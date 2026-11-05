/* The Product tab (product-sections.ts): one page for the one product. A
 * PageHeader names it with a verdict (resolves, or how many errors), where its
 * description is kept, and one action that follows the state (Show the fixes,
 * Save to product.gdl, Build); the strip from configured to running; then
 * tabs for its parts, each with a dot for where it stands. Only the chosen
 * part is drawn below them:
 *
 *   Map              the whole product in one picture (the default)
 *   Infrastructure   what the gears need and the infra services that meet it,
 *                    editable (ADR-0064); the environments it runs in, as
 *                    chips that open Releases (ADR-0056 §3)
 *   Backend          the gears (the existing `ProjectKits` journey, passed in
 *                    by the shell, kept mounted so its panes keep their state)
 *   Frontend         the frontend constructor, or "Add a frontend"
 */

import { ProductSources } from "./source-roles-view";
import { useEffect, useState, type ReactNode } from "react";

import {
  PRODUCT_CHANGED_EVENT,
  api,
  type DeployEnvironment,
  type FrontendPick,
  type ProjectConfig,
  type ProjectProduct,
  type ProjectTargets,
} from "./api";
import { FrontendConstructor, useFrontxDefaults } from "./frontend-constructor-view";
import { ProductInfraServices } from "./infra-services-view";
import type { PipelineTab } from "./pipeline";
import type { FlowState, FlowStep } from "./product-flow";
import { ProductFlow } from "./product-flow-view";
import { ProductKindStep } from "./product-kind-view";
import { ProductMap } from "./product-map-view";
import {
  PRODUCT_ACTION_LABEL,
  PRODUCT_COMMAND_EVENT,
  PRODUCT_NEXT_EVENT,
  PRODUCT_SECTIONS,
  announcedNext,
  hasFrontend,
  productHeader,
  type ProductAction,
  infrastructureOf,
  openingSection,
  productSummary,
  sectionFromPath,
  newFrontend,
  withoutFrontend,
  type Infrastructure,
  type ProductSectionId,
  type ProductSummary,
} from "./product-sections";
import { errText } from "./problem";
import { verdictText } from "./product";
import { EmptyState, PageHeader, StatusChip } from "./ui-standard";

/** The section an old address asked for (`/…/frontend`), read once when the
 *  page loaded: the shell rewrites the address to Product's straight after. */
let landing: ProductSectionId | null = typeof window !== "undefined" ? sectionFromPath(window.location.pathname) : null;

/** The section this member last looked at for the project; storage may be
 *  missing or refuse, which is only a convenience lost. */
const sectionKey = (projectId: string) => `studio.product.section.${projectId}`;
function storedSection(projectId: string): string | null {
  try {
    return window.localStorage.getItem(sectionKey(projectId));
  } catch {
    return null;
  }
}
function storeSection(projectId: string, id: ProductSectionId) {
  try {
    window.localStorage.setItem(sectionKey(projectId), id);
  } catch {
    // Not remembered; the page still works.
  }
}

/** A part's state as its tab's dot. */
const DOT: Record<FlowState, "ok" | "warn" | "danger" | "neutral"> = {
  done: "ok",
  todo: "warn",
  failed: "danger",
  unknown: "neutral",
  none: "neutral",
};

/** The Product tab: the header, the strip, the section tabs, the chosen section. */
export function ProductPage({
  token,
  projectId,
  backend,
  parts,
  onOpenTab,
}: {
  token: string;
  projectId: string;
  backend: ReactNode;
  /** Opens Releases, for the strip's last two steps. */
  onOpenTab?: (tab: PipelineTab) => void;
  /** The project's inventory (Parts); a section only when given. */
  parts?: (openBackend: () => void) => ReactNode;
}) {
  const [section, setSection] = useState<ProductSectionId>(() => {
    // The map is Configure's overview: where the page opens unless an address
    // or this member's last look says otherwise.
    const stored = storedSection(projectId);
    const first = !landing && (stored === null || stored === "map") ? "map" : openingSection(landing, stored);
    landing = null;
    return first;
  });
  const [summary, setSummary] = useState<ProductSummary | null>(null);
  // A product that could not be read is not a product that is not there.
  const [readError, setReadError] = useState<string | null>(null);
  const [round, setRound] = useState(0);
  const [steps, setSteps] = useState<FlowStep[] | null>(null);
  /** The strip's step opened below it: the header's Save opens Save. */
  const [openStep, setOpenStep] = useState<string | null>(null);
  /** What Backend says comes next (kits.tsx announces it). */
  const [next, setNext] = useState<string | null>(() => announcedNext(projectId));

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.projectProduct(token, projectId).then(
        (p) => {
          if (alive) setReadError(null);
          return p;
        },
        (e: unknown) => {
          if (alive) setReadError(errText(e));
          return null;
        },
      ),
      api.projectConfig(token, projectId).catch(() => null),
    ]).then(([product, cfg]) => alive && setSummary(productSummary(product, cfg)));
    return () => {
      alive = false;
    };
  }, [token, projectId, round]);

  // A section wrote the product -- Backend previewed or saved it, Frontend
  // saved its pick: the header and the strip read the record again.
  useEffect(() => {
    const changed = (e: Event) => {
      if ((e as CustomEvent<string>).detail === projectId) setRound((r) => r + 1);
    };
    window.addEventListener(PRODUCT_CHANGED_EVENT, changed);
    return () => window.removeEventListener(PRODUCT_CHANGED_EVENT, changed);
  }, [projectId]);

  // Backend's next step is the header's action; Backend mounts first, so what
  // it said before this listened is read back too.
  useEffect(() => {
    setNext(announcedNext(projectId));
    const said = (e: Event) => {
      const d = (e as CustomEvent<{ projectId: string; action: string | null }>).detail;
      if (d?.projectId === projectId) setNext(d.action);
    };
    window.addEventListener(PRODUCT_NEXT_EVENT, said);
    return () => window.removeEventListener(PRODUCT_NEXT_EVENT, said);
  }, [projectId]);

  const pick = (id: ProductSectionId) => {
    setSection(id);
    storeSection(projectId, id);
    // The header follows what the sections changed: a save, a frontend added.
    setRound((r) => r + 1);
  };

  /** Ask Backend to take a step: it is shown, then acts. */
  const tellBackend = (action: string) => {
    pick("backend");
    setTimeout(() => window.dispatchEvent(new CustomEvent(PRODUCT_COMMAND_EVENT, { detail: { projectId, action } })), 0);
  };

  const header = summary ? productHeader(summary, next, steps?.find((s) => s.id === "save")?.state ?? null) : null;
  const act = (a: ProductAction) => {
    if (a === "pick") pick("backend");
    else if (a === "save") setOpenStep("save");
    else if (a === "build") onOpenTab?.("releases");
    // Backend lists the fixes once it has checked the product as it is.
    else if (a === "fix" && next === "preview") tellBackend("preview");
    else tellBackend(a);
  };
  const partsOf = steps?.find((s) => s.id === "configure")?.parts ?? [];
  const partOf = (id: string) => partsOf.find((p) => p.id === id);
  const gears = summary?.gears ?? 0;
  const tabs: { id: ProductSectionId; label: string }[] = [
    { id: "map", label: "Map" },
    { id: "infrastructure", label: "Infrastructure" },
    { id: "backend", label: gears > 0 ? `Backend · ${gears} gear${gears === 1 ? "" : "s"}` : "Backend" },
    { id: "frontend", label: "Frontend" },
    ...(parts ? [{ id: "parts" as const, label: "Parts" }] : []),
  ];

  return (
    <>
      <div data-product-header>
        <PageHeader
          title={summary?.id ?? "Product"}
          info={
            <>
              <p>
                The product this project ships: its infrastructure, its backend (the gears) and, if it has one, its
                frontend. Configure it in the parts below, save it to <code>product.gdl</code> -- a revision Studio
                keeps -- then build and deploy what was saved, in Releases.
              </p>
              <p>
                The verdict is the Gearbox engine&apos;s at the last check. Published: the description is in the
                repository too.
              </p>
            </>
          }
          status={
            readError ? (
              <span className="error" data-product-summary>
                The product could not be read: {readError}
              </span>
            ) : !summary || !header ? (
              <span>Reading the product…</span>
            ) : (
              <span data-product-summary style={{ display: "contents" }}>
                {header.verdict ? (
                  <StatusChip
                    tone={header.verdict.tone}
                    data-product-verdict={header.verdict.tone}
                    title={summary.preview ? `${summary.preview.warnings} warnings` : undefined}
                    onClick={header.verdict.tone === "danger" ? () => act("fix") : undefined}
                  >
                    {header.verdict.text}
                  </StatusChip>
                ) : (
                  <span>No product yet</span>
                )}
                {header.kept && (
                  <StatusChip tone="neutral" data-product-kept>
                    {header.kept}
                  </StatusChip>
                )}
                {summary.saved?.prUrl && (
                  <a href={summary.saved.prUrl} target="_blank" rel="noreferrer">
                    pull request ↗
                  </a>
                )}
              </span>
            )
          }
          actions={
            header && (
              <button type="button" className="primary" onClick={() => act(header.action)} data-product-action={header.action}>
                {PRODUCT_ACTION_LABEL[header.action]}
                {header.action === "build" ? " →" : ""}
              </button>
            )
          }
        />
      </div>
      {/* What the product is comes first: Studio proposes it from the specs
          and a member confirms it (product-kind.ts). */}
      <ProductKindStep token={token} projectId={projectId} />
      <ProductFlow
        token={token}
        projectId={projectId}
        round={round}
        open={openStep}
        onOpen={setOpenStep}
        onSection={pick}
        onOpenTab={onOpenTab}
        onSaved={() => setRound((r) => r + 1)}
        onSteps={setSteps}
      />
      <ProductSources key={round} token={token} projectId={projectId} compact />
      <div className="doc-views product-tabs" role="tablist" aria-label="The product's parts" data-product-tabs>
        {tabs.map((t) => {
          const part = partOf(t.id);
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={section === t.id}
              className={section === t.id ? "doc-view on" : "doc-view"}
              onClick={() => pick(t.id)}
              title={part?.status ?? PRODUCT_SECTIONS.find((s) => s.id === t.id)?.hint}
              data-product-section-tab={t.id}
              data-flow-state={part?.state}
            >
              {part && <span className={`product-tab-dot ${DOT[part.state]}`} aria-hidden />}
              {t.label}
            </button>
          );
        })}
      </div>
      {section === "map" && <ProductMap token={token} projectId={projectId} onSection={pick} />}
      {section === "parts" && parts?.(() => pick("backend"))}
      {section === "infrastructure" && <ProductInfrastructure token={token} projectId={projectId} onOpenTab={onOpenTab} />}
      <div hidden={section !== "backend"} data-product-section="backend">
        {backend}
      </div>
      {section === "frontend" && (
        <ProductFrontend token={token} projectId={projectId} onChanged={() => setRound((r) => r + 1)} />
      )}
    </>
  );
}

/** What the product needs to run, and where it runs: per ADR-0056 §3 the
 *  environments are Releases'; here each is a chip that opens them. */
function ProductInfrastructure({
  token,
  projectId,
  onOpenTab,
}: {
  token: string;
  projectId: string;
  onOpenTab?: (tab: PipelineTab) => void;
}) {
  const [infra, setInfra] = useState<Infrastructure | null>(null);
  const [environments, setEnvironments] = useState<DeployEnvironment[]>([]);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.projectProduct(token, projectId).catch(() => null),
      api.projectTargets(token, projectId).catch((): ProjectTargets | null => null),
    ]).then(([product, targets]) => {
      if (!alive) return;
      setInfra(infrastructureOf(product, targets));
      setEnvironments((targets?.environments ?? []).map((e) => e.environment));
    });
    return () => {
      alive = false;
    };
  }, [token, projectId]);

  const releases = onOpenTab ? () => onOpenTab("releases") : undefined;
  return (
    <section className="card" data-product-section="infrastructure">
      {!infra ? (
        <p className="muted">Reading what the product needs…</p>
      ) : (
        <div style={{ display: "grid", gap: 10, fontSize: 13 }}>
          {/* ADR-0064: the needs, the services deployed with the product and
              their links to the gears, editable. */}
          <ProductInfraServices
            token={token}
            projectId={projectId}
            needs={infra.needs}
            places={infra.runsIn}
            environments={environments}
            onOpenTab={onOpenTab}
          />
          {infra.runsIn.length === 0 ? (
            <EmptyState
              title="No environment to run in yet."
              action={
                releases && (
                  <button type="button" onClick={releases}>
                    Open Releases
                  </button>
                )
              }
            />
          ) : (
            <div className="row" style={{ gap: 6, flexWrap: "wrap", alignItems: "center" }} data-product-environments>
              <span className="muted">Runs in</span>
              {infra.runsIn.map((r) => {
                const tone =
                  r.missing.length > 0 || r.verdict?.state === "failed"
                    ? "danger"
                    : r.unchecked || !r.profile
                      ? "warn"
                      : r.verdict?.state === "ok"
                        ? "ok"
                        : "neutral";
                const why =
                  r.missing.length > 0
                    ? `no ${r.missing.join(", ")}: the gears that need it cannot start there`
                    : (r.unchecked ?? (r.verdict ? verdictText(r.verdict) : "no profile bound"));
                return (
                  <StatusChip
                    key={r.environment}
                    tone={tone}
                    onClick={releases}
                    title={`${r.namespace} · ${r.database} · ${why}. Opens Releases.`}
                    data-env-chip={r.environment}
                    data-env-verdict={r.verdict?.state ?? "none"}
                  >
                    {r.environment} · {r.profileLabel ?? "no profile"}
                    {r.missing.length > 0 && <span data-env-missing> · no {r.missing.join(", ")}</span>}
                  </StatusChip>
                );
              })}
              {releases && (
                <button type="button" className="linklike" onClick={releases}>
                  Environments are in Releases →
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** The product's frontend: the constructor when it has one, an offer to add
 *  one when it does not. */
function ProductFrontend({
  token,
  projectId,
  onChanged,
}: {
  token: string;
  projectId: string;
  onChanged: () => void;
}) {
  const [cfg, setCfg] = useState<ProjectConfig | null | undefined>(undefined);
  const [product, setProduct] = useState<ProjectProduct | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The deployment's shell template (STUDIO_FRONTX_SHELL_TEMPLATE).
  const starter = newFrontend(useFrontxDefaults(token).shellTemplate);

  useEffect(() => {
    let alive = true;
    Promise.all([api.projectConfig(token, projectId), api.projectProduct(token, projectId).catch(() => null)])
      .then(([c, p]) => {
        if (!alive) return;
        setProduct(p);
        setCfg(c);
      })
      .catch((e) => {
        if (!alive) return;
        setCfg(null);
        setErr(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [token, projectId]);

  /** Give the product a frontend, or take it away (`null`): the product keeps
   *  it, and a project's older record of one in its configuration goes too. */
  async function change(frontend: FrontendPick | null) {
    setBusy(true);
    setErr(null);
    try {
      const saved = await api.saveProjectProduct(token, projectId, { frontend });
      setProduct(saved.value);
      if (!frontend) {
        const fresh = await api.projectConfig(token, projectId);
        if (fresh?.frontend) {
          const value = withoutFrontend(fresh);
          await api.putProjectConfig(token, projectId, value);
          setCfg(value);
        }
      }
      onChanged();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const has = hasFrontend(cfg, product);
  const picked = product?.frontend?.mfes.length ?? cfg?.frontend?.mfes?.length ?? 0;
  return (
    <section className="card" data-product-section="frontend" data-product-frontend={has ? "yes" : "no"}>
      {has && (
        <div className="row" style={{ alignItems: "center", marginBottom: 8 }}>
          <span className="grow" />
          <button
            type="button"
            className="ghost"
            disabled={busy}
            title={picked > 0 ? `Its ${picked} micro-frontend${picked === 1 ? "" : "s"} are dropped with it` : undefined}
            onClick={() => {
              if (picked === 0 || window.confirm("Remove the product's frontend, with the micro-frontends picked for it?"))
                void change(null);
            }}
          >
            Remove the frontend
          </button>
        </div>
      )}
      {err && <div className="error">{err}</div>}
      {cfg === undefined ? (
        <p className="muted">Reading whether the product has a frontend…</p>
      ) : has ? (
        <FrontendConstructor token={token} projectId={projectId} />
      ) : (
        <div style={{ display: "grid", gap: 8 }} data-add-frontend>
          <p style={{ margin: 0 }}>
            No frontend: the product is its gears and their APIs, which is a whole product. Add one when it needs screens:
            a FrontX shell from <code>{starter.shell.path}</code> in{" "}
            <a href={`https://github.com/${starter.shell.repo}`} target="_blank" rel="noreferrer">
              {starter.shell.repo}
            </a>
            , with micro-frontends mounted in it.
          </p>
          <span>
            <button type="button" className="primary" disabled={busy} onClick={() => void change(starter)}>
              {busy ? "Adding…" : "Add a frontend"}
            </button>
          </span>
        </div>
      )}
    </section>
  );
}
