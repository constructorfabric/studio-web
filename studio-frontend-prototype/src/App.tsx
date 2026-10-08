import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { VIEW_PATHS, pathToPlace, placeToPath, type KnownPlaces } from "./place-url";
import { URL_CHANGE_EVENT } from "./list-state";
import type { FormEvent, ReactNode } from "react";
import { env as runtimeEnv, idpConsoleUrl } from "./env";
import { errText, matches } from "./format";
// Screens that arrive when somebody asks for them — see ./lazy-screens for
// what is split and what deliberately is not.
import {
  ComponentsCatalog,
  ReportsScreen,
  DocumentTypesTab,
  DocumentsTab,
  DomainModelGraph,
  ViewsScreen,
  GtsEntitiesTable,
  IdentityDirectory,
  LazyScreens,
  ObjectTypes,
  ProcessCatalogTab,
  ProjectKits,
  SpecQuality,
} from "./lazy-screens";
import { ProjectsPortfolio } from "./projects";
import { ConnectorLogo } from "./connector-logos";
import { portfolioRollups, rollupText, type ProjectRollup } from "./rollups";
import {
  REVIEW_FILTERS,
  inReviewFilter,
  kindLine,
  lastUpdate,
  projectComparator,
  pullsCell,
  reviewOf,
  sortProjects,
  specsCell,
  teamText,
  type ReviewFilter,
} from "./project-rows";
import { DataTable, When, type PageRequest, type PageResult } from "./data-table";
import { PeopleView } from "./people";
import { OrgMembersView, OrganizationsTable } from "./org-admin";
import { BackgroundWork } from "./tasks";
import { WorkInbox, taskLabel, useCompletedWork, type CompletedRun } from "./work-inbox";
import { Notifications } from "./notifications";
import { StudioAI } from "./studio-ai";
import { runRepoSync, pruneDetached, findRepoNode, type SyncProgress } from "./artifact-sync";
import {
  hasRepository,
  projectRepoRows,
  supportsPullRequests,
  withPicked,
  withShareMode,
  without,
  type ProjectSource,
  type ShareMode,
} from "./project-sources";
import { ProjectOverview, type ProjTab } from "./project-overview";
import { makeZip } from "./zip";
import { GearsTable, PermissionsTable } from "./system-tables";
import {
  StudioBridgeProvider,
  useStudioBridge,
  type SavedDocument,
  type StudioBridge,
  type StudioDocumentRef,
  type StudioTarget,
} from "./studio-bridge";
import {
  ACCESS_MODELS,
  normalizeAccessConfig,
  privilegesByGroup,
  type AccessConfig,
  type AccessModel,
  type GrantDef,
} from "./access";
import {
  api,
  type RepoActivity,
  ApiError,
  PLATFORM_ROOT_TENANT_ID,
  UNAUTHENTICATED_EVENT,
  shortTypeName,
  TENANT_TYPES,
  normalizeStages,
  type Connection,
  type ConnectorProvider,
  type Me,
  type ProjectMode,
  type RemoteRepo,
  type RepoEntry,
  type StudioProfile,
  type StudioSession,
  type Tenant,
  type WorkspaceSettings,
  sessionOrigin,
  setCurrentOrganization,
  waitForStudioSessionReady,
  uploadProjectArtifact,
} from "./api";
import {
  Tile as VTile,
  ViewModePreferences,
  usePreference,
} from "./view-mode";

/** The person's theme and language, among their other preferences. */
const PREF_THEME = "app.theme";
const PREF_LANGUAGE = "app.language";
import { ActivityView } from "./activity-view";
import { PresenceNotes, WhoIsOnline, usePresence } from "./presence";
import { followRun } from "./studio-events";
import { runProvision, type ProvisionStep, type StepState } from "./provision";
import { gearParentDir, gearSlug } from "./scaffold";
import { productIdFrom } from "./product";
import { PortalNavProvider, type PortalNav } from "./portal-nav";
import { MyPersonCard, PersonPhoto } from "./people-profile";
import { orgPeople } from "./org-people";
import {
  BookIcon,
  CheckIcon,
  CloseIcon,
  GearIcon,
  GridIcon,
  LayersIcon,
  MenuIcon,
  RefreshIcon,
  ShieldIcon,
  SlidersIcon,
  SparkleIcon,
} from "./icons";
import { isPinned, loadPins, pinKey, savePins, togglePin, type Pin } from "./pins";
import {
  clampStep,
  createFormLayout,
  createSteps,
  pluginBlocker,
  stepBlocker,
  type RepoMode,
} from "./project-form";

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
/* The type itself now lives in ./studio-bridge, next to the hand-off contract
   that consumes it, so a view can take a target without importing the shell. */

/** One postMessage frame on the portal → IDE channel. `type` is always a
 *  `studio.*` name the IDE's portal-bridge knows; the rest is the payload for
 *  that name. Deliberately loose — the bridge transports, `studio-bridge`
 *  defines the typed calls that produce these. */
type BridgeMessage = { type: string } & Record<string, unknown>;

/** What the hand-off has to say for itself while a session comes up. */
type HandoffState =
  | { kind: "opening"; name: string; targetId: string }
  | { kind: "ready"; name: string; targetId: string }
  | { kind: "error"; name: string; error: string };

/** The product's mark, served from public/. Built through BASE_URL rather than
 *  written as "/constructor-symbol.svg": vite is configured with `base: "./"`
 *  precisely because this bundle is also mounted under `/prototype/` (see
 *  nginx.conf), and an absolute path would 404 there while working fine at the
 *  root.
 *
 *  The VECTOR symbol, taken from the deployed portal (/brand/constructor-symbol-
 *  vector.svg), not the old 79KB favicon.png. The mark is a gradient fabric knot
 *  that is drawn at 18px in the rail and at 44px on the sign-in screen; the
 *  raster was authored for a browser tab and visibly mushed at both. favicon.png
 *  stays in public/ for now — nothing references it, but the deploy's nginx
 *  config may still be asked for it. */
const PRODUCT_MARK = `${import.meta.env.BASE_URL}constructor-symbol.svg`;

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

/** The sections whose list owns its search, filters and sort, above it and in
 *  the address (docs/list-standard.md). The side panel has nothing for them,
 *  and says where the controls went rather than showing ones nothing reads. */
const LISTS_WITH_OWN_FILTERS: ReadonlySet<PanelView> = new Set<PanelView>([
  "projects",
  "people",
  "connectors",
  "tasks",
  "gears",
  "chats",
  "files",
]);

function activeFilterCount(view: PanelView, f: Filters): number {
  if (LISTS_WITH_OWN_FILTERS.has(view)) return 0;
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
  /** The one pending renewal timer. Every successful renewal schedules the
   *  next, and a 401 renews too — without replacing the timer, a busy session
   *  accumulates one more of them every time, all firing forever. */
  const renewTimer = useRef<number | undefined>(undefined);

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
      window.clearTimeout(renewTimer.current);
      renewTimer.current = window.setTimeout(
        () => void renew(),
        Math.max(30, session.expiresIn - 60) * 1000,
      );
      return true;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => () => window.clearTimeout(renewTimer.current), []);

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
    // Wrapped at the top so one read of the gear serves every list below, and
    // so a choice made on one screen is already in hand when another mounts.
    <ViewModePreferences token={token}>
    <Shell
      token={token}
      me={me}
      onLogout={() => {
        setToken(null);
        setMe(null);
        forgetPlace();
        // Ends the Keycloak session too (RP-initiated logout) — otherwise
        // the SSO cookie silently signs the same user back in and there is
        // no way to switch accounts. Static-token logins clear locally.
        void import("./oidc").then(({ endSsoSession }) => endSsoSession());
      }}
    />
    </ViewModePreferences>
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
    // The deployed sign-in screen's two panes: the story on a dark-to-blue
    // gradient, and a white card of a fixed 480x640 beside it. Taken from the
    // portal's own first-paint skeleton (the .initial-auth-* block inlined in
    // its index.html), so the proportions are the product's rather than a
    // reading of a screenshot.
    <div className="auth-shell">
      <section className="auth-story">
        <div>
          <p className="auth-brand">Constructor Studio</p>
          <div className="auth-rule" />
          <h1 className="auth-title">
            From requirements
            <br />
            to production.
          </h1>
          <p className="auth-copy">
            Let’s AI define, build, and run software end to end — with reusable components,
            operational automation, and built-in productivity measurement and insights.
          </p>
        </div>
      </section>

      <section className="auth-panel-wrap">
        <div className="auth-panel">
          <p className="auth-kicker">Welcome back</p>
          <h2 className="auth-heading">Sign in to Constructor Studio</h2>
          <p className="auth-panel-copy">
            Use your work account to continue across the full software development lifecycle.
          </p>

          {/* The product puts an e-mail and a password here, above the SSO
              button. This portal has no password of its own — every sign-in is
              a redirect to Keycloak — so the slot carries the real primary
              action instead of two inputs that would look like a credential
              form and accept nothing. Drawing a dead password field on a sign-in
              screen is worse than not matching the mock: people type real
              passwords into fields that look like this one. */}
          <button className="primary auth-submit" disabled={busy} onClick={() => void sso()}>
            {busy ? "Signing in…" : "Continue with Constructor ID"}
          </button>

          <div className="auth-divider" />

          {/* Where the product shows Google, we show GitHub — it is the identity
              our people actually carry, and the one the access-pending screen
              already names ("Your GitHub sign-in succeeded"). Routed through
              Keycloak by kc_idp_hint, so it works once the matching Identity
              Provider exists in the realm and falls back to Keycloak's own form
              until then. */}
          <button
            className="auth-provider"
            title="GitHub (via Keycloak identity federation)"
            disabled={busy}
            onClick={() => void sso("github")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.9 10.9c.6.1.8-.2.8-.5v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.7 1.3 3.4 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.4-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0C19.3 4.7 20.3 5 20.3 5c.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.6.8.5A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5z"/></svg>
            Continue with GitHub
          </button>

          {/* Google and Microsoft still federate; they are kept as a quiet row
              rather than deleted, because removing a working way in to match a
              layout costs somebody their account. */}
          <div className="auth-more">
            <button title="Google (via Keycloak identity federation)" disabled={busy} onClick={() => void sso("google")}>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="#4285F4" d="M23.5 12.3c0-.9-.1-1.5-.3-2.2H12v4.1h6.5c-.1 1.1-.8 2.7-2.4 3.8l3.7 2.9c2.3-2.1 3.7-5.1 3.7-8.6z"/><path fill="#34A853" d="M12 24c3.2 0 5.9-1.1 7.9-2.9l-3.7-2.9c-1 .7-2.4 1.2-4.2 1.2-3.1 0-5.8-2.1-6.7-5l-3.9 3C3.3 21.3 7.3 24 12 24z"/><path fill="#FBBC05" d="M5.3 14.4a7.4 7.4 0 0 1 0-4.7l-3.9-3a12 12 0 0 0 0 10.7l3.9-3z"/><path fill="#EA4335" d="M12 4.7c1.8 0 3 .8 3.7 1.4l3.3-3.2C17.9 1.1 15.2 0 12 0 7.3 0 3.3 2.7 1.4 6.7l3.9 3c.9-2.9 3.6-5 6.7-5z"/></svg>
              Google
            </button>
            <button title="Microsoft (via Keycloak identity federation)" disabled={busy} onClick={() => void sso("microsoft")}>
              <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><rect x="1" y="1" width="10" height="10" fill="#F25022"/><rect x="13" y="1" width="10" height="10" fill="#7FBA00"/><rect x="1" y="13" width="10" height="10" fill="#00A4EF"/><rect x="13" y="13" width="10" height="10" fill="#FFB900"/></svg>
              Microsoft
            </button>
          </div>

          {error && <div className="error auth-error">{error}</div>}
        </div>
      </section>
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
  | "reports"
  | "objects"
  | "views"
  | "tasks"
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
    // lucide `activity` and `clock-3`, the two the shipped project-sidebar uses
    // for those sections.
    activity: <path d="M3 12h4l3 8 4-16 3 8h4" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5h4" />
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
  /** Drawn only inside the "+" picker: pinnable, but not a group of its own. */
  hidden?: boolean;
  items: { id: View; icon: string; label: string }[];
}[] = [
  {
    // Was a group called WORK, holding these three. That was not a category so
    // much as what concept v2 left over after everything else moved onto a
    // project, and three unrelated destinations under a heading claiming they
    // belong together is a heading that has stopped meaning anything.
    //
    // The slot is the rail's most valuable one, so it holds what this person
    // always needs instead (see pins.ts). These three stay the defaults, so
    // nothing moves on first use, and they remain here as the list the "+"
    // picker offers — unpinning one must not put it out of reach.
    title: "Organization",
    hidden: true,
    items: [
      { id: "projects", icon: "grid", label: "Workspaces" },
      { id: "people", icon: "users", label: "People" },
      // Shared connector catalogue. It is owned by the hidden organization —
      // which is exactly why it sits here and not inside one project: every
      // project of the org inherits it. Labelled "Connections" to match the
      // sidebar in the product mockups.
      { id: "connectors", icon: "plug", label: "Connections" },
      // Chats and Files are hidden: neither is a surface of the organization.
      // A chat is had inside a project and a file is an artifact of one, so an
      // org-wide list of either is a flat, contextless feed sitting one click
      // from the top of the product. The views and their routes are kept
      // (`view === "chats"`, `view === "files"`), so putting an entry back here
      // is the whole of un-hiding them.
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
      // Every report the Studio draws, configured once for the organization
      // (studio-reports): the roadmap workbook is the first.
      { id: "reports", icon: "activity", label: "Reports" },
      // The type catalogue the line above is a view of. Which types are
      // components is a judgement this organization makes here, not a constant
      // in a gear — so the two surfaces sit next to each other.
      { id: "objects", icon: "grid", label: "Objects" },
      // Lists of the domain model's objects that people define and save as
      // data (views.tsx): a new one is not a release.
      { id: "views", icon: "grid", label: "Views" },
      // What the deployment is doing in the background, and what fires on its
      // own: studio-tasks runs plus studio-scheduler schedules.
      { id: "tasks", icon: "scan", label: "Background work" },
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
        <img className="logo login-logo" src={PRODUCT_MARK} alt="" />
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

/** Where the person was, as little of it as restores the screen.
 *
 *  Ids and enum tags only — no fetched records. Anything else would be a cache
 *  with no way to tell when it went stale, and every one of these is re-read
 *  from the backend on the way back in. */
interface Place {
  view: View;
  crumb: Crumb;
  projectTab: ProjTab;
  workspaceTab: WorkspaceTab;
  projectLabel?: string;
  activeOrgId: string | null;
  adminOpen: boolean;
  adminView: AdminView;
}

const PLACE_KEY = "studio.place";
const SPACES_KEY = "studio.spaces";

/** Forget where the last person was.
 *
 *  Signing out has to, or the next sign-in on this tab opens somebody else's
 *  project — the names of their organization and workspace included, drawn
 *  from storage before a single call is authorized. */
function forgetPlace(): void {
  try {
    sessionStorage.removeItem(PLACE_KEY);
    sessionStorage.removeItem(SPACES_KEY);
  } catch {
    /* nothing readable to forget */
  }
}

/** Read the stored place, or nothing at all.
 *
 *  Every field is checked because this is storage the user can edit and a
 *  previous version of the app wrote: a `view` that no longer exists would
 *  render an empty shell with no way back, which is worse than starting at
 *  the default. */
/** Every section has an address; a View without one fails to compile here. */
VIEW_PATHS satisfies Record<View, string>;

/** What an address may name, from the lists the screens draw their tabs from. */
function knownPlaces(): KnownPlaces {
  return {
    projectTabs: PROJECT_TABS.map((t) => t.id),
    workspaceTabs: WORKSPACE_TABS.map((t) => t.id),
    adminViews: [...ADMIN_NAV, ...PLATFORM_NAV].map((t) => t.id),
  };
}

/** The place the address names (place-url.ts), cast to the shell's types it was checked against. */
function placeFromUrl(): Partial<Place> | undefined {
  return pathToPlace(window.location.pathname, window.location.search, knownPlaces()) as Partial<Place> | undefined;
}

function readPlace(): Partial<Place> {
  try {
    const raw = sessionStorage.getItem(PLACE_KEY);
    if (!raw) return {};
    const saved = JSON.parse(raw) as Partial<Place>;
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    return {};
  }
}

function Shell({ token, me, onLogout }: { token: string; me: Me; onLogout: () => void }) {
  // Restored once, as the initial state: setting it from an effect afterwards
  // would flash the default screen first and fight any navigation the person
  // made in between.
  // The address wins over the tab's memory: a link someone followed names the
  // place they meant, and the stored one is only where this tab last was.
  const restoredPlace = useRef<Partial<Place>>({ ...readPlace(), ...placeFromUrl() }).current;
  const [view, setView] = useState<View>(restoredPlace.view ?? "projects");
  /** A component page the platform catalogue should open on, asked for from
   *  elsewhere (a project's product). Stamped, so asking twice reopens it. */
  const [componentFocus, setComponentFocus] = useState<{ name: string; at: number } | null>(null);
  const portalNav = useMemo<PortalNav>(
    () => ({
      openComponent: (name: string) => {
        setComponentFocus({ name, at: Date.now() });
        setView("gears");
      },
    }),
    [],
  );
  /** Position in the project → nested project drill-down. Two levels, one noun. */
  const [crumb, setCrumb] = useState<Crumb>(restoredPlace.crumb ?? {});
  /** Name of the opened nested project, kept for the crumb: the record is not
   *  in any list the shell holds, and refetching it for a label would be silly. */
  const [projectLabel, setProjectLabel] = useState<string | undefined>(restoredPlace.projectLabel);
  // The open project's active tab. Lifted here so the sidebar is the project's
  // nav (see the PROJECT section below); opening a different project resets it.
  const [projectTab, setProjectTab] = useState<ProjTab>(restoredPlace.projectTab ?? "overview");
  /** The open workspace's section. Lives here beside projectTab and for the
   *  same reason: the band that switches it is chrome above the work area, not
   *  part of the screen it switches. */
  const [workspaceTab, setWorkspaceTab] = useState<WorkspaceTab>(
    restoredPlace.workspaceTab ?? "projects",
  );
  // Opening a different project starts on its Overview — but a reload is not
  // "opening a different project", and resetting there would undo the restore
  // on the very first render.
  const tabbedProject = useRef(restoredPlace.crumb?.nestedId);
  useEffect(() => {
    if (tabbedProject.current === crumb.nestedId) return;
    tabbedProject.current = crumb.nestedId;
    setProjectTab("overview");
  }, [crumb.nestedId]);
  // And a different workspace starts on its Projects, for the same reason: the
  // section you left on the last one says nothing about this one, and landing
  // in a type editor belonging to a workspace you have only just opened reads
  // as the app having lost your place.
  // Not on the first render, nor on a Back/Forward that names the tab: a
  // reload or a link restoring /workspaces/{id}/types is not "opening a
  // different workspace", and resetting there undid the restore.
  const tabbedWorkspace = useRef(restoredPlace.crumb?.projectId);
  useEffect(() => {
    if (tabbedWorkspace.current === crumb.projectId) return;
    tabbedWorkspace.current = crumb.projectId;
    setWorkspaceTab("projects");
  }, [crumb.projectId]);
  const [accountMenu, setAccountMenu] = useState(false);
  // Active organization — the top context, now that the level above projects is
  // back. Lifted to the shell so the sidebar switcher (where "Home" used to be)
  // and the portfolio share one selection. null = "resolve a sensible default".
  const [activeOrgId, setActiveOrgId] = useState<string | null>(restoredPlace.activeOrgId ?? null);
  // Admin area (console pattern): a separate mode with its own sidebar for
  // organizations / members / workspaces administration.
  const [adminOpen, setAdminOpen] = useState(restoredPlace.adminOpen ?? false);
  const [adminView, setAdminView] = useState<AdminView>(restoredPlace.adminView ?? "people");
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
    setMenuOpen(false);
  };
  /** Whether the navigation rail is PINNED open. Not "is it visible" — the rail
   *  is always visible and opens on hover; this is only the latch that keeps it
   *  open once the pointer leaves. Unpinned is the resting state. */
  const [productMenu, setProductMenu] = useState(false);
  // What sits above PLATFORM in the rail. Persisted per browser; see pins.ts
  // for why the group it replaced had stopped meaning anything.
  const [pins, setPins] = useState<Pin[]>(() => loadPins());
  const [pinPicker, setPinPicker] = useState(false);
  const setPinned = (next: Pin[]) => {
    setPins(next);
    savePins(next);
  };
  const [menuOpen, setMenuOpen] = useState(false);
  /** Whether the Studio AI dock is open (368px) rather than railed (48px).
   *  Owned here because the shell grid sizes the track — see .shell-body. */
  const [aiOpen, setAiOpen] = useState(false);
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
    // The bridge dies with the frame: drop its readiness and anything still
    // queued for it, so a later space with the same id re-handshakes instead
    // of posting into a window that is gone.
    bridgeReadyRef.current.delete(wsId);
    delete bridgeQueueRef.current[wsId];
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

  // URL ← state: the open IDE space when there is one, else the portal place
  // (place-url.ts). Pushed, so Back returns to where the person was; a change
  // that came FROM the address (Back/Forward) is not pushed again.
  // The first write and one after Back/Forward only REPLACE: pushing there
  // would add an entry for the same place, and at an address that names none
  // (the root) Back would land on it and be pushed forward again, forever.
  const fromHistoryRef = useRef(true);
  useEffect(() => {
    const path = activeSpace
      ? `/space/${activeSpace}`
      : placeToPath({ view, crumb, projectTab, workspaceTab, activeOrgId, adminOpen, adminView });
    const replace = fromHistoryRef.current;
    fromHistoryRef.current = false;
    // The same place is compared by path and organization only: the rest of
    // the query string is the list on screen (list-state.ts), and rewriting
    // it here would drop a shared link's search before the list read it.
    const target = new URL(path, window.location.origin);
    const here = new URLSearchParams(window.location.search);
    if (window.location.pathname === target.pathname && here.get("org") === target.searchParams.get("org")) return;
    if (replace) window.history.replaceState(null, "", path);
    else window.history.pushState(null, "", path);
    window.dispatchEvent(new Event(URL_CHANGE_EVENT));
  }, [activeSpace, view, crumb, projectTab, workspaceTab, activeOrgId, adminOpen, adminView]);

  // Remember where the person is, so a reload puts them back rather than at
  // the default screen. Per-tab on purpose: two tabs are two places, and the
  // login session (localStorage) deliberately outlives both.
  useEffect(() => {
    const place: Place = {
      view,
      crumb,
      projectTab,
      workspaceTab,
      projectLabel,
      activeOrgId,
      adminOpen,
      adminView,
    };
    try {
      sessionStorage.setItem(PLACE_KEY, JSON.stringify(place));
    } catch {
      /* private mode etc. — the screen just opens at the default next time */
    }
  }, [view, crumb, projectTab, workspaceTab, projectLabel, activeOrgId, adminOpen, adminView]);

  useEffect(() => {
    try {
      sessionStorage.setItem(
        SPACES_KEY,
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
      fromHistoryRef.current = true;
      setActiveSpace(m ? m[1] : null);
      if (m) return;
      const place = placeFromUrl();
      if (!place) return;
      // The tab resets above answer "opened something else"; this is going
      // back to a place, tab included, so they are told it is not new.
      tabbedProject.current = place.crumb?.nestedId;
      tabbedWorkspace.current = place.crumb?.projectId;
      if (place.view) setView(place.view);
      if (place.crumb) setCrumb(place.crumb);
      if (place.projectTab) setProjectTab(place.projectTab);
      if (place.workspaceTab) setWorkspaceTab(place.workspaceTab);
      if (place.adminOpen !== undefined) setAdminOpen(place.adminOpen);
      if (place.adminView) setAdminView(place.adminView);
      if (place.activeOrgId !== undefined) setActiveOrgId(place.activeOrgId);
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
        const raw = JSON.parse(sessionStorage.getItem(SPACES_KEY) ?? "[]") as unknown[];
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

  /* ── One-gesture editing hand-off (contract in ./studio-bridge) ──
     A view asks for a document/file/graph in the IDE; this reuses or launches
     the session, mounts its space and delivers the message. Messages posted
     before the IDE's bridge has answered the handshake are QUEUED PER SPACE
     and flushed on its first `studio.*` reply — a plain postMessage into a
     booting iframe is dropped, which is why opening the IDE used to have to be
     a separate, earlier click.

     This replaces the single module-scoped `pendingEditorOpen` slot: one queue
     per space rather than one path per tab, so two spaces can be handed a file
     each, and so the queue can carry a document or the graph and not only a
     repository path. */
  const spacesRef = useRef(spaces);
  spacesRef.current = spaces;
  const activeSpaceRef = useRef(activeSpace);
  activeSpaceRef.current = activeSpace;
  const bridgeReadyRef = useRef<Set<string>>(new Set());
  const bridgeQueueRef = useRef<Record<string, BridgeMessage[]>>({});
  const [opening, setOpening] = useState<string | null>(null);
  const [handoff, setHandoff] = useState<HandoffState | null>(null);
  /** Set when the person dismissed the wait: the session still comes up and
   *  still gets the message, it just stops stealing the screen when it does. */
  const handoffDismissedRef = useRef(false);
  const [savedDocument, setSavedDocument] = useState<SavedDocument | null>(null);

  const postToFrame = useCallback((wsId: string, msg: BridgeMessage): boolean => {
    const frame = Array.from(
      document.querySelectorAll<HTMLIFrameElement>("iframe.space-frame"),
    ).find((f) => f.dataset.ws === wsId);
    const origin = frame?.dataset.origin;
    if (!frame || !origin) return false;
    frame.contentWindow?.postMessage(msg, origin);
    return true;
  }, []);

  const postToSpace = useCallback(
    (wsId: string, msg: BridgeMessage) => {
      if (bridgeReadyRef.current.has(wsId) && postToFrame(wsId, msg)) return;
      const queue = bridgeQueueRef.current;
      queue[wsId] = [...(queue[wsId] ?? []), msg];
    },
    [postToFrame],
  );

  const flushSpaceQueue = useCallback(
    (wsId: string) => {
      const queued = bridgeQueueRef.current[wsId];
      if (!queued?.length) return;
      delete bridgeQueueRef.current[wsId];
      for (const msg of queued) postToFrame(wsId, msg);
    },
    [postToFrame],
  );

  /* Sessions started ahead of a click, by target, with when. Opening a
     project is the moment someone is most likely to open one of its documents
     next, and a session takes seconds to come up — a minute on a node that
     has not pulled the image yet. Starting it then, in the background, leaves
     the click only Theia's own frontend to wait for. A session nobody opens
     is stopped by the backend once no browser has had it for
     `idle_session_secs`, so this costs a Pod for minutes, not hours.

     Once per target per PREWARM_EVERY_MS: moving between a project's tabs
     remounts the screen, and each remount asking again would be noise. */
  const prewarmedRef = useRef<Map<string, number>>(new Map());
  const prewarm = useCallback(
    (target: StudioTarget) => {
      // Any mounted space already answers a document click (openDocument
      // reuses whichever session is open), so one more Pod would buy nothing.
      if (spacesRef.current.length > 0) return;
      const at = prewarmedRef.current.get(target.id);
      if (at !== undefined && Date.now() - at < PREWARM_EVERY_MS) return;
      prewarmedRef.current.set(target.id, Date.now());
      // Creation is idempotent per workspace, so a click arriving while this
      // is in flight gets the same session rather than a second one.
      startStudioSession(token, target).catch(() => {
        prewarmedRef.current.delete(target.id);
      });
    },
    [token],
  );

  const openInStudio = useCallback(
    async (target: StudioTarget, msg: BridgeMessage, reuseAnySpace = false) => {
      // Already mounted: no wait to report at all, and switching never reloads
      // Theia. This is the common case once a session is up, and it has to stay
      // free of any "opening…" flicker.
      //
      // `reuseAnySpace` widens that to a session opened against something else.
      // Only a DOCUMENT may do this: it is read and written through the gear by
      // (workspace, id), so any running IDE can edit it. A repository file
      // cannot — it exists in one checkout, and only that session has it.
      const mounted =
        spacesRef.current.find((s) => s.wsId === target.id) ??
        (reuseAnySpace
          ? spacesRef.current.find((s) => s.wsId === activeSpaceRef.current) ??
            spacesRef.current[spacesRef.current.length - 1]
          : undefined);
      if (mounted) {
        setActiveSpace(mounted.wsId);
        postToSpace(mounted.wsId, msg);
        return;
      }
      handoffDismissedRef.current = false;
      setHandoff({ kind: "opening", name: target.name, targetId: target.id });
      setOpening(target.id);
      try {
        const ready = await startStudioSession(token, target);
        // Mount either way — the frame boots Theia and takes the message while
        // the person carries on. It only takes the screen if they are still
        // waiting for it.
        const dismissed = handoffDismissedRef.current;
        openSpace(target, { id: ready.id, url: ready.url }, !dismissed);
        postToSpace(target.id, msg);
        setHandoff(
          dismissed ? { kind: "ready", name: target.name, targetId: target.id } : null,
        );
      } catch (e) {
        setHandoff({ kind: "error", name: target.name, error: errText(e) });
      } finally {
        setOpening(null);
      }
    },
    [token, openSpace, postToSpace],
  );

  const studioBridge = useMemo<StudioBridge>(
    () => ({
      openDocument: (target: StudioTarget, doc: StudioDocumentRef) =>
        openInStudio(
          target,
          {
            type: "studio.openDocument",
            // The documents gear stores rows under the workspace tenant, while
            // a space can be keyed by a project — the two ids differ, so both
            // have to travel.
            workspaceId: doc.workspaceId,
            documentId: doc.id,
            title: doc.title,
          },
          // A session the person already has open beats waiting a minute for
          // one of this target's own, and the document reads the same in either.
          true,
        ),
      openFile: (target: StudioTarget, path: string) =>
        openInStudio(target, { type: "studio.openInEditor", path }),
      // A product opens as its file: the Gearbox perspective it used to ask
      // for is the desktop's, and a portal session has no engine behind it.
      // The branch it was saved on is not brought in beside the checkout.
      openProduct: (target: StudioTarget, path: string) =>
        openInStudio(target, { type: "studio.openInEditor", path }),
      openGraph: (target: StudioTarget) => openInStudio(target, { type: "studio.openGraph" }),
      prewarm,
      opening,
      isOpen: (targetId: string) => spacesRef.current.some((s) => s.wsId === targetId),
      savedDocument,
    }),
    [openInStudio, prewarm, opening, savedDocument],
  );

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const sp = spaces.find((s) => spaceOrigin(s.url) === e.origin);
      if (!sp) return; // only embedded sessions are trusted senders
      const d = e.data as {
        type?: string;
        dirty?: number;
        workspaceId?: string;
        documentId?: string;
        name?: string;
      };
      if (typeof d?.type === "string" && d.type.startsWith("studio.")) {
        stopInitRetry(sp.wsId); // the bridge is alive — handshake done
        // …and anything a view asked for while it was booting can go now.
        bridgeReadyRef.current.add(sp.wsId);
        flushSpaceQueue(sp.wsId);
      }
      if (
        d?.type === "studio.documentSaved" &&
        typeof d.workspaceId === "string" &&
        typeof d.documentId === "string"
      ) {
        // The IDE wrote a portal document back through the documents gear —
        // the Documents view re-reads it (content, status, conformance) rather
        // than showing the copy it had before the hand-off.
        setSavedDocument({
          workspaceId: d.workspaceId,
          documentId: d.documentId,
          at: Date.now(),
        });
      }
      if (d?.type === "studio.openComponent" && typeof d.name === "string" && d.name) {
        // A gear in the IDE asked for its catalogue page (the Gearbox Inspector's
        // link): leave the space for the catalogue, open on that component. The
        // session stays mounted, so going back to it is a switch, not a reload.
        setActiveSpace(null);
        portalNav.openComponent(d.name);
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
  }, [spaces, flushSpaceQueue, spaceOrigin, stopInitRetry, portalNav]);

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

  /* ── What finished ──
     One source, two destinations. The channel says a background run ended; the
     bell in the bar is where a person notices it, and any session they have
     open is told the same thing through the bridge — the IDE is a place they
     may be looking at instead of the portal, and it is inside this very page. */
  const [inboxOpen, setInboxOpen] = useState(false);
  const tellOpenSessions = useCallback(
    (run: CompletedRun) => {
      for (const space of spacesRef.current) {
        postToSpace(space.wsId, {
          type: "studio.notify",
          level: run.state === "succeeded" ? "info" : "warn",
          source: taskLabel(run.taskType),
          message:
            run.state === "succeeded"
              ? "finished"
              : run.state === "failed"
                ? "failed"
                : "was cancelled",
          detail: run.line,
        });
      }
    },
    [postToSpace],
  );
  const completed = useCompletedWork(token, tellOpenSessions);

  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);
  const [componentCategories, setComponentCategories] = useState<string[]>([]);
  /** The filter panel, opened from the funnel in the top bar. Same reasoning
   *  as the drawer: it is an overlay now, so it opens closed and the old
   *  "studio.filterPanel" preference is not read — remembering "open" would
   *  put a panel over the content on every load. */
  const [panelOpen, setPanelOpen] = useState(false);

  // The saved theme applies on login, not on the first visit to Profile —
  // ProfileView only edits it. It is one of the person's preferences
  // (`usePreference`), so it arrives with the rest of them.
  const [savedTheme] = usePreference(PREF_THEME);

  // The photo comes from the Studio person, not the token: a token carries
  // a name but no picture. Profile updates it when the person changes it.
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .myProfile(token)
      .then((p) => live && setAvatarUrl(p.avatar_url ?? null))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [token]);
  useEffect(() => {
    if (savedTheme) document.documentElement.dataset.theme = savedTheme;
  }, [savedTheme]);

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
  // Say we are here, and pick up anything left for us. `view` is the label
  // other people see in the admin list, and the crumb's project name is the
  // detail — "specs" alone answers less than "specs · Studioweb".
  const presence = usePresence(
    token,
    userName,
    view,
    workspaces.find((w) => w.id === crumb.projectId)?.name,
  );

  /** Where this deployment's identity provider keeps its console, or nothing
   *  when it has not said. */
  const idpConsole = useMemo(() => idpConsoleUrl(), []);

  /* Who the IDE should attribute this person's writing to.
   *
   * The session container is shared by everyone who opens the same workspace,
   * and the IDE has no login of its own, so the portal is the only side that
   * knows who is at the keyboard. Without this the IDE falls back to a name
   * typed into a text field and kept in that browser's storage.
   *
   * `sub` is the subject id, not the display name: it survives a rename, and
   * it is what the comment and change logs are partitioned by on disk. */
  const viewer = useMemo(
    // The address rides along because the IDE commits as this person: git
    // refuses a commit without one, and the session's fallback is a shared
    // "Constructor Studio" that attributes everybody's work to nobody.
    () => ({ sub: me.subject_id, name: userName, email: userEmail ?? undefined, kind: "person" }),
    [me.subject_id, userName, userEmail],
  );
  /* Read by the studio.init retry, for tokenRef's reason: that timer keeps
     firing the closure it was created with for up to five minutes, and the
     display name can resolve inside that window. */
  const viewerRef = useRef(viewer);
  viewerRef.current = viewer;

  useEffect(() => {
    // Silent renew: hand the fresh token — and the person it belongs to — to
    // every mounted space. The viewer rides along rather than going out on a
    // message of its own because the two answer the same question for the
    // IDE (who is calling), and a renew is exactly when the answer can change.
    document.querySelectorAll<HTMLIFrameElement>("iframe.space-frame").forEach((f) => {
      const origin = f.dataset.origin;
      if (origin) {
        f.contentWindow?.postMessage({ type: "studio.token", apiToken: token, viewer }, origin);
      }
    });
  }, [token, viewer]);

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
  // Set during render, not in an effect: children's effects run before this
  // component's, and their first catalogue or report fetch must already name
  // the organization. Assigning the same id again is a no-op.
  setCurrentOrganization(orgAsSpace?.id);

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
  /** A workspace is open when one is picked and no project inside it is. The
   *  two are mutually exclusive, so exactly one band ever shows. */
  const workspaceOpen =
    !adminOpen && !activeSpace && view === "projects" && !!crumb.projectId && !crumb.nestedId;

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
            const kids = await api.tenantChildrenAll(token, org.id);
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
    api.tenantChildrenAll(token, crumb.projectId).then(
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
    <StudioBridgeProvider value={studioBridge}>
    <PortalNavProvider value={portalNav}>
    <div className="shell">
      <PresenceNotes messages={presence.messages} onDismiss={presence.dismiss} />
      {/* The only chrome in the flow: one 56px row carrying the control that
          opens the navigation drawer, the product, the context the session is
          in, and the session's own affordances. Everything below it belongs to
          the screen. */}
      <header className="appbar">
        {/* Pins the rail open. It is not an open/close control any more — the
            rail is always there and opens on hover — so it reports pressed
            state rather than naming a destination. */}
        <button
          className="bar-burger"
          aria-label={menuOpen ? "Unpin global navigation" : "Pin global navigation open"}
          aria-pressed={menuOpen}
          title="Navigation"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <MenuIcon size={20} />
        </button>
        {/* The product family hangs off the wordmark again.
            It was moved to the foot of the drawer on the reasoning that the
            portal is one door and the API docs and the IdP admin are others,
            so none of them should hang off the name of one. True, and it cost
            more than it bought: reaching Docs or Admin meant opening the
            navigation rail, scrolling past every section of the thing you had
            open, and finding them under the fold. The wordmark is where a
            product family is looked for, and a menu names all three rather
            than implying the first owns the other two. */}
        <span className="brand-wrap" onMouseLeave={() => setProductMenu(false)}>
          <button
            type="button"
            className="brand"
            aria-haspopup="menu"
            aria-expanded={productMenu}
            title="Switch product"
            onClick={() => setProductMenu((v) => !v)}
          >
            <img className="logo" src={PRODUCT_MARK} alt="" />
            <strong>Constructor Studio</strong>
            <span className="chev" aria-hidden>▾</span>
          </button>
          {productMenu && (
            <div className="product-menu" role="menu">
              <button role="menuitem" className="on" onClick={() => setProductMenu(false)}>
                <span className="ico"><GridIcon /></span> Studio
                <span className="check"><CheckIcon /></span>
              </button>
              <button
                role="menuitem"
                onClick={() => {
                  window.open("/api-docs/", "_blank", "noopener");
                  setProductMenu(false);
                }}
              >
                <span className="ico"><BookIcon /></span> Docs &amp; API
              </button>
              <button
                role="menuitem"
                title="How the running backend and this portal are built"
                onClick={() => {
                  // The page has no theme switch of its own: it takes the
                  // portal's, which is a preference here, not the OS's.
                  const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
                  window.open(`/architecture/?theme=${theme}`, "_blank", "noopener");
                  setProductMenu(false);
                }}
              >
                <span className="ico"><LayersIcon /></span> Architecture
              </button>
              <button
                role="menuitem"
                title="Organizations, members, workspaces administration"
                onClick={() => {
                  setProductMenu(false);
                  openAdmin();
                }}
              >
                <span className="ico"><ShieldIcon /></span> Admin
              </button>
            </div>
          )}
        </span>
        <span className="bar-sep" aria-hidden />
        {/* Where the session is: organization › workspace › project. It used to
            sit above the content, which meant every screen started with a row
            of chrome; in the bar it is the same control the product puts
            there. */}
        <div className="bar-context">
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
        </div>
        <div className="bar-right">
          {/* The assistant's own toggle. The dock has a rail you can click, but
              the rail gives up its footprint below 720px, so without this there
              would be no way to reach the assistant on a phone at all. */}
          {!activeSpace && (
            <button
              className="pill pill-ai"
              title={aiOpen ? "Collapse Studio AI" : "Open Studio AI"}
              aria-label="Studio AI"
              aria-pressed={aiOpen}
              onClick={() => setAiOpen((v) => !v)}
            >
              <SparkleIcon />
            </button>
          )}
          <WorkInbox
            runs={completed.runs}
            unread={completed.unread}
            open={inboxOpen}
            onOpen={() => {
              setInboxOpen(true);
              completed.markRead();
            }}
            onClose={() => setInboxOpen(false)}
            onSeeAll={() => {
              setInboxOpen(false);
              setAdminOpen(false);
              setActiveSpace(null);
              setView("tasks");
            }}
          />
          {!activeSpace && (
            <button
              className="pill"
              title={panelOpen ? "Hide filters" : "Show filters"}
              aria-label="Filters"
              onClick={() => setPanelOpen((v) => !v)}
            >
              <SlidersIcon />
              {activeFilterCount(panelView, filters) > 0 && (
                <span className="count">{activeFilterCount(panelView, filters)}</span>
              )}
            </button>
          )}
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
              <PersonPhoto name={userName} url={avatarUrl} size="regular" />
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
        </div>
      </header>

      {/* Everything under the bar, as the product lays it out: a grid whose
          first track is the navigation and whose second is the work. The rail
          is 48px of icons at rest and 240px once it is asked for, and the
          content does NOT reflow when it opens — the rail overlays, which is
          why the track stays 48px in both states and the panel is absolutely
          positioned inside it. */}
      <div
        className="shell-body"
        /* The admin area is a settings sidebar, not transient navigation: it keeps
           its full 240px track, or its open panel would lie over the page it
           manages (and stay open over it while a nav button holds the focus). */
        data-sidebar={menuOpen || adminOpen ? "open" : "rail"}
        /* "none" while a space is showing: the IDE is a whole application, and
           the product does not dock its own assistant beside somebody else's
           editor — that column belongs to Theia. */
        data-ai={activeSpace ? "none" : aiOpen ? "open" : "rail"}
      >
          {/* Always mounted. The old overlay-with-a-scrim was the last place
              this prototype and the portal disagreed structurally: there,
              navigation is permanent chrome you glance at, not a modal you
              summon and dismiss. Hovering it opens it; the bar control pins it
              open so it survives the pointer leaving. */}
          <aside
            className="drawer"
            data-expanded={menuOpen || adminOpen ? "true" : "false"}
            aria-label="Global navigation"
            onKeyDown={(e) => {
              if (e.key === "Escape") setMenuOpen(false);
            }}
          >
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
                  {/* Only when the deployment says where its identity
                      provider is. The URL used to be a literal localhost, so
                      on anything but a developer's own machine this opened
                      the reader's own port 8443. */}
                  {idpConsole && (
                    <div className="nav-section">
                      <div className="nav-section-title admin-title">IdP</div>
                      <button
                        title="Keycloak administration console"
                        onClick={() => window.open(idpConsole, "_blank", "noopener")}
                      >
                        <span className="ico"><ShieldIcon /></span> IdP console ↗
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <>
                {/* Organization / workspace switchers used to live here; the
                    horizontal path picker (org › workspace › project) above the
                    content is now the single place to switch context, so the
                    sidebar keeps only the nav surfaces below. */}
                {/* The open project's sections are NOT here any more — they are
                    the band across the top of the work area (.project-sections).
                    Listing them in both places was the same navigation twice,
                    and the rail is for context, not for the open thing's parts. */}
                <PinnedSection
                  pins={pins}
                  setPins={setPinned}
                  picker={pinPicker}
                  setPicker={setPinPicker}
                  sections={NAV_SECTIONS}
                  activeView={activeSpace ? null : view}
                  activeProjectId={activeSpace ? undefined : crumb.nestedId}
                  activeTab={projectTab}
                  onOpenView={(id) => {
                    setActiveSpace(null); // portal navigation leaves the space
                    setCrumb({});
                    setView(id);
                  }}
                  onOpenProject={(pin) => {
                    setActiveSpace(null);
                    setProjectLabel(pin.name);
                    setCrumb({ projectId: pin.workspaceId, nestedId: pin.projectId });
                    setProjectTab(pin.tab as ProjTab);
                    setView("projects");
                  }}
                />
                {
                  // ── Organization context: work surfaces of the whole org ──
                  NAV_SECTIONS.filter((sec) => !sec.hidden).map((sec) => {
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
            </nav>
          </aside>

      {/* The work area. The IDE host and the portal content are siblings
          inside it — exactly one of the two is showing — so neither can claim
          the viewport out from under the bar. */}
      <div className="screen">
      {/* Open sessions, as tabs.
          They were a list in the navigation rail, which is where you go to
          change WHERE you are -- and a running IDE is not a place you navigate
          to, it is a thing you have open, like a document. Four controls on a
          240px row also left the name, the only part that could shrink, with
          nothing to shrink into. As a strip above the work area they read the
          way every other set of open things reads, and the way back to the
          portal becomes a tab of its own rather than a side effect of clicking
          something else in the rail. */}
      {spaces.length > 0 && (
        <nav className="space-tabs" aria-label="Open sessions">
          <button
            className={`stab${!activeSpace ? " on" : ""}`}
            aria-current={!activeSpace ? "page" : undefined}
            onClick={() => setActiveSpace(null)}
            title="Back to the portal"
          >
            <span className="ico" aria-hidden>
              <NavIcon name="home" />
            </span>
            Portal
          </button>
          {spaces.map((sp) => {
            const on = activeSpace === sp.wsId;
            const dirty = spaceDirty[sp.wsId] ?? 0;
            return (
              <span key={sp.wsId} className={`stab-wrap${on ? " on" : ""}`}>
                <button
                  className={`stab${on ? " on" : ""}`}
                  aria-current={on ? "page" : undefined}
                  onClick={() => {
                    setActiveSpace(sp.wsId);
                    setAdminOpen(false); // a space is a Studio surface
                  }}
                  title={`Switch to ${sp.wsName}${
                    dirty ? ` — ${dirty} unsaved file(s)` : ""
                  }`}
                >
                  <span className="ico">
                    <GearIcon />
                  </span>
                  <span className="stab-name">{sp.wsName}</span>
                  {dirty > 0 && <span className="dirty-dot">●</span>}
                </button>
                <button
                  className="stab-x"
                  title="Hide space (the IDE session keeps running)"
                  aria-label={`Hide ${sp.wsName}`}
                  onClick={() => closeSpace(sp.wsId)}
                >
                  <CloseIcon size={12} />
                </button>
              </span>
            );
          })}
          {/* Refresh, Stop and the external link belong to the session you are
              looking at, so they sit once at the end rather than four times
              across the strip. */}
          {activeSpace && (
            <span className="space-tools">
              <button
                className="ghost"
                title="Refresh IDE without stopping the session"
                aria-label="Refresh IDE"
                onClick={() => refreshSpace(activeSpace)}
              >
                <RefreshIcon size={14} />
              </button>
              <button
                className="ghost space-stop"
                title="Stop IDE session and release Kubernetes resources"
                onClick={() => void stopSpace(activeSpace)}
              >
                Stop
              </button>
              {(() => {
                const sp = spaces.find((x) => x.wsId === activeSpace);
                return sp ? (
                  <a href={sp.url} target="_blank" rel="noopener noreferrer">
                    open in tab ↗
                  </a>
                ) : null;
              })()}
            </span>
          )}
        </nav>
      )}
      {/* The project's sections, as the product draws them: a 44px band across
          the top of the work area, not a list inside the navigation rail.

          They used to live in the rail (commit a2b7f89). The product keeps the
          rail for where you ARE — organization, workspaces, products — and puts
          the sections of the thing you have open on the thing itself, which is
          also why they can be a row: seven short labels fit across a work area
          and would each cost a line in a 240px column. */}
      {projectOpen && (
        <nav className="project-sections" aria-label="Project sections">
          {PROJECT_TABS.map((t) => (
            <button
              key={t.id}
              className={`psection${projectTab === t.id ? " on" : ""}`}
              aria-current={projectTab === t.id ? "page" : undefined}
              onClick={() => setProjectTab(t.id)}
            >
              <span className="ico" aria-hidden>
                <NavIcon name={t.icon} />
              </span>
              {t.label}
            </button>
          ))}
          {/* Pinning a project section belongs on the section, not in the rail:
              the rail cannot know which project is open, and a picker listing
              every project x every section is a list nobody reads. */}
          {(() => {
            const pin: Pin = {
              kind: "project",
              projectId: crumb.nestedId ?? "",
              workspaceId: crumb.projectId ?? "",
              name: projectLabel ?? "Project",
              tab: projectTab,
            };
            const already = isPinned(pins, pin);
            return (
              <button
                className={`psection psection-pin${already ? " on" : ""}`}
                aria-pressed={already}
                title={
                  already
                    ? "Unpin this section from the rail"
                    : "Pin this section to the top of the rail"
                }
                onClick={() => setPinned(togglePin(pins, pin))}
              >
                <span className="ico" aria-hidden>
                  {already ? "★" : "☆"}
                </span>
                {already ? "Pinned" : "Pin"}
              </button>
            );
          })()}
        </nav>
      )}
      {/* A workspace gets the same band, because it is the same kind of thing:
          something you have open, with sections of its own. Its projects are
          one of those sections rather than a table pinned above a different
          switch — the level above should not invent its own navigation. */}
      {workspaceOpen && (
        <nav className="project-sections" aria-label="Workspace sections">
          {WORKSPACE_TABS.map((t) => (
            <button
              key={t.id}
              className={`psection${workspaceTab === t.id ? " on" : ""}`}
              aria-current={workspaceTab === t.id ? "page" : undefined}
              title={t.hint}
              onClick={() => setWorkspaceTab(t.id)}
            >
              <span className="ico" aria-hidden>
                <NavIcon name={t.icon} />
              </span>
              {t.label}
            </button>
          ))}
        </nav>
      )}
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
              /* Addresses this frame for a targeted hand-off — the theme/token
                 broadcasts go to every space, `studio.openDocument` to one. */
              data-ws={s.wsId}
              onLoad={(e) => {
                // Handshake: theme + the caller's API token (the IDE calls the
                // gears same-origin through the session gate's /studio-api/*).
                // Retried every INIT_RETRY_MS until the bridge acks (any
                // studio.* reply): the first load events are the gate's
                // redirect/splash, where nobody is listening yet. The bridge
                // cannot speak first — it learns the portal's origin from this
                // message — so every retry interval is time the IDE sits ready
                // and unaddressed; at 2s that was up to 2s on every open.
                // Splash reloads re-fire onLoad — reset the timer each time.
                const frame = e.currentTarget;
                const origin = spaceOrigin(s.url);
                // A (re)load means a fresh bridge that has not acked yet:
                // anything posted now would be dropped, so go back to queuing
                // until it answers the handshake below.
                bridgeReadyRef.current.delete(s.wsId);
                const post = () => {
                  const theme = document.documentElement.dataset.theme ?? "light";
                  frame.contentWindow?.postMessage(
                    // `wsId` is the tenant this session was opened against — a
                    // workspace tenant (its graph shows every project) or a
                    // project tenant (just that project). The IDE scopes the
                    // Artifact Graph's reads to it.
                    {
                      type: "studio.init",
                      theme,
                      apiToken: tokenRef.current,
                      // Who is at the keyboard. The IDE attributes comments,
                      // suggestions and history to this, and one container is
                      // shared by everyone who opens this workspace — so
                      // without it the session cannot tell them apart.
                      viewer: viewerRef.current,
                      workspaceId: s.wsId,
                      // The IDE opens `/workspace`, so without the name every
                      // surface in it calls the project after the container's
                      // directory. The portal is the only side that knows what
                      // the person actually opened.
                      workspaceName: s.wsName,
                    },
                    origin,
                  );
                };
                post();
                stopInitRetry(s.wsId);
                let tries = 0;
                initTimersRef.current[s.wsId] = setInterval(() => {
                  if (++tries > INIT_RETRY_LIMIT) {
                    stopInitRetry(s.wsId); // ~5 min — session is not coming up
                    return;
                  }
                  post();
                }, INIT_RETRY_MS);
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
        {error && <div className="error">{error}</div>}
        {/* One boundary for every screen that arrives on demand, wherever in
            this subtree it is rendered. Per-screen boundaries would mean a
            fallback to reason about at each site and nothing gained: only one
            screen is showing at a time. */}
        <LazyScreens>
        {adminOpen ? (
          <>
            {adminView === "identities" && (
              <IdentityDirectory token={token} query={filters.query} />
            )}
            {adminView === "tenants" && (showPlatform || orgs.length > 1) && adminOrgId !== "__new__" && (
              <OrganizationsTable
                token={token}
                orgs={orgs}
                workspaces={workspaces}
                selectedId={adminOrg?.id ?? null}
                onSelect={(id) => setAdminOrgId(id)}
                onMembers={(id) => openAdmin("people", id)}
                query={filters.query}
              />
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
              <OrgMembersView
                token={token}
                org={adminOrg ? { id: adminOrg.id, name: adminOrg.name } : activeOrg}
                isPlatformAdmin={showPlatform}
                query={filters.query}
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
            setProjectLabel={setProjectLabel}
            projectTab={projectTab}
            setProjectTab={setProjectTab}
            workspaceTab={workspaceTab}
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
        {view === "reports" && (
          <ReportsScreen
            token={token}
            tenantId={orgAsSpace?.id}
            projects={workspaces.filter((w) => w.orgId === orgAsSpace?.id).map((w) => ({ id: w.id, name: w.name }))}
          />
        )}
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
            focus={componentFocus}
          />
        )}
        {view === "objects" && <ObjectTypes token={token} query={filters.query} />}
        {view === "views" && <ViewsScreen token={token} />}
        {view === "tasks" && <BackgroundWork token={token} query={filters.query} />}
        {view === "system" && (
          <SystemView token={token} filters={filters} tenant={orgAsSpace} meId={me.subject_id} />
        )}
        {view === "profile" && (
          <ProfileView
            me={me}
            home={home}
            token={token}
            onPerson={(p) => setAvatarUrl(p.avatar_url ?? null)}
          />
        )}
          </>
        )}
        {studio && (
          <StudioLauncher
            token={token}
            target={studio}
            onClose={() => setStudio(null)}
            onOpen={(s) => openSpace(studio, s)}
            // No path: the IDE finds the gear.gdl in the project's checkout,
            // and asks when there is more than one.
            onGearProject={() => postToSpace(studio.id, { type: "studio.openGear" })}
          />
        )}
        </LazyScreens>
        </div>
      </div>

      {/* Third column of the grid. Rendered even while parked at 48px — the
          thread and the lazily-created chat id live inside it, and unmounting
          the panel to collapse it would throw both away. */}
      {!activeSpace && <StudioAI token={token} open={aiOpen} onOpenChange={setAiOpen} />}
      </div>

      {!activeSpace && panelOpen && (
        <FilterPanel
          view={panelView}
          token={token}
          filters={filters}
          onChange={setFilters}
          onClose={() => setPanelOpen(false)}
          componentCategories={componentCategories}
        />
      )}

      {/* Editing hand-off. One status for every entry point — a document, a
          repository file, the graph — so no view has to grow its own "the IDE
          is starting" state, and so the wait is visibly part of the SAME
          gesture rather than a launcher to notice and click.

          Deliberately NOT a modal. A first launch pulls an image and clones the
          sources, and blocking the portal behind that takes away the editor the
          person already has open on the very document they asked to edit. It
          reports, it does not detain: dismiss it and the session still comes up
          and still receives the message. */}
      {handoff && (
        <div className="handoff" role="status" aria-live="polite">
          {handoff.kind === "error" ? (
            <>
              <strong>Could not open {handoff.name} in Studio</strong>
              <p className="error">{handoff.error}</p>
              <div className="handoff-actions">
                <button onClick={() => setHandoff(null)}>Close</button>
              </div>
            </>
          ) : handoff.kind === "ready" ? (
            <>
              <strong>{handoff.name} is ready in Studio</strong>
              <p className="hint">The editor is open on what you asked for.</p>
              <div className="handoff-actions">
                <button
                  className="primary"
                  onClick={() => {
                    setActiveSpace(handoff.targetId);
                    setHandoff(null);
                  }}
                >
                  Open Studio
                </button>
                <button onClick={() => setHandoff(null)}>Not now</button>
              </div>
            </>
          ) : (
            <>
              <strong>Opening {handoff.name} in Studio…</strong>
              <p className="hint">
                Starting the IDE session. The first launch of a workspace takes a few seconds
                while its sources are cloned — you can keep working here meanwhile.
              </p>
              <div className="handoff-actions">
                <button
                  onClick={() => {
                    handoffDismissedRef.current = true;
                    setHandoff(null);
                  }}
                >
                  Keep working here
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
    </PortalNavProvider>
    </StudioBridgeProvider>
  );
}

/* ── Filters: an overlay from the right, opened from the top bar ──────────────
   It renders only while open — the caller decides that — so there is no
   collapsed state to draw here any more. The funnel that used to be a 56px
   rail pinned to the edge of every screen is one control in the bar's
   right-hand cluster, which is where the product keeps session affordances. */

function FilterPanel({
  view,
  token,
  filters,
  onChange,
  onClose,
  componentCategories,
}: {
  view: PanelView;
  token: string;
  filters: Filters;
  onChange: (f: Filters) => void;
  onClose: () => void;
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
  const ownFilters = LISTS_WITH_OWN_FILTERS.has(view);
  const noFilters = view === "profile" || view === "dashboard" || ownFilters;
  const hasSearch = !noFilters && view !== "system";

  return (
    <>
      <button
        type="button"
        className="rightbar-scrim"
        aria-label="Close filters"
        onClick={onClose}
      />
      <aside
        className="rightbar"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
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
          <button className="ghost" title="Hide filters" onClick={onClose}>
            ✕
          </button>
        </div>
      </div>

      {ownFilters ? (
        <p className="hint">This list has its own search and filters, above it.</p>
      ) : noFilters ? (
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
                  <option value="plugin">plugin</option>
                  <option value="sdk">SDK</option>
                  <option value="library">library</option>
                  <option value="micro-frontend">micro-frontend</option>
                  <option value="frontend-library">frontend library</option>
                  <option value="tool">tool / CLI</option>
                  <option value="kit">kit</option>
                  <option value="not-components">not components (config, tests, docs, templates, examples)</option>
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
    </>
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

function ProjectsView({
  token,
  workspaces,
  orgId,
  activeOrg,
  filters,
  crumb,
  setCrumb,
  setProjectLabel,
  projectTab,
  setProjectTab,
  workspaceTab,
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
  /** Only the SETTER: opening a project names it for the bar's PathBar. The
   *  label itself was read here by the breadcrumb trail, and there is no trail
   *  any more. */
  setProjectLabel: (n: string | undefined) => void;
  /** Open project's active section — the shell owns this, because the band
   *  that switches it is shell chrome above the work area. */
  projectTab: ProjTab;
  setProjectTab: (t: ProjTab) => void;
  /** Open workspace's active section, owned by the shell for the same reason. */
  workspaceTab: WorkspaceTab;
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

  /* There is no breadcrumb trail here any more. The top bar's PathBar already
     carries organization › workspace › project, and carries it BETTER: each
     segment is a picker, so it both says where you are and moves you, while a
     crumb only moves you back the way you came. Two rows of the same path with
     the weaker one directly under the stronger one is the kind of duplication
     nobody notices they are ignoring. */

  // Level 3 — an open project (its own AM tenant): a self-contained screen.
  if (crumb.nestedId) {
    return (
      <>
        <ProjectScreen
          key={crumb.nestedId}
          token={token}
          projectTenantId={crumb.nestedId}
          workspace={root}
          filters={filters}
          tab={projectTab}
          setTab={setProjectTab}
          onOpenStudio={onOpenStudio}
        />
      </>
    );
  }

  // Level 2 — the workspace. One section at a time, chosen by the band above
  // the work area, exactly as a project behaves.
  return (
    <>
      {workspaceTab === "projects" ? (
        <WorkspaceProjects
          token={token}
          workspace={root}
          onOpenProject={(p) => {
            setProjectLabel(p.name);
            setCrumb({ projectId: root.id, nestedId: p.id });
          }}
          onChanged={onChanged}
        />
      ) : (
        <>
          <WorkspaceHeader workspace={root} />
          <WorkspaceCatalogue
            token={token}
            workspaceId={root.id}
            tab={workspaceTab}
          />
        </>
      )}
    </>
  );
}


/** What a workspace owns: its projects, and the catalogues every project under
 *  it inherits — the document types, the journey, and the documents written
 *  from those types before any project has claimed them.
 *
 *  These are SECTIONS, drawn in the same 44px band the project uses, and the
 *  projects list is one of them. It used to be a stack: the projects table
 *  always at the top, then a row of blue pill buttons choosing between the
 *  three catalogues. That made the two levels behave differently for no
 *  reason a user could name — in a project every section is in the band, in a
 *  workspace one thing was pinned above a different kind of switch — and it
 *  pushed the type editor, which is the tallest screen in the product, below a
 *  projects table it has nothing to do with. */
/* No "documents" here. A workspace owns the document TYPES; a project owns the
   documents written from them. The workspace had a Documents section that
   offered "New document" and then listed nothing — on the development stand it
   had produced zero rows against one project-level document, which is what a
   section with no reader looks like. Authoring moved to the project's Documents
   section, where the writing actually happens. */
type WorkspaceTab = "projects" | "types" | "process";

/** The workspace's page header, shown above EVERY one of its sections — the
 *  project screen does exactly this with its own name, and the level above
 *  should not be the one place where the thing you have open stops naming
 *  itself as soon as you change section. Only the actions differ: creating a
 *  project belongs to the Projects section and nowhere else. */
function WorkspaceHeader({
  workspace,
  actions,
}: {
  workspace: Workspace;
  actions?: React.ReactNode;
}) {
  return (
    <div className="topbar">
      <div>
        <h1>{workspace.name}</h1>
        <p className="subtitle" style={{ margin: 0 }}>
          workspace · <code>{workspace.id.slice(0, 8)}…</code>
        </p>
      </div>
      {actions}
    </div>
  );
}

const WORKSPACE_TABS: { id: WorkspaceTab; icon: string; label: string; hint: string }[] = [
  { id: "projects", icon: "grid", label: "Projects", hint: "The projects in this workspace" },
  { id: "types", icon: "file", label: "Document types", hint: "Templates, section checklists and rules" },
  { id: "process", icon: "activity", label: "Process", hint: "The journey's stages and the capability vocabulary" },
];

function WorkspaceCatalogue({
  token,
  workspaceId,
  tab,
}: {
  token: string;
  workspaceId: string;
  /* No studioTarget: the only screen here that handed off to the IDE was the
     Documents one, and documents are authored in a project now. */
  /** Which catalogue the band selected. "projects" never reaches here — the
   *  screen above renders that one itself, because it owns the navigation into
   *  a project. */
  tab: Exclude<WorkspaceTab, "projects">;
}) {
  return (
    <div>
      {tab === "types" && <DocumentTypesTab token={token} workspaceId={workspaceId} />}
      {tab === "process" && <ProcessCatalogTab token={token} workspaceId={workspaceId} />}
    </div>
  );
}

/** Ids resolved as the create plan runs; carried between steps and across a
 *  retry so a healed run can skip what already succeeded. */
interface CreateCtx {
  tenantId: string;
  repoFull: string;
  branch: string;
  cloneUrl: string;
  /** Set once the starter gear's branch exists.
   *
   *  Unlike every other step, this one cannot probe its own result: writing a
   *  scaffold ends in `POST /git/refs`, which fails outright when the branch is
   *  already there (components_catalog/scaffold.rs). So Retry reads the flag
   *  rather than re-creating the branch — and a genuinely re-run creation gets
   *  the connector's own "does it already exist?" instead of a silent no-op. */
  scaffolded: boolean;
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
  /** Documents, findings and repositories per project. Absent until counted —
   *  see rollups.ts on why an uncounted project must not render as 0. */
  const [rollups, setRollups] = useState<
    Record<string, ProjectRollup & { row?: import("./api").RollupRow }>
  >({});
  const [err, setErr] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<import("./api").ProjectKind>("new_gears");
  // What the new project takes from the shared catalogue. A kit is a component
  // like any other, and a project acquires one the same way it acquires
  // anything else: by picking it from the list, not by naming a repository.
  const [kitCatalog, setKitCatalog] = useState<import("./api").StudioKit[]>([]);
  const [kitSel, setKitSel] = useState<Set<string>>(new Set());
  // Where a new gear's repository comes from. The `new_gears` radio has always
  // promised two roads in its own subtitle -- "Create a new repo, or use an
  // existing gear store" -- and the form asked for neither, so every gear
  // project was created with nowhere to put a gear.
  const [repoMode, setRepoMode] = useState<RepoMode>("new");
  const [connections, setConnections] = useState<Connection[]>([]);
  // "" means "let the backend take the first GitHub connection", which it does.
  const [connId, setConnId] = useState("");
  const [repoOwner, setRepoOwner] = useState("");
  const [repoIsOrg, setRepoIsOrg] = useState(false);
  // Both empty means "follow the project name"; typing pins them.
  const [repoName, setRepoName] = useState("");
  const [gearName, setGearName] = useState("");
  // Where under the repository the gear's own directory goes. Only thirteen
  // of the forty-two gears in `gears-rust` sit at `gears/<slug>/`; the rest
  // are under a family, so a scaffold that can only write the top level
  // writes to the wrong place in most of the monorepo.
  const [gearDir, setGearDir] = useState("");
  // What shape of gear, as the Gearbox engine scaffolds it: the skeleton's
  // `gear.gdl` is the engine's own, so the gear is composable from its first
  // commit. A plugin also names the host whose extension point it fills.
  const [gearKind, setGearKind] = useState<import("./api").GearKind>("service");
  const [pluginHost, setPluginHost] = useState("");
  // null: not loaded, or the engine is not configured on this deployment.
  const [hostPoints, setHostPoints] = useState<import("./api").GearboxExtensionPoint[] | null>(
    null,
  );
  const [corpusUrl, setCorpusUrl] = useState<string | null>(null);
  const [repoPrivate, setRepoPrivate] = useState(true);
  const [repoSearch, setRepoSearch] = useState("");
  const [remoteRepos, setRemoteRepos] = useState<RemoteRepo[] | null>(null);
  const [reposNote, setReposNote] = useState<string | null>(null);
  const [existingRepo, setExistingRepo] = useState<RemoteRepo | null>(null);
  // A gear store belongs to whoever already keeps gears in it, so the skeleton
  // arrives as a pull request. A repository created a moment ago has no such
  // owner, and a PR against an empty repo is ceremony.
  const [openPr, setOpenPr] = useState(false);
  // Journey framing captured at creation (previously dead in the UI): a free-text
  // brief and the opt-in journey stages (Intent is always applied).
  const [brief, setBrief] = useState("");
  // Which page of the card is showing. An index rather than a key, because the
  // pages are a list whose length depends on the answers -- see `clampStep`.
  const [step, setStep] = useState(0);
  // The workspace's effective stage catalogue: names, order, and which are
  // required. It was a constant in api.ts until ADR-0014 s7 moved it to the
  // server, because the journey is a thing an organization configures.
  // Read for `normalizeStages`, which has to know which entries are required.
  // Nothing picks from it here any more: a project's `stages` is not a gate --
  // no backend code reads it, `stage_status` computes against the workspace's
  // whole catalogue -- it only filtered the chips on the project's Overview.
  // Asking for a display filter before the project exists put the question at
  // the one moment nobody can answer it.
  const [stageCatalogue, setStageCatalogue] = useState<import("./api").JourneyStage[]>([]);
  // Resumable provisioning: the live checklist and the context that accumulates
  // ids across steps, kept in a ref so Retry reuses the same run.
  const [prov, setProv] = useState<StepState[] | null>(null);
  const [provOk, setProvOk] = useState(false);
  const provCtx = useRef<CreateCtx>({
    tenantId: "",
    repoFull: "",
    branch: "main",
    cloneUrl: "",
    scaffolded: false,
  });
  // Inline row editing (rename) + per-row busy for edit/delete.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [rowBusy, setRowBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setErr(null);
    try {
      const page = await api.tenantChildrenAll(token, workspace.id);
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

  // What each project contains, counted after the table has already painted
  // its names. Three reads per project, each settled on its own — a project
  // whose gears are half-deployed shows the numbers it can and a dash for the
  // rest, rather than costing the whole column. Deliberately NOT part of
  // `reload`: a rename must not make every count blink back to "—".
  const projectIds = (projects ?? []).map((p) => p.id).join(",");
  useEffect(() => {
    if (!projectIds) {
      setRollups({});
      return;
    }
    let alive = true;
    void (async () => {
      // One request for the whole table. It used to be three per project, and
      // one of those three walked the tenant's entire artifact graph.
      const { projects } = await portfolioRollups(token, workspace.id).catch(() => ({
        projects: new Map<string, import("./rollups").PortfolioProject>(),
      }));
      const wanted = new Set(projectIds.split(","));
      const entries = [...projects.entries()]
        .filter(([id]) => wanted.has(id))
        .map(
          ([id, p]) =>
            [id, { documents: p.documents, findings: p.findings, repos: p.repos, row: p.row }] as const,
        );
      if (alive) setRollups(Object.fromEntries(entries));
    })();
    return () => {
      alive = false;
    };
  }, [token, workspace.id, projectIds]);

  // Load the shared component catalogue when the create card opens.
  useEffect(() => {
    if (!creating) return;
    api
      .kits(token)
      .then((r) => setKitCatalog(r.items ?? []))
      .catch(() => setKitCatalog([]));
  }, [creating, token]);

  // ...and its journey-stage catalogue, for the same reason and at the same
  // moment. An empty catalogue simply renders no chips: a project can still be
  // created, and its stages can be set later.
  useEffect(() => {
    if (!creating) return;
    api
      .stages(token, workspace.id)
      .then((r) => setStageCatalogue(r.items ?? []))
      .catch(() => setStageCatalogue([]));
  }, [creating, token, workspace.id]);

  // Both kinds that create or attach a repository start at a connection. Not
  // loaded for `existing`, which attaches its repository afterwards rather than
  // at creation.
  useEffect(() => {
    if (!creating || (newKind !== "new_gears" && newKind !== "product")) return;
    api
      .connections(token, workspace.id)
      .then((r) => setConnections(r.items ?? []))
      .catch(() => setConnections([]));
  }, [creating, newKind, token, workspace.id]);

  // The hosts a plugin can fill, only once somebody asks for a plugin.
  useEffect(() => {
    if (!creating || newKind !== "new_gears" || gearKind !== "plugin") return;
    let alive = true;
    api
      .gearboxExtensionPoints(token)
      .then((r) => {
        if (alive) setHostPoints(r.items ?? []);
      })
      .catch(() => {
        if (alive) setHostPoints([]);
      });
    api
      .gearboxStatus(token)
      .then((st) => {
        if (alive) setCorpusUrl(st.enabled ? (st.corpus_url ?? null) : null);
      })
      .catch(() => {
        if (alive) setCorpusUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [creating, newKind, gearKind, token]);

  // The gear stores to choose from. A connection is required here (unlike
  // creating a repository, where the backend picks the first GitHub one) --
  // there is no listing without one to list through.
  useEffect(() => {
    if (!creating || newKind !== "new_gears" || repoMode !== "existing" || !connId) {
      setRemoteRepos(null);
      return;
    }
    let alive = true;
    setReposNote(null);
    const t = setTimeout(() => {
      api
        .connectionRepositories(token, connId, workspace.id, repoSearch)
        .then((r) => {
          if (alive) setRemoteRepos(r.items ?? []);
        })
        .catch((e) => {
          if (!alive) return;
          setRemoteRepos([]);
          setReposNote(errText(e));
        });
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [creating, newKind, repoMode, connId, repoSearch, token, workspace.id]);

  const toggleKit = (slug: string) =>
    setKitSel((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });

  // The gear project's derived names. Both fields follow the project name until
  // somebody types in one: in a shared gear store the gear is not the project,
  // and neither is the repository.
  const isGearProject = newKind === "new_gears";
  // GitHub only, and not as a shortcut: creating a repository resolves "the
  // first GitHub connection" server-side, and the scaffold writer speaks
  // GitHub's git API directly (components_catalog/scaffold.rs). Offering a
  // connection neither of them can use would only fail later.
  const gitConnections = connections.filter((c) => c.provider === "github");
  const gearSlugValue = gearSlug(gearName.trim() || newName.trim() || "gear");
  const gearDirValue = gearParentDir(gearDir);
  const repoNameValue = gearSlug(repoName.trim() || newName.trim() || "project");
  // Which sections this project kind is actually asked about, and what it still
  // needs before it can be created — both decided in project-form.ts, where the
  // branches can be read without the JSX around them.
  const layout = createFormLayout(newKind, repoMode);
  // The card's pages, and which one is showing. The list changes length when
  // the type or the repository road changes, so the index is clamped on every
  // render rather than corrected in the handlers that could change it.
  const steps = createSteps(newKind, repoMode);
  const stepIndex = clampStep(step, steps);
  const current = steps[stepIndex];
  const pluginProblem = pluginBlocker({
    repoMode,
    storeRepo: existingRepo?.full_path ?? null,
    corpusUrl,
    host: pluginHost,
  });
  const formState = {
    name: newName,
    kind: newKind,
    repoMode,
    connectionId: connId,
    storePicked: existingRepo !== null,
    pluginProblem: gearKind === "plugin" ? pluginProblem : null,
  };
  const pageBlocker = stepBlocker(current.key, formState);
  // What blocks creating at all, wherever it sits. The last page cannot assume
  // an earlier one is still answered: somebody can walk back and clear a field.
  const createBlocker = steps.map((s) => stepBlocker(s.key, formState)).find(Boolean) ?? null;

  /** Build the idempotent create plan for the current form inputs. Each step
   *  probes real backend state in `check` so a retry resumes cleanly instead of
   *  duplicating writes (ADR-0010: creation is several non-atomic requests). */
  const buildCreatePlan = (name: string): ProvisionStep<CreateCtx>[] => {
    const mode: ProjectMode = newKind === "existing" ? "modernize" : "greenfield";
    const steps: ProvisionStep<CreateCtx>[] = [];

    // 1) Project tenant — find-or-create. Reusing a same-named sibling heals a
    //    prior half-run and closes the "duplicate tenant on retry" race.
    steps.push({
      key: "tenant",
      label: "Project tenant",
      check: async (ctx) => {
        const page = await api.tenantChildrenAll(token, workspace.id);
        const found = (page.items ?? []).find(
          (t) => t.tenant_type === TENANT_TYPES.project && t.name === name,
        );
        if (found) {
          ctx.tenantId = found.id;
          return true;
        }
        return false;
      },
      run: async (ctx) => {
        const t = await api.createTenant(token, {
          name,
          parent_id: workspace.id,
          tenant_type: TENANT_TYPES.project,
        });
        ctx.tenantId = t.id;
      },
    });

    // 3) Project config — mode/kind/stages/brief. Idempotent overwriting PUT,
    //    so it always runs (cheap) and re-running is safe.
    steps.push({
      key: "config",
      label: "Project config",
      run: async (ctx) => {
        const cfg = (await api.projectConfig(token, ctx.tenantId).catch(() => null)) ?? {};
        await api.putProjectConfig(token, ctx.tenantId, {
          ...cfg,
          mode,
          kind: newKind,
          stages: normalizeStages(cfg.stages ?? [], stageCatalogue),
          status: cfg.status ?? "draft",
          brief: brief.trim() || cfg.brief,
          source_git_url: ctx.cloneUrl || cfg.source_git_url,
        });
      },
    });

    // The repository a step below gives the project, as one of its sources.
    // `project.config` `sources[]` is what a session, the desktop and the git
    // proxy clone; a repository recorded only as the gear repo was one the IDE
    // never opened, so the description written into it was nowhere to be seen.
    const cloneUrlOf = (ctx: CreateCtx) => ctx.cloneUrl || `https://github.com/${ctx.repoFull}`;
    const sourcesStep: ProvisionStep<CreateCtx> = {
      key: "sources",
      label: "Repository in the project's sources",
      check: async (ctx) => {
        const cfg = await api.projectConfig(token, ctx.tenantId).catch(() => null);
        return hasRepository(cfg?.sources, cloneUrlOf(ctx));
      },
      run: async (ctx) => {
        // "" is the backend's "first GitHub connection"; a source has to name one.
        const connection = connId || gitConnections[0]?.id;
        if (!connection) throw new Error("No GitHub connection to clone the repository through");
        const cfg = (await api.projectConfig(token, ctx.tenantId).catch(() => null)) ?? {};
        const cloneUrl = cloneUrlOf(ctx);
        if (hasRepository(cfg.sources, cloneUrl)) return;
        await api.putProjectConfig(token, ctx.tenantId, {
          ...cfg,
          source_git_url: cfg.source_git_url || cloneUrl,
          sources: [
            ...(cfg.sources ?? []),
            {
              connection_id: connection,
              full_path: ctx.repoFull,
              clone_url: cloneUrl,
              ...(ctx.branch ? { branch: ctx.branch } : {}),
            },
          ],
        });
      },
    };

    // 4) The gear's repository, and the gear.
    //
    //    Only a `new_gears` project has these: it is the one kind whose whole
    //    purpose is a gear, and a gear needs a directory in a repository before
    //    it is anything at all. The two roads end in the same place -- the
    //    project's gear repo -- so only the `run` differs.
    if (isGearProject) {
      steps.push({
        key: "repo",
        label: repoMode === "new" ? `Gear repository · ${repoNameValue}` : "Gear store",
        check: async (ctx) => {
          const attached = await api
            .getProjectGearRepo(token, ctx.tenantId)
            .then((r) => r.nodes?.[0]?.value)
            .catch(() => undefined);
          if (!attached?.repo) return false;
          ctx.repoFull = attached.repo;
          ctx.branch = attached.branch || "main";
          return true;
        },
        run: async (ctx) => {
          if (repoMode === "new") {
            const created = await api.createProjectRepo(token, ctx.tenantId, {
              tenant: workspace.id,
              connection_id: connId || null,
              ...(repoOwner.trim() ? { owner: repoOwner.trim() } : {}),
              is_org: repoIsOrg,
              name: repoNameValue,
              private: repoPrivate,
            });
            ctx.repoFull = created.full_name;
            ctx.branch = created.default_branch;
            ctx.cloneUrl = created.html_url;
            return;
          }
          if (!existingRepo) throw new Error("No gear store selected");
          const branch = existingRepo.default_branch || "main";
          await api.setProjectGearRepo(token, ctx.tenantId, {
            tenant: workspace.id,
            connection_id: connId || null,
            repo: existingRepo.full_path,
            branch,
          });
          ctx.repoFull = existingRepo.full_path;
          ctx.branch = branch;
          ctx.cloneUrl = existingRepo.clone_url;
        },
      });
      steps.push(sourcesStep);

      steps.push({
        key: "scaffold",
        label: `Starter gear · ${gearDirValue}/${gearSlugValue}`,
        check: (ctx) => ctx.scaffolded,
        run: async (ctx) => {
          // No files: the skeleton is the server's to compose, so this asks
          // for one rather than posting one. An agent makes the same call.
          await api.scaffoldGearToRepo(token, ctx.tenantId, {
            slug: gearSlugValue,
            app_title: name,
            problem: brief.trim(),
            origin: "Scaffolded when the project was created.",
            parent_dir: gearDirValue,
            gear_kind: gearKind,
            // The picker's value is `host::spec`: a host may declare several
            // points, and only the spec tells them apart.
            ...(gearKind === "plugin"
              ? {
                  plugin_host: pluginHost.split("::")[0],
                  plugin_spec: pluginHost.split("::").slice(1).join("::"),
                }
              : {}),
            open_pr: openPr,
          });
          ctx.scaffolded = true;
        },
      });
    }

    // 5) A product's repository, and the one document the assembly reads.
    //
    //    The type's own subtitle promises both -- "Assemble a product from
    //    gears. A new repository is created." -- and until now it did neither:
    //    `product` differed from `existing` in `mode` and in that sentence, and
    //    in nothing else.
    //
    //    The order is the only order that works. Components cannot be chosen
    //    before the product says what it needs, so creation ends at the App
    //    Spec rather than at a list of gears: its questionnaire is what turns
    //    prose into capabilities, and the capabilities are what the matcher
    //    reads (`compose.ts`). The brief is already the answer to that
    //    questionnaire's FIRST question, word for word -- "What are we
    //    building? Describe the product and its core domain." -- so the card
    //    stops filing it under `brief` and never asking again, and hands it
    //    over as the answer it is.
    if (newKind === "product") {
      steps.push({
        key: "repo",
        label: `Repository · ${repoNameValue}`,
        check: async (ctx) => {
          const attached = await api
            .getProjectGearRepo(token, ctx.tenantId)
            .then((r) => r.nodes?.[0]?.value)
            .catch(() => undefined);
          if (!attached?.repo) return false;
          ctx.repoFull = attached.repo;
          ctx.branch = attached.branch || "main";
          return true;
        },
        run: async (ctx) => {
          // Recorded as the project's gear repo, which is also where a gear
          // scaffolded for a capability nothing covers will be written -- so
          // the gap half of the matcher works from the first minute.
          const created = await api.createProjectRepo(token, ctx.tenantId, {
            tenant: workspace.id,
            connection_id: connId || null,
            ...(repoOwner.trim() ? { owner: repoOwner.trim() } : {}),
            is_org: repoIsOrg,
            name: repoNameValue,
            private: repoPrivate,
          });
          ctx.repoFull = created.full_name;
          ctx.branch = created.default_branch;
          ctx.cloneUrl = created.html_url;
        },
      });
      steps.push(sourcesStep);

      // The product's description, from the first minute. It names no gears
      // yet; picking them on the Components tab rewrites this same file on
      // this same branch, so the project has one `product.gdl` from creation
      // on, rather than none until somebody presses Save.
      steps.push({
        key: "product",
        label: "product.gdl",
        check: async (ctx) =>
          !!(await api.projectProduct(token, ctx.tenantId).catch(() => null))?.written,
        run: async (ctx) => {
          await api.previewProduct(token, ctx.tenantId, {
            product_id: productIdFrom(name),
            name,
            gears: [],
            write: true,
            onto_base: true,
          });
        },
      });

      if (brief.trim()) {
        steps.push({
          key: "spec",
          label: "PRD",
          check: async (ctx) => {
            const docs = await api
              .projectDocuments(token, workspace.id, ctx.tenantId)
              .then((r) => r.items)
              .catch(() => []);
            return docs.some((d) => d.type_key === "prd");
          },
          run: async (ctx) => {
            // One answer, not a whole questionnaire: the rest is asked in
            // Specs, where there is room for it. This one seeds the `domain`
            // capability, so the project opens with something for the
            // component matching to work from rather than an empty spec.
            //
            // The document is a PRD, and it will not conform yet: a problem
            // statement, goals and success metrics are nobody's answer here.
            // That is the point of writing it now rather than later -- the
            // Specs tab opens with exactly what is missing.
            await api.createProjectDocument(token, workspace.id, ctx.tenantId, {
              type_key: "prd",
              title: name,
              answers: [{ question_id: "product", text: brief.trim() }],
            });
          },
        });
      }
    }

    // 6) Kits the project asked for, as DESIRED state.
    //
    //    Requesting is idempotent by slug, and materialization is somebody
    //    else's job: the registry records `pending`, and a trusted `cfs` runner
    //    writes the files into whatever repositories the project has when it
    //    has them. That is why creation no longer needs a repository at all --
    //    a project can want a kit before it has anywhere to put it.
    if (kitSel.size > 0) {
      steps.push({
        key: "kits",
        label: `Request ${kitSel.size} kit${kitSel.size === 1 ? "" : "s"}`,
        check: async (ctx) => {
          const current = await api
            .kitInstallations(token, ctx.tenantId)
            .then((r) => r.items)
            .catch(() => []);
          return [...kitSel].every((slug) => current.some((i) => i.kit_slug === slug));
        },
        run: async (ctx) => {
          for (const slug of kitSel) {
            const kit = kitCatalog.find((k) => k.slug === slug);
            if (!kit) continue;
            await api.requestKitInstallation(token, ctx.tenantId, {
              kit_slug: kit.slug,
              version: kit.default_version,
              install_mode: "copy",
              scope: "all-repositories",
            });
          }
        },
      });
    }

    return steps;
  };

  // Run (or re-run) the create plan. Retry reuses the same accumulated context,
  // so satisfied steps short-circuit and only the failed tail re-executes.
  const runCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    setErr(null);
    const res = await runProvision(buildCreatePlan(name), provCtx.current, setProv);
    setProvOk(res.ok);
    if (res.ok) {
      await reload();
      onChanged();
    }
    setBusy(false);
  };

  const create = async () => {
    // Fresh run: reset the accumulated ids. `check` rehydrates them from the
    // backend anyway, so this is just hygiene for a brand-new attempt.
    provCtx.current = {
      tenantId: "",
      repoFull: "",
      branch: "main",
      cloneUrl: "",
      scaffolded: false,
    };
    setProvOk(false);
    await runCreate();
  };

  // Reset the create card back to an empty, pre-run state.
  const resetCreate = () => {
    setCreating(false);
    setProv(null);
    setProvOk(false);
    setNewName("");
    setBrief("");
    setStep(0);
    setKitSel(new Set());
    setRepoMode("new");
    setConnId("");
    setRepoOwner("");
    setRepoIsOrg(false);
    setRepoName("");
    setGearName("");
    setGearDir("");
    setGearKind("service");
    setPluginHost("");
    setHostPoints(null);
    setCorpusUrl(null);
    setRepoPrivate(true);
    setRepoSearch("");
    setRemoteRepos(null);
    setReposNote(null);
    setExistingRepo(null);
    setOpenPr(false);
    provCtx.current = {
      tenantId: "",
      repoFull: "",
      branch: "main",
      cloneUrl: "",
      scaffolded: false,
    };
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
  // Priority first, as the table has always opened: the project that most
  // needs somebody at the top. A header click re-sorts from there.
  const listed: ProjectListRow[] = sortProjects(
    (projects ?? []).map((p) => ({ ...p, row: rollups[p.id]?.row })),
    "priority",
  );

  return (
    <>
      <WorkspaceHeader workspace={workspace} />
      {err && <div className="error">{err}</div>}
      {creating && (
        <div className="card">
          <div className="card-head">
            <h2>New project</h2>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 640 }}>
            {/* One page at a time. The card used to ask everything at once, which
                made a project that needs four answers look like a project that
                needs eleven, and put the two questions a gear never has to answer
                between the two it does. */}
            {prov === null && (
              <div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {steps.map((s, i) => {
                    const done = i < stepIndex;
                    const here = i === stepIndex;
                    return (
                      <button
                        key={s.key}
                        onClick={() => done && setStep(i)}
                        aria-current={here ? "step" : undefined}
                        disabled={!done}
                        style={{
                          display: "inline-flex",
                          gap: 6,
                          alignItems: "center",
                          padding: "4px 10px",
                          border: "1px solid var(--border)",
                          borderRadius: 999,
                          fontSize: 12,
                          background: here ? "var(--accent)" : "transparent",
                          fontWeight: here ? 600 : 400,
                          opacity: here || done ? 1 : 0.5,
                          cursor: done ? "pointer" : "default",
                        }}
                      >
                        <span style={{ opacity: 0.6 }}>{done ? "✓" : i + 1}</span>
                        {s.label}
                      </button>
                    );
                  })}
                </div>
                <p style={{ fontSize: 11, opacity: 0.7, margin: "8px 0 0" }}>{current.hint}</p>
              </div>
            )}

            {current.key === "project" && prov === null && (
              <>
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
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        background: newKind === k ? "var(--accent)" : "transparent",
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
              </>
            )}

            {current.key === "repository" && layout.gearRepository && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  Gear repository
                </div>
                <p style={{ fontSize: 11, opacity: 0.7, margin: "0 0 8px", lineHeight: 1.5 }}>
                  Where the gear is written. Either road ends the same way — a skeleton on
                  branch <code>scaffold/{gearSlugValue}</code>, never on the base branch.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  {(
                    [
                      ["new", "New repository", "Created now; the gear is its first commit."],
                      [
                        "existing",
                        "Existing gear store",
                        "A repository that already holds gears. The skeleton arrives as a branch.",
                      ],
                    ] as ["new" | "existing", string, string][]
                  ).map(([m, title, desc]) => (
                    <label
                      key={m}
                      style={{
                        display: "flex",
                        gap: 8,
                        alignItems: "flex-start",
                        padding: "8px 10px",
                        border: "1px solid var(--border)",
                        borderRadius: 8,
                        background: repoMode === m ? "var(--accent)" : "transparent",
                        cursor: prov !== null ? "default" : "pointer",
                      }}
                    >
                      <input
                        type="radio"
                        name="grepo"
                        checked={repoMode === m}
                        disabled={prov !== null}
                        onChange={() => {
                          setRepoMode(m);
                          // A gear store belongs to whoever already keeps gears
                          // in it; a repository created a moment ago does not.
                          setOpenPr(m === "existing");
                        }}
                        style={{ marginTop: 2 }}
                      />
                      <span>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
                        <div style={{ fontSize: 11, opacity: 0.7 }}>{desc}</div>
                      </span>
                    </label>
                  ))}
                </div>

                <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                  <ConnectionField
                    connections={gitConnections}
                    value={connId}
                    disabled={prov !== null}
                    onChange={(id) => {
                      setConnId(id);
                      setExistingRepo(null);
                    }}
                    emptyLabel={
                      repoMode === "new"
                        ? "Default — the first GitHub connection"
                        : "Select a connection…"
                    }
                  />

                  {repoMode === "new" ? (
                    <NewRepoFields
                      owner={repoOwner}
                      setOwner={setRepoOwner}
                      isOrg={repoIsOrg}
                      setIsOrg={setRepoIsOrg}
                      name={repoName}
                      setName={setRepoName}
                      namePlaceholder={repoNameValue}
                      isPrivate={repoPrivate}
                      setPrivate={setRepoPrivate}
                      disabled={prov !== null}
                    />
                  ) : (
                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ fontSize: 11, opacity: 0.8 }}>Repository</span>
                      <input
                        placeholder={connId ? "Search…" : "Pick a connection first"}
                        value={repoSearch}
                        disabled={prov !== null || !connId}
                        onChange={(e) => setRepoSearch(e.target.value)}
                      />
                      {reposNote && (
                        <span style={{ fontSize: 11, color: "var(--danger, #c33)" }}>
                          {reposNote}
                        </span>
                      )}
                      {connId && remoteRepos !== null && (
                        <div
                          style={{
                            maxHeight: 180,
                            overflowY: "auto",
                            border: "1px solid var(--border)",
                            borderRadius: 8,
                          }}
                        >
                          {remoteRepos.length === 0 ? (
                            <div style={{ fontSize: 12, opacity: 0.7, padding: "8px 10px" }}>
                              Nothing matched.
                            </div>
                          ) : (
                            remoteRepos.map((r) => (
                              <label
                                key={r.id}
                                style={{
                                  display: "flex",
                                  gap: 8,
                                  alignItems: "center",
                                  padding: "6px 10px",
                                  fontSize: 12,
                                  background:
                                    existingRepo?.id === r.id ? "var(--accent)" : "transparent",
                                  cursor: prov !== null ? "default" : "pointer",
                                }}
                              >
                                <input
                                  type="radio"
                                  name="gstore"
                                  checked={existingRepo?.id === r.id}
                                  disabled={prov !== null}
                                  onChange={() => setExistingRepo(r)}
                                />
                                <span>
                                  {r.full_path}
                                  <span style={{ opacity: 0.6 }}>
                                    {" "}
                                    · {r.default_branch || "main"}
                                  </span>
                                </span>
                              </label>
                            ))
                          )}
                        </div>
                      )}
                    </label>
                  )}

                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, opacity: 0.8 }}>Gear name</span>
                    <input
                      placeholder={gearSlugValue}
                      value={gearName}
                      disabled={prov !== null}
                      onChange={(e) => setGearName(e.target.value)}
                    />
                    <span style={{ fontSize: 11, opacity: 0.7 }}>
                      gear.toml, the crate, the <code>#[toolkit::gear]</code> entrypoint, PRD and
                      DESIGN. In a shared store the gear is not the project, so this is its own
                      field.
                    </span>
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, opacity: 0.8 }}>Directory</span>
                    <input
                      placeholder={gearDirValue}
                      value={gearDir}
                      disabled={prov !== null}
                      onChange={(e) => setGearDir(e.target.value)}
                    />
                    <span style={{ fontSize: 11, opacity: 0.7 }}>
                      Scaffolded into <code>{gearDirValue}/{gearSlugValue}/</code>. A shared store
                      usually groups them — in <code>gears-rust</code> only thirteen of
                      forty-two gears sit at <code>gears/</code>, the rest under a family like{" "}
                      <code>gears/system</code> or <code>gears/bss</code>.
                    </span>
                  </label>

                  <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    <span style={{ fontSize: 11, opacity: 0.8 }}>Kind</span>
                    <select
                      value={gearKind}
                      disabled={prov !== null}
                      onChange={(e) => setGearKind(e.target.value as import("./api").GearKind)}
                    >
                      <option value="service">Service — a gear with a REST surface</option>
                      <option value="minimal">Minimal — a gear with no capabilities yet</option>
                      <option value="plugin">Plugin — fills a host's extension point</option>
                    </select>
                    <span style={{ fontSize: 11, opacity: 0.7 }}>
                      The skeleton carries a <code>gear.gdl</code> written by the Gearbox engine,
                      so the gear can be put in a product and opened in the IDE's Gearbox view.
                    </span>
                  </label>

                  {gearKind === "plugin" && (
                    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      <span style={{ fontSize: 11, opacity: 0.8 }}>Host</span>
                      {hostPoints === null ? (
                        <span style={{ fontSize: 11, opacity: 0.7 }}>Reading the corpus…</span>
                      ) : hostPoints.length === 0 ? (
                        <span style={{ fontSize: 11, opacity: 0.7 }}>
                          The Gearbox engine knows no extension point here, or is not configured.
                          A plugin cannot be described without one; pick another kind.
                        </span>
                      ) : (
                        <select
                          value={pluginHost}
                          disabled={prov !== null}
                          onChange={(e) => setPluginHost(e.target.value)}
                        >
                          <option value="">Pick a host…</option>
                          {hostPoints.map((p) => (
                            <option key={`${p.host}::${p.spec}`} value={`${p.host}::${p.spec}`}>
                              {p.host} · {p.trait_ident}
                              {p.runs ? "" : " (cannot run yet)"}
                            </option>
                          ))}
                        </select>
                      )}
                      {pluginProblem && hostPoints !== null && (
                        <span style={{ fontSize: 11, opacity: 0.8 }} data-plugin-problem>
                          {pluginProblem}
                        </span>
                      )}
                    </label>
                  )}

                  <label
                    style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 12 }}
                  >
                    <input
                      type="checkbox"
                      checked={openPr}
                      disabled={prov !== null}
                      onChange={(e) => setOpenPr(e.target.checked)}
                    />
                    Open a pull request
                  </label>
                </div>
              </div>
            )}

            {current.key === "components" && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  Components{" "}
                  {isGearProject && (
                    <span style={{ opacity: 0.6, fontWeight: 400 }}>· optional</span>
                  )}
                </div>
                <p style={{ fontSize: 11, opacity: 0.7, margin: "0 0 8px", lineHeight: 1.5 }}>
                  {isGearProject
                    ? "The skeleton already writes the gear's own PRD and DESIGN. A kit is the step after that — the workflows that keep them honest — so nothing here is picked for you."
                    : "What this project takes from the shared catalogue. Requested now, written into the project's repositories when it has them — so a project can want a kit before it has anywhere to put it."}
                </p>
                {kitCatalog.length === 0 ? (
                  <div style={{ fontSize: 12, opacity: 0.7 }}>
                    The catalogue is empty, or could not be read. A project can be created
                    without components and take them later from its Kits tab.
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    {kitCatalog.map((k) => {
                      const on = kitSel.has(k.slug);
                      return (
                        <label
                          key={k.slug}
                          style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "flex-start",
                            padding: "6px 10px",
                            border: "1px solid var(--border)",
                            borderRadius: 8,
                            background: on ? "var(--accent)" : "transparent",
                            cursor: prov !== null ? "default" : "pointer",
                            opacity: prov !== null && !on ? 0.5 : 1,
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={prov !== null}
                            onChange={() => toggleKit(k.slug)}
                            style={{ marginTop: 2 }}
                          />
                          <span>
                            <span style={{ fontSize: 12, fontWeight: 600 }}>{k.name}</span>
                            <span style={{ fontSize: 11, opacity: 0.6 }}>
                              {" "}
                              · {k.publisher} · {k.default_version}
                            </span>
                            <div style={{ fontSize: 11, opacity: 0.75, marginTop: 2 }}>
                              {k.description}
                            </div>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {current.key === "repository" && layout.productRepository && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  Repository
                </div>
                <p style={{ fontSize: 11, opacity: 0.7, margin: "0 0 8px", lineHeight: 1.5 }}>
                  A product gets its own, new — the gears it is assembled from stay where
                  they are and are depended on. This is also where a gear scaffolded for a
                  capability nothing in the catalogue covers will be written.
                </p>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <ConnectionField
                    connections={gitConnections}
                    value={connId}
                    disabled={prov !== null}
                    onChange={setConnId}
                    emptyLabel="Default — the first GitHub connection"
                  />
                  <NewRepoFields
                    owner={repoOwner}
                    setOwner={setRepoOwner}
                    isOrg={repoIsOrg}
                    setIsOrg={setRepoIsOrg}
                    name={repoName}
                    setName={setRepoName}
                    namePlaceholder={repoNameValue}
                    isPrivate={repoPrivate}
                    setPrivate={setRepoPrivate}
                    disabled={prov !== null}
                  />
                </div>
              </div>
            )}

            {current.key === "repository" && layout.componentsNote && (
              <p style={{ fontSize: 11, opacity: 0.7, margin: 0, lineHeight: 1.5 }}>
                No components are offered for a shared gear store. A kit installs with
                <code> copy</code> across every repository the project has, and this one
                already belongs to the gears in it — it has its own conventions to keep.
                The project can still take a kit later, from its Components tab.
              </p>
            )}

            {current.key === "brief" && (
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
                  Brief <span style={{ opacity: 0.6, fontWeight: 400 }}>· optional</span>
                </div>
                <textarea
                  placeholder={
                    newKind === "existing"
                      ? "What is this app, and what are we modernizing?"
                      : isGearProject
                        ? "What is this gear for? Becomes ## Problem in its docs/PRD.md."
                        : "What are we building, and why?"
                  }
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  rows={3}
                  style={{ width: "100%", resize: "vertical", fontFamily: "inherit", fontSize: 13 }}
                  disabled={prov !== null}
                />
              </div>
            )}

            {prov === null ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {stepIndex > 0 && (
                  <button className="ghost" onClick={() => setStep(stepIndex - 1)}>
                    Back
                  </button>
                )}
                {stepIndex < steps.length - 1 ? (
                  <button
                    className="primary"
                    onClick={() => setStep(stepIndex + 1)}
                    disabled={pageBlocker !== null}
                  >
                    Next
                  </button>
                ) : (
                  <button
                    className="primary"
                    onClick={() => void create()}
                    disabled={busy || createBlocker !== null}
                  >
                    {busy ? "Creating…" : "Create project"}
                  </button>
                )}
                <button className="ghost" onClick={resetCreate}>
                  Cancel
                </button>
                {(pageBlocker ?? createBlocker) && (
                  <span style={{ fontSize: 11, opacity: 0.7 }}>
                    {pageBlocker ?? createBlocker}
                  </span>
                )}
              </div>
            ) : (
              <div
                style={{
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  padding: "12px 14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.8 }}>
                  Provisioning {newName.trim()}
                </div>
                {prov.map((st) => {
                  const mark =
                    st.status === "done"
                      ? "✓"
                      : st.status === "running"
                        ? "…"
                        : st.status === "failed"
                          ? "✕"
                          : "○";
                  const color =
                    st.status === "done"
                      ? "var(--success)"
                      : st.status === "failed"
                        ? "var(--destructive)"
                        : "inherit";
                  return (
                    <div key={st.key} style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
                      <span style={{ width: 14, color, fontWeight: 700 }}>{mark}</span>
                      <span style={{ fontSize: 13 }}>{st.label}</span>
                      {st.error && (
                        <span style={{ fontSize: 12, color: "var(--destructive)" }}>
                          — {st.error}
                        </span>
                      )}
                    </div>
                  );
                })}
                <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                  {provOk ? (
                    <>
                      <button
                        className="primary"
                        onClick={() => {
                          const id = provCtx.current.tenantId;
                          const name = newName.trim();
                          resetCreate();
                          if (id) onOpenProject({ id, name });
                        }}
                      >
                        Open project
                      </button>
                      <button className="ghost" onClick={resetCreate}>
                        Done
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="primary"
                        onClick={() => void runCreate()}
                        disabled={busy}
                      >
                        {busy ? "Retrying…" : "Retry"}
                      </button>
                      <button className="ghost" onClick={resetCreate} disabled={busy}>
                        Cancel
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      <div className="card">
        <DataTable<ProjectListRow>
          list="projects"
          title="Projects"
          rows={projects === null ? null : listed}
          error={projects === null ? err : null}
          onRetry={() => void reload()}
          rowKey={(p) => p.id}
          rowLabel={(p) => p.name}
          onOpen={(p) => onOpenProject(p)}
          search={{ placeholder: "Search projects" }}
          searchText={(p) => [p.name, p.row?.brief]}
          filters={[
            {
              id: "review",
              allLabel: "All reviews",
              kind: "chips",
              options: REVIEW_FILTERS.filter((f) => f.id !== "all").map((f) => ({ value: f.id, label: f.label })),
              match: (p, value) => !!p.row && inReviewFilter(reviewOf(p.row), value as ReviewFilter),
            },
          ]}
          primary={
            <button className="primary" onClick={() => (creating ? resetCreate() : setCreating(true))}>
              + New project
            </button>
          }
          empty={{
            title: "No projects yet.",
            body: "Create one to get a codebase context: sources, IDE, artifacts.",
            action: (
              <button className="primary" onClick={() => setCreating(true)}>
                New project
              </button>
            ),
          }}
          columns={[
            {
              id: "name",
              header: "Project",
              compare: projectComparator<ProjectListRow>("name"),
              cell: (p) => (
                <div className="pcell">
                  <span className={`pkind pkind-${p.row?.project_kind ?? "none"}`} aria-hidden>
                    {p.row?.project_kind === "product" ? "◈" : p.row?.project_kind === "existing" ? "⌘" : "▦"}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    {editingId === p.id ? (
                      <input
                        value={editName}
                        autoFocus
                        aria-label={`New name for ${p.name}`}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") void saveEdit(p.id);
                          if (e.key === "Escape") cancelEdit();
                        }}
                        style={{ width: "100%" }}
                      />
                    ) : (
                      <div className="pname">{p.name}</div>
                    )}
                    <div className="sub pclip" title={p.row?.brief ?? undefined}>
                      {kindLine(p.row)}
                    </div>
                  </div>
                </div>
              ),
            },
            {
              id: "review",
              header: "Review",
              compare: projectComparator<ProjectListRow>("priority"),
              cell: (p) => {
                const review = p.row ? reviewOf(p.row) : null;
                return review ? (
                  <div className={`preview preview-${review.tone}`}>
                    <div className="preview-label">
                      <span className="preview-dot" aria-hidden />
                      {review.label}
                    </div>
                    {review.detail && <div className="sub">{review.detail}</div>}
                  </div>
                ) : (
                  <span className="sub">—</span>
                );
              },
            },
            {
              id: "specs",
              header: "Specs",
              cell: (p) => {
                const specs = specsCell(p.row);
                return (
                  <>
                    <div>{specs.label}</div>
                    {specs.detail && <div className="sub">{specs.detail}</div>}
                  </>
                );
              },
            },
            {
              id: "pulls",
              header: "Pull requests",
              cell: (p) => {
                const pulls = pullsCell(p.row);
                return pulls ? (
                  <div className="ppulls">
                    <div>
                      <div>{pulls.label}</div>
                      <div className="sub">{pulls.detail}</div>
                    </div>
                    {pulls.days.length > 0 && (
                      <div className="ppulls-spark">
                        <Spark days={pulls.days} />
                        <div className="sub">Last {pulls.days.length} days</div>
                      </div>
                    )}
                  </div>
                ) : (
                  <span className="sub">Pull request activity unavailable</span>
                );
              },
            },
            { id: "team", header: "Team", cell: (p) => teamText(p.row) },
            {
              id: "updated",
              header: "Last update",
              compare: projectComparator<ProjectListRow>("updated"),
              cell: (p) => {
                const last = lastUpdate(p.row);
                return (
                  <>
                    <When iso={p.row?.last_at} className={p.row?.last_at ? undefined : "sub"} />
                    <div className="sub pclip" title={last.what}>
                      {last.what}
                    </div>
                  </>
                );
              },
            },
          ]}
          inline={(p) =>
            editingId === p.id ? (
              <>
                <button className="primary" disabled={rowBusy === p.id || !editName.trim()} onClick={() => void saveEdit(p.id)}>
                  {rowBusy === p.id ? "Saving…" : "Save"}
                </button>
                <button className="ghost" disabled={rowBusy === p.id} onClick={cancelEdit}>
                  Cancel
                </button>
              </>
            ) : null
          }
          actions={(p) =>
            editingId === p.id
              ? []
              : [
                  { label: "Open", onSelect: () => onOpenProject(p) },
                  { label: "Rename", onSelect: () => startEdit(p) },
                  {
                    label: "Delete",
                    danger: {
                      title: `Delete project “${p.name}”?`,
                      body: "The project, its sources and its settings go. This cannot be undone.",
                      confirmLabel: "Delete",
                    },
                    onSelect: async () => {
                      await api.deleteTenant(token, p.id);
                      await reload();
                      onChanged();
                    },
                  },
                ]
          }
          tile={(p, open) => (
            <VTile
              icon={<span aria-hidden>▦</span>}
              title={p.name}
              subtitle={kindLine(p.row)}
              onClick={open}
              tone={rollups[p.id]?.findings ? "attn" : undefined}
              stats={[
                { label: "documents", value: rollupText(rollups[p.id]?.documents ?? null) },
                {
                  label: "findings",
                  value: rollups[p.id]?.findings ? (
                    <span className="pnum-attn">{rollups[p.id]!.findings}</span>
                  ) : (
                    rollupText(rollups[p.id]?.findings ?? null)
                  ),
                },
                { label: "repos", value: rollupText(rollups[p.id]?.repos ?? null) },
              ]}
            />
          )}
        />
      </div>
    </>
  );
}

/** One row of a workspace's project table: the project and what is counted for it. */
type ProjectListRow = { id: string; name: string; row?: import("./api").RollupRow };

/** A section the product's navigation lists but this prototype has no screen
 *  for. Named honestly on the page, with what it would show and what is
 *  actually missing, so it cannot be mistaken for a working screen with no
 *  data in it. */
function NotBuiltYet({ title, what, why }: { title: string; what: string; why: string }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <p className="empty">
        Not built yet. This section would show {what}.
      </p>
      <p className="hint">Why it is empty: {why}.</p>
    </div>
  );
}

/** The sections of an open project — the type is defined next to the Overview
 *  that links to them; this is the shell rail's rendering of the list (the
 *  active tab is stored on the shell, not inside ProjectScreen). */
const PROJECT_TABS: { id: ProjTab; icon: string; label: string }[] = [
  // In the order the work happens, which is not the order the sections were
  // added. Icons are the lucide names the shipped project-sidebar picks.
  { id: "overview", icon: "home", label: "Overview" },
  // Specs first, because everything after it is downstream of a document: the
  // components a product is composed from are matched against what its specs
  // declare, and the artifacts are what came out. Reading the row left to right
  // is reading the project's own order -- what we decided, what we build it
  // from, what exists. It used to sit fourth, behind the two sections that
  // depend on it.
  //
  // The name is the product's: this screen was called Documents here and the
  // shipped project-sidebar calls it Specs (`/v1/projects/<id>/specs`), and a
  // prototype that renames the product's sections is a prototype of a
  // different product.
  { id: "specs", icon: "scan", label: "Specs" },
  { id: "components", icon: "package", label: "Components" },
  // Kits are how the project works (workflows, conventions pinned to a Git
  // version), not what it is made of, so they stopped sharing a page with the
  // specs-to-product journey.
  { id: "kits", icon: "grid", label: "Kits" },
  { id: "artifacts", icon: "file", label: "Artifacts" },
  // Sources sits after them because it is where they come from: a sync run
  // here is what puts anything in Artifacts at all. It was a card near the
  // bottom of Overview, which buried the project's only long-running action
  // under six panels people read and then leave. The shipped sidebar has since
  // grown the same section, in the same place.
  { id: "sources", icon: "plug", label: "Sources" },
  { id: "activity", icon: "activity", label: "Activity" },
  { id: "timeline", icon: "clock", label: "Timeline" },
  { id: "people", icon: "users", label: "Team" },
  // Ours, kept after the product's list rather than interleaved with it.
  { id: "automation", icon: "shield", label: "Automation" },
];


/** The top of the navigation rail: what this person always needs.
 *
 *  It replaced a group called WORK, whose three entries were what concept v2
 *  left over rather than a category (see pins.ts). Those three are still the
 *  defaults and still listed in the picker, because a slot you can empty must
 *  not be a slot that loses things.
 *
 *  A pin naming a destination this build no longer has is drawn as its own id
 *  rather than dropped: losing somebody's row to a rename they never saw is
 *  worse than one row that says something unfamiliar. */
function PinnedSection({
  pins,
  setPins,
  picker,
  setPicker,
  sections,
  activeView,
  activeProjectId,
  activeTab,
  onOpenView,
  onOpenProject,
}: {
  pins: Pin[];
  setPins: (next: Pin[]) => void;
  picker: boolean;
  setPicker: (open: boolean | ((v: boolean) => boolean)) => void;
  sections: { items: { id: View; icon: string; label: string }[] }[];
  /** `null` while a space is open: nothing in the rail is current then. */
  activeView: View | null;
  activeProjectId?: string;
  activeTab: ProjTab;
  onOpenView: (id: View) => void;
  onOpenProject: (pin: Extract<Pin, { kind: "project" }>) => void;
}) {
  const everyItem = sections.flatMap((sec) => sec.items);
  return (
    <div className="nav-section nav-section-pinned">
      <div className="nav-section-title">
        Pinned
        <button
          className="nav-pin-add"
          aria-label="Pin a destination"
          aria-expanded={picker}
          title="Pin a destination"
          onClick={() => setPicker((v) => !v)}
        >
          +
        </button>
      </div>
      {pins.length === 0 && !picker && (
        <p className="nav-pin-empty">Nothing pinned. Use + to keep a screen here.</p>
      )}
      {pins.map((pin) => {
        const entry = pin.kind === "view" ? everyItem.find((i) => i.id === pin.id) : undefined;
        const label = pin.kind === "view" ? (entry?.label ?? pin.id) : pin.name;
        const icon = pin.kind === "view" ? (entry?.icon ?? "grid") : "home";
        const on =
          pin.kind === "view"
            ? activeView === pin.id && !activeProjectId
            : activeProjectId === pin.projectId && activeTab === pin.tab;
        return (
          <div key={pinKey(pin)} className="nav-pin">
            <button
              className={on ? "active" : ""}
              title={pin.kind === "view" ? label : `${pin.name} · ${pin.tab}`}
              onClick={() => (pin.kind === "view" ? onOpenView(pin.id as View) : onOpenProject(pin))}
            >
              <span className="ico">
                <NavIcon name={icon} />
              </span>
              <span className="nav-pin-name">{label}</span>
              {pin.kind === "project" && <span className="nav-pin-tab">{pin.tab}</span>}
            </button>
            <button
              className="nav-pin-x"
              aria-label={`Unpin ${label}`}
              title="Unpin"
              onClick={() => setPins(togglePin(pins, pin))}
            >
              <CloseIcon size={12} />
            </button>
          </div>
        );
      })}
      {picker && (
        <div className="nav-pin-picker">
          {everyItem.map((n) => {
            const pin: Pin = { kind: "view", id: n.id };
            const already = isPinned(pins, pin);
            return (
              <button
                key={n.id}
                className={already ? "on" : ""}
                onClick={() => setPins(togglePin(pins, pin))}
              >
                <span className="ico">
                  <NavIcon name={n.icon} />
                </span>
                {n.label}
                <span className="check">{already ? "✓" : "+"}</span>
              </button>
            );
          })}
          <p className="nav-pin-empty">
            A project&apos;s own section is pinned from the band above it.
          </p>
        </div>
      )}
    </div>
  );
}

/** The connection a repository is created or read through.
 *
 *  GitHub only, and not as a shortcut: creating a repository resolves "the
 *  first GitHub connection" server-side, and the scaffold writer speaks
 *  GitHub's git API directly (components_catalog/scaffold.rs). Offering a
 *  connection neither of them can use would only fail later. */
function ConnectionField({
  connections,
  value,
  onChange,
  disabled,
  emptyLabel,
}: {
  connections: Connection[];
  value: string;
  onChange: (id: string) => void;
  disabled: boolean;
  emptyLabel: string;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <span style={{ fontSize: 11, opacity: 0.8 }}>Connection</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">{emptyLabel}</option>
        {connections.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label} · {c.account}
          </option>
        ))}
      </select>
      {connections.length === 0 && (
        <span style={{ fontSize: 11, opacity: 0.7 }}>
          No GitHub connection on this workspace yet — add one in Integrations.
        </span>
      )}
    </label>
  );
}

/** Owner, name and visibility for a repository about to be created.
 *
 *  Shared by both repository pages rather than written twice: a gear's new
 *  store and a product's repository are created by the same call with the same
 *  four fields, and two copies would be two things to keep in step. */
function NewRepoFields({
  owner,
  setOwner,
  isOrg,
  setIsOrg,
  name,
  setName,
  namePlaceholder,
  isPrivate,
  setPrivate,
  disabled,
}: {
  owner: string;
  setOwner: (v: string) => void;
  isOrg: boolean;
  setIsOrg: (v: boolean) => void;
  name: string;
  setName: (v: string) => void;
  namePlaceholder: string;
  isPrivate: boolean;
  setPrivate: (v: boolean) => void;
  disabled: boolean;
}) {
  const row = { display: "flex", gap: 8, alignItems: "flex-end" } as const;
  const check = {
    display: "inline-flex",
    gap: 6,
    alignItems: "center",
    fontSize: 12,
    paddingBottom: 6,
  } as const;
  return (
    <>
      <div style={row}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
          <span style={{ fontSize: 11, opacity: 0.8 }}>Owner</span>
          <input
            placeholder="Leave empty for your own account"
            value={owner}
            disabled={disabled}
            onChange={(e) => setOwner(e.target.value)}
          />
        </label>
        <label style={check}>
          <input
            type="checkbox"
            checked={isOrg}
            disabled={disabled}
            onChange={(e) => setIsOrg(e.target.checked)}
          />
          organization
        </label>
      </div>
      <div style={row}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1 }}>
          <span style={{ fontSize: 11, opacity: 0.8 }}>Repository name</span>
          <input
            placeholder={namePlaceholder}
            value={name}
            disabled={disabled}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label style={check}>
          <input
            type="checkbox"
            checked={isPrivate}
            disabled={disabled}
            onChange={(e) => setPrivate(e.target.checked)}
          />
          private
        </label>
      </div>
    </>
  );
}

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
  onOpenStudio,
}: {
  token: string;
  projectTenantId: string;
  workspace: Workspace;
  filters: Filters;
  /** Active section — lifted to the shell, which draws the band that sets it. */
  tab: ProjTab;
  setTab: (t: ProjTab) => void;
  onOpenStudio: (target: StudioTarget) => void;
}) {
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const studio = useStudioBridge();

  // Someone who opens a project is likely to open one of its documents next:
  // start its IDE now, so that click is not also the wait for a session.
  const prewarm = studio?.prewarm;
  useEffect(() => {
    if (!tenant || !prewarm) return;
    prewarm({ ...tenant, orgId: workspace.orgId, orgName: workspace.orgName } as Workspace);
  }, [tenant, prewarm, workspace.orgId, workspace.orgName]);

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

  /* No header row. Everything that was in it was already on the screen:
   *
   *   - the NAME is the bar's PathBar project segment, one row above, and that
   *     one is a picker — it says where you are and moves you, where an <h1>
   *     only says it. This is the same argument that removed the breadcrumb
   *     trail and the "← <workspace>" link before it.
   *   - "project · d5e76267…" said the type, which is obvious from having
   *     opened a project, and eight characters of an id, which cannot be
   *     pasted into anything. The full id has never been here; if it is ever
   *     wanted it belongs somewhere it can be copied whole.
   *   - "Open in IDE" was the THIRD on this screen. Overview's Studio card
   *     carries it with the session's state and what it will mount, and
   *     Sources carries it next to the repositories it would check out. Both
   *     say something this one could not.
   *
   * What is left starts at the section band, which is the first thing on the
   * page that is about this project rather than about where it sits. */
  return (
    <>
      <div className="proj-content">
        {tab === "overview" && (
          <ProjectOverview
            token={token}
            project={proj}
            parentWorkspaceId={workspace.id}
            onOpenTab={setTab}
            onOpenStudio={() => onOpenStudio(proj)}
          />
        )}
        {tab === "artifacts" && (
          <ArtifactsView token={token} workspace={proj} parentWorkspaceId={workspace.id} />
        )}
        {tab === "components" && (
          <ProjectKits
            token={token}
            projectId={proj.id}
            projectName={proj.name}
            workspaceId={workspace.id}
          />
        )}
        {tab === "kits" && (
          <ProjectKits
            token={token}
            projectId={proj.id}
            projectName={proj.name}
            workspaceId={workspace.id}
            section="kits"
          />
        )}
        {tab === "sources" && (
          <>
            <h1>Sources</h1>
            <p className="subtitle">
              The repositories this project is built from. A session clones them when you open it;
              a sync pulls their issues, pull requests and files into the artifact graph — which is
              where every artifact number in this project comes from.
            </p>
            <ProjectSources
              token={token}
              workspace={proj}
              parentWorkspaceId={workspace.id}
              onOpenStudio={onOpenStudio}
            />
          </>
        )}
        {tab === "specs" && (
          <DocumentsTab
            token={token}
            workspaceId={workspace.id}
            projectTenantId={proj.id}
            /* One gesture: the bridge reuses or launches this project's
               session, mounts its space and opens the file — no launcher card
               in between, and nothing lost if the IDE is still booting. */
            onOpenFile={(path) => void studio?.openFile(proj, path)}
            /* The detector console, handed in rather than imported inside the
               tab: it needs the PROJECT tenant as its workspace and the parent
               as its catalogue scope, which is the pairing this screen already
               holds and documents.tsx would have to be taught. */
            analysis={
              <SpecQuality token={token} workspaceId={proj.id} parentWorkspaceId={workspace.id} />
            }
            /* The Authored view can hand a document to the IDE, and the IDE it
               means is this project's. */
            studioTarget={proj}
          />
        )}
        {/* Two sections the product has and this prototype does not. They say
            so rather than showing a plausible-looking empty table: a section
            that renders "0 events" is indistinguishable from a working one
            reading an empty project, and somebody will eventually report that
            as a bug against the backend. */}
        {tab === "activity" && (
          <ActivityView token={token} projectTenantId={proj.id} workspaceId={workspace.id} />
        )}
        {tab === "timeline" && (
          <NotBuiltYet
            title="Timeline"
            what="the project's milestones and journey stages on a time axis"
            why="the stage catalogue is already read on Overview; the time axis is the part that does not exist"
          />
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
  /** The repositories (`project-sources.ts`), as rows. */
  const [repos, setRepos] = useState<RepoEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await api.workspaceSettings(token, ws.id);
      setRepos(await projectRepoRows(token, ws.id).catch((): RepoEntry[] => []));
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
            {repos && repos.length > 0 ? ` · ${repos.length}` : ""}
          </h2>
          {onOpenStudio && (
            <button className="primary" onClick={() => onOpenStudio(ws)}>
              Open in IDE
            </button>
          )}
        </div>
        {!repos ? (
          <p className="empty">Loading…</p>
        ) : repos.length === 0 ? (
          <p className="empty">No repositories attached — add them on the Artifacts tab.</p>
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

/** `filters` is the side panel's; the list has its own search and model filter. */
function ChatsView({ token }: { token: string; filters?: Filters }) {
  const [chats, setChats] = useState<import("./api").Chat[] | null>(null);
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

  /** Throws, so the confirm dialog stays open with the reason. */
  async function remove(c: import("./api").Chat) {
    await api.deleteChat(token, c.id);
    if (open?.id === c.id) setOpen(null);
    await load();
  }
  const chatTitle = (c: import("./api").Chat) => c.title ?? c.id.slice(0, 8);

  return (
    <>
      <h1>Chats</h1>
      <p className="subtitle">
        mini-chat gear · models: {models.map((m) => m.display_name).join(", ") || "…"}
      </p>
      {error && <div className="error">{error}</div>}

      <div className="card">
        <DataTable<import("./api").Chat>
          list="chats"
          rows={chats === null && error ? [] : chats}
          error={chats === null ? error : null}
          onRetry={() => void load()}
          rowKey={(c) => c.id}
          rowLabel={chatTitle}
          onOpen={(c) => void openChat(c)}
          search={{ placeholder: "Search chats" }}
          searchText={(c) => [c.title, c.model, c.id]}
          filters={[
            {
              id: "model",
              allLabel: "Every model",
              kind: "select",
              options: models.map((m) => ({ value: m.model_id, label: m.display_name })),
              match: (c, v) => c.model === v,
            },
          ]}
          empty={{ title: "No chats yet.", body: "Start one from a project overview (Ask AI)." }}
          columns={[
            { id: "title", header: "Chat", compare: (a, b) => chatTitle(a).localeCompare(chatTitle(b)), cell: (c) => <div className="pname plain">{chatTitle(c)}</div> },
            { id: "model", header: "Model", cell: (c) => <span className="sub">{c.model}</span> },
            { id: "messages", header: "Messages", num: true, compare: (a, b) => a.message_count - b.message_count, cell: (c) => c.message_count },
            { id: "updated", header: "Updated", compare: (a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at), cell: (c) => <When iso={c.updated_at} /> },
          ]}
          actions={(c) => [
            { label: "Open", onSelect: () => openChat(c) },
            {
              label: "Delete",
              danger: { title: `Delete chat “${chatTitle(c)}”?`, body: "Its messages go with it.", confirmLabel: "Delete" },
              onSelect: () => remove(c),
            },
          ]}
        />
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

/** `filters` is the side panel's; the list has its own search. */
function FilesView({ token }: { token: string; filters?: Filters }) {
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
        <DataTable<import("./api").StoredFile>
          list="files"
          title="Files"
          rows={files === null && error ? [] : files}
          error={files === null ? error : null}
          rowKey={(f) => f.id}
          rowLabel={(f) => f.name ?? f.file_name ?? f.id}
          search={{ placeholder: "Search files" }}
          searchText={(f) => [f.name, f.file_name, f.id]}
          empty={{
            title: "Nothing stored yet.",
            body: "Files appear here once chats get attachments, or the upload sidecar is deployed.",
          }}
          columns={[
            {
              id: "name",
              header: "File",
              compare: (a, b) => (a.name ?? a.file_name ?? a.id).localeCompare(b.name ?? b.file_name ?? b.id),
              cell: (f) => <div className="name">{f.name ?? f.file_name ?? f.id}</div>,
            },
            { id: "id", header: "Id", cell: (f) => <code className="sub">{f.id}</code> },
          ]}
        />
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

function SystemView({
  token,
  filters,
  tenant,
  meId,
}: {
  token: string;
  filters: Filters;
  /** The caller, so the list can mark them and not offer to message them. */
  meId?: string;
  /** The shared-catalogue tenant a notification is sent from and to. Absent
   *  until one exists, and the panels then say so rather than rendering a form
   *  with nowhere to post. */
  tenant?: Workspace | null;
}) {
  const [notifyProviders, setNotifyProviders] = useState<ConnectorProvider[]>([]);
  const [notifyConnections, setNotifyConnections] = useState<Connection[]>([]);

  // The chat connectors the send panel needs. Tolerated failures: a build with
  // no connector driver answers 503, and that means "no chat targets", which
  // the panel already knows how to say.
  useEffect(() => {
    if (!tenant) return;
    let alive = true;
    void Promise.all([
      api.connectorProviders(token).then(
        (r) => r.items,
        () => [] as ConnectorProvider[],
      ),
      api.connections(token, tenant.id).then(
        (r) => r.items,
        () => [] as Connection[],
      ),
    ]).then(([p, c]) => {
      if (!alive) return;
      setNotifyProviders(p);
      setNotifyConnections(c);
    });
    return () => {
      alive = false;
    };
  }, [token, tenant]);

  const [gears, setGears] = useState<unknown>(null);
  const [upstreams, setUpstreams] = useState<unknown>(null);
  const [entities, setEntities] = useState<unknown>(null);

  // Domain-model upload: load a domain-entity document as the active model,
  // then materialize it as a graph — the studio-domain-model gear.
  const [modelImport, setModelImport] = useState<{
    entities: number;
    buckets: number;
    node_types: number;
    edge_types: number;
  } | null>(null);
  const [modelSync, setModelSync] = useState<{
    object_types: number;
    inherits: number;
    declares: number;
    skipped_endpoints: number;
  } | null>(null);
  const [modelErr, setModelErr] = useState<string | null>(null);
  const [modelBusy, setModelBusy] = useState(false);
  const [showGraph, setShowGraph] = useState(false);
  // Objects whose scope names no project: authorization treats them as
  // organization-wide (ADR-0035), so whoever owns the data should see them.
  const [legacy, setLegacy] = useState<Awaited<ReturnType<typeof api.domainLegacyScopes>> | null>(null);
  const onLegacyScopes = async () => {
    setModelErr(null);
    try {
      setLegacy(await api.domainLegacyScopes(token));
    } catch (e) {
      setModelErr(errText(e));
    }
  };
  // Changing the model needs `domain.model` (ADR-0035): an owner or a platform
  // administrator on the tenant model. The server refuses everyone else, so the
  // controls say so instead of failing. `null` until the answer arrives.
  const [canEditModel, setCanEditModel] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    api
      .domainModelTypes(token)
      .then((r) => alive && setCanEditModel(r.can_edit_model))
      .catch(() => alive && setCanEditModel(false));
    return () => {
      alive = false;
    };
  }, [token]);

  const onModelFile = async (file: File) => {
    setModelErr(null);
    setModelSync(null);
    setModelBusy(true);
    try {
      const ontology = JSON.parse(await file.text());
      setModelImport(await api.importDomainModel(token, ontology));
    } catch (e) {
      setModelErr(errText(e));
    } finally {
      setModelBusy(false);
    }
  };
  const onModelSync = async () => {
    setModelErr(null);
    setModelBusy(true);
    try {
      setModelSync(await api.syncDomainModel(token));
    } catch (e) {
      setModelErr(errText(e));
    } finally {
      setModelBusy(false);
    }
  };

  // Regenerate the model-UI file set from the stored model and download it as a
  // zip: one <bucket>/entities.json + <bucket>/buckets.json per bucket, plus
  // model-manifest.json — the shape the domain-model-ui app.js loads.
  const onRegenerate = async () => {
    setModelErr(null);
    setModelBusy(true);
    try {
      const { ontology } = await api.domainModelTypes(token);
      const entities = (ontology.entities ?? []) as Array<{ bucket?: string }>;
      const bucketDefs = (ontology.buckets ?? []) as Array<{ id?: string }>;
      const byBucket = new Map<string, unknown[]>();
      for (const e of entities) {
        const b = e.bucket ?? "domain";
        const arr = byBucket.get(b) ?? [];
        arr.push(e);
        byBucket.set(b, arr);
      }
      const files: { name: string; content: string }[] = [];
      const definitionFiles: string[] = [];
      for (const [bucket, ents] of byBucket) {
        files.push({ name: `${bucket}/entities.json`, content: JSON.stringify(ents, null, 2) });
        files.push({
          name: `${bucket}/buckets.json`,
          content: JSON.stringify(
            bucketDefs.filter((b) => b.id === bucket),
            null,
            2,
          ),
        });
        definitionFiles.push(`${bucket}/buckets.json`, `${bucket}/entities.json`);
      }
      files.push({
        name: "model-manifest.json",
        content: JSON.stringify({ metaFile: "core/meta.json", definitionFiles }, null, 2),
      });
      const url = URL.createObjectURL(makeZip(files));
      const a = document.createElement("a");
      a.href = url;
      a.download = "model-ui.zip";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setModelErr(errText(e));
    } finally {
      setModelBusy(false);
    }
  };

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

      {/* People before processes. Everything else on this page is about what
          the assembly is doing; this is about who is doing it, which is the
          question somebody opens an admin screen with. */}
      <WhoIsOnline token={token} meId={meId} />

      {/* Poking the assembly and watching what comes out belongs with watching
          it: a notification is the one gear behaviour you can trigger by hand
          and then see land. It used to sit on Connectors, next to the chat
          connector that makes it work — which explained the dependency and
          misfiled the action. */}
      {tenant ? (
        <Notifications
          token={token}
          tenantId={tenant.id}
          projectId={tenant.id}
          projectName={tenant.name}
          connections={notifyConnections}
          providers={notifyProviders}
        />
      ) : (
        <div className="card">
          <h2>Send a notification</h2>
          <p className="empty">
            No shared catalogue tenant yet, so there is nowhere to send from. One appears with the
            first organization.
          </p>
        </div>
      )}

      <div className="card">
        <h2>Privileges ({permissions.length} permissions registered)</h2>
        <p className="error" style={{ marginBottom: 10 }}>
          Enforcement: static allow-all — the PDP is not wired yet (ADR-0004 P3). Access is
          governed by tenant scope + self-managed barriers only; the permissions below are the
          registered vocabulary the future PDP and Role Grants will enforce.
        </p>
        <PermissionsTable data={entities} />
      </div>

      <div className="card">
        <h2>Domain model</h2>
        <p className="hint">
          Upload a domain-entity document (the shape <code>GET /studio-domain-model/v1/types</code>{" "}
          returns) to load it as the active model, then materialize it as a graph — the
          studio-domain-model gear registers its GTS types in Graph Storage.
        </p>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
          <input
            type="file"
            accept=".json,application/json"
            disabled={modelBusy || canEditModel !== true}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onModelFile(f);
            }}
          />
          <button
            disabled={modelBusy || !modelImport || canEditModel !== true}
            onClick={() => void onModelSync()}
          >
            Sync to graph
          </button>
          <button disabled={modelBusy} onClick={() => void onRegenerate()}>
            Regenerate frontend
          </button>
          <button onClick={() => void onLegacyScopes()}>Check scopes</button>
          <button onClick={() => setShowGraph((v) => !v)}>
            {showGraph ? "Hide graph" : "View graph"}
          </button>
        </div>
        {canEditModel === false && (
          <p className="hint" style={{ marginTop: 10 }}>
            Only the organization's owner (or whoever holds <code>domain.model</code>) can load or
            sync a model. Viewing and regenerating stay open.
          </p>
        )}
        {legacy && (
          <div style={{ marginTop: 10 }}>
            {legacy.total === 0 ? (
              <p className="hint">
                Every scoped object names a project ({legacy.scanned} objects read
                {legacy.complete ? "" : ", not all of them"}).
              </p>
            ) : (
              <>
                <p className="hint">
                  <b>{legacy.total}</b> objects carry a scope that is not a project, so no project
                  grant reaches them; they are organization-wide
                  {legacy.complete ? "" : ` (of the first ${legacy.scanned} read)`}.
                </p>
                <ul style={{ margin: 0, fontSize: 12 }}>
                  {legacy.items.slice(0, 50).map((o) => (
                    <li key={o.instance_id}>
                      <code>{o.scope}</code> · {o.entity} · {o.name ?? o.instance_id}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>
        )}
        {modelErr && (
          <p className="error" style={{ marginTop: 10 }}>
            {modelErr}
          </p>
        )}
        {modelImport && (
          <p style={{ marginTop: 10 }}>
            Loaded <b>{modelImport.entities}</b> entities · {modelImport.buckets} buckets ·{" "}
            {modelImport.node_types} node types · {modelImport.edge_types} edge types.
          </p>
        )}
        {modelSync && (
          <p>
            Synced graph: <b>{modelSync.object_types}</b> object-type nodes · {modelSync.inherits}{" "}
            inherits · {modelSync.declares} declares · {modelSync.skipped_endpoints} skipped.
          </p>
        )}
        {showGraph && (
          <div style={{ marginTop: 14 }}>
            <DomainModelGraph token={token} />
          </div>
        )}
      </div>

      {visibleCards.length === 0 && (
        <p className="empty">All sections are hidden — enable them in the filter panel.</p>
      )}
      {visibleCards.map((c) => (
        <div className="card" key={c.title}>
          <h2>{c.title}</h2>
          <p className="hint">{c.sub}</p>
          {c.key === "entities" ? (
            <GtsEntitiesTable data={c.data} />
          ) : c.key === "gears" ? (
            <GearsTable data={c.data} />
          ) : (
            <pre style={{ overflow: "auto", fontSize: 12, maxHeight: 260 }}>
              {JSON.stringify(c.data, null, 2)}
            </pre>
          )}
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
          <a href="/api-docs/" target="_blank" rel="noopener noreferrer">
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
          const [s, own] = await Promise.all([
            api.workspaceSettings(token, ws.id).catch(() => null),
            projectRepoRows(token, ws.id).catch((): RepoEntry[] => []),
          ]);
          const add = (ref?: string | null, what = "") => {
            const r = ref?.trim();
            if (!r) return;
            if (!map.has(r)) map.set(r, new Set());
            map.get(r)?.add(`${ws.name}${what}`);
          };
          add(s?.root_token_ref, " (project root)");
          // A repository's token is its connection's.
          for (const repo of own) add(repo.token_ref, ` / ${repo.name}`);
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
}: {
  token: string;
  workspaces: Workspace[];
  /** The side panel's; the list has its own search. */
  filters?: Filters;
}) {
  const rows = useKnownSecretRefs(token, workspaces);
  // The reference whose new value is being typed, under its row.
  const [rotating, setRotating] = useState<string | null>(null);
  const [newValue, setNewValue] = useState("");
  const [status, setStatus] = useState<Record<string, "ok" | "broken" | "checking">>({});
  const [error, setError] = useState<string | null>(null);

  async function check(ref: string) {
    setStatus((s) => ({ ...s, [ref]: "checking" }));
    const r = await api.checkSecret(token, ref);
    setStatus((s) => ({ ...s, [ref]: r }));
  }

  async function rotate(ref: string) {
    const value = newValue.trim();
    if (!value) return;
    setError(null);
    try {
      await api.putSecret(token, ref, value, PAT_SECRET_TYPE);
      setRotating(null);
      setNewValue("");
      await check(ref);
    } catch (e) {
      setError(errText(e));
    }
  }

  return (
    <>
      <h1>Secrets</h1>
      <p className="subtitle">
        Repository credentials in the credstore gear. Values are write-only; this view lists the
        references known to project settings, probes their health, and rotates broken ones
        (the store has no list API — anything saved outside the portal won't appear here).
      </p>
      <div className="card">
        <DataTable<{ ref: string; usedBy: string[] }>
          list="secrets"
          rows={rows}
          rowKey={(r) => r.ref}
          rowLabel={(r) => r.ref}
          search={{ placeholder: "Search secrets" }}
          searchText={(r) => [r.ref, ...r.usedBy]}
          empty={{ title: "No secret references found in any project settings." }}
          columns={[
            { id: "ref", header: "Reference", compare: (a, b) => a.ref.localeCompare(b.ref), cell: (r) => <code>{r.ref}</code> },
            { id: "used", header: "Used by", cell: (r) => <span className="sub">{r.usedBy.join(", ")}</span> },
            {
              id: "health",
              header: "Health",
              cell: (r) =>
                status[r.ref] === "ok" ? (
                  <span className="badge workspace">readable</span>
                ) : status[r.ref] === "broken" ? (
                  <span className="badge selfmanaged" title="Exists but unreadable (or missing) — rotate to heal">
                    broken
                  </span>
                ) : (
                  <span className="sub">{status[r.ref] === "checking" ? "checking…" : "not checked"}</span>
                ),
            },
          ]}
          inline={(r) => (
            <button className="ghost" disabled={status[r.ref] === "checking"} onClick={() => void check(r.ref)}>
              Check
            </button>
          )}
          actions={(r) => [
            {
              label: "Rotate",
              onSelect: () => {
                setNewValue("");
                setRotating(rotating === r.ref ? null : r.ref);
              },
            },
            {
              label: "Delete",
              danger: {
                title: `Delete secret “${r.ref}”?`,
                body: "Project settings keep the reference, and launches clone without credentials until a new value is saved.",
                confirmLabel: "Delete",
              },
              onSelect: async () => {
                await api.deleteSecret(token, r.ref);
                setStatus((st) => ({ ...st, [r.ref]: "broken" }));
              },
            },
          ]}
          detail={(r) =>
            rotating === r.ref ? (
              <form
                className="inline"
                onSubmit={(e) => {
                  e.preventDefault();
                  void rotate(r.ref);
                }}
              >
                <input
                  type="password"
                  autoFocus
                  aria-label={`New value for ${r.ref}`}
                  placeholder="New value, e.g. a fresh PAT"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  style={{ minWidth: 280 }}
                />
                <button className="primary" disabled={!newValue.trim()}>
                  Save
                </button>
                <button type="button" className="ghost" onClick={() => setRotating(null)}>
                  Cancel
                </button>
              </form>
            ) : null
          }
        />
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
  {
    key: "notification",
    title: "Notifications",
    blurb:
      "Where Studio tells people what happened: Slack, Zulip or Discord. A bot token reaches " +
      "every channel it was invited to; an incoming webhook posts to the one channel its URL " +
      "was created for.",
  },
];

/** Where a connection is attached, and how widely its token is readable.
 *  One choice sets both: the tenant holding the catalogue row (its reach) and
 *  the credstore sharing mode of the token (who may read it). */
type Reach = "organization" | "workspace" | "personal";

/** The project's current sources (workspace repos) with detach + Open in IDE, so
 *  the Sources tab shows the RESULT of attaching, not only the connectors. */
/** Attach chosen remote repositories to a project: into its config's
 *  `sources` (`project-sources.ts`), the record every session clones from and
 *  both portals read. Shared by the Sources-tab repository browser and the
 *  "Pick from a connector…" picker. The connection is named by id; its token
 *  stays server-side. `shareMode` is how "Share with the team" in the IDE
 *  lands edits in them. Returns how many were added. */
async function attachReposToWorkspace(
  token: string,
  ws: Workspace,
  connection: Connection,
  picks: RemoteRepo[],
  shareMode: ShareMode = "branch",
): Promise<number> {
  const current = (await api.projectConfig(token, ws.id)) ?? {};
  const { sources, added } = withPicked(current.sources, connection, picks, shareMode);
  if (added > 0) await api.putProjectConfig(token, ws.id, { ...current, sources });
  return added;
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
}: {
  token: string;
  workspace: Workspace;
  /** The parent workspace tenant id. `workspace` here is the project tenant;
   *  ProjectFiles tags BOTH onto every file it adds so the graph can scope to
   *  either level. Still needed after Sources moved out — dropping it would
   *  silently start writing files that only the project can see. */
  parentWorkspaceId?: string;
}) {
  // Was bumped after every sync, back when the sync button was on this page.
  // It is a Sources action now, and this list re-reads on mount — which is the
  // only moment it can have changed, because you have to leave to run one.
  const [refreshKey] = useState(0);
  /** Which origin's artifacts are showing. Synced is the default because it is
   *  where nearly everything is; hand-added files are the exception. */
  const [origin, setOrigin] = useState<"ingested" | "manual">("ingested");
  return (
    <>
      <h1>Artifacts</h1>
      <p className="subtitle">
        Everything this project knows about its own work. The repositories it came from are on the
        Sources tab.
      </p>
      {/* Where an artifact CAME FROM is the first thing to choose, because it
          decides everything after it: a synced artifact has a forge, an author
          and a state, and a hand-added file has bytes and a version. They were
          two stacked cards, which put a nine-thousand-row table above a
          usually-empty one and made the second easy to miss entirely. */}
      <div className="doc-views" role="tablist" aria-label="Where artifacts came from">
        <button
          role="tab"
          aria-selected={origin === "ingested"}
          className={origin === "ingested" ? "doc-view on" : "doc-view"}
          onClick={() => setOrigin("ingested")}
        >
          From repositories
        </button>
        <button
          role="tab"
          aria-selected={origin === "manual"}
          className={origin === "manual" ? "doc-view on" : "doc-view"}
          onClick={() => setOrigin("manual")}
        >
          Added by hand
        </button>
      </div>
      {origin === "ingested" ? (
        <IngestedArtifacts
          token={token}
          scope={workspace.id}
          target={workspace}
          refreshKey={refreshKey}
        />
      ) : (
        <ProjectFiles token={token} workspace={workspace} parentWorkspaceId={parentWorkspaceId} />
      )}
    </>
  );
}

/** The ingested-artifacts viewer: issues and pull requests pulled from the
 *  attached sources by the artifact-ingest gear and read back from the graph
 *  store. Reloads whenever `refreshKey` changes (i.e. after a Sync). */
/** The node types a repository sync actually writes into the graph.
 *
 *  Three of these were being ingested and never shown. On the development graph
 *  at the time of writing: 8529 files, 5227 COMMENTS, 4965 COMMITS, 2210
 *  issues, 800 pull requests, 89 AUTHORS. The sync task has always reported
 *  `comments` and `commits` in its progress counts (see api.artifactSyncTask) —
 *  the work was done, the door was just missing. Roughly ten thousand nodes
 *  were unreachable from the portal.
 *
 *  `user` is last because it is a by-product: authors are extracted so issues
 *  and commits can point at a person, not because anybody browses them. */
type ArtTab = "issue" | "pull_request" | "commit" | "comment" | "file" | "user";

const ART_TABS: { id: ArtTab; label: string; plural: string }[] = [
  { id: "issue", label: "Issues", plural: "issues" },
  { id: "pull_request", label: "Pull requests", plural: "pull requests" },
  { id: "commit", label: "Commits", plural: "commits" },
  { id: "comment", label: "Comments", plural: "comments" },
  { id: "file", label: "Files", plural: "files" },
  { id: "user", label: "Authors", plural: "authors" },
];

/** One column of the artifact table. `render` gets the node's payload. */
interface ArtColumn {
  key: string;
  label: string;
  /** Right-aligned, tabular — for counts and sizes. */
  num?: boolean;
  render: (v: import("./api").ArtifactNode["value"]) => ReactNode;
}

/** Truncate a body to something that fits a table cell. Comments are the reason
 *  this exists: a CodeRabbit review body is kilobytes of markdown, and pasting
 *  it into a row makes the row taller than the viewport. */
function excerpt(s: unknown, max = 120): string {
  const text = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  if (!text) return "—";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const ART_COLUMNS: Record<ArtTab, ArtColumn[]> = {
  issue: [
    { key: "title", label: "Title", render: (v) => `${v.number != null ? `#${v.number} ` : ""}${v.title ?? "(untitled)"}` },
    { key: "state", label: "State", render: (v) => String(v.state ?? "—") },
    { key: "author", label: "Author", render: (v) => String(v.author ?? "—") },
    { key: "labels", label: "Labels", render: (v) => (Array.isArray(v.labels) && v.labels.length ? v.labels.join(", ") : "—") },
    { key: "updated", label: "Updated", render: (v) => <When iso={v.updated_at as string | undefined} /> },
  ],
  pull_request: [
    { key: "title", label: "Title", render: (v) => `${v.number != null ? `#${v.number} ` : ""}${v.title ?? "(untitled)"}` },
    { key: "state", label: "State", render: (v) => (v.merged ? "merged" : String(v.state ?? "—")) },
    { key: "author", label: "Author", render: (v) => String(v.author ?? "—") },
    { key: "branches", label: "Branches", render: (v) => (v.source_branch ? `${v.source_branch} → ${v.target_branch ?? "?"}` : "—") },
    // Only open pull requests carry a count — a merged one is nobody's queue,
    // and the sync leaves it unset rather than writing a zero that would read
    // as "reviewed and clear".
    {
      key: "open_threads",
      label: "Open threads",
      num: true,
      render: (v) => {
        const open = (v as Record<string, unknown>).open_threads;
        return typeof open === "number" ? String(open) : "—";
      },
    },
    { key: "updated", label: "Updated", render: (v) => <When iso={v.updated_at as string | undefined} /> },
  ],
  commit: [
    { key: "title", label: "Message", render: (v) => excerpt(v.title ?? (v as Record<string, unknown>).message, 90) },
    { key: "sha", label: "SHA", render: (v) => <code>{String((v as Record<string, unknown>).short_sha ?? "").slice(0, 7) || "—"}</code> },
    { key: "author", label: "Author", render: (v) => String((v as Record<string, unknown>).author_name ?? v.author ?? "—") },
    { key: "created", label: "Committed", render: (v) => <When iso={(v as Record<string, unknown>).created_at as string | undefined} /> },
  ],
  comment: [
    { key: "body", label: "Comment", render: (v) => excerpt((v as Record<string, unknown>).body) },
    { key: "on", label: "On", render: (v) => { const n = (v as Record<string, unknown>).target_number; return n != null ? `#${n}` : "—"; } },
    { key: "author", label: "Author", render: (v) => String(v.author ?? "—") },
    { key: "created", label: "Written", render: (v) => <When iso={(v as Record<string, unknown>).created_at as string | undefined} /> },
  ],
  file: [
    { key: "path", label: "Path", render: (v) => <code>{String(v.path ?? "(no path)")}</code> },
    { key: "size", label: "Size", num: true, render: (v) => (typeof v.size === "number" ? `${(v.size / 1024).toFixed(1)} KB` : "—") },
    { key: "sha", label: "SHA", render: (v) => <code>{v.sha ? String(v.sha).slice(0, 7) : "—"}</code> },
  ],
  user: [
    { key: "login", label: "Login", render: (v) => String((v as Record<string, unknown>).login ?? v.title ?? "—") },
    { key: "provider", label: "Provider", render: (v) => String(v.provider ?? "—") },
  ],
};

function IngestedArtifacts({
  token,
  scope,
  target,
  refreshKey,
}: {
  token: string;
  /** Project tenant id — reads are scoped to it so the list shows only this
   *  project's ingested artifacts, not every repo across the org. */
  scope?: string;
  /** The project the IDE opens against when a row is handed off to it. */
  target: StudioTarget;
  refreshKey: number;
}) {
  const studio = useStudioBridge();
  const [repos, setRepos] = useState<import("./api").ArtifactNode[]>([]);
  const [tab, setTab] = useState<ArtTab>("issue");
  const [tick, setTick] = useState(0);

  // The repositories in scope, for the repository filter.
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

  // The backend pages, searches and filters; newest first is the order it
  // offers, so it is the list's order and no header pretends to sort.
  const load = useCallback(
    async (req: PageRequest): Promise<PageResult<import("./api").ArtifactNode>> => {
      const r = await api.listArtifactNodes(token, tab, scope, undefined, req.limit, {
        repo: req.filters.repo || undefined,
        sort: "updated",
        q: req.q || undefined,
        offset: req.offset,
      });
      return { items: r.nodes ?? [], total: r.total ?? (r.nodes?.length ?? 0) };
    },
    [token, tab, scope],
  );

  /** What a row is for: a file opens in the editor, anything else where it
   *  came from. A commit or a comment has no meaning inside the IDE. */
  const openNode = (n: import("./api").ArtifactNode) => {
    const path = typeof n.value.path === "string" ? n.value.path : "";
    const url = typeof n.value.url === "string" ? n.value.url : undefined;
    if (tab === "file" && path) void studio?.openFile(target, path);
    else if (url) window.open(url, "_blank", "noreferrer");
  };
  const opens = (n: import("./api").ArtifactNode) =>
    (tab === "file" && typeof n.value.path === "string" && !!n.value.path) || typeof n.value.url === "string";

  const plural = ART_TABS.find((t) => t.id === tab)?.plural ?? "artifacts";

  return (
    <div className="card">
      <p className="hint">
        Issues, pull requests and repository files pulled from the attached sources by Sync. Stored
        in the graph as typed GTS nodes — this reads them back.
      </p>
      <div className="doc-views" role="tablist" aria-label="Artifact kind">
        {ART_TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "doc-view on" : "doc-view"}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <DataTable<import("./api").ArtifactNode>
        key={tab}
        list="artifacts"
        title="Ingested"
        load={load}
        reloadKey={`${refreshKey}:${tick}`}
        rowKey={(n) => n.instance_id}
        rowLabel={(n) => String(n.value.title ?? n.value.path ?? n.instance_id)}
        onOpen={openNode}
        canOpen={opens}
        search={{ placeholder: "Search title / author…" }}
        filters={[
          {
            id: "repo",
            allLabel: "All repositories",
            kind: "select",
            options: repos.map((r) => ({
              value: r.instance_id,
              label: String(r.value.full_path ?? r.value.name ?? r.instance_id),
            })),
          },
        ]}
        primary={
          <>
            {/* Launches the session if none is running — the graph is one
                click from here whether or not the IDE is already open. */}
            <button
              className="ghost"
              onClick={() => void studio?.openGraph(target)}
              disabled={!studio || studio.opening === target.id}
              title="Open the Workspace Graph in the Studio IDE"
            >
              {studio?.opening === target.id ? "Opening Studio…" : "Open graph in Studio"}
            </button>
            <button className="ghost" onClick={() => setTick((t) => t + 1)}>
              Refresh
            </button>
          </>
        }
        empty={{ title: `Nothing ingested yet.`, body: `Sync a repository in Sources to pull its ${plural}.` }}
        columns={ART_COLUMNS[tab].map((c, i) => ({
          id: c.key,
          header: c.label,
          num: c.num,
          className: !c.num && i === 0 ? "acell-lead" : undefined,
          cell: (n: import("./api").ArtifactNode) => c.render(n.value),
        }))}
        inline={(n) => {
          const path = typeof n.value.path === "string" ? n.value.path : "";
          const url = typeof n.value.url === "string" ? n.value.url : undefined;
          return tab === "file" && path ? (
            <button
              className="ghost"
              onClick={() => void studio?.openFile(target, path)}
              disabled={!studio || studio.opening === target.id}
              title="Open this file in the Studio editor"
            >
              Open in editor
            </button>
          ) : url ? (
            <a className="ghost" href={url} target="_blank" rel="noreferrer">
              Open ↗
            </a>
          ) : null;
        }}
        tile={(n, open) => {
          const [lead, second, ...rest] = ART_COLUMNS[tab];
          return (
            <VTile
              title={lead.render(n.value)}
              subtitle={second?.render(n.value)}
              stats={rest.slice(0, 3).map((c) => ({ label: c.label, value: c.render(n.value) }))}
              onClick={opens(n) ? open : undefined}
            />
          );
        }}
      />
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
      // only hand-added files. Every page, not the first: a hand-added file
      // past it used to be invisible, among a repository's thousands.
      const nodes: import("./api").ArtifactNode[] = [];
      for (let offset = 0; offset < 20_000; ) {
        const page = await api.listArtifactNodes(token, "file", workspace.id, undefined, 200, { offset });
        nodes.push(...(page.nodes ?? []));
        offset += page.nodes?.length ?? 0;
        if (!page.nodes?.length || offset >= (page.total ?? 0)) break;
      }
      const mine = nodes
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
      {err && files !== null && <p className="error">{err}</p>}
      <DataTable<NonNullable<typeof files>[number]>
        list="project-files"
        urlPrefix="files."
        rows={files === null && err ? [] : files}
        error={files === null ? err : null}
        onRetry={() => void reload()}
        rowKey={(f) => f.id}
        rowLabel={(f) => f.path}
        search={{ placeholder: "Search files" }}
        searchText={(f) => [f.path]}
        empty={{ title: "No files yet.", body: "Use “Add file…” to attach one." }}
        columns={[
          { id: "path", header: "File", compare: (a, b) => a.path.localeCompare(b.path), cell: (f) => <div className="name">{f.path}</div> },
          {
            id: "size",
            header: "Size",
            num: true,
            compare: (a, b) => (a.size ?? -1) - (b.size ?? -1),
            cell: (f) => (typeof f.size === "number" ? `${(f.size / 1024).toFixed(1)} KB` : "—"),
          },
          { id: "version", header: "Version", cell: (f) => <span className="sub">{f.version_id ? `${f.version_id.slice(0, 8)}…` : "—"}</span> },
        ]}
      />
    </div>
  );
}

/** The product's source glyph: a branch forking off a trunk. Inline rather
 *  than in the shared icon set, because nothing else asks for it. */
function GitBranchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="7" cy="5" r="2.2" />
      <circle cx="7" cy="19" r="2.2" />
      <circle cx="17" cy="9" r="2.2" />
      <path d="M7 7.2v9.6M17 11.2c0 3-2.6 4.4-5.6 4.8" />
    </svg>
  );
}

/** Seven bars, one per day, oldest on the left.
 *
 *  Drawn rather than charted: the question is "is anything happening here",
 *  and a library that answers it costs more than the answer. Heights are
 *  relative to this row's own busiest day — a repository with one commit a day
 *  should look steady, not flat next to one with forty. */
function Spark({ days }: { days: number[] }) {
  const peak = Math.max(1, ...days);
  const total = days.reduce((a, b) => a + b, 0);
  return (
    <span
      className="spark"
      role="img"
      aria-label={`${total} pull request${total === 1 ? "" : "s"} moved in the last ${days.length} days`}
      title={days.map((n, i) => `${days.length - i}d ago: ${n}`).join("\n")}
    >
      {days.map((n, i) => (
        <span key={i} className="spark-col">
          {/* An empty day keeps a 1px rule rather than nothing, so the axis
              stays visible and a quiet week reads as quiet, not as missing. */}
          <span
            className={n > 0 ? "spark-bar" : "spark-bar none"}
            style={{ height: n > 0 ? `${Math.max(18, (n / peak) * 100)}%` : "1px" }}
          />
        </span>
      ))}
    </span>
  );
}

/** How a source's shared edits read on its row; nothing for the default. */
function shareModeText(mode: RepoEntry["share_mode"]): string {
  return mode === "pull_request" ? " · shared through a pull request" : "";
}

/** "How changes are shared" for the repositories about to be attached: straight
 *  to the branch (what every source did before the choice existed), or through
 *  a pull request — offered only where the connection can open one. */
function ShareModeSelect({
  value,
  onChange,
  connection,
}: {
  value: ShareMode;
  onChange: (mode: ShareMode) => void;
  connection: Connection | null;
}) {
  const pullRequests = supportsPullRequests(connection);
  return (
    <label className="sub" title="How “Share with the team” in the IDE lands edits in these repositories">
      Changes:{" "}
      <select value={value} onChange={(e) => onChange(e.target.value as ShareMode)}>
        <option value="branch">Commit to the branch</option>
        <option value="pull_request" disabled={!pullRequests}>
          Through a pull request{pullRequests ? "" : " (GitHub only)"}
        </option>
      </select>
    </label>
  );
}

/** Where a row's "Changes" save stands: the mode being written, and whether
 *  the write failed. Nothing for a row at rest. */
type ShareSave = { mode: ShareMode; failed: boolean };

/** A source's "Changes" on the Sources list: how "Share with the team" in the
 *  IDE lands edits in it, changed in place. Saves on change. A pull request is
 *  offered only where the row's connection is GitHub — `asRows` names the
 *  row's source after its connection's provider, and a connection not visible
 *  from here is not GitHub as far as this row can tell. */
function SourceShareMode({
  row,
  save,
  onChange,
}: {
  row: RepoEntry;
  save: ShareSave | undefined;
  onChange: (mode: ShareMode) => void;
}) {
  const pullRequests = supportsPullRequests({ provider: row.source });
  const saving = !!save && !save.failed;
  return (
    <span className="src-share">
      <select
        aria-label={`How changes to ${row.name} are shared`}
        title="How “Share with the team” in the IDE lands edits in this repository"
        value={saving ? save.mode : (row.share_mode ?? "branch")}
        disabled={saving}
        onChange={(e) => onChange(e.target.value as ShareMode)}
      >
        <option value="branch">Commit to the branch</option>
        <option value="pull_request" disabled={!pullRequests && row.share_mode !== "pull_request"}>
          Through a pull request{pullRequests ? "" : " (GitHub only)"}
        </option>
      </select>
      {saving && <span className="sub">saving…</span>}
      {save?.failed && <span className="sub src-share-failed">not saved</span>}
    </span>
  );
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
  /** The `repo` nodes the graph holds for this project — what a sync left
   *  behind, keyed by full path rather than by name. */
  const [repoNodes, setRepoNodes] = useState<import("./api").ArtifactNode[]>([]);
  /** A week of pull-request and commit movement per repo node id, folded out
   *  of the graph. Empty until the walk below finishes, and empty for good on
   *  a project whose sources have never been synced. */
  const [activity, setActivity] = useState<Record<string, RepoActivity>>({});
  /** How many of the project's specs came out of each repository, keyed by
   *  repo node id. A binding carries a repo-RELATIVE path and nothing else, so
   *  this is joined through the file node, which knows where it came from. */
  const [specsPerRepo, setSpecsPerRepo] = useState<Record<string, number>>({});
  /** Whether the specs could be counted at all. False means every count is
   *  MISSING rather than zero — the column then reads "—" for every row. */
  const [specsKnown, setSpecsKnown] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  // Per-repo artifact-sync progress, keyed by repo name.
  const [sync, setSync] = useState<Record<string, SyncProgress>>({});

  const syncRepo = async (r: RepoEntry) => {
    // Nodes land in the graph as the sync runs, so refresh the ingested list
    // whenever the stored count climbs (and once at the end) rather than on
    // every poll tick.
    let lastStored = -1;
    const scope = { workspaceId: parentWorkspaceId ?? ws.id, projectId: ws.id };
    // Whatever an earlier attachment left behind goes first, so this sync is
    // not listed beside it. Best-effort: a failed prune is retried by the
    // next sync, and must not stop this one.
    if (repos) await pruneDetached(token, repos, scope).catch(() => undefined);
    await runRepoSync(token, r, scope, (p) => {
      setSync((s) => ({ ...s, [r.name]: p }));
      if (!p.running || p.stored > lastStored) {
        lastStored = p.stored;
        onSynced?.();
      }
    });
  };

  const reload = useCallback(async () => {
    setRepos(await projectRepoRows(token, ws.id).catch(() => []));
    // The graph's side of a source: present once it has been synced at least
    // once, carrying when that was and what came in. This used to be readable
    // only from the Overview card, which is why that card existed at all —
    // without it a source that has never been synced looks exactly like one
    // that synced this morning.
    try {
      const page = await api.listArtifactNodes(token, "repo", ws.id, undefined, 200);
      setRepoNodes(page.nodes ?? []);
    } catch {
      // Ingest not deployed: the rows still list what is attached, and simply
      // cannot say when it was last pulled.
      setRepoNodes([]);
    }

    // A week of movement per repository, folded by the gear that owns the
    // nodes. This used to be two paged walks from here — commits outnumber
    // everything else in a repository, and each page was a slice of the
    // tenant's whole typed node set.
    try {
      const page = await api.sourceActivity(token, ws.id);
      const byRepo: Record<string, RepoActivity> = {};
      for (const row of page.items) byRepo[row.repo] = row;
      setActivity(byRepo);
    } catch {
      // The columns read as "—" rather than as zero: nothing was counted, and
      // nothing counted is not the same as nothing happened.
      setActivity({});
    }

    // Specs per source, counted by the gear that holds the bindings — it asks
    // the artifact graph for the file→repository map itself. This page used to
    // page the whole file listing to build that map, then read every binding.
    try {
      const page = await api.specsPerSource(token, ws.id);
      const counts: Record<string, number> = {};
      for (const row of page.items) counts[row.repo] = row.specs;
      setSpecsPerRepo(counts);
      setSpecsKnown(page.files_known);
    } catch {
      // The column reads as "—" rather than as zero: nothing was counted, and
      // nothing counted is not the same as nothing found.
      setSpecsPerRepo({});
      setSpecsKnown(false);
    }
  }, [token, ws.id, parentWorkspaceId]);

  /** Matched on the parsed full path, not on the directory name: the name is a
   *  local choice, the full path is the repository's identity. */
  const graphRepo = (r: RepoEntry): import("./api").ArtifactNode | undefined =>
    findRepoNode(repoNodes, r);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Detach a repository: out of the project's config, and out of the graph
   *  with it (the graph keeps what was synced until it is told otherwise).
   *  Throws, so the confirm dialog stays open with the reason. */
  const detach = async (name: string) => {
    setErr(null);
    const config = (await api.projectConfig(token, ws.id)) ?? {};
    await api.putProjectConfig(token, ws.id, { ...config, sources: without(config.sources, name) });
    const remaining = (repos ?? []).filter((r) => r.name !== name);
    await pruneDetached(token, remaining, {
      workspaceId: parentWorkspaceId ?? ws.id,
      projectId: ws.id,
    });
    await reload();
  };

  /** "Changes" per row, keyed by repo name, while a save is out or after one
   *  failed. */
  const [shareSaves, setShareSaves] = useState<Record<string, ShareSave>>({});

  /** Change how one source is shared: the config read fresh, that entry's
   *  `share_mode` changed and nothing else, written back — the same
   *  read-modify-write that attach and detach do. */
  const changeShareMode = async (name: string, mode: ShareMode) => {
    setShareSaves((s) => ({ ...s, [name]: { mode, failed: false } }));
    try {
      const config = (await api.projectConfig(token, ws.id)) ?? {};
      await api.putProjectConfig(token, ws.id, { ...config, sources: withShareMode(config.sources, name, mode) });
      await reload();
      setShareSaves((s) => {
        const next = { ...s };
        delete next[name];
        return next;
      });
    } catch {
      setShareSaves((s) => ({ ...s, [name]: { mode, failed: true } }));
    }
  };

  const syncLabel = (r: RepoEntry) => {
    const live = sync[r.name];
    return live?.running ? "…" : graphRepo(r) ? "Re-sync" : "Sync";
  };
  const repoUrl = (r: RepoEntry) => (r.url && /^https?:\/\//.test(r.url) ? r.url.replace(/\.git$/, "") : undefined);

  return (
    <div className="card">
      <p className="hint">
        Repositories cloned into the workspace when a session launches. Add one by picking it from a
        connector — connectors are set up in Connections.
      </p>
      <DataTable<RepoEntry>
        list="sources"
        title="Repositories"
        rows={repos}
        error={repos === null ? err : null}
        onRetry={() => void reload()}
        rowKey={(r) => r.name}
        rowLabel={(r) => r.name}
        onOpen={(r) => window.open(repoUrl(r), "_blank", "noreferrer")}
        canOpen={(r) => !!repoUrl(r)}
        primary={
          (repos?.length ?? 0) > 0 && onOpenStudio ? (
            <button className="primary" onClick={() => onOpenStudio(ws)}>
              Open in IDE
            </button>
          ) : null
        }
        empty={{
          title: "No repositories attached yet.",
          body: "Pick one from a connector below.",
        }}
        columns={[
          {
            id: "name",
            header: "Source",
            className: "acell-lead",
            compare: (a, b) => a.name.localeCompare(b.name),
            cell: (r) => (
              <>
                <span className="src-ico" aria-hidden>
                  <GitBranchIcon />
                </span>
                <span>
                  <span className="src-name">{r.name}</span>
                  <span className="sub">Repository{r.branch ? ` · ${r.branch}` : ""}</span>
                </span>
              </>
            ),
          },
          {
            id: "share",
            header: "Changes",
            cell: (r) => (
              <SourceShareMode
                row={r}
                save={shareSaves[r.name]}
                onChange={(mode) => void changeShareMode(r.name, mode)}
              />
            ),
          },
          {
            // The product shows a role here. Nothing in the model assigns one
            // to a source, so this says what the source IS.
            id: "role",
            header: "Role",
            cell: (r) => (
              <>
                <span className="src-dot" aria-hidden />
                {r.source}
              </>
            ),
          },
          {
            // Counted and none is 0; not counted is "—" (`files_known`).
            id: "specs",
            header: "Specs",
            num: true,
            cell: (r) => rollupText(specsKnown ? (specsPerRepo[graphRepo(r)?.instance_id ?? ""] ?? 0) : null),
          },
          {
            id: "prs",
            header: "Pull requests · 7 days",
            cell: (r) => {
              const node = graphRepo(r);
              const act = node ? activity[node.instance_id] : undefined;
              return act ? (
                <div className="src-prs">
                  <div className="src-pr-counts">
                    <span className="src-open">{act.open} open</span>
                    <span className="sub">{act.merged} merged</span>
                  </div>
                  <Spark days={act.days} />
                </div>
              ) : (
                <span className="ing-dash">—</span>
              );
            },
          },
          {
            id: "commits",
            header: "Commits · 7 days",
            num: true,
            cell: (r) => {
              const node = graphRepo(r);
              const act = node ? activity[node.instance_id] : undefined;
              return act ? act.commits : <span className="ing-dash">—</span>;
            },
          },
          {
            id: "synced",
            header: "Last sync",
            cell: (r) => {
              const live = sync[r.name];
              const syncedAt = graphRepo(r)?.value.synced_at as string | undefined;
              if (live?.running) return <span className="sub">{live.line}</span>;
              return syncedAt ? <When iso={syncedAt} /> : <span className="sub">never</span>;
            },
          },
        ]}
        inline={(r) => (
          <button
            className="ghost"
            title="Clone this source and pull its issues, pull requests and files into the graph"
            disabled={!!sync[r.name]?.running}
            onClick={() => void syncRepo(r)}
          >
            {syncLabel(r)}
          </button>
        )}
        actions={(r) => [
          ...(repoUrl(r) ? [{ label: "Open repository", onSelect: () => window.open(repoUrl(r), "_blank", "noreferrer") }] : []),
          {
            label: "Detach",
            danger: {
              title: `Detach “${r.name}”?`,
              body:
                "It leaves this project's sources, and everything synced from it — issues, pull requests, files and their document bindings — leaves the project's graph. Attaching it again later syncs it afresh.",
              confirmLabel: "Detach",
            },
            onSelect: () => detach(r.name),
          },
        ]}
        tile={(r, open) => {
          const node = graphRepo(r);
          const live = sync[r.name];
          const syncedAt = node?.value.synced_at as string | undefined;
          // The two thread counts are claims about the present, so 0 is worth
          // printing; an unknown count is left off rather than written as 0.
          const reviewThreads = node?.value.open_review_threads as number | undefined;
          const documentThreads = node?.value.open_document_threads as number | undefined;
          return (
            <VTile
              icon={<GitBranchIcon />}
              title={r.name}
              subtitle={`${r.source}${r.branch ? ` · ${r.branch}` : ""}${shareModeText(r.share_mode)}`}
              onClick={open}
              tone={node ? undefined : "attn"}
              stats={[
                { label: "issues", value: node ? String(node.value.issues ?? 0) : "—" },
                { label: "PRs", value: node ? String(node.value.pull_requests ?? 0) : "—" },
                { label: "files", value: node ? String(node.value.files ?? 0) : "—" },
                ...(reviewThreads != null ? [{ label: "open on reviews", value: String(reviewThreads) }] : []),
                ...(documentThreads != null ? [{ label: "open in documents", value: String(documentThreads) }] : []),
              ].slice(0, 4)}
              footer={
                <>
                  <span className="sub">
                    {live ? live.line : syncedAt ? <>synced <When iso={syncedAt} /></> : "never synced"}
                  </span>
                  <button
                    className="ghost"
                    disabled={!!live?.running}
                    onClick={(e) => {
                      e.stopPropagation();
                      void syncRepo(r);
                    }}
                  >
                    {syncLabel(r)}
                  </button>
                </>
              }
            />
          );
        }}
      />

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
  const [attached, setAttached] = useState<ProjectSource[]>([]);
  const [shareMode, setShareMode] = useState<ShareMode>("branch");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const loadAttached = useCallback(async () => {
    const config = await api.projectConfig(token, ws.id).catch(() => null);
    setAttached(config?.sources ?? []);
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
  // A pull request chosen on a GitHub connection does not carry over to one
  // that cannot open it.
  const effectiveShareMode: ShareMode = supportsPullRequests(connection) ? shareMode : "branch";

  const attach = async () => {
    if (!connection || picks.length === 0) return;
    setBusy(true);
    setErr(null);
    try {
      await attachReposToWorkspace(token, ws, connection, picks, effectiveShareMode);
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
                const isAttached = hasRepository(attached, r.clone_url);
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
            <ShareModeSelect value={effectiveShareMode} onChange={setShareMode} connection={connection} />
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
}: {
  token: string;
  /** From the account switcher — this page no longer asks again. */
  workspace: Workspace;
  /** The side panel's filters. Not read: the connection list searches itself. */
  filters?: Filters;
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
          connections={connections ?? []}
          loading={connections === null}
          sourcesTick={sourcesTick}
          onSourcesChanged={bumpSources}
          onChanged={() => void reload()}
          onNote={setNote}
        />
      )}

      {/* The send-a-notification and show-it-in-the-IDE panels moved to System.
          They were here because a chat connector is what makes the first one
          work, but they are not connector CONFIGURATION — they are a way to
          poke the running assembly and watch what comes out, which is what
          System is. This page is now only about what is connected. */}
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
                    <span className="conn-logo-slot" aria-hidden>
                      <ConnectorLogo provider={p.provider} label={p.display_name} />
                    </span>
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
          <span className="conn-logo-slot" aria-hidden>
            <ConnectorLogo provider={picked.provider} label={picked.display_name} />
          </span>
          <div className="grow">
            <div className="name">{picked.display_name}</div>
            <div className="sub">
              {CATEGORIES.find((c) => c.key === picked.category)?.title.toLowerCase() ??
                picked.category}
            </div>
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

      {/* An incoming webhook carries its own host, path and channel in the URL
          that IS its credential, so asking for an instance URL as well invites
          a contradiction the driver would then have to refuse. */}
      {picked.fixed_target ? (
        <p className="hint">
          The webhook URL below is the whole address: host, channel and secret. Nothing else to
          configure.
        </p>
      ) : (
        <>
          <label>Instance URL</label>
          <input
            placeholder={
              picked.category === "ai"
                ? `Leave empty for ${picked.default_base_url} — or any compatible endpoint`
                : picked.category === "notification"
                  ? `Leave empty for ${picked.default_base_url} — or your own installation`
                  : `Leave empty for ${picked.default_base_url} — or your self-hosted installation`
            }
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
        </>
      )}

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
  const [health, setHealth] = useState<Record<string, "ok" | "bad" | "testing">>({});

  const nameOf = (p: string) => providers.find((x) => x.provider === p)?.display_name ?? p;
  const categoryOf = (p: string) => providers.find((x) => x.provider === p)?.category;
  const categoryTitle = (p: string) => CATEGORIES.find((c) => c.key === categoryOf(p))?.title ?? "Other";
  // A row stored on an ancestor is shared with sibling workspaces — worth
  // saying, because removing it affects them too.
  const inheritedOf = (c: Connection) => c.owner_tenant_id !== workspace.id;
  const browsable = (c: Connection) => categoryOf(c.provider) === "source_code";

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

  const providersPresent = [...new Set(connections.map((c) => c.provider))];
  const categoriesPresent = CATEGORIES.filter(({ key }) => connections.some((c) => categoryOf(c.provider) === key));

  /* A table, not a grid of cards: two accounts of one provider differ only in
     account, scope and health, and in columns the eye goes down one. The
     editor and the repository browser open as a panel under their row. */
  return (
    <div className="card">
      <DataTable<Connection>
        list="connections"
        urlPrefix="conn."
        title="Connections"
        rows={loading ? null : connections}
        rowKey={(c) => c.id}
        rowLabel={(c) => c.label}
        search={{ placeholder: "Search connections" }}
        searchText={(c) => [c.label, c.account, c.base_url, nameOf(c.provider)]}
        filters={[
          {
            id: "kind",
            allLabel: "Every kind",
            kind: "chips",
            options: categoriesPresent.map(({ key, title }) => ({ value: key, label: title })),
            match: (c, v) => categoryOf(c.provider) === v,
          },
          {
            // Several of one provider are normal: two GitLab installations, a
            // personal and an organization token.
            id: "provider",
            allLabel: "Every connector",
            kind: "select",
            options: providersPresent.map((p) => ({ value: p, label: nameOf(p) })),
            match: (c, v) => c.provider === v,
          },
        ]}
        empty={{ title: "Nothing connected for this project yet.", body: "Add a connector below." }}
        columns={[
          {
            id: "connector",
            header: "Connector",
            className: "acell-lead",
            compare: (a, b) => nameOf(a.provider).localeCompare(nameOf(b.provider)),
            cell: (c) => (
              <>
                <span className="conn-logo-slot" aria-hidden>
                  <ConnectorLogo provider={c.provider} label={nameOf(c.provider)} />
                </span>
                {nameOf(c.provider)}
              </>
            ),
          },
          { id: "kind", header: "Kind", cell: (c) => <span className="sub">{categoryTitle(c.provider)}</span> },
          { id: "account", header: "Account", cell: (c) => c.account || <span className="ing-dash">—</span> },
          { id: "label", header: "Label", compare: (a, b) => a.label.localeCompare(b.label), cell: (c) => c.label },
          {
            id: "url",
            header: "URL",
            className: "conn-url",
            cell: (c) => <span title={c.base_url}>{c.base_url}</span>,
          },
          {
            id: "health",
            header: "Health",
            cell: (c) => {
              const h = health[c.id];
              return (
                <span
                  className={`badge ${h === "ok" ? "ok" : h === "bad" ? "danger" : ""}`}
                  title={h ? undefined : "Health is not cached — Test checks it now"}
                >
                  {h === "ok" ? "healthy" : h === "bad" ? "failing" : h === "testing" ? "testing…" : "not checked"}
                </span>
              );
            },
          },
          {
            id: "scope",
            header: "Scope",
            cell: (c) => (
              <span className={`badge ${c.scope === "personal" ? "" : "workspace"}`}>
                {inheritedOf(c) ? `${c.scope} · shared` : c.scope}
              </span>
            ),
          },
        ]}
        inline={(c) => (
          <button type="button" className="ghost" disabled={health[c.id] === "testing"} onClick={() => test(c)}>
            Test
          </button>
        )}
        actions={(c) => [
          {
            label: editing === c.id ? "Close editor" : "Edit",
            // Inherited connections are edited where they are defined.
            disabled: inheritedOf(c),
            onSelect: () => {
              setOpen(null);
              setEditing(editing === c.id ? null : c.id);
            },
          },
          ...(browsable(c)
            ? [
                {
                  label: open === c.id ? "Hide repositories" : "Browse repositories",
                  onSelect: () => {
                    setEditing(null);
                    setOpen(open === c.id ? null : c.id);
                  },
                },
              ]
            : []),
          {
            label: "Remove",
            danger: {
              title: inheritedOf(c) ? `Remove “${c.label}” for everyone?` : `Remove “${c.label}”?`,
              body: inheritedOf(c)
                ? "It is shared with your other projects, and removing it here removes it there too — with its token."
                : "The connection and its stored token go. Sources attached through it stop syncing.",
              confirmLabel: "Remove",
            },
            onSelect: async () => {
              await api.deleteConnection(token, c.id, workspace.id);
              onChanged();
            },
          },
        ]}
        detail={(c) =>
          editing === c.id ? (
            <EditConnection
              token={token}
              connection={c}
              workspaceId={workspace.id}
              onNote={onNote}
              onDone={(changed) => {
                setEditing(null);
                if (changed) {
                  // A rotated credential invalidates the cached health badge:
                  // it was computed for the old token.
                  setHealth((h) => {
                    const next = { ...h };
                    delete next[c.id];
                    return next;
                  });
                  onChanged();
                }
              }}
            />
          ) : open === c.id && browsable(c) ? (
            <RepoBrowser
              token={token}
              connection={c}
              workspace={workspace}
              sourcesTick={sourcesTick}
              onSourcesChanged={onSourcesChanged}
              onNote={onNote}
            />
          ) : null
        }
      />
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
  const [attached, setAttached] = useState<ProjectSource[]>([]);
  const [shareMode, setShareMode] = useState<ShareMode>("branch");

  const loadAttached = useCallback(async () => {
    const config = await api.projectConfig(token, workspace.id).catch(() => null);
    setAttached(config?.sources ?? []);
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
  const effectiveShareMode: ShareMode = supportsPullRequests(connection) ? shareMode : "branch";

  const attach = async () => {
    if (picks.length === 0) return;
    setBusy(true);
    try {
      const added = await attachReposToWorkspace(token, workspace, connection, picks, effectiveShareMode);
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
            const isAttached = hasRepository(attached, r.clone_url);
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
        <ShareModeSelect value={effectiveShareMode} onChange={setShareMode} connection={connection} />
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

/* ── Access: model + roles (ADR-0009) ── */

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
  /** Every privilege the PDP understands, in catalogue order, from the server. */
  const [privileges, setPrivileges] = useState<string[]>([]);
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
    // The catalogue and the ladder come from the side that evaluates them, so
    // this screen cannot save a role the PDP has never heard of.
    Promise.all([api.accessConfig(token, org.id), api.accessCatalogue(token)])
      .then(([v, catalogue]) => {
        if (!live) return;
        setPrivileges(catalogue.privileges);
        setCfg(normalizeAccessConfig(v, catalogue.default_roles));
      })
      .catch((e) => live && setError(errText(e)))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [token, org]);

  // Grant subjects: the organization's members, by person id — the key every
  // grant names (ADR-0037 §5) — and teams (RG groups). Best-effort: a failed
  // load just leaves a picker empty.
  useEffect(() => {
    let live = true;
    if (!org) {
      setMembers([]);
      setTeams([]);
      return;
    }
    orgPeople(token, org.id).then(
      (people) => live && setMembers(people.map((p) => ({ id: p.id, name: p.name }))),
      () => live && setMembers([]),
    );
    api.groups(token).then(
      (p) =>
        live &&
        setTeams((p.items ?? []).map((g) => ({ id: g.id, name: g.name ?? g.id.slice(0, 8) }))),
      () => live && setTeams([]),
    );
    return () => {
      live = false;
    };
  }, [token, org]);

  // The caller as a person: what a grant names (ADR-0037 §5). Until it is
  // known — or on a backend without studio-user — the sign-in subject stands
  // in, which every grant matcher still accepts.
  const [personId, setPersonId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.myProfile(token).then(
      (p) => live && setPersonId(p.id),
      () => live && setPersonId(null),
    );
    return () => {
      live = false;
    };
  }, [token]);
  const myKeys = [personId, meId].filter((k): k is string => !!k);

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
    c.grants.some((g) => g.subjectType === "member" && myKeys.includes(g.subjectId));

  /** Give the current user an org-wide Owner grant so enabling roles can't lock
   *  them out. Returns the config with the grant appended (idempotent). */
  function withSelfOwner(c: AccessConfig): AccessConfig {
    if (selfGranted(c)) return c;
    const ownerKey = c.roles.some((r) => r.key === "owner") ? "owner" : c.roles[0]?.key ?? "owner";
    const grant: GrantDef = {
      id: `g_self_${Date.now().toString(36)}`,
      subjectType: "member",
      subjectId: personId ?? meId,
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
    const key = `role_${cfg.roles.length + 1}_${privileges.length}`.replace(/[^a-z0-9_]/gi, "");
    mutate({
      ...cfg,
      roles: [...cfg.roles, { key, name: "New role", privileges: ["people.view"] }],
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

  const groups = privilegesByGroup(privileges);

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
                <i>Works</i> by these grants (ADR-0009); other surfaces still run allow-all until
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
                      {role.privileges.length} / {privileges.length} privileges
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

function ProfileView({
  me,
  home,
  token,
  onPerson,
}: {
  me: Me;
  home: Tenant | null;
  token: string;
  /** Told about every change to the person, so the account button follows. */
  onPerson: (profile: StudioProfile) => void;
}) {
  // Stored with the person's other preferences (`usePreference`); the form
  // edits a draft and Save commits it.
  const [savedTheme, saveTheme] = usePreference(PREF_THEME, "light");
  const [savedLanguage, saveLanguage] = usePreference(PREF_LANGUAGE, "en");
  const [theme, setTheme] = useState(savedTheme);
  const [language, setLanguage] = useState(savedLanguage);
  const [saved, setSaved] = useState(false);
  const [error] = useState<string | null>(null);

  // The record answers a moment after mount; the draft follows it until the
  // person starts editing.
  useEffect(() => setTheme(savedTheme), [savedTheme]);
  useEffect(() => setLanguage(savedLanguage), [savedLanguage]);

  function save(e: FormEvent) {
    e.preventDefault();
    setSaved(false);
    saveTheme(theme);
    saveLanguage(language);
    document.documentElement.dataset.theme = theme;
    setSaved(true);
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
          API: <a href="/api-docs/">/api-docs/</a>
        </p>
      </div>

      <MyPersonCard token={token} onChanged={onPerson} />

      <AiKeysCard token={token} />

      <div className="card">
        <h2>Preferences</h2>
        <p className="hint">Stored server-side per user, with your other Studio preferences.</p>
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

/** How often the portal repeats `studio.init` to a booting IDE, and how many
 *  times (~5 min) before it decides the session is not coming up. */
const INIT_RETRY_MS = 300;
const INIT_RETRY_LIMIT = Math.ceil((5 * 60 * 1000) / INIT_RETRY_MS);

/** A target's session is started ahead of a click at most this often. Under
 *  the backend's idle stop (15 min), so a person still on the project when it
 *  fires gets it started again on their next visit to it. */
const PREWARM_EVERY_MS = 10 * 60 * 1000;

/** Reuse-or-launch the IDE session for a target and return it only once the
 *  backend's reachability probe says it is actually serving.
 *
 *  Creation is idempotent per workspace — the gear returns the already-running
 *  session instead of a second container — so this doubles as "give me the
 *  session for this target", which is what makes the editing hand-off a single
 *  gesture (`studio-bridge`) rather than a launch click plus an edit click.
 *
 *  The project's repositories are not sent: the backend reads them from the
 *  project's config and clones them whoever launches (`project-sources.ts`).
 *  This sends only what is not the project's — a backend-host folder from the
 *  settings, the gear corpus — and reads the repositories just to show them.
 *
 *  `onResolved` reports the sources back so a caller that displays them (the
 *  launcher card) does not need a second round trip. */
async function startStudioSession(
  token: string,
  target: StudioTarget,
  onResolved?: (sources: {
    repos: RepoEntry[];
    root: { path?: string; repoUrl?: string; branch?: string; tokenRef?: string };
    kind?: string;
  }) => void,
): Promise<StudioSession> {
  const own = await projectRepoRows(token, target.id).catch((): RepoEntry[] => []);
  let repos = target.repos ?? [];
  let root = target.root ?? {};
  // A nested project is standalone — it carries its own repos/root and has no
  // workspaceSettings of its own to read.
  if (!target.standalone) {
    try {
      const s = await api.workspaceSettings(token, target.id);
      // Only a working copy's folders: the repositories are the config's.
      repos = (s?.repos ?? []).filter((r) => r.source === "local");
      root = {
        path: s?.root_path?.trim() || undefined,
        repoUrl: s?.root_repo_url?.trim() || undefined,
        branch: s?.root_branch?.trim() || undefined,
        tokenRef: s?.root_token_ref?.trim() || undefined,
      };
    } catch {
      // Settings unreachable — fall back to whatever the target carries.
    }
  }
  // No gear corpus. A session the portal opens is for the project's own
  // documents and code, with the assistants; Gearbox — and the gears-rust
  // checkout it resolves a product against — is Constructor Studio Desktop's.
  // It used to be cloned beside every project that had a product, which on dev
  // was a second repository, a Gearbox engine and the better part of a gigabyte
  // in a session nobody had asked to compose anything in.
  const kind = await api
    .projectConfig(token, target.id)
    .then((c) => c?.kind)
    .catch(() => undefined);
  const shown = [...own, ...repos];
  onResolved?.({ repos: shown, root, kind });
  const ownNames = new Set(own.map((r) => r.name));
  const usable = shown.filter(
    (r) => !ownNames.has(r.name) && (r.source === "local" ? Boolean(r.path?.trim()) : Boolean(r.url?.trim())),
  );
  const created = await api.createStudioSession(token, target.id, usable, root);
  // The backend probes the session on its own run; this only watches it, and
  // asks for the record once it is up.
  return waitForStudioSessionReady(created, () => api.studioSession(token, created.id), {
    follow: (runId, signal) => followRun(token, runId, () => {}, { signal }),
  });
}

function StudioLauncher({
  token,
  target,
  onClose,
  onOpen,
  onGearProject,
}: {
  token: string;
  target: StudioTarget;
  onClose: () => void;
  /** Opens the session as an embedded space (same window, no new tab). */
  onOpen: (session: { id: string; url: string }) => void;
  /** A gear project's IDE opens on its gear, in the Gearbox view, the way a
   *  product project's opens on its product. */
  onGearProject?: () => void;
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

  // A root project's repositories are its config's; its settings add only a
  // working copy's folders and root. A nested project is standalone — it
  // carries its own repos/root on the target (its single source), and has no
  // workspaceSettings of its own to read.
  useEffect(() => {
    if (target.standalone) {
      setRepos(target.repos ?? []);
      setRoot(target.root ?? {});
      return;
    }
    Promise.all([projectRepoRows(token, target.id), api.workspaceSettings(token, target.id)])
      .then(([own, s]) => {
        setRepos([...own, ...(s?.repos ?? []).filter((r) => r.source === "local")]);
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
      // Same path the editing hand-off takes (see `startStudioSession`), so a
      // session opened from a document and one opened from this card are the
      // same session with the same sources.
      let gearProject = false;
      const ready = await startStudioSession(token, target, (sources) => {
        setRepos(sources.repos);
        setRoot(sources.root);
        gearProject = sources.kind === "new_gears";
      });
      setSession(ready);
      onOpen({ id: ready.id, url: ready.url });
      if (gearProject) onGearProject?.();
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
