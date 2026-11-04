/* A product's infra services on screen (ADR-0064):
 *  - InfraLane: the product map's Infrastructure tab, each need of the gears
 *    bound to a deployable service, its image or chart source, and import;
 *  - InfraPlacementField: the environment form's placement setting;
 *  - InfraPlanView: what a deploy to an environment installs. */

import { useCallback, useEffect, useState } from "react";
import {
  api,
  type DeployEnvironment,
  type DeployEnvironmentInput,
  type InfraPassport,
  type InfraPlan,
  type InfraService,
  type ProductTechnology,
} from "./api";
import {
  bindNeeds,
  deployable,
  importedFrom,
  offeredInfra,
  parseShared,
  placementText,
  planItemText,
  planRefusals,
  serviceFrom,
  sharedAllowed,
  sharedText,
  sourceText,
  variableOf,
} from "./infra-services";
import { errText } from "./problem";

/** The Infrastructure tab of the product map's palette. */
export function InfraLane({
  token,
  projectId,
  needs,
  environments,
}: {
  token: string;
  projectId: string;
  needs: ProductTechnology[] | null;
  environments: DeployEnvironment[];
}) {
  const [services, setServices] = useState<InfraService[] | null>(null);
  const [offered, setOffered] = useState<InfraPassport[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const env = environments.find((e) => e.kind !== "research") ?? null;

  useEffect(() => {
    let live = true;
    Promise.all([
      api.infraServices(token, projectId).catch(() => ({ items: [] as InfraService[] })),
      api.listComponents(token, projectId).catch(() => ({ nodes: [] })),
    ]).then(([s, c]) => {
      if (!live) return;
      setServices(s.items);
      setOffered(offeredInfra(c.nodes ?? []));
    });
    return () => {
      live = false;
    };
  }, [token, projectId, round]);

  const save = useCallback(
    async (next: InfraService[], what: string) => {
      setBusy(what);
      setError(null);
      try {
        const saved = await api.putInfraServices(token, projectId, next);
        setServices(saved.items);
        setNote(what);
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusy(null);
      }
    },
    [token, projectId],
  );

  const importImage = async (s: InfraService) => {
    if (!env || !s.passport.image) return;
    setBusy(`import ${s.passport.name}`);
    setError(null);
    try {
      await api.importImage(token, projectId, { environment_id: env.id, source: s.passport.image, name: s.passport.name });
      setNote(`Importing ${s.passport.image} into the project's path in ${env.name}'s registry; use it once it is copied.`);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const useImported = async (s: InfraService) => {
    setBusy(`use ${s.passport.name}`);
    setError(null);
    try {
      const records = await api.projectImages(token, projectId, { app: s.passport.name, kind: "image" });
      const found = importedFrom(records.items, s.passport.image)[0];
      if (!found) {
        setError(`No copy of ${s.passport.image} is in the project's path yet: import it, then try again.`);
        return;
      }
      await save(
        (services ?? []).map((x) => (x.passport.name === s.passport.name ? { ...x, image: found.reference } : x)),
        `${s.passport.name} runs ${found.reference}`,
      );
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  if (services === null) return <p className="muted">Reading the infra services…</p>;
  const bound = bindNeeds(needs ?? [], services, offered);
  const unneeded = services.filter((s) => !bound.some((b) => b.service === s));
  const card = (s: InfraService) => (
    <div key={s.passport.name} className="pmap-item" data-infra-service={s.passport.name}>
      <div className="grow">
        <div className="pmap-item-name">
          {s.passport.name}
          {s.passport.version ? ` ${s.passport.version}` : ""}{" "}
          <span className={deployable(s) ? "badge ok" : "badge warn"} data-infra-deployable={deployable(s)}>
            {deployable(s) ? "deployable" : "not imported"}
          </span>
        </div>
        <div className="pmap-item-sub">{sourceText(s)}</div>
        {Object.keys(s.passport.provides).length > 0 && (
          <div className="pmap-item-sub">
            gives the product{" "}
            {Object.keys(s.passport.provides)
              .map((k) => `${k} as \${${variableOf(k)}}`)
              .join(", ")}
          </div>
        )}
        <div className="row" style={{ gap: 4, marginTop: 4 }}>
          {!s.image && s.passport.image && (
            <button type="button" className="ghost" disabled={!!busy || !env} onClick={() => void importImage(s)}>
              Import image
            </button>
          )}
          {!s.image && (
            <button type="button" className="ghost" disabled={!!busy} onClick={() => void useImported(s)}>
              Use the imported copy
            </button>
          )}
          <button
            type="button"
            className="ghost"
            disabled={!!busy}
            onClick={() =>
              void save(
                services.filter((x) => x.passport.name !== s.passport.name),
                `${s.passport.name} removed`,
              )
            }
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  );
  return (
    <div data-infra-lane>
      <p className="muted pmap-hint">
        Deployed with the product: each need of the gears is met by an infra service from the catalogue, its image
        imported into the project&apos;s path. Where it runs is the environment&apos;s setting.
      </p>
      {needs === null && <p className="muted">The gears&apos; needs show once the product is checked.</p>}
      {bound.map((b) => (
        <div key={b.need.id} data-infra-need={b.need.id}>
          <div className="pmap-item-sub">
            <b>{b.need.name}</b> — {b.need.why}; for {b.need.gears.length} gear{b.need.gears.length === 1 ? "" : "s"}
            {b.capability ? ` · needs ${b.capability}` : ""}
          </div>
          {b.service ? (
            card(b.service)
          ) : b.offer ? (
            <div className="pmap-item">
              <div className="grow">
                <div className="pmap-item-name">{b.offer.name} (catalogue)</div>
                <div className="pmap-item-sub">{b.offer.description ?? b.offer.image}</div>
              </div>
              <button
                type="button"
                disabled={!!busy}
                onClick={() => void save([...services, serviceFrom(b.offer!)], `${b.offer!.name} added`)}
              >
                Add
              </button>
            </div>
          ) : (
            <p className="muted">No infra service in the catalogue provides it.</p>
          )}
        </div>
      ))}
      {unneeded.map(card)}
      {note && <p className="hint">{note}</p>}
      {error && <p className="error">{error}</p>}
      <button type="button" className="ghost" onClick={() => setRound((r) => r + 1)}>
        Read again
      </button>
    </div>
  );
}

/** The environment form's setting: where a product's infra services run. */
export function InfraPlacementField({
  input,
  set,
}: {
  input: DeployEnvironmentInput;
  set: <K extends keyof DeployEnvironmentInput>(k: K, v: DeployEnvironmentInput[K]) => void;
}) {
  const placement = input.infra?.placement ?? "with_product";
  const allowed = sharedAllowed(input);
  const [text, setText] = useState(() => sharedText(input.infra?.shared ?? []));
  return (
    <details className="env-advanced" open={placement === "shared"} data-environment-infra>
      <summary>
        Infra services
        <span className="sub"> · {placementText(input.infra)}</span>
      </summary>
      <label className="field">
        Where a product&apos;s PostgreSQL, Keycloak and the like run
        <select
          value={placement}
          onChange={(e) =>
            set(
              "infra",
              e.target.value === "shared"
                ? { placement: "shared", shared: parseShared(text) }
                : { placement: "with_product", shared: [] },
            )
          }
          aria-label="Infra placement"
        >
          <option value="with_product">With the product, one of each per environment</option>
          <option value="shared" disabled={!allowed}>
            The organization&apos;s shared place{allowed ? "" : " (not in a dev environment)"}
          </option>
        </select>
        <span className="hint">
          A dev environment always runs them with the product, so a product never signs in through Studio&apos;s own
          identity provider.
        </span>
      </label>
      {placement === "shared" && (
        <label className="field">
          Shared places
          <textarea
            rows={3}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              set("infra", { placement: "shared", shared: parseShared(e.target.value) });
            }}
            placeholder="keycloak @identity oidc.issuer=https://id.acme.example/realms/shop"
          />
          <span className="hint">
            One service per line: its name, where it runs (@namespace), and what it provides. Passwords go in the
            project&apos;s configuration secrets.
          </span>
        </label>
      )}
    </details>
  );
}

/** What a deploy to `environmentId` does with the project's infra services. */
export function InfraPlanView({ token, projectId, environmentId }: { token: string; projectId: string; environmentId: string }) {
  const [plan, setPlan] = useState<InfraPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api
      .infraPlan(token, projectId, environmentId)
      .then((p) => live && setPlan(p))
      .catch((e) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [token, projectId, environmentId]);
  if (error) return <p className="hint">What the infra services will do could not be read: {error}</p>;
  if (!plan || plan.items.length === 0) return null;
  const refusals = planRefusals(plan);
  return (
    <details className="build-plan" data-infra-plan open={refusals.length > 0}>
      <summary>
        <b>Infra services this deploy brings</b>{" "}
        <span className="sub">
          · {placementText({ placement: plan.placement, shared: [] })}
          {plan.namespace ? `, namespace ${plan.namespace}` : ""}
        </span>
      </summary>
      <ul className="sub" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
        {plan.items.map((i) => (
          <li key={i.service} data-infra-plan-item={i.service}>
            {planItemText(i)}
            {i.provides.length > 0 && ` · gives ${i.provides.map((p) => p.variable).join(", ")}`}
          </li>
        ))}
      </ul>
      {refusals.length > 0 && (
        <ul className="error" style={{ margin: "6px 0 0", paddingLeft: 18 }} data-infra-plan-refusals>
          {refusals.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      )}
    </details>
  );
}
