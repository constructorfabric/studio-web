/* Where an organization's products run (ADR-0043).
 *
 * `OrgEnvironments` is the organization's Environments section: its
 * environments (a cluster connection, a registry, a namespace per project,
 * whether a deploy needs approval), the deploys waiting for a decision, and
 * what runs where. `ProjectEnvironments` sits on a project's product card:
 * its kubernetes profiles bound to the environments, and its deployments.
 *
 * A deploy itself is asked for from the desktop, which builds and pushes the
 * images and sends the generated chart; the server installs it with the
 * environment's connection. */

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ApiError,
  api,
  type Connection,
  type DeployEnvironment,
  type DeployEnvironmentInput,
  type Deployment,
  type DeploymentStatus,
  type EnvironmentBinding,
  type ProjectTargets,
  type ResearchHardware,
  type ResearchProject,
  type Tenant,
} from "./api";
import {
  DEFAULT_NAMESPACE_PATTERN,
  type ClusterCard,
  type EnvironmentField,
  STATE_LABELS,
  awaitingDecision,
  clusterCards,
  clusterConnections,
  emptyEnvironment,
  environmentInput,
  environmentProblems,
  registryConnections,
  researchConnections,
  namespaceFor,
  shortCommit,
  stateTone,
} from "./environments";
import { DataTable } from "./data-table";
import { errText, relTime } from "./format";
import { AddCluster, AddRegistry } from "./kubeconfig-field";
import { Tile } from "./view-mode";

const PROJECT_TYPE = /tenant\.project\.v1/;

/** The cluster select's "connect a new one" entry. */
const NEW_CLUSTER = "__new_cluster__";

function StateBadge({ d }: { d: Deployment }) {
  return (
    <span className={`badge env-state env-${stateTone(d.state)}`} data-deployment-state={d.state}>
      {STATE_LABELS[d.state] ?? d.state}
    </span>
  );
}

/** One deployment as a row: what, where, who, when. */
function DeploymentLine({ d, showProject }: { d: Deployment; showProject: boolean }) {
  return (
    <div className="env-deployment">
      <StateBadge d={d} />
      <b>{d.product}</b>
      {showProject && <span className="sub">{d.project_name}</span>}
      <span className="sub">
        → {d.environment_name} · <code>{d.namespace}</code>
        {d.commit && (
          <>
            {" "}
            · <code>{shortCommit(d.commit)}</code>
          </>
        )}{" "}
        · {d.requested_by_name || d.requested_by} · {relTime(d.requested_at)}
        {d.decided_at && (
          <>
            {" "}
            · {d.state === "declined" ? "declined" : "approved"} by {d.decided_by_name || d.decided_by}
          </>
        )}
      </span>
      {d.reason && <div className="sub">“{d.reason}”</div>}
      {d.outcome && <div className="sub env-outcome">{d.outcome}</div>}
    </div>
  );
}

/** The rollout read back from the cluster, on demand. */
function StatusButton({ token, org, d }: { token: string; org: string; d: Deployment }) {
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const read = async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.deploymentStatus(token, org, d.id));
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="env-status">
      <button type="button" className="ghost" disabled={busy} onClick={() => void read()} data-deployment-status>
        {busy ? "Asking the cluster…" : status ? "Ask again" : "Status in the cluster"}
      </button>
      {error && <span className="error">{error}</span>}
      {status && (
        <ul className="env-workloads">
          {status.workloads.length === 0 && <li className="sub">No workloads in {d.namespace}.</li>}
          {status.workloads.map((w) => (
            <li key={w.name}>
              <span className={`badge env-${w.ready >= w.desired ? "ok" : "warn"}`}>
                {w.ready}/{w.desired}
              </span>{" "}
              {w.name} <span className="sub">{w.images.join(", ")}</span>
            </li>
          ))}
          {status.hosts.map((h) => (
            <li key={h}>
              <a href={`https://${h}`} target="_blank" rel="noreferrer">
                {h}
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A Research environment's place: the organization's Research connection,
 *  one of its projects and, optionally, a hardware configuration, as the
 *  integration service lists them (ADR-0049 §2). Typed by hand when Research
 *  cannot be asked. */
function ResearchFields({
  token,
  org,
  input,
  researches,
  set,
  shown,
}: {
  token: string;
  org: string;
  input: DeployEnvironmentInput;
  researches: Connection[];
  set: <K extends keyof DeployEnvironmentInput>(k: K, v: DeployEnvironmentInput[K]) => void;
  shown: (f: EnvironmentField) => string | null;
}) {
  const [projects, setProjects] = useState<ResearchProject[] | null>(null);
  const [hardware, setHardware] = useState<ResearchHardware[] | null>(null);
  const [unreachable, setUnreachable] = useState<string | null>(null);
  const connection = input.connection_id;
  const project = input.research_project ?? "";
  useEffect(() => {
    if (!connection) return;
    let live = true;
    setProjects(null);
    setUnreachable(null);
    api
      .researchProjects(token, org, connection)
      .then((r) => live && setProjects(r.items))
      .catch((e) => live && (setProjects([]), setUnreachable(errText(e))));
    return () => {
      live = false;
    };
  }, [token, org, connection]);
  useEffect(() => {
    if (!connection || !project || unreachable) return;
    let live = true;
    setHardware(null);
    api
      .researchHardware(token, org, connection, project)
      .then((r) => live && setHardware(r.items))
      .catch(() => live && setHardware([]));
    return () => {
      live = false;
    };
  }, [token, org, connection, project, unreachable]);
  const typed = unreachable !== null || (projects !== null && projects.length === 0);
  return (
    <>
      <label className="field">
        Constructor Research connection
        <select
          value={connection}
          onChange={(e) => set("connection_id", e.target.value)}
          aria-label="Constructor Research connection"
          aria-invalid={shown("connection_id") ? true : undefined}
          data-research-connection
        >
          <option value="">{researches.length === 0 ? "No Research connection yet" : "Choose a connection"}</option>
          {researches.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <span className="sub">
          Sign in to Research once in Organization › Connections, shared with the organization: builds and deploys run as
          its service.
        </span>
        {shown("connection_id") && <span className="env-field-error">{shown("connection_id")}</span>}
      </label>
      {connection && (
        <label className="field">
          Research project
          {typed ? (
            <input
              value={project}
              onChange={(e) => set("research_project", e.target.value)}
              placeholder="the Research project's id"
              aria-label="Research project"
              aria-invalid={shown("research_project") ? true : undefined}
              data-research-project
            />
          ) : (
            <select
              value={project}
              onChange={(e) => {
                set("research_project", e.target.value);
                set("research_hardware", null);
              }}
              aria-label="Research project"
              aria-invalid={shown("research_project") ? true : undefined}
              data-research-project
            >
              <option value="">{projects === null ? "Asking Research…" : "Choose a project"}</option>
              {(projects ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.id}
                </option>
              ))}
            </select>
          )}
          <span className="sub">
            Each Studio project runs there as one application per environment, named{" "}
            <code>{"{project}-" + (input.name || "env")}</code>.
          </span>
          {unreachable && <span className="hint">Research could not list the projects ({unreachable}); type the id.</span>}
          {shown("research_project") && <span className="env-field-error">{shown("research_project")}</span>}
        </label>
      )}
      {connection && project && (
        <label className="field">
          Hardware
          {hardware && hardware.length > 0 ? (
            <select
              value={input.research_hardware ?? ""}
              onChange={(e) => set("research_hardware", e.target.value || null)}
              aria-label="Hardware"
              data-research-hardware
            >
              <option value="">Research&apos;s default</option>
              {hardware.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name || h.id}
                  {h.trial ? " — trial: Research ends what runs on it by its own rules" : ""}
                </option>
              ))}
            </select>
          ) : (
            <input
              value={input.research_hardware ?? ""}
              onChange={(e) => set("research_hardware", e.target.value || null)}
              placeholder="Research's default"
              aria-label="Hardware"
              data-research-hardware
            />
          )}
        </label>
      )}
    </>
  );
}

/** Add or change one environment. */
function EnvironmentForm({
  token,
  org,
  editing,
  others,
  clusters,
  registries,
  researches,
  projects,
  onDone,
  onCancel,
  onClusterAdded,
  initialCluster,
}: {
  token: string;
  org: string;
  /** The cluster a new environment starts on: the one selected above. */
  initialCluster?: string;
  editing: DeployEnvironment | null;
  others: DeployEnvironment[];
  clusters: Connection[];
  /** The organization's registry connections (ADR-0048). */
  registries: Connection[];
  /** The organization's Constructor Research connections (ADR-0049). */
  researches: Connection[];
  projects: Tenant[];
  onDone: () => void;
  onCancel: () => void;
  onClusterAdded: (c: Connection) => void;
}) {
  const [input, setInput] = useState<DeployEnvironmentInput>(() =>
    editing
      ? environmentInput(editing)
      : researches.some((c) => c.id === initialCluster)
        ? { ...emptyEnvironment(), kind: "research", connection_id: initialCluster ?? "" }
        : { ...emptyEnvironment(), connection_id: initialCluster || (clusters.length === 1 ? clusters[0].id : "") },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [connectingRegistry, setConnectingRegistry] = useState(false);
  // A field says what is wrong once it was touched, or once Add was pressed:
  // a fresh form is not a list of complaints.
  const [touched, setTouched] = useState<Set<EnvironmentField>>(new Set());
  const [tried, setTried] = useState(false);
  const problems = environmentProblems(input, others, editing?.id, registries);
  const problem = Object.values(problems)[0] ?? null;
  const shown = (f: EnvironmentField) => ((tried || touched.has(f)) && problems[f]) || null;
  const touch = (f: EnvironmentField) => setTouched((t) => (t.has(f) ? t : new Set(t).add(f)));
  const set = <K extends keyof DeployEnvironmentInput>(k: K, v: DeployEnvironmentInput[K]) => {
    setInput((i) => ({ ...i, [k]: v }));
    if (
      k !== "description" &&
      k !== "database" &&
      k !== "protected" &&
      k !== "database_image" &&
      k !== "promote_from" &&
      k !== "kind" &&
      k !== "research_hardware"
    )
      touch(k as EnvironmentField);
  };
  const patternIsDefault = (input.namespace_pattern ?? "").trim() === "" || input.namespace_pattern === DEFAULT_NAMESPACE_PATTERN;
  const examples = (projects.length > 0 ? projects.slice(0, 3).map((p) => p.name) : ["Studio Web"]).map((p) =>
    namespaceFor(input.namespace_pattern ?? "", p, input.name || "dev"),
  );
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (editing) await api.updateEnvironment(token, org, editing.id, input);
      else await api.createEnvironment(token, org, input);
      onDone();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const restricted = input.projects != null;
  const research = input.kind === "research";
  // Switching what runs the products starts its own fields over: a cluster's
  // registry means nothing to Research, and Research's project nothing to a cluster.
  const runOn = (kind: "kubernetes" | "research") =>
    setInput((i) => ({
      ...i,
      kind,
      connection_id: kind === "research" ? (researches.length === 1 ? researches[0].id : "") : clusters.length === 1 ? clusters[0].id : "",
      registry: "",
      registry_connection_id: null,
      research_project: null,
      research_hardware: null,
      database: i.database === "shared" ? "none" : i.database,
    }));
  return (
    <form
      className="card env-form"
      data-environment-form
      onSubmit={(e) => {
        e.preventDefault();
        setTried(true);
        if (!problem) void save();
      }}
    >
      <h3>{editing ? `Change ${editing.name}` : "Add an environment"}</h3>
      <label className="field">
        Name
        <input
          value={input.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="dev, stage or prod"
          aria-label="Name"
          aria-invalid={shown("name") ? true : undefined}
        />
        {shown("name") && <span className="env-field-error">{shown("name")}</span>}
      </label>
      <label className="field">
        Description
        <input value={input.description} onChange={(e) => set("description", e.target.value)} placeholder="optional" />
      </label>
      <label className="field">
        Runs on
        <select
          value={research ? "research" : "kubernetes"}
          onChange={(e) => runOn(e.target.value as "kubernetes" | "research")}
          aria-label="Runs on"
          data-environment-kind
        >
          <option value="kubernetes">A Kubernetes cluster of the organization</option>
          <option value="research">Constructor Research: its hardware, its registry, its addresses</option>
        </select>
      </label>
      {research && <ResearchFields token={token} org={org} input={input} researches={researches} set={set} shown={shown} />}
      {!research && (
      <>
      <label className="field">
        Cluster
        <select
          value={connecting ? NEW_CLUSTER : input.connection_id}
          onChange={(e) => {
            if (e.target.value === NEW_CLUSTER) {
              setConnecting(true);
              return;
            }
            setConnecting(false);
            set("connection_id", e.target.value);
          }}
          aria-label="Cluster"
          aria-invalid={shown("connection_id") ? true : undefined}
        >
          <option value="">{clusters.length === 0 ? "No cluster connected yet" : "Choose a cluster"}</option>
          {clusters.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} — {c.base_url}
            </option>
          ))}
          <option value={NEW_CLUSTER}>+ Connect a cluster…</option>
        </select>
        {!connecting && shown("connection_id") && <span className="env-field-error">{shown("connection_id")}</span>}
      </label>
      {connecting && (
        <AddCluster
          token={token}
          org={org}
          onCancel={() => setConnecting(false)}
          onAdded={(c) => {
            setConnecting(false);
            onClusterAdded(c);
            set("connection_id", c.id);
          }}
        />
      )}
      <label className="field">
        Image registry
        <input
          value={input.registry}
          onChange={(e) => set("registry", e.target.value)}
          placeholder="ghcr.io/acme — where the product's images are pulled from"
          aria-invalid={shown("registry") ? true : undefined}
        />
        {shown("registry") && <span className="env-field-error">{shown("registry")}</span>}
      </label>
      <label className="field">
        Registry login
        <select
          value={connectingRegistry ? NEW_CLUSTER : (input.registry_connection_id ?? "")}
          onChange={(e) => {
            if (e.target.value === NEW_CLUSTER) {
              setConnectingRegistry(true);
              return;
            }
            setConnectingRegistry(false);
            set("registry_connection_id", e.target.value || null);
          }}
          aria-label="Registry login"
          data-registry-login
        >
          <option value="">None — the images are public</option>
          {registries.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} — {c.base_url}
            </option>
          ))}
          <option value={NEW_CLUSTER}>+ Connect a registry…</option>
        </select>
        <span className="sub">
          The cluster pulls the product&apos;s images with it, and a published chart is fetched with it.
        </span>
      </label>
      {connectingRegistry && (
        <AddRegistry
          token={token}
          org={org}
          onCancel={() => setConnectingRegistry(false)}
          onAdded={(c) => {
            setConnectingRegistry(false);
            onClusterAdded(c);
            set("registry_connection_id", c.id);
            if (!input.registry.trim()) set("registry", new URL(c.base_url).host);
          }}
        />
      )}
      <details className="env-advanced" open={!patternIsDefault || !!shown("namespace_pattern")}>
        <summary>
          Namespaces: <code>{examples.join(", ")}</code>
          <span className="sub"> · one per project</span>
        </summary>
        <label className="field">
          Namespace pattern
          <input
            value={input.namespace_pattern ?? ""}
            onChange={(e) => set("namespace_pattern", e.target.value)}
            placeholder={DEFAULT_NAMESPACE_PATTERN}
            aria-invalid={shown("namespace_pattern") ? true : undefined}
          />
          <span className="hint">
            A pattern, not a name: <code>{"{project}"}</code> becomes each project&apos;s name and <code>{"{environment}"}</code>{" "}
            this environment&apos;s.
          </span>
          {shown("namespace_pattern") && <span className="env-field-error">{shown("namespace_pattern")}</span>}
        </label>
      </details>
      </>
      )}
      <label className="field">
        Database
        <select
          value={input.database}
          onChange={(e) => set("database", e.target.value as "none" | "shared" | "namespace")}
          aria-label="Database"
        >
          <option value="none">None: the product brings its own</option>
          <option value="namespace">
            {research
              ? "A Postgres service of the product's own in its Research application, with the databases its gears keep"
              : "A Postgres of the product's own, in its namespace, with the databases its gears keep"}
          </option>
          {!research && (
            <option value="shared">The environment&apos;s shared Postgres — recorded only, not handed to the chart yet</option>
          )}
        </select>
      </label>
      {input.database === "namespace" && (
        <label className="field">
          Postgres image
          <input
            value={input.database_image ?? ""}
            onChange={(e) => set("database_image", e.target.value || null)}
            placeholder="pgvector/pgvector:pg18 — graph-storage asks for pgvector"
          />
        </label>
      )}
      <label className="field">
        Takes releases from
        <select
          value={input.promote_from ?? ""}
          onChange={(e) => set("promote_from", e.target.value || null)}
          aria-label="Takes releases from"
        >
          <option value="">Anywhere: any build may be deployed here</option>
          {others
            .filter((o) => o.id !== editing?.id)
            .map((o) => (
              <option key={o.id} value={o.id}>
                Only what succeeded in {o.name}
              </option>
            ))}
        </select>
      </label>
      <label className="env-check">
        <input type="checkbox" checked={input.protected} onChange={(e) => set("protected", e.target.checked)} /> Protected: a
        deploy waits for an organization administrator&apos;s approval
      </label>
      <label className="env-check">
        <input type="checkbox" checked={!restricted} onChange={(e) => set("projects", e.target.checked ? null : [])} /> Every
        project of the organization may deploy here
      </label>
      {restricted && (
        <ul className="env-projects">
          {projects.length === 0 && <li className="hint">No projects found.</li>}
          {projects.map((p) => (
            <li key={p.id}>
              <label>
                <input
                  type="checkbox"
                  checked={input.projects?.includes(p.id) ?? false}
                  onChange={(e) =>
                    set(
                      "projects",
                      e.target.checked ? [...(input.projects ?? []), p.id] : (input.projects ?? []).filter((id) => id !== p.id),
                    )
                  }
                />{" "}
                {p.name}
              </label>
            </li>
          ))}
        </ul>
      )}
      {shown("projects") && <span className="env-field-error">{shown("projects")}</span>}
      {error && <div className="error">{error}</div>}
      <div className="env-actions">
        <button type="submit" className="primary" disabled={busy || connecting}>
          {editing ? "Save" : "Add"}
        </button>
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/** The organization's Environments section. */
export function OrgEnvironments({ token, org, workspaceIds }: { token: string; org: { id: string; name: string }; workspaceIds: string[] }) {
  const [environments, setEnvironments] = useState<DeployEnvironment[] | null>(null);
  const [mayManage, setMayManage] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [projects, setProjects] = useState<Tenant[]>([]);
  const [editing, setEditing] = useState<DeployEnvironment | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [connectingCluster, setConnectingCluster] = useState(false);
  /** The cluster whose environments and deploys are shown below the cards. */
  const [selected, setSelected] = useState<string | null>(null);
  /** Each cluster's answer to a test, asked when the page opens. */
  const [health, setHealth] = useState<Record<string, { state: "checking" | "ok" | "bad"; text: string; at: number }>>({});
  // What a Test answered, kept at the row it was asked from.
  const [answers, setAnswers] = useState<Record<string, { ok: boolean; text: string }>>({});
  const ask = async (key: string, run: () => Promise<string>) => {
    setBusy(key);
    try {
      const text = await run();
      setAnswers((a) => ({ ...a, [key]: { ok: true, text } }));
    } catch (e) {
      setAnswers((a) => ({ ...a, [key]: { ok: false, text: errText(e) } }));
    } finally {
      setBusy(null);
    }
  };
  const Answer = ({ id }: { id: string }) =>
    answers[id] ? <div className={`sub env-answer ${answers[id].ok ? "env-answer-ok" : "error"}`}>{answers[id].text}</div> : null;

  const load = useCallback(() => {
    let live = true;
    setError(null);
    Promise.all([
      api.environments(token, org.id),
      api.connections(token, org.id).catch(() => ({ items: [] as Connection[] })),
      api.deployments(token, { org: org.id }).catch(() => ({ items: [] as Deployment[], total: 0 })),
    ])
      .then(([envs, conns, deps]) => {
        if (!live) return;
        setEnvironments(envs.items);
        setMayManage(envs.may_manage);
        setConnections(conns.items);
        setDeployments(deps.items);
      })
      .catch((e) => {
        if (!live) return;
        setEnvironments([]);
        setError(e instanceof ApiError && e.status === 404 ? "This Studio has no environments yet (the backend predates them)." : errText(e));
      });
    return () => {
      live = false;
    };
  }, [token, org.id]);
  useEffect(load, [load]);

  useEffect(() => {
    let live = true;
    Promise.all(workspaceIds.map((w) => api.tenantChildrenAll(token, w).then((p) => p.items).catch(() => [] as Tenant[]))).then((lists) => {
      if (live) setProjects(lists.flat().filter((t) => PROJECT_TYPE.test(t.tenant_type)));
    });
    return () => {
      live = false;
    };
  }, [token, workspaceIds]);

  const clusters = useMemo(() => clusterConnections(connections), [connections]);
  const registries = useMemo(() => registryConnections(connections), [connections]);
  const researches = useMemo(() => researchConnections(connections), [connections]);
  // A Research connection is a place products run, beside the clusters.
  const places = useMemo(() => [...clusters, ...researches], [clusters, researches]);
  const cards = useMemo(() => clusterCards(places, environments ?? [], deployments), [places, environments, deployments]);
  const current: ClusterCard | null = cards.find((c) => c.id === selected) ?? cards[0] ?? null;
  const check = useCallback(
    (id: string) => {
      setHealth((h) => ({ ...h, [id]: { state: "checking", text: "Checking…", at: Date.now() } }));
      api
        .testConnection(token, id, org.id)
        .then((t) => setHealth((h) => ({ ...h, [id]: { state: "ok", text: t.account, at: Date.now() } })))
        .catch((e) => setHealth((h) => ({ ...h, [id]: { state: "bad", text: errText(e), at: Date.now() } })));
    },
    [token, org.id],
  );
  // Every cluster is asked once when the page opens, so the cards say at a
  // glance which answer and which do not.
  const clusterIds = clusters.map((c) => c.id).join(",");
  useEffect(() => {
    for (const c of clusters) check(c.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clusterIds, check]);
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id.slice(0, 8);

  const act = async (key: string, run: () => Promise<string>) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      setNotice(await run());
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const waiting = awaitingDecision(deployments);

  return (
    <div className="envs" data-org-environments>
      <style>{ENV_CSS}</style>
      <h1>Environments</h1>
      <p className="subtitle">
        Where {org.name}&apos;s products run: a cluster, the registry its images come from, a namespace per project. A project
        binds its product&apos;s kubernetes profiles to these, and a deploy runs on the server with the environment&apos;s
        connection -- nobody&apos;s laptop holds the cluster&apos;s credentials.
      </p>
      {error && <div className="error">{error}</div>}
      {notice && <div className="hint">{notice}</div>}

      {waiting.length > 0 && (
        <section className="card" data-deploys-awaiting>
          <h3>Waiting for a decision</h3>
          <ul className="env-list">
            {waiting.map((d) => (
              <li key={d.id}>
                <DeploymentLine d={d} showProject />
                {mayManage ? (
                  <div className="env-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy === d.id}
                      data-deploy-approve
                      onClick={() =>
                        void act(d.id, async () => {
                          await api.decideDeployment(token, org.id, d.id, "approve");
                          return `Approved: ${d.product} goes to ${d.environment_name}.`;
                        })
                      }
                    >
                      Approve
                    </button>
                    <button type="button" disabled={busy === d.id} onClick={() => setDeclining(declining === d.id ? null : d.id)}>
                      Decline…
                    </button>
                    {declining === d.id && (
                      <>
                        <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="required: why not" aria-label="Reason" />
                        <button
                          type="button"
                          disabled={busy === d.id || !reason.trim()}
                          onClick={() =>
                            void act(d.id, async () => {
                              await api.decideDeployment(token, org.id, d.id, "decline", reason.trim());
                              setDeclining(null);
                              setReason("");
                              return `Declined the deploy of ${d.product} to ${d.environment_name}.`;
                            })
                          }
                        >
                          Decline
                        </button>
                      </>
                    )}
                  </div>
                ) : (
                  <p className="hint">An organization administrator decides.</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="card" data-clusters>
        <DataTable<ClusterCard>
          list="clusters"
          title="Clusters"
          rows={environments === null ? null : cards}
          rowKey={(c) => c.id || "unseen"}
          rowLabel={(c) => c.label}
          onOpen={(c) => setSelected(c.id)}
          search={{ placeholder: "Search clusters" }}
          searchText={(c) => [c.label, c.baseUrl, ...c.environments.map((e) => e.name)]}
          defaultView="table"
          primary={
            mayManage ? (
              <button type="button" className="primary" onClick={() => setConnectingCluster(true)} data-cluster-add>
                Connect a cluster
              </button>
            ) : undefined
          }
          empty={{ title: "No cluster connected yet.", body: "Connect one to add the environments products run in." }}
          columns={[
            {
              id: "cluster",
              header: "Cluster",
              compare: (a, b) => a.label.localeCompare(b.label),
              cell: (c) => (
                <div className={`env-cluster-cell${current?.id === c.id ? " on" : ""}`}>
                  <span className={`env-dot env-dot-${c.id ? (health[c.id]?.state ?? "checking") : "bad"}`} aria-hidden />
                  <div>
                    <div className="pname">{c.label}</div>
                    <div className="sub">{c.baseUrl ? c.baseUrl.replace(/^https?:\/\//, "") : "its connection is out of reach"}</div>
                  </div>
                </div>
              ),
            },
            {
              id: "health",
              header: "Answers",
              cell: (c) => (
                <span className={`env-cluster-health ${c.id ? (health[c.id]?.state ?? "") : "bad"}`}>
                  {c.id ? (health[c.id]?.text ?? "Checking…") : "—"}
                </span>
              ),
            },
            {
              id: "environments",
              header: "Environments",
              compare: (a, b) => a.environments.length - b.environments.length,
              cell: (c) =>
                c.environments.length === 0 ? (
                  <span className="sub">none yet</span>
                ) : (
                  <span className="env-cluster-envs">
                    {c.environments.map((e) => (
                      <span key={e.id} className={`env-chip${e.protected ? " protected" : ""}`} title={e.protected ? "Protected: a deploy waits for approval" : undefined}>
                        {e.protected ? "🔒 " : ""}
                        {e.name}
                      </span>
                    ))}
                  </span>
                ),
            },
            { id: "running", header: "Running", num: true, compare: (a, b) => a.running.length - b.running.length, cell: (c) => c.running.length },
            {
              id: "deployed",
              header: "Last deploy",
              compare: (a, b) => (a.lastDeploy ?? "").localeCompare(b.lastDeploy ?? ""),
              cell: (c) => (c.lastDeploy ? relTime(c.lastDeploy) : <span className="sub">never</span>),
            },
          ]}
          actions={(c) => (c.id ? [{ label: "Test again", onSelect: () => check(c.id) }] : [])}
          tile={(c, open) => (
            <Tile
              tone={current?.id === c.id ? "env-tile-on" : undefined}
              icon={<span className={`env-dot env-dot-${c.id ? (health[c.id]?.state ?? "checking") : "bad"}`} aria-hidden />}
              title={c.label}
              subtitle={
                <span className={`env-cluster-health ${c.id ? (health[c.id]?.state ?? "") : "bad"}`}>
                  {c.id ? (health[c.id]?.text ?? "Checking…") : "its connection is out of reach"}
                </span>
              }
              onClick={open}
              stats={[
                { label: "envs", value: c.environments.length },
                { label: "running", value: c.running.length },
                { label: "deployed", value: c.lastDeploy ? relTime(c.lastDeploy) : "never" },
              ]}
              footer={
                c.environments.length ? (
                  <span className="env-cluster-envs">
                    {c.environments.map((e) => (
                      <span key={e.id} className={`env-chip${e.protected ? " protected" : ""}`}>
                        {e.protected ? "🔒 " : ""}
                        {e.name}
                      </span>
                    ))}
                  </span>
                ) : undefined
              }
            />
          )}
        />
      </div>
      {connectingCluster && (
        <section className="card">
          <AddCluster
            token={token}
            org={org.id}
            onCancel={() => setConnectingCluster(false)}
            onAdded={(c) => {
              setConnectingCluster(false);
              setNotice(`Connected ${c.label}.`);
              setSelected(c.id);
              load();
            }}
          />
        </section>
      )}
      {cards.length === 0 && !connectingCluster && (
        <p className="empty">No cluster connected yet. Connect one to add the environments products run in.</p>
      )}

      {current && (
        <section className="card env-detail" data-cluster-detail={current.label}>
          <div className="card-head">
            <div>
              <h3>{current.label}</h3>
              {current.baseUrl && <code className="sub">{current.baseUrl}</code>}
            </div>
            <div className="env-actions">
              {current.id && (
                <button type="button" className="ghost" disabled={health[current.id]?.state === "checking"} onClick={() => check(current.id)}>
                  {health[current.id]?.state === "checking" ? "Asking…" : "Test again"}
                </button>
              )}
              {mayManage && editing === null && current.id && (
                <button type="button" className="primary" onClick={() => setEditing("new")} data-environment-add>
                  Add an environment here
                </button>
              )}
            </div>
          </div>

          <h4 className="env-sub">Environments on it</h4>
          {editing !== null && (
            <EnvironmentForm
              token={token}
              org={org.id}
              editing={editing === "new" ? null : editing}
              others={environments ?? []}
              clusters={clusters}
              registries={registries}
              researches={researches}
              projects={projects}
              initialCluster={current.id}
              onCancel={() => setEditing(null)}
              onDone={() => {
                setEditing(null);
                load();
              }}
              onClusterAdded={(c) => setConnections((cs) => [...cs, c])}
            />
          )}
          <DataTable<DeployEnvironment>
            list="cluster-environments"
            rows={environments === null ? null : current.environments}
            rowKey={(e) => e.id}
            rowLabel={(e) => e.name}
            empty={{
              title: "No environment on this cluster yet.",
              body: mayManage ? "Add dev, stage or prod here." : "An organization administrator adds them.",
            }}
            columns={[
              {
                id: "name",
                header: "Environment",
                compare: (a, b) => a.name.localeCompare(b.name),
                cell: (e) => (
                  <div data-environment={e.name}>
                    <div className="env-head">
                      <b>{e.name}</b>
                      {e.protected && <span className="badge">protected</span>}
                      {e.database === "shared" && <span className="badge">shared database</span>}
                      {e.database === "namespace" && <span className="badge">own Postgres</span>}
                    </div>
                    {e.description && <div className="sub">{e.description}</div>}
                    <Answer id={e.id} />
                  </div>
                ),
              },
              { id: "images", header: "Images", cell: (e) => (e.registry ? <code>{e.registry}</code> : <span className="sub">where the chart says</span>) },
              {
                id: "namespaces",
                header: "Namespaces",
                cell: (e) => (
                  <>
                    <code>{namespaceFor(e.namespace_pattern, projects[0]?.name ?? "Studio Web", e.name)}</code>
                    {projects.length > 1 ? " …" : ""}
                  </>
                ),
              },
              {
                id: "projects",
                header: "Projects",
                cell: (e) => (e.projects ? (e.projects.length ? e.projects.map(projectName).join(", ") : "none yet") : "every project"),
              },
              {
                id: "running",
                header: "Running",
                cell: (e) => {
                  const here = current.running.filter((d) => d.environment_id === e.id);
                  return here.length ? here.map((d) => d.project_name).join(", ") : <span className="sub">nothing yet</span>;
                },
              },
            ]}
            actions={(e) =>
              mayManage
                ? [
                    { label: busy === e.id ? "Asking…" : "Test", disabled: busy === e.id, onSelect: () => ask(e.id, async () => (await api.testEnvironment(token, org.id, e.id)).message) },
                    { label: "Change", onSelect: () => setEditing(e) },
                    {
                      label: "Remove",
                      danger: { title: `Remove ${e.name}?`, body: "What runs in the cluster stays there.", confirmLabel: "Remove" },
                      onSelect: () =>
                        act(e.id, async () => {
                          await api.deleteEnvironment(token, org.id, e.id);
                          return `Removed ${e.name}.`;
                        }),
                    },
                  ]
                : []
            }
          />

          <h4 className="env-sub" data-running-now>
            What runs here
          </h4>
          {current.running.length === 0 ? (
            <p className="empty">Nothing deployed to this cluster yet. A project deploys from its Deploys tab, or from the desktop after Generate.</p>
          ) : (
            <ul className="env-list">
              {current.running.map((d) => (
                <li key={d.id}>
                  <DeploymentLine d={d} showProject />
                  <StatusButton token={token} org={org.id} d={d} />
                </li>
              ))}
            </ul>
          )}

          <h4 className="env-sub">Deploys to it</h4>
          {current.deployments.length === 0 ? (
            <p className="empty">None yet.</p>
          ) : (
            <ul className="env-list">
              {current.deployments.slice(0, 20).map((d) => (
                <li key={d.id}>
                  <DeploymentLine d={d} showProject />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/** A project's environments, on its product card: bindings and deployments. */
export function ProjectEnvironments({
  token,
  projectId,
  profiles,
  title = "Environments",
}: {
  token: string;
  projectId: string;
  profiles: readonly string[];
  /** The heading: where the bindings sit decides what they are called. */
  title?: string;
}) {
  const [targets, setTargets] = useState<ProjectTargets | null>(null);
  const [bindings, setBindings] = useState<EnvironmentBinding[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([api.projectTargets(token, projectId), api.deployments(token, { project: projectId }).catch(() => ({ items: [] as Deployment[], total: 0 }))])
      .then(([t, d]) => {
        if (!live) return;
        setTargets(t);
        setBindings(t.bindings);
        setDeployments(d.items);
      })
      .catch((e) => {
        if (!live) return;
        if (e instanceof ApiError && e.status === 404) setUnavailable(true);
        else setError(errText(e));
      });
    return () => {
      live = false;
    };
  }, [token, projectId]);

  if (unavailable) return null;
  const bound = (profile: string) => bindings.find((b) => b.profile === profile)?.environment_id ?? "";
  const bind = (profile: string, environment: string) => {
    setSaved(false);
    setBindings((all) => [...all.filter((b) => b.profile !== profile), ...(environment ? [{ profile, environment_id: environment }] : [])]);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      setBindings((await api.saveBindings(token, projectId, bindings)).items);
      setSaved(true);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const changed = targets !== null && JSON.stringify(sortBindings(bindings)) !== JSON.stringify(sortBindings(targets.bindings));

  return (
    <div className="envs env-project" data-project-environments>
      <style>{ENV_CSS}</style>
      <div className="card-head">
        <h3>{title}</h3>
      </div>
      {error && <div className="error">{error}</div>}
      {targets === null ? (
        <p className="hint">Loading…</p>
      ) : targets.environments.length === 0 ? (
        <p className="empty">The organization has no environment this project may deploy to yet.</p>
      ) : (
        <>
          <p className="hint">
            Bind each kubernetes profile of the product to an environment: Deploy on the desktop takes the namespace and the image
            registry from it.
          </p>
          <ul className="env-list">
            {profiles.map((profile) => {
              const env = targets.environments.find((t) => t.environment.id === bound(profile));
              return (
                <li key={profile} className="env-binding">
                  <code>{profile}</code> →{" "}
                  <select value={bound(profile)} onChange={(e) => bind(profile, e.target.value)} aria-label={`Environment for ${profile}`}>
                    <option value="">not bound</option>
                    {targets.environments.map((t) => (
                      <option key={t.environment.id} value={t.environment.id}>
                        {t.environment.name}
                        {t.environment.protected ? " (protected)" : ""}
                      </option>
                    ))}
                  </select>
                  {env && (
                    <span className="sub">
                      {" "}
                      namespace <code>{env.namespace}</code>
                      {env.environment.registry && (
                        <>
                          , images from <code>{env.environment.registry}</code>
                        </>
                      )}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="env-actions">
            <button type="button" className="primary" disabled={busy || !changed} onClick={() => void save()} data-bindings-save>
              Save
            </button>
            {saved && <span className="hint">Saved.</span>}
          </div>
        </>
      )}
      {deployments.length > 0 && targets && (
        <ul className="env-list">
          {deployments.slice(0, 10).map((d) => (
            <li key={d.id}>
              <DeploymentLine d={d} showProject={false} />
              {d.state === "succeeded" && <StatusButton token={token} org={targets.organization_id} d={d} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function sortBindings(b: EnvironmentBinding[]): EnvironmentBinding[] {
  return [...b].sort((x, y) => x.profile.localeCompare(y.profile));
}

const ENV_CSS = `
.envs .env-clusters { display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:12px; margin:12px 0; }
.envs .env-cluster { display:flex; flex-direction:column; align-items:flex-start; gap:6px; padding:14px 16px; border:1px solid var(--border); border-radius:var(--radius-lg, 12px); background:var(--card); color:var(--foreground); text-align:left; cursor:pointer; font:inherit; transition:border-color .15s, box-shadow .15s, transform .15s; }
.envs .env-cluster:hover { border-color:color-mix(in srgb, var(--primary) 45%, var(--border)); transform:translateY(-1px); }
.envs .env-cluster.on { border-color:var(--primary); box-shadow:0 0 0 1px var(--primary) inset, 0 4px 14px color-mix(in srgb, var(--primary) 14%, transparent); }
.envs .env-cluster.unseen { border-style:dashed; }
.envs .env-cluster-top { display:flex; align-items:center; gap:8px; font-size:15px; }
.envs .env-cluster-url { font-size:12px; color:var(--muted-foreground); }
.envs .env-cluster-health { font-size:12.5px; color:var(--muted-foreground); }
.envs .env-cluster-health.ok { color:#15803d; }
.envs .env-cluster-health.bad { color:var(--destructive, #dc2626); }
.envs .env-cluster-stats { display:flex; flex-wrap:wrap; gap:4px 12px; font-size:12.5px; color:var(--muted-foreground); }
.envs .env-cluster-stats b { color:var(--foreground); font-size:14px; }
.envs .env-cluster-envs { display:flex; flex-wrap:wrap; gap:4px; }
.envs .env-chip { font-size:11.5px; padding:1px 8px; border-radius:999px; background:var(--accent); }
.envs .env-chip.protected { background:color-mix(in srgb, #d97706 16%, transparent); }
.envs .env-cluster-add { justify-content:center; border-style:dashed; color:var(--primary); min-height:120px; }
.envs .env-dot { width:9px; height:9px; border-radius:50%; background:var(--muted-foreground); flex:none; }
.envs .env-dot-ok { background:#16a34a; box-shadow:0 0 0 3px color-mix(in srgb, #16a34a 22%, transparent); }
.envs .env-dot-bad { background:#dc2626; box-shadow:0 0 0 3px color-mix(in srgb, #dc2626 22%, transparent); }
.envs .env-dot-checking { background:#d97706; animation:env-pulse 1s ease-in-out infinite; }
@keyframes env-pulse { 50% { opacity:.35; } }
.envs .env-cluster-cell { display:flex; align-items:center; gap:10px; }
.envs .env-cluster-cell.on .pname { color:var(--primary); }
.vtile.env-tile-on { border-color:var(--primary); box-shadow:0 0 0 1px var(--primary) inset; }
.envs .env-detail .card-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
.envs .env-sub { margin:16px 0 6px; font-size:12px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted-foreground); }
.envs .env-grid { list-style:none; padding:0; margin:0; display:grid; grid-template-columns:repeat(auto-fill, minmax(300px, 1fr)); gap:10px; }
.envs .env-card { border:1px solid var(--border); border-radius:var(--radius-md, 8px); padding:12px; display:flex; flex-direction:column; gap:6px; }
.envs .env-facts { display:grid; grid-template-columns:auto 1fr; gap:3px 10px; margin:0; font-size:12.5px; }
.envs .env-facts dt { color:var(--muted-foreground); }
.envs .env-facts dd { margin:0; overflow-wrap:anywhere; }
.envs .env-list { list-style:none; padding:0; margin:8px 0 0; display:grid; gap:10px; }
.envs .env-head, .envs .env-deployment { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
.envs .sub { color:var(--muted-foreground); font-size:12px; }
.envs .env-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:6px; }
.envs .env-actions input { flex:1; min-width:200px; }
.envs .env-form { display:grid; gap:10px; margin:10px 0; }
.envs .env-check { display:flex; gap:6px; align-items:center; font-size:13px; }
.envs .env-projects { list-style:none; padding:0 0 0 22px; margin:0; display:grid; gap:4px; max-height:180px; overflow:auto; }
.envs .env-ok { background:color-mix(in srgb, #16a34a 18%, transparent); }
.envs .env-warn { background:color-mix(in srgb, #d97706 18%, transparent); }
.envs .env-bad { background:color-mix(in srgb, #dc2626 18%, transparent); }
.envs .env-outcome { white-space:pre-wrap; overflow-wrap:anywhere; }
.envs .env-workloads { list-style:none; padding:0; margin:6px 0 0; display:grid; gap:4px; font-size:13px; }
.envs .env-status { margin-top:6px; }
.envs .env-binding select { min-width:160px; }
.envs .env-field-error { color:var(--destructive, #dc2626); font-size:12px; }
.envs [aria-invalid] { border-color:var(--destructive, #dc2626); }
.envs .env-answer { margin-top:4px; }
.envs .env-answer-ok { color:#15803d; }
.envs .env-advanced summary { cursor:pointer; font-size:13px; }
.envs .env-advanced[open] summary { margin-bottom:8px; }
.env-project { margin-top:12px; }
`;
