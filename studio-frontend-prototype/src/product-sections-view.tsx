/* The Product tab's sections (product-sections.ts): Infrastructure above the
 * gears, Frontend below them. The gears in between are the existing Product
 * journey (`ProjectKits`), drawn by the shell unchanged, so this file adds the
 * parts around it rather than reaching into it:
 *
 *   ProductSectionsHead   the section bar, Infrastructure, the Backend heading
 *   (ProjectKits)         the gears
 *   ProductFrontend       the frontend constructor, or "Add a frontend"
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import { api, type ProjectConfig, type ProjectTargets } from "./api";
import { FrontendConstructor } from "./frontend-constructor-view";
import {
  FRONTX_SHELL_TEMPLATE,
  PRODUCT_SECTIONS,
  hasFrontend,
  infrastructureOf,
  sectionFromPath,
  withFrontend,
  withoutFrontend,
  type Infrastructure,
  type ProductSectionId,
} from "./product-sections";
import { errText } from "./problem";

/** The section an old address asked for (`/…/frontend`), read once when the
 *  page loaded: the shell rewrites the address to Product's straight after. */
let landing: ProductSectionId | null = typeof window !== "undefined" ? sectionFromPath(window.location.pathname) : null;

const anchor = (id: ProductSectionId) => `product-section-${id}`;

function scrollTo(id: ProductSectionId) {
  document.getElementById(anchor(id))?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function SectionHead({ id, children }: { id: ProductSectionId; children?: ReactNode }) {
  const s = PRODUCT_SECTIONS.find((x) => x.id === id);
  return (
    <div className="card-head" id={anchor(id)} data-product-section={id} style={{ marginTop: 8 }}>
      <div>
        <h2 style={{ margin: 0 }}>{s?.title}</h2>
        <p className="subtitle" style={{ margin: 0 }}>
          {s?.hint}
        </p>
      </div>
      {children}
    </div>
  );
}

/** The section bar, Infrastructure, and the heading of the gears below. */
export function ProductSectionsHead({ token, projectId }: { token: string; projectId: string }) {
  const [infra, setInfra] = useState<Infrastructure | null>(null);
  const [frontend, setFrontend] = useState<boolean | null>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.projectProduct(token, projectId).catch(() => null),
      api.projectTargets(token, projectId).catch((): ProjectTargets | null => null),
      api.projectConfig(token, projectId).catch(() => null),
    ]).then(([product, targets, cfg]) => {
      if (!alive) return;
      setInfra(infrastructureOf(product, targets));
      setFrontend(hasFrontend(cfg));
    });
    return () => {
      alive = false;
    };
  }, [token, projectId]);

  return (
    <>
      <nav className="chips" aria-label="The product's parts" data-product-sections>
        {PRODUCT_SECTIONS.map((s) => (
          <button key={s.id} type="button" className="chip" title={s.hint} onClick={() => scrollTo(s.id)}>
            {s.title}
            {s.id === "frontend" && frontend === false && <span className="muted"> · none yet</span>}
          </button>
        ))}
      </nav>
      <section className="card" style={{ marginBottom: 16 }}>
        <SectionHead id="infrastructure" />
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
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </section>
      <SectionHead id="backend" />
    </>
  );
}

/** The product's frontend: the constructor when it has one, an offer to add
 *  one when it does not. */
export function ProductFrontend({ token, projectId }: { token: string; projectId: string }) {
  const [cfg, setCfg] = useState<ProjectConfig | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);

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

  // An old Frontend-tab address lands here, once.
  useEffect(() => {
    if (cfg === undefined || landing !== "frontend") return;
    landing = null;
    ref.current?.scrollIntoView({ block: "start" });
  }, [cfg]);

  async function change(next: (c: ProjectConfig | null) => ProjectConfig) {
    setBusy(true);
    setErr(null);
    try {
      const fresh = await api.projectConfig(token, projectId);
      const value = next(fresh);
      await api.putProjectConfig(token, projectId, value);
      setCfg(value);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  const has = hasFrontend(cfg);
  const picked = cfg?.frontend?.mfes?.length ?? 0;
  return (
    <section className="card" style={{ marginTop: 16 }} ref={ref} data-product-frontend={has ? "yes" : "no"}>
      <SectionHead id="frontend">
        {has && (
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
        )}
      </SectionHead>
      {err && <div className="error">{err}</div>}
      {cfg === undefined ? (
        <p className="muted">Reading whether the product has a frontend…</p>
      ) : has ? (
        <>
          <p className="muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
            Shell from <code>{cfg?.frontend?.shell ?? FRONTX_SHELL_TEMPLATE}</code>.
          </p>
          <FrontendConstructor token={token} projectId={projectId} />
        </>
      ) : (
        <div style={{ display: "grid", gap: 8 }} data-add-frontend>
          <p style={{ margin: 0 }}>
            This product has no frontend: it is its gears, reached through their APIs. That is a whole product. Add a
            frontend when it needs screens of its own: a FrontX shell, from <code>template-shell</code> in{" "}
            <a href="https://github.com/constructorfabric/gears-frontx-templates" target="_blank" rel="noreferrer">
              constructorfabric/gears-frontx-templates
            </a>
            , with micro-frontends from the catalogue mounted in it.
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
