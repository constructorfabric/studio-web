/* The Product tab (product-sections.ts): one page for the one product. A header
 * says it in a line -- id, profile, gears, where it was saved, whether it
 * resolved, whether it has a frontend -- above a switch between its parts;
 * only the chosen part is drawn below it:
 *
 *   Infrastructure   where it runs: its profile, environments, databases
 *   Backend          the gears (the existing `ProjectKits` journey, passed in
 *                    by the shell, kept mounted so its panes keep their state)
 *   Frontend         the frontend constructor, or "Add a frontend"
 */

import { useEffect, useState, type ReactNode } from "react";

import { api, type ProjectConfig, type ProjectTargets } from "./api";
import { FrontendConstructor } from "./frontend-constructor-view";
import {
  FRONTX_SHELL_TEMPLATE,
  PRODUCT_SECTIONS,
  hasFrontend,
  comesWith,
  infrastructureOf,
  openingSection,
  productSummary,
  sectionFromPath,
  withFrontend,
  withoutFrontend,
  type Infrastructure,
  type ProductSectionId,
  type ProductSummary,
} from "./product-sections";
import { errText } from "./problem";
import { gearLabel } from "./product";

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

/** The Product tab: the header, the section switch, the chosen section. */
export function ProductPage({
  token,
  projectId,
  backend,
  parts,
}: {
  token: string;
  projectId: string;
  backend: ReactNode;
  /** The project's inventory (Parts); a section only when given. */
  parts?: (openBackend: () => void) => ReactNode;
}) {
  const [section, setSection] = useState<ProductSectionId>(() => {
    const first = openingSection(landing, storedSection(projectId));
    landing = null;
    return first;
  });
  const [summary, setSummary] = useState<ProductSummary | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.projectProduct(token, projectId).catch(() => null),
      api.projectConfig(token, projectId).catch(() => null),
    ]).then(([product, cfg]) => alive && setSummary(productSummary(product, cfg)));
    return () => {
      alive = false;
    };
  }, [token, projectId, round]);

  const pick = (id: ProductSectionId) => {
    setSection(id);
    storeSection(projectId, id);
    // The header follows what the sections changed: a save, a frontend added.
    setRound((r) => r + 1);
  };
  const hint = PRODUCT_SECTIONS.find((s) => s.id === section)?.hint;

  return (
    <>
      <section className="card" style={{ marginBottom: 12 }} data-product-header>
        <SummaryLine summary={summary} />
        <div className="row" style={{ alignItems: "center", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
          <div className="doc-views" role="tablist" aria-label="The product's parts" style={{ marginBottom: 0 }} data-product-sections>
            {PRODUCT_SECTIONS.filter((s) => s.id !== "parts" || parts).map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={section === s.id}
                className={`doc-view${section === s.id ? " on" : ""}`}
                onClick={() => pick(s.id)}
                data-product-section-tab={s.id}
              >
                {s.title}
                {s.id === "frontend" && summary && !summary.frontend && <span className="muted"> · none</span>}
              </button>
            ))}
          </div>
          <span className="hint" style={{ fontSize: 12 }}>
            {hint}
          </span>
        </div>
      </section>
      {section === "parts" && parts?.(() => pick("backend"))}
      {section === "infrastructure" && <ProductInfrastructure token={token} projectId={projectId} />}
      <div hidden={section !== "backend"} data-product-section="backend">
        {backend}
      </div>
      {section === "frontend" && (
        <ProductFrontend token={token} projectId={projectId} onChanged={() => setRound((r) => r + 1)} />
      )}
    </>
  );
}

/** The product in one line. */
function SummaryLine({ summary: s }: { summary: ProductSummary | null }) {
  if (!s) return <p className="muted" style={{ margin: 0 }}>Reading the product…</p>;
  if (!s.id && s.gears === 0) {
    return (
      <p style={{ margin: 0 }} data-product-summary>
        <b>No product yet.</b> <span className="muted">Pick its gears under Backend; it is saved to the repository from there.</span>
      </p>
    );
  }
  return (
    <p style={{ margin: 0, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }} data-product-summary>
      <b>{s.id ?? "Unnamed product"}</b>
      {s.profile && <span className="muted">{s.profile}</span>}
      <span className="muted">
        · {s.gears} gear{s.gears === 1 ? "" : "s"}
      </span>
      {s.preview && (
        <span className={`badge ${s.preview.ok ? "ok" : "danger"}`} title={`${s.preview.warnings} warnings`}>
          {s.preview.ok ? "resolves" : `${s.preview.errors} error${s.preview.errors === 1 ? "" : "s"}`}
        </span>
      )}
      <span className="muted">
        ·{" "}
        {s.revision !== null ? (
          <>kept in Studio as revision {s.revision}</>
        ) : s.saved ? (
          <>
            saved on <code>{s.saved.branch ?? "the repository's branch"}</code>
            {s.saved.prUrl && (
              <>
                {" "}
                (
                <a href={s.saved.prUrl} target="_blank" rel="noreferrer">
                  pull request
                </a>
                )
              </>
            )}
          </>
        ) : (
          "not saved to the repository yet"
        )}
      </span>
      <span className="muted">· {s.frontend ? "with a frontend" : "no frontend"}</span>
    </p>
  );
}

/** Where the product runs: its profile, the environments it may run in, and
 *  the database each gives it. */
function ProductInfrastructure({ token, projectId }: { token: string; projectId: string }) {
  const [infra, setInfra] = useState<Infrastructure | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.projectProduct(token, projectId).catch(() => null),
      api.projectTargets(token, projectId).catch((): ProjectTargets | null => null),
    ]).then(([product, targets]) => alive && setInfra(infrastructureOf(product, targets)));
    return () => {
      alive = false;
    };
  }, [token, projectId]);

  return (
    <>
      <section className="card" data-product-section="infrastructure">
        {!infra ? (
          <p className="muted">Reading where the product runs…</p>
        ) : (
          <div style={{ display: "grid", gap: 6, fontSize: 13 }}>
            <div>
              Profile:{" "}
              {infra.profileLabel ? (
                <b>{infra.profileLabel}</b>
              ) : (
                <span className="muted">none yet; it is set when the gears below are composed into a product</span>
              )}
            </div>
            <ProductNeeds infra={infra} />
            {infra.runsIn.length === 0 ? (
              <div className="muted">
                No environment this project may deploy to. An organization administrator adds one under Environments; the
                Deploys tab binds a profile to it.
              </div>
            ) : (
              <table className="ptable" aria-label="Where the product runs">
                <thead>
                  <tr>
                    <th>Environment</th>
                    <th>Namespace</th>
                    <th>Profile</th>
                    <th>Database</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {infra.runsIn.map((r) => (
                    <tr key={r.environment}>
                      <td>{r.environment}</td>
                      <td>
                        <code>{r.namespace}</code>
                      </td>
                      <td>{r.profile ?? <span className="muted">not bound</span>}</td>
                      <td>{r.database}</td>
                      <td>
                        {r.missing.length > 0 ? (
                          <span className="badge danger" title="The gears that need it cannot start there" data-env-missing>
                            no {r.missing.join(", ")}
                          </span>
                        ) : infra.needs ? (
                          <span className="badge ok">gives what it needs</span>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>
    </>
  );
}

/** What the product runs on besides its own applications: the technologies
 *  its gears need, each with the gears that need it. */
function ProductNeeds({ infra }: { infra: Infrastructure }) {
  if (infra.needs === null) {
    return (
      <p className="muted" style={{ margin: 0 }}>
        What the gears need running beside them shows once the product is checked: open Backend.
      </p>
    );
  }
  return (
    <table className="ptable" aria-label="What the product runs on" data-product-needs>
      <thead>
        <tr>
          <th>Runs on</th>
          <th>For</th>
          <th>Gears</th>
          <th>Comes</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td>
            <b>{infra.profileLabel ?? "Its profile"}</b>
          </td>
          <td>
            {infra.applications.length === 0
              ? "the product's applications"
              : `${infra.applications.length} application${infra.applications.length === 1 ? "" : "s"}: ${infra.applications.join(", ")}`}
          </td>
          <td className="muted">all</td>
          <td>
            <span className="badge ok">with every deploy</span>
          </td>
        </tr>
        {infra.needs.map((t) => (
          <tr key={t.id} data-technology={t.id}>
            <td>
              <b>{t.name}</b>
            </td>
            <td>{t.why}</td>
            <td title={t.gears.map(gearLabel).join(", ")}>
              {t.gears.length <= 3 ? t.gears.map(gearLabel).join(", ") : `${t.gears.length} gears`}
            </td>
            <td title={comesWith(t.id).words}>
              {comesWith(t.id).deployed ? (
                <span className="badge ok">with every deploy</span>
              ) : (
                <span className="badge" data-outside>
                  outside Studio
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .projectConfig(token, projectId)
      .then((c) => alive && setCfg(c))
      .catch((e) => {
        if (!alive) return;
        setCfg(null);
        setErr(errText(e));
      });
    return () => {
      alive = false;
    };
  }, [token, projectId]);

  async function change(next: (c: ProjectConfig | null) => ProjectConfig) {
    setBusy(true);
    setErr(null);
    try {
      const fresh = await api.projectConfig(token, projectId);
      const value = next(fresh);
      await api.putProjectConfig(token, projectId, value);
      setCfg(value);
      onChanged();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const has = hasFrontend(cfg);
  const picked = cfg?.frontend?.mfes?.length ?? 0;
  return (
    <section className="card" data-product-section="frontend" data-product-frontend={has ? "yes" : "no"}>
      {has && (
        <div className="row" style={{ alignItems: "center", marginBottom: 8 }}>
          <span className="grow muted" style={{ fontSize: 12 }}>
            Shell from <code>{cfg?.frontend?.shell ?? FRONTX_SHELL_TEMPLATE}</code>.
          </span>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            title={picked > 0 ? `Its ${picked} micro-frontend${picked === 1 ? "" : "s"} are dropped with it` : undefined}
            onClick={() => {
              if (picked === 0 || window.confirm("Remove the product's frontend, with the micro-frontends picked for it?"))
                void change(withoutFrontend);
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
            a FrontX shell from <code>template-shell</code> in{" "}
            <a href="https://github.com/constructorfabric/gears-frontx-templates" target="_blank" rel="noreferrer">
              constructorfabric/gears-frontx-templates
            </a>
            , with micro-frontends mounted in it.
          </p>
          <span>
            <button type="button" className="primary" disabled={busy} onClick={() => void change(withFrontend)}>
              {busy ? "Adding…" : "Add a frontend"}
            </button>
          </span>
        </div>
      )}
    </section>
  );
}
