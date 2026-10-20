/* The project's Components tab: what the project is made of (project-inventory.ts)
 * — taken from the platform and the organization, its own, its code that could
 * become a gear, the services that are not gears, and the gears its documents
 * ask for that nobody has written — with a gear scaffolded from the specs for
 * the last. */
import { useEffect, useMemo, useRef, useState } from "react";

import { api, type Conformance, type PlanRow } from "./api";
import { capabilityEntities, keptSentences, suggestedCategory } from "./capability-entities";
import { ProjectCandidate } from "./component-registry";
import { layerOf } from "./domain-layers";
import { entityGears, gearRefs } from "./entity-gears";
import { gearDeployState, type ProductAt } from "./gear-deploys-model";
import { useGearCatalogue, useRunning } from "./product-configurator-view";
import { DataTable } from "./data-table";
import { ScaffoldModal } from "./documents";
import { errText } from "./format";
import { usePortalNav } from "./portal-nav";
import { inventory, ownGearsOf, ROLE_LABEL, type InventoryRole, type InventoryRow, type OwnGear } from "./project-inventory";
import type { ProjectComponent } from "./project-checks";
import { gearProblem, rowCoverage } from "./spec-coverage";
import { entitiesOf, type Entity, type GlossaryEntry } from "./spec-model";

interface Read {
  plan: PlanRow[];
  code: Conformance | null;
  picks: string[];
  /** The product's last commit and change, which its deploys are read against. */
  productAt: ProductAt;
  services: ProjectComponent[];
  /** The gears the project's own code declares, from the registry. */
  own: OwnGear[];
  /** What could not be read, each in a sentence; the rest still shows. */
  partial: string[];
}

export function ProjectComponentsInventory({
  token,
  projectId,
  workspaceId,
  onOpenProduct,
}: {
  token: string;
  projectId: string;
  workspaceId: string;
  /** The Product tab, where a component goes into the product. */
  onOpenProduct?: () => void;
}) {
  const [read, setRead] = useState<Read | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scaffold, setScaffold] = useState<PlanRow | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  /** The Domain model's entities, read when a gear is first asked for: what
   *  the new gear keeps. Null while unread; empty when it cannot be read. */
  const [entities, setEntities] = useState<Entity[] | null>(null);
  const nav = usePortalNav();
  const asking = useRef(projectId);

  useEffect(() => setEntities(null), [projectId]);
  useEffect(() => {
    if (!scaffold || entities) return;
    let live = true;
    Promise.all([
      api.specModel(token, projectId),
      // A backend from before the glossary answers 404: the model still reads.
      api.glossary(token, projectId).catch(() => ({ items: [] as GlossaryEntry[], total: 0 })),
    ])
      .then(([model, glossary]) => live && setEntities(entitiesOf(model.facts, glossary.items)))
      // No model yet: the gear is asked for from the capability alone.
      .catch(() => live && setEntities([]));
    return () => {
      live = false;
    };
  }, [scaffold, entities, token, projectId]);
  // The catalogue says which subsystem the new gear most likely joins; a
  // catalogue that cannot be read leaves the choice to the server's default.
  // It also gives the product's gears their maturity, read against where they run.
  const catalogue = useGearCatalogue(token, !!scaffold || (read?.picks.length ?? 0) > 0, projectId);
  const running = useRunning(token, projectId);
  const index = catalogue && "index" in catalogue ? catalogue.index : null;
  const draft = useMemo(() => {
    if (!scaffold || !entities || !catalogue) return null;
    const kept = capabilityEntities(scaffold, entities);
    const domain = entities.filter((e) => layerOf(e) === "domain");
    const keepers = index ? entityGears(domain, gearRefs(index)).byEntity : new Map();
    const suggested = suggestedCategory(scaffold, kept.entities, entities, index, (keys) => keys.map((k) => keepers.get(k)?.gear.id ?? null));
    const categories = [...new Set((index?.gears ?? []).map((g) => g.category?.trim() ?? "").filter((c) => c && c !== "example"))].sort();
    return { kept, suggested, categories };
  }, [scaffold, entities, catalogue, index]);
  const kept = draft?.kept ?? null;

  const load = async () => {
    const forProject = projectId;
    asking.current = forProject;
    setError(null);
    const partial: string[] = [];
    try {
      const [plan, product, services, code, registry] = await Promise.all([
        api.projectPlan(token, forProject),
        api.projectProduct(token, forProject).catch(() => {
          partial.push("the product could not be read");
          return null;
        }),
        api.projectComponents(token, forProject).catch(() => {
          partial.push("the repositories' services could not be read");
          return null;
        }),
        Promise.all([api.declaredCapabilities(token, forProject), api.capabilities(token, workspaceId)])
          .then(([declared, vocab]) => api.conformance(token, forProject, declared.items.map((c) => c.key), vocab.items ?? []))
          .catch(() => {
            partial.push("the code could not be read");
            return null;
          }),
        // Every gear the project's code declares, whether a capability offers
        // it or not; the plan only names the ones its documents ask for.
        api.componentRegistry(token, { project_id: forProject }).catch(() => {
          partial.push("the project's own gears could not be read");
          return null;
        }),
      ]);
      if (asking.current !== forProject) return;
      setRead({
        plan: plan.items,
        code,
        picks: product?.gears ?? [],
        productAt: { commit: product?.written?.commit_sha, updatedAt: product?.updated_at },
        services: services?.items ?? [],
        own: ownGearsOf(registry?.items ?? [], forProject),
        partial,
      });
    } catch (e) {
      if (asking.current === forProject) setError(errText(e));
    }
  };
  useEffect(() => {
    setRead(null);
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, projectId]);

  const rows = useMemo(() => {
    if (!read) return null;
    const needsGear = (row: PlanRow) =>
      !row.nonfunctional &&
      !!(row.gap || row.unbuilt || (rowCoverage(row, read.picks).cover === "open" && !row.candidates.some((c) => c.built === "built")));
    return inventory(read.plan, read.code, read.picks, read.services, needsGear, read.own);
  }, [read]);
  const n = (role: InventoryRole) => rows?.filter((r) => r.role === role).length ?? 0;
  const roles: InventoryRole[] = ["ours", "could", "create", "organization", "platform", "service"];

  return (
    <section className="pcomp">
      <p className="dm-howto">
        <b>What this project is made of.</b> The components it takes from the platform and the organization, its own
        gears, its code that could become one, the services that are not gears — and the gears its documents ask for
        that nobody has written yet, to create from the specs.
      </p>
      {read && read.partial.length > 0 && <p className="hint">Not everything could be read: {read.partial.join("; ")}.</p>}
      <div className="card">
        <DataTable<InventoryRow>
          list="project-components"
          urlPrefix="pc."
          rows={rows}
          error={error}
          onRetry={() => void load()}
          rowKey={(r) => r.key}
          rowLabel={(r) => r.name}
          pageSize={25}
          search={{ placeholder: "Find a component or a capability" }}
          searchText={(r) => [r.name, r.kind, r.path, ...r.answers]}
          empty={{ title: "Nothing found in this project yet.", body: "Connect its repositories on Sources and type its documents on Specs." }}
          filters={[
            {
              id: "role",
              allLabel: "Everything",
              kind: "chips",
              options: roles.filter((r) => n(r) > 0).map((r) => ({ value: r, label: ROLE_LABEL[r] })),
              match: (r, v) => r.role === v,
            },
          ]}
          columns={[
            {
              id: "name",
              header: "Component",
              compare: (a, b) => a.name.localeCompare(b.name),
              cell: (r) => (
                <span>
                  <b>{r.name}</b> <span className="sub">{r.kind}</span>
                  {r.path && <div className="sub">{r.path}</div>}
                </span>
              ),
            },
            { id: "role", header: "Whose", cell: (r) => <span className={`dm-pill pcomp-${r.role}`}>{ROLE_LABEL[r.role]}</span> },
            {
              id: "answers",
              header: "Answers",
              cell: (r) => (r.answers.length ? <code className="sub">{r.answers.join(", ")}</code> : <span className="sub">—</span>),
            },
            { id: "product", header: "In the product", cell: (r) => (r.inProduct ? "✓" : <span className="sub">—</span>) },
            {
              id: "runs",
              header: "Runs",
              cell: (r) => {
                // Only what the product carries is deployed with it.
                const s = r.inProduct && read ? gearDeployState({ name: r.name, maturity: index?.find(r.name)?.maturity }, running, read.productAt) : null;
                if (!s) return <span className="sub">—</span>;
                return (
                  <span className="sub" data-runs={s.runs.length > 0 ? "yes" : "no"} title={s.hint ?? s.line}>
                    {s.hint && <span style={{ color: "var(--destructive)" }}>⚠ </span>}
                    {s.runs.length > 0 ? s.runs.map((x) => x.environment).join(", ") : "not deployed"}
                  </span>
                );
              },
            },
            { id: "code", header: "In the code", cell: (r) => (r.inCode ? "✓" : <span className="sub">—</span>) },
            {
              id: "state",
              header: "State",
              cell: (r) =>
                r.service ? (
                  <span className="sub">{r.service.readiness === "ready" ? "ready to take" : r.service.readiness === "caution" ? "ask first" : "not ready"}</span>
                ) : r.role === "create" ? (
                  <span className="sub">{r.need?.gap ? "nothing in the catalogue" : "nothing built answers it"}</span>
                ) : r.candidate?.built === "docs-only" ? (
                  <span className="sub">docs only</span>
                ) : r.candidate?.registry_state ? (
                  <span className="sub">{r.candidate.registry_state}</span>
                ) : (
                  <span className="sub">built</span>
                ),
            },
          ]}
          inline={(r) =>
            r.role === "create" && r.need ? (
              <button type="button" className="primary" disabled={scaffold === r.need && !kept} onClick={() => setScaffold(r.need!)}>
                {scaffold === r.need && !kept ? "Reading the Domain model…" : "Create a gear…"}
              </button>
            ) : null
          }
          actions={(r) => [
            ...((r.role === "platform" || r.role === "organization") && nav ? [{ label: "Open in the catalogue", onSelect: () => nav.openComponent(r.name) }] : []),
            ...(r.role === "could" ? [{ label: opened === r.key ? "Hide" : "Make it a gear…", onSelect: () => setOpened(opened === r.key ? null : r.key) }] : []),
            ...(r.role !== "service" && r.role !== "create" && !r.inProduct && onOpenProduct ? [{ label: "Put it into the product…", onSelect: onOpenProduct }] : []),
          ]}
          detail={(r) => (opened === r.key && r.role === "could" ? <ProjectCandidate token={token} name={r.name} projectId={projectId} /> : null)}
          expand={(r) =>
            r.service ? (
              <div className="sub">
                {r.service.reasons.join(" · ") || "Nothing stands in the way."}
                {r.service.owners.length > 0 && <div>Owners: {r.service.owners.join(", ")}</div>}
              </div>
            ) : r.need ? (
              <div className="sub">{gearProblem(r.need)}</div>
            ) : r.answers.length ? (
              <div className="sub">Answers {r.answers.join(", ")} by its contract, its declaration or a member&apos;s confirmation.</div>
            ) : (
              <div className="sub">Taken by the {r.inProduct ? "product" : "code"}; no capability the specs declare asks for it.</div>
            )
          }
        />
      </div>
      {/* Opened once the Domain model is read, so the draft it starts with is the whole one. */}
      {scaffold && draft && kept && (
        <ScaffoldModal
          capability={scaffold.capability}
          token={token}
          projectTenantId={projectId}
          problem={[gearProblem(scaffold), keptSentences(kept)].filter(Boolean).join(" ")}
          declares={[scaffold.capability]}
          editable
          category={draft.suggested?.category}
          categories={draft.categories}
          lead={[
            kept.entities.length
              ? `From the Domain model it keeps ${kept.entities.map((e) => e.name).join(", ")}${
                  kept.requirements.length ? ` and answers ${kept.requirements.length} of its requirements` : ""
                }. Change what it is for before the push if the model read it wrong.`
              : "The Domain model names no entity of this capability: the gear starts from the specs' words alone.",
            draft.suggested ? `Its subsystem is proposed from ${draft.suggested.why}.` : "",
          ]
            .filter(Boolean)
            .join(" ")}
          onClose={() => {
            setScaffold(null);
            void load();
          }}
        />
      )}
    </section>
  );
}
