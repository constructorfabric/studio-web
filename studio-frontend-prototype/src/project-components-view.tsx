/* The project's Components tab: what the project is made of (project-inventory.ts)
 * — taken from the platform and the organization, its own, its code that could
 * become a gear, the services that are not gears, and the gears its documents
 * ask for that nobody has written — with a gear scaffolded from the specs for
 * the last. */
import { useEffect, useMemo, useRef, useState } from "react";

import { api, type Conformance, type PlanRow } from "./api";
import { ProjectCandidate } from "./component-registry";
import { DataTable } from "./data-table";
import { ScaffoldModal } from "./documents";
import { errText } from "./format";
import { usePortalNav } from "./portal-nav";
import { inventory, ownGearsOf, ROLE_LABEL, type InventoryRole, type InventoryRow, type OwnGear } from "./project-inventory";
import type { ProjectComponent } from "./project-checks";
import { gearProblem, rowCoverage } from "./spec-coverage";

interface Read {
  plan: PlanRow[];
  code: Conformance | null;
  picks: string[];
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
  const nav = usePortalNav();
  const asking = useRef(projectId);

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
              <button type="button" className="primary" onClick={() => setScaffold(r.need!)}>
                Create a gear…
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
      {scaffold && (
        <ScaffoldModal
          capability={scaffold.capability}
          token={token}
          projectTenantId={projectId}
          problem={gearProblem(scaffold)}
          declares={[scaffold.capability]}
          onClose={() => {
            setScaffold(null);
            void load();
          }}
        />
      )}
    </section>
  );
}
