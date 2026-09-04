import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { env as runtimeEnv } from "./env";
import { errText, matches } from "./format";
import { ProjectsPortfolio } from "./projects";
import { PeopleView } from "./people";
import { IdentityDirectory } from "./identity-directory";
import { StudioAI } from "./studio-ai";
import { SpecQuality } from "./spec-quality";
import { ComponentsCatalog } from "./components-catalog";
import { ProjectKits } from "./kits";
import { DocumentsTab, DocumentTypesTab } from "./documents";
import {
  ACCESS_MODELS,
  defaultAccessConfig,
  normalizeAccessConfig,
  privilegesByGroup,
  PRIVILEGES,
  type AccessConfig,
  type AccessModel,
  type GrantDef,
} from "./access";
import {
  api,
  ApiError,
  PLATFORM_ROOT_TENANT_ID,
  UNAUTHENTICATED_EVENT,
  shortTypeName,
  TENANT_TYPES,
  type Connection,
  type ConnectorProvider,
  type Me,
  type RemoteRepo,
  type RepoEntry,
  type Tenant,
  type WorkspaceSettings,
  sessionOrigin,
  waitForStudioSessionReady,
  uploadProjectArtifact,
} from "./api";

// Portal (личный кабинет): sign in with a bearer token, then an app shell
// with a sidebar — Projects / People / Integrations / Profile.
// Opening a project hands off to the Theia-based Studio (/space/{id}).
//
// ── Concept v2 ───────────────────────────────────────────────────────────────
// A **Project** is the only unit of work the UI knows. What the platform calls
// a *workspace tenant* IS a project (it owns the sources, the automation level,
// the people and the IDE sessions); what the `studio-project` gear records are
// *nested projects* inside it.
//
// **Organizations are hidden, not removed.** The organization tenant still
// exists and still does its two jobs — owning the shared connector catalogue
// and anchoring the tenant hierarchy — but it is no longer a place you can
// navigate to, and nobody holds a role in one. The code below keeps every
// org-shaped seam (`orgId` on a project, org-scoped connections, the tenant
// admin surfaces) reachable behind a flag, so bringing the level back is a
// UI decision rather than a re-architecture.

/** The AM tenant behind a root project.
 *
 *  Still named `Workspace` on purpose: that is the tenant type the backend
 *  serves, and renaming the wire word would only hide where the UI's noun and
 *  the platform's noun disagree. `orgName`/`orgId` stay for the same reason —
 *  a connection can be attached to the organization instead of the project,
 *  which is what makes one PAT serve every project of an organization. */
interface Workspace extends Tenant {
  orgName: string;
  orgId: string;
}

/** What "Open in IDE" launches against. A root project passes itself (a
 *  Workspace is a valid target — it already has id + name). A nested project
 *  passes its OWN id and its single source as the root repo, so each project
 *  gets its own session (keyed by id) cloning its own content. The session gear
 *  treats workspace_id as an opaque per-session key — directory name, pod
 *  label, idempotency — and does not require it to be a tenant, so no tenant is
 *  created for a nested project. */
type StudioTarget = {
  id: string;
  name: string;
  /** Explicit repo set; when omitted the launcher reads workspaceSettings(id). */
  repos?: RepoEntry[];
  /** Root repo/path override; when omitted taken from workspaceSettings(id). */
  root?: { path?: string; repoUrl?: string; branch?: string; tokenRef?: string };
  /** True when this is a nested project (no workspaceSettings of its own). */
  standalone?: boolean;
};

/* ── Filters (right panel) ── */

interface Filters {
  query: string;
  org: string; // platform admin: filter the raw workspace list by organization
  selfManagedOnly: boolean;
  sort: "name-asc" | "name-desc";
  model: string; // chats: filter by model_id
  sections: { gears: boolean; upstreams: boolean; entities: boolean }; // system
  gearKind: string; // gears: filter by crate kind
  gearSort: "name-asc" | "name-desc" | "downloads-desc"; // gears
  gearHideSdk: boolean; // gears: hide *-sdk crates
  gearCategory: string; // gears: filter by category/domain
}

const DEFAULT_FILTERS: Filters = {
  query: "",
  org: "",
  selfManagedOnly: false,
  sort: "name-asc",
  model: "",
  sections: { gears: true, upstreams: true, entities: true },
  gearKind: "",
  gearSort: "name-asc",
  gearHideSdk: false,
  gearCategory: "",
};

type PanelView = View | "dashboard";

function activeFilterCount(view: PanelView, f: Filters): number {
  let n = 0;
  if (view !== "system" && view !== "profile" && view !== "dashboard" && f.query.trim()) n++;
  if (view === "projects") {
    if (f.selfManagedOnly) n++;
    if (f.sort !== "name-asc") n++;
  }
  if (view === "chats" && f.model) n++;
  if (view === "system") n += Object.values(f.sections).filter((v) => !v).length;
  if (view === "gears") {
    if (f.gearKind) n++;
    if (f.gearSort !== "name-asc") n++;
    if (f.gearHideSdk) n++;
    if (f.gearCategory.trim()) n++;
  }
  return n;
}

export function App() {
  const [token, setToken] = useState<string | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [expired, setExpired] = useState(false);
  const [restoring, setRestoring] = useState(true);

  /** Renew the access token silently; returns true when the session lives on. */
  const renew = useCallback(async (): Promise<boolean> => {
    const { refreshSsoSession } = await import("./oidc");
    const session = await refreshSsoSession().catch(() => null);
    if (!session) return false;
    try {
      const who = await api.me(session.accessToken);
      setToken(session.accessToken);
      setMe(who);
      // Renew a minute before expiry; the IdP keeps the SSO session alive far
      // longer than one access token, so this is invisible to the user.
      window.setTimeout(() => void renew(), Math.max(30, session.expiresIn - 60) * 1000);
      return true;
    } catch {
      return false;
    }
  }, []);

  // Page load: restore a session from the stored refresh token (survives F5).
  useEffect(() => {
    (async () => {
      const { hasSsoSession } = await import("./oidc");
      if (hasSsoSession()) await renew();
      setRestoring(false);
    })();
  }, [renew]);

  // Any 401: try a silent renewal first (access tokens are short-lived), and
  // only end the session when the IdP declines.
  useEffect(() => {
    const onUnauthenticated = () => {
      void (async () => {
        if (await renew()) return;
        const { clearSsoSession } = await import("./oidc");
        clearSsoSession();
        setToken((t) => {
          if (t) setExpired(true);
          return null;
        });
        setMe(null);
      })();
    };
    window.addEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
    return () => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated);
  }, [renew]);

  if (restoring && !token) {
    return (
      <main className="narrow">
        <p className="hint">Restoring session…</p>
      </main>
    );
  }

  if (!token || !me) {
    return (
      <Login
        sessionExpired={expired}
        onLogin={(t, who) => {
          setExpired(false);
          setToken(t);
          setMe(who);
        }}
      />
    );
  }
  return (
    <Shell
      token={token}
      me={me}
      onLogout={() => {
        setToken(null);
        setMe(null);
        // Ends the Keycloak session too (RP-initiated logout) — otherwise
        // the SSO cookie silently signs the same user back in and there is
        // no way to switch accounts. Static-token logins clear locally.
        void import("./oidc").then(({ endSsoSession }) => endSsoSession());
      }}
    />
  );
}

/* ── Login ── */

function Login({
  onLogin,
  sessionExpired = false,
}: {
  onLogin: (token: string, me: Me) => void;
  sessionExpired?: boolean;
}) {
  const [error, setError] = useState<string | null>(
    sessionExpired ? "Session expired — please sign in again." : null,
  );
  const [busy, setBusy] = useState(false);

  // Returning from the IdP? Finish the PKCE exchange and sign in.
  useEffect(() => {
    import("./oidc").then(({ completeSsoLogin }) =>
      completeSsoLogin()
        .then(async (session) => {
          if (!session) return;
          setBusy(true);
          const who = await api.me(session.accessToken);
          onLogin(session.accessToken, who);
        })
        .catch((e) => {
          setBusy(false);
          setError(errText(e));
        }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const sso = (idpHint?: string) =>
    import("./oidc").then(({ startSsoLogin }) => startSsoLogin(idpHint));

  return (
    <div className="login-page">
      <div className="login-panel">
        <div className="logo login-logo">S</div>
        <h1 className="login-title">
          <span className="hero-gradient">Let’s start building</span>
        </h1>
        <p className="subtitle">Sign in to Constructor Studio</p>

        <button className="primary login-sso" disabled={busy} onClick={() => void sso()}>
          {busy ? "Signing in…" : "Continue with Constructor ID"}
        </button>

        {/* Federated providers — routed through Keycloak (kc_idp_hint).
            They work once the matching Identity Provider is configured in
            the realm; until then Keycloak falls back to its own form. */}
        <div className="login-providers">
          <button title="Google (via Keycloak identity federation)" disabled={busy} onClick={() => void sso("google")}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l3.7 2.9c2.3-2.1 3.7-5.1 3.7-8.6z"/><path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.7-2.9c-1 .7-2.4 1.2-4.2 1.2-3.1 0-5.8-2.1-6.7-5l-3.9 3C3.3 21.3 7.3 24 12 24z"/><path fill="#FBBC05" d="M5.3 14.4a7.4 7.4 0 0 1 0-4.7l-3.9-3a12 12 0 0 0 0 10.7l3.9-3z"/><path fill="#EA4335" d="M12 4.7c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1.1 15.2 0 12 0 7.3 0 3.3 2.7 1.4 6.7l3.9 3c.9-2.9 3.6-5 6.7-5z"/></svg>
          </button>
          <button title="GitHub (via Keycloak identity federation)" disabled={busy} onClick={() => void sso("github")}>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.9 10.9c.6.1.8-.2.8-.5v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0C19.3 4.7 20.3 5 20.3 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.6.8.5A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z"/></svg>
          </button>
          <button title="Microsoft (via Keycloak identity federation)" disabled={busy} onClick={() => void sso("microsoft")}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="13" y="1" width="10" height="10" fill="#7FBA00"/><rect x="1" y="13" width="10" height="10" fill="#00A4EF"/><rect x="13" y="13" width="10" height="10" fill="#FFB900"/></svg>
          </button>
        </div>

        {error && <div className="error">{error}</div>}

      </div>
    </div>
  );
}

/* ── App shell ── */

type View =
  | "home"
  | "projects"
  | "people"
  | "chats"
  | "files"
  | "connectors"
  | "gears"
  | "system"
  | "profile";

/** Monochrome line icons (lucide-style): consistent stroke, currentColor —
 *  they inherit the nav's text/accent color instead of emoji potpourri. */
function NavIcon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    home: (
      <>
        <path d="m3 11 9-8 9 8" />
        <path d="M5 10v11h14V10" />
      </>
    ),
    shield: (
      <>
        <path d="M12 3l7 3v5c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" />
        <path d="m9 12 2 2 4-4" />
      </>
    ),
    org: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="1" />
        <path d="M9 7h1.5M13.5 7H15M9 11h1.5M13.5 11H15M9 15h1.5M13.5 15H15M10 21v-3h4v3" />
      </>
    ),
    grid: (
      <>
        <rect x="3" y="3" width="7.5" height="7.5" rx="1" />
        <rect x="13.5" y="3" width="7.5" height="7.5" rx="1" />
        <rect x="3" y="13.5" width="7.5" height="7.5" rx="1" />
        <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1" />
      </>
    ),
    users: (
      <>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
        <path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M21 20c0-2.6-1.7-4.9-4-5.7" />
      </>
    ),
    key: (
      <>
        <circle cx="8" cy="15" r="4" />
        <path d="m11 12 9-9M17 4l3 3M14 7l2.5 2.5" />
      </>
    ),
    chat: <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-3.4-.8L3 21l1.9-5.6A8.4 8.4 0 1 1 21 11.5z" />,
    file: (
      <>
        <path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" />
        <path d="M14 3v5h5" />
      </>
    ),
    plug: (
      <>
        <path d="M8 3 4 7l4 4M4 7h16" />
        <path d="m16 13 4 4-4 4M20 17H4" />
      </>
    ),
    cog: (
      <>
        <circle cx="12" cy="12" r="3.2" />
        <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1" />
      </>
    ),
    package: (
      <>
        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        <path d="M3.3 7 12 12l8.7-5M12 22V12" />
      </>
    ),
    scan: (
      <>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M4 12h16" />
        <path d="M8 8h.01M8 16h.01" />
      </>
    ),
  };
  return (
    <svg
      viewBox="0 0 24 24"
      width="17"
      height="17"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? <circle cx="12" cy="12" r="8" />}
    </svg>
  );
}

// Sectioned nav (concept v2). Two nouns carry the whole product — Projects and
// People — and everything that used to need a level above them (organizations,
// the workspace/project split, "pick a workspace first" dead ends) is gone from
// the sidebar. Sources, secrets and nested projects are not top-level surfaces:
// they belong TO a project and live on its page, which is what makes the
// project the unit rather than a folder you have to select first.
const NAV_SECTIONS: {
  title: string | null;
  items: { id: View; icon: string; label: string }[];
}[] = [
  {
    title: "Work",
    items: [
      { id: "projects", icon: "grid", label: "Workspaces" },
      { id: "people", icon: "users", label: "People" },
      // Shared connector catalogue. It is owned by the hidden organization —
      // which is exactly why it sits here and not inside one project: every
      // project of the org inherits it. Labelled "Connections" to match the
      // sidebar in the product mockups.
      { id: "connectors", icon: "plug", label: "Connections" },
      { id: "chats", icon: "chat", label: "Chats" },
      { id: "files", icon: "file", label: "Files" },
    ],
  },
  // Spec Quality is no longer a top-level surface — it moved onto the project
  // page (the "Analyze" project tab), where it runs over that project's
  // ingested artifacts.
  {
    title: "Platform",
    items: [
      // Our published gears (crates.io → graph), and the system observability
      // surface.
      { id: "gears", icon: "package", label: "Components" },
      { id: "system", icon: "cog", label: "System" },
    ],
  },
];

type AdminView =
  | "people"
  | "identities"
  | "access"
  | "connectors"
  | "secrets"
  | "tenants"
  | "workspaces";

/** Administration that survives concept v2: people, the shared catalogue,
 *  credentials. The tenant hierarchy (organizations, the raw workspace list)
 *  appears only when the platform-admin flag is on. */
const ADMIN_NAV: { id: AdminView; icon: string; label: string }[] = [
  // Organizations are a first-class concept again, so managing them (rename,
  // add, delete) is ordinary administration — not gated behind the platform flag.
  { id: "tenants", icon: "org", label: "Organizations" },
  { id: "people", icon: "users", label: "People" },
  { id: "access", icon: "shield", label: "Access" },
  { id: "connectors", icon: "plug", label: "Integrations" },
  { id: "secrets", icon: "key", label: "Secrets" },
];

const PLATFORM_NAV: { id: AdminView; icon: string; label: string }[] = [
  { id: "identities", icon: "users", label: "All identities" },
  { id: "workspaces", icon: "grid", label: "Project tenants" },
];

function OrganizationAccessGate({
  loading,
  onRetry,
  onLogout,
}: {
  loading: boolean;
  onRetry: () => void;
  onLogout: () => void;
}) {
  return (
    <div className="login-page">
      <div className="login-panel">
        <div className="logo login-logo">CS</div>
        <h1 className="login-title">
          {loading ? "Checking organization access" : "Waiting for organization access"}
        </h1>
        <p className="hint">
          {loading
            ? "Your identity is verified. Studio is checking your organization memberships."
            : "Your GitHub sign-in succeeded, but you are not a member of a Studio organization yet."}
        </p>
        {!loading && (
          <p className="hint">
            Ask a Studio administrator or an organization owner to invite you. Signing in does not
            grant access automatically.
          </p>
        )}
        <div className="inline">
          <button className="primary" disabled={loading} onClick={onRetry}>
            Check again
          </button>
          <button className="ghost" onClick={onLogout}>
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}

function Shell({ token, me, onLogout }: { token: string; me: Me; onLogout: () => void }) {
  const [view, setView] = useState<View>("projects");
  /** Position in the project → nested project drill-down. Two levels, one noun. */
  const [crumb, setCrumb] = useState<Crumb>({});
  /** Name of the opened nested project, kept for the crumb: the record is not
   *  in any list the shell holds, and refetching it for a label would be silly. */
  const [projectLabel, setProjectLabel] = useState<string | undefined>();
  // The open project's active tab. Lifted here so the sidebar is the project's
  // nav (see the PROJECT section below); opening a different project resets it.
  const [projectTab, setProjectTab] = useState<ProjTab>("overview");
  // Opening a different project starts on its Overview.
  useEffect(() => {
    setProjectTab("overview");
  }, [crumb.nestedId]);
  const [accountMenu, setAccountMenu] = useState(false);
  const [productMenu, setProductMenu] = useState(false);
  // Active organization — the top context, now that the level above projects is
  // back. Lifted to the shell so the sidebar switcher (where "Home" used to be)
  // and the portfolio share one selection. null = "resolve a sensible default".
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  // Admin area (console pattern): a separate mode with its own sidebar for
  // organizations / members / workspaces administration.
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminView, setAdminView] = useState<AdminView>("people");
  // Which organization the admin area is scoped to ("__new__" = create hero).
  // Concept v2 resolves it implicitly; the picker only appears under the flag.
  const [adminOrgId, setAdminOrgId] = useState<string | null>(null);
  const [adminOrgMenu, setAdminOrgMenu] = useState(false);
  const openAdmin = (v: AdminView = "people", orgId?: string) => {
    setAdminOpen(true);
    setAdminView(v);
    if (orgId) setAdminOrgId(orgId);
    setActiveSpace(null);
    setDash(null);
    setStudio(null);
    setAccountMenu(false);
    setProductMenu(false);
  };
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("studio.sidebar") === "collapsed";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("studio.sidebar", sidebarCollapsed ? "collapsed" : "open");
    } catch {
      /* non-fatal */
    }
  }, [sidebarCollapsed]);
  const [home, setHome] = useState<Tenant | null>(null);
  const [accessState, setAccessState] = useState<"loading" | "ready" | "unassigned">(
    "loading",
  );
  const showPlatform = home?.id === PLATFORM_ROOT_TENANT_ID;
  const [orgs, setOrgs] = useState<Tenant[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // Temporary platform-admin fallback until every installation bootstraps its
  // default organization server-side. Never runs for an external identity.
  const seededOrgRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [studio, setStudio] = useState<StudioTarget | null>(null);
  const [dash, setDash] = useState<Workspace | null>(null);
  // Spaces: embedded IDE sessions living INSIDE the portal window. Every
  // space keeps its iframe mounted (hidden, not unmounted), so switching
  // between the portal and sessions never reloads Theia.
  const [spaces, setSpaces] = useState<
    { wsId: string; wsName: string; url: string; sessionId: string }[]
  >([]);
  const [spaceDirty, setSpaceDirty] = useState<Record<string, number>>({});
  const [spaceRefresh, setSpaceRefresh] = useState<Record<string, number>>({});
  const initTimersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const stopInitRetry = useCallback((wsId: string) => {
    const timer = initTimersRef.current[wsId];
    if (timer !== undefined) {
      clearInterval(timer);
      delete initTimersRef.current[wsId];
    }
  }, []);
  // Initialized FROM the URL: the sync effect below runs on mount and would
  // otherwise rewrite /space/{id} to / before the restore logic reads it.
  const [activeSpace, setActiveSpace] = useState<string | null>(
    () => window.location.pathname.match(/^\/space\/([0-9a-f-]{36})$/)?.[1] ?? null,
  );

  const openSpace = useCallback(
    (ws: StudioTarget, session: { id: string; url: string }, activate = true) => {
      setSpaces((prev) =>
        prev.some((s) => s.wsId === ws.id)
          ? prev.map((s) =>
              s.wsId === ws.id ? { ...s, url: session.url, sessionId: session.id } : s,
            )
          : [...prev, { wsId: ws.id, wsName: ws.name, url: session.url, sessionId: session.id }],
      );
      if (activate) setActiveSpace(ws.id);
      setStudio(null);
    },
    [],
  );

  const closeSpace = useCallback((wsId: string) => {
    stopInitRetry(wsId);
    setSpaces((prev) => prev.filter((s) => s.wsId !== wsId));
    setActiveSpace((a) => (a === wsId ? null : a));
    setSpaceDirty((prev) => {
      if (!(wsId in prev)) return prev;
      const next = { ...prev };
      delete next[wsId];
      return next;
    });
    setSpaceRefresh((prev) => {
      if (!(wsId in prev)) return prev;
      const next = { ...prev };
      delete next[wsId];
      return next;
    });
  }, [stopInitRetry]);

  const refreshSpace = useCallback(
    (wsId: string) => {
      const dirty = spaceDirty[wsId] ?? 0;
      if (
        dirty > 0 &&
        !window.confirm(`Refresh the IDE? ${dirty} unsaved file(s) may be lost.`)
      ) {
        return;
      }
      stopInitRetry(wsId);
      setSpaceRefresh((prev) => ({ ...prev, [wsId]: (prev[wsId] ?? 0) + 1 }));
    },
    [spaceDirty, stopInitRetry],
  );

  const stopSpace = useCallback(
    async (wsId: string) => {
      const space = spaces.find((candidate) => candidate.wsId === wsId);
      if (!space) return;
      const dirty = spaceDirty[wsId] ?? 0;
      const warning = dirty > 0 ? ` ${dirty} unsaved file(s) will be lost.` : "";
      if (!window.confirm(`Stop the IDE session and release its resources?${warning}`)) return;
      try {
        await api.deleteStudioSession(token, space.sessionId);
        closeSpace(wsId);
      } catch (e) {
        setError(errText(e));
      }
    },
    [closeSpace, spaceDirty, spaces, token],
  );

  /* ── Space routing & restore ──
     The URL mirrors the active space (/space/{wsId} ↔ /), the list of open
     spaces persists in sessionStorage, and after a reload every space with
     a LIVE session is remounted silently — the one from the URL activated.
     A dead session in the URL falls back to the launcher (auto-launch). */
  const restoredRef = useRef(false);
  // The URL as it was BEFORE any state→URL sync could touch it.
  const initialSpaceRef = useRef<string | null>(
    window.location.pathname.match(/^\/space\/([0-9a-f-]{36})$/)?.[1] ?? null,
  );

  useEffect(() => {
    // URL ← state (replace, not push: spaces are switched often).
    const path = activeSpace ? `/space/${activeSpace}` : "/";
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
  }, [activeSpace]);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        "studio.spaces",
        JSON.stringify(spaces.map((s) => ({ wsId: s.wsId, wsName: s.wsName }))),
      );
    } catch {
      /* non-fatal */
    }
  }, [spaces]);

  useEffect(() => {
    // Back/forward buttons switch space ↔ portal.
    const onPop = () => {
      const m = window.location.pathname.match(/^\/space\/([0-9a-f-]{36})$/);
      setActiveSpace(m ? m[1] : null);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const pendingLaunchRef = useRef<string | null>(null);

  useEffect(() => {
    // One-shot restore, WITHOUT waiting for the workspace list: names come
    // from sessionStorage, liveness from one sessions call — the IDE frame
    // starts loading seconds earlier than the AM catalog finishes.
    if (restoredRef.current) return;
    restoredRef.current = true;
    void (async () => {
      let saved: { wsId: string; wsName: string }[] = [];
      try {
        const raw = JSON.parse(sessionStorage.getItem("studio.spaces") ?? "[]") as unknown[];
        saved = raw
          .map((e) =>
            typeof e === "string"
              ? { wsId: e, wsName: "Workspace" } // legacy format
              : (e as { wsId: string; wsName: string }),
          )
          .filter((e) => e?.wsId);
      } catch {
        /* corrupt state — start clean */
      }
      const urlWs = initialSpaceRef.current;
      if (urlWs && !saved.some((s) => s.wsId === urlWs)) {
        saved.push({ wsId: urlWs, wsName: "Workspace" });
      }
      if (saved.length === 0) return;
      const live = await api.studioSessions(token).then(
        (p) => p.items.filter((s) => s.state !== "stopped"),
        () => [],
      );
      for (const entry of saved) {
        const session = live.find((s) => s.workspace_id === entry.wsId);
        if (session) {
          openSpace(
            { id: entry.wsId, name: entry.wsName },
            session,
            entry.wsId === urlWs,
          );
        } else if (entry.wsId === urlWs) {
          pendingLaunchRef.current = entry.wsId; // needs the workspace object
        }
      }
    })();
  }, [token, openSpace]);

  useEffect(() => {
    // Dead-session fallback: the launcher needs the real Workspace object,
    // so this half waits for the catalog.
    if (!pendingLaunchRef.current || workspaces.length === 0) return;
    const ws = workspaces.find((w) => w.id === pendingLaunchRef.current);
    pendingLaunchRef.current = null;
    if (ws) setStudio(ws);
  }, [workspaces]);

  /* ── Portal ↔ IDE bridge (postMessage) ──
     Outbound: theme on iframe load + on portal theme change. Inbound:
     studio.status {dirty} — origin-checked against known space URLs. */
  const spaceOrigin = sessionOrigin;

  /* studio.init retry: the iframe's first load events are the session gate's
     redirect/splash pages — Theia's bridge isn't listening yet, so a single
     onLoad handshake is lost and the IDE never gets the theme/token. Repeat
     until the bridge answers with studio.status (its ack to studio.init). */
  const tokenRef = useRef(token);
  tokenRef.current = token;

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const sp = spaces.find((s) => spaceOrigin(s.url) === e.origin);
      if (!sp) return; // only embedded sessions are trusted senders
      const d = e.data as { type?: string; dirty?: number };
      if (typeof d?.type === "string" && d.type.startsWith("studio.")) {
        stopInitRetry(sp.wsId); // the bridge is alive — handshake done
      }
      if (d?.type === "studio.status" && typeof d.dirty === "number") {
        const dirty = d.dirty; // narrow before the closure
        setSpaceDirty((prev) =>
          prev[sp.wsId] === dirty ? prev : { ...prev, [sp.wsId]: dirty },
        );
      }
    };
    window.addEventListener("message", onMsg);
    return () => window.removeEventListener("message", onMsg);
  }, [spaces]);

  useEffect(() => {
    // Broadcast portal theme changes to every mounted space.
    const send = () => {
      const theme = document.documentElement.dataset.theme ?? "light";
      document.querySelectorAll<HTMLIFrameElement>("iframe.space-frame").forEach((f) => {
        const origin = f.dataset.origin;
        if (origin) f.contentWindow?.postMessage({ type: "studio.theme", theme }, origin);
      });
    };
    const mo = new MutationObserver(send);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);

  useEffect(() => {
    // Silent renew: hand the fresh token to every mounted space.
    document.querySelectorAll<HTMLIFrameElement>("iframe.space-frame").forEach((f) => {
      const origin = f.dataset.origin;
      if (origin) f.contentWindow?.postMessage({ type: "studio.token", apiToken: token }, origin);
    });
  }, [token]);
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [componentCategories, setComponentCategories] = useState<string[]>([]);
  const [panelOpen, setPanelOpen] = useState<boolean>(() => {
    try {
      return localStorage.getItem("studio.filterPanel") !== "collapsed";
    } catch {
      return true;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem("studio.filterPanel", panelOpen ? "open" : "collapsed");
    } catch {
      /* private mode etc. — non-fatal */
    }
  }, [panelOpen]);

  // The saved theme applies on login, not on the first visit to Profile —
  // ProfileView only edits it.
  useEffect(() => {
    api
      .userSettings(token)
      .then((p) => {
        if (p.theme) document.documentElement.dataset.theme = p.theme;
      })
      .catch(() => {
        /* theme is cosmetic — never block the shell on it */
      });
  }, [token]);

  // Who is signed in — from the token claims (display only; the backend
  // validates). Static dev tokens are opaque → fall back to the subject id.
  const claims = decodeJwtClaims(token);
  const claimStr = (k: string): string | null => {
    const v = claims?.[k];
    return typeof v === "string" && v.trim() ? v : null;
  };
  const userName =
    claimStr("name") ?? claimStr("preferred_username") ?? `${me.subject_id.slice(0, 8)}…`;
  const userEmail = claimStr("email");
  const userInitials = userName
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  // Resolved AFTER home/orgs state exists (declaration order matters).
  const adminOrg =
    orgs.find((o) => o.id === adminOrgId) ??
    (home?.tenant_type === TENANT_TYPES.organization ? (home as Tenant) : orgs[0]) ??
    null;

  /** The organization concept v2 hides.
   *
   *  It is still where a new project is created and still owns the shared
   *  connector catalogue — the UI simply never names it. Resolution order: the
   *  one the platform-admin picker selected, your home tenant when that IS an
   *  organization, the first organization you can see, else your home tenant
   *  (single-tenant deployments put projects straight under the root). */
  const implicitOrgId = adminOrg?.id ?? home?.id ?? null;
  /** Shaped like a project so the connector surfaces — written against "a
   *  tenant that owns a catalogue" — can be pointed at the organization. */
  const orgAsSpace: Workspace | null = adminOrg
    ? { ...adminOrg, orgId: adminOrg.id, orgName: adminOrg.name }
    : home
      ? { ...home, orgId: home.id, orgName: home.name }
      : null;

  // The organizations offered in the switcher: every one that holds projects
  // (derived from the loaded workspaces, which carry orgId/orgName) plus any
  // other visible, accessible org — so a freshly created, still-empty org is
  // switchable straight away. Self-managed orgs are barriered (no children
  // reachable), so they only appear if they already own a project here.
  const orgOptions = (() => {
    const m = new Map<string, { id: string; name: string }>();
    for (const w of workspaces) if (w.orgId) m.set(w.orgId, { id: w.orgId, name: w.orgName });
    for (const o of orgs) if (!o.self_managed && !m.has(o.id)) m.set(o.id, { id: o.id, name: o.name });
    if (m.size === 0 && implicitOrgId) m.set(implicitOrgId, { id: implicitOrgId, name: home?.name ?? "Organization" });
    return Array.from(m.values());
  })();
  // Resolve the active org. Honour an explicit pick, else default to one that
  // actually CONTAINS projects — never an empty sibling, which is what made the
  // portfolio read as "nothing here".
  const orgsWithProjects = new Set(workspaces.map((w) => w.orgId));
  const activeOrgResolvedId =
    (activeOrgId && orgOptions.some((o) => o.id === activeOrgId) ? activeOrgId : null) ??
    orgOptions.find((o) => orgsWithProjects.has(o.id))?.id ??
    orgOptions[0]?.id ??
    implicitOrgId ??
    null;
  const activeOrg = orgOptions.find((o) => o.id === activeOrgResolvedId) ?? null;
  // Workspaces of the active org — the path picker's workspace options.
  const orgWorkspaces = workspaces.filter((w) => w.orgId === activeOrgResolvedId);

  // When a project is open, the sidebar gains its tab nav (Overview / Artifacts
  // / Spec Quality / Team) so the tabs live on the panel rather than the page.
  const projectOpen = !adminOpen && !activeSpace && view === "projects" && !!crumb.nestedId;

  const panelView: PanelView = dash ? "dashboard" : view;

  const refresh = useCallback(async () => {
    setError(null);
    try {
      // Authentication and organization membership are separate. During the
      // ADR-0011 migration an external identity can carry a legacy home id
      // without a live tenant. That is an unassigned identity, not a broken org.
      const homeTenant = await api.tenant(token, me.subject_tenant_id).catch((e) => {
        if (e instanceof ApiError && e.status === 404) {
          setHome(null);
          setOrgs([]);
          setWorkspaces([]);
          setAccessState("unassigned");
          return null;
        }
        throw e;
      });
      if (!homeTenant) return;

      setAccessState("ready");
      const page = await api
        .tenantChildren(token, me.subject_tenant_id)
        .catch((e) => (e instanceof ApiError && e.status === 404 ? { items: [] } : Promise.reject(e)));
      setHome(homeTenant);
      const children = page.items ?? [];
      let orgList = children.filter((t) => t.tenant_type === TENANT_TYPES.organization);

      // Transitional fallback: only the deliberately provisioned platform-root
      // administrator may create the default organization on a fresh database.
      if (
        orgList.length === 0 &&
        homeTenant.id === PLATFORM_ROOT_TENANT_ID &&
        !seededOrgRef.current
      ) {
        seededOrgRef.current = true;
        try {
          const org = await api.createTenant(token, {
            name: "Default Organization",
            parent_id: me.subject_tenant_id,
            tenant_type: TENANT_TYPES.organization,
          });
          orgList = [org];
        } catch {
          // A concurrent first-login may have created it already (or we lack the
          // right) — re-read children so an org someone else seeded still shows.
          const again = await api
            .tenantChildren(token, me.subject_tenant_id)
            .catch(() => ({ items: [] as Tenant[] }));
          orgList = (again.items ?? []).filter(
            (t) => t.tenant_type === TENANT_TYPES.organization,
          );
        }
      }

      const directWs = children
        .filter((t) => t.tenant_type === TENANT_TYPES.workspace)
        .map((t) => ({ ...t, orgName: homeTenant.name, orgId: homeTenant.id }));
      // Workspaces live under organizations — fetch each org's children.
      // A self-managed org raises the visibility barrier: from outside its
      // subtree the backend answers 404. That's tenant isolation working,
      // not an error — skip such orgs instead of failing the whole view.
      const nested = await Promise.all(
        orgList.map(async (org): Promise<Workspace[]> => {
          // A self-managed org raises the barrier by design — don't even ask
          // (the 404 would be correct, but it clutters the browser console).
          if (org.self_managed) return [];
          try {
            const kids = await api.tenantChildren(token, org.id);
            return (kids.items ?? [])
              .filter((t) => t.tenant_type === TENANT_TYPES.workspace)
              .map((t) => ({ ...t, orgName: org.name, orgId: org.id }));
          } catch {
            return []; // barrier or no access — org stays visible, contents don't
          }
        }),
      );
      setOrgs(orgList);
      setWorkspaces([...directWs, ...nested.flat()]);
    } catch (e) {
      setError(errText(e));
    }
  }, [token, me.subject_tenant_id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Nested projects of the workspace in context — options for the PathBar's
  // project dropdown. Loaded when a workspace is selected; cleared otherwise.
  const [nestedProjects, setNestedProjects] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let cancelled = false;
    if (!crumb.projectId) {
      setNestedProjects([]);
      return;
    }
    api.tenantChildren(token, crumb.projectId).then(
      (page) => {
        if (cancelled) return;
        setNestedProjects(
          (page.items ?? [])
            .filter((t) => t.tenant_type === TENANT_TYPES.project)
            .map((t) => ({ id: t.id, name: t.name })),
        );
      },
      () => {
        if (!cancelled) setNestedProjects([]);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token, crumb.projectId]);

  if (accessState !== "ready") {
    return (
      <OrganizationAccessGate
        loading={accessState === "loading"}
        onRetry={() => void refresh()}
        onLogout={onLogout}
      />
    );
  }

  return (
    <div className="shell">
      <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
        {/* Product switcher (console pattern): the portal is one door of the
            product family — API docs and the IdP admin are the real others. */}
        <div className="wordmark product-switch">
          <button className="product-button" onClick={() => setProductMenu((v) => !v)}>
            <div className="logo">CS</div>
            <strong>Constructor Studio</strong>
            <span className="chev">▾</span>
          </button>
          <button
            className="sidebar-toggle"
            title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => {
              setSidebarCollapsed((v) => !v);
              setProductMenu(false);
              setAccountMenu(false);
            }}
          >
            {sidebarCollapsed ? "⟩" : "⟨"}
          </button>
          {productMenu && (
            <div className="product-menu">
              <button onClick={() => setProductMenu(false)}>
                <span className="ico">▦</span> Studio <span className="check">✓</span>
              </button>
              <button
                onClick={() => {
                  window.open("/cf/docs", "_blank", "noopener");
                  setProductMenu(false);
                }}
              >
                <span className="ico">⧉</span> Docs &amp; API
              </button>
              <button title="Organizations, members, workspaces administration" onClick={() => openAdmin()}>
                <span className="ico">🛡</span> Admin
              </button>
            </div>
          )}
        </div>
        <nav>
          {adminOpen ? (
            <>
              <div className="nav-section">
                <button title="Back to Studio" onClick={() => setAdminOpen(false)}>
                  <span className="ico">←</span> Back to Studio
                </button>
              </div>
              {/* Org selector: shown under the platform flag, or whenever there
                  is more than one organization to manage (so the Organizations
                  admin can switch which one it acts on). A single org resolves
                  implicitly and needs no picker. */}
              {(showPlatform || orgs.length > 1) && (
              <div className="nav-section org-select-wrap">
                <button className="org-select" onClick={() => setAdminOrgMenu((v) => !v)}>
                  <span className="account-avatar small">
                    {(adminOrgId === "__new__" ? "+" : (adminOrg?.name ?? "?")).slice(0, 1).toUpperCase()}
                  </span>
                  <span className="org-select-name">
                    {adminOrgId === "__new__" ? "New organization" : adminOrg?.name ?? "Select organization"}
                  </span>
                  <span className="chev">▾</span>
                </button>
                {adminOrgMenu && (
                  <div className="org-menu">
                    {orgs.map((o) => (
                      <button
                        key={o.id}
                        onClick={() => {
                          setAdminOrgId(o.id);
                          setAdminOrgMenu(false);
                        }}
                      >
                        <span className="account-avatar small">{o.name.slice(0, 1).toUpperCase()}</span>
                        {o.name} {o.self_managed ? "🔒" : ""}
                      </button>
                    ))}
                    <button
                      onClick={() => {
                        setAdminOrgId("__new__");
                        setAdminView("tenants");
                        setAdminOrgMenu(false);
                      }}
                    >
                      ＋ New organization
                    </button>
                  </div>
                )}
              </div>
              )}
              <div className="nav-section">
                <div className="nav-section-title admin-title">Administration</div>
                {ADMIN_NAV.map((n) => (
                  <button
                    key={n.id}
                    className={adminView === n.id ? "active" : ""}
                    title={n.label}
                    onClick={() => setAdminView(n.id)}
                  >
                    <span className="ico"><NavIcon name={n.icon} /></span> {n.label}
                  </button>
                ))}
              </div>
              {showPlatform && (
                <div className="nav-section">
                  <div className="nav-section-title admin-title">Platform (tenant hierarchy)</div>
                  {PLATFORM_NAV.map((n) => (
                    <button
                      key={n.id}
                      className={adminView === n.id ? "active" : ""}
                      title="The organization level concept v2 hides — still real, still administrable"
                      onClick={() => setAdminView(n.id)}
                    >
                      <span className="ico"><NavIcon name={n.icon} /></span> {n.label}
                    </button>
                  ))}
                </div>
              )}
              <div className="nav-section">
                <div className="nav-section-title admin-title">IdP</div>
                <button
                  title="Keycloak administration console"
                  onClick={() => window.open("https://localhost:8443/admin/", "_blank", "noopener")}
                >
                  <span className="ico">🛡</span> IdP console ↗
                </button>
              </div>
            </>
          ) : (
            <>
            {/* Organization / workspace switchers used to live here; the
                horizontal path picker (org › workspace › project) above the
                content is now the single place to switch context, so the
                sidebar keeps only the nav surfaces below. */}
            {projectOpen && (
              // ── Project context: the open project's tabs live in the sidebar ──
              <div className="nav-section nav-section-project">
                <div className="nav-section-title">{projectLabel ?? "Project"}</div>
                {PROJECT_TABS.map((t) => (
                  <button
                    key={t.id}
                    className={projectTab === t.id ? "active" : ""}
                    title={t.label}
                    onClick={() => {
                      setProjectTab(t.id);
                      setActiveSpace(null);
                    }}
                  >
                    <span className="ico">
                      <NavIcon name={t.icon} />
                    </span>{" "}
                    {t.label}
                  </button>
                ))}
              </div>
            )}
            {
              // ── Organization context: work surfaces of the whole org ──
              NAV_SECTIONS.map((sec) => {
                const items = sec.items;
                return (
                  <div
                    key={sec.title ?? "_top"}
                    className={`nav-section${sec.title ? ` nav-section-${sec.title.toLowerCase()}` : ""}`}
                  >
                    {sec.title && <div className="nav-section-title">{sec.title}</div>}
                    {items.map((n) => (
                      <button
                        key={n.id}
                        className={view === n.id && !activeSpace ? "active" : ""}
                        title={n.label}
                        onClick={() => {
                          setView(n.id);
                          setActiveSpace(null); // portal navigation leaves the space
                        }}
                      >
                        <span className="ico"><NavIcon name={n.icon} /></span> {n.label}
                      </button>
                    ))}
                  </div>
                );
              })
            }
            </>
          )}
          {spaces.length > 0 && (
            <div className="nav-spaces">
              <div className="nav-spaces-title">Spaces</div>
              {spaces.map((s) => (
                <div key={s.wsId} className="space-row">
                  <button
                    className={activeSpace === s.wsId ? "active" : ""}
                    onClick={() => {
                      setActiveSpace(s.wsId);
                      setAdminOpen(false); // a space is a Studio surface
                    }}
                    title={`Switch to ${s.wsName}${
                      spaceDirty[s.wsId] ? ` — ${spaceDirty[s.wsId]} unsaved file(s)` : ""
                    }`}
                  >
                    <span className="ico">⚙</span> {s.wsName}
                    {(spaceDirty[s.wsId] ?? 0) > 0 && <span className="dirty-dot">●</span>}
                  </button>
                  <button
                    className="ghost space-x"
                    title="Hide space (the IDE session keeps running)"
                    onClick={() => closeSpace(s.wsId)}
                  >
                    ✕
                  </button>
                  <button
                    className="ghost space-refresh"
                    title="Refresh IDE without stopping the session"
                    onClick={() => refreshSpace(s.wsId)}
                  >
                    ↻
                  </button>
                  <button
                    className="ghost space-stop"
                    title="Stop IDE session and release Kubernetes resources"
                    onClick={() => void stopSpace(s.wsId)}
                  >
                    Stop
                  </button>
                </div>
              ))}
            </div>
          )}
        </nav>
        <div className="spacer" />
        <div className="whoami">
          {accountMenu && (
            <div className="account-menu two-pane">
              {/* Left: who you are and what you can do as yourself. */}
              <div className="pane-left">
                <div className="account-menu-head">
                  <span className="account-user">{userName}</span>
                  {userEmail && <span>{userEmail}</span>}
                  {/* The home tenant IS the access scope — say so explicitly. */}
                  {home && (
                    <span
                      className="scope-line"
                      title="Your home tenant anchors what you can see: its whole subtree, pruned at self-managed barriers."
                    >
                      {home.tenant_type === TENANT_TYPES.organization
                        ? `Scope: ${home.name} subtree`
                        : `Scope: entire platform${
                            orgs.filter((o) => o.self_managed).length
                              ? ` · ${orgs.filter((o) => o.self_managed).length} self-managed hidden`
                              : ""
                          }`}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => {
                    setAdminOpen(false);
                    setView("profile");
                    setActiveSpace(null);
                    setAccountMenu(false);
                  }}
                >
                  Profile
                </button>
                <button onClick={() => openAdmin()}>Admin settings</button>
                <button onClick={onLogout}>Sign out</button>
              </div>

              {/* Right: where you are working — organizations first, then the
                  projects of the one in context. The level above projects is
                  back, so the menu groups by it instead of a flat column. */}
              <ContextPane
                token={token}
                orgs={orgOptions}
                homeId={home?.id ?? null}
                createOrgId={implicitOrgId}
                workspaces={workspaces}
                crumb={crumb}
                onPick={(next) => {
                  setAdminOpen(false);
                  setCrumb(next);
                  setView("projects");
                  setActiveSpace(null);
                  setAccountMenu(false);
                }}
                onChanged={() => void refresh()}
              />
            </div>
          )}
          <button
            className="account-button"
            onClick={() => setAccountMenu((v) => !v)}
            title="Account"
          >
            <span className="account-avatar">{userInitials}</span>
            <span className="account-lines">
              <span className="account-name">{userName}</span>
              {/* The context lives here, next to the identity — the two
                  questions "who am I" and "where am I" get one answer spot. */}
              <span className="scope-line">
                {workspaces.find((w) => w.id === crumb.projectId)?.name ??
                  userEmail ??
                  home?.name ??
                  ""}
              </span>
            </span>
          </button>
        </div>
      </aside>

      {/* Spaces host: all session iframes stay mounted; only the active one
          is visible, so switching never reloads the IDE. */}
      {/* While the portal is active the host stays rendered but parked as a
          transparent background layer — display:none would throttle every
          embedded session's WebSocket (see .space-frames note). */}
      <div
        className="spaces-host"
        style={
          activeSpace
            ? { display: "flex" }
            : {
                display: "flex",
                position: "fixed",
                inset: 0,
                zIndex: -1,
                opacity: 0,
                pointerEvents: "none",
              }
        }
      >
        {activeSpace &&
          (() => {
            const sp = spaces.find((s) => s.wsId === activeSpace);
            return sp ? (
              <div className="space-bar">
                <span>⚙ {sp.wsName}</span>
                <a href={sp.url} target="_blank" rel="noopener noreferrer">
                  open in tab ↗
                </a>
              </div>
            ) : null;
          })()}
        {activeSpace && !spaces.some((s) => s.wsId === activeSpace) && (
          <p className="hint" style={{ padding: 16 }}>
            Reconnecting the space…
          </p>
        )}
        {/* Inactive frames stay RENDERED (opacity 0, stacked) — display:none
            makes Chrome throttle hidden cross-origin iframes, Theia misses
            its WebSocket keepalive and the session reconnect-loops. */}
        <div className="space-frames">
          {spaces.map((s) => (
            <iframe
              key={`${s.wsId}:${spaceRefresh[s.wsId] ?? 0}`}
              className="space-frame"
              src={s.url}
              title={`Studio — ${s.wsName}`}
              allow="clipboard-read; clipboard-write"
              data-origin={spaceOrigin(s.url)}
              onLoad={(e) => {
                // Handshake: theme + the caller's API token (the IDE calls the
                // gears same-origin through the session gate's /studio-api/*).
                // Retried every 2s until the bridge acks (studio.status): the
                // first load events are the gate's redirect/splash, where
                // nobody is listening yet. Splash reloads re-fire onLoad —
                // reset the timer each time.
                const frame = e.currentTarget;
                const origin = spaceOrigin(s.url);
                const post = () => {
                  const theme = document.documentElement.dataset.theme ?? "light";
                  frame.contentWindow?.postMessage(
                    // `wsId` is the tenant this session was opened against — a
                    // workspace tenant (its graph shows every project) or a
                    // project tenant (just that project). The IDE scopes the
                    // Artifact Graph's reads to it.
                    { type: "studio.init", theme, apiToken: tokenRef.current, workspaceId: s.wsId },
                    origin,
                  );
                };
                post();
                stopInitRetry(s.wsId);
                let tries = 0;
                initTimersRef.current[s.wsId] = setInterval(() => {
                  if (++tries > 150) {
                    stopInitRetry(s.wsId); // ~5 min — session is not coming up
                    return;
                  }
                  post();
                }, 2000);
              }}
              style={
                activeSpace === s.wsId
                  ? { opacity: 1, zIndex: 1, pointerEvents: "auto" }
                  : { opacity: 0, zIndex: 0, pointerEvents: "none" }
              }
            />
          ))}
        </div>
      </div>

      <div className="content" style={activeSpace ? { display: "none" } : undefined}>
        {/* Floating assistant, bottom-right, on every portal screen (mockups). */}
        <StudioAI token={token} />
        {/* Horizontal path picker (org › workspace › project) — replaces the
            in-view breadcrumb trail. Each level is a dropdown; picking a project
            opens it, "All projects" drops back to the workspace's project list. */}
        {!adminOpen && (
          <PathBar
            orgs={orgOptions}
            activeOrg={activeOrg}
            onPickOrg={(id) => {
              setActiveOrgId(id);
              setCrumb({});
              setView("projects");
              setActiveSpace(null);
            }}
            workspaces={orgWorkspaces}
            currentWorkspaceId={crumb.projectId}
            onPickWorkspace={(id) => {
              setCrumb(id ? { projectId: id } : {});
              setView("projects");
              setActiveSpace(null);
            }}
            projects={nestedProjects}
            currentProjectId={crumb.nestedId}
            currentProjectName={projectLabel}
            onPickProject={(p) => {
              if (p) {
                setProjectLabel(p.name);
                setCrumb({ projectId: crumb.projectId, nestedId: p.id });
                setProjectTab("overview");
              } else {
                setProjectLabel(undefined);
                setCrumb({ projectId: crumb.projectId });
              }
              setView("projects");
              setActiveSpace(null);
            }}
          />
        )}
        {error && <div className="error">{error}</div>}
        {adminOpen ? (
          <>
            {adminView === "identities" && (
              <IdentityDirectory token={token} query={filters.query} />
            )}
            {adminView === "tenants" && (
              <OrganizationsView
                token={token}
                homeId={me.subject_tenant_id}
                home={home}
                orgs={orgs}
                workspaces={workspaces}
                selectedOrgId={adminOrgId}
                onChanged={refresh}
                onCreated={(id) => setAdminOrgId(id || null)}
                onNew={() => setAdminOrgId("__new__")}
              />
            )}
            {adminView === "people" && (
              <PeopleView
                token={token}
                mode="org"
                org={adminOrg ? { id: adminOrg.id, name: adminOrg.name } : activeOrg}
                roots={workspaces.filter((w) =>
                  adminOrg ? w.orgId === adminOrg.id : w.orgId === activeOrgResolvedId,
                )}
                query={filters.query}
                onOpenProject={(id) => {
                  setAdminOpen(false);
                  setCrumb({ projectId: id });
                  setView("projects");
                }}
              />
            )}
            {adminView === "access" && (
              <AccessView
                token={token}
                org={adminOrg ? { id: adminOrg.id, name: adminOrg.name } : activeOrg}
                selfManaged={
                  adminOrg
                    ? adminOrg.self_managed
                    : orgs.find((o) => o.id === activeOrgResolvedId)?.self_managed ?? false
                }
                projects={workspaces
                  .filter((w) => (adminOrg ? w.orgId === adminOrg.id : w.orgId === activeOrgResolvedId))
                  .map((w) => ({ id: w.id, name: w.name }))}
                meId={me.subject_id}
                meName={userName}
              />
            )}
            {adminView === "workspaces" && (
              <WorkspacesView
                token={token}
                orgs={adminOrg ? [adminOrg] : orgs}
                workspaces={adminOrg ? workspaces.filter((w) => w.orgName === adminOrg.name) : workspaces}
                filters={filters}
                onChanged={refresh}
                onOpenStudio={(ws) => {
                  setAdminOpen(false);
                  setStudio(ws);
                }}
                onOpen={(ws) => {
                  // The platform list is the raw tenant view; opening a row hands
                  // over to the normal project page rather than growing a second
                  // project surface inside the admin zone.
                  setAdminOpen(false);
                  setCrumb({ projectId: ws.id });
                  setView("projects");
                }}
              />
            )}
            {adminView === "connectors" &&
              (orgAsSpace ? (
                /* ConnectorsView is written against a tenant that owns a
                   connection catalogue, which the organization is. Passing it in
                   the project slot makes `inherited` false for its own rows, so
                   the Edit button is enabled here — the whole point of this
                   section, and the reason the org level survives in the model. */
                <ConnectorsView token={token} workspace={orgAsSpace} filters={filters} />
              ) : (
                <div className="card">
                  <h2>Integrations</h2>
                  <p className="empty">No tenant to hold the shared catalogue yet.</p>
                </div>
              ))}
            {adminView === "secrets" && <SecretsView token={token} workspaces={workspaces} filters={filters} />}
          </>
        ) : dash ? (
          <WorkspaceDashboard
            token={token}
            ws={dash}
            onBack={() => setDash(null)}
            onOpenStudio={setStudio}
          />
        ) : (
          <>
        {view === "projects" && (
          <ProjectsView
            token={token}
            workspaces={workspaces}
            orgId={activeOrgResolvedId}
            activeOrg={activeOrg}
            filters={filters}
            crumb={crumb}
            setCrumb={setCrumb}
            projectLabel={projectLabel}
            setProjectLabel={setProjectLabel}
            projectTab={projectTab}
            setProjectTab={setProjectTab}
            onChanged={refresh}
            onOpenStudio={setStudio}
          />
        )}
        {view === "people" && (
          <PeopleView
            token={token}
            mode="org"
            org={activeOrg}
            roots={workspaces.filter((w) => w.orgId === activeOrgResolvedId)}
            query={filters.query}
            onOpenProject={(id) => {
              setCrumb({ projectId: id });
              setView("projects");
            }}
          />
        )}
        {view === "home" && (
          <HomeView
            token={token}
            home={home}
            orgs={orgs}
            workspaces={workspaces}
            spaces={spaces}
            onOpenSpace={(wsId) => setActiveSpace(wsId)}
            onOpenStudio={setStudio}
            onOpenDashboard={setDash}
            onNavigate={setView}
          />
        )}
        {view === "connectors" &&
          (orgAsSpace ? (
            <ConnectorsView token={token} workspace={orgAsSpace} filters={filters} />
          ) : (
            <div className="card">
              <h2>Connections</h2>
              <p className="empty">
                No shared catalogue tenant yet — you can still add a connector inside a project on
                its Sources tab.
              </p>
            </div>
          ))}
        {/* The tenant hierarchy renders only inside the Admin area, under the flag. */}
        {view === "chats" && <ChatsView token={token} filters={filters} />}
        {view === "files" && <FilesView token={token} filters={filters} />}
        {view === "gears" && (
          <ComponentsCatalog
            token={token}
            tenantId={orgAsSpace?.id}
            query={filters.query}
            kindFilter={filters.gearKind}
            sortMode={filters.gearSort}
            hideSdk={filters.gearHideSdk}
            categoryFilter={filters.gearCategory}
            onCategories={setComponentCategories}
          />
        )}
        {view === "system" && <SystemView token={token} filters={filters} />}
        {view === "profile" && <ProfileView me={me} home={home} token={token} />}
          </>
        )}
        {studio && (
          <StudioLauncher
            token={token}
            target={studio}
            onClose={() => setStudio(null)}
            onOpen={(s) => openSpace(studio, s)}
          />
        )}
      </div>

      {!activeSpace && (
        <FilterPanel
          view={panelView}
          token={token}
          filters={filters}
          onChange={setFilters}
          open={panelOpen}
          onToggle={() => setPanelOpen((v) => !v)}
          componentCategories={componentCategories}
        />
      )}
    </div>
  );
}

/* ── Right panel: context-aware filters ── */

function FilterPanel({
  view,
  token,
  filters,
  onChange,
  open,
  onToggle,
  componentCategories,
}: {
  view: PanelView;
  token: string;
  filters: Filters;
  onChange: (f: Filters) => void;
  open: boolean;
  onToggle: () => void;
  componentCategories: string[];
}) {
  const [models, setModels] = useState<import("./api").Model[]>([]);

  useEffect(() => {
    if (view === "chats" && models.length === 0) {
      api
        .models(token)
        .then((p) => setModels(p.items ?? []))
        .catch(() => {
          /* model list is a nicety — search still works */
        });
    }
  }, [view, token, models.length]);

  const count = activeFilterCount(view, filters);
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  const noFilters = view === "profile" || view === "dashboard";
  const hasSearch = !noFilters && view !== "system";

  if (!open) {
    return (
      <aside className="rightbar collapsed">
        <button className="funnel" title="Show filters" onClick={onToggle}>
          <span aria-hidden>🎛</span>
          {count > 0 && <span className="count">{count}</span>}
        </button>
      </aside>
    );
  }

  return (
    <aside className="rightbar">
      <div className="rightbar-head">
        <h2>
          Filters {count > 0 && <span className="count-pill">{count}</span>}
        </h2>
        <div style={{ display: "flex", gap: 4 }}>
          {count > 0 && (
            <button className="ghost" onClick={() => onChange({ ...DEFAULT_FILTERS })}>
              reset
            </button>
          )}
          <button className="ghost" title="Hide filters" onClick={onToggle}>
            ⇥
          </button>
        </div>
      </div>

      {noFilters ? (
        <p className="hint">No filters for this view.</p>
      ) : (
        <>
          {hasSearch && (
            <div className="filter-group">
              <span className="lbl">Search</span>
              <input
                placeholder="Type to filter…"
                value={filters.query}
                onChange={(e) => set({ query: e.target.value })}
              />
            </div>
          )}

          {view === "projects" && (
            <>
              <div className="filter-group">
                <span className="lbl">Mode</span>
                <div className="chipset">
                  <button
                    type="button"
                    className={`chip ${filters.selfManagedOnly ? "on" : ""}`}
                    onClick={() => set({ selfManagedOnly: !filters.selfManagedOnly })}
                  >
                    self-managed only
                  </button>
                </div>
              </div>
              <div className="filter-group">
                <span className="lbl">Sort</span>
                <select
                  value={filters.sort}
                  onChange={(e) => set({ sort: e.target.value as Filters["sort"] })}
                >
                  <option value="name-asc">Name A → Z</option>
                  <option value="name-desc">Name Z → A</option>
                </select>
              </div>
            </>
          )}

          {view === "gears" && (
            <>
              <div className="filter-group">
                <span className="lbl">Kind</span>
                <select value={filters.gearKind} onChange={(e) => set({ gearKind: e.target.value })}>
                  <option value="">All kinds</option>
                  <option value="gear">gear</option>
                  <option value="sdk">sdk</option>
                  <option value="plugin">plugin</option>
                  <option value="toolkit">toolkit</option>
                  <option value="frontx">frontx</option>
                </select>
              </div>
              <div className="filter-group">
                <span className="lbl">Category</span>
                <select
                  value={filters.gearCategory}
                  onChange={(e) => set({ gearCategory: e.target.value })}
                >
                  <option value="">All categories</option>
                  {componentCategories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                  {filters.gearCategory && !componentCategories.includes(filters.gearCategory) && (
                    <option value={filters.gearCategory}>{filters.gearCategory}</option>
                  )}
                </select>
              </div>
              <div className="filter-group">
                <span className="lbl">Sort</span>
                <select
                  value={filters.gearSort}
                  onChange={(e) => set({ gearSort: e.target.value as Filters["gearSort"] })}
                >
                  <option value="name-asc">Name A → Z</option>
                  <option value="name-desc">Name Z → A</option>
                  <option value="downloads-desc">Downloads</option>
                </select>
              </div>
              <div className="filter-group">
                <span className="lbl">Show</span>
                <div className="chipset">
                  <button
                    type="button"
                    className={`chip ${filters.gearHideSdk ? "on" : ""}`}
                    onClick={() => set({ gearHideSdk: !filters.gearHideSdk })}
                  >
                    hide SDK crates
                  </button>
                </div>
              </div>
            </>
          )}

          {view === "chats" && (
            <div className="filter-group">
              <span className="lbl">Model</span>
              <select value={filters.model} onChange={(e) => set({ model: e.target.value })}>
                <option value="">All models</option>
                {models.map((m) => (
                  <option key={m.model_id} value={m.model_id}>
                    {m.display_name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {view === "system" && (
            <div className="filter-group">
              <span className="lbl">Sections</span>
              <div className="chipset">
                {(Object.keys(filters.sections) as (keyof Filters["sections"])[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    className={`chip ${filters.sections[k] ? "on" : ""}`}
                    onClick={() =>
                      set({ sections: { ...filters.sections, [k]: !filters.sections[k] } })
                    }
                  >
                    {k}
                  </button>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

/* ── Projects ── */

/** The right pane of the account popover: pick where you are working.
 *
 *  Organizations first, then the projects OF the one in context — the level
 *  above a project is back, so the menu groups by it instead of showing one
 *  flat column. The organization list is derived from the loaded projects, so
 *  an org with nothing in it never appears here empty. */
function ContextPane({
  token,
  orgs,
  homeId,
  createOrgId,
  workspaces,
  crumb,
  onPick,
  onChanged,
}: {
  token: string;
  /** Organizations that group the projects — derived from the loaded set. */
  orgs: { id: string; name: string }[];
  /** Parent tenant a brand-new organization is created under (the home root). */
  homeId: string | null;
  /** Fallback parent for a brand-new project when no org is in context. */
  createOrgId: string | null;
  workspaces: Workspace[];
  crumb: Crumb;
  onPick: (c: Crumb) => void;
  onChanged: () => void;
}) {
  const [q, setQ] = useState("");
  // Which creator is open, if any — a new organization, or a new project.
  const [adding, setAdding] = useState<"org" | "ws" | null>(null);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Which organization's projects to show. Defaults to the org owning the
  // project in context, else the first org that actually has projects — never
  // an empty one, even though empty orgs are still listed and selectable.
  const [pickedOrg, setPickedOrg] = useState<string | null>(null);
  const ownerOrgId = workspaces.find((w) => w.id === crumb.projectId)?.orgId;
  const activeOrgId =
    pickedOrg ??
    ownerOrgId ??
    orgs.find((o) => workspaces.some((w) => w.orgId === o.id))?.id ??
    orgs[0]?.id ??
    null;

  const orgList = orgs.filter((o) => matches(q, o.name));
  const list = workspaces
    .filter((w) => (activeOrgId ? w.orgId === activeOrgId : true) && matches(q, w.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  async function create(kind: "org" | "ws") {
    // An organization is created under the home root; a project under the org
    // currently in context (falling back to the implicit one).
    const parent = kind === "org" ? homeId : activeOrgId ?? createOrgId;
    if (!parent || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await api.createTenant(token, {
        name: name.trim(),
        parent_id: parent,
        tenant_type: kind === "org" ? TENANT_TYPES.organization : TENANT_TYPES.workspace,
      });
      setName("");
      setAdding(null);
      // Jump straight into a freshly created org so the user can fill it.
      if (kind === "org" && created?.id) setPickedOrg(created.id);
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="pane-right">
      <input
        className="ctx-search"
        placeholder="Search…"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />

      <div className="ctx-head">
        <span>Organizations</span>
        <button
          type="button"
          title="New organization"
          disabled={!homeId}
          onClick={() => setAdding((v) => (v === "org" ? null : "org"))}
        >
          +
        </button>
      </div>
      {adding === "org" && (
        <div className="ctx-add">
          <input
            autoFocus
            placeholder="Organization name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create("org");
            }}
          />
          <button type="button" disabled={busy || !name.trim()} onClick={() => void create("org")}>
            Create
          </button>
        </div>
      )}
      {orgList.map((o) => (
        <div key={o.id} className={`ctx-row${activeOrgId === o.id ? " on" : ""}`}>
          <button type="button" className="grow" onClick={() => setPickedOrg(o.id)}>
            <span className="account-avatar small">{o.name.slice(0, 1).toUpperCase()}</span>
            {o.name}
          </button>
        </div>
      ))}

      <div className="ctx-head">
        <span>Workspaces</span>
        <button
          type="button"
          title="New workspace"
          disabled={!activeOrgId && !createOrgId}
          onClick={() => setAdding((v) => (v === "ws" ? null : "ws"))}
        >
          +
        </button>
      </div>
      {adding === "ws" && (
        <div className="ctx-add">
          <input
            autoFocus
            placeholder="Workspace name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void create("ws");
            }}
          />
          <button type="button" disabled={busy || !name.trim()} onClick={() => void create("ws")}>
            Create
          </button>
        </div>
      )}
      {list.length === 0 ? (
        <p className="empty">No workspaces yet.</p>
      ) : (
        list.map((w) => (
          <div key={w.id} className={`ctx-row${crumb.projectId === w.id ? " on" : ""}`}>
            <button type="button" className="grow" onClick={() => onPick({ projectId: w.id })}>
              <span className="account-avatar small">{w.name.slice(0, 1).toUpperCase()}</span>
              {w.name}
            </button>
          </div>
        ))
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/* ── Project drill-down ────────────────────────────────────────────────────────
 *
 * Two levels of the same noun: the portfolio, then one project, then a nested
 * project inside it. The level above (organizations) is gone from navigation —
 * see the concept note at the top of this file for what survived in the model.
 */

interface Crumb {
  /** Open workspace: the AM tenant of type `workspace` (child of an org).
   *  (Field name kept as `projectId` so the surrounding Shell keeps working.) */
  projectId?: string;
  /** Open project: the AM tenant of type `project` (child of the workspace). */
  nestedId?: string;
}

/** Horizontal path picker: org › workspace › project, each a dropdown. Mirrors
 *  the sidebar switcher pattern (button + menu) but laid out horizontally and
 *  outside the sidebar, so the whole path can be re-picked in one place. The
 *  project level uses the same mechanic as the workspace level: pick one to open
 *  it, "All projects" returns to the workspace's project list. */
function PathBar({
  orgs,
  activeOrg,
  onPickOrg,
  workspaces,
  currentWorkspaceId,
  onPickWorkspace,
  projects,
  currentProjectId,
  currentProjectName,
  onPickProject,
}: {
  orgs: { id: string; name: string }[];
  activeOrg: { id: string; name: string } | null;
  onPickOrg: (id: string) => void;
  workspaces: { id: string; name: string }[];
  currentWorkspaceId?: string;
  onPickWorkspace: (id: string | null) => void;
  projects: { id: string; name: string }[];
  currentProjectId?: string;
  currentProjectName?: string;
  onPickProject: (p: { id: string; name: string } | null) => void;
}) {
  const [open, setOpen] = useState<"org" | "ws" | "proj" | null>(null);
  const initial = (s: string) => (s || "?").slice(0, 1).toUpperCase();
  const currentWs = workspaces.find((w) => w.id === currentWorkspaceId) ?? null;

  return (
    <div className="path-bar" onMouseLeave={() => setOpen(null)}>
      {/* Organization */}
      <div className="path-seg org-select-wrap">
        <button
          type="button"
          className="org-select"
          disabled={orgs.length <= 1}
          title={activeOrg?.name ?? "Organization"}
          onClick={() => setOpen((o) => (o === "org" ? null : "org"))}
        >
          <span className="account-avatar small">{initial(activeOrg?.name ?? "?")}</span>
          <span className="org-select-name">{activeOrg?.name ?? "Organization"}</span>
          {orgs.length > 1 && <span className="chev">▾</span>}
        </button>
        {open === "org" && orgs.length > 1 && (
          <div className="org-menu">
            {orgs.map((o) => (
              <button
                key={o.id}
                type="button"
                className={activeOrg?.id === o.id ? "on" : ""}
                onClick={() => {
                  onPickOrg(o.id);
                  setOpen(null);
                }}
              >
                <span className="account-avatar small">{initial(o.name)}</span>
                {o.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <span className="path-sep">›</span>

      {/* Workspace */}
      <div className="path-seg org-select-wrap">
        <button
          type="button"
          className="org-select"
          title={currentWs?.name ?? "All workspaces"}
          onClick={() => setOpen((o) => (o === "ws" ? null : "ws"))}
        >
          <span className="account-avatar small">{currentWs ? initial(currentWs.name) : "▤"}</span>
          <span className="org-select-name">{currentWs?.name ?? "All workspaces"}</span>
          <span className="chev">▾</span>
        </button>
        {open === "ws" && (
          <div className="org-menu">
            <button
              type="button"
              className={!currentWorkspaceId ? "on" : ""}
              onClick={() => {
                onPickWorkspace(null);
                setOpen(null);
              }}
            >
              <span className="account-avatar small">▤</span>
              All workspaces
            </button>
            {workspaces.map((w) => (
              <button
                key={w.id}
                type="button"
                className={currentWorkspaceId === w.id ? "on" : ""}
                onClick={() => {
                  onPickWorkspace(w.id);
                  setOpen(null);
                }}
              >
                <span className="account-avatar small">{initial(w.name)}</span>
                {w.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Project — only meaningful once a workspace is chosen */}
      {currentWorkspaceId && (
        <>
          <span className="path-sep">›</span>
          <div className="path-seg org-select-wrap">
            <button
              type="button"
              className="org-select"
              title={currentProjectName ?? "All projects"}
              onClick={() => setOpen((o) => (o === "proj" ? null : "proj"))}
            >
              <span className="account-avatar small">
                {currentProjectName ? initial(currentProjectName) : "▦"}
              </span>
              <span className="org-select-name">{currentProjectName ?? "All projects"}</span>
              <span className="chev">▾</span>
            </button>
            {open === "proj" && (
              <div className="org-menu">
                <button
                  type="button"
                  className={!currentProjectId ? "on" : ""}
                  onClick={() => {
                    onPickProject(null);
                    setOpen(null);
                  }}
                >
                  <span className="account-avatar small">▦</span>
                  All projects
                </button>
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    className={currentProjectId === p.id ? "on" : ""}
                    onClick={() => {
                      onPickProject(p);
                      setOpen(null);
                    }}
                  >
                    <span className="account-avatar small">{initial(p.name)}</span>
                    {p.name}
                  </button>
                ))}
                {projects.length === 0 && (
                  <div className="sub" style={{ padding: "6px 10px" }}>
                    No projects yet
                  </div>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Breadcrumbs({
  items,
}: {
  items: { label: string; onClick?: () => void }[];
}) {
  return (
    <nav className="crumbs">
      {items.map((it, i) => (
        <span key={`${it.label}-${i}`}>
          {i > 0 && <span className="crumb-sep">/</span>}
          {it.onClick ? (
            <button type="button" className="linklike" onClick={it.onClick}>
              {it.label}
            </button>
          ) : (
            <span className="crumb-here">{it.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

function ProjectsView({
  token,
  workspaces,
  orgId,
  activeOrg,
  filters,
  crumb,
  setCrumb,
  projectLabel,
  setProjectLabel,
  projectTab,
  setProjectTab,
  onChanged,
  onOpenStudio,
}: {
  token: string;
  workspaces: Workspace[];
  /** Active organization, chosen in the sidebar switcher and resolved by the
   *  shell to one that actually holds projects. New projects are created here. */
  orgId: string | null;
  activeOrg: { id: string; name: string } | null;
  filters: Filters;
  crumb: Crumb;
  setCrumb: (c: Crumb) => void;
  projectLabel?: string;
  setProjectLabel: (n: string | undefined) => void;
  /** Open project's active tab — the sidebar owns this (see the shell). */
  projectTab: ProjTab;
  setProjectTab: (t: ProjTab) => void;
  onChanged: () => void;
  onOpenStudio: (target: StudioTarget) => void;
}) {
  const orgRoots = workspaces.filter((w) => w.orgId === orgId);
  const root = workspaces.find((w) => w.id === crumb.projectId);

  // Level 1 — the portfolio of workspaces (org children of type workspace).
  if (!root) {
    return (
      <ProjectsPortfolio
        token={token}
        roots={orgRoots}
        org={activeOrg}
        query={filters.query}
        selfManagedOnly={filters.selfManagedOnly}
        sort={filters.sort}
        homeOrgId={orgId}
        onOpen={(r) => setCrumb({ projectId: r.id })}
        onOpenStudio={(r) => {
          const ws = workspaces.find((w) => w.id === r.id);
          if (ws) onOpenStudio(ws);
        }}
        onOpenProject={(wsId, p) => {
          setProjectLabel(p.name);
          setCrumb({ projectId: wsId, nestedId: p.id });
        }}
        onChanged={onChanged}
      />
    );
  }

  const trail: { label: string; onClick?: () => void }[] = [
    ...(activeOrg ? [{ label: activeOrg.name, onClick: () => setCrumb({}) }] : []),
    { label: "Workspaces", onClick: () => setCrumb({}) },
    {
      label: root.name,
      onClick: crumb.nestedId ? () => setCrumb({ projectId: root.id }) : undefined,
    },
  ];
  if (crumb.nestedId) trail.push({ label: projectLabel ?? "project" });

  // Level 3 — an open project (its own AM tenant): a self-contained screen.
  if (crumb.nestedId) {
    return (
      <>
        <Breadcrumbs items={trail} />
        <ProjectScreen
          key={crumb.nestedId}
          token={token}
          projectTenantId={crumb.nestedId}
          workspace={root}
          filters={filters}
          tab={projectTab}
          setTab={setProjectTab}
          onBack={() => setCrumb({ projectId: root.id })}
          onOpenStudio={onOpenStudio}
        />
      </>
    );
  }

  // Level 2 — the workspace: its projects, then its own properties panel
  // (workspace settings), reusing the same dashboard the project Overview uses.
  return (
    <>
      <Breadcrumbs items={trail} />
      <WorkspaceProjects
        token={token}
        workspace={root}
        onOpenProject={(p) => {
          setProjectLabel(p.name);
          setCrumb({ projectId: root.id, nestedId: p.id });
        }}
        onChanged={onChanged}
      />
      <div style={{ marginTop: 20 }}>
        <DocumentTypesTab token={token} workspaceId={root.id} />
      </div>
    </>
  );
}

/** Level 2: the projects (child tenants of type `project`) inside a workspace,
 *  plus a "New project" that creates a project tenant + its config metadata. */
function WorkspaceProjects({
  token,
  workspace,
  onOpenProject,
  onChanged,
}: {
  token: string;
  workspace: Workspace;
  onOpenProject: (p: { id: string; name: string }) => void;
  onChanged: () => void;
}) {
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<import("./api").ProjectKind>("new_gears");
  const [conns, setConns] = useState<import("./api").Connection[]>([]);
  const [connId, setConnId] = useState("");
  const [repoMode, setRepoMode] = useState<"create" | "existing">("create");
  const [repoName, setRepoName] = useState("");
  const [owner, setOwner] = useState("");
  const [isOrg, setIsOrg] = useState(false);
  const [priv, setPriv] = useState(true);
  const [remoteRepos, setRemoteRepos] = useState<import("./api").RemoteRepo[]>([]);
  const [pickedRepo, setPickedRepo] = useState("");
  // Inline row editing (rename) + per-row busy for edit/delete.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setErr(null);
    try {
      const page = await api.tenantChildren(token, workspace.id);
      setProjects(
        (page.items ?? [])
          .filter((t) => t.tenant_type === TENANT_TYPES.project)
          .map((t) => ({ id: t.id, name: t.name })),
      );
    } catch (e) {
      setErr(errText(e));
    }
  }, [token, workspace.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Load the workspace's connections when the create card opens.
  useEffect(() => {
    if (!creating) return;
    api
      .connections(token, workspace.id)
      .then((r) => setConns(r.items ?? []))
      .catch(() => {});
  }, [creating, token, workspace.id]);

  // Repo mode allowed per project kind: product always creates a new repo,
  // an imported existing app always picks one, new-gears defaults to create.
  useEffect(() => {
    if (newKind === "product") setRepoMode("create");
    else if (newKind === "existing") setRepoMode("existing");
    else setRepoMode("create");
  }, [newKind]);

  // When picking an existing repo, list the chosen connection's repositories.
  useEffect(() => {
    if (!creating || repoMode !== "existing" || !connId) return;
    api
      .connectionRepositories(token, connId, workspace.id)
      .then((r) => setRemoteRepos(r.items ?? []))
      .catch(() => setRemoteRepos([]));
  }, [creating, repoMode, connId, token, workspace.id]);

  const repoDir = (fullPath: string) =>
    (fullPath.split("/").pop() ?? fullPath).toLowerCase().replace(/[^a-z0-9_-]+/g, "-");

  const create = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setErr(null);
    try {
      const tenant = await api.createTenant(token, {
        name,
        parent_id: workspace.id,
        tenant_type: TENANT_TYPES.project,
      });
      await api
        .putProjectConfig(token, tenant.id, {
          mode: newKind === "existing" ? "modernize" : "greenfield",
          kind: newKind,
          stages: [],
          status: "draft",
        })
        .catch(() => {});

      // Resolve the project's repository: create a new one, or attach an existing.
      const conn = conns.find((c) => c.id === connId);
      let repoFull = "";
      let branch = "main";
      let cloneUrl = "";
      if (repoMode === "create") {
        if (!repoName.trim()) throw new Error("enter a name for the new repository");
        const r = await api.createProjectRepo(token, tenant.id, {
          tenant: workspace.id,
          connection_id: connId || null,
          owner: isOrg ? owner.trim() : undefined,
          is_org: isOrg,
          name: repoName.trim(),
          private: priv,
        });
        repoFull = r.full_name;
        branch = r.default_branch || "main";
        cloneUrl = `https://github.com/${r.full_name}.git`;
      } else {
        const picked = remoteRepos.find((r) => r.full_path === pickedRepo);
        if (!picked) throw new Error("pick a repository to attach");
        repoFull = picked.full_path;
        branch = picked.default_branch || "main";
        cloneUrl = picked.clone_url;
        await api.setProjectGearRepo(token, tenant.id, {
          tenant: workspace.id,
          connection_id: connId || null,
          repo: repoFull,
          branch,
        });
      }

      // Add it to the project's repositories list (shown by Repositories/Sources).
      const s = (await api.workspaceSettings(token, tenant.id).catch(() => null)) ?? {};
      const entry: import("./api").RepoEntry = {
        name: repoDir(repoFull),
        source: "github",
        url: cloneUrl,
        target: repoDir(repoFull),
        branch,
        token_ref: conn?.secret_ref,
      };
      await api
        .putWorkspaceSettings(token, tenant.id, { ...s, repos: [...(s.repos ?? []), entry] })
        .catch(() => {});

      setNewName("");
      setRepoName("");
      setPickedRepo("");
      setCreating(false);
      await reload();
      onChanged();
      onOpenProject({ id: tenant.id, name });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const startEdit = (p: { id: string; name: string }) => {
    setEditingId(p.id);
    setEditName(p.name);
    setErr(null);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
  };
  const saveEdit = async (id: string) => {
    const name = editName.trim();
    if (!name) return;
    setRowBusy(id);
    setErr(null);
    try {
      await api.updateTenant(token, id, { name });
      cancelEdit();
      await reload();
      onChanged();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setRowBusy(null);
    }
  };
  const remove = async (p: { id: string; name: string }) => {
    if (!window.confirm(`Delete project “${p.name}”? This cannot be undone.`)) return;
    setRowBusy(p.id);
    setErr(null);
    try {
      await api.deleteTenant(token, p.id);
      await reload();
      onChanged();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setRowBusy(null);
    }
  };

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{workspace.name}</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            workspace · <code>{workspace.id.slice(0, 8)}…</code>
          </p>
        </div>
        <button className="primary" onClick={() => setCreating((v) => !v)}>
          New project
        </button>
      </div>
      {err && <div className="error">{err}</div>}
      {creating && (
        <div className="card">
          <div className="card-head">
            <h2>New project</h2>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 640 }}>
            <input
              placeholder="Project name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />

            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Project type</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(
                  [
                    ["new_gears", "New Gears", "Build new gears. Create a new repo, or use an existing gear store."],
                    ["product", "Product from Gears", "Assemble a product from gears. A new repository is created."],
                    ["existing", "Existing Gears app", "Import a gears-based app already built. Attach its repository."],
                  ] as [import("./api").ProjectKind, string, string][]
                ).map(([k, title, desc]) => (
                  <label
                    key={k}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "flex-start",
                      padding: "8px 10px",
                      border: "1px solid var(--border,#e2e4e9)",
                      borderRadius: 8,
                      background: newKind === k ? "var(--accent-soft,#eef2ff)" : "transparent",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="radio"
                      name="pkind"
                      checked={newKind === k}
                      onChange={() => setNewKind(k)}
                      style={{ marginTop: 2 }}
                    />
                    <span>
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
                      <div style={{ fontSize: 11, opacity: 0.7 }}>{desc}</div>
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div>
              <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>Repository</div>
              <select value={connId} onChange={(e) => setConnId(e.target.value)} style={{ marginBottom: 8, width: "100%" }}>
                <option value="">First GitHub connection</option>
                {conns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} · {c.provider} · {c.account}
                  </option>
                ))}
              </select>

              {newKind === "new_gears" && (
                <div style={{ display: "flex", gap: 12, marginBottom: 8, fontSize: 12 }}>
                  <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <input type="radio" name="repomode" checked={repoMode === "create"} onChange={() => setRepoMode("create")} />
                    Create new
                  </label>
                  <label style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <input type="radio" name="repomode" checked={repoMode === "existing"} onChange={() => setRepoMode("existing")} />
                    Use existing gear store
                  </label>
                </div>
              )}

              {repoMode === "create" ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                  <input placeholder="new repo name" value={repoName} onChange={(e) => setRepoName(e.target.value)} />
                  <label style={{ fontSize: 12, display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={isOrg} onChange={(e) => setIsOrg(e.target.checked)} />
                    under org
                  </label>
                  {isOrg && (
                    <input placeholder="org login" value={owner} onChange={(e) => setOwner(e.target.value)} style={{ width: 140 }} />
                  )}
                  <label style={{ fontSize: 12, display: "inline-flex", gap: 6, alignItems: "center" }}>
                    <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} />
                    private
                  </label>
                </div>
              ) : (
                <select value={pickedRepo} onChange={(e) => setPickedRepo(e.target.value)} style={{ width: "100%" }} disabled={!connId}>
                  <option value="">{connId ? "— select a repository —" : "pick a connection first"}</option>
                  {remoteRepos.map((r) => (
                    <option key={r.id} value={r.full_path}>
                      {r.full_path}
                      {r.visibility ? ` · ${r.visibility}` : ""}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button className="primary" onClick={() => void create()} disabled={!newName.trim() || busy}>
                {busy ? "Creating…" : "Create project"}
              </button>
              <button className="ghost" onClick={() => setCreating(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="card">
        <div className="card-head">
          <h2>Projects{projects ? ` · ${projects.length}` : ""}</h2>
        </div>
        {projects === null ? (
          <p className="empty">Loading…</p>
        ) : projects.length === 0 ? (
          <div className="empty" style={{ textAlign: "center", padding: "28px 12px" }}>
            <div style={{ fontSize: 30, opacity: 0.4, marginBottom: 10 }}>▦</div>
            <div style={{ marginBottom: 14 }}>
              No projects yet — create one to get a codebase context (sources, IDE, artifacts).
            </div>
            <button className="primary" onClick={() => setCreating(true)}>
              New project
            </button>
          </div>
        ) : (
          <table className="ptable">
            <thead>
              <tr>
                <th>Project</th>
                <th>ID</th>
                <th aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {projects.map((p) => {
                const editing = editingId === p.id;
                const busyRow = rowBusy === p.id;
                return (
                  <tr key={p.id} className="prow root">
                    <td>
                      <div className="pcell">
                        <span className="pico" aria-hidden>▦</span>
                        <div>
                          {editing ? (
                            <input
                              value={editName}
                              autoFocus
                              onChange={(e) => setEditName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") void saveEdit(p.id);
                                if (e.key === "Escape") cancelEdit();
                              }}
                              style={{ width: "100%" }}
                            />
                          ) : (
                            <button type="button" className="pname" onClick={() => onOpenProject(p)}>
                              {p.name}
                            </button>
                          )}
                          <div className="sub">project</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <code>{p.id.slice(0, 8)}…</code>
                    </td>
                    <td className="pactions">
                      {editing ? (
                        <>
                          <button className="primary" disabled={busyRow || !editName.trim()} onClick={() => void saveEdit(p.id)}>
                            {busyRow ? "Saving…" : "Save"}
                          </button>
                          <button className="ghost" disabled={busyRow} onClick={cancelEdit}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button onClick={() => onOpenProject(p)}>Open</button>
                          <button className="ghost" disabled={busyRow} onClick={() => startEdit(p)}>
                            Edit
                          </button>
                          <button className="ghost" disabled={busyRow} title="Delete project" onClick={() => void remove(p)}>
                            ✕
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/** Project attributes (mode / status / stages / brief) — the fields the retired
 *  studio-project gear used to own, now stored as `project.config` tenant
 *  metadata on the project tenant and edited here. Status is forward-only and
 *  the stage list is validated against the catalogue, both client-side now. */
/** The sections of an open project. Lifted so the shell sidebar can BE the
 *  project's nav (the tab is stored on the shell, not inside ProjectScreen). */
type ProjTab = "overview" | "artifacts" | "documents" | "kits" | "analyze" | "automation" | "people";
const PROJECT_TABS: { id: ProjTab; icon: string; label: string }[] = [
  { id: "overview", icon: "home", label: "Overview" },
  { id: "artifacts", icon: "file", label: "Artifacts" },
  { id: "documents", icon: "file", label: "Documents" },
  { id: "kits", icon: "package", label: "Kits" },
  { id: "analyze", icon: "scan", label: "Spec Quality" },
  { id: "automation", icon: "shield", label: "Automation" },
  { id: "people", icon: "users", label: "Team" },
];

/** Level 3: one project (its own AM tenant). The tabs live in the sidebar; this
 *  renders the active one for the code context (sources, IDE, artifacts,
 *  spec-quality) scoped to the project tenant id. */
function ProjectScreen({
  token,
  projectTenantId,
  workspace,
  filters,
  tab,
  setTab,
  onBack,
  onOpenStudio,
}: {
  token: string;
  projectTenantId: string;
  workspace: Workspace;
  filters: Filters;
  /** Active tab — lifted to the shell so the sidebar is the project's nav. */
  tab: ProjTab;
  setTab: (t: ProjTab) => void;
  onBack: () => void;
  onOpenStudio: (target: StudioTarget) => void;
}) {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .tenant(token, projectTenantId)
      .then((t) => {
        if (!cancelled) setTenant(t);
      })
      .catch((e) => {
        if (!cancelled) setErr(errText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [token, projectTenantId]);

  if (err) return <div className="error">{err}</div>;
  if (!tenant) return <p className="empty">Loading project…</p>;

  // A project tenant, presented as a Workspace so the existing tab components
  // (which take a Workspace) operate on it unchanged.
  const proj = { ...tenant, orgId: workspace.orgId, orgName: workspace.orgName } as Workspace;

  return (
    <>
      <div className="topbar">
        <div>
          <h1>{tenant.name}</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            project · <code>{tenant.id.slice(0, 8)}…</code>
          </p>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={onBack}>← {workspace.name}</button>
          <button className="primary" onClick={() => onOpenStudio(proj)}>
            Open in IDE
          </button>
        </div>
      </div>
      <div className="proj-content">
        {tab === "overview" && (
          <>
            <WorkspaceDashboard token={token} ws={proj} embedded onBack={onBack} onOpenStudio={onOpenStudio} />
          </>
        )}
        {tab === "artifacts" && (
          <ArtifactsView
            token={token}
            workspace={proj}
            parentWorkspaceId={workspace.id}
            onOpenStudio={onOpenStudio}
          />
        )}
        {tab === "kits" && <ProjectKits token={token} projectId={proj.id} />}
        {tab === "documents" && (
          <DocumentsTab token={token} workspaceId={workspace.id} projectTenantId={proj.id} />
        )}
        {tab === "analyze" && (
          <SpecQuality token={token} workspaceId={proj.id} parentWorkspaceId={workspace.id} />
        )}
        {tab === "automation" && <AutomationSettings token={token} ws={proj} />}
        {tab === "people" && (
          <PeopleView
            token={token}
            mode="team"
            org={{ id: proj.orgId, name: proj.orgName }}
            roots={[proj]}
            query={filters.query}
            onOpenProject={() => setTab("overview")}
          />
        )}
      </div>
    </>
  );
}

function WorkspacesView({
  token,
  orgs,
  workspaces,
  filters,
  onChanged,
  onOpenStudio,
  onOpen,
  heading = true,
}: {
  token: string;
  orgs: Tenant[];
  workspaces: Workspace[];
  filters: Filters;
  onChanged: () => void;
  onOpenStudio: (target: StudioTarget) => void;
  /** Drill into a workspace. */
  onOpen: (ws: Workspace) => void;
  /** Off when rendered as a level inside an organization, which has its own. */
  heading?: boolean;
}) {
  const [name, setName] = useState("");
  const [orgId, setOrgId] = useState(orgs.length === 1 ? orgs[0].id : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const orgFilterName = orgs.find((o) => o.id === filters.org)?.name;
  const visible = workspaces
    .filter((w) => matches(filters.query, w.name, w.orgName))
    .filter((w) => !orgFilterName || w.orgName === orgFilterName)
    .filter((w) => !filters.selfManagedOnly || w.self_managed)
    .sort((a, b) =>
      filters.sort === "name-desc" ? b.name.localeCompare(a.name) : a.name.localeCompare(b.name),
    );

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.createTenant(token, {
        name,
        parent_id: orgId,
        tenant_type: TENANT_TYPES.workspace,
      });
      setName("");
      onChanged();
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(w: Workspace) {
    if (!window.confirm(`Delete workspace “${w.name}”? This cannot be undone.`)) return;
    setError(null);
    try {
      await api.deleteTenant(token, w.id);
      onChanged();
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <>
      {heading && (
        <>
          <h1>Project tenants</h1>
          <p className="subtitle">
            The raw tenant list behind the projects — one AM tenant of type <code>workspace</code>
            per project. Concept v2 does not show this level; it is here so the hierarchy stays
            administrable.
          </p>
        </>
      )}
      <div className="card">
        {workspaces.length === 0 ? (
          <p className="empty">No workspaces yet — create the first one below.</p>
        ) : visible.length === 0 ? (
          <p className="empty">No workspaces match the current filters.</p>
        ) : (
          <ul className="rows">
            {visible.map((w) => (
              <li key={w.id}>
                <div
                  className="grow"
                  style={{ cursor: "pointer" }}
                  onClick={() => onOpen(w)}
                  title="Open this project"
                >
                  <div className="name">{w.name}</div>
                  <div className="sub">{w.orgName}</div>
                </div>
                <span className="badge workspace">tenant</span>
                {w.self_managed && <span className="badge selfmanaged">self-managed</span>}
                <button onClick={() => onOpen(w)}>Open</button>
                <button className="primary" onClick={() => onOpenStudio(w)}>
                  Open in IDE
                </button>
                <button className="ghost" title="Delete workspace" onClick={() => void remove(w)}>
                  ✕
                </button>
              </li>
            ))}
          </ul>
        )}
        <form className="inline" onSubmit={create}>
          <input placeholder="New workspace name" value={name} onChange={(e) => setName(e.target.value)} />
          <select value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            <option value="">organization…</option>
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <button className="primary" disabled={busy || !name || !orgId}>
            Create
          </button>
        </form>
        {error && <div className="error">{error}</div>}
      </div>
    </>
  );
}

/* ── Workspace Dashboard (vision journey J2: onboard a project) ── */

const WORKER_CATEGORIES = ["documenting", "coding", "review", "analysis"];


// Repository credentials are workspace-scoped (tenant sharing), so the
// api_key secret type is the right one — personal_token is private-only by
// definition and credstore rejects tenant sharing for it.
const PAT_SECRET_TYPE = "gts.cf.core.credstore.secret.v1~cf.core.credstore.api_key.v1~";

// Personal AI keys are per-user, so they use the private-only `personal_token`
// type (credstore rejects tenant sharing for it) and are written with
// sharing: "private". The IDE launch resolves `openai-key`/`anthropic-key`
// under the launching user's identity and the credstore returns that user's
// private secret ahead of any org-wide one — so a key set in Profile overrides
// the organization fallback for that user only.
const PERSONAL_SECRET_TYPE =
  "gts.cf.core.credstore.secret.v1~cf.core.credstore.personal_token.v1~";

/** Automation trust ramp for a project — moved out of the overview into its own
 *  sidebar tab. Loads/saves the workspace settings (automation_level + approved
 *  worker categories) as GTS-validated tenant metadata. */
function AutomationSettings({ token, ws }: { token: string; ws: Workspace }) {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await api.workspaceSettings(token, ws.id);
      setSettings(s ?? { automation_level: "recommendations", approved_worker_categories: [] });
    } catch (e) {
      setError(errText(e));
    }
  }, [token, ws.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (!settings) return;
    setError(null);
    setSaved(false);
    try {
      await api.putWorkspaceSettings(token, ws.id, settings);
      setSaved(true);
    } catch (err) {
      setError(errText(err));
    }
  }

  return (
    <div className="card">
      <h2>Automation — trust ramp</h2>
      <p className="hint">
        The domain model's trust ramp, per project: <b>manual</b> = read-only insight,{" "}
        <b>recommendations</b> = prepared actions awaiting approval, <b>autonomous</b> = approved
        automation for the categories below. Stored as tenant metadata (GTS-validated).
      </p>
      {error && <div className="error">{error}</div>}
      {!settings ? (
        <p className="empty">Loading…</p>
      ) : (
        <form onSubmit={save}>
          <label className="field" style={{ maxWidth: 320 }}>
            Automation level
            <select
              style={{ display: "block", width: "100%", marginTop: 6 }}
              value={settings.automation_level ?? "recommendations"}
              onChange={(e) =>
                setSettings({
                  ...settings,
                  automation_level: e.target.value as WorkspaceSettings["automation_level"],
                })
              }
            >
              <option value="manual">manual — humans do everything</option>
              <option value="recommendations">recommendations — workers suggest, humans approve</option>
              <option value="autonomous">autonomous — approved workers act on their own</option>
            </select>
          </label>
          <div className="field">
            Approved worker categories
            <div style={{ display: "flex", gap: 14, marginTop: 6, flexWrap: "wrap" }}>
              {WORKER_CATEGORIES.map((c) => (
                <label key={c} style={{ fontWeight: 400 }}>
                  <input
                    type="checkbox"
                    checked={settings.approved_worker_categories?.includes(c) ?? false}
                    onChange={(e) => {
                      const cur = new Set(settings.approved_worker_categories ?? []);
                      if (e.target.checked) cur.add(c);
                      else cur.delete(c);
                      setSettings({ ...settings, approved_worker_categories: [...cur] });
                    }}
                  />{" "}
                  {c}
                </label>
              ))}
            </div>
          </div>
          <button className="primary">Save settings</button>
          {saved && (
            <span className="hint" style={{ marginLeft: 10 }}>
              saved ✓
            </span>
          )}
        </form>
      )}
    </div>
  );
}

function WorkspaceDashboard({
  token,
  ws,
  onBack,
  onOpenStudio,
  embedded = false,
}: {
  token: string;
  ws: Workspace;
  onBack: () => void;
  onOpenStudio: (target: StudioTarget) => void;
  /** Rendered inside the workspace row rather than as its own page: the row
   *  already shows the name and carries "Open in IDE", so the topbar would be
   *  a second copy of both. */
  embedded?: boolean;
}) {
  const [settings, setSettings] = useState<WorkspaceSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await api.workspaceSettings(token, ws.id);
      setSettings(s ?? { automation_level: "recommendations", approved_worker_categories: [] });
    } catch (e) {
      setError(errText(e));
    }
  }, [token, ws.id]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      {!embedded && (
        <div className="topbar">
          <div>
            <h1>{ws.name}</h1>
            <p className="subtitle" style={{ margin: 0 }}>
              {ws.orgName} · <code>{ws.id.slice(0, 8)}…</code>
            </p>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={onBack}>← Back</button>
            <button className="primary" onClick={() => onOpenStudio(ws)}>
              Open in IDE
            </button>
          </div>
        </div>
      )}
      {error && <div className="error">{error}</div>}

      {/* Project at a glance: identity, attached repositories, and a placeholder
          for the artifact map + work status that will render here next. */}
      <div className="card">
        <div className="card-head">
          <h2>Project</h2>
        </div>
        <ul className="rows">
          <li>
            <div className="grow">
              <div className="name">{ws.name}</div>
              <div className="sub">
                id <code>{ws.id}</code>
                {ws.orgName ? ` · ${ws.orgName}` : ""}
                {ws.self_managed ? " · self-managed" : ""}
              </div>
            </div>
          </li>
        </ul>
        <p className="hint">
          {settings?.root_repo_url
            ? `Workspace repository: ${settings.root_repo_url}`
            : settings?.root_path
              ? `Workspace folder: ${settings.root_path}`
              : "Managed workspace — sources are cloned in when a session launches."}
        </p>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>
            Repositories
            {settings?.repos && settings.repos.length > 0 ? ` · ${settings.repos.length}` : ""}
          </h2>
          {onOpenStudio && (
            <button className="primary" onClick={() => onOpenStudio(ws)}>
              Open in IDE
            </button>
          )}
        </div>
        {!settings ? (
          <p className="empty">Loading…</p>
        ) : (settings.repos?.length ?? 0) === 0 ? (
          <p className="empty">No repositories attached — add them on the Artifacts tab.</p>
        ) : (
          <ul className="rows">
            {settings.repos!.map((r) => (
              <li key={r.name}>
                <div className="grow">
                  <div className="name">{r.name}</div>
                  <div className="sub">
                    {r.source}
                    {r.url ? ` · ${r.url}` : ""}
                    {r.branch ? ` · ${r.branch}` : ""}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

    </>
  );
}

/* ── Chats (mini-chat: threads, history, models) ── */

function ChatsView({ token, filters }: { token: string; filters: Filters }) {
  const [chats, setChats] = useState<import("./api").Chat[]>([]);
  const [models, setModels] = useState<import("./api").Model[]>([]);
  const [open, setOpen] = useState<import("./api").Chat | null>(null);
  const [history, setHistory] = useState<import("./api").ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [live, setLive] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [c, m] = await Promise.all([api.chats(token), api.models(token)]);
      setChats(c.items ?? []);
      setModels(m.items ?? []);
    } catch (e) {
      setError(errText(e));
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openChat(c: import("./api").Chat) {
    setOpen(c);
    setHistory([]);
    setLive(null);
    try {
      const page = await api.chatMessages(token, c.id);
      setHistory(page.items ?? []);
    } catch (e) {
      setError(errText(e));
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!open || !input.trim()) return;
    const content = input.trim();
    setInput("");
    setBusy(true);
    setHistory((h) => [
      ...h,
      { id: crypto.randomUUID(), role: "user", content, created_at: new Date().toISOString() },
    ]);
    setLive("…");
    try {
      await api.streamMessage(token, open.id, content, setLive);
      const page = await api.chatMessages(token, open.id);
      setHistory(page.items ?? []);
      setLive(null);
      await load();
    } catch (err) {
      setLive(null);
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(c: import("./api").Chat) {
    try {
      await api.deleteChat(token, c.id);
      if (open?.id === c.id) setOpen(null);
      await load();
    } catch (e) {
      setError(errText(e));
    }
  }

  const visibleChats = chats
    .filter((c) => matches(filters.query, c.title, c.model, c.id))
    .filter((c) => !filters.model || c.model === filters.model);

  return (
    <>
      <h1>Chats</h1>
      <p className="subtitle">
        mini-chat gear · models: {models.map((m) => m.display_name).join(", ") || "…"}
      </p>
      {error && <div className="error">{error}</div>}

      <div className="card">
        {chats.length === 0 ? (
          <p className="empty">No chats yet — start one from a project overview (Ask AI).</p>
        ) : visibleChats.length === 0 ? (
          <p className="empty">No chats match the current filters.</p>
        ) : (
          <ul className="rows">
            {visibleChats.map((c) => (
              <li key={c.id}>
                <div className="grow" style={{ cursor: "pointer" }} onClick={() => openChat(c)}>
                  <div className="name">{c.title ?? c.id.slice(0, 8)}</div>
                  <div className="sub">
                    {c.model} · {c.message_count} messages
                  </div>
                </div>
                <button onClick={() => openChat(c)}>open</button>
                <button className="ghost" onClick={() => remove(c)}>
                  delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {open && (
        <div className="card">
          <div className="card-head">
            <h2>{open.title ?? open.id.slice(0, 8)}</h2>
            <button className="ghost" onClick={() => setOpen(null)}>
              close
            </button>
          </div>
          <div style={{ maxHeight: 380, overflowY: "auto" }}>
            {history.map((m) => (
              <p key={m.id} style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>
                <strong>{m.role === "user" ? "You" : "AI"}:</strong> {m.content}
              </p>
            ))}
            {live !== null && (
              <p style={{ margin: "6px 0", whiteSpace: "pre-wrap" }}>
                <strong>AI:</strong> {live}
              </p>
            )}
          </div>
          <form className="inline" onSubmit={send}>
            <input value={input} onChange={(e) => setInput(e.target.value)} disabled={busy} />
            <button className="primary" disabled={busy || !input.trim()}>
              {busy ? "Streaming…" : "Send"}
            </button>
          </form>
        </div>
      )}
    </>
  );
}

/* ── Files (file-storage: read-only until an upload sidecar is deployed) ── */

function FilesView({ token, filters }: { token: string; filters: Filters }) {
  const [files, setFiles] = useState<import("./api").StoredFile[] | null>(null);
  const [storages, setStorages] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([api.files(token), api.storages(token)])
      .then(([f, s]) => {
        setFiles(f.items ?? []);
        setStorages(s);
      })
      .catch((e) => setError(errText(e)));
  }, [token]);

  const visibleFiles = (files ?? []).filter((f) =>
    matches(filters.query, f.name, f.file_name, f.id),
  );

  const storageItems: unknown[] | null = Array.isArray(storages)
    ? storages
    : storages && typeof storages === "object" && "items" in storages &&
        Array.isArray((storages as { items: unknown[] }).items)
      ? (storages as { items: unknown[] }).items
      : null;

  return (
    <>
      <h1>Files</h1>
      <p className="subtitle">
        The file-storage gear is the platform's blob store: in the domain model it backs
        Documents, Text Content and chat Attachments. Today it serves mini-chat attachments;
        uploads go through signed URLs from a separate sidecar this dev assembly doesn't run —
        so the view is read-only and usually empty.
      </p>
      {error && <div className="error">{error}</div>}
      <div className="card">
        <h2>Files</h2>
        {!files || files.length === 0 ? (
          <p className="empty">
            Nothing stored yet — files appear here once chats get attachments (or the upload
            sidecar is deployed).
          </p>
        ) : visibleFiles.length === 0 ? (
          <p className="empty">No files match the current filters.</p>
        ) : (
          <ul className="rows">
            {visibleFiles.map((f) => (
              <li key={f.id}>
                <div className="grow">
                  <div className="name">{f.name ?? f.file_name ?? f.id}</div>
                  <div className="sub">{f.id}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {storageItems && storageItems.length > 0 && (
        <div className="card">
          <h2>Storage backends ({storageItems.length})</h2>
          <pre style={{ overflow: "auto", fontSize: 12 }}>{JSON.stringify(storageItems, null, 2)}</pre>
        </div>
      )}
    </>
  );
}

/* ── System (observability across platform gears) ── */

function SystemView({ token, filters }: { token: string; filters: Filters }) {
  const [gears, setGears] = useState<unknown>(null);
  const [upstreams, setUpstreams] = useState<unknown>(null);
  const [entities, setEntities] = useState<unknown>(null);

  useEffect(() => {
    (async () => {
      const grab = async (p: Promise<unknown>) => p.catch((e) => ({ error: errText(e) }));
      setGears(await grab(api.gears(token)));
      setUpstreams(await grab(api.oagwUpstreams(token)));
      setEntities(await grab(api.gtsEntities(token)));
    })();
  }, [token]);

  const count = (v: unknown): string => {
    if (Array.isArray(v)) return String(v.length);
    if (v && typeof v === "object") {
      // Different gears wrap their list under different keys; accept the common ones.
      for (const key of ["items", "gears", "nodes", "data"]) {
        const arr = (v as Record<string, unknown>)[key];
        if (Array.isArray(arr)) return String(arr.length);
      }
    }
    return "—";
  };

  const cards: { key: keyof Filters["sections"]; title: string; sub: string; data: unknown }[] = [
    { key: "gears", title: `Gears (${count(gears)})`, sub: "gear-orchestrator/v1/gears", data: gears },
    { key: "upstreams", title: `OAGW upstreams (${count(upstreams)})`, sub: "oagw/v1/upstreams — the openai LLM egress lives here", data: upstreams },
    { key: "entities", title: `GTS entities (${count(entities)})`, sub: "types-registry/v1/entities — tenant types, schemas, permissions, plugins", data: entities },
  ];
  const visibleCards = cards.filter((c) => filters.sections[c.key]);

  // Permission catalog: every `gts.cf.toolkit.authz.permission.v1~…`
  // instance registered in the types-registry. Extracted by id pattern so
  // the card survives shape changes in the entities payload.
  const permissions = Array.from(
    new Set(
      (JSON.stringify(entities ?? "").match(
        /gts\.cf\.toolkit\.authz\.permission\.v1~[a-zA-Z0-9_.]+\.v\d+/g,
      ) ?? []),
    ),
  ).sort();

  return (
    <>
      <h1>System</h1>
      <p className="subtitle">Live observability over the platform gears of this assembly.</p>

      <div className="card">
        <h2>Privileges ({permissions.length} permissions registered)</h2>
        <p className="error" style={{ marginBottom: 10 }}>
          Enforcement: static allow-all — the PDP is not wired yet (ADR-0004 P3). Access is
          governed by tenant scope + self-managed barriers only; the permissions below are the
          registered vocabulary the future PDP and Role Grants will enforce.
        </p>
        {permissions.length === 0 ? (
          <p className="empty">No permission instances found in the types-registry.</p>
        ) : (
          <ul className="perm-list">
            {permissions.map((p) => (
              <li key={p}>
                <code>{p.replace("gts.cf.toolkit.authz.permission.v1~", "")}</code>
              </li>
            ))}
          </ul>
        )}
      </div>

      {visibleCards.length === 0 && (
        <p className="empty">All sections are hidden — enable them in the filter panel.</p>
      )}
      {visibleCards.map((c) => (
        <div className="card" key={c.title}>
          <h2>{c.title}</h2>
          <p className="hint">{c.sub}</p>
          <pre style={{ overflow: "auto", fontSize: 12, maxHeight: 260 }}>
            {JSON.stringify(c.data, null, 2)}
          </pre>
        </div>
      ))}
    </>
  );
}

/* ── Projects (workspace-scoped card; RG-backed, ADR-0002) ──
   In the domain model a Project is a managed object of type Project — a
   graph object inside a workspace's context, not a control-plane citizen.
   Hence no top-level Projects view: they live on the Workspace Dashboard. */

/* ── Organizations ── */

/* ── Home hub ── */

function HomeView({
  token,
  home,
  orgs,
  workspaces,
  spaces,
  onOpenSpace,
  onOpenStudio,
  onOpenDashboard,
  onNavigate,
}: {
  token: string;
  home: Tenant | null;
  orgs: Tenant[];
  workspaces: Workspace[];
  spaces: { wsId: string; wsName: string }[];
  onOpenSpace: (wsId: string) => void;
  onOpenStudio: (target: StudioTarget) => void;
  onOpenDashboard: (ws: Workspace) => void;
  onNavigate: (v: View) => void;
}) {
  const [live, setLive] = useState<import("./api").StudioSession[]>([]);
  const [gearCount, setGearCount] = useState<string>("…");

  useEffect(() => {
    void api.studioSessions(token).then(
      (p) => setLive(p.items.filter((s) => s.state !== "stopped")),
      () => setLive([]),
    );
    void api.gears(token).then(
      (g: unknown) => {
        const items =
          Array.isArray(g) ? g
          : g && typeof g === "object" && "items" in g && Array.isArray((g as { items: unknown[] }).items)
            ? (g as { items: unknown[] }).items
            : null;
        setGearCount(items ? String(items.length) : "—");
      },
      () => setGearCount("—"),
    );
  }, [token]);

  const hidden = orgs.filter((o) => o.self_managed).length;
  const continueItems = workspaces
    .map((ws) => ({
      ws,
      space: spaces.find((s) => s.wsId === ws.id),
      session: live.find((s) => s.workspace_id === ws.id),
    }))
    .filter((x) => x.space || x.session);

  return (
    <>
      <div className="home-hero">
        <div>
          <h1>
            <span className="hero-gradient">Constructor Studio</span>
          </h1>
          <p className="subtitle">
            Projects that build with AI over real repositories — the control plane of the Studio
            domain model.
          </p>
        </div>
        <div className="hero-links">
          {/* Discord invite comes from env (runtime env.js in clusters,
              VITE_ var in dev) so each deployment points at its own server;
              without it the link hides itself. */}
          {runtimeEnv.discordUrl && (
            <a href={runtimeEnv.discordUrl} target="_blank" rel="noopener noreferrer">
              🎮 Discord
            </a>
          )}
          <a href="https://github.com/constructorfabric/studio-web" target="_blank" rel="noopener noreferrer">
            🐙 GitHub
          </a>
          <a href="/cf/docs" target="_blank" rel="noopener noreferrer">
            ⧉ Docs &amp; API
          </a>
        </div>
      </div>

      <div className="home-grid">
        <div className="card span-all">
          <h2>Continue</h2>
          {continueItems.length === 0 ? (
            <p className="empty">No live sessions. Open a project to start one.</p>
          ) : (
            <ul className="rows">
              {continueItems.map(({ ws, space, session }) => (
                <li key={ws.id}>
                  <div className="grow">
                    <div className="name">⚙ {ws.name}</div>
                    <div className="sub">project{session ? ` · session ${session.state}` : ""}</div>
                  </div>
                  {space ? (
                    <button className="primary" onClick={() => onOpenSpace(ws.id)}>
                      Switch to space
                    </button>
                  ) : (
                    <button className="primary" onClick={() => onOpenStudio(ws)}>
                      Reopen
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2>Build</h2>
          <ul className="home-links">
            <li>
              <button className="linklike" onClick={() => onNavigate("projects")}>
                Projects — open one, or start the Studio IDE →
              </button>
            </li>
            {workspaces[0] && (
              <li>
                <button className="linklike" onClick={() => onOpenDashboard(workspaces[0])}>
                  Project overview (sources, automation, nested projects) →
                </button>
              </li>
            )}
            <li>
              <button className="linklike" onClick={() => onNavigate("people")}>
                Invite someone into a project →
              </button>
            </li>
            <li>
              <button className="linklike" onClick={() => onNavigate("connectors")}>
                Connect a repository →
              </button>
            </li>
            <li>
              <button className="linklike" onClick={() => onNavigate("chats")}>
                Ask AI →
              </button>
            </li>
          </ul>
        </div>

        <div className="card">
          <h2>Platform</h2>
          <ul className="rows">
            <li>
              <div className="grow"><div className="sub">Scope</div>
                <div className="name">
                  {home?.tenant_type === TENANT_TYPES.organization
                    ? `${home.name} subtree`
                    : `entire platform${hidden ? ` · ${hidden} self-managed hidden` : ""}`}
                </div>
              </div>
            </li>
            <li>
              <div className="grow">
                <div className="sub">Projects</div>
                <div className="name">
                  {workspaces.length}
                  {/* The organization count stays visible as a platform fact,
                      not as a place to go — concept v2 hides the level, it does
                      not pretend the tenants vanished. */}
                  <span className="sub" style={{ fontWeight: 400 }}>
                    {orgs.length > 0 ? ` · in ${orgs.length} organization${orgs.length === 1 ? "" : "s"} (hidden)` : ""}
                  </span>
                </div>
              </div>
            </li>
            <li>
              <div className="grow"><div className="sub">Gears running</div>
                <div className="name">{gearCount}</div>
              </div>
              <button className="ghost" onClick={() => onNavigate("system")}>System →</button>
            </li>
          </ul>
        </div>

        <div className="card">
          <h2>Documentation</h2>
          <ul className="home-links">
            <li><a href="https://github.com/constructorfabric/studio-web#readme" target="_blank" rel="noopener noreferrer">README — running the stack →</a></li>
            <li><a href="https://github.com/constructorfabric/studio-web/tree/main/docs/adr" target="_blank" rel="noopener noreferrer">Architecture decisions (ADR) →</a></li>
            <li><a href="https://github.com/constructorfabric/studio-web/blob/main/docs/domain-alignment.md" target="_blank" rel="noopener noreferrer">Domain model alignment →</a></li>
          </ul>
        </div>
      </div>
    </>
  );
}

/* ── Secrets (credstore surface) ──
   credstore has NO list endpoint (gears feedback #5), so the view builds
   from refs the workspace settings know about, probes each with GET, and
   heals broken ones with the unconditional-PUT rotate. */

interface SecretRow {
  ref: string;
  usedBy: string[];
}

function useKnownSecretRefs(token: string, workspaces: Workspace[]): SecretRow[] | null {
  const [rows, setRows] = useState<SecretRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const map = new Map<string, Set<string>>();
      await Promise.all(
        workspaces.map(async (ws) => {
          const s = await api.workspaceSettings(token, ws.id).catch(() => null);
          if (!s) return;
          const add = (ref?: string | null, what = "") => {
            const r = ref?.trim();
            if (!r) return;
            if (!map.has(r)) map.set(r, new Set());
            map.get(r)?.add(`${ws.name}${what}`);
          };
          add(s.root_token_ref, " (project root)");
          for (const repo of s.repos ?? []) add(repo.token_ref, ` / ${repo.name}`);
        }),
      );
      if (!cancelled) {
        setRows(
          [...map.entries()]
            .map(([ref, used]) => ({ ref, usedBy: [...used].sort() }))
            .sort((a, b) => a.ref.localeCompare(b.ref)),
        );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, workspaces]);
  return rows;
}

function SecretsView({
  token,
  workspaces,
  filters,
}: {
  token: string;
  workspaces: Workspace[];
  filters: Filters;
}) {
  const rows = useKnownSecretRefs(token, workspaces);
  const [status, setStatus] = useState<Record<string, "ok" | "broken" | "checking">>({});
  const [error, setError] = useState<string | null>(null);

  async function check(ref: string) {
    setStatus((s) => ({ ...s, [ref]: "checking" }));
    const r = await api.checkSecret(token, ref);
    setStatus((s) => ({ ...s, [ref]: r }));
  }

  async function rotate(ref: string) {
    const value = window.prompt(`New value for “${ref}” (e.g. a fresh PAT):`);
    if (!value?.trim()) return;
    setError(null);
    try {
      await api.putSecret(token, ref, value.trim(), PAT_SECRET_TYPE);
      await check(ref);
    } catch (e) {
      setError(errText(e));
    }
  }

  async function remove(ref: string) {
    if (!window.confirm(`Delete secret “${ref}”? Project settings keep the reference — launches will clone without credentials until a new value is saved.`)) return;
    setError(null);
    try {
      await api.deleteSecret(token, ref);
      setStatus((s) => ({ ...s, [ref]: "broken" }));
    } catch (e) {
      setError(errText(e));
    }
  }

  const visible = (rows ?? []).filter((r) => matches(filters.query, r.ref, r.usedBy.join(" ")));

  return (
    <>
      <h1>Secrets</h1>
      <p className="subtitle">
        Repository credentials in the credstore gear. Values are write-only; this view lists the
        references known to project settings, probes their health, and rotates broken ones
        (the store has no list API — anything saved outside the portal won't appear here).
      </p>
      <div className="card">
        {rows === null ? (
          <p className="empty">Loading references from project settings…</p>
        ) : visible.length === 0 ? (
          <p className="empty">No secret references found in any project settings.</p>
        ) : (
          <ul className="rows">
            {visible.map((r) => (
              <li key={r.ref}>
                <div className="grow">
                  <div className="name"><code>{r.ref}</code></div>
                  <div className="sub">used by: {r.usedBy.join(", ")}</div>
                </div>
                {status[r.ref] === "ok" && <span className="badge workspace">readable ✓</span>}
                {status[r.ref] === "broken" && (
                  <span className="badge selfmanaged" title="Exists but unreadable (or missing) — rotate to heal">
                    broken ✗
                  </span>
                )}
                <button className="ghost" disabled={status[r.ref] === "checking"} onClick={() => void check(r.ref)}>
                  {status[r.ref] === "checking" ? "…" : "Check"}
                </button>
                <button className="ghost" onClick={() => void rotate(r.ref)}>Rotate</button>
                <button className="ghost" title="Delete the stored value" onClick={() => void remove(r.ref)}>✕</button>
              </li>
            ))}
          </ul>
        )}
        {error && <div className="error">{error}</div>}
      </div>
    </>
  );
}

/* ── Connectors (aggregate of workspace sources) ── */

/** Provider groups in the picker. Keys match ConnectorDriver::category(). */
const CATEGORIES: { key: string; title: string; blurb: string }[] = [
  {
    key: "source_code",
    title: "Source code",
    blurb: "Browse repositories and attach them to this project.",
  },
  {
    key: "ai",
    title: "AI providers",
    blurb:
      "Credentials the IDE agents authenticate with — Anthropic for Claude Code, OpenAI for Codex.",
  },
];

/** Where a connection is attached, and how widely its token is readable.
 *  One choice sets both: the tenant holding the catalogue row (its reach) and
 *  the credstore sharing mode of the token (who may read it). */
type Reach = "organization" | "workspace" | "personal";

/** The project's current sources (workspace repos) with detach + Open in IDE, so
 *  the Sources tab shows the RESULT of attaching, not only the connectors. */
/** Attach chosen remote repositories to a workspace as sources (the repos a
 *  session clones on launch). Shared by the Sources-tab repository browser and
 *  the Nested-projects "Pick from a connector…" picker so both build identical
 *  RepoEntry rows — same name sanitisation, same provider→source mapping, same
 *  server-side token reference. Returns how many were added. */
async function attachReposToWorkspace(
  token: string,
  ws: Workspace,
  connection: Connection,
  picks: RemoteRepo[],
): Promise<number> {
  const current = (await api.workspaceSettings(token, ws.id)) ?? {};
  const existing = current.repos ?? [];
  const taken = new Set(existing.map((r) => r.name));
  const added: RepoEntry[] = [];
  for (const r of picks) {
    // Directory name must be [a-z0-9_-]+. De-duplicate against what the
    // workspace already has rather than shadowing an existing source.
    const base =
      r.name
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || `repo-${r.id}`;
    let candidate = base;
    let n = 2;
    while (taken.has(candidate)) candidate = `${base}-${n++}`;
    taken.add(candidate);
    added.push({
      name: candidate,
      // github/gitlab compose a provider URL; anything else (bitbucket,
      // self-hosted) is a plain git clone URL — don't mislabel it gitlab.
      source:
        connection.provider === "github"
          ? "github"
          : connection.provider === "gitlab"
            ? "gitlab"
            : "git",
      url: r.clone_url,
      branch: r.default_branch,
      // studio-session resolves this from credstore itself, so the token
      // stays server-side end to end.
      token_ref: connection.secret_ref,
    });
  }
  await api.putWorkspaceSettings(token, ws.id, {
    ...current,
    repos: [...existing, ...added],
  });
  return added.length;
}

/** The repositories attached to a project — the sources a session clones on
 *  launch. Lives on the Nested projects tab (next to the projects they feed):
 *  it lists what is attached, lets you detach, and adds new sources by picking
 *  them straight from one of the project's connectors. */
/** Artifacts — repository sources stay in Git/Graph Storage, while user-added
 *  and Studio-generated file bytes use file-storage/S3. */
function ArtifactsView({
  token,
  workspace,
  parentWorkspaceId,
  onOpenStudio,
}: {
  token: string;
  workspace: Workspace;
  /** The parent workspace tenant id. `workspace` here is the project tenant;
   *  both are tagged onto synced nodes so the graph can scope to either. */
  parentWorkspaceId?: string;
  onOpenStudio?: (ws: Workspace) => void;
}) {
  // Bumped after every successful sync so the ingested-artifacts viewer reloads.
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <>
      <h1>Artifacts</h1>
      <p className="subtitle">
        What this project works on — repositories attached as sources, plus files added by hand. A
        session clones these into the IDE when you open it.
      </p>
      <ProjectSources
        token={token}
        workspace={workspace}
        parentWorkspaceId={parentWorkspaceId}
        onOpenStudio={onOpenStudio}
        onSynced={() => setRefreshKey((k) => k + 1)}
      />
      <IngestedArtifacts token={token} scope={workspace.id} refreshKey={refreshKey} />
      <ProjectFiles token={token} workspace={workspace} parentWorkspaceId={parentWorkspaceId} />
    </>
  );
}

/** Ask every embedded Studio (Theia) iframe to open a file in its editor. The
 *  IDE's portal-bridge maps `studio.openInEditor` onto the editor open against
 *  the workspace roots (ADR-0010). `path` is checkout-relative — a repo file's
 *  path. No-op when no session is open. */
function openInStudioEditor(path?: string): void {
  if (!path) return;
  document.querySelectorAll<HTMLIFrameElement>("iframe.space-frame").forEach((f) => {
    const origin = f.dataset.origin;
    if (origin) f.contentWindow?.postMessage({ type: "studio.openInEditor", path }, origin);
  });
}

/** The ingested-artifacts viewer: issues and pull requests pulled from the
 *  attached sources by the artifact-ingest gear and read back from the graph
 *  store. Reloads whenever `refreshKey` changes (i.e. after a Sync). */
function IngestedArtifacts({
  token,
  scope,
  refreshKey,
}: {
  token: string;
  /** Project tenant id — reads are scoped to it so the list shows only this
   *  project's ingested artifacts, not every repo across the org. */
  scope?: string;
  refreshKey: number;
}) {
  const PAGE = 50;
  const [nodes, setNodes] = useState<import("./api").ArtifactNode[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [repoFilter, setRepoFilter] = useState("");
  const [sort, setSort] = useState<"updated" | "">("updated");
  const [qInput, setQInput] = useState("");
  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState<import("./api").ArtifactNode[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"issue" | "pull_request" | "file">("issue");

  const load = useCallback(
    (nextOffset: number) => {
      setErr(null);
      setBusy(true);
      api
        .listArtifactNodes(token, tab, scope, undefined, PAGE, {
          repo: repoFilter || undefined,
          sort: sort || undefined,
          q: query || undefined,
          offset: nextOffset,
        })
        .then((r) => {
          setNodes(r.nodes ?? []);
          setTotal(r.total ?? (r.nodes?.length ?? 0));
          setOffset(nextOffset);
        })
        .catch((e) => setErr(errText(e)))
        .finally(() => setBusy(false));
    },
    [token, scope, tab, repoFilter, sort, query],
  );

  // First page whenever the tab, scope, repo filter or sort changes.
  useEffect(() => {
    setNodes(null);
    load(0);
  }, [load, refreshKey]);

  // The repositories in scope, for the repo-filter dropdown.
  useEffect(() => {
    let alive = true;
    api
      .listArtifactNodes(token, "repo", scope, undefined, 200)
      .then((r) => {
        if (alive) setRepos(r.nodes ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [token, scope]);

  const rows = nodes ?? [];

  const emptyLabel =
    tab === "issue" ? "issues" : tab === "pull_request" ? "pull requests" : "files";

  // Experiment: ask the embedded Studio (Theia) sessions to open their
  // Workspace Graph view. Same postMessage channel as the theme/token bridge;
  // the IDE's portal-bridge maps `studio.openGraph` onto the graph command.
  const openGraphInStudio = () => {
    document
      .querySelectorAll<HTMLIFrameElement>("iframe.space-frame")
      .forEach((f) => {
        const origin = f.dataset.origin;
        if (origin) f.contentWindow?.postMessage({ type: "studio.openGraph" }, origin);
      });
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>Ingested{total != null ? ` · ${total}` : ""}</h2>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="ghost" onClick={openGraphInStudio} title="Open the Workspace Graph in the embedded Studio IDE">
            Open graph in Studio
          </button>
          <button className="ghost" onClick={() => load(offset)} disabled={busy}>
            Refresh
          </button>
        </div>
      </div>
      <p className="hint">
        Issues, pull requests and repository files pulled from the attached sources by Sync. Stored
        in the graph as typed GTS nodes — this reads them back.
      </p>
      <div className="row" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button className={tab === "issue" ? "primary" : "ghost"} onClick={() => setTab("issue")}>
          Issues
        </button>
        <button
          className={tab === "pull_request" ? "primary" : "ghost"}
          onClick={() => setTab("pull_request")}
        >
          Pull requests
        </button>
        <button className={tab === "file" ? "primary" : "ghost"} onClick={() => setTab("file")}>
          Files
        </button>
      </div>
      <div className="row" style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, opacity: 0.7 }}>Repo</label>
        <select value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} disabled={busy}>
          <option value="">All repositories</option>
          {repos.map((r) => (
            <option key={r.instance_id} value={r.instance_id}>
              {String(r.value.full_path ?? r.value.name ?? r.instance_id)}
            </option>
          ))}
        </select>
        <label style={{ fontSize: 12, opacity: 0.7, marginLeft: 8 }}>Sort</label>
        <select value={sort} onChange={(e) => setSort(e.target.value as "updated" | "")} disabled={busy}>
          <option value="updated">Updated (newest)</option>
          <option value="">Default</option>
        </select>
        <form
          style={{ display: "flex", gap: 6, marginLeft: "auto" }}
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(qInput.trim());
          }}
        >
          <input
            placeholder="Search title / author…"
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            style={{ minWidth: 180 }}
          />
          <button className="ghost" type="submit" disabled={busy}>
            Search
          </button>
          {query && (
            <button
              className="ghost"
              type="button"
              disabled={busy}
              onClick={() => {
                setQInput("");
                setQuery("");
              }}
            >
              Clear
            </button>
          )}
        </form>
      </div>
      {err && <p className="error">{err}</p>}
      {nodes === null ? (
        <p className="empty">Loading artifacts…</p>
      ) : rows.length === 0 ? (
        <p className="empty">
          Nothing ingested yet — hit Sync on a repository above to pull its {emptyLabel}.
        </p>
      ) : tab === "file" ? (
        <ul className="rows">
          {rows.map((n) => {
              const v = n.value;
              const kb = typeof v.size === "number" ? `${(v.size / 1024).toFixed(1)} KB` : "";
              return (
                <li key={n.instance_id}>
                  <div className="grow">
                    <div className="name" style={{ fontFamily: "var(--mono, monospace)" }}>
                      {v.path ?? "(no path)"}
                    </div>
                    <div className="sub">
                      {kb}
                      {v.sha ? `${kb ? " · " : ""}${String(v.sha).slice(0, 7)}` : ""}
                    </div>
                  </div>
                  {typeof v.path === "string" && v.path && (
                    <button
                      className="ghost"
                      onClick={() => openInStudioEditor(v.path)}
                      title="Open this file in the embedded Studio editor"
                    >
                      Open in editor
                    </button>
                  )}
                </li>
              );
            })}
        </ul>
      ) : (
        <ul className="rows">
          {rows.map((n) => {
              const v = n.value;
              const url = typeof v.url === "string" ? v.url : undefined;
              return (
                <li key={n.instance_id}>
                  <div className="grow">
                    <div className="name">
                      {v.number != null ? `#${v.number} ` : ""}
                      {v.title ?? "(untitled)"}
                    </div>
                    <div className="sub">
                      {v.state ?? "?"}
                      {v.author ? ` · ${v.author}` : ""}
                      {tab === "pull_request" && v.source_branch
                        ? ` · ${v.source_branch} → ${v.target_branch ?? "?"}`
                        : ""}
                      {tab === "pull_request" && v.merged ? " · merged" : ""}
                      {Array.isArray(v.labels) && v.labels.length > 0
                        ? ` · ${v.labels.join(", ")}`
                        : ""}
                    </div>
                  </div>
                  {url && (
                    <a className="ghost" href={url} target="_blank" rel="noreferrer">
                      Open
                    </a>
                  )}
                </li>
              );
            })}
        </ul>
      )}
      {total != null && total > PAGE && (
        <div style={{ marginTop: 12, display: "flex", alignItems: "center", gap: 10 }}>
          <button className="ghost" disabled={busy || offset === 0} onClick={() => load(Math.max(0, offset - PAGE))}>
            ← Prev
          </button>
          <span style={{ fontSize: 12, opacity: 0.7 }}>
            {rows.length > 0 ? `${offset + 1}–${offset + rows.length}` : "0"} of {total} ·
            {" "}page {Math.floor(offset / PAGE) + 1} of {Math.max(1, Math.ceil(total / PAGE))}
          </span>
          <button
            className="ghost"
            disabled={busy || offset + PAGE >= total}
            onClick={() => load(offset + PAGE)}
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}

/** The artifact relationship map for the Overview: reads the ingested nodes
 *  back from the graph and draws each repository with its issues, pull requests
 *  and files as a radial hub-and-spoke. Edges are derived from each node's
 *  `repo` reference — no extra endpoint needed. */
/** Manual project artifacts. Bytes live in file-storage/S3; Graph Storage keeps
 *  only searchable metadata and the durable file/version reference. Generated
 *  artifacts use the same upload helper with `origin=generated`. */
function ProjectFiles({
  token,
  workspace,
  parentWorkspaceId,
}: {
  token: string;
  workspace: Workspace;
  /** Parent workspace tenant. `workspace` is the project tenant; files are
   *  tagged with both so the graph can scope to either. */
  parentWorkspaceId?: string;
}) {
  const [files, setFiles] = useState<
    {
      id: string;
      path: string;
      size?: number;
      file_id?: string;
      version_id?: string;
    }[] | null
  >(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const reload = useCallback(async () => {
    setErr(null);
    try {
      // Scope to this project tenant (matches the file's project_id), then keep
      // only hand-added files.
      const { nodes } = await api.listArtifactNodes(token, "file", workspace.id);
      const mine = (nodes ?? [])
        .filter((n) => {
          const v = (n.value ?? {}) as Record<string, unknown>;
          return v.origin === "manual";
        })
        .map((n) => {
          const v = (n.value ?? {}) as Record<string, unknown>;
          const objectRef =
            v.object_ref && typeof v.object_ref === "object"
              ? (v.object_ref as Record<string, unknown>)
              : undefined;
          return {
            id: n.instance_id,
            path: typeof v.path === "string" ? v.path : n.instance_id,
            size: typeof v.size === "number" ? v.size : undefined,
            file_id: typeof objectRef?.file_id === "string" ? objectRef.file_id : undefined,
            version_id: typeof objectRef?.version_id === "string" ? objectRef.version_id : undefined,
          };
        });
      setFiles(mine);
    } catch (e) {
      setErr(errText(e));
    }
  }, [token, workspace.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const onPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-picking the same file
    if (!file) return;
    setBusy(true);
    setErr(null);
    try {
      const workspaceId = parentWorkspaceId ?? workspace.id;
      const existingFileId = files?.find((stored) => stored.path === file.name)?.file_id;
      const objectRef = await uploadProjectArtifact(
        token,
        file,
        {
          organization_id: workspace.orgId,
          workspace_id: workspaceId,
          project_id: workspace.id,
        },
        "manual",
        existingFileId,
      );
      await api.addProjectArtifact(token, {
        organization_id: workspace.orgId,
        workspace_id: workspaceId,
        project_id: workspace.id,
        origin: "manual",
        path: file.name,
        size: file.size,
        object_ref: objectRef,
      });
      await reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const count = files?.length ?? 0;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Added by hand{count > 0 ? ` · ${count}` : ""}</h2>
        <button className="primary" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? "Uploading…" : "Add file…"}
        </button>
      </div>
      <input ref={inputRef} type="file" style={{ display: "none" }} onChange={onPick} />
      <p className="hint">
        Manually added file bytes are stored in S3 through file-storage. The artifact graph keeps
        their organization/workspace/project scope and a durable file-version reference. Uploading
        the same name creates a new immutable version.
      </p>
      {err && <p className="error">{err}</p>}
      {files === null ? (
        <p className="empty">Loading files…</p>
      ) : files.length === 0 ? (
        <p className="empty">No files yet — use “Add file…” to attach one.</p>
      ) : (
        <ul className="rows">
          {files.map((f) => (
            <li key={f.id}>
              <div className="grow">
                <div className="name">{f.path}</div>
                <div className="sub">
                  {typeof f.size === "number" ? `${(f.size / 1024).toFixed(1)} KB` : ""}
                  {f.version_id ? ` · version ${f.version_id.slice(0, 8)}…` : ""}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Derive the artifact-ingest parameters (provider + owner/repo + API base)
 *  from a git clone URL. Returns null for hosts we have no driver for. */
function parseRepoSource(
  url?: string,
): { provider: string; full_path: string; base_url?: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const provider = host.includes("github")
      ? "github"
      : host.includes("gitlab")
        ? "gitlab"
        : host.includes("bitbucket")
          ? "bitbucket"
          : "";
    if (!provider) return null;
    const full_path = u.pathname.replace(/^\/+/, "").replace(/\.git$/, "");
    // github.com uses api.github.com (the driver default); GHE and self-hosted
    // GitLab need their own API root.
    const base_url =
      host === "github.com"
        ? undefined
        : provider === "github"
          ? `${u.protocol}//${host}/api/v3`
          : `${u.protocol}//${host}`;
    return { provider, full_path, base_url };
  } catch {
    return null;
  }
}

function ProjectSources({
  token,
  workspace: ws,
  parentWorkspaceId,
  onOpenStudio,
  onSynced,
}: {
  token: string;
  workspace: Workspace;
  /** Parent workspace tenant. `ws` is the project tenant; sync tags both onto
   *  every node so the graph can scope to either level. */
  parentWorkspaceId?: string;
  onOpenStudio?: (ws: Workspace) => void;
  onSynced?: () => void;
}) {
  const [repos, setRepos] = useState<RepoEntry[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  // Per-repo artifact-sync status text, keyed by repo name.
  const [sync, setSync] = useState<Record<string, string>>({});

  const syncRepo = async (r: RepoEntry) => {
    const parsed = parseRepoSource(r.url ?? undefined);
    if (!parsed) {
      setSync((s) => ({ ...s, [r.name]: "unsupported source URL" }));
      return;
    }
    if (!r.token_ref) {
      setSync((s) => ({ ...s, [r.name]: "no token — attach it from a connector" }));
      return;
    }
    setSync((s) => ({ ...s, [r.name]: "queued…" }));
    try {
      // Sync runs in the background (cloning can take a while); enqueue, then
      // poll the task to completion. A trailing "…" marks a running state and
      // keeps the button disabled.
      const { task_id } = await api.syncArtifacts(token, {
        provider: parsed.provider,
        secret_ref: r.token_ref,
        repo_full_path: parsed.full_path,
        base_url: parsed.base_url,
        // Tag every node with both tenants: the parent workspace (so a
        // workspace-level graph shows every project) and this project (so a
        // project-level graph shows only its own). `project_id` also locates
        // the IDE's shared checkout to read instead of cloning.
        workspace_id: parentWorkspaceId ?? ws.id,
        project_id: ws.id,
        repo_dir: r.target || r.name,
      });
      const deadline = Date.now() + 5 * 60 * 1000;
      // Running total of nodes the backend reports as already stored in the
      // graph. When it climbs, refresh the ingested-artifacts viewer so the
      // objects appear as they land, not only when the whole sync finishes.
      let lastStored = -1;
      // Compact "what's been pulled so far" line, hiding zero counts.
      const counts = (t: {
        issues: number;
        pull_requests: number;
        files: number;
        comments: number;
        commits: number;
      }) =>
        [
          t.issues ? `${t.issues} issues` : "",
          t.pull_requests ? `${t.pull_requests} PRs` : "",
          t.files ? `${t.files} files` : "",
          t.comments ? `${t.comments} comments` : "",
          t.commits ? `${t.commits} commits` : "",
        ]
          .filter(Boolean)
          .join(" · ");
      for (;;) {
        await new Promise((res) => setTimeout(res, 1200));
        const t = await api.artifactSyncTask(token, task_id);
        if (t.status === "succeeded") {
          setSync((s) => ({ ...s, [r.name]: counts(t) || "done" }));
          onSynced?.();
          break;
        }
        if (t.status === "failed") {
          setSync((s) => ({ ...s, [r.name]: t.message || "sync failed" }));
          break;
        }
        // Live line: the current phase, plus counts and how many objects are
        // already in the graph.
        const phase = (t.message || t.status).replace(/…$/, "");
        const c = counts(t);
        const line = `${phase}${c ? ` — ${c}` : ""}${t.stored ? ` · ${t.stored} in graph` : ""}…`;
        setSync((s) => ({ ...s, [r.name]: line }));
        // Objects landed since last tick → reload the ingested list.
        if (t.stored > lastStored) {
          lastStored = t.stored;
          onSynced?.();
        }
        if (Date.now() > deadline) {
          setSync((s) => ({ ...s, [r.name]: "timed out — still running server-side" }));
          break;
        }
      }
    } catch (e) {
      setSync((s) => ({ ...s, [r.name]: errText(e) }));
    }
  };

  const reload = useCallback(async () => {
    const s = await api.workspaceSettings(token, ws.id).catch(() => null);
    setRepos(s?.repos ?? []);
  }, [token, ws.id]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const detach = async (name: string) => {
    setBusy(name);
    setErr(null);
    try {
      const s = (await api.workspaceSettings(token, ws.id)) ?? {};
      await api.putWorkspaceSettings(token, ws.id, {
        ...s,
        repos: (s.repos ?? []).filter((r) => r.name !== name),
      });
      await reload();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const count = repos?.length ?? 0;

  return (
    <div className="card">
      <div className="card-head">
        <h2>From repositories{count > 0 ? ` · ${count}` : ""}</h2>
        {count > 0 && onOpenStudio && (
          <button className="primary" onClick={() => onOpenStudio(ws)}>
            Open in IDE
          </button>
        )}
      </div>
      <p className="hint">
        Repositories cloned into the workspace when a session launches. Add one by picking it from a
        connector — set connectors up on the Connectors tab.
      </p>
      {err && <p className="error">{err}</p>}
      {repos === null ? (
        <p className="empty">Loading sources…</p>
      ) : repos.length === 0 ? (
        <p className="empty">No repositories attached yet — pick one from a connector below.</p>
      ) : (
        <ul className="rows">
          {repos.map((r) => (
            <li key={r.name}>
              <div className="grow">
                <div className="name">{r.name}</div>
                <div className="sub">
                  {r.source}
                  {r.url ? ` · ${r.url}` : ""}
                  {r.branch ? ` · ${r.branch}` : ""}
                  {sync[r.name] ? ` — sync: ${sync[r.name]}` : ""}
                </div>
              </div>
              <button
                className="ghost"
                title="Clone this source and pull its issues, pull requests and files into the graph"
                disabled={!!sync[r.name]?.endsWith("…")}
                onClick={() => void syncRepo(r)}
              >
                {sync[r.name]?.endsWith("…") ? "…" : "Sync"}
              </button>
              <button className="ghost" disabled={busy === r.name} onClick={() => void detach(r.name)}>
                {busy === r.name ? "…" : "Detach"}
              </button>
            </li>
          ))}
        </ul>
      )}

      <SourceAttachPicker token={token} workspace={ws} onAttached={() => void reload()} />
    </div>
  );
}

/** "Pick from a connector…" on the Project sources panel: choose a connection,
 *  search its repositories, tick some, attach them as sources. The same clone
 *  URLs the Sources-tab browser produces — this just puts the affordance next
 *  to the sources list itself. */
function SourceAttachPicker({
  token,
  workspace: ws,
  onAttached,
}: {
  token: string;
  workspace: Workspace;
  onAttached: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [connId, setConnId] = useState("");
  const [search, setSearch] = useState("");
  const [repos, setRepos] = useState<RemoteRepo[] | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [attached, setAttached] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadAttached = useCallback(async () => {
    const s = await api.workspaceSettings(token, ws.id).catch(() => null);
    setAttached(new Set((s?.repos ?? []).map((r) => r.url).filter((u): u is string => Boolean(u))));
  }, [token, ws.id]);

  useEffect(() => {
    if (!open || connections) return;
    void api.connections(token, ws.id).then(
      (c) => {
        setConnections(c.items);
        if (c.items[0]) setConnId(c.items[0].id);
      },
      (e) => setErr(errText(e)),
    );
  }, [open, connections, token, ws.id]);

  const load = useCallback(
    async (q: string) => {
      if (!connId) return;
      setErr(null);
      setRepos(null);
      try {
        const r = await api.connectionRepositories(token, connId, ws.id, q);
        setRepos(r.items);
      } catch (e) {
        setErr(errText(e));
        setRepos([]);
      }
    },
    [token, connId, ws.id],
  );

  useEffect(() => {
    if (open && connId) {
      void load("");
      void loadAttached();
    }
  }, [open, connId, load, loadAttached]);

  const connection = (connections ?? []).find((c) => c.id === connId) ?? null;
  const picks = (repos ?? []).filter((r) => checked[r.id]);

  const attach = async () => {
    if (!connection || picks.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      await attachReposToWorkspace(token, ws, connection, picks);
      setChecked({});
      await loadAttached();
      onAttached();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button type="button" className="ghost" style={{ marginTop: 6 }} onClick={() => setOpen(true)}>
        Pick from a connector…
      </button>
    );
  }

  return (
    <div className="nested" style={{ marginTop: 6 }}>
      {err && <p className="error">{err}</p>}
      {connections && connections.length === 0 ? (
        <p className="empty">
          No connectors on this project yet — add one on the Sources tab, then pick a repository here.
        </p>
      ) : (
        <>
          <div className="row">
            <select value={connId} onChange={(e) => setConnId(e.target.value)}>
              {(connections ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label} ({c.provider})
                </option>
              ))}
            </select>
            <input
              className="grow"
              placeholder="Search repositories…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void load(search);
              }}
            />
            <button type="button" onClick={() => void load(search)}>
              Search
            </button>
            <button type="button" className="ghost" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>
          {repos === null ? (
            <p className="empty">Loading repositories…</p>
          ) : repos.length === 0 ? (
            <p className="empty">Nothing reachable with this connector.</p>
          ) : (
            <ul className="rows">
              {repos.map((r) => {
                const isAttached = attached.has(r.clone_url);
                return (
                  <li key={r.id} className={isAttached ? "attached" : undefined}>
                    <input
                      type="checkbox"
                      disabled={isAttached}
                      checked={isAttached || Boolean(checked[r.id])}
                      onChange={(e) => setChecked((c) => ({ ...c, [r.id]: e.target.checked }))}
                    />
                    <div className="grow">
                      <div className="name">{r.full_path}</div>
                      <div className="sub">{r.default_branch ?? "default branch"}</div>
                    </div>
                    {isAttached && <span className="badge ok">attached</span>}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="row">
            <span className="grow" />
            <button
              type="button"
              className="primary"
              disabled={picks.length === 0 || busy}
              onClick={() => void attach()}
            >
              {busy ? "Attaching…" : `Add ${picks.length || ""} to ${ws.name}`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ConnectorsView({
  token,
  workspace: ws,
  filters,
}: {
  token: string;
  /** From the account switcher — this page no longer asks again. */
  workspace: Workspace;
  filters: Filters;
}) {
  const [providers, setProviders] = useState<ConnectorProvider[] | null>(null);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [disabled, setDisabled] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  // Bumped when a repo is attached/detached anywhere on the tab, so the sources
  // panel and the connector browser's "attached" flags stay in sync.
  const [sourcesTick, setSourcesTick] = useState(0);
  const bumpSources = () => setSourcesTick((t) => t + 1);

  const reload = useCallback(async () => {
    if (!ws) return;
    setErr(null);
    try {
      const [p, c] = await Promise.all([
        api.connectorProviders(token),
        api.connections(token, ws.id),
      ]);
      setProviders(p.items);
      setConnections(c.items);
      setDisabled(null);
    } catch (e) {
      // 503 = no driver plugin registered in this build. Say so plainly instead
      // of showing an empty list that reads as "nothing connected".
      if (e instanceof ApiError && e.status === 503) {
        setDisabled(errText(e));
        setProviders([]);
        setConnections([]);
      } else {
        setErr(errText(e));
      }
    }
  }, [token, ws]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <>
      <h1>Connectors</h1>
      <p className="subtitle">
        How repositories and model credentials enter <b>{ws.name}</b>: its own connections plus
        those shared with every project. Configure one once, then pick
        repositories from a list instead of pasting clone URLs. Tokens go to credstore — after you
        submit one the browser never sees it again.
      </p>

      {err && <p className="error">{err}</p>}
      {note && <p className="hint">{note}</p>}
      {disabled && (
        <div className="card">
          <h2>Connectors unavailable</h2>
          <p className="empty">{disabled}</p>
        </div>
      )}

      {/* Connectors + the repository browser live here (the Sources tab). The
          attached-sources list itself now lives on the Nested projects tab,
          next to the projects those sources feed. */}
      {!disabled && (
        <AddConnector
          token={token}
          workspace={ws}
          providers={providers ?? []}
          onAdded={(t) => {
            setNote(`Connected as ${t.account}${t.display_name ? ` (${t.display_name})` : ""}.`);
            void reload();
          }}
        />
      )}

      {!disabled && (
        <ConnectionList
          token={token}
          workspace={ws}
          providers={providers ?? []}
          connections={(connections ?? []).filter((c) =>
            matches(filters.query, c.label, c.provider, c.base_url),
          )}
          loading={connections === null}
          sourcesTick={sourcesTick}
          onSourcesChanged={bumpSources}
          onChanged={() => void reload()}
          onNote={setNote}
        />
      )}
    </>
  );
}

/** Provider picker, then the credential form. "Test connection" probes without
 *  saving; "Test & save" does both in one server-side step. */
function AddConnector({
  token,
  workspace,
  providers,
  onAdded,
}: {
  token: string;
  workspace: Workspace;
  providers: ConnectorProvider[];
  onAdded: (t: { account: string; display_name?: string }) => void;
}) {
  const [picked, setPicked] = useState<ConnectorProvider | null>(null);
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [pat, setPat] = useState("");
  const [reveal, setReveal] = useState(false);
  // This project by default. A project admin owns their project but not the
  // hidden organization above it, so defaulting to org-scope made the very
  // first "Test & save" fail on a write they aren't allowed — the connector
  // never landed. Org-shared stays one explicit choice away for the case where
  // one PAT really is an organization asset shared across every project.
  const [reach, setReach] = useState<Reach>("workspace");
  const [busy, setBusy] = useState<"probe" | "save" | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setPicked(null);
    setLabel("");
    setBaseUrl("");
    setPat("");
    setReveal(false);
    setReach("workspace");
    setResult(null);
    setError(null);
  };

  if (providers.length === 0) {
    return (
      <div className="card">
        <h2>Add connector</h2>
        <p className="empty">No connector driver plugin is registered in this build.</p>
      </div>
    );
  }

  if (!picked) {
    return (
      <div className="card">
        <h2>Add connector</h2>
        <p className="hint">Connect this project to an external tool or service.</p>
        {CATEGORIES.map(({ key, title, blurb }) => {
          const group = providers.filter((p) => p.category === key);
          if (group.length === 0) return null;
          return (
            <div key={key}>
              <h3 className="group">{title}</h3>
              <p className="hint">{blurb}</p>
              <ul className="rows">
                {group.map((p) => (
                  <li key={p.provider}>
                    <div className="grow">
                      <div className="name">{p.display_name}</div>
                      <div className="sub">
                        {title.toLowerCase()} · {p.default_base_url}
                      </div>
                    </div>
                    {/* Proof this is plugin-backed: the driver's GTS instance id. */}
                    <span className="sub" title={p.instance_id}>
                      {p.instance_id.split("~").filter(Boolean).slice(-1)[0]}
                    </span>
                    <button onClick={() => setPicked(p)}>Connect</button>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    );
  }

  const submit = async (mode: "probe" | "save") => {
    setBusy(mode);
    setError(null);
    setResult(null);
    try {
      const body = {
        provider: picked.provider,
        base_url: baseUrl.trim() || undefined,
        token: pat,
      };
      if (mode === "probe") {
        const id = await api.probeConnection(token, body);
        setResult(`Valid — ${id.account}${id.display_name ? ` (${id.display_name})` : ""}`);
      } else {
        const t = await api.createConnection(token, {
          ...body,
          label,
          scope: reach,
          // Reach and visibility come from one choice: the organization row is
          // inherited by every workspace under it, a workspace row by that one
          // workspace, and "personal" additionally keeps the token to its owner.
          owner_tenant_id: reach === "organization" ? workspace.orgId : workspace.id,
        });
        onAdded(t);
        reset();
      }
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="card">
      <h2>Add connector</h2>
      <ul className="rows">
        <li>
          <div className="grow">
            <div className="name">{picked.display_name}</div>
            <div className="sub">source code</div>
          </div>
        </li>
      </ul>

      <label>Available to</label>
      <select value={reach} onChange={(e) => setReach(e.target.value as Reach)}>
        <option value="workspace">{workspace.name} — this project only</option>
        <option value="organization">Shared — inherited by every project</option>
        <option value="personal">Only me — private to my account</option>
      </select>
      <p className="hint">
        {reach === "organization"
          ? "Stored once and inherited by every project; the token is readable across them."
          : reach === "workspace"
            ? "Stored on this project; everyone in it can use the token."
            : "Stored on this project, but the token stays readable only by you."}
      </p>

      <label>Label</label>
      <input
        placeholder={`e.g. My ${picked.display_name} account`}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
      />

      <label>Instance URL</label>
      <input
        placeholder={
          picked.category === "ai"
            ? `Leave empty for ${picked.default_base_url} — or any compatible endpoint`
            : `Leave empty for ${picked.default_base_url} — or your self-hosted installation`
        }
        value={baseUrl}
        onChange={(e) => setBaseUrl(e.target.value)}
      />

      <label>{picked.credential_label}</label>
      <div className="row">
        <input
          className="grow"
          type={reveal ? "text" : "password"}
          placeholder={picked.credential_hint}
          value={pat}
          onChange={(e) => setPat(e.target.value)}
        />
        <button onClick={() => setReveal((v) => !v)}>{reveal ? "Hide" : "Show"}</button>
      </div>
      <p className="hint">
        Stored in credstore under a per-connection reference. Never logged, never returned by the
        API.
      </p>

      {result && <p className="hint">{result}</p>}
      {error && <p className="error">{error}</p>}

      <div className="row">
        <button onClick={reset}>← Back</button>
        <span className="grow" />
        <button disabled={!pat.trim() || busy !== null} onClick={() => void submit("probe")}>
          {busy === "probe" ? "Testing…" : "Test connection"}
        </button>
        <button
          className="primary"
          disabled={!pat.trim() || !label.trim() || busy !== null}
          onClick={() => void submit("save")}
        >
          {busy === "save" ? "Saving…" : "Test & save"}
        </button>
      </div>
    </div>
  );
}

/** Connections usable by one workspace: type chips, category sections, one card
 *  per connection. Health is checked on demand — the card says "not checked"
 *  until you press Test, rather than showing a green badge we never earned. */
function ConnectionList({
  token,
  workspace,
  providers,
  connections,
  loading,
  sourcesTick,
  onSourcesChanged,
  onChanged,
  onNote,
}: {
  token: string;
  workspace: Workspace;
  providers: ConnectorProvider[];
  connections: Connection[];
  loading: boolean;
  sourcesTick: number;
  onSourcesChanged: () => void;
  onChanged: () => void;
  onNote: (s: string) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, "ok" | "bad" | "testing">>({});

  const counts = connections.reduce<Record<string, number>>((acc, c) => {
    acc[c.provider] = (acc[c.provider] ?? 0) + 1;
    return acc;
  }, {});
  const shown = typeFilter ? connections.filter((c) => c.provider === typeFilter) : connections;
  const nameOf = (p: string) => providers.find((x) => x.provider === p)?.display_name ?? p;
  const categoryOf = (p: string) => providers.find((x) => x.provider === p)?.category;

  const test = (c: Connection) => {
    setHealth((h) => ({ ...h, [c.id]: "testing" }));
    void api
      .testConnection(token, c.id, workspace.id)
      .then((t) => {
        setHealth((h) => ({ ...h, [c.id]: "ok" }));
        onNote(`${c.label}: valid — ${t.account}`);
      })
      .catch((e) => {
        setHealth((h) => ({ ...h, [c.id]: "bad" }));
        onNote(`${c.label}: ${errText(e)}`);
      });
  };

  const remove = (c: Connection, inherited: boolean) => {
    const warn = inherited
      ? `"${c.label}" is shared with your other projects. Remove it for everyone?`
      : `Remove connection "${c.label}" and its token?`;
    if (!window.confirm(warn)) return;
    void api
      .deleteConnection(token, c.id, workspace.id)
      .then(onChanged)
      .catch((e) => onNote(errText(e)));
  };

  if (loading) {
    return (
      <div className="card">
        <h2>Connections</h2>
        <p className="empty">Loading…</p>
      </div>
    );
  }
  if (connections.length === 0) {
    return (
      <div className="card">
        <h2>Connections</h2>
        <p className="empty">Nothing connected for this project yet.</p>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Connections</h2>

      {/* Type chips: several connections of the same provider are normal —
          two GitLab installations, a personal and an organization token. */}
      <div className="chips">
        {Object.entries(counts).map(([p, n]) => (
          <button
            key={p}
            type="button"
            className={`chip${typeFilter === p ? " on" : ""}`}
            onClick={() => setTypeFilter(typeFilter === p ? null : p)}
          >
            {nameOf(p)} <span className="chip-n">{n}</span>
          </button>
        ))}
        {typeFilter && (
          <button type="button" className="chip" onClick={() => setTypeFilter(null)}>
            Clear
          </button>
        )}
      </div>

      {CATEGORIES.map(({ key, title }) => {
        const group = shown.filter((c) => categoryOf(c.provider) === key);
        if (group.length === 0) return null;
        return (
          <div key={key}>
            <h3 className="group">{title}</h3>
            <div className="conn-grid">
              {group.map((c) => {
                const browsable = categoryOf(c.provider) === "source_code";
                // A row stored on an ancestor is shared with sibling workspaces —
                // worth saying, because removing it affects them too.
                const inherited = c.owner_tenant_id !== workspace.id;
                const h = health[c.id];
                return (
                  <div className="conn" key={c.id}>
                    <div className="conn-head">
                      <span className="conn-ico" aria-hidden="true">
                        {nameOf(c.provider).slice(0, 1)}
                      </span>
                      <div className="grow">
                        <div className="name">
                          {nameOf(c.provider)}
                          {c.account ? ` · ${c.account}` : ""}
                        </div>
                        <div className="sub">
                          {c.label} · {c.base_url}
                        </div>
                      </div>
                      <div className="conn-badges">
                        <span
                          className={`badge ${h === "ok" ? "workspace" : ""}`}
                          title={
                            h
                              ? undefined
                              : "Health is not cached — press Test connection to check it now"
                          }
                        >
                          {h === "ok"
                            ? "healthy"
                            : h === "bad"
                              ? "failing"
                              : h === "testing"
                                ? "testing…"
                                : "not checked"}
                        </span>
                        <span className={`badge ${c.scope === "personal" ? "" : "workspace"}`}>
                          {inherited ? `${c.scope} · shared` : c.scope}
                        </span>
                      </div>
                    </div>
                    <div className="row">
                      <button type="button" onClick={() => test(c)}>
                        Test connection
                      </button>
                      <button
                        type="button"
                        disabled={inherited}
                        title={
                          inherited
                            ? "Inherited connections are edited where they are defined \u2014 in the organization"
                            : "Change the label or URL, or rotate the token"
                        }
                        onClick={() => setEditing(editing === c.id ? null : c.id)}
                      >
                        {editing === c.id ? "Cancel" : "Edit"}
                      </button>
                      {browsable && (
                        <button type="button" onClick={() => setOpen(open === c.id ? null : c.id)}>
                          {open === c.id ? "Hide repositories" : "Repositories"}
                        </button>
                      )}
                      <span className="grow" />
                      <button type="button" onClick={() => remove(c, inherited)}>
                        Remove
                      </button>
                    </div>
                    {editing === c.id && (
                      <EditConnection
                        token={token}
                        connection={c}
                        workspaceId={workspace.id}
                        onNote={onNote}
                        onDone={(changed) => {
                          setEditing(null);
                          if (changed) {
                            // A rotated credential invalidates the cached
                            // health badge: it was computed for the old token.
                            setHealth((h) => {
                              const next = { ...h };
                              delete next[c.id];
                              return next;
                            });
                            onChanged();
                          }
                        }}
                      />
                    )}
                    {open === c.id && browsable && (
                      <RepoBrowser
                        token={token}
                        connection={c}
                        workspace={workspace}
                        sourcesTick={sourcesTick}
                        onSourcesChanged={onSourcesChanged}
                        onNote={onNote}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Inline editor for a stored connection.
 *
 *  Exists because the alternative was Remove-and-add, which mints a NEW
 *  connection id — and every workspace source references a connection by id, so
 *  rotating an expired token that way silently orphans them. The backend keeps
 *  the id and the credstore reference across a PATCH.
 *
 *  Leaving the token box empty means "keep the stored credential"; the backend
 *  still verifies the rest of the change against it, so a URL typo cannot leave
 *  a connection that has never been proven to work. Scope is absent on purpose:
 *  it maps onto the secret's credstore sharing mode, and changing it is a
 *  delete-and-recreate. */
function EditConnection({
  token,
  connection,
  workspaceId,
  onNote,
  onDone,
}: {
  token: string;
  connection: Connection;
  workspaceId: string;
  onNote: (s: string) => void;
  onDone: (changed: boolean) => void;
}) {
  const [label, setLabel] = useState(connection.label);
  const [baseUrl, setBaseUrl] = useState(connection.base_url);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty =
    label.trim() !== connection.label ||
    baseUrl.trim() !== connection.base_url ||
    secret.trim().length > 0;

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const t = await api.patchConnection(
        token,
        connection.id,
        {
          // Only send what actually changed: an unchanged field left out means
          // the backend does not have to reason about "same value" writes.
          ...(label.trim() !== connection.label ? { label: label.trim() } : {}),
          ...(baseUrl.trim() !== connection.base_url ? { base_url: baseUrl.trim() } : {}),
          ...(secret.trim() ? { token: secret.trim() } : {}),
        },
        workspaceId,
      );
      onNote(
        `Connection updated \u2014 the credential belongs to ${t.account || "an unnamed account"}`,
      );
      onDone(true);
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" style={{ marginTop: 8 }} onSubmit={save}>
      <div className="inline">
        <input
          style={{ flex: 1 }}
          placeholder="Label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      <div className="inline" style={{ marginTop: 6 }}>
        <input
          style={{ flex: 1 }}
          placeholder="Installation URL (empty = the provider default)"
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
        />
      </div>
      <div className="inline" style={{ marginTop: 6 }}>
        <input
          style={{ flex: 1 }}
          type="password"
          autoComplete="new-password"
          placeholder="New token (leave empty to keep the current one)"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
        />
      </div>
      <p className="hint" style={{ marginTop: 6 }}>
        The change is verified against the provider before anything is stored, with or without a
        new token. The connection id is preserved, so project sources keep working.
      </p>
      <div className="inline" style={{ marginTop: 6 }}>
        <button className="primary" disabled={!dirty || busy}>
          {busy ? "Verifying and saving..." : "Save"}
        </button>
        <button type="button" onClick={() => onDone(false)} disabled={busy}>
          Cancel
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </form>
  );
}

function RepoBrowser({
  token,
  connection,
  workspace,
  sourcesTick,
  onSourcesChanged,
  onNote,
}: {
  token: string;
  connection: Connection;
  workspace: Workspace;
  /** Reload the attached set when sources change elsewhere on the tab. */
  sourcesTick: number;
  onSourcesChanged: () => void;
  onNote: (s: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [repos, setRepos] = useState<RemoteRepo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  // Clone URLs already attached to this project — so a repo can't be added twice.
  const [attached, setAttached] = useState<Set<string>>(new Set());

  const loadAttached = useCallback(async () => {
    const s = await api.workspaceSettings(token, workspace.id).catch(() => null);
    setAttached(
      new Set((s?.repos ?? []).map((r) => r.url).filter((u): u is string => Boolean(u))),
    );
  }, [token, workspace.id]);

  const load = useCallback(
    async (q: string) => {
      setError(null);
      try {
        const r = await api.connectionRepositories(token, connection.id, workspace.id, q);
        setRepos(r.items);
      } catch (e) {
        setError(errText(e));
        setRepos([]);
      }
    },
    [token, connection.id, workspace.id],
  );

  useEffect(() => {
    void load("");
    void loadAttached();
  }, [load, loadAttached, sourcesTick]);

  const picks = (repos ?? []).filter((r) => checked[r.id]);

  const attach = async () => {
    if (picks.length === 0) return;
    setBusy(true);
    try {
      const added = await attachReposToWorkspace(token, workspace, connection, picks);
      onNote(
        `Attached ${added} repositor${added === 1 ? "y" : "ies"} to ${workspace.name} — ` +
          `cloned on the next session launch.`,
      );
      setChecked({});
      void loadAttached();
      onSourcesChanged();
    } catch (e) {
      onNote(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="nested">
      <div className="row">
        <input
          className="grow"
          placeholder="Search repositories…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void load(search);
          }}
        />
        <button onClick={() => void load(search)}>Search</button>
      </div>

      {error && <p className="error">{error}</p>}
      {repos === null ? (
        <p className="empty">Loading repositories…</p>
      ) : repos.length === 0 ? (
        <p className="empty">Nothing reachable with this credential.</p>
      ) : (
        <ul className="rows">
          {repos.map((r) => {
            const isAttached = attached.has(r.clone_url);
            return (
              <li key={r.id} className={isAttached ? "attached" : undefined}>
                <input
                  type="checkbox"
                  disabled={isAttached}
                  checked={isAttached || Boolean(checked[r.id])}
                  onChange={(e) => setChecked((c) => ({ ...c, [r.id]: e.target.checked }))}
                />
                <div className="grow">
                  <div className="name">{r.full_path}</div>
                  <div className="sub">
                    {r.default_branch ?? "default branch"}
                    {r.description ? ` · ${r.description}` : ""}
                  </div>
                </div>
                {isAttached ? (
                  <span className="badge ok">attached</span>
                ) : (
                  r.visibility && <span className="badge">{r.visibility}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="row">
        <span className="grow" />
        <button className="primary" disabled={picks.length === 0 || busy} onClick={() => void attach()}>
          {busy ? "Attaching…" : `Add ${picks.length || ""} to ${workspace.name}`}
        </button>
      </div>
    </div>
  );
}

function OrganizationsView({
  token,
  homeId,
  home,
  orgs,
  workspaces,
  selectedOrgId,
  onChanged,
  onCreated,
  onNew,
}: {
  token: string;
  homeId: string;
  home: Tenant | null;
  orgs: Tenant[];
  workspaces: Workspace[];
  /** Org selected in the admin header; "__new__" opens the create hero. */
  selectedOrgId: string | null;
  onChanged: () => void;
  onCreated: (id: string) => void;
  /** Opens the create hero (sets the selector to "__new__" upstream). */
  onNew: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [inbound, setInbound] = useState<import("./api").Conversion[]>([]);
  // Inline rename of the selected organization.
  const [renaming, setRenaming] = useState(false);
  const [renameTo, setRenameTo] = useState("");

  const loadInbound = useCallback(async () => {
    try {
      const page = await api.inboundConversions(token, homeId);
      setInbound((page.items ?? []).filter((c) => c.status === "pending"));
    } catch {
      /* inbound discovery is best-effort */
    }
  }, [token, homeId]);

  useEffect(() => {
    void loadInbound();
  }, [loadInbound]);

  async function requestMode(org: Tenant) {
    // The barrier is easy to raise and deliberately hard to lower — make
    // sure nobody locks themselves out by accident again.
    if (
      !org.self_managed &&
      !window.confirm(
        `Make “${org.name}” self-managed?\n\n` +
          "This raises a VISIBILITY BARRIER: you (and every platform admin) lose " +
          "access to the organization and everything inside it — its workspaces " +
          "disappear from your lists. Only an admin whose home is inside the " +
          "organization can request the conversion back to managed; you would " +
          "then approve it here.",
      )
    )
      return;
    setError(null);
    try {
      await api.requestConversion(token, org.id, org.self_managed ? "managed" : "self_managed");
      await loadInbound();
    } catch (e) {
      setError(errText(e));
    }
  }

  async function saveRename(org: Tenant) {
    const next = renameTo.trim();
    if (!next || next === org.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.updateTenant(token, org.id, { name: next });
      setRenaming(false);
      onChanged();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeOrg(org: Tenant) {
    if (!window.confirm(`Delete organization “${org.name}”? Delete its workspaces first.`)) return;
    setError(null);
    try {
      await api.deleteTenant(token, org.id);
      onChanged();
    } catch (e) {
      setError(errText(e)); // 409 with children — expected guidance
    }
  }

  async function decide(c: import("./api").Conversion, status: "approved" | "rejected") {
    setError(null);
    try {
      await api.decideConversion(token, homeId, c.request_id ?? c.id ?? "", status);
      await loadInbound();
      onChanged(); // self_managed flag may have flipped
    } catch (e) {
      setError(errText(e));
    }
  }

  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const created = await api.createTenant(token, {
        name,
        parent_id: homeId,
        tenant_type: TENANT_TYPES.organization,
      });
      setName("");
      onChanged();
      onCreated((created as Tenant)?.id ?? "");
    } catch (err) {
      setError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  // Full-page create hero: for the very first organization AND for the
  // "+ New organization" entry from the admin org selector.
  if (
    selectedOrgId === "__new__" ||
    (orgs.length === 0 && home && home.tenant_type !== TENANT_TYPES.organization)
  ) {
    return (
      <div className="hero-create">
        <h1>
          <span className="hero-gradient">Create your organization</span>
        </h1>
        <p className="subtitle" style={{ maxWidth: 460, textAlign: "center" }}>
          An organization is a tenant in the admin hierarchy — your workspaces, members and
          repositories will live inside it.
        </p>
        <div className="card hero-create-card">
          <label className="field">
            Organization name
            <input
              placeholder="My organization"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </label>
          <p className="hint">
            Created managed (platform admins keep access); it can request self-managed mode
            later via dual consent.
          </p>
          {error && <div className="error">{error}</div>}
        </div>
        <button
          className="primary hero-create-btn"
          disabled={busy || !name.trim()}
          onClick={(e) => void create(e as unknown as FormEvent)}
        >
          Create organization
        </button>
        {orgs.length > 0 && (
          <button className="ghost" onClick={() => onCreated("")}>
            ← Back to {orgs[0]?.name ?? "organizations"}
          </button>
        )}
      </div>
    );
  }

  // Resolve the org the admin header selected (an org-homed user's own org
  // wins when nothing is selected — that's all they can administer).
  const selected =
    orgs.find((o) => o.id === selectedOrgId) ??
    (home?.tenant_type === TENANT_TYPES.organization ? home : orgs[0]) ??
    null;
  const orgWorkspaces = selected ? workspaces.filter((w) => w.orgName === selected.name) : [];

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Organization</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            One tenant per organization (the admin hierarchy governs management, never data);
            workspaces and members live inside it. Switch organizations in the sidebar header.
          </p>
        </div>
        <button className="primary" onClick={onNew}>
          ＋ New organization
        </button>
      </div>

      {selected && (
        <div className="card">
          <div className="org-head">
            {renaming ? (
              <div className="ctx-add org-rename">
                <input
                  autoFocus
                  value={renameTo}
                  onChange={(e) => setRenameTo(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void saveRename(selected);
                    if (e.key === "Escape") setRenaming(false);
                  }}
                />
                <button
                  type="button"
                  disabled={busy || !renameTo.trim()}
                  onClick={() => void saveRename(selected)}
                >
                  Save
                </button>
                <button type="button" className="ghost" onClick={() => setRenaming(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <>
                <h2 style={{ margin: 0 }}>{selected.name}</h2>
                <button
                  type="button"
                  className="ghost"
                  title="Rename organization"
                  onClick={() => {
                    setRenameTo(selected.name);
                    setRenaming(true);
                  }}
                >
                  ✎ Rename
                </button>
              </>
            )}
          </div>
          <ul className="rows">
            <li>
              <div className="grow">
                <div className="sub">Organization ID</div>
                <div className="name"><code>{selected.id}</code></div>
              </div>
              <button
                className="ghost"
                title="Copy ID"
                onClick={() => void navigator.clipboard?.writeText(selected.id)}
              >
                ⧉
              </button>
            </li>
            <li>
              <div className="grow">
                <div className="sub">Type / mode</div>
                <div className="name">
                  <span className="badge">{shortTypeName(selected.tenant_type)}</span>{" "}
                  <span className={`badge ${selected.self_managed ? "selfmanaged" : "workspace"}`}>
                    {selected.self_managed ? "self-managed 🔒" : "managed"}
                  </span>
                </div>
              </div>
              {selected.self_managed && selected.id !== home?.id ? (
                <span
                  className="hint"
                  style={{ margin: 0 }}
                  title="Self-managed = visibility barrier. An admin homed inside this organization requests the conversion; you approve it here."
                >
                  → managed: requested from inside
                </span>
              ) : (
                <button
                  className="ghost"
                  title="Dual-consent mode conversion: creates a pending request the other side approves"
                  onClick={() => void requestMode(selected)}
                >
                  {selected.self_managed ? "→ managed" : "→ self-managed"}
                </button>
              )}
            </li>
            <li>
              <div className="grow">
                <div className="sub">Workspaces / visible members</div>
                <div className="name">{orgWorkspaces.length} workspace(s)</div>
              </div>
            </li>
          </ul>
        </div>
      )}

      {/* Access map: the tenant hierarchy IS the privilege system — your
          home tenant anchors your scope (its subtree), self-managed raises
          a visibility barrier. One picture instead of a 404 hunt. */}
      {home && (
        <div className="card">
          <h2>Access map</h2>
          <p className="hint">
            Your scope is your home tenant's subtree. 🔒 self-managed = a visibility barrier:
            that subtree is governed by its own admins and hidden from you.
          </p>
          <ul className="access-tree">
            <li>
              <span className="access-node">
                🏛 <b>{home.name}</b>
                <span className="badge you">you are here</span>
              </span>
              <ul>
                {home.tenant_type === TENANT_TYPES.organization
                  ? workspaces.map((w) => (
                      <li key={w.id}>
                        <span className="access-node">▦ {w.name}</span>
                      </li>
                    ))
                  : orgs.map((o) => (
                      <li key={o.id} className={o.self_managed ? "access-dim" : ""}>
                        <span className="access-node">
                          🏢 {o.name}
                          {o.self_managed && (
                            <span
                              className="badge selfmanaged"
                              title="Visibility barrier: governed by its own admins; only a dual-consent conversion (requested from inside) lifts it"
                            >
                              🔒 subtree hidden from you
                            </span>
                          )}
                        </span>
                        {!o.self_managed && (
                          <ul>
                            {workspaces
                              .filter((w) => w.orgName === o.name)
                              .map((w) => (
                                <li key={w.id}>
                                  <span className="access-node">▦ {w.name}</span>
                                </li>
                              ))}
                          </ul>
                        )}
                      </li>
                    ))}
              </ul>
            </li>
          </ul>
          <p className="hint">
            Enforcement today: scope + barriers only — fine-grained permissions are registered
            in the types-registry (see System) but the PDP is not wired yet (allow-all).
          </p>
        </div>
      )}

      {selected && selected.id !== home?.id && (
        <div className="card danger-zone">
          <h2>Danger zone</h2>
          <ul className="rows">
            <li>
              <div className="grow">
                <div className="name">Delete organization</div>
                <div className="sub">
                  Permanently deletes the tenant. Its workspaces must be deleted first (the
                  platform refuses to cascade); Keycloak users keep existing.
                </div>
              </div>
              <button className="danger" onClick={() => void removeOrg(selected)}>
                Delete organization
              </button>
            </li>
          </ul>
        </div>
      )}
      {error && <div className="error">{error}</div>}

      {inbound.length > 0 && (
        <div className="card">
          <h2>Pending mode conversions (need your consent)</h2>
          <ul className="rows">
            {inbound.map((c) => (
              <li key={c.request_id ?? c.id}>
                <div className="grow">
                  <div className="name">
                    {c.child_tenant_name ?? c.tenant_id} → {c.target_mode}
                  </div>
                  <div className="sub">expires {c.expires_at ?? "—"}</div>
                </div>
                <button className="primary" onClick={() => decide(c, "approved")}>
                  Approve
                </button>
                <button onClick={() => decide(c, "rejected")}>Reject</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/* ── Access: model + roles (ADR-0006, P1) ── */

/** Admin surface to choose the organization's access MODEL and, when it is
 *  role-based, edit the roles (each role a set of privileges). Stored as AM
 *  tenant metadata — the same mechanism as the automation trust ramp — so it is
 *  backend-backed without a new gear. Enforcement (the Studio PDP) lands later;
 *  this screen is where the model and the roles are authored. */
function AccessView({
  token,
  org,
  selfManaged,
  projects,
  meId,
  meName,
}: {
  token: string;
  org: { id: string; name: string } | null;
  /** Self-managed orgs raise a visibility barrier: their access is governed
   *  from inside, and writes from outside 404. We show a notice, not the editor. */
  selfManaged: boolean;
  /** Projects of this organization — the per-project grant scopes. */
  projects: { id: string; name: string }[];
  /** The current user — so we never let them lock themselves out. */
  meId: string;
  meName: string;
}) {
  const [cfg, setCfg] = useState<AccessConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Grant subjects: organization members, and teams (RG groups).
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  // Add-grant form.
  const [gSubjectType, setGSubjectType] = useState<"member" | "team">("member");
  const [gSubject, setGSubject] = useState("");
  const [gRole, setGRole] = useState("");
  const [gScope, setGScope] = useState(""); // "" = whole org, else project id

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    if (!org) {
      setCfg(null);
      setLoading(false);
      return;
    }
    api
      .accessConfig(token, org.id)
      .then((v) => {
        if (!live) return;
        setCfg(normalizeAccessConfig(v ?? defaultAccessConfig()));
      })
      .catch((e) => live && setError(errText(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [token, org]);

  // Grant subjects: org accounts (owned by the org tenant or its projects) and
  // teams (RG groups). Best-effort — a failed load just leaves a picker empty.
  useEffect(() => {
    let live = true;
    if (!org) {
      setMembers([]);
      setTeams([]);
      return;
    }
    const ids = [org.id, ...projects.map((p) => p.id)];
    Promise.all(
      ids.map((id) => api.tenantUsers(token, id).then((p) => p.items ?? [], () => [])),
    ).then((lists) => {
      if (!live) return;
      const m = new Map<string, { id: string; name: string }>();
      for (const u of lists.flat()) m.set(u.id, { id: u.id, name: u.display_name ?? u.username });
      setMembers([...m.values()].sort((a, b) => a.name.localeCompare(b.name)));
    });
    api.groups(token).then(
      (p) =>
        live &&
        setTeams((p.items ?? []).map((g) => ({ id: g.id, name: g.name ?? g.id.slice(0, 8) }))),
      () => live && setTeams([]),
    );
    return () => {
      live = false;
    };
  }, [token, org, projects]);

  function mutate(next: AccessConfig) {
    setCfg(next);
    setDirty(true);
    setSaved(false);
  }

  const subjectPool = gSubjectType === "member" ? members : teams;

  function addGrant() {
    if (!cfg || !gSubject || !gRole) return;
    const subj = subjectPool.find((s) => s.id === gSubject);
    const scopeProj = projects.find((p) => p.id === gScope);
    const grant: import("./access").GrantDef = {
      id: `g_${Date.now().toString(36)}_${cfg.grants.length}`,
      subjectType: gSubjectType,
      subjectId: gSubject,
      subjectName: subj?.name ?? gSubject.slice(0, 8),
      roleKey: gRole,
      scopeType: gScope ? "project" : "org",
      scopeId: gScope,
      scopeName: gScope ? scopeProj?.name ?? gScope.slice(0, 8) : org?.name ?? "Organization",
    };
    mutate({ ...cfg, grants: [...cfg.grants, grant] });
    setGSubject("");
  }

  function removeGrant(id: string) {
    if (!cfg) return;
    mutate({ ...cfg, grants: cfg.grants.filter((g) => g.id !== id) });
  }

  const selfGranted = (c: AccessConfig): boolean =>
    c.grants.some((g) => g.subjectType === "member" && g.subjectId === meId);

  /** Give the current user an org-wide Owner grant so enabling roles can't lock
   *  them out. Returns the config with the grant appended (idempotent). */
  function withSelfOwner(c: AccessConfig): AccessConfig {
    if (selfGranted(c)) return c;
    const ownerKey = c.roles.some((r) => r.key === "owner") ? "owner" : c.roles[0]?.key ?? "owner";
    const grant: GrantDef = {
      id: `g_self_${Date.now().toString(36)}`,
      subjectType: "member",
      subjectId: meId,
      subjectName: `${meName} (you)`,
      roleKey: ownerKey,
      scopeType: "org",
      scopeId: "",
      scopeName: org?.name ?? "Organization",
    };
    return { ...c, grants: [...c.grants, grant] };
  }

  function grantMyself() {
    if (!cfg) return;
    mutate(withSelfOwner(cfg));
  }

  function setModel(model: AccessModel) {
    if (!cfg) return;
    // Switching to role-based without a grant for yourself would hide everything
    // from you once enforcement is on — seed a self Owner grant up front.
    const next = model === "roles" ? withSelfOwner({ ...cfg, model }) : { ...cfg, model };
    mutate(next);
  }

  function togglePrivilege(roleKey: string, privId: string) {
    if (!cfg) return;
    mutate({
      ...cfg,
      roles: cfg.roles.map((r) => {
        if (r.key !== roleKey) return r;
        const has = r.privileges.includes(privId);
        return {
          ...r,
          privileges: has ? r.privileges.filter((p) => p !== privId) : [...r.privileges, privId],
        };
      }),
    });
  }

  function renameRole(roleKey: string, name: string) {
    if (!cfg) return;
    mutate({ ...cfg, roles: cfg.roles.map((r) => (r.key === roleKey ? { ...r, name } : r)) });
  }

  function addRole() {
    if (!cfg) return;
    const key = `role_${cfg.roles.length + 1}_${PRIVILEGES.length}`.replace(/[^a-z0-9_]/gi, "");
    mutate({
      ...cfg,
      roles: [...cfg.roles, { key, name: "New role", privileges: ["project.view"] }],
    });
  }

  function removeRole(roleKey: string) {
    if (!cfg) return;
    mutate({ ...cfg, roles: cfg.roles.filter((r) => r.key !== roleKey) });
  }

  async function save() {
    if (!org || !cfg) return;
    setBusy(true);
    setError(null);
    try {
      await api.putAccessConfig(token, org.id, cfg);
      setDirty(false);
      setSaved(true);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const groups = privilegesByGroup();

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Access</h1>
          <p className="subtitle" style={{ margin: 0 }}>
            Choose how access works in {org?.name ?? "this organization"}. Stored on the
            organization (like the automation level); enforcement arrives with the Studio PDP.
          </p>
        </div>
        <button
          className="primary"
          disabled={!org || !cfg || !dirty || busy || selfManaged}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : saved && !dirty ? "Saved" : "Save"}
        </button>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <p className="hint">Loading…</p>
      ) : !org || !cfg ? (
        <p className="empty">No organization in context.</p>
      ) : selfManaged ? (
        <div className="card">
          <p className="hint" style={{ margin: 0 }}>
            <b>{org.name} is self-managed.</b> It raises a visibility barrier — its access is
            governed by admins inside the organization, and it can't be configured from here.
            Convert it to managed (requested from inside, via dual consent) to manage its access on
            this screen.
          </p>
        </div>
      ) : (
        <>
          <div className="card">
            <h2>Access model</h2>
            <div className="access-models">
              {ACCESS_MODELS.map((m) => (
                <label key={m.id} className={`access-model${cfg.model === m.id ? " on" : ""}`}>
                  <input
                    type="radio"
                    name="access-model"
                    checked={cfg.model === m.id}
                    onChange={() => setModel(m.id)}
                  />
                  <div>
                    <div className="name">{m.label}</div>
                    <div className="sub">{m.blurb}</div>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {cfg.model === "roles" ? (
            <>
              <div className="notice">
                <b>Enforcement is rolling out.</b> The Studio PDP now filters a project's{" "}
                <i>Works</i> by these grants (ADR-0006); other surfaces still run allow-all until
                their checks land. Owner keeps every privilege.
              </div>
              {!selfGranted(cfg) && (
                <div className="notice notice-danger">
                  <b>You have no grant here.</b> With role-based access on, you'd be locked out of
                  this organization's projects.{" "}
                  <button className="ghost" onClick={grantMyself}>
                    Grant myself Owner
                  </button>
                </div>
              )}
              {cfg.roles.map((role) => (
                <div key={role.key} className="card role-card">
                  <div className="role-head">
                    <input
                      className="role-name"
                      value={role.name}
                      onChange={(e) => renameRole(role.key, e.target.value)}
                    />
                    {role.system ? (
                      <span className="badge" title="Seeded role — cannot be deleted">
                        system
                      </span>
                    ) : (
                      <button className="ghost" onClick={() => removeRole(role.key)}>
                        Delete
                      </button>
                    )}
                    <span className="sub" style={{ marginLeft: "auto" }}>
                      {role.privileges.length} / {PRIVILEGES.length} privileges
                    </span>
                  </div>
                  <div className="role-grid">
                    {groups.map((g) => (
                      <div key={g.group} className="role-group">
                        <div className="field-label">{g.group}</div>
                        {g.items.map((p) => {
                          const locked = role.key === "owner"; // owner = all, never editable
                          return (
                            <label key={p.id} className="priv">
                              <input
                                type="checkbox"
                                disabled={locked}
                                checked={role.privileges.includes(p.id)}
                                onChange={() => togglePrivilege(role.key, p.id)}
                              />
                              {p.label}
                            </label>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
              <button onClick={addRole}>＋ Add role</button>

              <div className="card" style={{ marginTop: 16 }}>
                <h2>Grants</h2>
                <p className="hint" style={{ marginTop: 0 }}>
                  Assign a role to a member or a team, scoped to the whole organization or a single
                  project. This is the (subject × role × scope) the PDP will read.
                </p>
                {cfg.grants.length === 0 ? (
                  <p className="empty">No grants yet — add one below.</p>
                ) : (
                  <table className="ptable">
                    <thead>
                      <tr>
                        <th>Subject</th>
                        <th>Role</th>
                        <th>Scope</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {cfg.grants.map((g) => (
                        <tr key={g.id}>
                          <td>
                            <span className="badge">{g.subjectType}</span> {g.subjectName}
                          </td>
                          <td>{cfg.roles.find((r) => r.key === g.roleKey)?.name ?? g.roleKey}</td>
                          <td className="sub">
                            {g.scopeType === "org" ? `${g.scopeName} (org)` : g.scopeName}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <button className="ghost" onClick={() => removeGrant(g.id)}>
                              Remove
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                <div className="grant-add">
                  <select
                    value={gSubjectType}
                    onChange={(e) => {
                      setGSubjectType(e.target.value as "member" | "team");
                      setGSubject("");
                    }}
                  >
                    <option value="member">Member</option>
                    <option value="team">Team</option>
                  </select>
                  <select value={gSubject} onChange={(e) => setGSubject(e.target.value)}>
                    <option value="">
                      {subjectPool.length
                        ? `Select ${gSubjectType}…`
                        : gSubjectType === "team"
                          ? "No teams yet"
                          : "No members yet"}
                    </option>
                    {subjectPool.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <select value={gRole} onChange={(e) => setGRole(e.target.value)}>
                    <option value="">Select role…</option>
                    {cfg.roles.map((r) => (
                      <option key={r.key} value={r.key}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                  <select value={gScope} onChange={(e) => setGScope(e.target.value)}>
                    <option value="">Whole organization</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                  <button className="primary" disabled={!gSubject || !gRole} onClick={addGrant}>
                    Add grant
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="card">
              <p className="hint" style={{ margin: 0 }}>
                Tenant access is on: anyone who is a member of the organization or a project can act
                within it. Switch to <b>Role-based access</b> above to define roles and privileges.
              </p>
            </div>
          )}
        </>
      )}
    </>
  );
}

/* ── Profile ── */

/// Best-effort JWT payload decode for DISPLAY only — authorization decisions
/// live in the backend (oidc-authn-plugin validates signatures; we just show
/// the person who they are signed in as). Static dev tokens are opaque, so
/// this returns null and the card degrades gracefully.
function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(b64)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Per-user AI keys the in-IDE agents authenticate with. `anthropic-key` →
 *  ANTHROPIC_API_KEY (Claude Code), `openai-key` → OPENAI_API_KEY (Codex).
 *  Stored as PRIVATE credstore secrets so only the owner's launches see them. */
const AI_KEYS: { ref: string; label: string; env: string; hint: string }[] = [
  {
    ref: "anthropic-key",
    label: "Anthropic API key",
    env: "ANTHROPIC_API_KEY",
    hint: "Claude Code agent in the IDE",
  },
  {
    ref: "openai-key",
    label: "OpenAI API key",
    env: "OPENAI_API_KEY",
    hint: "Codex agent in the IDE",
  },
];

function AiKeysCard({ token }: { token: string }) {
  const [status, setStatus] = useState<Record<string, "ok" | "broken" | "checking">>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const probe = useCallback(
    async (ref: string) => {
      setStatus((s) => ({ ...s, [ref]: "checking" }));
      const r = await api.checkSecret(token, ref);
      setStatus((s) => ({ ...s, [ref]: r }));
    },
    [token],
  );

  useEffect(() => {
    for (const k of AI_KEYS) void probe(k.ref);
  }, [probe]);

  async function saveKey(ref: string, label: string) {
    // Write-only: prompt for the value, store it, and never read it back.
    const value = window.prompt(`Paste your ${label} — stored encrypted, never shown again:`);
    if (!value?.trim()) return;
    setBusy(ref);
    setError(null);
    setNote(null);
    try {
      await api.putSecret(token, ref, value.trim(), PERSONAL_SECRET_TYPE, "private");
      await probe(ref);
      setNote(`${label} saved — new IDE sessions you launch will use it.`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  async function removeKey(ref: string, label: string) {
    if (
      !window.confirm(
        `Delete your ${label}? Sessions you launch will fall back to the organization key, if one is set.`,
      )
    )
      return;
    setBusy(ref);
    setError(null);
    setNote(null);
    try {
      await api.deleteSecret(token, ref);
      setStatus((s) => ({ ...s, [ref]: "broken" }));
      setNote(`${label} removed.`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2>AI keys</h2>
      <p className="hint">
        Personal keys for the in-IDE AI agents. Stored encrypted in your private credstore and
        injected only into sessions you launch — nobody else can read them, and they take
        precedence over the organization key. Write-only: a saved value is never displayed back.
      </p>
      <ul className="rows">
        {AI_KEYS.map((k) => {
          const st = status[k.ref];
          return (
            <li key={k.ref}>
              <div className="grow">
                <div className="name">{k.label}</div>
                <div className="sub">
                  {k.hint} — <code>{k.env}</code>
                </div>
              </div>
              {st === "ok" && <span className="badge workspace">set ✓</span>}
              {st === "broken" && <span className="sub">not set</span>}
              {st === "checking" && <span className="sub">…</span>}
              <button
                className="ghost"
                disabled={busy === k.ref}
                onClick={() => void saveKey(k.ref, k.label)}
              >
                {st === "ok" ? "Replace" : "Set"}
              </button>
              {st === "ok" && (
                <button
                  className="ghost"
                  title="Delete your key"
                  disabled={busy === k.ref}
                  onClick={() => void removeKey(k.ref, k.label)}
                >
                  ✕
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {note && <p className="hint">{note}</p>}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

function ProfileView({ me, home, token }: { me: Me; home: Tenant | null; token: string }) {
  const [theme, setTheme] = useState("light");
  const [language, setLanguage] = useState("en");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .userSettings(token)
      .then((p) => {
        if (p.theme) {
          setTheme(p.theme);
          document.documentElement.dataset.theme = p.theme;
        }
        if (p.language) setLanguage(p.language);
      })
      .catch((e) => setError(errText(e)));
  }, [token]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    try {
      await api.saveUserSettings(token, { theme, language });
      document.documentElement.dataset.theme = theme;
      setSaved(true);
    } catch (err) {
      setError(errText(err));
    }
  }

  const claims = decodeJwtClaims(token);
  const claim = (k: string) => {
    const v = claims?.[k];
    return typeof v === "string" && v.trim() ? v : null;
  };
  const displayName = claim("name") ?? claim("preferred_username");
  const sessionUntil =
    typeof claims?.exp === "number" ? new Date(claims.exp * 1000).toLocaleTimeString() : null;

  return (
    <>
      <h1>Profile</h1>
      <p className="subtitle">Identity as the backend sees it (from the validated token).</p>

      <div className="card">
        <h2>Signed in as</h2>
        <ul className="rows">
          <li>
            <div className="grow">
              <div className="sub">Name</div>
              <div className="name">{displayName ?? "— (opaque dev token)"}</div>
            </div>
          </li>
          {claim("preferred_username") && (
            <li>
              <div className="grow">
                <div className="sub">Username</div>
                <div className="name">{claim("preferred_username")}</div>
              </div>
            </li>
          )}
          {claim("email") && (
            <li>
              <div className="grow">
                <div className="sub">Email</div>
                <div className="name">{claim("email")}</div>
              </div>
            </li>
          )}
          <li>
            <div className="grow">
              <div className="sub">Identity provider</div>
              <div className="name">{claim("iss") ?? "static token (dev profile)"}</div>
            </div>
          </li>
          {sessionUntil && (
            <li>
              <div className="grow">
                <div className="sub">Session token valid until</div>
                <div className="name">{sessionUntil} (renewed silently)</div>
              </div>
            </li>
          )}
        </ul>
      </div>

      <div className="card">
        <ul className="rows">
          <li>
            <div className="grow"><div className="sub">Subject ID</div><div className="name">{me.subject_id}</div></div>
          </li>
          <li>
            <div className="grow"><div className="sub">Subject type</div><div className="name">{me.subject_type ?? "—"}</div></div>
          </li>
          <li>
            <div className="grow">
              <div className="sub">Home tenant</div>
              <div className="name">{home ? `${home.name} (${shortTypeName(home.tenant_type)})` : me.subject_tenant_id}</div>
            </div>
          </li>
        </ul>
        <p className="hint" style={{ marginTop: 12 }}>
          API: <a href="/cf/docs">/cf/docs</a>
        </p>
      </div>

      <AiKeysCard token={token} />

      <div className="card">
        <h2>Preferences</h2>
        <p className="hint">Stored server-side per user (simple-user-settings gear).</p>
        <form className="inline" onSubmit={save}>
          <select value={theme} onChange={(e) => setTheme(e.target.value)}>
            <option value="light">light</option>
            <option value="dark">dark</option>
          </select>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            <option value="en">en</option>
            <option value="ru">ru</option>
          </select>
          <button className="primary">Save</button>
          {saved && <span className="hint">saved ✓</span>}
        </form>
        {error && <div className="error">{error}</div>}
      </div>
    </>
  );
}

/* ── Studio launcher (studio-session gear → per-workspace Theia container) ── */

function StudioLauncher({
  token,
  target,
  onClose,
  onOpen,
}: {
  token: string;
  target: StudioTarget;
  onClose: () => void;
  /** Opens the session as an embedded space (same window, no new tab). */
  onOpen: (session: { id: string; url: string }) => void;
}) {
  const [session, setSession] = useState<import("./api").StudioSession | null>(null);
  const [repos, setRepos] = useState<import("./api").RepoEntry[] | null>(null);
  const [root, setRoot] = useState<{
    path?: string;
    repoUrl?: string;
    branch?: string;
    tokenRef?: string;
  }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoLaunched = useRef(false);

  // A root project reads its sources from workspaceSettings. A nested project
  // is standalone — it carries its own repos/root on the target (its single
  // source), and has no workspaceSettings of its own to read.
  useEffect(() => {
    if (target.standalone) {
      setRepos(target.repos ?? []);
      setRoot(target.root ?? {});
      return;
    }
    api
      .workspaceSettings(token, target.id)
      .then((s) => {
        setRepos(s?.repos ?? []);
        setRoot({
          path: s?.root_path?.trim() || undefined,
          repoUrl: s?.root_repo_url?.trim() || undefined,
          branch: s?.root_branch?.trim() || undefined,
          tokenRef: s?.root_token_ref?.trim() || undefined,
        });
      })
      .catch(() => setRepos([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, target.id]);

  // Kubernetes creates the session Pod asynchronously. Do not mount its URL
  // until the backend reachability probe moves it from starting to running;
  // otherwise the first iframe request races the Service endpoint and gets a
  // sticky Cloudflare 502 instead of the container-side splash.

  // "Open in IDE" means open the Studio — launch as soon as the sources are
  // known instead of asking for a second click. Creation is idempotent per
  // workspace: an already-running session is simply returned (and opened).
  useEffect(() => {
    if (repos === null || session || autoLaunched.current) return;
    autoLaunched.current = true;
    void launch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repos, session]);

  async function launch() {
    setBusy(true);
    setError(null);
    try {
      // Re-read settings at launch time: the card may have been open since
      // before the last "Save repositories", and a stale snapshot silently
      // launches without the new sources/targets/token refs.
      let freshRepos = repos ?? [];
      let freshRoot = root;
      if (!target.standalone) {
        try {
          const s = await api.workspaceSettings(token, target.id);
          freshRepos = s?.repos ?? [];
          freshRoot = {
            path: s?.root_path?.trim() || undefined,
            repoUrl: s?.root_repo_url?.trim() || undefined,
            branch: s?.root_branch?.trim() || undefined,
            tokenRef: s?.root_token_ref?.trim() || undefined,
          };
          setRepos(freshRepos);
          setRoot(freshRoot);
        } catch {
          // Settings unreachable — fall back to the snapshot we have.
        }
      }
      const usable = freshRepos.filter((r) =>
        r.source === "local" ? Boolean(r.path?.trim()) : Boolean(r.url?.trim()),
      );
      const created = await api.createStudioSession(token, target.id, usable, freshRoot);
      setSession(created);
      const ready = await waitForStudioSessionReady(created, () =>
        api.studioSession(token, created.id),
      );
      setSession(ready);
      onOpen({ id: ready.id, url: ready.url });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    if (!session) return;
    setError(null);
    try {
      await api.deleteStudioSession(token, session.id);
      setSession(null);
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <div className="card launcher">
      <div className="card-head">
        <h2>Studio — {target.name}</h2>
        <button className="ghost" onClick={onClose}>
          close
        </button>
      </div>
      <p>
        Launches a dedicated Theia IDE container for this workspace (studio-session gear). The
        session is published on loopback and stopped automatically after its maximum age.
      </p>

      {!session && (
        <>
          {(root.path || root.repoUrl) && (
            <p className="hint">
              Workspace root: <code>{root.path || root.repoUrl}</code>{" "}
              {root.path ? "(local folder)" : "(cloned on first launch)"}
            </p>
          )}
          {repos && repos.length > 0 && (
            <p className="hint">
              Workspace sources ({repos.length}):{" "}
              {repos.map((r) => `${r.name} (${r.source})`).join(", ")} — managed on the dashboard.
            </p>
          )}
          {repos && repos.length === 0 && !root.path && !root.repoUrl && (
            <p className="hint">
              No sources bound yet — the workspace opens with an empty repository. Connect
              repositories on the dashboard (Repositories card).
            </p>
          )}
          {/* Launch fires automatically when the card opens; the button is
              the retry path (e.g. after fixing sources or a failed start). */}
          <button className="primary" onClick={launch} disabled={busy || repos === null}>
            {busy || repos === null ? "Launching…" : error ? "Retry launch" : "Launch again"}
          </button>
        </>
      )}

      {session && (
        <ul className="rows">
          <li>
            <div className="grow">
              <div className="name">
                {session.state === "starting" ? "Starting container…" : `Session ${session.state}`}
              </div>
              <div className="sub">{session.url}</div>
            </div>
            <span className={`badge ${session.state === "running" ? "workspace" : ""}`}>
              {session.state}
            </span>
            <button
              className="primary"
              onClick={() => onOpen({ id: session.id, url: session.url })}
            >
              Open space
            </button>
            <button className="ghost" onClick={stop}>
              Stop session
            </button>
          </li>
        </ul>
      )}

      {error && <div className="error">{error}</div>}
      <p className="hint">
        Requires Docker on the backend host. The IDE image is pulled from the
        registry automatically — the first launch after a backend start may ask
        you to retry while the download finishes.
      </p>
    </div>
  );
}
