/* The architecture page's data section: what stays in Studio's core, how a
 * gear's record becomes a domain object, and — read from the backend running
 * now — where each gear keeps its records and the types it holds. The prose
 * names mechanisms only; every count and every place comes from the manifest,
 * so the section stays true without being edited. */

import type { ReactNode } from "react";

import { DATA_DESIGN_DOC, dataSummary, designDocUrl } from "./architecture";
import { HowToRead } from "./architecture-overview";
import type { ManifestData } from "./architecture";

const STORE_WORDS: Record<string, string> = {
  model: "domain objects",
  tables: "its own tables",
  metadata: "account-management metadata",
  graph: "the graph store, outside the model",
  sources: "its old store",
};

function StoreTag({ store }: { store: string }) {
  const inModel = store === "model";
  return (
    <span
      className={`arch-via ${inModel ? "via-port" : "via-surface"}`}
      title={inModel ? "Kept as domain objects" : `Still kept in ${STORE_WORDS[store] ?? store}`}
    >
      {inModel ? "model" : store}
    </span>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="arch-data-step">
      <span className="arch-data-n">{n}</span>
      <div>
        <strong>{title}</strong>
        <p className="arch-muted">{children}</p>
      </div>
    </li>
  );
}

export function DataSection({
  data,
  commit,
  renderGear,
}: {
  data: ManifestData[] | undefined;
  commit?: string | null;
  renderGear: (name: string) => ReactNode;
}) {
  const counts = data ? dataSummary(data) : null;
  return (
    <section className="card arch-section" id="data" aria-labelledby="data-title">
      <h2 id="data-title">Where Studio keeps its data</h2>
      <HowToRead tab="data" />
      <p className="arch-muted arch-intro">
        Studio keeps a small <strong>core</strong> of its own: organizations, workspaces and projects in
        account-management with their own settings, the people and their roles, and secrets. Every other record a
        gear keeps — documents, reviews, artifacts, the catalogue, environments, deploys, budgets, kits — is an
        object of the organization's <strong>domain model</strong>. The portal reads any of them with one{" "}
        <code>/query</code>, and an organization can add fields and types of its own.
      </p>

      <ol className="arch-data-steps" aria-label="How one record travels">
        <Step n={1} title="The gear writes it">
          The gear checks its rules and rights as before, then writes the record into the model of the organization
          that owns it. The record's type is marked as held by that gear.
        </Step>
        <Step n={2} title="Everyone sees it">
          A Postgres copy of the model answers <code>/query</code>, and a <code>domain.*</code> event tells open screens
          to read again — no reload.
        </Step>
        <Step n={3} title="The organization extends it">
          Fields an admin adds to the type in the model editor are filled by people; the gear's next write keeps them.
        </Step>
        <Step n={4} title="Nobody goes around the gear">
          The generic <code>/mutate</code> refuses the gear's own records and fields; only the gear changes them.
        </Step>
      </ol>

      {!data ? (
        <div className="arch-warn" role="status">
          This backend does not say where its gears keep their records: that arrives with the manifest's{" "}
          <code>data</code> field.
        </div>
      ) : (
        <>
          <div className="arch-stats arch-data-stats">
            <div className="arch-stat">
              <span className="arch-stat-value">{counts!.gears}</span>
              <span className="arch-stat-label">gears keep records</span>
            </div>
            <div className="arch-stat">
              <span className="arch-stat-value">{counts!.inModel}</span>
              <span className="arch-stat-label">kinds of records live as domain objects</span>
            </div>
            <div className={`arch-stat${counts!.elsewhere.length ? " is-bad" : ""}`}>
              <span className="arch-stat-value">{counts!.elsewhere.length}</span>
              <span className="arch-stat-label">kinds still kept outside the model</span>
            </div>
            <div className="arch-stat">
              <span className="arch-stat-value">{counts!.types}</span>
              <span className="arch-stat-label">model types held by gears</span>
            </div>
          </div>
          <div className="arch-table-wrap">
            <table className="arch-table arch-data-table">
              <thead>
                <tr>
                  <th>Gear</th>
                  <th>Its records and where they live</th>
                  <th>Model types only it writes</th>
                </tr>
              </thead>
              <tbody>
                {data.map((d) => (
                  <tr key={d.gear}>
                    <td>{d.gear.startsWith("studio-") ? renderGear(d.gear) : <code>{d.gear}</code>}</td>
                    <td>
                      <div className="arch-chips">
                        {d.stores.length === 0 && <span className="arch-muted">—</span>}
                        {d.stores.map((s) => (
                          <span key={s.kind} className="arch-data-kind">
                            <code>{s.kind}</code> <StoreTag store={s.store} />
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      {d.types.length === 0 ? (
                        <span className="arch-muted">none written yet</span>
                      ) : (
                        <div className="arch-chips">
                          {d.types.map((t) => (
                            <code key={t} className="arch-data-type">
                              {t}
                            </code>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="arch-muted arch-intro">
            A gear's <code>storage.&lt;kind&gt;</code> setting decides where each kind lives: <code>model</code>, or the
            store it was kept in before. Changing it moves the records the other way when the backend starts, and leaves
            no copy behind. A gear's types are listed as it writes them after the backend starts.{" "}
            <a href={designDocUrl(DATA_DESIGN_DOC, commit)} target="_blank" rel="noreferrer">
              The design (ADR-0051)
            </a>
            .
          </p>
        </>
      )}
    </section>
  );
}
