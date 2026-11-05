/* The Product page's first step: what the product is (product-kind.ts).
 * Studio proposes a kind from the project's specs, its own components and the
 * product record, with the reasons it read; a member confirms it or picks
 * another, and the choice is kept in the project's configuration. Marked
 * experimental: the proposal is read in the portal, by word matches and
 * counts, until a backend route proposes one. */

import { useEffect, useState } from "react";
import { api } from "./api";
import { GEAR_TYPE, FRONTX_TYPE, SERVICE_TYPE, tierOf } from "./catalogue-levels";
import { errText } from "./problem";
import {
  KIND_TITLE,
  PRODUCT_KINDS,
  kindStatus,
  proposeKind,
  readKindChoice,
  withKind,
  type KindFacts,
  type KindProposal,
  type ProductKind,
  type ProductKindChoice,
} from "./product-kind";
import { StatusChip } from "./ui-standard";

/** Reads what the proposal needs; each read on its own, a failed one `null`. */
export async function readKindFacts(token: string, projectId: string): Promise<{
  facts: KindFacts;
  choice: ProductKindChoice | null;
}> {
  const [cfg, caps, reqs, comps, product] = await Promise.all([
    api.projectConfig(token, projectId).catch(() => null),
    api.declaredCapabilities(token, projectId).then((r) => r.items).catch(() => null),
    api.declaredRequirements(token, projectId).then((r) => r.items).catch(() => null),
    api.listComponents(token, projectId).then((r) => r.nodes ?? []).catch(() => null),
    api.projectProduct(token, projectId).catch(() => null),
  ]);
  const own = comps?.filter((n) => tierOf(n) === "project") ?? null;
  return {
    choice: readKindChoice(cfg?.product_kind),
    facts: {
      brief: cfg?.brief ?? null,
      capabilities: caps?.map((c) => ({ key: c.key, from: [...new Set(c.sources.map((s) => s.label))] })) ?? null,
      requirements: reqs?.map((r) => r.text) ?? null,
      ownComponents: own
        ? {
            gears: own.filter((n) => n.type_id === GEAR_TYPE).length,
            frontx: own.filter((n) => n.type_id === FRONTX_TYPE).length,
            services: own.filter((n) => n.type_id === SERVICE_TYPE).length,
          }
        : null,
      product: product ? { gears: product.gears?.length ?? 0, frontend: !!product.frontend } : null,
    },
  };
}

export function ProductKindStep({ token, projectId }: { token: string; projectId: string }) {
  const [read, setRead] = useState<{ proposal: KindProposal; choice: ProductKindChoice | null } | null>(null);
  const [readErr, setReadErr] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<ProductKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    readKindFacts(token, projectId)
      .then(({ facts, choice }) => {
        if (!live) return;
        setRead({ proposal: proposeKind(facts), choice });
        // Open on a project that has not decided: it is the first step.
        setOpen(!choice);
      })
      .catch((e) => live && setReadErr(errText(e)));
    return () => {
      live = false;
    };
  }, [token, projectId, round]);

  if (readErr) return <div className="error">What the product is could not be read: {readErr}</div>;
  if (!read) return null;
  const { proposal, choice } = read;
  const status = kindStatus(choice, proposal);
  const chosen = picked ?? choice?.kind ?? proposal.kind;

  const confirm = async () => {
    setBusy(true);
    setErr(null);
    try {
      // Read fresh, set the one field, write back: as the sources do.
      const cfg = (await api.projectConfig(token, projectId).catch(() => null)) ?? {};
      await api.putProjectConfig(token, projectId, withKind(cfg, chosen, proposal.kind, null));
      setPicked(null);
      setOpen(false);
      setRound((r) => r + 1);
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card product-kind-step" data-product-kind={choice?.kind ?? "undecided"}>
      <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <b>What the product is</b>
        <StatusChip tone="warn" className="badge-experimental" title="Experimental: Studio reads the proposal from the specs by word matches and counts">
          exp
        </StatusChip>
        {choice ? (
          <StatusChip tone="ok" data-product-kind-confirmed>
            {KIND_TITLE[choice.kind]}
          </StatusChip>
        ) : (
          <StatusChip tone="info" data-product-kind-proposed={proposal.kind}>
            proposed: {KIND_TITLE[proposal.kind]}
          </StatusChip>
        )}
        <span className="muted grow" style={{ fontSize: 12 }}>
          {status.text}
        </span>
        <button type="button" className={choice ? "linklike" : "primary"} onClick={() => setOpen((o) => !o)} data-product-kind-open>
          {open ? "Close" : choice ? "Change" : "Decide"}
        </button>
      </div>
      {open && (
        <div className="product-kind-step-body" style={{ display: "grid", gap: 10, marginTop: 10 }}>
          <div>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Why Studio proposes {KIND_TITLE[proposal.kind]}</div>
            <ul className="product-kind-step-reasons" style={{ margin: 0, paddingLeft: 18, fontSize: 12 }} data-product-kind-reasons>
              {proposal.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
          <div role="radiogroup" aria-label="What the product is" style={{ display: "grid", gap: 6 }}>
            {[proposal.kind, ...proposal.alternatives].map((id) => {
              const k = PRODUCT_KINDS.find((x) => x.id === id)!;
              return (
                <label
                  key={k.id}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "flex-start",
                    padding: "8px 10px",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    background: chosen === k.id ? "var(--accent)" : "transparent",
                    cursor: "pointer",
                  }}
                >
                  <input
                    type="radio"
                    name={`pkind-${projectId}`}
                    checked={chosen === k.id}
                    onChange={() => setPicked(k.id)}
                    style={{ marginTop: 2 }}
                    data-product-kind-option={k.id}
                  />
                  <span>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>
                      {k.title}
                      {k.id === proposal.kind && <span className="muted"> · proposed</span>}
                    </div>
                    <div style={{ fontSize: 12 }}>{k.what}</div>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {k.builds}
                    </div>
                  </span>
                </label>
              );
            })}
          </div>
          {err && <div className="error">{err}</div>}
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="primary" disabled={busy || (!!choice && chosen === choice.kind)} onClick={() => void confirm()} data-product-kind-confirm>
              {busy ? "Saving…" : chosen === proposal.kind ? `Confirm ${KIND_TITLE[chosen]}` : `Use ${KIND_TITLE[chosen]}`}
            </button>
            <span className="muted" style={{ fontSize: 11 }}>
              Kept in the project&apos;s configuration; change it whenever the specs change.
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
