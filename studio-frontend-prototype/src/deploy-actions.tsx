/* What a project does in one environment from the portal (ADR-0048): deploy a
 * build a pipeline or the IDE published, roll back to the one before, take the
 * release out; the release's configuration there (chart values, secrets); and
 * the workflow that builds the product for it. The rules are in
 * `project-deploys.ts`; the server checks every one of them again. */

import { useState } from "react";

import { api, type ConfigSecret, type Deployment, type DeployEnvironment, type EnvironmentBinding } from "./api";
import type { IdeBuild } from "./builds";
import { shortCommit } from "./environments";
import { errText, relTime } from "./format";
import {
  deployableBuilds,
  isSecretKey,
  parseValues,
  promotionGap,
  rollbackTarget,
  runsNow,
  valuesText,
} from "./project-deploys";

/** Ask the server for a deploy, and say what it answered: queued, or
 *  waiting for an administrator. One for every place a deploy is asked. */
function useDeployRequest(token: string, projectId: string, onChanged: (message: string) => void) {
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
 *  the Builds tab's action on a build, beside each environment's own. */
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
  const [envId, setEnvId] = useState(environments[0]?.id ?? "");
  const { busy, error, ask } = useDeployRequest(token, projectId, onChanged);
  const envName = (id: string) => environments.find((e) => e.id === id)?.name ?? id;
  const env = environments.find((e) => e.id === envId);
  const gap = env ? promotionGap(env, build, deployments, envName) : null;
  if (environments.length === 0) return null;
  return (
    <div className="row" style={{ gap: 6, marginTop: 6 }} data-deploy-build-to>
      <select value={envId} onChange={(e) => setEnvId(e.target.value)} aria-label="Environment">
        {environments.map((e) => (
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
          env && void ask({ environment_id: env.id, build: build.buildId }, `Deploy ${build.chartVersion} to ${env.name} -- it shows under Deploys`)
        }
      >
        Deploy…
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
  onChanged,
}: {
  token: string;
  projectId: string;
  env: DeployEnvironment;
  latest: Deployment | undefined;
  deployments: Deployment[];
  builds: IdeBuild[];
  envName: (id: string) => string;
  onChanged: (message: string) => void;
}) {
  const [picking, setPicking] = useState(false);
  const request = useDeployRequest(token, projectId, onChanged);
  const { busy, error } = request;
  const candidates = deployableBuilds(builds, env);
  const back = rollbackTarget(deployments, env.id);
  const ask = async (body: Parameters<typeof api.createDeployment>[2], what: string) => {
    if (await request.ask(body, what)) setPicking(false);
  };
  return (
    <div className="deploy-actions" data-environment-actions={env.name}>
      <div className="row">
        <button type="button" className="primary" disabled={busy} onClick={() => setPicking((v) => !v)}>
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
            <p className="hint">
              {isResearch(env)
                ? "No build made in Constructor Research yet: Build in Research in the Builds tab."
                : "No build has published a chart yet: build in the Builds tab, or publish from the IDE's Deploy."}
            </p>
          ) : (
            <ul className="rows">
              {candidates.slice(0, 8).map((b) => {
                const gap = promotionGap(env, b, deployments, envName);
                return (
                  <li key={b.id}>
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
                  </li>
                );
              })}
            </ul>
          )}
        </div>
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
        Secrets <span className="sub">— kept in credstore, given to every application as environment variables</span>
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
 *  pull request, the profile picked. What a build builds unless told
 *  otherwise. */
export interface SavedProduct {
  path: string;
  branch: string | null;
  prUrl: string | null;
  profile: string | null;
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

/** Where an environment keeps what a build makes, said in a few words. */
export function buildTarget(e: DeployEnvironment): string {
  return isResearch(e) ? `Research project ${e.research_project}` : e.registry;
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
  profiles,
  saved,
  onChanged,
}: {
  token: string;
  projectId: string;
  environments: DeployEnvironment[];
  profiles: string[];
  saved: SavedProduct | null;
  onChanged?: (message: string) => void;
}) {
  const choices = buildableEnvironments(environments);
  const [envId, setEnvId] = useState("");
  const [productFile, setProductFile] = useState<string | null>(null);
  const [gitRef, setGitRef] = useState<string | null>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (choices.length === 0) {
    return (
      <p className="hint" data-build-studio-unavailable>
        No environment can take a Studio build yet: one needs a registry prefix and a registry connection to push with,
        or a Constructor Research project (Organization › Environments). Until then, build on your machine or in CI.
      </p>
    );
  }
  // The Product step's answer unless the member changed it.
  const env = choices.find((e) => e.id === envId) ?? choices[0];
  const file = productFile ?? saved?.path ?? "product.gdl";
  const branch = gitRef ?? saved?.branch ?? "";
  const options = profiles.length ? profiles : ["prod"];
  const prof = profile ?? (saved?.profile && options.includes(saved.profile) ? saved.profile : options[0]);
  return (
    <div data-build-in-studio>
      <p data-build-summary>
        Builds <code>{file}</code> from {branch ? <code>{branch}</code> : "the repository's own branch"}
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
        for profile <code>{prof}</code>
        {isResearch(env) ? (
          <>
            : Studio prepares it, and Constructor Research builds the images in <code>{env.research_project}</code> for{" "}
            <b>{env.name}</b>.{" "}
          </>
        ) : (
          <>
            , and pushes its images and chart to <code>{env.registry}</code> of <b>{env.name}</b>.{" "}
          </>
        )}
        <button type="button" className="linklike" onClick={() => setChanging((v) => !v)} data-build-change>
          {changing ? "Done" : "Change"}
        </button>
      </p>
      {changing && (
        <div className="row" data-build-fields>
          <select value={env.id} onChange={(e) => setEnvId(e.target.value)} aria-label="Environment">
            {choices.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} — {buildTarget(e)}
              </option>
            ))}
          </select>
          <input
            value={file}
            onChange={(e) => setProductFile(e.target.value)}
            aria-label="Product description"
            title="The product's description in the repository: product.gdl, or products/<name>/product.gdl"
            placeholder="product.gdl"
          />
          <input
            value={branch}
            onChange={(e) => setGitRef(e.target.value)}
            aria-label="Branch or tag"
            title="The branch or tag to build; the repository's own branch when empty. Push it first: the Job clones from the repository, not from anybody's machine."
            placeholder="the repository's own branch"
          />
          <select value={prof} onChange={(e) => setProfile(e.target.value)} aria-label="Profile">
            {options.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </div>
      )}
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={building}
          onClick={async () => {
            setBuilding(true);
            setError(null);
            try {
              const b = await api.startBuild(token, projectId, {
                environment_id: env.id,
                profile: prof,
                product_file: file.trim() || "product.gdl",
                ...(branch.trim() ? { ref: branch.trim() } : {}),
              });
              onChanged?.(`Build ${b.build_id} started in ${b.namespace}; it shows below as it goes.`);
            } catch (e) {
              setError(errText(e));
            } finally {
              setBuilding(false);
            }
          }}
          data-build-start-studio
        >
          {building ? "Starting…" : isResearch(env) ? "Build in Research" : "Build in Studio"}
        </button>
      </div>
      {error && <div className="error">{error}</div>}
    </div>
  );
}

/** Propose the workflow that builds the product in the repository's CI on
 *  every push to main, as a pull request. What it proposed is said only right
 *  after, in this visit: the pull request's own page says what became of it. */
export function ProposeBuildWorkflow({
  token,
  projectId,
  environments,
  profiles,
  saved,
}: {
  token: string;
  projectId: string;
  environments: DeployEnvironment[];
  profiles: string[];
  saved: SavedProduct | null;
}) {
  const choices = environments.filter((e) => e.registry.includes("/"));
  const [envId, setEnvId] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ pr_url?: string | null; branch: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (choices.length === 0) {
    return (
      <p className="hint">
        A CI workflow publishes to an environment&apos;s registry, and no environment of this project names one yet
        (Organization › Environments).
      </p>
    );
  }
  const env = choices.find((e) => e.id === envId) ?? choices[0];
  const options = profiles.length ? profiles : ["prod"];
  const profile = saved?.profile && options.includes(saved.profile) ? saved.profile : options[0];
  const file = saved?.path ?? "product.gdl";
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
          A workflow that builds <code>{file}</code> for profile <code>{profile}</code> and publishes to{" "}
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
                  product_file: file,
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
