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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = deployableBuilds(builds);
  const back = rollbackTarget(deployments, env.id);
  const ask = async (body: Parameters<typeof api.createDeployment>[2], what: string) => {
    setBusy(true);
    setError(null);
    try {
      const d = await api.createDeployment(token, projectId, body);
      setPicking(false);
      onChanged(d.state === "awaiting_approval" ? `${what}: waiting for an administrator's approval.` : `${what}: queued.`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
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
            onClick={() => void ask({ environment_id: env.id, redeploy_of: back.id }, `Rollback to ${back.chart_version ?? "the earlier build"}`)}
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
              No build has published a chart yet. Propose the build workflow below, or publish from the IDE&apos;s Deploy.
            </p>
          ) : (
            <ul className="rows">
              {candidates.slice(0, 8).map((b) => {
                const gap = promotionGap(env, b, deployments, envName);
                return (
                  <li key={b.id}>
                    <div className="grow">
                      <b>{b.chartVersion}</b> <span className="sub">{b.where}</span>{" "}
                      {b.commit && <code>{shortCommit(b.commit)}</code>}{" "}
                      <span className="sub">{relTime(b.finishedAt ?? b.startedAt ?? "")}</span>
                      {gap && <div className="sub warn">{gap}</div>}
                    </div>
                    <button
                      type="button"
                      disabled={busy || !!gap}
                      onClick={() => void ask({ environment_id: env.id, build: b.buildId }, `Deploy ${b.chartVersion}`)}
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

/** Build the product for an environment: in Studio, as a Job in the
 *  environment's cluster, or by proposing a CI workflow to the repository. */
export function BuildWorkflowProposal({
  token,
  projectId,
  environments,
  profiles,
  onChanged,
}: {
  token: string;
  projectId: string;
  environments: DeployEnvironment[];
  profiles: string[];
  onChanged?: (message: string) => void;
}) {
  const withRegistry = environments.filter((e) => e.registry.includes("/"));
  const [building, setBuilding] = useState(false);
  const [envId, setEnvId] = useState(withRegistry[0]?.id ?? "");
  const [profile, setProfile] = useState(profiles[0] ?? "prod");
  const [productFile, setProductFile] = useState("product.gdl");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ pr_url?: string | null; branch: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (withRegistry.length === 0) return null;
  return (
    <div className="card" data-build-workflow>
      <h3>Build</h3>
      <p className="hint">
        <b>Build in Studio</b> runs the build as a Job in the environment&apos;s cluster, on the organization&apos;s nodes: it
        clones the repository, generates the profile with the Gearbox engine this Studio runs, builds the images and pushes
        them and the chart under the environment&apos;s registry. Or propose a workflow that does the same in the
        repository&apos;s CI on every push to main. Either way the build appears under Deploy a build once it passes.
      </p>
      <div className="row">
        <select value={envId} onChange={(e) => setEnvId(e.target.value)} aria-label="Environment">
          {withRegistry.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} — {e.registry}
            </option>
          ))}
        </select>
        <input
          value={productFile}
          onChange={(e) => setProductFile(e.target.value)}
          aria-label="Product description"
          title="The product's description in the repository: product.gdl, or products/<name>/product.gdl"
          placeholder="product.gdl"
        />
        <select value={profile} onChange={(e) => setProfile(e.target.value)} aria-label="Profile">
          {(profiles.length ? profiles : ["prod"]).map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        <button
          type="button"
          className="primary"
          disabled={building || !envId}
          onClick={async () => {
            setBuilding(true);
            setError(null);
            try {
              const b = await api.startBuild(token, projectId, {
                environment_id: envId,
                profile,
                product_file: productFile.trim() || "product.gdl",
              });
              onChanged?.(`Build ${b.build_id} started in ${b.namespace}: it shows under Builds, and under Deploy a build once it passes.`);
            } catch (e) {
              setError(errText(e));
            } finally {
              setBuilding(false);
            }
          }}
        >
          {building ? "Starting…" : "Build in Studio"}
        </button>
        <button
          type="button"
          disabled={busy || !envId}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              setResult(
                await api.proposeBuildWorkflow(token, projectId, {
                  environment_id: envId,
                  profile,
                  product_file: productFile.trim() || "product.gdl",
                }),
              );
            } catch (e) {
              setError(errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Proposing…" : "Propose a CI workflow"}
        </button>
      </div>
      {result && (
        <p className="hint">
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
          . Merge it to build.
        </p>
      )}
      {error && <div className="error">{error}</div>}
    </div>
  );
}
