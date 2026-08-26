import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { env as runtimeEnv } from "./env";
import { errText, matches } from "./format";
import { ProjectsPortfolio } from "./projects";
import { PeopleView } from "./people";
import { StudioAI } from "./studio-ai";
import { SpecQuality } from "./spec-quality";
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
  UNAUTHENTICATED_EVENT,
  shortTypeName,
  TENANT_TYPES,
  JOURNEY_STAGES,
  STATUS_LADDER,
  normalizeStages,
  type ArtifactEdge,
  type ArtifactNode,
  type Connection,
  type ConnectorProvider,
  type Me,
  type ProjectConfig,
  type ProjectMode,
  type ProjectStatus,
  type RemoteRepo,
  type RepoEntry,
  type Tenant,
  type WorkspaceSettings,
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

/** What "Open Studio" launches against. A root project passes itself (a
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

/** Platform tenant administration (organizations, raw workspace list).
 *
 *  Off by default — concept v2 hides the organization level. Kept one
 *  `localStorage.setItem("studio.platformAdmin", "on")` away because the
 *  hierarchy is still real and someone has to be able to see it. */
function platformAdminEnabled(): boolean {
  try {
    return localStorage.getItem("studio.platformAdmin") === "on";
  } catch {
    return false;
  }
}

/* ── Filters (right panel) ── */

interface Filters {
  query: string;
  org: string; // platform admin: filter the raw workspace list by organization
  selfManagedOnly: boolean;
  sort: "name-asc" | "name-desc";
  model: string; // chats: filter by model_id
  sections: { gears: boolean; upstreams: boolean; entities: boolean }; // system
}

const DEFAULT_FILTERS: Filters = {
  query: "",
  org: "",
  selfManagedOnly: false,
  sort: "name-asc",
  model: "",
  sections: { gears: true, upstreams: true, entities: true },
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
  const [value, setValue] = useState("studio-admin-token");
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

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const who = await api.me(value); // 401 -> failed login
      onLogin(value, who);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 401 ? "Invalid token" : errText(err));
    } finally {
      setBusy(false);
    }
  }

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

        {/* Static-profile escape hatch: dev tokens, tucked away. */}
        <details className="login-dev">
          <summary>Developer sign-in (static token)</summary>
          <form onSubmit={submit} className="inline">
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="studio-admin-token"
            />
            <button disabled={busy || !value}>Sign in</button>
          </form>
          <p className="hint">
            Works with the static profiles only (<code>config/dev.yaml</code>,{" "}
            <code>config/postgres.yaml</code>). The compose stack signs in through Keycloak
            instead — use the button above, admin or demo, password <code>studio</code>.
          </p>
        </details>
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
    title: "Monitor",
    items: [{ id: "system", icon: "cog", label: "System" }],
  },
];

type AdminView = "people" | "access" | "connectors" | "secrets" | "tenants" | "workspaces";

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
  { id: "workspaces", icon: "grid", label: "Project tenants" },
];

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
  const [orgNavMenu, setOrgNavMenu] = useState(false);
  const [wsNavMenu, setWsNavMenu] = useState(false);
  // Admin area (console pattern): a separate mode with its own sidebar for
  // organizations / members / workspaces administration.
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminView, setAdminView] = useState<AdminView>("people");
  // Which organization the admin area is scoped to ("__new__" = create hero).
  // Concept v2 resolves it implicitly; the picker only appears under the flag.
  const [adminOrgId, setAdminOrgId] = useState<string | null>(null);
  const [adminOrgMenu, setAdminOrgMenu] = useState(false);
  const showPlatform = platformAdminEnabled();
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
  const [orgs, setOrgs] = useState<Tenant[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  // Guards the one-time default-organization seed on a from-scratch deploy (see
  // refresh): only try once per session so a failing create can't loop.
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
    setSpaces((prev) => prev.filter((s) => s.wsId !== wsId));
    setActiveSpace((a) => (a === wsId ? null : a));
  }, []);

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
  const [spaceDirty, setSpaceDirty] = useState<Record<string, number>>({});
  const spaceOrigin = (url: string): string => {
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  };

  /* studio.init retry: the iframe's first load events are the session gate's
     redirect/splash pages — Theia's bridge isn't listening yet, so a single
     onLoad handshake is lost and the IDE never gets the theme/token. Repeat
     until the bridge answers with studio.status (its ack to studio.init). */
  const tokenRef = useRef(token);
  tokenRef.current = token;
  const initTimersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const stopInitRetry = (wsId: string) => {
    const t = initTimersRef.current[wsId];
    if (t !== undefined) {
      clearInterval(t);
      delete initTimersRef.current[wsId];
    }
  };

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
  // Workspaces of the active org — the second sidebar switcher's options — and
  // the one currently in the crumb (null = the whole-org "All workspaces" view).
  const orgWorkspaces = workspaces.filter((w) => w.orgId === activeOrgResolvedId);
  const currentWorkspace = workspaces.find((w) => w.id === crumb.projectId) ?? null;

  // When a project is open, the sidebar gains its tab nav (Overview / Artifacts
  // / Spec Quality / Team) so the tabs live on the panel rather than the page.
  const projectOpen = !adminOpen && !activeSpace && view === "projects" && !!crumb.nestedId;

  const panelView: PanelView = dash ? "dashboard" : view;

  const refresh = useCallback(async () => {
    setError(null);
    try {
      // The home tenant comes from the validated token. If it no longer
      // exists (deleted), say so plainly instead of raising a raw 404.
      const homeTenant = await api.tenant(token, me.subject_tenant_id).catch((e) => {
        if (e instanceof ApiError && e.status === 404) {
          throw new Error(
            `Your home tenant (${me.subject_tenant_id}) no longer exists — it was probably deleted. ` +
              `Re-create it or sign in as a user whose home tenant is alive.`,
          );
        }
        throw e;
      });
      const page = await api
        .tenantChildren(token, me.subject_tenant_id)
        .catch((e) => (e instanceof ApiError && e.status === 404 ? { items: [] } : Promise.reject(e)));
      setHome(homeTenant);
      const children = page.items ?? [];
      let orgList = children.filter((t) => t.tenant_type === TENANT_TYPES.organization);

      // From-scratch bootstrap: the backend seeds only the platform root tenant,
      // and a workspace must hang off an ORGANIZATION (the AM type barrier
      // rejects a workspace directly under the platform root). So on the very
      // first login — a fresh database with no organization yet — create a
      // default one under the home tenant, mirroring demo.sh's step 3. This is
      // what lets a clean deploy create workspaces and projects right away
      // instead of dead-ending on an empty org list. Idempotent: only when
      // there are zero orgs, and only once per session.
      if (
        orgList.length === 0 &&
        homeTenant.tenant_type !== TENANT_TYPES.organization &&
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
            {/* Organization switcher — sits where "Home" used to, because the
                organization IS the home context: pick one and its projects
                open. A static pill when there is only one; creation lives in
                the account menu below. */}
            <div className="nav-section org-nav">
              <div className="org-select-wrap">
                <button
                  type="button"
                  className="org-select"
                  disabled={orgOptions.length <= 1}
                  title={activeOrg?.name ?? "Organization"}
                  onClick={() => setOrgNavMenu((v) => !v)}
                >
                  <span className="account-avatar small">
                    {(activeOrg?.name ?? "?").slice(0, 1).toUpperCase()}
                  </span>
                  <span className="org-select-name">{activeOrg?.name ?? "Select organization"}</span>
                  {orgOptions.length > 1 && <span className="chev">▾</span>}
                </button>
                {orgNavMenu && orgOptions.length > 1 && (
                  <div className="org-menu">
                    {orgOptions.map((o) => (
                      <button
                        key={o.id}
                        type="button"
                        onClick={() => {
                          setActiveOrgId(o.id);
                          setCrumb({});
                          setView("projects");
                          setActiveSpace(null);
                          setOrgNavMenu(false);
                        }}
                      >
                        <span className="account-avatar small">{o.name.slice(0, 1).toUpperCase()}</span>
                        {o.name}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="org-new"
                      title="Create an organization in the account menu"
                      onClick={() => {
                        setOrgNavMenu(false);
                        setAccountMenu(true);
                      }}
                    >
                      ＋ New organization
                    </button>
                  </div>
                )}
              </div>
            </div>
            {/* Workspace switcher — one level below the organization one. Picking
                a workspace opens its projects (+ its properties panel); "All
                workspaces" drops back to the whole-org portfolio. */}
            {activeOrg && (
              <div className="nav-section org-nav ws-nav">
                <div className="org-select-wrap">
                  <button
                    type="button"
                    className="org-select"
                    title={currentWorkspace?.name ?? "All workspaces"}
                    onClick={() => setWsNavMenu((v) => !v)}
                  >
                    <span className="account-avatar small">
                      {(currentWorkspace?.name ?? "▤").slice(0, 1).toUpperCase()}
                    </span>
                    <span className="org-select-name">
                      {currentWorkspace?.name ?? "All workspaces"}
                    </span>
                    <span className="chev">▾</span>
                  </button>
                  {wsNavMenu && (
                    <div className="org-menu">
                      <button
                        type="button"
                        className={!crumb.projectId ? "on" : ""}
                        onClick={() => {
                          setCrumb({});
                          setView("projects");
                          setActiveSpace(null);
                          setWsNavMenu(false);
                        }}
                      >
                        <span className="account-avatar small">▤</span>
                        All workspaces
                      </button>
                      {orgWorkspaces.map((w) => (
                        <button
                          key={w.id}
                          type="button"
                          className={crumb.projectId === w.id ? "on" : ""}
                          onClick={() => {
                            setCrumb({ projectId: w.id });
                            setView("projects");
                            setActiveSpace(null);
                            setWsNavMenu(false);
                          }}
                        >
                          <span className="account-avatar small">
                            {w.name.slice(0, 1).toUpperCase()}
                          </span>
                          {w.name}
                        </button>
                      ))}
                      <button
                        type="button"
                        className="org-new"
                        title="Create a workspace in the account menu"
                        onClick={() => {
                          setWsNavMenu(false);
                          setAccountMenu(true);
                        }}
                      >
                        ＋ New workspace
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
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
                    title="Close space (the session keeps running)"
                    onClick={() => closeSpace(s.wsId)}
                  >
                    ✕
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
              key={s.wsId}
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
                    { type: "studio.init", theme, apiToken: tokenRef.current },
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
        {error && <div className="error">{error}</div>}
        {adminOpen ? (
          <>
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
}: {
  view: PanelView;
  token: string;
  filters: Filters;
  onChange: (f: Filters) => void;
  open: boolean;
  onToggle: () => void;
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
      <WorkspaceDashboard
        token={token}
        ws={root}
        embedded
        onBack={() => setCrumb({})}
        onOpenStudio={onOpenStudio}
      />
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
  const [newMode, setNewMode] = useState<import("./api").ProjectMode>("greenfield");

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
        .putProjectConfig(token, tenant.id, { mode: newMode, stages: [], status: "draft" })
        .catch(() => {});
      setNewName("");
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
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              placeholder="Project name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <select
              value={newMode}
              onChange={(e) => setNewMode(e.target.value as import("./api").ProjectMode)}
            >
              <option value="greenfield">Build something new</option>
              <option value="modernize">Modernize existing</option>
            </select>
            <button className="primary" onClick={() => void create()} disabled={!newName.trim() || busy}>
              {busy ? "Creating…" : "Create"}
            </button>
            <button className="ghost" onClick={() => setCreating(false)}>
              Cancel
            </button>
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
          <p className="empty">
            No projects yet — create one to get a codebase context (sources, IDE, artifacts).
          </p>
        ) : (
          <ul className="rows">
            {projects.map((p) => (
              <li key={p.id}>
                <div className="grow">
                  <div className="name">{p.name}</div>
                  <div className="sub">
                    <code>{p.id.slice(0, 8)}…</code>
                  </div>
                </div>
                <button className="ghost" onClick={() => onOpenProject(p)}>
                  Open
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** Project attributes (mode / status / stages / brief) — the fields the retired
 *  studio-project gear used to own, now stored as `project.config` tenant
 *  metadata on the project tenant and edited here. Status is forward-only and
 *  the stage list is validated against the catalogue, both client-side now. */
function ProjectProperties({ token, projectId }: { token: string; projectId: string }) {
  const fallback: ProjectConfig = { mode: "greenfield", status: "draft", stages: ["intent"] };
  const [saved, setSaved] = useState<ProjectConfig | null>(null);
  const [draft, setDraft] = useState<ProjectConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api.projectConfig(token, projectId).then(
      (c) => {
        if (cancelled) return;
        const v: ProjectConfig = { ...fallback, ...(c ?? {}), stages: normalizeStages(c?.stages ?? ["intent"]) };
        setSaved(v);
        setDraft(v);
      },
      (e) => {
        if (!cancelled) setErr(errText(e));
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, projectId]);

  if (err) return <div className="error">{err}</div>;
  if (!draft || !saved) return <p className="empty">Loading project properties…</p>;

  const stages = draft.stages ?? [];
  const statusIdx = STATUS_LADDER.indexOf(draft.status ?? "draft");
  const dirty = JSON.stringify(saved) !== JSON.stringify(draft);

  const patch = (p: Partial<ProjectConfig>) => {
    setJustSaved(false);
    setDraft((d) => (d ? { ...d, ...p } : d));
  };
  const toggleStage = (key: string) => patch({ stages: normalizeStages(stages.includes(key) ? stages.filter((s) => s !== key) : [...stages, key]) });

  async function save() {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    try {
      const clean: ProjectConfig = { ...draft, stages: normalizeStages(draft.stages ?? []) };
      await api.putProjectConfig(token, projectId, clean);
      setSaved(clean);
      setDraft(clean);
      setJustSaved(true);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="topbar" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>Project properties</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {justSaved && !dirty && <span className="sub">Saved</span>}
          <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      <div className="field">
        <span className="lbl">Mode</span>
        <select
          value={draft.mode ?? "greenfield"}
          onChange={(e) => patch({ mode: e.target.value as ProjectMode })}
        >
          <option value="greenfield">Greenfield — build from an idea</option>
          <option value="modernize">Modernize — start from a source repository</option>
        </select>
      </div>

      <div className="field">
        <span className="lbl">Status</span>
        <div style={{ display: "flex", gap: 6 }}>
          {STATUS_LADDER.map((s, i) => (
            <button
              key={s}
              className={draft.status === s ? "primary" : "ghost"}
              // Forward-only: you can hold or advance, never regress.
              disabled={i < statusIdx}
              title={i < statusIdx ? "Status is forward-only — it cannot move back" : undefined}
              onClick={() => patch({ status: s as ProjectStatus })}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="lbl">Journey stages</span>
        <div className="chips">
          {JOURNEY_STAGES.map((s) => {
            const on = stages.includes(s.key) || s.required;
            return (
              <button
                key={s.key}
                type="button"
                className={`chip${on ? " on" : ""}`}
                disabled={s.required}
                title={s.required ? "Intent is always applied" : undefined}
                onClick={() => toggleStage(s.key)}
              >
                {s.label}
                {s.required ? " ·" : ""}
              </button>
            );
          })}
        </div>
      </div>

      <div className="field">
        <span className="lbl">{draft.mode === "modernize" ? "Notes" : "Brief"}</span>
        <textarea
          rows={4}
          placeholder={
            draft.mode === "modernize"
              ? "Optional notes about the modernization."
              : "The idea, pasted PRD or notes that seed this project."
          }
          value={draft.brief ?? ""}
          onChange={(e) => patch({ brief: e.target.value })}
        />
      </div>

      {draft.source_git_url && (
        <p className="hint" style={{ marginTop: 4 }}>
          Seed source: <code>{draft.source_git_url}</code>. The working repositories are managed on
          the Artifacts tab (workspace settings).
        </p>
      )}
    </div>
  );
}

/** The sections of an open project. Lifted so the shell sidebar can BE the
 *  project's nav (the tab is stored on the shell, not inside ProjectScreen). */
type ProjTab = "overview" | "artifacts" | "analyze" | "people";
const PROJECT_TABS: { id: ProjTab; icon: string; label: string }[] = [
  { id: "overview", icon: "home", label: "Overview" },
  { id: "artifacts", icon: "file", label: "Artifacts" },
  { id: "analyze", icon: "scan", label: "Spec Quality" },
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
            Open Studio
          </button>
        </div>
      </div>
      <div className="proj-content">
        {tab === "overview" && (
          <>
            <ProjectProperties token={token} projectId={proj.id} />
            <WorkspaceDashboard token={token} ws={proj} embedded onBack={onBack} onOpenStudio={onOpenStudio} />
          </>
        )}
        {tab === "artifacts" && (
          <ArtifactsView token={token} workspace={proj} onOpenStudio={onOpenStudio} />
        )}
        {tab === "analyze" && <SpecQuality token={token} workspaceId={proj.id} />}
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
                  Open Studio
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
   *  already shows the name and carries "Open Studio", so the topbar would be
   *  a second copy of both. */
  embedded?: boolean;
}) {
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

  async function saveSettings(e: FormEvent) {
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
              Open Studio
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
              Open Studio
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

      <div className="card">
        <div className="card-head">
          <h2>Artifact map</h2>
        </div>
        <p className="hint">
          How this project's artifacts relate — the repository, its issues, pull requests and files,
          each a node read back from the knowledge graph. Click any node to inspect the metadata the
          graph stored for it; use “show more” to expand a category. Run Sync on the Artifacts tab to
          populate it. (Live work statuses are still planned.)
        </p>
        <ArtifactGraph token={token} />
      </div>

      <div className="card">
        <h2>Automation — trust ramp</h2>
        <p className="hint">
          The domain model's trust ramp, per project: <b>manual</b> = read-only insight,{" "}
          <b>recommendations</b> = prepared actions awaiting approval, <b>autonomous</b> = approved
          automation for the categories below. Stored as tenant metadata (GTS-validated).
        </p>
        {settings && (
          <form onSubmit={saveSettings}>
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
            {saved && <span className="hint" style={{ marginLeft: 10 }}>saved ✓</span>}
          </form>
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
    if (v && typeof v === "object" && "items" in v && Array.isArray((v as { items: unknown[] }).items))
      return String((v as { items: unknown[] }).items.length);
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
/** Artifacts — everything a project works on, in one place: repositories
 *  attached as sources (cloned into the IDE on launch) and files added by hand.
 *  Two honest halves: repository sources are real and addable today; manual
 *  file upload waits on the file-storage data-plane (not deployed here), so
 *  that list is read-only for now. */
function ArtifactsView({
  token,
  workspace,
  onOpenStudio,
}: {
  token: string;
  workspace: Workspace;
  onOpenStudio?: (ws: Workspace) => void;
}) {
  // Bumped after every successful sync so the ingested-artifacts viewer reloads.
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <>
      <h1>Artifacts</h1>
      <p className="subtitle">
        What this project works on — repositories attached as sources, plus files added by hand. A
        session clones these into the IDE when you open Studio.
      </p>
      <ProjectSources
        token={token}
        workspace={workspace}
        onOpenStudio={onOpenStudio}
        onSynced={() => setRefreshKey((k) => k + 1)}
      />
      <IngestedArtifacts token={token} refreshKey={refreshKey} />
      <ProjectFiles token={token} />
    </>
  );
}

/** The ingested-artifacts viewer: issues and pull requests pulled from the
 *  attached sources by the artifact-ingest gear and read back from the graph
 *  store. Reloads whenever `refreshKey` changes (i.e. after a Sync). */
function IngestedArtifacts({ token, refreshKey }: { token: string; refreshKey: number }) {
  const [nodes, setNodes] = useState<import("./api").ArtifactNode[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"issue" | "pull_request" | "file">("issue");

  const reload = useCallback(() => {
    setErr(null);
    api
      .listArtifactNodes(token)
      .then((r) => setNodes(r.nodes ?? []))
      .catch((e) => setErr(errText(e)));
  }, [token]);

  useEffect(() => {
    reload();
  }, [reload, refreshKey]);

  const issues = (nodes ?? []).filter((n) => n.type_id.includes("issue"));
  const prs = (nodes ?? []).filter((n) => n.type_id.includes("pull_request"));
  const files = (nodes ?? []).filter((n) => n.type_id.includes("file"));
  const rows = tab === "issue" ? issues : tab === "pull_request" ? prs : files;

  const emptyLabel =
    tab === "issue" ? "issues" : tab === "pull_request" ? "pull requests" : "files";

  return (
    <div className="card">
      <div className="card-head">
        <h2>Ingested{nodes ? ` · ${issues.length + prs.length + files.length}` : ""}</h2>
        <button className="ghost" onClick={reload}>
          Refresh
        </button>
      </div>
      <p className="hint">
        Issues, pull requests and repository files pulled from the attached sources by Sync. Stored
        in the graph as typed GTS nodes — this reads them back.
      </p>
      <div className="row" style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <button className={tab === "issue" ? "primary" : "ghost"} onClick={() => setTab("issue")}>
          Issues · {issues.length}
        </button>
        <button
          className={tab === "pull_request" ? "primary" : "ghost"}
          onClick={() => setTab("pull_request")}
        >
          Pull requests · {prs.length}
        </button>
        <button className={tab === "file" ? "primary" : "ghost"} onClick={() => setTab("file")}>
          Files · {files.length}
        </button>
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
          {files
            .slice()
            .sort((a, b) => (a.value.path ?? "").localeCompare(b.value.path ?? ""))
            .map((n) => {
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
                </li>
              );
            })}
        </ul>
      ) : (
        <ul className="rows">
          {rows
            .slice()
            .sort((a, b) => (b.value.number ?? 0) - (a.value.number ?? 0))
            .map((n) => {
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
    </div>
  );
}

/** The artifact relationship map for the Overview: reads the ingested nodes
 *  back from the graph and draws each repository with its issues, pull requests
 *  and files as a radial hub-and-spoke. Edges are derived from each node's
 *  `repo` reference — no extra endpoint needed. */
function ArtifactGraph({ token }: { token: string }) {
  const [nodes, setNodes] = useState<ArtifactNode[] | null>(null);
  const [edges, setEdges] = useState<ArtifactEdge[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const reload = useCallback(() => {
    setErr(null);
    api
      .listArtifactNodes(token)
      .then((r) => setNodes(r.nodes ?? []))
      .catch((e) => setErr(errText(e)));
    // Relations are best-effort: an older backend without the endpoint just
    // leaves the graph without cross-links rather than erroring the whole card.
    api
      .artifactEdges(token)
      .then((r) => setEdges(r.edges ?? []))
      .catch(() => setEdges([]));
  }, [token]);

  useEffect(() => {
    reload();
  }, [reload]);

  const repos = (nodes ?? []).filter((n) => n.type_id.includes("repo"));

  return (
    <>
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 8 }}>
        <button className="ghost" onClick={reload}>
          Refresh
        </button>
      </div>
      {err && <p className="error">{err}</p>}
      {nodes === null ? (
        <p className="empty">Loading graph…</p>
      ) : repos.length === 0 ? (
        <p className="empty">
          Nothing ingested yet — run Sync on a repository in the Artifacts tab to build the graph.
        </p>
      ) : (
        <>
          {repos.map((repo) => (
            <RepoGraph key={repo.instance_id} repo={repo} nodes={nodes!} edges={edges} />
          ))}
          <div
            style={{
              display: "flex",
              gap: 16,
              flexWrap: "wrap",
              marginTop: 8,
              fontSize: 12,
              color: "var(--muted, #9aa0a6)",
            }}
          >
            {[
              ["Repository", "#3b82f6"],
              ["Issue", "#10b981"],
              ["Pull request", "#8b5cf6"],
              ["File", "#f59e0b"],
            ].map(([label, color]) => (
              <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                <span
                  style={{ width: 10, height: 10, borderRadius: 10, background: color as string }}
                />
                {label}
              </span>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** One repository's radial graph: repo in the centre, three category hubs
 *  (Issues / Pull requests / Files) with counts, and a capped sample of items
 *  under each. */
const GRAPH_COLORS = { repo: "#3b82f6", issue: "#10b981", pr: "#8b5cf6", file: "#f59e0b" } as const;
type GraphKind = keyof typeof GRAPH_COLORS;

function nodeKind(n: ArtifactNode): GraphKind {
  if (n.type_id.includes("pull_request")) return "pr";
  if (n.type_id.includes("issue")) return "issue";
  if (n.type_id.includes("file")) return "file";
  return "repo";
}

function nodeLabel(n: ArtifactNode): string {
  const v = n.value;
  if (nodeKind(n) === "file") return String(v.path ?? "(file)");
  return `${v.number != null ? `#${v.number} ` : ""}${v.title ?? "(untitled)"}`;
}

const gtrunc = (s: string, n = 40) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** One repository's graph. The repo is the centre; three category hubs (Issues /
 *  Pull requests / Files) fan out; and every artifact is its OWN clickable node.
 *  Selecting a node opens an inspector with the full metadata the graph store
 *  holds for it. Each column is capped and grows with "show more" so a large
 *  repo stays legible. */
function RepoGraph({
  repo,
  nodes,
  edges,
}: {
  repo: ArtifactNode;
  nodes: ArtifactNode[];
  edges: ArtifactEdge[];
}) {
  const rid = repo.instance_id;
  const mine = (n: ArtifactNode) => n.value.repo === rid;
  const nodeById = new Map(nodes.map((n) => [n.instance_id, n]));
  const issues = nodes.filter((n) => n.type_id.includes("issue") && mine(n));
  const prs = nodes.filter((n) => n.type_id.includes("pull_request") && mine(n));
  const files = nodes.filter((n) => n.type_id.includes("file") && mine(n));

  const [selected, setSelected] = useState<ArtifactNode | null>(null);
  const [caps, setCaps] = useState<Record<GraphKind, number>>({ repo: 0, issue: 16, pr: 16, file: 16 });
  const bump = (k: GraphKind) => setCaps((c) => ({ ...c, [k]: c[k] + 24 }));

  const hubs = [
    { key: "issue" as GraphKind, label: "Issues", all: issues },
    { key: "pr" as GraphKind, label: "Pull requests", all: prs },
    { key: "file" as GraphKind, label: "Files", all: files },
  ].map((h) => ({ ...h, items: h.all.slice(0, caps[h.key]), color: GRAPH_COLORS[h.key] }));

  const W = 1180;
  const colCX = [110, 520, 900];
  const repoX = W / 2;
  const repoY = 40;
  const hubY = 116;
  const nodesTop = 178;
  const rowH = 22;
  const maxRows = Math.max(1, ...hubs.map((h) => h.items.length));
  const footerY = nodesTop + maxRows * rowH + 4;
  const H = footerY + 30;

  const isSel = (n: ArtifactNode) => selected?.instance_id === n.instance_id;

  return (
    <>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        role="img"
        style={{ maxWidth: "100%", background: "var(--bg, #0e1116)", borderRadius: 10 }}
      >
        {/* repo → hub edges */}
        {hubs.map((_, i) => (
          <line
            key={`e${i}`}
            x1={repoX}
            y1={repoY + 14}
            x2={colCX[i]}
            y2={hubY - 12}
            stroke="var(--border, #333)"
            strokeWidth={1.5}
          />
        ))}
        {/* hub spines */}
        {hubs.map((h, i) =>
          h.items.length > 0 ? (
            <line
              key={`sp${i}`}
              x1={colCX[i]}
              y1={hubY + 12}
              x2={colCX[i]}
              y2={nodesTop + (h.items.length - 1) * rowH}
              stroke="var(--border, #333)"
              strokeWidth={1}
              opacity={0.4}
            />
          ) : null,
        )}
        {/* repo node */}
        <circle
          cx={repoX}
          cy={repoY}
          r={13}
          fill={GRAPH_COLORS.repo}
          style={{ cursor: "pointer" }}
          onClick={() => setSelected(repo)}
        />
        {isSel(repo) && (
          <circle cx={repoX} cy={repoY} r={17} fill="none" stroke={GRAPH_COLORS.repo} strokeWidth={2} />
        )}
        <text x={repoX} y={repoY - 20} textAnchor="middle" fontSize={13} fontWeight={600} fill="var(--text, #e6e6e6)">
          {gtrunc(String(repo.value.full_path ?? "repository"), 60)}
        </text>
        {/* hubs + artifact nodes */}
        {hubs.map((h, i) => (
          <g key={`h${i}`}>
            <circle cx={colCX[i]} cy={hubY} r={10} fill={h.color} />
            <text x={colCX[i]} y={hubY - 16} textAnchor="middle" fontSize={12.5} fontWeight={600} fill="var(--text, #e6e6e6)">
              {h.label} · {h.all.length}
            </text>
            {h.items.map((n, j) => {
              const y = nodesTop + j * rowH;
              return (
                <g key={n.instance_id} style={{ cursor: "pointer" }} onClick={() => setSelected(n)}>
                  <circle cx={colCX[i]} cy={y} r={6} fill={h.color} opacity={isSel(n) ? 1 : 0.85} />
                  {isSel(n) && <circle cx={colCX[i]} cy={y} r={9} fill="none" stroke={h.color} strokeWidth={2} />}
                  <text
                    x={colCX[i] + 14}
                    y={y + 4}
                    textAnchor="start"
                    fontSize={11.5}
                    fill={isSel(n) ? "var(--text, #e6e6e6)" : "var(--muted, #9aa0a6)"}
                  >
                    {gtrunc(nodeLabel(n))}
                    <title>{nodeLabel(n)}</title>
                  </text>
                </g>
              );
            })}
            {h.all.length > h.items.length && (
              <text
                x={colCX[i]}
                y={nodesTop + h.items.length * rowH + 8}
                textAnchor="middle"
                fontSize={11}
                fill="var(--accent, #4c8bf5)"
                style={{ cursor: "pointer" }}
                onClick={() => bump(h.key)}
              >
                + show more ({h.all.length - h.items.length} left)
              </text>
            )}
          </g>
        ))}
      </svg>
      {selected && (
        <NodeInspector
          node={selected}
          edges={edges}
          nodeById={nodeById}
          onSelect={setSelected}
          onClose={() => setSelected(null)}
        />
      )}
    </>
  );
}

/** Full metadata for one graph node, straight from the payload the graph store
 *  returned — a labelled row per field, the body behind a disclosure, and a link
 *  out to the source when there is a url. */
/** A human label for a relation type, phrased from the selected node's side. */
function relText(typeId: string, outgoing: boolean): string {
  if (typeId.includes("authored_by")) return outgoing ? "Author" : "Authored";
  if (typeId.includes("modifies")) return outgoing ? "Modifies" : "Modified by";
  if (typeId.includes("artifact_of")) return outgoing ? "Belongs to" : "Artifacts";
  if (typeId.includes("contains")) return outgoing ? "Contains" : "In repository";
  return typeId;
}

function NodeInspector({
  node,
  edges,
  nodeById,
  onSelect,
  onClose,
}: {
  node: ArtifactNode;
  edges: ArtifactEdge[];
  nodeById: Map<string, ArtifactNode>;
  onSelect: (n: ArtifactNode) => void;
  onClose: () => void;
}) {
  const v = node.value;
  const kind = nodeKind(node);

  // Relations of this node, grouped by a human label. Endpoints resolve to the
  // nodes we hold; a capped node set means some targets may be unresolved (we
  // still show their id, just not clickable).
  const REL_CAP = 40;
  const relGroups = new Map<string, { id: string; node?: ArtifactNode }[]>();
  for (const e of edges) {
    const outgoing = e.from === node.instance_id;
    const incoming = e.to === node.instance_id;
    if (!outgoing && !incoming) continue;
    const otherId = outgoing ? e.to : e.from;
    const label = relText(e.type_id, outgoing);
    const arr = relGroups.get(label) ?? [];
    arr.push({ id: otherId, node: nodeById.get(otherId) });
    relGroups.set(label, arr);
  }
  const rows: [string, string][] = [];
  const add = (label: string, val: unknown) => {
    if (val == null || val === "") return;
    if (Array.isArray(val)) {
      if (val.length === 0) return;
      rows.push([label, val.join(", ")]);
    } else if (typeof val === "boolean") {
      rows.push([label, val ? "yes" : "no"]);
    } else {
      rows.push([label, String(val)]);
    }
  };
  add("Full path", v.full_path);
  add("Number", v.number);
  add("State", v.state);
  add("Author", v.author);
  add("Labels", v.labels);
  add("Source branch", v.source_branch);
  add("Target branch", v.target_branch);
  add("Merged", v.merged);
  add("Provider", v.provider);
  add("External id", v.external_id);
  add("Path", v.path);
  add("SHA", v.sha);
  add("Directory", v.is_dir);
  add("Size", v.size != null ? `${v.size} bytes` : undefined);
  add("Created", v.created_at);
  add("Updated", v.updated_at);
  const handled = new Set([
    "repo", "body", "text", "title", "number", "state", "author", "labels",
    "source_branch", "target_branch", "merged", "provider", "external_id",
    "path", "sha", "is_dir", "size", "created_at", "updated_at", "full_path", "url",
  ]);
  for (const [k, val] of Object.entries(v)) if (!handled.has(k)) add(k, val);

  const title =
    kind === "file"
      ? String(v.path ?? "(file)")
      : kind === "repo"
        ? String(v.full_path ?? "repository")
        : `${v.number != null ? `#${v.number} ` : ""}${v.title ?? "(untitled)"}`;
  const body = typeof v.body === "string" ? v.body : "";

  return (
    <div className="card" style={{ marginTop: 12 }}>
      <div className="card-head">
        <h3 style={{ margin: 0, display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 11, height: 11, borderRadius: 11, background: GRAPH_COLORS[kind], display: "inline-block" }} />
          {gtrunc(title, 80)}
        </h3>
        <button className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="sub" style={{ marginBottom: 10 }}>
        <code>{shortTypeName(node.type_id)}</code> · <code>{node.instance_id.slice(0, 12)}…</code>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "max-content 1fr", gap: "4px 16px" }}>
        {rows.map(([k, val]) => (
          <div key={k} style={{ display: "contents" }}>
            <span className="sub">{k}</span>
            <span style={{ wordBreak: "break-word" }}>{val}</span>
          </div>
        ))}
      </div>

      {relGroups.size > 0 && (
        <div style={{ marginTop: 12 }}>
          <div className="sub" style={{ marginBottom: 6 }}>
            Relations
          </div>
          {[...relGroups.entries()].map(([label, items]) => (
            <div key={label} style={{ marginBottom: 6 }}>
              <span className="sub" style={{ marginRight: 6 }}>
                {label} · {items.length}
              </span>
              <span className="chips">
                {items.slice(0, REL_CAP).map((it, idx) => {
                  const name = it.node ? gtrunc(nodeLabel(it.node), 36) : `${it.id.slice(0, 8)}…`;
                  return it.node ? (
                    <button
                      key={`${it.id}-${idx}`}
                      type="button"
                      className="chip"
                      title={it.node ? nodeLabel(it.node) : it.id}
                      onClick={() => it.node && onSelect(it.node)}
                    >
                      {name}
                    </button>
                  ) : (
                    <span key={`${it.id}-${idx}`} className="chip" title={it.id}>
                      {name}
                    </span>
                  );
                })}
                {items.length > REL_CAP && (
                  <span className="sub">+{items.length - REL_CAP} more</span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {v.url && (
        <p style={{ marginTop: 10 }}>
          <a href={String(v.url)} target="_blank" rel="noreferrer">
            Open on {String(v.provider ?? "source")} ↗
          </a>
        </p>
      )}
      {body && (
        <details style={{ marginTop: 10 }}>
          <summary className="sub">Body</summary>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12, marginTop: 8, maxHeight: 320, overflow: "auto" }}>
            {body.slice(0, 4000)}
            {body.length > 4000 ? "…" : ""}
          </pre>
        </details>
      )}
    </div>
  );
}

/** The manual-file half of Artifacts. file-storage is the platform blob store,
 *  but uploads go through its signed-URL data-plane sidecar, which this assembly
 *  does not run — so the list is read-only and "Add file" says why rather than
 *  offering a button that cannot finish. Per-project association arrives with
 *  the project-as-tenant work (phase 2). */
function ProjectFiles({ token }: { token: string }) {
  const [files, setFiles] = useState<import("./api").StoredFile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .files(token)
      .then((f) => setFiles(f.items ?? []))
      .catch((e) => setErr(errText(e)));
  }, [token]);

  const count = files?.length ?? 0;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Added by hand{count > 0 ? ` · ${count}` : ""}</h2>
        <button
          className="primary"
          disabled
          title="Uploads need the file-storage data-plane (signed-URL sidecar), which is not deployed in this environment yet"
        >
          Add file…
        </button>
      </div>
      <p className="hint">
        Manually added files for later processing. Upload needs the file-storage data-plane, which
        this environment does not run yet — the list is read-only for now and shows the platform
        file-storage until per-project files are wired.
      </p>
      {err && <p className="error">{err}</p>}
      {files === null ? (
        <p className="empty">Loading files…</p>
      ) : files.length === 0 ? (
        <p className="empty">No files yet — manual upload arrives with the file-storage data-plane.</p>
      ) : (
        <ul className="rows">
          {files.map((f) => (
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
  onOpenStudio,
  onSynced,
}: {
  token: string;
  workspace: Workspace;
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
        // Let the backend read this repo's checkout from the IDE workspace
        // (one shared clone) when the session has already materialized it.
        workspace_id: ws.id,
        repo_dir: r.target || r.name,
      });
      const deadline = Date.now() + 5 * 60 * 1000;
      for (;;) {
        await new Promise((res) => setTimeout(res, 1200));
        const t = await api.artifactSyncTask(token, task_id);
        if (t.status === "succeeded") {
          setSync((s) => ({
            ...s,
            [r.name]: `${t.issues} issues · ${t.pull_requests} PRs · ${t.files} files`,
          }));
          onSynced?.();
          break;
        }
        if (t.status === "failed") {
          setSync((s) => ({ ...s, [r.name]: t.message || "sync failed" }));
          break;
        }
        const phase = t.message || t.status;
        setSync((s) => ({ ...s, [r.name]: /…$/.test(phase) ? phase : `${phase}…` }));
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

  // No polling needed for opening: the space embeds the session URL right
  // away and the container-side splash keeps the frame alive until Theia
  // takes the port over.

  // "Open Studio" means open the Studio — launch as soon as the sources are
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
      const s = await api.createStudioSession(token, target.id, usable, freshRoot);
      setSession(s);
      // Straight into the embedded space — starting sessions show the
      // in-container splash until the IDE is up.
      onOpen({ id: s.id, url: s.url });
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
