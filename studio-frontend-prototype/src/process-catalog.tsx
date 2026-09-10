/** The workspace's process catalogue: journey stages and the capability
 *  vocabulary.
 *
 *  Both used to be constants — `JOURNEY_STAGES` in this app and `CAP_KEYWORDS`
 *  in documents.tsx — so an organization could not change the path its products
 *  take through the studio, nor the words that decide which components get
 *  offered. ADR-0014 moved both to the server as catalogues that overlay
 *  `Builtin → Organization → Workspace`. This is where a workspace acts on
 *  them, and until now there was no screen at all: the API existed and nothing
 *  could reach it.
 *
 *  Three verbs, and the distinction between the last two is the whole point:
 *
 *  - **Override** — replace an inherited entry with your own.
 *  - **Hide** — a tombstone. Removes the inherited entry from the effective
 *    catalogue rather than replacing it.
 *  - **Revert** — drop your own entry, so what you inherit shows through again.
 *
 *  Without revert, an override would be a one-way door. The screen therefore
 *  shows what LEVEL every row comes from, because "this is ours" and "this is
 *  the platform's" are different situations with different affordances.
 */

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import type { Capability, JourneyStage } from "./api";
import { errText } from "./format";

const CSS = `
.pcat { display: flex; flex-direction: column; gap: 20px; }
.pcat-head h2 { margin: 0 0 4px; font-size: 16px; }
.pcat-head p { margin: 0; font-size: 12px; opacity: .75; max-width: 78ch; line-height: 1.5; }
.pcat-card { border: 1px solid var(--border,#e2e4e9); border-radius: 10px; padding: 14px 16px; }
.pcat-card h3 { margin: 0 0 2px; font-size: 13px; }
.pcat-card .sub { margin: 0 0 12px; font-size: 11px; opacity: .7; }
.pcat-row { display: grid; grid-template-columns: 150px 1fr auto; gap: 12px; align-items: center;
  padding: 8px 0; border-top: 1px solid var(--border,#eef0f3); }
.pcat-row:first-of-type { border-top: 0; }
.pcat-key { font-family: ui-monospace, monospace; font-size: 12px; }
.pcat-meta { font-size: 12px; opacity: .8; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.pcat-owner { font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
  border: 1px solid var(--border,#e2e4e9); border-radius: 999px; padding: 1px 7px; opacity: .8; }
.pcat-owner.own { border-color: var(--accent,#4f46e5); color: var(--accent,#4f46e5); opacity: 1; }
.pcat-actions { display: flex; gap: 6px; }
.pcat-actions button { font-size: 11px; padding: 3px 9px; }
.pcat-add { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-end; margin-top: 12px;
  padding-top: 12px; border-top: 1px dashed var(--border,#e2e4e9); }
.pcat-add label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; opacity: .8; }
.pcat-add input { font-size: 12px; padding: 4px 6px; }
.pcat-empty { font-size: 12px; opacity: .7; padding: 8px 0; }
`;

/** Which level an entry came from, as a chip. `own` is what this workspace can
 *  revert; anything else it can only override or hide. */
function OwnerChip({ owner }: { owner: string }) {
  const own = owner === "workspace";
  return <span className={own ? "pcat-owner own" : "pcat-owner"}>{owner}</span>;
}

function commaList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function ProcessCatalogTab({
  token,
  workspaceId,
}: {
  token: string;
  workspaceId: string;
}) {
  const [stages, setStages] = useState<JourneyStage[]>([]);
  const [caps, setCaps] = useState<Capability[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        api.stages(token, workspaceId),
        api.capabilities(token, workspaceId),
      ]);
      setStages(s.items ?? []);
      setCaps(c.items ?? []);
      setErr(null);
    } catch (e) {
      setErr(errText(e));
    }
  }, [token, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Every write reloads: the effective catalogue is resolved server-side, so a
   *  local edit would only be a guess at what the overlay produced. */
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await work();
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  // ── stages ────────────────────────────────────────────────────────────────
  const [stKey, setStKey] = useState("");
  const [stLabel, setStLabel] = useState("");
  const [stPos, setStPos] = useState("");
  const [stRequires, setStRequires] = useState("");
  const [stGates, setStGates] = useState("");

  const addStage = () =>
    run(async () => {
      await api.upsertStage(token, workspaceId, {
        key: stKey.trim(),
        label: stLabel.trim() || stKey.trim(),
        // Built-in positions are spaced by ten, so an unspecified one lands
        // after everything rather than colliding with a platform stage.
        position: stPos.trim() ? Number(stPos) : (stages.at(-1)?.position ?? 0) + 10,
        requires: commaList(stRequires),
        gates: commaList(stGates),
      });
      setStKey("");
      setStLabel("");
      setStPos("");
      setStRequires("");
      setStGates("");
    });

  const hideStage = (s: JourneyStage) =>
    run(() =>
      api.upsertStage(token, workspaceId, { key: s.key, label: s.label, hidden: true }),
    );

  const revertStage = (s: JourneyStage) => run(() => api.deleteStage(token, workspaceId, s.key));

  // ── capabilities ──────────────────────────────────────────────────────────
  const [capKey, setCapKey] = useState("");
  const [capLabel, setCapLabel] = useState("");
  const [capTerms, setCapTerms] = useState("");

  const addCap = () =>
    run(async () => {
      await api.upsertCapability(token, workspaceId, {
        key: capKey.trim(),
        label: capLabel.trim() || capKey.trim(),
        terms: commaList(capTerms),
      });
      setCapKey("");
      setCapLabel("");
      setCapTerms("");
    });

  const hideCap = (c: Capability) =>
    run(() =>
      api.upsertCapability(token, workspaceId, { key: c.key, label: c.label, hidden: true }),
    );

  const revertCap = (c: Capability) => run(() => api.deleteCapability(token, workspaceId, c.key));

  return (
    <div className="pcat">
      <style>{CSS}</style>
      <div className="pcat-head">
        <h2>Process catalogue</h2>
        <p>
          The stages a product passes through, and the capability vocabulary its documents seed.
          Both are inherited — from the platform, then from your organization — and this workspace
          may replace an entry, hide one it does not use, or revert to what it inherits. A row
          marked <em>workspace</em> is yours; the rest come from above.
        </p>
      </div>

      {err && <div className="error">{err}</div>}

      <div className="pcat-card">
        <h3>Journey stages</h3>
        <p className="sub">
          In catalogue order. <strong>Requires</strong> names the document types a stage cannot be
          complete without; <strong>gates</strong> names the spec-quality detectors those documents
          must pass before it is.
        </p>
        {stages.length === 0 && <div className="pcat-empty">No stages — the catalogue is empty.</div>}
        {stages.map((s) => (
          <div className="pcat-row" key={s.key}>
            <span className="pcat-key">{s.key}</span>
            <span className="pcat-meta">
              {s.label}
              <OwnerChip owner={s.owner} />
              <span style={{ opacity: 0.6 }}>#{s.position}</span>
              {s.required && <span style={{ opacity: 0.6 }}>required</span>}
              {s.requires.length > 0 && <span>requires: {s.requires.join(", ")}</span>}
              {s.gates.length > 0 && <span>gates: {s.gates.join(", ")}</span>}
            </span>
            <span className="pcat-actions">
              {s.owner === "workspace" ? (
                <button onClick={() => revertStage(s)} disabled={busy} title="Drop our entry and go back to what we inherit">
                  Revert
                </button>
              ) : (
                <button onClick={() => hideStage(s)} disabled={busy} title="Remove this inherited stage from our catalogue">
                  Hide
                </button>
              )}
            </span>
          </div>
        ))}

        <div className="pcat-add">
          <label>
            key
            <input value={stKey} onChange={(e) => setStKey(e.target.value)} placeholder="discovery" />
          </label>
          <label>
            label
            <input value={stLabel} onChange={(e) => setStLabel(e.target.value)} placeholder="Discovery" />
          </label>
          <label>
            position
            <input value={stPos} onChange={(e) => setStPos(e.target.value)} placeholder="15" style={{ width: 70 }} />
          </label>
          <label>
            requires
            <input value={stRequires} onChange={(e) => setStRequires(e.target.value)} placeholder="prd, upstream_reqs" />
          </label>
          <label>
            gates
            <input value={stGates} onChange={(e) => setStGates(e.target.value)} placeholder="bloat, purpose" />
          </label>
          <button className="primary" onClick={addStage} disabled={busy || !stKey.trim()}>
            Add or replace
          </button>
        </div>
      </div>

      <div className="pcat-card">
        <h3>Capabilities</h3>
        <p className="sub">
          A questionnaire answer seeds a capability, and the composer turns capabilities into
          candidate components through these terms. An entry with no terms is matched on its own
          key.
        </p>
        {caps.length === 0 && <div className="pcat-empty">No capabilities — the vocabulary is empty.</div>}
        {caps.map((c) => (
          <div className="pcat-row" key={c.key}>
            <span className="pcat-key">{c.key}</span>
            <span className="pcat-meta">
              {c.label}
              <OwnerChip owner={c.owner} />
              {c.terms.length > 0 && <span style={{ opacity: 0.7 }}>{c.terms.join(", ")}</span>}
            </span>
            <span className="pcat-actions">
              {c.owner === "workspace" ? (
                <button onClick={() => revertCap(c)} disabled={busy}>
                  Revert
                </button>
              ) : (
                <button onClick={() => hideCap(c)} disabled={busy}>
                  Hide
                </button>
              )}
            </span>
          </div>
        ))}

        <div className="pcat-add">
          <label>
            key
            <input value={capKey} onChange={(e) => setCapKey(e.target.value)} placeholder="observability" />
          </label>
          <label>
            label
            <input value={capLabel} onChange={(e) => setCapLabel(e.target.value)} placeholder="Observability" />
          </label>
          <label style={{ flex: 1, minWidth: 220 }}>
            search terms
            <input value={capTerms} onChange={(e) => setCapTerms(e.target.value)} placeholder="tracing, metrics, otel" />
          </label>
          <button className="primary" onClick={addCap} disabled={busy || !capKey.trim()}>
            Add or replace
          </button>
        </div>
      </div>
    </div>
  );
}
