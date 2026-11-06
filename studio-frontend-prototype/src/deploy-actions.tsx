/* What a project does in one environment from the portal (ADR-0048): deploy a
 * build a pipeline or the IDE published, roll back to the one before, take the
 * release out; the release's configuration there (chart values, secrets); and
 * the workflow that builds the product for it. The rules are in
 * `project-deploys.ts`; the server checks every one of them again. */

import { useEffect, useState } from "react";

import {
  api,
  type BuildPlan,
  type ConfigSecret,
  type Connection,
  type Deployment,
  type DeployEnvironment,
  type EnvironmentBinding,
  type ProjectBuildSetting,
} from "./api";
import { planKey, planLines, planRefusalText } from "./build-plan";
import { InfraPlanView } from "./infra-services-view";
import { type IdeBuild, buildRefusalText } from "./builds";
import { STATE_LABELS, codedWarnings, shortCommit, stateTone } from "./environments";
import { personLabel, usePeople } from "./user-names";
import { ownBuildSummary } from "./project-build";
import { readDeclaredProfiles, useDeclaredProfiles } from "./declared-profiles";
import { deployableProfiles } from "./product";
import { errText, relTime } from "./format";
import {
  deployableBuilds,
  expiresIn,
  isSecretKey,
  lifetimeLabel,
  livePreviews,
  parseValues,
  previewLifetimes,
  previewNameFor,
  promotionGap,
  rollbackTarget,
  runsNow,
  valuesText,
} from "./project-deploys";
import type { LadderStep } from "./releases";
import { EmptyState, InfoPopover, StatusChip } from "./ui-standard";
import "./infrastructure.css";

/** Ask the server for a deploy, and say what it answered: queued, or
 *  waiting for an administrator. One for every place a deploy is asked. */
export function useDeployRequest(token: string, projectId: string, onChanged: (message: string) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = async (body: Parameters<typeof api.createDeployment>[2], what: string): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      const d = await api.createDeployment(token, projectId, body);
      onChanged(d.state === "awaiting_approval" ? `${what}: waiting for an administrator's approval.` : `${what}: queued.`);
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, ask };
}

/** Deploy one published build to an environment the project may deploy to:
 *  Releases' action on a build, beside each step of its ladder. */
export function DeployBuildTo({
  token,
  projectId,
  build,
  environments,
  deployments,
  onChanged,
}: {
  token: string;
  projectId: string;
  build: IdeBuild;
  environments: DeployEnvironment[];
  deployments: Deployment[];
  onChanged: (message: string) => void;
}) {
  // Only where this build can go: a Research environment runs only what
  // Research built, the others only a published chart -- the same rule the
  // ladder picks builds by, so the two never offer different things.
  const takers = environments.filter((e) => deployableBuilds([build], e).length > 0);
  const [envId, setEnvId] = useState(takers[0]?.id ?? "");
  const { busy, error, ask } = useDeployRequest(token, projectId, onChanged);
  const envName = (id: string) => environments.find((e) => e.id === id)?.name ?? id;
  const env = takers.find((e) => e.id === envId);
  const gap = env ? promotionGap(env, build, deployments, envName) : null;
  if (takers.length === 0) return null;
  return (
    <div className="row" style={{ gap: 6, marginTop: 6 }} data-deploy-build-to>
      <select value={envId} onChange={(e) => setEnvId(e.target.value)} aria-label="Environment">
        {takers.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="primary"
        disabled={busy || !env || !!gap}
        title={gap ?? undefined}
        onClick={() =>
          env && void ask({ environment_id: env.id, build: build.buildId }, `Deploy ${build.chartVersion} to ${env.name} -- it shows on the ladder above`)
        }
      >
        Deploy
      </button>
      {gap && <span className="sub warn">{gap}</span>}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

/** Deploy a build, roll back, uninstall: one environment's actions. */
export function EnvironmentActions({
  token,
  projectId,
  env,
  latest,
  deployments,
  builds,
  envName,
  organizationId,
  onChanged,
}: {
  token: string;
  projectId: string;
  env: DeployEnvironment;
  latest: Deployment | undefined;
  /** The project's organization: an administrator decides its deploys here. */
  organizationId?: string;
  deployments: Deployment[];
  builds: IdeBuild[];
  envName: (id: string) => string;
  onChanged: (message: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  // The build a preview is being asked for, if any: its name and lifetime are
  // set in a line under it.
  const [previewing, setPreviewing] = useState<string | null>(null);
  const request = useDeployRequest(token, projectId, onChanged);
  const { busy, error } = request;
  const candidates = deployableBuilds(builds, env);
  const back = rollbackTarget(deployments, env.id);
  const previews = env.kind !== "research" && !!env.previews;
  // A deploy that waits for a decision is decided before another is asked:
  // a second request would only wait beside it.
  const waiting = deployments.filter((d) => d.environment_id === env.id && d.state === "awaiting_approval");
  const ask = async (body: Parameters<typeof api.createDeployment>[2], what: string) => {
    if (await request.ask(body, what)) {
      setPicking(false);
      setPreviewing(null);
    }
  };
  return (
    <div className="deploy-actions" data-environment-actions={env.name}>
      {waiting.length > 0 && (
        <PendingDecisions token={token} organizationId={organizationId} waiting={waiting} onChanged={onChanged} />
      )}
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={busy || waiting.length > 0}
          title={waiting.length > 0 ? "A deploy here waits for a decision: approve or decline it first" : undefined}
          onClick={() => setPicking((v) => !v)}
        >
          Deploy a build…
        </button>
        {back && (
          <button
            type="button"
            disabled={busy}
            title={`Install again what was deployed ${relTime(back.requested_at)}`}
            onClick={() =>
              void ask({ environment_id: env.id, redeploy_of: back.id }, `Rollback to ${back.chart_version ?? back.build ?? "the earlier build"}`)
            }
          >
            Roll back
          </button>
        )}
        {runsNow(latest) && latest && (
          <button
            type="button"
            className="danger"
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Take ${latest.product} out of ${env.name}? Its pods stop; its database stays.`))
                void ask({ environment_id: env.id, product: latest.product, profile: latest.profile, action: "uninstall" }, "Uninstall");
            }}
          >
            Uninstall
          </button>
        )}
      </div>
      {picking && (
        <div className="deploy-pick" data-build-picker>
          {candidates.length === 0 ? (
            isResearch(env) ? (
              <div className="row" data-research-no-build>
                <StatusChip tone="warn">no build for Research yet</StatusChip>
                <BuildForResearch token={token} projectId={projectId} env={env} onChanged={onChanged} />
              </div>
            ) : (
              <p className="hint">No build has published a chart yet: build under Builds below, or publish from the IDE&apos;s Deploy.</p>
            )
          ) : (
            <ul className="rows">
              {candidates.slice(0, 8).map((b) => {
                const gap = promotionGap(env, b, deployments, envName);
                return (
                  // Wraps, so the preview's line can sit under the build.
                  <li key={b.id} style={{ flexWrap: "wrap" }}>
                    <div className="grow">
                      <b>{b.chartVersion ?? b.buildId}</b> <span className="sub">{b.where}</span>{" "}
                      {b.commit && <code>{shortCommit(b.commit)}</code>}{" "}
                      <span className="sub">{relTime(b.finishedAt ?? b.startedAt ?? "")}</span>
                      {gap && <div className="sub warn">{gap}</div>}
                    </div>
                    <button
                      type="button"
                      disabled={busy || !!gap}
                      onClick={() => void ask({ environment_id: env.id, build: b.buildId }, `Deploy ${b.chartVersion ?? b.buildId}`)}
                    >
                      Deploy
                    </button>
                    {previews && (
                      <button
                        type="button"
                        disabled={busy}
                        aria-expanded={previewing === b.buildId}
                        data-preview-build={b.buildId}
                        title={`Install it in a namespace of its own beside ${env.name}, removed when it expires`}
                        onClick={() => setPreviewing((v) => (v === b.buildId ? null : b.buildId))}
                      >
                        Preview…
                      </button>
                    )}
                    {previews && previewing === b.buildId && (
                      <PreviewForm
                        build={b}
                        most={env.previews?.ttl_hours ?? 72}
                        busy={busy}
                        onCancel={() => setPreviewing(null)}
                        onStart={(name, ttl) =>
                          void ask(
                            { environment_id: env.id, build: b.buildId, preview: { name: name || undefined, ttl_hours: ttl } },
                            `Preview ${b.chartVersion ?? b.buildId} in ${env.name}`,
                          )
                        }
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {env.kind !== "research" && <InfraPlanView token={token} projectId={projectId} environmentId={env.id} />}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** The deploys to one environment that wait for an administrator, decided
 *  where they were asked. Whoever may not decide sees who does. */
function PendingDecisions({
  token,
  organizationId,
  waiting,
  onChanged,
}: {
  token: string;
  organizationId?: string;
  waiting: Deployment[];
  onChanged: (message: string) => void;
}) {
  const [mayDecide, setMayDecide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const people = usePeople(token, [organizationId, ...new Set(waiting.map((d) => d.project_id))]);
  useEffect(() => {
    if (!organizationId) return;
    let live = true;
    api
      .environments(token, organizationId)
      .then((r) => live && setMayDecide(r.may_manage))
      .catch(() => live && setMayDecide(false));
    return () => {
      live = false;
    };
  }, [token, organizationId]);
  const decide = async (d: Deployment, action: "approve" | "decline") => {
    if (!organizationId) return;
    setBusy(true);
    setError(null);
    try {
      await api.decideDeployment(token, organizationId, d.id, action, action === "decline" ? reason.trim() : undefined);
      setDeclining(null);
      setReason("");
      onChanged(
        action === "approve"
          ? `Approved: ${d.chart_version ?? d.build ?? d.product} goes to ${d.environment_name}.`
          : `Declined the deploy of ${d.chart_version ?? d.build ?? d.product} to ${d.environment_name}.`,
      );
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="deploy-pick" data-deploys-waiting>
      <ul className="rows">
        {waiting.map((d) => (
          <li key={d.id} style={{ flexWrap: "wrap" }}>
            <div className="grow">
              <StatusChip tone="warn">waits for a decision</StatusChip> <b>{d.chart_version ?? d.build ?? d.product}</b>{" "}
              {d.commit && <code>{shortCommit(d.commit)}</code>}{" "}
              <span className="sub">
                asked by {personLabel(d.requested_by, d.requested_by_name, people)} {relTime(d.requested_at)}
              </span>
            </div>
            {mayDecide ? (
              <>
                <button type="button" className="primary" disabled={busy} data-deploy-approve onClick={() => void decide(d, "approve")}>
                  Approve
                </button>
                <button type="button" disabled={busy} onClick={() => setDeclining(declining === d.id ? null : d.id)}>
                  Decline…
                </button>
                {declining === d.id && (
                  <>
                    <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="required: why not" aria-label="Reason" />
                    <button type="button" disabled={busy || !reason.trim()} onClick={() => void decide(d, "decline")}>
                      Decline
                    </button>
                  </>
                )}
              </>
            ) : (
              <span className="hint">An organization administrator decides.</span>
            )}
          </li>
        ))}
      </ul>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** A preview's name and how long it lives, asked in a line under its build.
 *  The server checks both again: the name's characters, the environment's
 *  most hours. */
function PreviewForm({
  build,
  most,
  busy,
  onStart,
  onCancel,
}: {
  build: IdeBuild;
  most: number;
  busy: boolean;
  onStart: (name: string, ttlHours: number) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(() => previewNameFor(build));
  const lifetimes = previewLifetimes(most);
  const [ttl, setTtl] = useState(() => (lifetimes.includes(24) ? 24 : lifetimes[lifetimes.length - 1]));
  const valid = /^[a-z0-9-]{0,20}$/.test(name.trim());
  return (
    <form
      className="row"
      style={{ gap: 6, flexBasis: "100%" }}
      data-preview-form={build.buildId}
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onStart(name.trim(), ttl);
      }}
    >
      <input
        aria-label="Preview name"
        value={name}
        maxLength={20}
        placeholder="name"
        onChange={(e) => setName(e.target.value.toLowerCase())}
        title="Lowercase letters, digits and -, at most 20"
      />
      <select aria-label="Lives for" value={ttl} onChange={(e) => setTtl(Number(e.target.value))}>
        {lifetimes.map((h) => (
          <option key={h} value={h}>
            for {lifetimeLabel(h)}
          </option>
        ))}
      </select>
      <button type="submit" className="primary" disabled={busy || !valid}>
        Start preview
      </button>
      <button type="button" className="ghost" onClick={onCancel}>
        Cancel
      </button>
      {!valid && <span className="sub warn">Lowercase letters, digits and -, at most 20.</span>}
    </form>
  );
}

/** The project's previews in one environment (ADR-0055): each in a namespace
 *  of its own, with its address, until it expires or is removed here. */
export function EnvironmentPreviews({
  token,
  projectId,
  env,
  deployments,
  onChanged,
}: {
  token: string;
  projectId: string;
  env: DeployEnvironment;
  deployments: Deployment[];
  onChanged: (message: string) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (env.kind === "research" || !env.previews) return null;
  const live = livePreviews(deployments, env.id);
  const remove = async (d: Deployment) => {
    if (!window.confirm(`Remove preview ${d.preview?.name}? Its namespace ${d.namespace} goes, with everything in it.`)) return;
    setBusy(d.id);
    setError(null);
    try {
      await api.removePreview(token, projectId, d.id);
      onChanged(`Preview ${d.preview?.name} is being removed.`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="deploy-previews" data-environment-previews={env.name}>
      <div className="sub">
        Previews · {live.length} of {env.previews.max_live ?? 3}
        {env.previews.domain ? (
          <>
            {" "}
            · each at its own address under <code>{env.previews.domain}</code>
          </>
        ) : (
          " · no preview domain: reach them by port-forward"
        )}
      </div>
      {live.length === 0 ? (
        <p className="hint">No preview here. Deploy a build… › Preview… installs one beside {env.name}, in a namespace of its own.</p>
      ) : (
        <ul className="rows">
          {live.map((d) => {
            const p = d.preview!;
            return (
              <li key={d.id} data-preview={p.name}>
                <div className="grow">
                  <b>{p.name}</b>{" "}
                  <span className={`badge deploy-${stateTone(d.state)}`}>{STATE_LABELS[d.state] ?? d.state}</span>{" "}
                  {d.chart_version && <code>{d.chart_version}</code>}{" "}
                  <span className="sub">
                    <code>{d.namespace}</code> · {expiresIn(p.expires_at)}
                  </span>
                  {p.host && d.state === "succeeded" && (
                    <div>
                      <a href={`https://${p.host}`} target="_blank" rel="noreferrer" data-preview-url>
                        {p.host} ↗
                      </a>
                    </div>
                  )}
                  {d.state === "failed" && d.outcome && <div className="sub warn">{d.outcome}</div>}
                  {p.removal_error && <div className="sub warn">Not removed yet: {p.removal_error}</div>}
                </div>
                <button type="button" disabled={busy !== null} onClick={() => void remove(d)}>
                  {busy === d.id ? "Removing…" : "Remove"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** The release's configuration in one environment: each bound profile's
 *  chart values, and the secrets every application reads. */
export function EnvironmentConfig({
  token,
  projectId,
  env,
  bindings,
  secrets,
  onChanged,
}: {
  token: string;
  projectId: string;
  env: DeployEnvironment;
  bindings: EnvironmentBinding[];
  secrets: ConfigSecret[];
  onChanged: (message: string) => void;
}) {
  const mine = bindings.filter((b) => b.environment_id === env.id);
  const keys = secrets.filter((s) => s.environment_id === env.id).map((s) => s.key);
  const [texts, setTexts] = useState<Record<string, string>>(() =>
    Object.fromEntries(mine.map((b) => [b.profile, valuesText(b.values)])),
  );
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      onChanged(message);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const saveValues = (profile: string) => {
    const parsed = parseValues(texts[profile] ?? "");
    if (parsed.error) {
      setError(parsed.error);
      return;
    }
    const items = bindings.map((b) =>
      b.environment_id === env.id && b.profile === profile ? { ...b, values: parsed.values } : b,
    );
    void run(() => api.saveBindings(token, projectId, items), `Values for ${profile} in ${env.name} saved: the next deploy uses them.`);
  };
  return (
    <details className="deploy-config" data-environment-config={env.name}>
      <summary>
        Configuration <span className="sub">· {keys.length} secret{keys.length === 1 ? "" : "s"}</span>
      </summary>
      {mine.length === 0 ? (
        <p className="hint">Bind a profile to {env.name} below to give its release chart values.</p>
      ) : (
        mine.map((b) => (
          <label key={b.profile} className="field">
            Chart values for <code>{b.profile}</code>
            <textarea
              rows={4}
              value={texts[b.profile] ?? ""}
              placeholder='{ "api-gateway": { "replicaCount": 2 } }'
              onChange={(e) => setTexts((t) => ({ ...t, [b.profile]: e.target.value }))}
            />
            <button type="button" disabled={busy} onClick={() => saveValues(b.profile)}>
              Save values
            </button>
          </label>
        ))
      )}
      <div className="field">
        <span>
          Secrets <span className="sub">— kept in credstore, given to every application as environment variables</span>{" "}
          {isResearch(env) && <SecretsLimit />}
        </span>
        <ul className="rows">
          {keys.map((k) => (
            <li key={k}>
              <code className="grow">{k}</code>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run(() => api.deleteConfigSecret(token, projectId, env.id, k), `${k} removed from ${env.name}.`)}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div className="row">
          <input value={key} onChange={(e) => setKey(e.target.value.toUpperCase())} placeholder="SMTP_PASSWORD" aria-label="Secret key" />
          <input type="password" value={value} onChange={(e) => setValue(e.target.value)} placeholder="value" aria-label="Secret value" />
          <button
            type="button"
            disabled={busy || !isSecretKey(key) || !value}
            onClick={() =>
              void run(async () => {
                await api.setConfigSecret(token, projectId, env.id, key, value);
                setKey("");
                setValue("");
              }, `${key} set for ${env.name}: the next deploy writes it.`)
            }
          >
            Set
          </button>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
    </details>
  );
}

/** What the Product step last wrote: the description's path, its branch and
 *  pull request. What a build builds unless told otherwise; the profile is
 *  the environment's binding's (ADR-0057). */
export interface SavedProduct {
  path: string;
  branch: string | null;
  prUrl: string | null;
  /** The description revision Studio keeps and a build takes (ADR-0053 §2). */
  revision?: number | null;
}

/** The environments a Studio build can push from: a registry prefix and a
 *  login to push with. */
export function buildableEnvironments(environments: readonly DeployEnvironment[]): DeployEnvironment[] {
  return environments.filter(
    (e) =>
      (e.kind === "research" && !!e.research_project) || (e.registry.includes("/") && !!e.registry_connection_id),
  );
}

/** Whether an environment is a Constructor Research one (ADR-0049). */
export function isResearch(e: Pick<DeployEnvironment, "kind">): boolean {
  return e.kind === "research";
}

/** One place a Studio build can put its images: a registry, or a Research
 *  project, with the environments that take from it. */
export interface BuildDestination {
  key: string;
  kind: "registry" | "research";
  /** The registry prefix, or the Research project's id. */
  name: string;
  environments: DeployEnvironment[];
}

/** The environments a Studio build can push from, grouped by where the images
 *  go: environments that share a registry (or a Research project) take the
 *  same build. */
export function buildDestinations(environments: readonly DeployEnvironment[]): BuildDestination[] {
  const out: BuildDestination[] = [];
  for (const e of buildableEnvironments(environments)) {
    const kind = isResearch(e) ? "research" : "registry";
    const name = (isResearch(e) ? e.research_project : e.registry) ?? "";
    const key = `${kind}:${name}`;
    const at = out.find((d) => d.key === key);
    if (at) at.environments.push(e);
    else out.push({ key, kind, name, environments: [e] });
  }
  return out;
}

/** "→ registry ghcr.io/acme (envs dev, stage)", "→ Research project p1 (env research-dev)". */
export function destinationText(d: BuildDestination): string {
  const names = d.environments.map((e) => e.name);
  const envs = `${names.length === 1 ? "env" : "envs"} ${names.join(", ")}`;
  return `→ ${d.kind === "research" ? "Research project" : "registry"} ${d.name} (${envs})`;
}

/** Opens Organization › Infrastructure, with "Add a place" on the kind asked
 *  for: the portal's router follows the address. */
export function openInfrastructure(add?: "registry" | "cluster") {
  const q = new URLSearchParams(window.location.search);
  if (add) q.set("add", add);
  const query = q.toString();
  window.history.pushState(null, "", `/infrastructure${query ? `?${query}` : ""}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Opens Organization › Connections, where a member signs in to Research
 *  with their own account (ADR-0049 §5). */
function openConnections() {
  window.history.pushState(null, "", `/connections${window.location.search}`);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

/** Build for Research in one click: the environment's bound profile, the
 *  product record's path, the repository's own branch. */
function BuildForResearch({
  token,
  projectId,
  env,
  label = "Build for Research",
  chip,
  onChanged,
}: {
  token: string;
  projectId: string;
  env: DeployEnvironment;
  label?: string;
  /** Drawn as a chip (a rung's prerequisite) rather than a button. */
  chip?: boolean;
  onChanged?: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const [targets, declared] = await Promise.all([api.projectTargets(token, projectId), readDeclaredProfiles(token, projectId)]);
      const deployable = deployableProfiles(declared).map((p) => p.id);
      const b = await api.startBuild(token, projectId, { environment_id: env.id, profile: profileFor(targets.bindings, env.id, deployable) });
      onChanged?.(`Build ${b.build_id} started for ${env.name} in Research; it shows under Build as it goes.`);
    } catch (e) {
      setError(buildRefusalText(e, errText));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {chip ? (
        <StatusChip tone="warn" onClick={busy ? undefined : () => void start()} data-research-build>
          {busy ? "starting a build…" : `no build for Research → ${label}`}
        </StatusChip>
      ) : (
        <button type="button" className="primary" disabled={busy} onClick={() => void start()} data-research-build>
          {busy ? "Starting…" : label}
        </button>
      )}
      {error && <span className="error">{error}</span>}
    </>
  );
}

/** Secrets in Research are plain variables (ADR-0049 §4): a warn chip, the why behind its "?". */
function SecretsLimit() {
  return (
    <span className="research-needs" data-research-limit="secrets">
      <StatusChip tone="warn">secrets → plain variables</StatusChip>
      <InfoPopover label="Why are secrets plain variables in Research?">
        Research&apos;s public API has no secret variables and returns a service&apos;s variables as they are, so a
        secret set here reaches the application as a plain environment variable (ADR-0049 §4).
      </InfoPopover>
    </span>
  );
}

/** Each project's connections, read once a visit: every rung asks. */
const connectionsRead = new Map<string, Promise<Connection[]>>();
function projectConnections(token: string, projectId: string): Promise<Connection[]> {
  let p = connectionsRead.get(projectId);
  if (!p) {
    p = api
      .connections(token, projectId)
      .then((r) => r.items)
      .catch(() => {
        connectionsRead.delete(projectId);
        return [] as Connection[];
      });
    connectionsRead.set(projectId, p);
  }
  return p;
}

/** A rung of the release ladder: its place as a chip; for a Research
 *  environment also what it still needs, each one click away -- the member's
 *  own sign-in, a build made in Research -- and its limits as warn chips.
 *  Research is a place, not another process (ADR-0056 §1). */
export function RungPlace({
  token,
  projectId,
  step,
  onChanged,
}: {
  token: string;
  projectId: string;
  step: Pick<LadderStep, "environment" | "deployable">;
  onChanged?: (message: string) => void;
}) {
  const env = step.environment;
  const research = isResearch(env);
  const [connections, setConnections] = useState<Connection[] | null>(null);
  useEffect(() => {
    let live = true;
    void projectConnections(token, projectId).then((c) => live && setConnections(c));
    return () => {
      live = false;
    };
  }, [token, projectId]);
  const place = connections?.find((c) => c.id === env.connection_id);
  // The member's own sign-in to Research, not the one the environment was made with.
  const signedIn = connections?.some((c) => c.provider === "research" && (c.mine || c.scope === "personal"));
  return (
    <div className="research-needs" data-rung-place={research ? "research" : "cluster"}>
      <StatusChip tone={research ? "info" : "neutral"} title={research ? "A Constructor Research project" : "A Kubernetes cluster"}>
        {research ? `⚗ Research ${env.research_project ?? ""}` : `☁ ${place?.label ?? "cluster"}`}
      </StatusChip>
      {research && connections !== null && !signedIn && (
        <StatusChip tone="warn" onClick={openConnections} data-research-signin>
          your Research sign-in: none → Connect
        </StatusChip>
      )}
      {research && step.deployable.length === 0 && (
        <BuildForResearch token={token} projectId={projectId} env={env} label="Build" chip onChanged={onChanged} />
      )}
      {research && (
        <>
          <SecretsLimit />
          <span className="research-needs" data-research-limit="previews">
            <StatusChip tone="warn">no previews</StatusChip>
            <InfoPopover label="Why no previews in Research?">
              A preview is a namespace of its own beside the environment (ADR-0055); a Research environment has no
              namespace, so it takes deploys only.
            </InfoPopover>
          </span>
        </>
      )}
    </div>
  );
}

/** The profile a build for `environment` takes: the one bound to it, else the
 *  one every other environment runs, else the first deployable profile the
 *  saved description declares (`deployable`), else `prod`. */
export function profileFor(bindings: readonly EnvironmentBinding[], environment: string, deployable: readonly string[] = []): string {
  const bound = bindings.find((b) => b.environment_id === environment)?.profile;
  if (bound) return bound;
  const all = [...new Set(bindings.map((b) => b.profile))];
  if (all.length === 1) return all[0];
  return deployable.includes("prod") ? "prod" : (deployable[0] ?? "prod");
}

/** Build in Studio: a Job in the environment's cluster clones the repository,
 *  generates the product, builds its images and pushes them and the chart to
 *  the environment's registry. Said as one sentence -- what is built, from
 *  where, to where -- with Change for the member who wants another branch,
 *  file, profile or environment. */
export function BuildInStudio({
  token,
  projectId,
  environments,
  bindings,
  saved,
  own,
  onChanged,
}: {
  token: string;
  projectId: string;
  environments: DeployEnvironment[];
  /** Which profile each environment runs: a build takes its environment's. */
  bindings: EnvironmentBinding[];
  saved: SavedProduct | null;
  /** The repository's own Dockerfiles and chart (ADR-0054 §7); absent: on gears. */
  own?: ProjectBuildSetting | null;
  onChanged?: (message: string) => void;
}) {
  // Research builds a product on gears only, for now.
  const choices = buildableEnvironments(environments).filter((e) => !own || !isResearch(e));
  const [envId, setEnvId] = useState("");
  const [productFile, setProductFile] = useState<string | null>(null);
  const [gitRef, setGitRef] = useState<string | null>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the build would do, asked again whenever what it would build
  // changes -- after a pause, as the fields change per key.
  const [plan, setPlan] = useState<BuildPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [started, setStarted] = useState(0);
  const deployable = deployableProfiles(useDeclaredProfiles(token, projectId)).map((p) => p.id);
  const planEnv = choices.find((e) => e.id === envId) ?? choices[0];
  const planBody = planEnv
    ? {
        environment_id: planEnv.id,
        profile: profile ?? profileFor(bindings, planEnv.id, deployable),
        ...((productFile ?? saved?.path ?? "").trim() ? { product_file: (productFile ?? saved?.path ?? "").trim() } : {}),
        ...((gitRef ?? saved?.branch ?? "").trim() ? { ref: (gitRef ?? saved?.branch ?? "").trim() } : {}),
      }
    : null;
  const asked = planBody ? planKey(planBody) : "";
  useEffect(() => {
    if (!planBody) return;
    let live = true;
    const timer = window.setTimeout(() => {
      api
        .planBuild(token, projectId, planBody)
        .then((p) => {
          if (!live) return;
          setPlan(p);
          setPlanError(null);
        })
        .catch((e: unknown) => {
          if (!live) return;
          setPlan(null);
          setPlanError(errText(e));
        });
    }, PLAN_PAUSE_MS);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
    // `asked` is the body's fields; the body itself is a new object every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asked, token, projectId, started]);
  if (choices.length === 0) {
    return (
      <div data-build-studio-unavailable>
        <EmptyState
          title="No registry to build into"
          body={
            <>
              Or build on your machine or in CI.{" "}
              <InfoPopover label="What can take a Studio build?">
                An environment with a registry prefix and a registry connection to push with, or a Constructor Research
                project (ADR-0048, ADR-0049).
              </InfoPopover>
            </>
          }
          action={
            <button type="button" className="primary" onClick={() => openInfrastructure("registry")} data-connect-registry>
              Connect a registry
            </button>
          }
        />
      </div>
    );
  }
  // The Product step's answer unless the member changed it.
  const env = choices.find((e) => e.id === envId) ?? choices[0];
  const destinations = buildDestinations(choices);
  const here = destinations.find((d) => d.environments.some((e) => e.id === env.id)) ?? destinations[0];
  const file = productFile ?? saved?.path ?? "";
  const branch = gitRef ?? saved?.branch ?? "";
  const bound = profileFor(bindings, env.id, deployable);
  const options = [...new Set([bound, ...bindings.map((b) => b.profile), ...deployable])];
  const prof = profile ?? bound;
  return (
    <div data-build-in-studio>
      {own ? (
        <p data-build-summary data-build-own>
          Builds {ownBuildSummary(own)} from {branch ? <code>{branch}</code> : "the repository's own branch"}.{" "}
          <button type="button" className="linklike" onClick={() => setChanging((v) => !v)} data-build-change>
            {changing ? "Done" : "Change"}
          </button>
        </p>
      ) : (
      <p data-build-summary>
        Builds <code>{file}</code>
        {saved?.revision ? ` (revision ${saved.revision}, kept in Studio)` : ""} with the code of{" "}
        {branch ? <code>{branch}</code> : "the repository's own branch"}
        {saved?.prUrl && branch === saved.branch ? (
          <>
            {" "}
            (
            <a href={saved.prUrl} target="_blank" rel="noreferrer">
              the Product step&apos;s pull request
            </a>
            )
          </>
        ) : null}{" "}
        for profile <code>{prof}</code>.{" "}
        <button type="button" className="linklike" onClick={() => setChanging((v) => !v)} data-build-change>
          {changing ? "Done" : "Change"}
        </button>
      </p>
      )}
      {/* Where the images go, as a chip; with more than one place, chosen here. */}
      <div className="build-dest" data-build-destination={here.kind}>
        {destinations.length > 1 ? (
          <select
            value={here.key}
            onChange={(e) => setEnvId(destinations.find((d) => d.key === e.target.value)?.environments[0]?.id ?? "")}
            aria-label="Build into"
            data-build-destination-pick
          >
            {destinations.map((d) => (
              <option key={d.key} value={d.key}>
                {destinationText(d)}
              </option>
            ))}
          </select>
        ) : (
          <StatusChip tone={here.kind === "research" ? "info" : "neutral"} data-build-destination-chip>
            {destinationText(here)}
          </StatusChip>
        )}
        {here.kind === "research" && (
          <InfoPopover label="How a Research build goes">
            Studio prepares the product, and Constructor Research builds the images in its project with its own builder,
            under your own sign-in (ADR-0049 §3, §5).
          </InfoPopover>
        )}
      </div>
      {changing && (
        <div className="row" data-build-fields>
          {here.environments.length > 1 && (
            <select value={env.id} onChange={(e) => setEnvId(e.target.value)} aria-label="Environment" title="The environment whose profile and login the build takes">
              {here.environments.map((e) => (
                <option key={e.id} value={e.id}>
                  for {e.name}
                </option>
              ))}
            </select>
          )}
          {!own && (
          <input
            value={file}
            onChange={(e) => setProductFile(e.target.value)}
            aria-label="Product description"
            title="The product's description in the repository: product.gdl, or products/<name>/product.gdl"
            placeholder="products/<product>/product.gdl"
          />
          )}
          <input
            value={branch}
            onChange={(e) => setGitRef(e.target.value)}
            aria-label="Branch or tag"
            title="The branch or tag to build; the repository's own branch when empty. Push it first: the Job clones from the repository, not from anybody's machine."
            placeholder="the repository's own branch"
          />
          {!own && (
          <select value={prof} onChange={(e) => setProfile(e.target.value)} aria-label="Profile">
            {options.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          )}
        </div>
      )}
      {plan && <BuildPlanView plan={plan} />}
      {planError && (
        <p className="hint" data-build-plan-unknown>
          Studio could not say what the build will do: {planError}
        </p>
      )}
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={building || !!plan?.refusal}
          title={plan?.refusal ? (planRefusalText(plan.refusal) ?? undefined) : undefined}
          onClick={async () => {
            setBuilding(true);
            setError(null);
            try {
              const b = await api.startBuild(token, projectId, {
                environment_id: env.id,
                profile: prof,
                // None named: the server takes the product record's path.
                ...(file.trim() ? { product_file: file.trim() } : {}),
                ...(branch.trim() ? { ref: branch.trim() } : {}),
              });
              onChanged?.(`Build ${b.build_id} started in ${b.namespace}; it shows below as it goes.`);
            } catch (e) {
              setError(buildRefusalText(e, errText));
            } finally {
              setBuilding(false);
              // What was true before may not be now: the plan is asked again.
              setStarted((n) => n + 1);
            }
          }}
          data-build-start-studio
        >
          {building ? "Starting…" : isResearch(env) ? "Build in Research" : "Build in Studio"}
        </button>
      </div>
      {plan?.refusal && (
        <div className="error" data-build-refusal={plan.refusal.code}>
          {planRefusalText(plan.refusal)}
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** How long the fields rest before the plan is asked again. */
const PLAN_PAUSE_MS = 400;

/** "What this build will do": where its Job runs, the builder, the code and
 *  whose connection clones it, the repositories it pushes to, and what the
 *  server warns of. Folded to its first lines; the rest on a click. */
function BuildPlanView({ plan }: { plan: BuildPlan }) {
  const lines = planLines(plan);
  return (
    <details className="build-plan" data-build-plan open={plan.warnings.length > 0 || lines.some((l) => l.warn)}>
      <summary>
        <b>What this build will do</b>{" "}
        <span className="sub">
          · {plan.environment}, namespace <code>{plan.build_namespace}</code>
          {plan.warnings.length > 0 ? ` · ${plan.warnings.length} warning${plan.warnings.length === 1 ? "" : "s"}` : ""}
        </span>
      </summary>
      <dl
        className="sub"
        style={{ margin: "6px 0 0", display: "grid", gridTemplateColumns: "max-content 1fr", gap: "2px 8px" }}
      >
        {lines.map((l, i) => (
          <div key={`${l.label}-${i}`} style={{ display: "contents" }} data-build-plan-line={l.label}>
            <dt>{l.label}</dt>
            <dd style={{ margin: 0, overflowWrap: "anywhere" }} className={l.warn ? "warn" : undefined}>
              <code>{l.value}</code>
              {l.warn ? " ⚠" : ""}
            </dd>
          </div>
        ))}
      </dl>
      {plan.warnings.length > 0 && (
        <ul className="hint" style={{ margin: "6px 0 0", paddingLeft: 18 }} data-build-plan-warnings>
          {codedWarnings(plan.warnings, plan.warning_codes).map((w) => (
            <li key={w.text} data-warning-code={w.code ?? undefined}>
              {w.code ? <code>{w.code}</code> : null}
              {w.code ? " " : null}
              {w.text}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}

/** Propose the workflow that builds the product in the repository's CI on
 *  every push to main, as a pull request. What it proposed is said only right
 *  after, in this visit: the pull request's own page says what became of it. */
export function ProposeBuildWorkflow({
  token,
  projectId,
  environments,
  bindings,
  saved,
}: {
  token: string;
  projectId: string;
  environments: DeployEnvironment[];
  bindings: EnvironmentBinding[];
  saved: SavedProduct | null;
}) {
  const choices = environments.filter((e) => e.registry.includes("/"));
  const [envId, setEnvId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ pr_url?: string | null; branch: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deployable = deployableProfiles(useDeclaredProfiles(token, projectId)).map((p) => p.id);
  if (choices.length === 0) {
    return (
      <p className="hint">
        A CI workflow publishes to an environment&apos;s registry, and no environment of this project names one yet
        (Organization › Infrastructure).
      </p>
    );
  }
  const env = choices.find((e) => e.id === envId) ?? choices[0];
  const profile = profileFor(bindings, env.id, deployable);
  const file = saved?.path;
  return (
    <div data-propose-workflow>
      <div className="row">
        {choices.length > 1 && (
          <select value={env.id} onChange={(e) => setEnvId(e.target.value)} aria-label="Environment">
            {choices.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} — {e.registry}
              </option>
            ))}
          </select>
        )}
        <span className="grow hint">
          A workflow that builds {file ? <code>{file}</code> : "the project's product"} for profile <code>{profile}</code> and publishes to{" "}
          <code>{env.registry}</code>, proposed to the repository as a pull request.
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setResult(
                await api.proposeBuildWorkflow(token, projectId, {
                  environment_id: env.id,
                  profile,
                  ...(file ? { product_file: file } : {}),
                }),
              );
            } catch (e) {
              setError(errText(e));
            } finally {
              setBusy(false);
            }
          }}
          data-propose-workflow-start
        >
          {busy ? "Proposing…" : "Propose a CI workflow"}
        </button>
      </div>
      {result && (
        <p className="hint" data-propose-workflow-result>
          Proposed on <code>{result.branch}</code>
          {result.pr_url && (
            <>
              {" "}
              —{" "}
              <a href={result.pr_url} target="_blank" rel="noreferrer">
                the pull request
              </a>
            </>
          )}
          . Once it is merged, every push to main builds the product.
        </p>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
