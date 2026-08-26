// Minimal typed client for the studio-backend REST API (/cf prefix).
// The live OpenAPI contract is served by the backend at /cf/docs.

export interface Me {
  subject_id: string;
  subject_type?: string;
  subject_tenant_id: string;
}

export interface Tenant {
  id: string;
  name: string;
  tenant_type: string;
  self_managed: boolean;
}

export interface User {
  id: string;
  username: string;
  email?: string;
  display_name?: string;
}

export interface Page<T> {
  items: T[];
  page_info?: { next_cursor: string | null; prev_cursor: string | null; limit: number };
}

// Studio tenant types seeded by studio-backend config (types-registry.config.entities).
export const TENANT_TYPES = {
  organization: "gts.cf.core.am.tenant_type.v1~cf.studio.tenant.organization.v1~",
  workspace: "gts.cf.core.am.tenant_type.v1~cf.studio.tenant.workspace.v1~",
  /** A project is now its own AM tenant, child of a workspace — its codebase
   *  context (sources, IDE, artifacts, spec-quality) is tenant-scoped on it. */
  project: "gts.cf.core.am.tenant_type.v1~cf.studio.tenant.project.v1~",
} as const;

/** Project attributes stored as tenant metadata on the project tenant. */
export const PROJECT_CONFIG_TYPE =
  "gts.cf.core.am.tenant_metadata.v1~cf.studio.project.config.v1~";

/** The project attributes carried in PROJECT_CONFIG_TYPE metadata. */
export interface ProjectConfig {
  mode?: ProjectMode;
  stages?: string[];
  status?: ProjectStatus;
  /** Seed source: a git url, a brief, or an uploaded file id. */
  source_git_url?: string;
  brief?: string;
}

// Workspace settings live as AM tenant metadata (schema seeded by the backend config).
export const WS_SETTINGS_TYPE = "gts.cf.core.am.tenant_metadata.v1~cf.studio.workspace.settings.v1~";
// Organization access config (model + roles) — AM tenant metadata, same
// mechanism as workspace settings (schema seeded by the backend config).
export const ACCESS_TYPE = "gts.cf.core.am.tenant_metadata.v1~cf.studio.access.config.v1~";

/** The two creation shapes. A greenfield project has no source to import; a
 *  modernization has exactly one. Carried in a project's config metadata. */
export type ProjectMode = "greenfield" | "modernize";

/** Forward-only: draft -> active -> archived, and archived is terminal. */
export type ProjectStatus = "draft" | "active" | "archived";

/** The status ladder in order — used to enforce forward-only transitions in
 *  the UI now that the studio-project gear no longer guards them server-side. */
export const STATUS_LADDER: ProjectStatus[] = ["draft", "active", "archived"];

/** The canonical journey-stage catalogue (was `GET /studio-project/v1/stages`).
 *  Intent is always applied; the rest are opt-in. A project's `stages` should be
 *  a subset of these keys, kept in this order. */
export const JOURNEY_STAGES: { key: string; label: string; required: boolean }[] = [
  { key: "intent", label: "Intent", required: true },
  { key: "brd", label: "BRD", required: false },
  { key: "prd", label: "PRD", required: false },
  { key: "prd_spec", label: "PRD-Spec", required: false },
  { key: "architecture", label: "Architecture", required: false },
  { key: "ui_design", label: "UI Design", required: false },
  { key: "user_stories", label: "User Stories", required: false },
  { key: "testing", label: "Testing", required: false },
];

/** Normalise a stage selection to the required set + chosen keys, in catalogue
 *  order — the same idempotent normalisation the old gear did server-side. */
export function normalizeStages(selected: readonly string[]): string[] {
  const chosen = new Set(selected);
  return JOURNEY_STAGES.filter((s) => s.required || chosen.has(s.key)).map((s) => s.key);
}

export type RepoSource = "local" | "git" | "github" | "gitlab";

/** One workspace source — mirrored into .cf-workspace.toml by the backend. */
export interface RepoEntry {
  /** Directory name under the workspace root: [a-z0-9_-]+ */
  name: string;
  /** UI-level source flavor; github/gitlab are git with a composed URL. */
  source: RepoSource;
  url?: string;
  path?: string;
  /** Mount/clone target relative to the workspace root (defaults to name). */
  target?: string;
  branch?: string;
  /** credstore secret reference holding the repo PAT (private repos). */
  token_ref?: string;
}

/* ── studio-connector: source connections ── */

/** A provider this deployment can serve, i.e. one whose driver plugin is linked. */
export interface ConnectorProvider {
  provider: string;
  display_name: string;
  default_base_url: string;
  /** GTS instance id of the driver plugin — shown so the UI can prove it is plugin-backed. */
  instance_id: string;
  /** "source_code" = repositories can be browsed; "ai" = credential only. */
  category: string;
  /** Label for the credential field, e.g. "API Key" vs "Personal Access Token (PAT)". */
  credential_label: string;
  /** Placeholder hinting at the credential shape, e.g. "sk-ant-…". */
  credential_hint: string;
}

export interface Connection {
  id: string;
  /** Tenant holding this connection: the viewed one, or an ancestor when inherited. */
  owner_tenant_id: string;
  provider: string;
  label: string;
  /** Account the credential belongs to, captured when it was verified. */
  account: string;
  base_url: string;
  /** personal | workspace | organization */
  scope: string;
  /** credstore reference of the token — pass as token_ref when launching a session. */
  secret_ref: string;
  created_at_epoch_secs: number;
}

export interface ConnectorIdentity {
  account: string;
  display_name?: string;
}

export interface ConnectionTest extends ConnectorIdentity {
  connection: Connection;
}

export interface RemoteRepo {
  id: string;
  name: string;
  full_path: string;
  clone_url: string;
  default_branch?: string;
  description?: string;
  visibility?: string;
}

/** One ingested artifact node from `GET /studio-artifact-ingest/v1/nodes`.
 * `value` is the free-form GTS payload (issue/PR/repo fields). */
export interface ArtifactNode {
  type_id: string;
  instance_id: string;
  value: {
    repo?: string;
    external_id?: string;
    number?: number;
    title?: string;
    state?: string;
    author?: string | null;
    body?: string | null;
    url?: string | null;
    labels?: string[];
    source_branch?: string | null;
    target_branch?: string | null;
    merged?: boolean;
    provider?: string;
    full_path?: string;
    // File nodes:
    path?: string;
    sha?: string;
    is_dir?: boolean;
    size?: number | null;
    created_at?: string | null;
    updated_at?: string | null;
    // User nodes:
    login?: string;
    [key: string]: unknown;
  };
}

/** A relation between two artifact nodes (endpoints by instance id). Types:
 *  `…rel.authored_by…`, `…rel.modifies…`, `…rel.artifact_of…`, `…rel.contains…`. */
export interface ArtifactEdge {
  type_id: string;
  from: string;
  to: string;
}

export interface WorkspaceSettings {
  automation_level?: "manual" | "recommendations" | "autonomous";
  approved_worker_categories?: string[];
  /** Existing Studio workspace folder (CLI-created) used as the root. */
  root_path?: string;
  /** Clone URL of the workspace repository itself (alternative to root_path). */
  root_repo_url?: string;
  root_branch?: string;
  /** credstore secret reference with the PAT for the workspace repository. */
  root_token_ref?: string;
  /** Workspace sources: multiple repositories/folders per workspace. */
  repos?: RepoEntry[];
}

// simple-user-settings gear stores exactly these two per-user fields.
export interface UserPrefs {
  theme?: string;
  language?: string;
}

/* ── mini-chat / conversions / file-storage shapes ── */

export interface Chat {
  id: string;
  model: string;
  title?: string;
  message_count: number;
  updated_at: string;
}

export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  model?: string;
  created_at: string;
}

export interface Model {
  model_id: string;
  display_name: string;
  tier: string;
  context_window: number;
  description?: string;
}

export interface Conversion {
  request_id?: string;
  id?: string;
  tenant_id: string;
  child_tenant_name?: string;
  target_mode: string;
  status: string;
  expires_at?: string;
}

export interface StudioSession {
  id: string;
  workspace_id: string;
  state: "starting" | "running" | "stopped";
  url: string;
  created_at_epoch_secs: number;
  sources: string[];
}

/** Loopback names the session URL may carry — same machine, different "site". */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Rewrite a session URL to the host the portal itself is served from.
 *
 * The IDE runs in an iframe and its auth gate uses a `SameSite=Lax` cookie,
 * which the browser withholds from cross-site requests. `localhost` and
 * `127.0.0.1` are the same machine but NOT the same site, so a portal opened
 * on one and a session published on the other loses the cookie on every
 * request after the initial `?token=` redirect — the IDE then answers
 * "403 — session token required" from inside the frame. Ports are irrelevant
 * to that comparison; only the host is.
 *
 * `SameSite=None` would be the other way out, but it requires `Secure`, and
 * sessions are published over plain http on loopback.
 *
 * Only loopback hosts are rewritten: a real `public_host` (a deployment
 * reachable by name) is deliberate configuration and must survive untouched.
 */
export function alignSessionHost(url: string): string {
  const here = typeof window === "undefined" ? "" : window.location.hostname;
  try {
    const u = new URL(url);
    if (LOOPBACK.has(u.hostname) && LOOPBACK.has(here)) {
      u.hostname = here;
    }
    return u.toString();
  } catch {
    return url; // not a URL we understand — hand it back unchanged
  }
}

const withAlignedHost = (s: StudioSession): StudioSession => ({
  ...s,
  url: alignSessionHost(s.url),
});

export interface StoredFile {
  id: string;
  name?: string;
  file_name?: string;
  size_bytes?: number;
  created_at?: string;
}

export interface Group {
  id: string;
  type: string;
  name: string;
  hierarchy: { parent_id: string | null; tenant_id: string; depth: number };
  metadata?: { workspace_id?: string } & Record<string, unknown>;
}

export interface Membership {
  group_id: string;
  resource_type: string;
  resource_id: string;
}

export function shortTypeName(gtsType: string): string {
  return gtsType.split("~").filter(Boolean).at(-1)?.split(".").at(-2) ?? gtsType;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
  ) {
    super(`API error ${status}`);
  }
}

export function apiUrl(path: string): string {
  return `/cf${path.startsWith("/") ? path : `/${path}`}`;
}

/** Fired on any 401 so the app can drop a dead session instead of looping. */
export const UNAUTHENTICATED_EVENT = "studio:unauthenticated";

async function request<T>(path: string, token: string, init?: RequestInit): Promise<T> {
  if (!token) {
    // Defensive: an empty token would reach the gateway as a missing bearer
    // and read as a server-side auth failure. Fail here, clearly.
    window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
    throw new ApiError(401, { title: "Not signed in", detail: "No access token in this session" });
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };
  if (import.meta.env.DEV) {
    // Dev-only: makes "did we actually send the bearer?" answerable from the
    // console instead of guessing at a server-side 401.
    console.debug(
      `[api] ${init?.method ?? "GET"} ${path} · auth=${headers.Authorization ? "yes" : "NO"} · token=${token.length}ch ${token.slice(0, 6)}…`,
    );
  }
  const res = await fetch(apiUrl(path), { ...init, headers });
  const body = res.status === 204 ? undefined : await res.json().catch(() => undefined);
  if (!res.ok) {
    // 401 = the session is over (SSO access tokens expire; we hold no refresh
    // token yet). Tell the app once; every caller still gets its error.
    if (res.status === 401) window.dispatchEvent(new CustomEvent(UNAUTHENTICATED_EVENT));
    throw new ApiError(res.status, body);
  }
  return body as T;
}

export const api = {
  /** Login = validate the token by asking the backend who we are. */
  me: (token: string) => request<Me>("/account-management/v1/me", token),

  tenant: (token: string, tenantId: string) =>
    request<Tenant>(`/account-management/v1/tenants/${tenantId}`, token),

  tenantChildren: (token: string, tenantId: string) =>
    request<Page<Tenant>>(`/account-management/v1/tenants/${tenantId}/children`, token),

  deleteTenant: (token: string, tenantId: string) =>
    request<void>(`/account-management/v1/tenants/${tenantId}`, token, { method: "DELETE" }),

  deleteGroup: (token: string, groupId: string, force = false) =>
    request<void>(`/resource-group/v1/groups/${groupId}${force ? "?force=true" : ""}`, token, {
      method: "DELETE",
    }),

  createTenant: (
    token: string,
    input: { name: string; parent_id: string; tenant_type: string },
  ) =>
    request<Tenant>("/account-management/v1/tenants", token, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /** Rename a tenant. AM exposes `name` as the only mutable field on
   *  `PATCH /tenants/{id}` (RFC 7396 merge patch); status transitions and the
   *  parent are immutable here. */
  updateTenant: (token: string, tenantId: string, input: { name: string }) =>
    request<Tenant>(`/account-management/v1/tenants/${tenantId}`, token, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),

  tenantUsers: (token: string, tenantId: string) =>
    request<Page<User>>(`/account-management/v1/tenants/${tenantId}/users`, token),

  inviteUser: (
    token: string,
    tenantId: string,
    input: { username: string; email?: string; display_name?: string },
  ) =>
    request<User>(`/account-management/v1/tenants/${tenantId}/users`, token, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  /* ── Projects (RG-backed, ADR-0002) ── */

  groups: (token: string) => request<Page<Group>>("/resource-group/v1/groups", token),

  createGroup: (
    token: string,
    input: { type: string; name: string; parent_id: string | null; metadata?: Record<string, unknown> },
  ) =>
    request<Group>("/resource-group/v1/groups", token, {
      method: "POST",
      body: JSON.stringify(input),
    }),

  memberships: (token: string) => request<Page<Membership>>("/resource-group/v1/memberships", token),

  addMembership: (token: string, groupId: string, resourceType: string, resourceId: string) =>
    request<Membership>(
      `/resource-group/v1/memberships/${groupId}/${resourceType}/${resourceId}`,
      token,
      { method: "POST" },
    ),

  /** Relabel a connection, move it to another installation, or rotate its
   *  credential. Every field optional; the backend verifies the result against
   *  the provider before writing, with or without a new token. The connection
   *  id survives, which is why this exists — workspace sources reference it. */
  patchConnection: (
    token: string,
    id: string,
    input: { label?: string; base_url?: string; token?: string },
    tenantId?: string,
  ) =>
    request<ConnectionTest>(
      `/studio-connector/v1/connections/${id}${tenantId ? `?tenant=${tenantId}` : ""}`,
      token,
      { method: "PATCH", body: JSON.stringify(input) },
    ),

  /* ── Workspace settings (AM tenant metadata) ── */

  workspaceSettings: async (token: string, tenantId: string): Promise<WorkspaceSettings | null> => {
    try {
      const entry = await request<{ value: WorkspaceSettings }>(
        `/account-management/v1/tenants/${tenantId}/metadata/${WS_SETTINGS_TYPE}`,
        token,
      );
      return entry.value;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null; // not set yet
      throw e;
    }
  },

  /* ── studio-connector ── */

  connectorProviders: (token: string) =>
    request<{ items: ConnectorProvider[] }>("/studio-connector/v1/providers", token),

  /** Connections visible from `tenant` — its own, or inherited from an ancestor. */
  connections: (token: string, tenant: string) =>
    request<{ items: Connection[] }>(
      `/studio-connector/v1/connections?tenant=${encodeURIComponent(tenant)}`,
      token,
    ),

  /** Verify a credential without storing it ("Test connection"). */
  probeConnection: (token: string, body: { provider: string; base_url?: string; token: string }) =>
    request<ConnectorIdentity>("/studio-connector/v1/probe", token, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  /** Verifies, then stores ("Test & save"). The token never comes back out. */
  createConnection: (
    token: string,
    body: {
      provider: string;
      label: string;
      base_url?: string;
      token: string;
      scope?: string;
      /** Organization (inherited by its workspaces) or a single workspace. */
      owner_tenant_id?: string;
    },
  ) =>
    request<ConnectionTest>("/studio-connector/v1/connections", token, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  testConnection: (token: string, id: string, tenant: string) =>
    request<ConnectionTest>(
      `/studio-connector/v1/connections/${id}/test?tenant=${encodeURIComponent(tenant)}`,
      token,
      { method: "POST" },
    ),

  /** Removes the row from the connection's OWNING tenant, so deleting an
   *  inherited connection edits the organization's catalogue — and is refused
   *  when the caller may not write there. */
  deleteConnection: (token: string, id: string, tenant: string) =>
    request<void>(
      `/studio-connector/v1/connections/${id}?tenant=${encodeURIComponent(tenant)}`,
      token,
      { method: "DELETE" },
    ),

  connectionRepositories: (token: string, id: string, tenant: string, search?: string) => {
    const q = new URLSearchParams({ tenant });
    if (search?.trim()) q.set("search", search.trim());
    return request<{ items: RemoteRepo[] }>(
      `/studio-connector/v1/connections/${id}/repositories?${q.toString()}`,
      token,
    );
  },

  putWorkspaceSettings: (token: string, tenantId: string, value: WorkspaceSettings) =>
    request<unknown>(`/account-management/v1/tenants/${tenantId}/metadata/${WS_SETTINGS_TYPE}`, token, {
      method: "PUT",
      body: JSON.stringify(value), // transparent payload; GTS-validated server-side
    }),

  /* ── Project attributes (AM tenant metadata on the project tenant) ── */
  projectConfig: async (token: string, tenantId: string): Promise<ProjectConfig | null> => {
    try {
      const entry = await request<{ value: ProjectConfig }>(
        `/account-management/v1/tenants/${tenantId}/metadata/${PROJECT_CONFIG_TYPE}`,
        token,
      );
      return entry.value;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null;
      throw e;
    }
  },

  putProjectConfig: (token: string, tenantId: string, value: ProjectConfig) =>
    request<unknown>(
      `/account-management/v1/tenants/${tenantId}/metadata/${PROJECT_CONFIG_TYPE}`,
      token,
      { method: "PUT", body: JSON.stringify(value) },
    ),

  /* ── Organization access config (AM tenant metadata) ── */

  /** The org's access model + role definitions. `null` = never set (defaults). */
  accessConfig: async (token: string, tenantId: string): Promise<import("./access").AccessConfig | null> => {
    try {
      const entry = await request<{ value: import("./access").AccessConfig }>(
        `/account-management/v1/tenants/${tenantId}/metadata/${ACCESS_TYPE}`,
        token,
      );
      return entry.value;
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return null; // not set yet
      throw e;
    }
  },

  putAccessConfig: (token: string, tenantId: string, value: import("./access").AccessConfig) =>
    request<unknown>(`/account-management/v1/tenants/${tenantId}/metadata/${ACCESS_TYPE}`, token, {
      method: "PUT",
      body: JSON.stringify(value),
    }),

  /* ── Per-user settings (simple-user-settings gear: fixed theme/language) ── */

  userSettings: async (token: string): Promise<UserPrefs> => {
    try {
      const s = await request<{ theme?: string | null; language?: string | null }>(
        "/simple-user-settings/v1/settings",
        token,
      );
      return { theme: s.theme ?? undefined, language: s.language ?? undefined };
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) return {};
      throw e;
    }
  },

  saveUserSettings: (token: string, prefs: Required<UserPrefs>) =>
    request<unknown>("/simple-user-settings/v1/settings", token, {
      method: "PATCH",
      body: JSON.stringify(prefs),
    }).catch(async (e) => {
      // First write for this user needs POST (create), PATCH 404s.
      if (e instanceof ApiError && e.status === 404) {
        return request<unknown>("/simple-user-settings/v1/settings", token, {
          method: "POST",
          body: JSON.stringify(prefs),
        });
      }
      throw e;
    }),

  /* ── Workspace AI chat (mini-chat gear) ── */

  createChat: (token: string, title: string) =>
    request<{ id: string }>("/mini-chat/v1/chats", token, {
      method: "POST",
      body: JSON.stringify({ title }),
    }),

  chats: (token: string) => request<Page<Chat>>("/mini-chat/v1/chats", token),

  chatMessages: (token: string, chatId: string) =>
    request<Page<ChatMessage>>(`/mini-chat/v1/chats/${chatId}/messages`, token),

  deleteChat: (token: string, chatId: string) =>
    request<unknown>(`/mini-chat/v1/chats/${chatId}`, token, { method: "DELETE" }),

  models: (token: string) => request<Page<Model>>("/mini-chat/v1/models", token),

  /* ── AM dual-consent conversions ── */

  requestConversion: (token: string, tenantId: string, target: "managed" | "self_managed") =>
    request<Conversion>(`/account-management/v1/tenants/${tenantId}/conversions`, token, {
      method: "POST",
      body: JSON.stringify({ target_mode: target, comment: "Requested from the Studio portal" }),
    }),

  inboundConversions: (token: string, parentId: string) =>
    request<Page<Conversion>>(`/account-management/v1/tenants/${parentId}/child-conversions`, token),

  decideConversion: (
    token: string,
    parentId: string,
    requestId: string,
    status: "approved" | "rejected",
  ) =>
    request<Conversion>(
      `/account-management/v1/tenants/${parentId}/child-conversions/${requestId}`,
      token,
      { method: "PATCH", body: JSON.stringify({ status }) },
    ),

  /* ── System observability (orchestrator / oagw / types-registry / file-storage) ── */

  gears: (token: string) => request<unknown>("/gear-orchestrator/v1/gears", token),
  oagwUpstreams: (token: string) => request<unknown>("/oagw/v1/upstreams", token),
  gtsEntities: (token: string) => request<unknown>("/types-registry/v1/entities", token),
  files: (token: string) => request<Page<StoredFile>>("/api/file-storage/v1/files", token),
  storages: (token: string) => request<unknown>("/api/file-storage/v1/storages", token),

  /* ── studio-artifact-ingest gear: pull issues/PRs from a source into the graph ── */
  syncArtifacts: (
    token: string,
    body: {
      provider: string;
      secret_ref: string;
      repo_full_path: string;
      base_url?: string;
      since?: string;
      /** Workspace + repo dir → ingest reads the IDE's checkout instead of
       *  cloning its own. */
      workspace_id?: string;
      repo_dir?: string;
    },
  ) =>
    request<{ task_id: string; status: string }>(
      "/studio-artifact-ingest/v1/sync",
      token,
      { method: "POST", body: JSON.stringify(body) },
    ),

  /** Poll a background sync task. Terminal states are `succeeded` / `failed`. */
  artifactSyncTask: (token: string, taskId: string) =>
    request<{
      task_id: string;
      status: "queued" | "running" | "succeeded" | "failed";
      repo_full_path: string;
      message?: string | null;
      issues: number;
      pull_requests: number;
      files: number;
    }>(`/studio-artifact-ingest/v1/tasks/${encodeURIComponent(taskId)}`, token),

  /** Text files (path + content) from a repository's IDE checkout, for running
   * analysis over the actual repo. Empty until the IDE has cloned it. */
  repoFiles: (token: string, workspaceId: string, repoDir: string) =>
    request<{ files: { path: string; text: string }[] }>(
      `/studio-artifact-ingest/v1/repo-files?workspace_id=${encodeURIComponent(
        workspaceId,
      )}&repo_dir=${encodeURIComponent(repoDir)}`,
      token,
    ),

  /** Read back the ingested artifact nodes, optionally filtered by type
   * substring (`issue`, `pull_request`, `file`, `repo`). */
  listArtifactNodes: (token: string, type?: string) =>
    request<{ nodes: ArtifactNode[] }>(
      `/studio-artifact-ingest/v1/nodes${type ? `?type=${encodeURIComponent(type)}` : ""}`,
      token,
    ),

  /** Relations between ingested nodes (authored_by / modifies / …). */
  artifactEdges: (token: string) =>
    request<{ edges: ArtifactEdge[] }>("/studio-artifact-ingest/v1/edges", token),

  /* ── studio-session gear: per-workspace Theia IDE containers ── */
  createStudioSession: (
    token: string,
    workspaceId: string,
    repos: RepoEntry[],
    root?: { path?: string; repoUrl?: string; branch?: string; tokenRef?: string },
  ) =>
    request<StudioSession>("/studio-session/v1/sessions", token, {
      method: "POST",
      body: JSON.stringify({
        workspace_id: workspaceId,
        root_path: root?.path || undefined,
        root_repo_url: root?.repoUrl || undefined,
        root_branch: root?.branch || undefined,
        root_token_ref: root?.tokenRef || undefined,
        repos: repos.map((r) => ({
          name: r.name,
          kind: r.source === "local" ? "local" : "git",
          url: r.url || undefined,
          path: r.path || undefined,
          target: r.target || undefined,
          branch: r.branch || undefined,
          token_ref: r.token_ref || undefined,
        })),
      }),
    }).then(withAlignedHost),

  /**
   * credstore: create a secret (used for repo access tokens).
   *
   * `sharing` defaults to "tenant" — a repository credential belongs to the
   * workspace, so any member launching a session can use it. Pass "private"
   * for a per-user secret (e.g. a personal AI key): the credstore keeps it to
   * its owner and returns it ahead of any tenant secret with the same ref. The
   * `personal_token` secret type requires "private" — it rejects tenant sharing.
   */
  putSecret: async (
    token: string,
    reference: string,
    value: string,
    secretType?: string,
    sharing: "tenant" | "private" | "shared" = "tenant",
  ) => {
    const payload = {
      value,
      sharing,
      ...(secretType ? { type: secretType } : {}),
    };
    try {
      return await request<unknown>("/credstore/v1/secrets", token, {
        method: "POST",
        body: JSON.stringify({ reference, ...payload }),
      });
    } catch (e) {
      // 409: the reference exists (possibly from an earlier failed attempt,
      // whose GET fails closed). Rotate it instead — `If-Match: *` is the
      // gear's explicit unconditional overwrite.
      if (!(e instanceof ApiError) || e.status !== 409) throw e;
      return await request<unknown>(`/credstore/v1/secrets/${encodeURIComponent(reference)}`, token, {
        method: "PUT",
        headers: { "If-Match": "*" },
        body: JSON.stringify(payload),
      });
    }
  },
  /**
   * Secret health probe: credstore has NO list endpoint, so surfaces build
   * from refs known to workspace settings and check each with a GET.
   * "ok" = readable; "broken" = exists but fails closed (fence-poisoned) or
   * missing — either way a rotate (putSecret) heals it.
   */
  checkSecret: async (token: string, reference: string): Promise<"ok" | "broken"> => {
    try {
      await request<unknown>(`/credstore/v1/secrets/${encodeURIComponent(reference)}`, token);
      return "ok";
    } catch {
      return "broken";
    }
  },

  deleteSecret: (token: string, reference: string) =>
    request<unknown>(`/credstore/v1/secrets/${encodeURIComponent(reference)}`, token, {
      method: "DELETE",
    }),

  studioSession: (token: string, id: string) =>
    request<StudioSession>(`/studio-session/v1/sessions/${id}`, token).then(withAlignedHost),
  studioSessions: (token: string) =>
    request<{ items: StudioSession[] }>("/studio-session/v1/sessions", token).then((p) => ({
      items: p.items.map(withAlignedHost),
    })),
  deleteStudioSession: (token: string, id: string) =>
    request<void>(`/studio-session/v1/sessions/${id}`, token, { method: "DELETE" }),

  /**
   * POST /mini-chat/v1/chats/{id}/messages:stream — SSE.
   * Calls onDelta with accumulated text; resolves when the stream ends.
   */
  streamMessage: async (
    token: string,
    chatId: string,
    content: string,
    onDelta: (full: string) => void,
  ): Promise<void> => {
    const res = await fetch(apiUrl(`/mini-chat/v1/chats/${chatId}/messages:stream`), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ content }),
    });
    if (!res.ok || !res.body) {
      throw new ApiError(res.status, await res.json().catch(() => undefined));
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Parse SSE frames: "event: X\ndata: {...}\n\n"
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const event = /^event:\s*(.+)$/m.exec(frame)?.[1]?.trim();
        const data = /^data:\s*(.+)$/m.exec(frame)?.[1];
        if (event === "delta" && data) {
          try {
            const d = JSON.parse(data) as { text?: string; content?: string; delta?: string };
            text += d.text ?? d.content ?? d.delta ?? "";
            onDelta(text);
          } catch {
            /* ignore malformed frame */
          }
        } else if (event === "error" && data) {
          throw new ApiError(502, JSON.parse(data));
        }
      }
    }
  },
};
