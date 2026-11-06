/* Where an organization's products run (ADR-0043).
 *
 * `OrgInfrastructure` is the organization's Infrastructure section (ADR-0056
 * §2), in three parts: the places it holds (clusters, Constructor Research
 * projects, registries), each with its test, whether it is open to projects
 * and the environments on it; the environments, as the ladder a release
 * climbs, each with its place, database and approval; and what runs where,
 * with the deploys waiting for a decision. It was the Environments section,
 * and its old address still opens it. `ProjectEnvironments` sits on a
 * project's Releases tab: its kubernetes profiles bound to the environments,
 * and its deployments.
 *
 * A deploy itself is asked for from the desktop, which builds and pushes the
 * images and sends the generated chart; the server installs it with the
 * environment's connection. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { type DeclaredProfile, deployableProfiles, profileLabel } from "./product";
import { useDeclaredProfiles } from "./declared-profiles";
import { oneEach } from "./project-deploys";
import {
  ApiError,
  api,
  type Connection,
  type DeployEnvironment,
  type DeployEnvironmentInput,
  type Deployment,
  type ContainerLog,
  type DeploymentStatus,
  type EnvironmentBinding,
  type EnvironmentReadiness,
  type ProjectTargets,
  type ResearchHardware,
  type ResearchProject,
  type Tenant,
} from "./api";
import {
  DEFAULT_BUILD_NAMESPACE,
  DEFAULT_NAMESPACE_PATTERN,
  type ClusterCard,
  type EnvironmentField,
  STATE_LABELS,
  awaitingDecision,
  canReadStatus,
  clusterCards,
  clusterConnections,
  codedWarnings,
  emptyEnvironment,
  environmentInput,
  environmentProblems,
  registryConnections,
  researchConnections,
  registryHost,
  namespaceFor,
  readinessBadge,
  shortCommit,
  stateTone,
} from "./environments";
import { InfraPlacementField } from "./infra-services-view";
import { personLabel, usePeople, type PeopleNames } from "./user-names";
import { DataTable, RowMenu, When } from "./data-table";
import { errText, relTime } from "./format";
import { AddCluster, AddRegistry } from "./kubeconfig-field";
import { BoxIcon, CloudIcon, FlaskIcon, LockIcon } from "./icons";
import { Modal } from "./modal";
import { NamespaceAssignments, OrgRetention } from "./namespace-assignments-view";
import { RegistryBrowser } from "./registry-browser-view";
import { databaseWord, ladderOrder, versionOf, whatRunsWhere, type ProjectRuns } from "./releases";
import { EmptyState, PageHeader, StatusChip, type Tone } from "./ui-standard";
import "./infrastructure.css";
import { useDomainRefresh } from "./domain-live";
import { ModelFields } from "./object-attributes";

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
function DeploymentLine({ d, showProject, people }: { d: Deployment; showProject: boolean; people: PeopleNames }) {
  return (
    <div className="env-deployment">
      <StateBadge d={d} />
      <b>{d.product}</b>
      {/* Beside the environment, not in it (ADR-0055), and it goes on its own. */}
      {d.preview && (
        <span className="badge" title="A preview: its own namespace beside the environment, removed when it expires">
          preview {d.preview.name}
        </span>
      )}
      {(d.action ?? "install") === "uninstall" && <span className="badge">taken out</span>}
      {showProject && <span className="sub">{d.project_name}</span>}
      <span className="sub">
        → {d.environment_name} · <code>{d.namespace}</code>
        {d.commit && (
          <>
            {" "}
            · <code>{shortCommit(d.commit)}</code>
          </>
        )}{" "}
        · {personLabel(d.requested_by, d.requested_by_name, people)} · {relTime(d.requested_at)}
        {d.decided_at && (
          <>
            {" "}
            · {d.state === "declined" ? "declined" : "approved"} by {personLabel(d.decided_by, d.decided_by_name, people)}
          </>
        )}
      </span>
      {d.reason && <div className="sub">“{d.reason}”</div>}
      {d.outcome && <div className="sub env-outcome">{d.outcome}</div>}
      {(d.warnings ?? []).map((w) => (
        <div key={w} className="sub warn" data-deployment-warning>
          {w}
        </div>
      ))}
    </div>
  );
}

/** The rollout read back from the cluster, on demand. */
function StatusButton({
  token,
  org,
  d,
  place = "the cluster",
}: {
  token: string;
  org: string;
  d: Deployment;
  /** Where the product runs, as the button names it: "Research" for a Research environment. */
  place?: string;
}) {
  const [status, setStatus] = useState<DeploymentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<ContainerLog[] | null>(null);
  const [readingLogs, setReadingLogs] = useState(false);
  const readLogs = async () => {
    if (logs) {
      setLogs(null);
      return;
    }
    setReadingLogs(true);
    setError(null);
    try {
      setLogs((await api.deploymentLogs(token, org, d.id)).containers);
    } catch (e) {
      setError(errText(e));
    } finally {
      setReadingLogs(false);
    }
  };
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
        {busy ? `Asking ${place}…` : status ? "Ask again" : `Status in ${place}`}
      </button>{" "}
      <button type="button" className="ghost" disabled={readingLogs} onClick={() => void readLogs()} data-deployment-logs>
        {readingLogs ? "Reading the logs…" : logs ? "Hide logs" : "Logs"}
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
          {(status.problems ?? []).map((p) => (
            <li key={p} className="error" data-deployment-problem>
              {p}
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
      {logs && (
        <div className="env-logs" data-deployment-logs-view>
          {logs.length === 0 && <p className="sub">No pods of this release run in {d.namespace}.</p>}
          {logs.map((l) => (
            <details key={`${l.pod}/${l.container}/${l.previous}`} open={logs.length === 1 || l.previous}>
              <summary>
                {l.pod} · {l.container}
                {l.previous ? " (the run before its last restart)" : ""}
              </summary>
              <pre style={{ maxHeight: 320, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                {l.text.trim() === "" ? "(empty)" : l.text}
              </pre>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}

/** A Research environment's place: the member's own Research sign-in that lists the projects,
 *  one of its projects and, optionally, a hardware configuration, as the
 *  integration service lists them (ADR-0049 §2). Typed by hand when Research
 *  cannot be asked. */
function ResearchFields({
  token,
  org,
  input,
  researches,
  fixed,
  set,
  shown,
}: {
  token: string;
  org: string;
  input: DeployEnvironmentInput;
  researches: Connection[];
  /** Opened from its place: the connection is that one, not asked again. */
  fixed?: boolean;
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
      {!fixed && (
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
          Your own sign-in to Research (Connections), to pick the project. Every member builds and deploys with
          their own sign-in; the project's owner adds them to it in Research.
        </span>
        {shown("connection_id") && <span className="env-field-error">{shown("connection_id")}</span>}
      </label>
      )}
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
export function EnvironmentForm({
  token,
  org,
  ownedBy,
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
  /** A project's own environment (ADR-0054): saved with the project, by its
   *  members, never protected and listing no projects. Absent: the
   *  organization's. */
  ownedBy?: { projectId: string; projectName: string };
  /** The cluster a new environment starts on: the one selected above. */
  initialCluster?: string;
  editing: DeployEnvironment | null;
  others: DeployEnvironment[];
  clusters: Connection[];
  /** The organization's registry connections (ADR-0048). */
  registries: Connection[];
  /** The caller's own Constructor Research sign-ins (ADR-0049). */
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
      k !== "strictness" &&
      k !== "kind" &&
      k !== "research_hardware"
    )
      touch(k as EnvironmentField);
  };
  const patternIsDefault = (input.namespace_pattern ?? "").trim() === "" || input.namespace_pattern === DEFAULT_NAMESPACE_PATTERN;
  const examples = (
    ownedBy ? [ownedBy.projectName] : projects.length > 0 ? projects.slice(0, 3).map((p) => p.name) : ["Studio Web"]
  ).map((p) =>
    namespaceFor(input.namespace_pattern ?? "", p, input.name || "dev"),
  );
  const examplesProject = ownedBy?.projectName ?? projects[0]?.name ?? "Studio Web";
  // Typed as text: a list rebuilt on every key would swallow the comma
  // being typed.
  const [namespacesText, setNamespacesText] = useState(() => (input.namespaces ?? []).join(", "));
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      if (ownedBy) {
        const own = { ...input, protected: false, projects: null };
        if (editing) await api.updateProjectEnvironment(token, ownedBy.projectId, editing.id, own);
        else await api.createProjectEnvironment(token, ownedBy.projectId, own);
      } else if (editing) await api.updateEnvironment(token, org, editing.id, input);
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
  // Added from a place's card ("Add an environment here"): it runs there. The
  // form does not offer another place, nor Research beside a cluster.
  // Changed: it stays on the place it runs on, which the form names too.
  const place = [...clusters, ...researches].find((c) => c.id === (editing ? editing.connection_id : initialCluster));
  // Switching what runs the products starts its own fields over: a cluster's
  // registry means nothing to Research, and Research's project nothing to a cluster.
  const runOn = (kind: "kubernetes" | "research") =>
    setInput((i) => ({
      ...i,
      kind,
      connection_id: kind === "research" ? (researches.length === 1 ? researches[0].id : "") : clusters.length === 1 ? clusters[0].id : "",
      registry: "",
      registry_connection_id: null,
      registry_pull_connection_id: null,
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
      <h3>{editing ? `Change ${editing.name}` : ownedBy ? `Add an environment of ${ownedBy.projectName}'s own` : "Add an environment"}</h3>
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
      {place ? (
        <div className="field" data-environment-place>
          Runs on
          <span>
            <b>{place.label}</b>
            {place.base_url && <code className="sub"> {place.base_url}</code>}
          </span>
          <span className="sub">
            {research
              ? "The Constructor Research project it runs in is chosen below; every member builds and deploys there with their own sign-in."
              : editing
                ? "The cluster it runs on."
                : "The cluster this was added from. Add an environment on another cluster from that cluster's card."}
          </span>
        </div>
      ) : (
      <label className="field">
        Runs on
        <select
          value={research ? "research" : "kubernetes"}
          onChange={(e) => runOn(e.target.value as "kubernetes" | "research")}
          aria-label="Runs on"
          data-environment-kind
        >
          <option value="kubernetes">
            {ownedBy
              ? "A Kubernetes cluster: the project's own, or one the organization opened to its projects"
              : "A Kubernetes cluster of the organization"}
          </option>
          <option value="research">Constructor Research: its hardware, its registry, its addresses</option>
        </select>
      </label>
      )}
      {research && (
        <ResearchFields token={token} org={org} input={input} researches={place ? [place] : researches} fixed={!!place} set={set} shown={shown} />
      )}
      {!research && (
      <>
      {!place && (
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
      )}
      {connecting && (
        <AddCluster
          token={token}
          org={ownedBy?.projectId ?? org}
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
          org={ownedBy?.projectId ?? org}
          onCancel={() => setConnectingRegistry(false)}
          onAdded={(c) => {
            setConnectingRegistry(false);
            onClusterAdded(c);
            set("registry_connection_id", c.id);
            if (!input.registry.trim()) set("registry", new URL(c.base_url).host);
          }}
        />
      )}
      <label className="field">
        Pull login
        <select
          value={input.registry_pull_connection_id ?? ""}
          onChange={(e) => set("registry_pull_connection_id", e.target.value || null)}
          aria-label="Pull login"
          data-registry-pull-login
        >
          <option value="">The registry login above</option>
          {registries
            .filter((c) => c.id !== input.registry_connection_id)
            .map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} — {c.base_url}
              </option>
            ))}
        </select>
        <span className="sub">
          A read-only login for the cluster to pull with. Without one, the cluster gets the login builds push with,
          which can write to the registry.
        </span>
      </label>
      {(editing?.warnings ?? []).length > 0 && (
        <ul className="hint" data-environment-warnings>
          {codedWarnings(editing!.warnings, editing!.warning_codes).map((w) => (
            <li key={w.text} data-warning-code={w.code ?? undefined}>
              {w.code ? <code>{w.code}</code> : null}
              {w.code ? " " : null}
              {w.text}
            </li>
          ))}
        </ul>
      )}
      <details
        className="env-advanced"
        open={
          !!(input.builder_image || input.build_namespace || (input.namespaces ?? []).length || input.allow_broad_registry_token) ||
          !!(shown("builder_image") || shown("build_namespace") || shown("namespaces"))
        }
        data-environment-builds
      >
        <summary>
          How builds run here
          <span className="sub">
            {" "}
            · in <code>{namespaceFor(input.build_namespace || DEFAULT_BUILD_NAMESPACE, examplesProject, input.name || "dev")}</code>,{" "}
            {input.builder_image ? "with the organization's builder" : "with Studio's own builder"}
          </span>
        </summary>
        <label className="field">
          Builder image
          <input
            value={input.builder_image ?? ""}
            onChange={(e) => set("builder_image", e.target.value.trim() || null)}
            placeholder="ghcr.io/acme/mirror/builder@sha256:… — empty: the one Studio ships with"
            aria-invalid={shown("builder_image") ? true : undefined}
            data-builder-image
          />
          <span className="hint">From the organization&apos;s own mirror, named by digest, so every build runs the same builder.</span>
          {shown("builder_image") && <span className="env-field-error">{shown("builder_image")}</span>}
        </label>
        <label className="field">
          Builder login
          <select
            value={input.builder_registry_connection_id ?? ""}
            onChange={(e) => set("builder_registry_connection_id", e.target.value || null)}
            aria-label="Builder login"
          >
            <option value="">None — the builder image is public</option>
            {registries.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} — {c.base_url}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Build namespace
          <input
            value={input.build_namespace ?? ""}
            onChange={(e) => set("build_namespace", e.target.value.trim() || null)}
            placeholder={DEFAULT_BUILD_NAMESPACE}
            aria-invalid={shown("build_namespace") ? true : undefined}
          />
          <span className="hint">
            A pattern like the namespace pattern: where a project&apos;s build Job runs, apart from what it deploys.
          </span>
          {shown("build_namespace") && <span className="env-field-error">{shown("build_namespace")}</span>}
        </label>
        <label className="field">
          Namespaces the cluster gives
          <input
            value={namespacesText}
            onChange={(e) => {
              setNamespacesText(e.target.value);
              const list = e.target.value
                .split(/[\s,]+/)
                .map((n) => n.trim())
                .filter(Boolean);
              set("namespaces", list.length ? list : null);
            }}
            placeholder="web-dev, web-build — empty: Studio creates its own"
            aria-invalid={shown("namespaces") ? true : undefined}
          />
          <span className="hint">
            When Studio may not create namespaces on this cluster, the ones its administrators made for Studio to use.
          </span>
          {shown("namespaces") && <span className="env-field-error">{shown("namespaces")}</span>}
        </label>
        <label className="env-check">
          <input
            type="checkbox"
            checked={!!input.allow_broad_registry_token}
            onChange={(e) => set("allow_broad_registry_token", e.target.checked)}
          />{" "}
          A build&apos;s registry token may reach past the project&apos;s own path (only for a registry that cannot scope
          one)
        </label>
      </details>
      {input.kind !== "research" && <InfraPlacementField input={input} set={set} />}
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
          <option value="none">
            {research
              ? "The product's own, when its gears keep data: a Postgres service in its Research application"
              : "The product's own, when its gears keep data: a Postgres in its namespace, with every deploy"}
          </option>
          {input.database === "namespace" && <option value="namespace">The product&apos;s own (as recorded before)</option>}
          {/* A shared server is recorded and deploys get nothing from it
              (ADR-0048 §7), so a new choice of it is not offered; one
              recorded before stays, saying so. */}
          {!research && input.database === "shared" && (
            <option value="shared">A shared Postgres — recorded only: deploys get no database from it</option>
          )}
        </select>
      </label>
      {input.database !== "shared" && (
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
      {!research && (
        <div className="field" data-environment-previews-settings>
          <label className="env-check">
            <input
              type="checkbox"
              checked={!!input.previews}
              onChange={(e) => set("previews", e.target.checked ? { domain: "", ingress_class: null, ttl_hours: 72, max_live: 3 } : null)}
            />{" "}
            Previews: a project may try a build here in a namespace of its own, removed when it expires
          </label>
          {input.previews && (
            <div
              className="env-previews"
              style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 8 }}
            >
              <label className="field">
                Preview domain
                <input
                  value={input.previews.domain}
                  onChange={(e) => input.previews && set("previews", { ...input.previews, domain: e.target.value })}
                  placeholder="preview.example.com — a wildcard DNS record to the cluster's ingress; empty: no address"
                />
              </label>
              <label className="field">
                Ingress class
                <input
                  value={input.previews.ingress_class ?? ""}
                  onChange={(e) => input.previews && set("previews", { ...input.previews, ingress_class: e.target.value || null })}
                  placeholder="the cluster's default"
                />
              </label>
              <label className="field">
                Lives for, hours
                <input
                  type="number"
                  min={1}
                  max={336}
                  value={input.previews.ttl_hours ?? 72}
                  onChange={(e) => input.previews && set("previews", { ...input.previews, ttl_hours: Number(e.target.value) })}
                />
              </label>
              <label className="field">
                At once, per project
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={input.previews.max_live ?? 3}
                  onChange={(e) => input.previews && set("previews", { ...input.previews, max_live: Number(e.target.value) })}
                />
              </label>
            </div>
          )}
          {shown("previews") && <span className="env-field-error">{shown("previews")}</span>}
        </div>
      )}
      {!research && (
        <label className="field" data-environment-strictness>
          Checks a product as
          <select
            value={input.strictness ?? ""}
            onChange={(e) => set("strictness", (e.target.value || null) as DeployEnvironmentInput["strictness"])}
            aria-label="Checks a product as"
          >
            <option value="">
              {input.protected ? "production" : "development"}, as {input.protected ? "a protected" : "an unprotected"} environment does
            </option>
            <option value="dev">development: the production rules only warn</option>
            <option value="prod">production: a production rule that fails stops the build</option>
          </select>
          <span className="sub">
            What the engine checks the product against when it is built for here (ADR-0060). A development check lets a
            product without an identity provider or a tenant resolver build, and says what it lacks.
          </span>
        </label>
      )}
      {ownedBy ? (
        <p className="sub" data-own-environment-note>
          Only {ownedBy.projectName} sees and deploys to it. An environment whose deploys need approval is the
          organization&apos;s: ask an organization administrator for one.
        </p>
      ) : (
        <>
          <label className="env-check">
            <input type="checkbox" checked={input.protected} onChange={(e) => set("protected", e.target.checked)} /> Protected:
            a deploy waits for an organization administrator&apos;s approval
          </label>
          <label className="env-check">
            <input type="checkbox" checked={!restricted} onChange={(e) => set("projects", e.target.checked ? null : [])} />{" "}
            Every project of the organization may deploy here
          </label>
        </>
      )}
      {!ownedBy && restricted && (
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

/** What a place is: a cluster or a Constructor Research project products run
 *  on, or a registry their images come from (ADR-0056 §1). */
type PlaceKind = "cluster" | "research" | "registry";

const PLACE_WORD: Record<PlaceKind, string> = { cluster: "Cluster", research: "Constructor Research", registry: "Registry" };

/** A place's kind as its mark: the same one on its card, on a rung of the
 *  ladder and in its panel. */
function PlaceIcon({ kind, size = 16 }: { kind: PlaceKind; size?: number }) {
  if (kind === "research") return <FlaskIcon size={size} aria-label="Constructor Research" />;
  if (kind === "registry") return <BoxIcon size={size} aria-label="Registry" />;
  return <CloudIcon size={size} aria-label="Kubernetes cluster" />;
}

/** One place as the page holds it: what it is, how it answered, and the
 *  environments on it (or, for a registry, those that pull from it). */
interface Place {
  /** The connection's id; "" for environments on a cluster this page cannot see. */
  id: string;
  kind: PlaceKind;
  label: string;
  baseUrl: string;
  environments: DeployEnvironment[];
  card: ClusterCard | null;
}

/** Opens Organization › Connections, where a member signs in to Constructor
 *  Research: the sign-in is the member's own (ADR-0049 §5), so it is not made
 *  on this page. */
function openConnections() {
  window.history.pushState(null, "", `/connections${window.location.search}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** "Add a place ▾": the one way a place is added, whatever its kind. */
function AddPlaceMenu({ onPick }: { onPick: (kind: PlaceKind) => void }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (wrap.current && e.target instanceof Node && !wrap.current.contains(e.target)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const item = (kind: PlaceKind, sub: string) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        setOpen(false);
        onPick(kind);
      }}
      data-add-place={kind}
    >
      <PlaceIcon kind={kind} />
      <span>
        <b>{PLACE_WORD[kind]}</b>
        <span className="sub">{sub}</span>
      </span>
    </button>
  );
  return (
    <div className="infra-menu" ref={wrap}>
      <button type="button" className="primary" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-place-add>
        Add a place ▾
      </button>
      {open && (
        <div className="infra-menu-list" role="menu">
          {item("cluster", "a Kubernetes cluster, by its kubeconfig")}
          {item("research", "your sign-in to a Research project")}
          {item("registry", "where images and charts are pushed")}
        </div>
      )}
    </div>
  );
}

/** The organization's Infrastructure section (ADR-0056 §2): one header, the
 *  environments as the ladder a release climbs (or, in the tab beside it,
 *  what runs where), then the places as one grid of cards. A place's details
 *  open in a side panel; an environment is added from its place. */
export function OrgInfrastructure({ token, org, workspaceIds }: { token: string; org: { id: string; name: string }; workspaceIds: string[] }) {
  const [environments, setEnvironments] = useState<DeployEnvironment[] | null>(null);
  const [mayManage, setMayManage] = useState(false);
  const [openClusters, setOpenClusters] = useState<string[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  // A requester may be in their project's user list alone.
  const people = usePeople(token, [org.id, ...workspaceIds, ...deployments.map((d) => d.project_id)]);
  const [projects, setProjects] = useState<Tenant[]>([]);
  const [editing, setEditing] = useState<DeployEnvironment | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  // "Connect a registry" elsewhere (a project's Releases) lands here with
  // `?add=registry`: the form is open, and the address forgets it.
  const [adding, setAdding] = useState<"cluster" | "registry" | null>(() => {
    const asked = new URLSearchParams(window.location.search).get("add");
    return asked === "registry" || asked === "cluster" ? asked : null;
  });
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has("add")) return;
    url.searchParams.delete("add");
    window.history.replaceState(window.history.state, "", url.pathname + url.search);
  }, []);
  const [tab, setTab] = useState<"ladder" | "where" | "namespaces" | "retention">("ladder");
  /** The place whose side panel is open. */
  const [panel, setPanel] = useState<string | null>(null);
  /** Each place's answer to a test, asked when the page opens. */
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
        setOpenClusters(envs.open_clusters?.connection_ids ?? []);
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
  useDomainRefresh(["deployment-environment","environment-binding","environment-config-secret","deployment","connector-connection"], load);
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
  const cards = useMemo(() => clusterCards([...clusters, ...researches], environments ?? [], deployments), [clusters, researches, environments, deployments]);
  // Every place in one list: clusters, Research projects, registries.
  const places: Place[] = useMemo(() => {
    const envs = environments ?? [];
    const runs: Place[] = cards.map((c) => ({
      id: c.id,
      kind: researches.some((r) => r.id === c.id) || (c.id === "" && c.environments.every((e) => e.kind === "research")) ? "research" : "cluster",
      label: c.label,
      baseUrl: c.baseUrl,
      environments: c.environments,
      card: c,
    }));
    const pulls: Place[] = registries.map((r) => ({
      id: r.id,
      kind: "registry",
      label: r.label,
      baseUrl: r.base_url ?? "",
      environments: envs.filter((e) => e.registry_connection_id === r.id),
      card: null,
    }));
    return [...runs, ...pulls];
  }, [cards, registries, researches, environments]);
  const check = useCallback(
    (id: string) => {
      setHealth((h) => ({ ...h, [id]: { state: "checking", text: "Checking…", at: Date.now() } }));
      api
        .testConnection(token, id, org.id)
        .then((t) => {
          // A cluster that answers but lacks the bootstrap's rights still
          // answers: say what it may not do, so a build is not the first to.
          const missing = (t.checks ?? []).filter((c) => !c.ok);
          const text = missing.length
            ? `${t.account} · may not ${missing.map((c) => c.name).join(", ")}: ${missing[0].detail}`
            : t.account;
          setHealth((h) => ({ ...h, [id]: { state: "ok", text, at: Date.now() } }));
        })
        .catch((e) => setHealth((h) => ({ ...h, [id]: { state: "bad", text: errText(e), at: Date.now() } })));
    },
    [token, org.id],
  );
  // Every cluster and registry is asked once when the page opens, so the
  // cards say at a glance which answer. A Research sign-in is a member's own
  // and is tested from Connections.
  const testedIds = [...clusters, ...registries].map((c) => c.id).join(",");
  useEffect(() => {
    for (const c of [...clusters, ...registries]) check(c.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testedIds, check]);
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

  // "Open to projects", saved as soon as it is switched (ADR-0054 §2).
  const setOpen = async (id: string, on: boolean) => {
    const next = on ? [...new Set([...openClusters, id])] : openClusters.filter((c) => c !== id);
    const before = openClusters;
    setOpenClusters(next);
    setBusy(`open:${id}`);
    try {
      setOpenClusters((await api.saveOpenClusters(token, org.id, next)).connection_ids);
    } catch (e) {
      setOpenClusters(before);
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const waiting = awaitingDecision(deployments);
  const ladder = useMemo(() => ladderOrder(environments ?? []), [environments]);
  const runsWhere = useMemo(() => whatRunsWhere(deployments), [deployments]);
  const placeOf = (e: DeployEnvironment) => places.find((p) => p.id === e.connection_id && p.kind !== "registry") ?? places.find((p) => p.id === "" && p.environments.includes(e));
  const envName = (id: string) => environments?.find((e) => e.id === id)?.name ?? id;
  const running = cards.reduce((n, c) => n + c.running.length, 0);
  const unanswered = places.filter((p) => p.id === "" || health[p.id]?.state === "bad").length;
  const environmentActions = (e: DeployEnvironment) =>
    mayManage
      ? [
          { label: busy === e.id ? "Asking…" : "Test", disabled: busy === e.id, onSelect: () => ask(e.id, async () => (await api.testEnvironment(token, org.id, e.id)).message) },
          {
            label: "Change",
            onSelect: () => {
              setPanel(placeOf(e)?.id ?? e.connection_id);
              setEditing(e);
            },
          },
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
      : [];
  const projectsWord = (e: DeployEnvironment) =>
    e.project_id ? `${projectName(e.project_id)} only` : e.projects ? `${e.projects.length} project${e.projects.length === 1 ? "" : "s"}` : "every project";
  const opened = places.find((p) => p.id === panel) ?? null;

  return (
    <div className="envs infra" data-org-environments data-org-infrastructure>
      <style>{ENV_CSS}</style>
      <PageHeader
        title="Infrastructure"
        status={
          environments === null ? (
            <StatusChip tone="running">reading…</StatusChip>
          ) : (
            <>
              <span data-infra-count>
                {places.length} place{places.length === 1 ? "" : "s"} · {ladder.length} environment{ladder.length === 1 ? "" : "s"} · {running} running
              </span>
              {waiting.length > 0 && (
                <StatusChip tone="warn" onClick={() => setTab("where")} data-deploys-awaiting-count>
                  {waiting.length} waiting for a decision
                </StatusChip>
              )}
              {unanswered > 0 && <StatusChip tone="danger">{unanswered} not answering</StatusChip>}
            </>
          )
        }
        info={
          <>
            <p>
              Where {org.name}&apos;s products run: the places it holds (a cluster, a Constructor Research project, the
              registry images come from), the environments it defines on them, dev to prod, and what runs where.
            </p>
            <p>
              A deploy runs on the server with the environment&apos;s connection: nobody&apos;s laptop holds the
              cluster&apos;s credentials. An environment is added from the place it runs on; a release climbs the ladder,
              each environment taking from the one before it.
            </p>
          </>
        }
        actions={
          mayManage ? (
            <AddPlaceMenu
              onPick={(kind) => {
                if (kind === "research") openConnections();
                else setAdding(kind);
              }}
            />
          ) : undefined
        }
      />
      {error && <div className="error">{error}</div>}
      {notice && <div className="hint">{notice}</div>}
      {adding === "cluster" && (
        <section className="card">
          <AddCluster
            token={token}
            org={org.id}
            onCancel={() => setAdding(null)}
            onAdded={(c) => {
              setAdding(null);
              setNotice(`Connected ${c.label}.`);
              setPanel(c.id);
              load();
            }}
          />
        </section>
      )}
      {adding === "registry" && (
        <section className="card">
          <AddRegistry
            token={token}
            org={org.id}
            onCancel={() => setAdding(null)}
            onAdded={(c) => {
              setAdding(null);
              setNotice(`Connected ${c.label}.`);
              setConnections((cs) => [...cs, c]);
            }}
          />
        </section>
      )}

      <div className="infra-tabs" role="tablist" aria-label="Environments">
        <button type="button" role="tab" aria-selected={tab === "ladder"} className={tab === "ladder" ? "on" : ""} onClick={() => setTab("ladder")} data-infra-tab="ladder">
          Environments
        </button>
        <button type="button" role="tab" aria-selected={tab === "where"} className={tab === "where" ? "on" : ""} onClick={() => setTab("where")} data-infra-tab="where">
          What runs where
          {waiting.length > 0 && <span className="badge warn">{waiting.length}</span>}
        </button>
        {mayManage && (
          <>
            <button type="button" role="tab" aria-selected={tab === "namespaces"} className={tab === "namespaces" ? "on" : ""} onClick={() => setTab("namespaces")} data-infra-tab="namespaces">
              Namespaces
            </button>
            <button type="button" role="tab" aria-selected={tab === "retention"} className={tab === "retention" ? "on" : ""} onClick={() => setTab("retention")} data-infra-tab="retention">
              Image retention
            </button>
          </>
        )}
      </div>

      {tab === "namespaces" && mayManage ? (
        <NamespaceAssignments token={token} org={org.id} environments={environments ?? []} projects={projects} />
      ) : tab === "retention" && mayManage ? (
        <OrgRetention token={token} org={org.id} />
      ) : tab !== "where" ? (
        <section className="card" data-environment-ladder data-infra-environments>
          {environments === null ? (
            <p className="hint">Loading…</p>
          ) : ladder.length === 0 ? (
            <EmptyState
              title="No environment yet · add dev, stage or prod from a place"
              action={
                mayManage && places.some((p) => p.kind !== "registry" && p.id) ? (
                  <button type="button" onClick={() => setPanel(places.find((p) => p.kind !== "registry" && p.id)!.id)}>
                    Open a place
                  </button>
                ) : undefined
              }
            />
          ) : (
            <ol className="infra-ladder" aria-label="The environments a release climbs">
              {ladder.map((e, i) => {
                const place = placeOf(e);
                const pending = waiting.filter((d) => d.environment_id === e.id).length;
                const before = i > 0 ? ladder[i - 1] : null;
                return (
                  <li key={e.id} className="infra-rung" data-ladder-environment={e.name}>
                    <div className="infra-rung-head">
                      <b>{e.name}</b>
                      {e.protected && (
                        <span className="infra-lock" title="Protected: a deploy waits for an administrator's approval" aria-label="needs approval">
                          <LockIcon size={13} />
                        </span>
                      )}
                      {e.strictness && e.strictness !== (e.protected ? "prod" : "dev") && (
                        <StatusChip
                          tone={e.strictness === "dev" ? "warn" : "info"}
                          title={e.strictness === "dev" ? "Products are checked as development ones here: the production rules only warn" : "Products are checked as production ones here"}
                          data-rung-strictness={e.strictness}
                        >
                          {e.strictness} checks
                        </StatusChip>
                      )}
                      {pending > 0 && (
                        <StatusChip tone="warn" onClick={() => setTab("where")} data-rung-pending>
                          {pending} to decide
                        </StatusChip>
                      )}
                      <span className="grow" />
                      <RowMenu label={e.name} actions={environmentActions(e)} onRun={(a) => void a.onSelect()} />
                    </div>
                    {place ? (
                      <button type="button" className="infra-place-chip" onClick={() => setPanel(place.id)} data-rung-place={place.kind}>
                        <PlaceIcon kind={place.kind} size={13} />
                        {place.label}
                      </button>
                    ) : (
                      <span className="sub">a place this page cannot see</span>
                    )}
                    <div className="sub">
                      {projectsWord(e)} · {databaseWord(e)}
                      {e.promote_from && e.promote_from !== before?.id && <> · takes from {envName(e.promote_from)}</>}
                      {!e.promote_from && i > 0 && <> · takes any build</>}
                    </div>
                    <Answer id={e.id} />
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      ) : (
        <div data-what-runs-where>
          {waiting.length > 0 && (
            <section className="card" data-deploys-awaiting>
              <h3>Waiting for a decision</h3>
              <ul className="env-list">
                {waiting.map((d) => (
                  <li key={d.id}>
                    <DeploymentLine d={d} showProject people={people} />
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
          <div className="card" data-runs-where>
            <DataTable<ProjectRuns>
              list="what-runs-where"
              rows={environments === null ? null : runsWhere}
              rowKey={(r) => r.projectId}
              rowLabel={(r) => r.projectName}
              defaultView="table"
              empty={{ title: "Nothing runs anywhere yet · deploy from a project's Releases" }}
              columns={[
                {
                  id: "project",
                  header: "Project",
                  compare: (a, b) => a.projectName.localeCompare(b.projectName),
                  cell: (r) => <b>{r.projectName}</b>,
                },
                ...ladder.map((e) => ({
                  id: `env-${e.id}`,
                  header: e.name,
                  cell: (r: ProjectRuns) => {
                    const cell = r.cells.get(e.id);
                    if (!cell) return <span className="sub">—</span>;
                    const runs = cell.runs ? versionOf(cell.runs) : null;
                    const asked = versionOf(cell.latest);
                    // What runs, as a chip; the newest deploy beside it when it
                    // is not what runs: waiting, deploying, failed, taken out.
                    return (
                      <div className="infra-cell" data-runs-cell={`${r.projectName}/${e.name}`} title={`newest deploy ${relTime(cell.latest.requested_at)}`}>
                        {runs ? <StatusChip tone="ok">{runs}</StatusChip> : <span className="sub">nothing runs</span>}
                        {cell.latest.id !== cell.runs?.id && (
                          <StatusChip tone={CHIP_TONE[stateTone(cell.latest.state)]} data-deployment-state={cell.latest.state}>
                            {asked ? `${asked} · ` : ""}
                            {STATE_LABELS[cell.latest.state] ?? cell.latest.state}
                          </StatusChip>
                        )}
                      </div>
                    );
                  },
                })),
              ]}
            />
          </div>
        </div>
      )}

      <h2 className="env-part" data-infra-places>
        Places
      </h2>
      {environments !== null && places.length === 0 ? (
        <section className="card">
          <EmptyState
            title="No place yet · connect a cluster, a Research project or a registry"
            action={mayManage ? <AddPlaceMenu onPick={(kind) => (kind === "research" ? openConnections() : setAdding(kind))} /> : undefined}
          />
        </section>
      ) : (
        <div className="infra-places" data-clusters data-registries>
          {places.map((p) => {
            const h = p.id ? health[p.id] : { state: "bad" as const, text: "its connection is out of reach", at: 0 };
            const isOpen = openClusters.includes(p.id);
            return (
              <article
                key={`${p.kind}:${p.id}`}
                className={`card infra-place${panel === p.id ? " on" : ""}${p.id ? "" : " unseen"}`}
                data-place={p.label}
                data-place-kind={p.kind}
              >
                <button type="button" className="infra-place-open" onClick={() => setPanel(p.id)} aria-label={`Open ${p.label}`}>
                  <span className="infra-place-top">
                    <PlaceIcon kind={p.kind} />
                    <b>{p.label}</b>
                    {h && <span className={`env-dot env-dot-${h.state}`} aria-hidden />}
                  </span>
                  <span className="sub">
                    {PLACE_WORD[p.kind]}
                    {p.baseUrl ? ` · ${p.kind === "registry" ? registryHost(p.baseUrl) || p.baseUrl : p.baseUrl.replace(/^https?:\/\//, "")}` : ""}
                  </span>
                  <span className={`env-cluster-health ${h?.state ?? ""}`}>
                    {h ? h.text : p.kind === "research" ? "each member signs in with their own account" : ""}
                  </span>
                </button>
                <div className="env-cluster-envs">
                  {p.environments.length === 0 ? (
                    <span className="sub">{p.kind === "registry" ? "no environment pulls from it" : "no environment on it"}</span>
                  ) : (
                    p.environments.map((e) => (
                      <span key={e.id} className={`env-chip${e.protected ? " protected" : ""}`}>
                        {e.protected ? "🔒 " : ""}
                        {e.name}
                      </span>
                    ))
                  )}
                </div>
                {p.kind === "cluster" && p.id && p.environments.length > 0 && (
                  <PlaceReadiness token={token} org={org.id} environments={p.environments} />
                )}
                {p.kind === "cluster" && p.id && (
                  <label className="infra-toggle" title="A project may add environments of its own on it, without an administrator (ADR-0054 §2)">
                    <input
                      type="checkbox"
                      role="switch"
                      checked={isOpen}
                      disabled={!mayManage || busy === `open:${p.id}`}
                      onChange={(ev) => void setOpen(p.id, ev.target.checked)}
                      data-open-cluster={p.label}
                    />
                    <span className="infra-switch" aria-hidden />
                    Open to projects
                  </label>
                )}
              </article>
            );
          })}
        </div>
      )}

      {/* Over the whole page, top bar included: drawn at the document's end. */}
      {opened &&
        createPortal(
        <Modal
          label={opened.label}
          onClose={() => {
            setPanel(null);
            setEditing(null);
          }}
          backdropClassName="infra-sheet-back"
          cardClassName="infra-sheet"
        >
          <section className="envs" data-cluster-detail={opened.label} data-place-panel={opened.kind}>
            <div className="infra-sheet-head">
              <PlaceIcon kind={opened.kind} size={20} />
              <h3>{opened.label}</h3>
              <button
                type="button"
                className="ghost"
                aria-label="Close"
                onClick={() => {
                  setPanel(null);
                  setEditing(null);
                }}
              >
                ✕
              </button>
            </div>
            <dl className="env-facts">
              <dt>Kind</dt>
              <dd>{PLACE_WORD[opened.kind]}</dd>
              {opened.baseUrl && (
                <>
                  <dt>Address</dt>
                  <dd>
                    <code>{opened.baseUrl}</code>
                  </dd>
                </>
              )}
              <dt>Check</dt>
              <dd>
                {opened.id && health[opened.id] ? (
                  <span className={`env-cluster-health ${health[opened.id].state}`}>{health[opened.id].text}</span>
                ) : opened.kind === "research" ? (
                  <span className="sub">Each member builds and deploys with their own sign-in (ADR-0049 §5).</span>
                ) : (
                  <span className="sub">{opened.id ? "not asked yet" : "its connection is out of reach"}</span>
                )}{" "}
                {opened.id && opened.kind !== "research" && (
                  <button type="button" className="linklike" disabled={health[opened.id]?.state === "checking"} onClick={() => check(opened.id)}>
                    {health[opened.id]?.state === "checking" ? "Asking…" : "Test again"}
                  </button>
                )}
              </dd>
              {opened.kind === "cluster" && opened.id && (
                <>
                  <dt>Projects</dt>
                  <dd>{openClusters.includes(opened.id) ? "may add environments of their own here" : "use only the organization's environments here"}</dd>
                </>
              )}
            </dl>

            <div className="infra-sheet-sub">
              <h4 className="env-sub">{opened.kind === "registry" ? "Environments that pull from it" : "Environments on it"}</h4>
              {mayManage && editing === null && opened.id && opened.kind !== "registry" && (
                <button type="button" className="primary" onClick={() => setEditing("new")} data-environment-add>
                  Add an environment here
                </button>
              )}
            </div>
            {editing !== null && opened.kind !== "registry" && (
              <EnvironmentForm
                token={token}
                org={org.id}
                editing={editing === "new" ? null : editing}
                others={environments ?? []}
                clusters={clusters}
                registries={registries}
                researches={researches}
                projects={projects}
                initialCluster={editing === "new" ? opened.id : editing.connection_id}
                onCancel={() => setEditing(null)}
                onDone={() => {
                  setEditing(null);
                  load();
                }}
                onClusterAdded={(c) => setConnections((cs) => [...cs, c])}
              />
            )}
            {opened.environments.length === 0 ? (
              editing === null && <p className="sub">None yet.</p>
            ) : (
              <ul className="env-list">
                {opened.environments.map((e) => (
                  <li key={e.id} data-environment={e.name}>
                    <div className="env-head">
                      <b>{e.name}</b>
                      {e.protected && <StatusChip tone="info">needs approval</StatusChip>}
                      <span className="sub">
                        {projectsWord(e)} · {databaseWord(e)}
                        {e.kind === "research" ? (
                          <> · Research project <code>{e.research_project}</code></>
                        ) : (
                          <>
                            {" "}
                            · <code>{namespaceFor(e.namespace_pattern, projects[0]?.name ?? "Studio Web", e.name)}</code>
                          </>
                        )}
                      </span>
                      <span className="grow" />
                      <RowMenu label={e.name} actions={environmentActions(e)} onRun={(a) => void a.onSelect()} />
                    </div>
                    {e.description && <div className="sub">{e.description}</div>}
                    <Answer id={e.id} />
                    <ModelFields
                      token={token}
                      entity="deployment-environment"
                      where={{ doc_tenant_id: { _eq: org.id }, doc_key: { _eq: e.id } }}
                    />
                  </li>
                ))}
              </ul>
            )}

            {opened.kind === "registry" && opened.id && mayManage && (
              <>
                <h4 className="env-sub" data-registry-contents>
                  What is in it
                </h4>
                <RegistryBrowser token={token} org={org.id} connectionId={opened.id} />
              </>
            )}

            {opened.card && (
              <>
                <h4 className="env-sub" data-running-now>
                  Runs here
                </h4>
                {opened.card.running.length === 0 && opened.card.deployments.length === 0 ? (
                  <EmptyState title="Nothing runs here · deploy from a project's Releases" />
                ) : (
                  <ul className="env-list">
                    {(opened.card.running.length ? opened.card.running : opened.card.deployments.slice(0, 10)).map((d) => (
                      <li key={d.id}>
                        <DeploymentLine d={d} showProject people={people} />
                        {opened.card!.running.includes(d) && (
                          <StatusButton token={token} org={org.id} d={d} place={opened.kind === "research" ? "Research" : "the cluster"} />
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </section>
        </Modal>,
          document.body,
        )}
    </div>
  );
}

/** Whether a cluster is ready for Studio, per environment on it: asked when
 *  a person asks, not when the page opens -- each answer is a walk of the
 *  cluster's rights -- and never again by itself. */
function PlaceReadiness({ token, org, environments }: { token: string; org: string; environments: DeployEnvironment[] }) {
  const [answers, setAnswers] = useState<Record<string, EnvironmentReadiness | { error: string }> | null>(null);
  const [asking, setAsking] = useState(false);
  const ask = async () => {
    setAsking(true);
    const pairs = await Promise.all(
      environments.map(async (e) => {
        try {
          const owner = e.project_id ? { project: e.project_id } : { org };
          return [e.id, await api.environmentReadiness(token, e.id, owner)] as const;
        } catch (err) {
          return [e.id, { error: errText(err) }] as const;
        }
      }),
    );
    setAnswers(Object.fromEntries(pairs));
    setAsking(false);
  };
  return (
    <div className="env-cluster-envs" data-place-readiness>
      {answers &&
        environments.map((e) => {
          const a = answers[e.id];
          if (!a) return null;
          if ("error" in a)
            return (
              <StatusChip key={e.id} tone="neutral" title={a.error} data-readiness="unknown">
                {environments.length > 1 ? `${e.name}: ` : ""}not known
              </StatusChip>
            );
          const badge = readinessBadge(a);
          return (
            <StatusChip key={e.id} tone={badge.tone} title={badge.title} data-readiness={a.level}>
              {environments.length > 1 ? `${e.name}: ` : ""}
              {badge.label}
            </StatusChip>
          );
        })}
      <button type="button" className="linklike" disabled={asking} onClick={() => void ask()} data-readiness-check>
        {asking ? "Asking the cluster…" : answers ? "Check again" : "Check readiness"}
      </button>
    </div>
  );
}

/** A deploy state's tone (environments.ts) as a StatusChip's. */
const CHIP_TONE: Record<ReturnType<typeof stateTone>, Tone> = { ok: "ok", warn: "warn", bad: "danger", idle: "neutral" };

/** A project's environments: its profiles' bindings and its deployments.
 *  Releases draws the two apart (ADR-0056 §4) -- the history under the
 *  builds, the bindings in its folded Environments of this project. */
export function ProjectEnvironments({
  token,
  projectId,
  profiles,
  title = "Environments",
  show = "both",
  onSaved,
}: {
  token: string;
  projectId: string;
  /** The profiles to offer; by default the ones the saved description
   *  declares (its latest revision), each with its kind. */
  profiles?: readonly DeclaredProfile[];
  /** The heading: where the bindings sit decides what they are called. */
  title?: string;
  /** Which of the two to draw. */
  show?: "both" | "bindings" | "history";
  /** The bindings were saved: whatever else shows them reads them again. */
  onSaved?: () => void;
}) {
  const [targets, setTargets] = useState<ProjectTargets | null>(null);
  const [bindings, setBindings] = useState<EnvironmentBinding[]>([]);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const people = usePeople(token, [targets?.organization_id, projectId]);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const read = useDeclaredProfiles(token, projectId);
  const declared = profiles ?? read;
  // An environment runs a profile it can deploy: a cluster, a `kubernetes`
  // one (ADR-0057).
  const offered = deployableProfiles(declared).map((p) => p.id);

  useEffect(() => {
    let live = true;
    Promise.all([api.projectTargets(token, projectId), api.deployments(token, { project: projectId }).catch(() => ({ items: [] as Deployment[], total: 0 }))])
      .then(([t, d]) => {
        if (!live) return;
        setTargets(t);
        setBindings(oneEach(t.bindings));
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
  // Each environment runs one profile; one profile may run in several
  // (ADR-0057).
  const bound = (environment: string) => bindings.find((b) => b.environment_id === environment)?.profile ?? "";
  const bind = (environment: string, profile: string) => {
    setSaved(false);
    // Values belong to the release in that environment: kept while it stays
    // bound, whichever profile it runs.
    setBindings((all) => {
      const was = all.find((b) => b.environment_id === environment);
      const next = was ? { ...was, profile } : { profile, environment_id: environment };
      return [...all.filter((b) => b.environment_id !== environment), ...(profile ? [next] : [])];
    });
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      setBindings((await api.saveBindings(token, projectId, bindings)).items);
      setSaved(true);
      onSaved?.();
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
      {show === "history" ? null : targets === null ? (
        <p className="hint">Loading…</p>
      ) : targets.environments.length === 0 ? (
        <p className="empty">The organization has no environment this project may deploy to yet.</p>
      ) : (
        <>
          <p className="hint">
            Pick the kubernetes profile of the product each environment runs; one profile may run in several. Deploy takes the
            namespace and the image registry from the environment.
          </p>
          <ul className="env-list">
            {targets.environments.map((t) => {
              const env = t.environment;
              return (
                <li key={env.id} className="env-binding" data-binding-environment={env.name}>
                  <b>{env.name}</b>
                  {env.protected ? " (protected)" : ""} runs{" "}
                  <select value={bound(env.id)} onChange={(e) => bind(env.id, e.target.value)} aria-label={`Profile for ${env.name}`}>
                    <option value="">nothing: not bound</option>
                    {/* A profile bound before that this list does not offer stays shown. */}
                    {[...offered, ...(bound(env.id) && !offered.includes(bound(env.id)) ? [bound(env.id)] : [])].map((p) => (
                      <option key={p} value={p}>
                        {profileLabel(p, declared)}
                      </option>
                    ))}
                  </select>
                  <span className="sub">
                    {" "}
                    namespace <code>{t.namespace}</code>
                    {env.registry && (
                      <>
                        , images from <code>{env.registry}</code>
                      </>
                    )}
                  </span>
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
      {show === "history" && targets && <DeployHistory token={token} org={targets.organization_id} deployments={deployments} />}
      {show === "both" && deployments.length > 0 && targets && (
        <ul className="env-list">
          {deployments.slice(0, 10).map((d) => (
            <li key={d.id}>
              <DeploymentLine d={d} showProject={false} people={people} />
              {canReadStatus(d) && <StatusButton token={token} org={targets.organization_id} d={d} />}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A project's deploys, newest first, one row each: what, where, who and
 *  when. A row opens on what the deploy said -- its reason, its outcome with
 *  a crashed container's error -- and asks the cluster how it is now. */
function DeployHistory({ token, org, deployments }: { token: string; org: string; deployments: Deployment[] }) {
  const people = usePeople(token, [org, ...new Set(deployments.map((d) => d.project_id))]);
  return (
    <DataTable<Deployment>
      list="deploy-history"
      urlPrefix="history."
      rows={deployments}
      rowKey={(d) => d.id}
      rowLabel={(d) => `${d.product} to ${d.environment_name}`}
      expand={(d) => (
        <div data-deploy-history-detail={d.id}>
          <DeploymentLine d={d} showProject={false} people={people} />
          {canReadStatus(d) && <StatusButton token={token} org={org} d={d} />}
        </div>
      )}
      expandOnClick
      search={{ placeholder: "Search deploys…" }}
      searchText={(d) => [d.product, d.environment_name, d.namespace, d.commit, d.requested_by_name, d.requested_by, d.state]}
      empty={{ title: "Nothing deployed yet." }}
      columns={[
        { id: "state", header: "State", cell: (d) => <StateBadge d={d} /> },
        {
          id: "what",
          header: "What",
          cell: (d) => (
            <>
              <b>{d.product}</b>
              {versionOf(d) ? <span className="sub"> · {versionOf(d)}</span> : null}{" "}
              {d.preview && <span className="badge">preview {d.preview.name}</span>}
              {(d.action ?? "install") === "uninstall" && <span className="badge">taken out</span>}
            </>
          ),
        },
        {
          id: "where",
          header: "Where",
          cell: (d) => (
            <>
              {d.environment_name} <span className="sub">· <code>{d.namespace}</code></span>
            </>
          ),
        },
        { id: "commit", header: "Commit", cell: (d) => (d.commit ? <code>{shortCommit(d.commit)}</code> : "—") },
        { id: "by", header: "By", cell: (d) => personLabel(d.requested_by, d.requested_by_name, people) },
        {
          id: "when",
          header: "When",
          compare: (a, b) => a.requested_at.localeCompare(b.requested_at),
          cell: (d) => <When iso={d.requested_at} />,
        },
      ]}
    />
  );
}

function sortBindings(b: EnvironmentBinding[]): EnvironmentBinding[] {
  return [...b].sort((x, y) => x.environment_id.localeCompare(y.environment_id));
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
.envs .env-part { margin:24px 0 4px; }
`;
