/* A product's infra services on screen (ADR-0064):
 *  - InfraLane: the product map's Infrastructure tab, each need of the gears
 *    bound to a deployable service, its image or chart source, and import;
 *  - InfraPlacementField: the environment form's placement setting;
 *  - InfraPlanView: what a deploy to an environment installs;
 *  - ProductInfraServices: Product › Infrastructure, the editor -- needs and
 *    what meets them per environment, the services (add, image, ready chart,
 *    public address, remove), and the links to the gears' config fields. */

import { useCallback, useEffect, useState } from "react";
import {
  api,
  type DeployEnvironment,
  type DeployEnvironmentInput,
  type GearConfig,
  type InfraIngress,
  type InfraPassport,
  type InfraPlan,
  type InfraService,
  type KeycloakRealm,
  type ProductTechnology,
  type ProjectImage,
} from "./api";
import { DataTable, useConfirm } from "./data-table";
import { gearKey } from "./frontend-constructor";
import {
  bindNeeds,
  configLines,
  deployable,
  importedFrom,
  infraRows,
  linkedConfig,
  linkRows,
  mirrorIn,
  needRows,
  offeredInfra,
  offersFor,
  parseConfigLines,
  parseShared,
  fileProblems,
  isKeycloak,
  patchPassport,
  patchService,
  placementText,
  planItemText,
  planNotes,
  planAllRefusals,
  planWarnings,
  realmClientsText,
  withRealmFile,
  serviceFrom,
  sharedAllowed,
  sharedText,
  sourceText,
  unmetNeeds,
  unmetWithout,
  variableOf,
  withoutService,
  withService,
  type InfraRow,
  type LinkRow,
} from "./infra-services";
import type { PipelineTab } from "./pipeline";
import { INFRA_SOURCE_TEXT, infraStore, type InfraLoaded } from "./infra-store";
import { errText } from "./problem";
import { gearLabel } from "./product";
import { describedConfigs, gearConfigOf } from "./product-map";
import { InfoPopover, StatusChip } from "./ui-standard";

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
      infraStore(token, projectId)
        .load()
        .catch(() => ({ items: [] as InfraService[] })),
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
        const saved = await infraStore(token, projectId).save(next, null);
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
  const ingress = input.infra?.ingress ?? null;
  const [notes, setNotes] = useState(() =>
    Object.entries(ingress?.annotations ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join("\n"),
  );
  const setIngress = (patch: Partial<InfraIngress>) =>
    set("infra", {
      placement,
      shared: input.infra?.shared ?? [],
      ingress: { ...(ingress ?? {}), ...patch },
    });
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
                ? { placement: "shared", shared: parseShared(text), ingress }
                : { placement: "with_product", shared: [], ingress },
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
              set("infra", { placement: "shared", shared: parseShared(e.target.value), ingress });
            }}
            placeholder="keycloak @identity oidc.issuer=https://id.acme.example/realms/shop"
          />
          <span className="hint">
            One service per line: its name, where it runs (@namespace), and what it provides. Passwords go in the
            project&apos;s configuration secrets.
          </span>
        </label>
      )}
      {placement === "with_product" && (
        <div className="field" data-environment-infra-ingress>
          <span>Public address of a service (its Ingress)</span>
          <span className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <input
              value={ingress?.class ?? ""}
              onChange={(e) => setIngress({ class: e.target.value || null })}
              placeholder="ingress class (the preview one)"
              aria-label="Infra ingress class"
            />
            <input
              value={ingress?.tls_secret ?? ""}
              onChange={(e) => setIngress({ tls_secret: e.target.value || null })}
              placeholder="TLS secret (the controller's default)"
              aria-label="Infra TLS secret"
            />
          </span>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => {
              setNotes(e.target.value);
              const annotations: Record<string, string> = {};
              for (const line of e.target.value.split("\n")) {
                const at = line.indexOf("=");
                if (at > 0) annotations[line.slice(0, at).trim()] = line.slice(at + 1).trim();
              }
              setIngress({ annotations });
            }}
            placeholder="cert-manager.io/cluster-issuer=letsencrypt"
            aria-label="Infra ingress annotations"
          />
          <span className="hint">
            A service the project gives a public address gets an Ingress at that host and path, so the address
            answers. One annotation per line, <code>key=value</code>.
          </span>
        </div>
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
  const refusals = planAllRefusals(plan);
  const notes = planNotes(plan);
  const warnings = planWarnings(plan);
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
      {notes.length > 0 && (
        <ul className="hint" style={{ margin: "6px 0 0", paddingLeft: 18 }} data-infra-plan-notes>
          {notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="warn" style={{ margin: "6px 0 0", paddingLeft: 18 }} data-infra-plan-warnings>
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
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

/* ── Product › Infrastructure ─────────────────────────────────────────────── */

/** One place the product runs in, as `infrastructureOf`'s `runsIn` says it. */
export interface InfraPlace {
  environment: string;
  database: string;
  missing: string[];
}

/** What the product decides about a service: the publisher image (its
 *  version) and the passport's literal config. The rest is an environment's. */
type Editing = { service: string; what: "image" | "config" | "files" };

/** The product's infra services as one table, one row per thing that runs
 *  beside the gears: the environment's own Postgres while no service gives
 *  the database, then each service. A row opens to its image, its settings,
 *  its links to gear fields (Link writes `${VARIABLE}` into the product's
 *  gear config) and each environment. What an environment does -- placement,
 *  chart, secrets, its mirror copy -- is shown, not edited: Releases has it.
 *  Address & files edits the project's side of a service: its public
 *  address, the files its container reads (a Keycloak realm to import) and
 *  extra arguments. Every save writes the whole list through the store
 *  (infra-store.ts). */
export function ProductInfraServices({
  token,
  projectId,
  needs,
  places,
  environments,
  onOpenTab,
}: {
  token: string;
  projectId: string;
  /** The engine's needs for the profile shown; null before a check says. */
  needs: ProductTechnology[] | null;
  places: readonly InfraPlace[];
  environments: readonly DeployEnvironment[];
  /** Opens Releases, where an environment imports its copies. */
  onOpenTab?: (tab: PipelineTab) => void;
}) {
  const [services, setServices] = useState<InfraService[] | null>(null);
  const [kept, setKept] = useState<Omit<InfraLoaded, "items"> | null>(null);
  const [offered, setOffered] = useState<InfraPassport[]>([]);
  const [plans, setPlans] = useState<InfraPlan[]>([]);
  const [images, setImages] = useState<ProjectImage[]>([]);
  const [configs, setConfigs] = useState<{ record: GearConfig | undefined; described: Map<string, Record<string, unknown>> }>(
    () => ({ record: undefined, described: new Map() }),
  );
  const [readErr, setReadErr] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [adding, setAdding] = useState("");
  const [ask, confirmDialog] = useConfirm();
  const runs = environments.filter((e) => e.kind !== "research");
  const envIds = runs.map((e) => e.id).join(",");

  useEffect(() => {
    let live = true;
    Promise.all([
      infraStore(token, projectId).load(),
      api.listComponents(token, projectId).catch(() => ({ nodes: [] })),
      api.projectImages(token, projectId, { limit: 200 }).catch(() => ({ items: [] as ProjectImage[], total: 0 })),
      api.projectProduct(token, projectId).catch(() => null),
      api.productDescription(token, projectId).catch(() => null),
      Promise.all(
        envIds
          .split(",")
          .filter(Boolean)
          .map((id) => api.infraPlan(token, projectId, id).catch(() => null)),
      ),
    ])
      .then(([s, c, im, product, description, ps]) => {
        if (!live) return;
        setServices(s.items);
        setKept({ source: s.source, revision: s.revision });
        setOffered(offeredInfra(c.nodes ?? []));
        setImages(im.items);
        setConfigs({ record: product?.config, described: describedConfigs(description?.latest?.text ?? "") });
        setPlans(ps.filter((p): p is InfraPlan => !!p));
        setReadErr(null);
      })
      .catch((e) => live && setReadErr(errText(e)));
    return () => {
      live = false;
    };
  }, [token, projectId, envIds, round]);

  /** Write the whole list; the plans are read again, since they follow it. */
  const save = async (next: InfraService[], what: string): Promise<boolean> => {
    setBusy(what);
    setError(null);
    try {
      const saved = await infraStore(token, projectId).save(next, kept?.revision ?? null);
      setServices(saved.items);
      setKept({ source: saved.source, revision: saved.revision });
      setNote(what);
      setRound((r) => r + 1);
      return true;
    } catch (e) {
      setError(errText(e));
      return false;
    } finally {
      setBusy(null);
    }
  };

  if (readErr) return <p className="error">The infra services could not be read: {readErr}</p>;
  if (services === null) return <p className="muted">Reading the infra services…</p>;

  // A passport the catalogue does not list (any more) still counts: the
  // project's service can be chosen again after it was swapped out.
  const known = [...offered, ...services.map((s) => s.passport).filter((p) => !offered.some((o) => o.name === p.name))];
  const unmet = unmetNeeds(needRows(needs ?? [], services, known, plans, places));
  const offers = offersFor(known, services, needs);
  const links = linkRows(
    needs ?? [],
    services,
    (key) => gearConfigOf(key, configs.record, configs.described).values,
    gearKey,
  );
  const rows = infraRows(
    needs ?? [],
    services,
    plans,
    runs.map((e) => {
      const place = places.find((p) => p.environment === e.name);
      return { id: e.id, name: e.name, registry: e.registry, database: place?.database ?? "", missing: place?.missing ?? [] };
    }),
    links,
  );
  const releases = onOpenTab ? () => onOpenTab("releases") : undefined;
  const addOffer = offers.find((o) => o.passport.name === adding) ?? null;

  /** Add a catalogue service; one that gives what another gives takes its
   *  place, since two may not provide the same capability. */
  const add = (p: InfraPassport) => {
    const run = () => {
      const { next, dropped } = withService(services, p);
      return save(next, dropped.length ? `${p.name} added in place of ${dropped.join(", ")}` : `${p.name} added`);
    };
    const { dropped } = withService(services, p);
    if (dropped.length === 0) return run();
    ask(
      {
        title: `Use ${p.name} in place of ${dropped.join(", ")}?`,
        body: <p>Two services may not give the same capability, so {dropped.join(", ")} leaves the product with its settings.</p>,
        confirmLabel: `Use ${p.name}`,
      },
      run,
    );
    return Promise.resolve(false);
  };

  /** Link a gear field to a capability: the field reads `${VARIABLE}` in
   *  the product's configuration of the gear (product.gdl at the next save). */
  const link = async (l: LinkRow) => {
    if (!l.gear || !l.field) return;
    const key = gearKey(l.gear);
    setBusy(`link ${l.field}`);
    setError(null);
    try {
      const fresh = await api.projectProduct(token, projectId);
      const record = { ...(fresh?.config ?? {}) };
      const own = Object.keys(record).find((g) => gearKey(g) === key) ?? key;
      // The gear's whole config as the product has it, so a field only the
      // saved product.gdl held is not lost when the record takes it over.
      const current = gearConfigOf(key, record, configs.described).values;
      record[own] = linkedConfig(current, l.field, l.variable);
      await api.saveProjectProduct(token, projectId, { config: record });
      setNote(`${gearLabel(l.gear)} reads ${l.field} from ${l.capability}: save the product to put it in product.gdl.`);
      setRound((r) => r + 1);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: "grid", gap: 8 }} data-infra-editor>
      {unmet.length > 0 && (
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }} data-infra-unmet>
          {unmet.map(({ need, offer }) => (
            <span key={need.id} className="row" style={{ gap: 6, alignItems: "center" }} data-infra-unmet-need={need.id}>
              <StatusChip tone="warn">{need.name} has no provider</StatusChip>
              {offer ? (
                <button type="button" disabled={!!busy} onClick={() => void add(offer)} data-infra-add-offer={offer.name}>
                  Add {offer.name}
                </button>
              ) : (
                <span className="muted">the catalogue has none</span>
              )}
            </span>
          ))}
        </div>
      )}
      <DataTable<InfraRow>
        list="infra-services"
        urlPrefix="infra."
        title={
          <span>
            Runs beside the gears{" "}
            <InfoPopover label="About the product's infra services">
              <p>
                What the gears need running beside them -- a database, a sign-in provider -- and the service that gives
                it. A gear field reads what a service gives by name: Link makes the field read{" "}
                <code>{"${OIDC_ISSUER}"}</code> in the product&apos;s configuration.
              </p>
              <p>
                The product chooses the services, their image and settings. Each environment places them, gives them a
                public address and secrets, and keeps its own copy of the image: that is in Releases.
              </p>
              {kept && <p data-infra-source={kept.source}>{INFRA_SOURCE_TEXT[kept.source]}</p>}
            </InfoPopover>
          </span>
        }
        rows={rows}
        rowKey={(r) => r.id}
        rowLabel={(r) => r.name}
        expandOnClick
        primary={
          offers.length > 0 && (
            <span className="row" style={{ gap: 6, alignItems: "center" }} data-infra-add>
              <select
                aria-label="A service from the catalogue"
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                disabled={!!busy}
              >
                <option value="">Add a service…</option>
                {offers.map((o) => (
                  <option key={o.passport.name} value={o.passport.name}>
                    {o.passport.name}
                    {o.passport.version ? ` ${o.passport.version}` : ""}
                    {o.meets.length ? ` — ${o.meets.join(", ")}` : ""}
                    {o.replaces.length ? ` (in place of ${o.replaces.join(", ")})` : ""}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="primary"
                disabled={!addOffer || !!busy}
                onClick={() => {
                  if (addOffer) void add(addOffer.passport).then((ok) => ok && setAdding(""));
                }}
              >
                Add
              </button>
            </span>
          )
        }
        empty={{
          title: needs === null ? "What the gears need is not known yet." : "Nothing runs beside the gears.",
          body:
            needs === null
              ? "It shows once the product is checked for the profile an environment runs: open Backend."
              : undefined,
        }}
        columns={[
          {
            id: "service",
            header: "Service",
            cell: (r) => (
              <span data-infra-row={r.id}>
                <b>{r.name}</b>
                {r.version ? ` ${r.version}` : ""}
                {r.description && (
                  <div className="sub" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 320 }} title={r.description}>
                    {r.description}
                  </div>
                )}
              </span>
            ),
          },
          {
            id: "gives",
            header: "Gives the gears",
            cell: (r) => (
              <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                {r.gives.map((g) => (
                  <StatusChip key={g} tone="neutral">
                    {g}
                  </StatusChip>
                ))}
              </span>
            ),
          },
          {
            id: "used",
            header: "Used by",
            cell: (r) =>
              r.usedBy.length === 0 ? (
                <span className="muted">no gear</span>
              ) : r.usedBy.length > 3 ? (
                <StatusChip tone="neutral" title={r.usedBy.map(gearLabel).join(", ")}>
                  {r.usedBy.length} gears
                </StatusChip>
              ) : (
                <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                  {r.usedBy.map((g) => (
                    <StatusChip key={g} tone="neutral">
                      {gearLabel(g)}
                    </StatusChip>
                  ))}
                </span>
              ),
          },
          {
            id: "environments",
            header: "Environments",
            cell: (r) =>
              r.envs.length === 0 ? (
                <span className="muted">none yet</span>
              ) : (
                <span className="row" style={{ gap: 4, flexWrap: "wrap" }}>
                  {r.envs.map((e) => (
                    <StatusChip key={e.environment} tone={e.tone} title={e.detail} data-infra-env={e.environment} data-infra-env-tone={e.tone}>
                      {e.text}
                    </StatusChip>
                  ))}
                </span>
              ),
          },
        ]}
        actions={(r) => {
          const s = r.service;
          if (!s) return [];
          const gone = unmetWithout(needs, services, s.passport.name);
          return [
            { label: "Change image…", onSelect: () => setEditing({ service: s.passport.name, what: "image" }) },
            { label: "Settings…", onSelect: () => setEditing({ service: s.passport.name, what: "config" }) },
            { label: "Address & files…", onSelect: () => setEditing({ service: s.passport.name, what: "files" }) },
            {
              label: "Remove",
              disabled: !!busy,
              onSelect: async () => {
                if (!(await save(withoutService(services, s.passport.name), `${s.passport.name} removed`)))
                  throw new Error(`${s.passport.name} could not be removed`);
              },
              danger: {
                title: `Remove ${s.passport.name} from the product?`,
                body: (
                  <p>
                    {gone.length === 0
                      ? "No need of the gears depends on it."
                      : `${gone.map((n) => n.name).join(", ")} then ${gone.length === 1 ? "has" : "have"} no provider${
                          gone.some((n) => n.id === "postgres") ? " (the database falls back to the environment's own Postgres)" : ""
                        }.`}{" "}
                    What already runs in an environment stays there until it is uninstalled.
                  </p>
                ),
                confirmLabel: "Remove",
              },
            },
          ];
        }}
        expand={(r) => (
          <RowDetail
            row={r}
            images={images}
            environments={runs}
            busy={!!busy}
            onLink={(l) => void link(l)}
            onReleases={releases}
          />
        )}
        detail={(r) =>
          r.service && editing?.service === r.id && editing.what === "files" ? (
            <FilesEditor
              key={`${r.id}:files`}
              service={r.service}
              loadRealm={(portal) => api.keycloakRealm(token, projectId, r.id, portal)}
              busy={!!busy}
              onSave={async (patch, what) => {
                if (await save(patchService(services, r.id, patch), what)) setEditing(null);
              }}
              onClose={() => setEditing(null)}
            />
          ) : r.service && editing?.service === r.id ? (
            <ServiceEditor
              key={`${r.id}:${editing.what}`}
              service={r.service}
              catalogue={offered.find((o) => o.name === r.id) ?? null}
              what={editing.what}
              busy={!!busy}
              onSave={async (patch, what) => {
                if (await save(patchPassport(services, r.id, patch), what)) setEditing(null);
              }}
              onClose={() => setEditing(null)}
            />
          ) : null
        }
      />
      {note && <p className="hint">{note}</p>}
      {error && <p className="error">{error}</p>}
      {confirmDialog}
    </div>
  );
}

const LINK_STATE: Record<LinkRow["state"], string> = {
  reference: "linked ✓",
  literal: "set by hand",
  unset: "not set",
  database: "wired by the database step ✓",
  unknown: "which field reads it is not known",
};

/** A row opened: its image and settings, its links to gear fields, and
 *  each environment in a line. */
function RowDetail({
  row: r,
  images,
  environments,
  busy,
  onLink,
  onReleases,
}: {
  row: InfraRow;
  images: readonly ProjectImage[];
  environments: readonly DeployEnvironment[];
  busy: boolean;
  onLink: (l: LinkRow) => void;
  onReleases?: () => void;
}) {
  const s = r.service;
  const config = Object.entries(s?.passport.config ?? {});
  return (
    <div style={{ display: "grid", gap: 6, fontSize: 13 }} data-infra-detail={r.id}>
      {s && (
        <div>
          <b>Image</b> <code style={{ overflowWrap: "anywhere" }}>{s.passport.image ?? "none"}</code>
          <div className="sub">not locked yet: the product lock pins its digest</div>
        </div>
      )}
      {s && (
        <div>
          <b>Settings</b>{" "}
          {config.length === 0 ? (
            <span className="muted">none</span>
          ) : (
            <span className="sub">{config.map(([k, v]) => `${k}=${v}`).join(" · ")}</span>
          )}
        </div>
      )}
      {r.links.length > 0 && (
        <div>
          <b>Links</b>
          <ul style={{ margin: "2px 0 0", paddingLeft: 18 }}>
            {r.links.map((l) => (
              <li key={`${l.capability}:${l.field ?? ""}`} data-infra-link={`${l.capability}:${l.field ?? ""}`} data-infra-link-state={l.state}>
                {l.gears.length > 3 ? `${l.gears.length} gears` : l.gears.map(gearLabel).join(", ")}
                {l.field && (
                  <>
                    {" · "}
                    <code>{l.field}</code>
                  </>
                )}{" "}
                ← <code>{l.capability}</code>{" "}
                <span className={l.state === "reference" || l.state === "database" ? undefined : "muted"}>
                  [{LINK_STATE[l.state]}
                  {l.state === "literal" && l.value ? `: ${l.value}` : ""}]
                </span>
                {l.field && (l.state === "literal" || l.state === "unset") && (
                  <>
                    {" "}
                    <button type="button" className="ghost" disabled={busy} onClick={() => onLink(l)}>
                      Link
                    </button>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {environments.map((e) => {
        const pill = r.envs.find((p) => p.environment === e.name);
        const copy = s ? mirrorIn([...images], s.passport.image, e.registry) : null;
        return (
          <div key={e.id} className="sub" data-infra-detail-env={e.name}>
            <b>{e.name}</b>: {pill?.detail ?? "—"}
            {s && (e.registry ? (copy ? " · its copy is in the registry" : " · no copy of this image in its registry") : "")}
            {s?.public_url && ` · public at ${s.public_url}`}
            {s?.files && Object.keys(s.files).length > 0 && ` · ${Object.keys(s.files).length} file(s) mounted`}
            {s?.chart_ref && ` · ready chart ${s.chart_ref}`}
            {onReleases && (
              <>
                {" "}
                <button type="button" className="linklike" onClick={onReleases}>
                  Releases →
                </button>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** One service's product-level settings, under its row: which publisher
 *  image (and so version) it runs, and its passport's literal config. */
function ServiceEditor({
  service: s,
  catalogue,
  what,
  busy,
  onSave,
  onClose,
}: {
  service: InfraService;
  /** The catalogue's passport of the same name: what the publisher names. */
  catalogue: InfraPassport | null;
  what: Editing["what"];
  busy: boolean;
  onSave: (patch: Partial<InfraPassport>, what: string) => Promise<void>;
  onClose: () => void;
}) {
  const p = s.passport;
  const [image, setImage] = useState(p.image ?? "");
  const [text, setText] = useState(() => configLines(p.config));
  const parsed = parseConfigLines(text, p.secrets);
  const cancel = (
    <button type="button" className="ghost" onClick={onClose}>
      Cancel
    </button>
  );
  const tag = (ref: string) => ref.match(/:([^/:@]+)(@|$)/)?.[1] ?? null;
  return (
    <div style={{ display: "grid", gap: 8, padding: "8px 0" }} data-infra-editor-panel={`${p.name}:${what}`}>
      {what === "image" ? (
        <>
          <label className="field">
            {p.name}&apos;s image, as its publisher names it
            <input
              value={image}
              onChange={(e) => setImage(e.target.value)}
              placeholder={catalogue?.image ?? "quay.io/keycloak/keycloak:26.0.7"}
              aria-label="Publisher image"
            />
            <span className="hint">
              {catalogue?.image && catalogue.image !== image.trim() ? `The catalogue names ${catalogue.image}. ` : ""}
              Another tag is another version; each environment then needs its own copy of it (Releases › Images).
            </span>
          </label>
          <span className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="primary"
              disabled={busy || !image.trim() || image.trim() === (p.image ?? "")}
              onClick={() => {
                const v = tag(image.trim());
                void onSave({ image: image.trim(), ...(v ? { version: v } : {}) }, `${p.name} is ${image.trim()}`);
              }}
            >
              Save
            </button>
            {catalogue?.image && catalogue.image !== (p.image ?? "") && (
              <button type="button" className="ghost" onClick={() => setImage(catalogue.image ?? "")}>
                The catalogue&apos;s
              </button>
            )}
            {cancel}
          </span>
        </>
      ) : (
        <>
          <label className="field">
            {p.name}&apos;s settings
            <textarea
              rows={Math.max(3, Object.keys(p.config).length + 1)}
              value={text}
              onChange={(e) => setText(e.target.value)}
              aria-label="Service settings"
            />
            <span className="hint">
              One <code>KEY=value</code> per line, given to its container as is. Secrets (
              {p.secrets.join(", ") || "none"}) are each environment&apos;s.
            </span>
          </label>
          {parsed.problems.map((m) => (
            <span key={m} className="env-field-error">
              {m}
            </span>
          ))}
          <span className="row" style={{ gap: 6 }}>
            <button
              type="button"
              className="primary"
              disabled={busy || parsed.problems.length > 0 || text === configLines(p.config)}
              onClick={() => void onSave({ config: parsed.config }, `${p.name}'s settings saved`)}
            >
              Save
            </button>
            {catalogue && configLines(catalogue.config) !== text && (
              <button type="button" className="ghost" onClick={() => setText(configLines(catalogue.config))}>
                The catalogue&apos;s
              </button>
            )}
            {cancel}
          </span>
        </>
      )}
    </div>
  );
}

/** One service's project side: where people reach it, the files its
 *  container reads (path + content), and arguments after the passport's.
 *  A Keycloak gets a one-click realm to import. */
function FilesEditor({
  service: s,
  loadRealm,
  busy,
  onSave,
  onClose,
}: {
  service: InfraService;
  /** The realm the server makes for this service (a Keycloak). */
  loadRealm: (portal: string) => Promise<KeycloakRealm>;
  busy: boolean;
  onSave: (patch: Pick<InfraService, "public_url" | "files" | "args">, what: string) => Promise<void>;
  onClose: () => void;
}) {
  const p = s.passport;
  const [url, setUrl] = useState(s.public_url ?? "");
  const [rows, setRows] = useState<{ path: string; content: string }[]>(() =>
    Object.entries(s.files ?? {}).map(([path, content]) => ({ path, content })),
  );
  const [argsText, setArgsText] = useState((s.args ?? []).join("\n"));
  const [portal, setPortal] = useState("");
  const files = Object.fromEntries(rows.filter((r) => r.path.trim()).map((r) => [r.path.trim(), r.content]));
  const args = argsText
    .split("\n")
    .map((a) => a.trim())
    .filter(Boolean);
  const problems = [
    ...fileProblems(files),
    ...(new Set(rows.map((r) => r.path.trim())).size < rows.length ? ["two files have the same path"] : []),
    ...(url.trim() && !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(url.trim()) ? [`"${url.trim()}" is not an address (https://…)`] : []),
  ];
  const usesUrl = Object.values(p.provides).some((t) => t.includes("{public_url}"));
  const keycloak = isKeycloak(p);
  const [realm, setRealm] = useState<KeycloakRealm | null>(null);
  const [realmError, setRealmError] = useState<string | null>(null);
  const addRealm = async () => {
    setRealmError(null);
    try {
      const made = await loadRealm(portal);
      const next = withRealmFile({ files, args }, made);
      setRealm(made);
      setRows(Object.entries(next.files).map(([path, content]) => ({ path, content })));
      setArgsText(next.args.join("\n"));
    } catch (e) {
      setRealmError(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <div style={{ display: "grid", gap: 8, padding: "8px 0" }} data-infra-editor-panel={`${p.name}:files`}>
      <label className="field">
        Public address
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder={`https://${p.name}.example.com`}
          aria-label="Public address"
          data-infra-public-url
        />
        <span className="hint">
          Where a browser reaches {p.name}: <code>{"{public_url}"}</code>.{" "}
          {usesUrl && "What it gives the product says it, so a deploy is refused without one. "}
          Placed with the product, its chart routes this address to it with an Ingress.
        </span>
      </label>
      <div className="field">
        <span>
          <b>Files</b> <span className="sub">mounted read-only in its container</span>
        </span>
        {rows.length === 0 && <span className="muted">none</span>}
        {rows.map((r, n) => (
          <div key={n} style={{ display: "grid", gap: 4 }} data-infra-file={r.path}>
            <span className="row" style={{ gap: 6 }}>
              <input
                value={r.path}
                onChange={(e) => setRows(rows.map((x, i) => (i === n ? { ...x, path: e.target.value } : x)))}
                placeholder="/etc/app/config.json"
                aria-label="File path"
                style={{ flex: 1 }}
              />
              <button type="button" className="ghost" onClick={() => setRows(rows.filter((_, i) => i !== n))}>
                Remove
              </button>
            </span>
            <textarea
              rows={Math.min(16, Math.max(4, r.content.split("\n").length))}
              value={r.content}
              onChange={(e) => setRows(rows.map((x, i) => (i === n ? { ...x, content: e.target.value } : x)))}
              aria-label={`Content of ${r.path || "the file"}`}
              style={{ fontFamily: "monospace", fontSize: 12 }}
            />
          </div>
        ))}
        <span className="row" style={{ gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          <button type="button" className="ghost" onClick={() => setRows([...rows, { path: "", content: "" }])}>
            Add file
          </button>
          {keycloak && (
            <>
              <input
                value={portal}
                onChange={(e) => setPortal(e.target.value)}
                placeholder="https://shop.example.com (the portal)"
                aria-label="The product's portal address"
              />
              <button type="button" onClick={() => void addRealm()} data-infra-keycloak-realm>
                Keycloak realm
              </button>
            </>
          )}
        </span>
        <span className="hint">
          Text may say <code>{"{secret.KEY}"}</code>, <code>{"{host}"}</code>, <code>{"{public_url}"}</code> and{" "}
          <code>{"{namespace}"}</code>, filled at deploy; with a secret the files are kept in a Secret. A ready chart
          does not apply them.
          {keycloak &&
            !realm &&
            " The Keycloak realm is made by the server from the product description: a client for the portal, the backend, and each gear that signs in with client credentials."}
          {realm &&
            ` The realm imports ${realm.path} with clients ${realmClientsText(realm)}; every confidential client's tokens carry tenant_id ${realm.root_tenant_id} (${realm.root_tenant_from === "description" ? "account-management's bootstrap.root_id" : "the platform's root tenant"}). {env.KEY} is the environment's configuration secret KEY, made once when none is set.`}
        </span>
        {realm?.notes.map((n) => (
          <span key={n} className="env-field-error" data-infra-realm-note>
            {n}
          </span>
        ))}
        {realmError && <span className="env-field-error">The realm could not be made: {realmError}</span>}
      </div>
      <label className="field">
        More arguments
        <textarea rows={2} value={argsText} onChange={(e) => setArgsText(e.target.value)} aria-label="More arguments" />
        <span className="hint">
          One per line, after the passport&apos;s ({p.args.join(" ") || "none"}).
        </span>
      </label>
      {problems.map((m) => (
        <span key={m} className="env-field-error">
          {m}
        </span>
      ))}
      <span className="row" style={{ gap: 6 }}>
        <button
          type="button"
          className="primary"
          disabled={busy || problems.length > 0}
          onClick={() =>
            void onSave({ public_url: url.trim() || null, files, args }, `${p.name}'s address and files saved`)
          }
        >
          Save
        </button>
        <button type="button" className="ghost" onClick={onClose}>
          Cancel
        </button>
      </span>
    </div>
  );
}

