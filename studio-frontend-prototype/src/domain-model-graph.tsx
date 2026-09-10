// Interactive graph of the stored domain model, read live from
// GET /studio-domain-model/v1/model/graph (object_type nodes + inherits/declares
// edges). A self-contained canvas force layout — no graph library.
import { useEffect, useRef, useState, type RefObject } from "react";
import { api } from "./api";
import { errText } from "./format";

// Disambiguated 11-hue bucket palette (the model's own bucket colours collide
// on a few pairs), spread across the wheel and legible on both grounds.
const PALETTE: Record<string, string> = {
  identity: "#34d399", graph: "#f472b6", governance: "#f59e0b", connectors: "#a78bfa",
  content: "#22d3ee", planning: "#60a5fa", collaboration: "#fb7185", automation: "#fb923c",
  ai: "#6366f1", "kit-management": "#a3e635", "system-primitives": "#94a3b8",
};
const colorOf = (b: string) => PALETTE[b] ?? "#94a3b8";

interface GNode {
  key: string; id: string; name: string; bucket: string; ext: string | null;
  abstract: boolean; fields: number; rels: number;
  props: Record<string, unknown>; // the node's stored payload in Graph Storage
  x: number; y: number; vx: number; vy: number;
  out: GLink[]; in: GLink[];
}
interface GLink { s: GNode; t: GNode; k: "i" | "d"; type: string; payload: Record<string, unknown>; }

interface RawNode { key: string; name: string; payload: Record<string, unknown>; }
interface RawEdge { type_id: string; from: string; to: string; payload?: Record<string, unknown>; }
interface RawObj { instance_id: string; entity: string; bucket: string; name: string; value: Record<string, unknown>; }

interface Ctrl { select: (key: string | null) => void; clearEdge: () => void; }

export function DomainModelGraph({ token }: { token: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctrlRef = useRef<Ctrl | null>(null);
  const nodesRef = useRef<Map<string, GNode>>(new Map());
  const filterRef = useRef({ i: true, d: true, off: new Set<string>(), q: "", focus: false });

  const [mode, setMode] = useState<"types" | "instances">("types");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState({ n: 0, i: 0, d: 0 });
  const [buckets, setBuckets] = useState<{ b: string; n: number }[]>([]);
  const [sel, setSel] = useState<GNode | null>(null);
  const [selEdge, setSelEdge] = useState<GLink | null>(null);
  const [, force] = useState(0); // repaint UI (legend off-state, toggles)

  useEffect(() => {
    let raf = 0;
    let disposed = false;
    const cleanup: (() => void)[] = [];

    setLoading(true); setError(null); setSel(null);

    (async () => {
      let nodes: GNode[];
      let rawLinks: { from: string; to: string; k: "i" | "d"; type: string; payload: Record<string, unknown> }[];
      try {
        if (mode === "instances") {
          const raw = (await api.domainObjectsGraph(token)) as unknown as { nodes: RawObj[]; edges: RawEdge[] };
          nodes = raw.nodes.map((n) => ({
            key: n.instance_id, id: n.entity, name: n.name || n.instance_id, bucket: n.bucket,
            ext: null, abstract: false, fields: 0, rels: 0, props: n.value ?? {},
            x: 0, y: 0, vx: 0, vy: 0, out: [], in: [],
          }));
          rawLinks = raw.edges.map((e) => ({ from: e.from, to: e.to, k: "d" as const, type: e.type_id, payload: e.payload ?? {} }));
        } else {
          const raw = (await api.domainModelGraph(token)) as unknown as { nodes: RawNode[]; edges: RawEdge[] };
          nodes = raw.nodes.map((n) => ({
            key: n.key, id: String(n.payload.id ?? ""), name: n.name || String(n.payload.name ?? n.payload.id ?? ""),
            bucket: String(n.payload.bucket ?? ""), ext: (n.payload.extends as string | null) ?? null,
            abstract: Boolean(n.payload.abstract), fields: Number(n.payload.field_count ?? 0), rels: Number(n.payload.relation_count ?? 0),
            props: n.payload ?? {},
            x: 0, y: 0, vx: 0, vy: 0, out: [], in: [],
          }));
          rawLinks = raw.edges.map((e) => ({ from: e.from, to: e.to, k: e.type_id.includes("inherits") ? "i" as const : "d" as const, type: e.type_id, payload: e.payload ?? {} }));
        }
      } catch (e) {
        if (!disposed) { setError(errText(e)); setLoading(false); }
        return;
      }
      if (disposed) return;

      const byKey = new Map(nodes.map((n) => [n.key, n]));
      nodesRef.current = byKey;
      const links: GLink[] = rawLinks
        .map((e) => ({ s: byKey.get(e.from)!, t: byKey.get(e.to)!, k: e.k, type: e.type, payload: e.payload }))
        .filter((l) => l.s && l.t);
      for (const l of links) { l.s.out.push(l); l.t.in.push(l); }

      const bkts = [...new Set(nodes.map((n) => n.bucket))].sort();
      const bIndex = new Map(bkts.map((b, i) => [b, i]));
      const bc: Record<string, number> = {};
      for (const n of nodes) bc[n.bucket] = (bc[n.bucket] || 0) + 1;
      const R = 340;
      nodes.forEach((n) => {
        const ba = ((bIndex.get(n.bucket) || 0) / bkts.length) * Math.PI * 2;
        const a = Math.random() * Math.PI * 2, r = 40 + Math.random() * 70;
        n.x = Math.cos(ba) * R + Math.cos(a) * r;
        n.y = Math.sin(ba) * R + Math.sin(a) * r;
      });

      setCounts({ n: nodes.length, i: links.filter((l) => l.k === "i").length, d: links.filter((l) => l.k === "d").length });
      setBuckets(bkts.map((b) => ({ b, n: bc[b] })));
      setLoading(false);

      const cv = canvasRef.current!, ctx = cv.getContext("2d")!;
      let W = 0, H = 0, DPR = 1;
      const view = { k: 0.85, x: 0, y: 0 };
      const resize = () => {
        const box = wrapRef.current!.getBoundingClientRect();
        DPR = Math.min(2, window.devicePixelRatio || 1);
        W = Math.max(1, box.width); H = Math.max(1, box.height);
        cv.width = W * DPR; cv.height = H * DPR;
        cv.style.width = W + "px"; cv.style.height = H + "px";
      };
      resize();
      view.x = W / 2; view.y = H / 2;
      const ro = new ResizeObserver(resize);
      ro.observe(wrapRef.current!);
      cleanup.push(() => ro.disconnect());

      // theme tokens read from the wrapper's computed style
      let TOK = { edge: "", edgeI: "", hi: "", text: "", bg: "" };
      const readTokens = () => {
        const dark = matchMedia("(prefers-color-scheme: dark)").matches;
        TOK = dark
          ? { edge: "rgba(205,220,245,0.10)", edgeI: "rgba(205,220,245,0.30)", hi: "rgba(122,167,255,0.95)", text: "#e7edf6", bg: "#0d1017" }
          : { edge: "rgba(24,32,49,0.10)", edgeI: "rgba(24,32,49,0.28)", hi: "rgba(37,99,235,0.9)", text: "#182031", bg: "#ffffff" };
      };
      readTokens();
      const mq = matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", readTokens);
      cleanup.push(() => mq.removeEventListener("change", readTokens));

      const F = filterRef.current;
      let hover: GNode | null = null, selected: GNode | null = null, selectedEdge: GLink | null = null;
      const visN = (n: GNode) => !F.off.has(n.bucket);
      const visL = (l: GLink) => (l.k === "i" ? F.i : F.d) && visN(l.s) && visN(l.t);
      // Focus mode: when on and a node is selected, isolate it + its direct
      // neighbours (one type and its relations).
      const focusSet = (): Set<GNode> | null =>
        F.focus && selected
          ? new Set<GNode>([selected, ...selected.out.map((l) => l.t), ...selected.in.map((l) => l.s)])
          : null;
      const radius = (n: GNode) => 4 + Math.sqrt(n.fields + n.rels) * 1.1;
      const sx = (n: GNode) => n.x * view.k + view.x, sy = (n: GNode) => n.y * view.k + view.y;

      let alpha = 1;
      const tick = () => {
        if (alpha < 0.02) return;
        const rep = 5000, cluster = 0.015;
        for (let i = 0; i < nodes.length; i++) {
          const a = nodes[i];
          for (let j = i + 1; j < nodes.length; j++) {
            const b = nodes[j];
            const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy || 0.01;
            if (d2 > 90000) continue;
            const d = Math.sqrt(d2), f = rep / d2;
            const fx = (dx / d) * f, fy = (dy / d) * f;
            a.vx += fx; a.vy += fy; b.vx -= fx; b.vy -= fy;
          }
        }
        for (const l of links) {
          const dx = l.t.x - l.s.x, dy = l.t.y - l.s.y, d = Math.hypot(dx, dy) || 0.01;
          const f = (d - (l.k === "i" ? 60 : 92)) * (l.k === "i" ? 0.06 : 0.035);
          const fx = (dx / d) * f, fy = (dy / d) * f;
          l.s.vx += fx; l.s.vy += fy; l.t.vx -= fx; l.t.vy -= fy;
        }
        for (const n of nodes) {
          const ba = ((bIndex.get(n.bucket) || 0) / bkts.length) * Math.PI * 2;
          n.vx += (Math.cos(ba) * R - n.x) * cluster;
          n.vy += (Math.sin(ba) * R - n.y) * cluster;
          n.vx -= n.x * 0.002; n.vy -= n.y * 0.002;
          if (n === dragging) continue;
          n.vx *= 0.86; n.vy *= 0.86;
          n.x += n.vx * alpha; n.y += n.vy * alpha;
        }
        alpha *= 0.985;
      };

      const draw = () => {
        ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
        ctx.clearRect(0, 0, W, H);
        const fs = focusSet();
        const hl = hover || selected;
        const near = hl ? new Set<GNode>([hl, ...hl.out.map((l) => l.t), ...hl.in.map((l) => l.s)]) : null;
        for (const l of links) {
          if (!visL(l) || (fs && !(fs.has(l.s) && fs.has(l.t)))) continue;
          const onE = l === selectedEdge;
          const on = onE || (hl != null && (l.s === hl || l.t === hl));
          ctx.globalAlpha = hl && !on ? 0.06 : 1;
          ctx.beginPath(); ctx.moveTo(sx(l.s), sy(l.s)); ctx.lineTo(sx(l.t), sy(l.t));
          ctx.strokeStyle = on ? TOK.hi : l.k === "i" ? TOK.edgeI : TOK.edge;
          ctx.lineWidth = onE ? 2.6 : on ? 1.6 : l.k === "i" ? 1.1 : 0.7;
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
        const q = F.q.toLowerCase();
        for (const n of nodes) {
          if (!visN(n) || (fs && !fs.has(n))) continue;
          const dim = (hl != null && near != null && !near.has(n)) || (q !== "" && !(n.name.toLowerCase().includes(q) || n.id.includes(q)));
          const r = radius(n) * (n === hl ? 1.35 : 1) * view.k * 0.9 + 0.5;
          ctx.globalAlpha = dim ? 0.14 : 1;
          ctx.beginPath(); ctx.arc(sx(n), sy(n), r, 0, Math.PI * 2);
          ctx.fillStyle = colorOf(n.bucket); ctx.fill();
          if (n.abstract) { ctx.setLineDash([2, 2]); ctx.lineWidth = 1.4; ctx.strokeStyle = colorOf(n.bucket); ctx.stroke(); ctx.setLineDash([]); }
          else if (n === hl) { ctx.lineWidth = 2; ctx.strokeStyle = TOK.text; ctx.stroke(); }
          if ((hl != null && near != null && near.has(n)) || (selectedEdge != null && (n === selectedEdge.s || n === selectedEdge.t)) || view.k > 1.7 || (q !== "" && !dim)) {
            ctx.globalAlpha = dim ? 0.2 : 1; ctx.fillStyle = TOK.text;
            ctx.font = "600 " + (n === hl ? 13 : 11) + "px system-ui, sans-serif"; ctx.textBaseline = "middle";
            ctx.fillText(n.name, sx(n) + r + 6, sy(n));
          }
        }
        ctx.globalAlpha = 1;
      };

      const loop = () => { tick(); draw(); raf = requestAnimationFrame(loop); };
      raf = requestAnimationFrame(loop);

      const pick = (mx: number, my: number): GNode | null => {
        let best: GNode | null = null, bd = Infinity;
        const fs = focusSet();
        for (const n of nodes) {
          if (!visN(n) || (fs && !fs.has(n))) continue;
          const dx = sx(n) - mx, dy = sy(n) - my, d = dx * dx + dy * dy;
          const rr = (radius(n) * view.k + 9) ** 2;
          if (d < rr && d < bd) { best = n; bd = d; }
        }
        return best;
      };

      const doSelect = (n: GNode | null) => { selected = n; selectedEdge = null; setSel(n); setSelEdge(null); };
      const doSelectEdge = (e: GLink | null) => { selectedEdge = e; selected = null; setSelEdge(e); setSel(null); };
      ctrlRef.current = {
        select: (key) => {
          const n = key ? byKey.get(key) ?? null : null;
          doSelect(n);
          if (n) { view.k = Math.max(view.k, 1.5); view.x = W / 2 - n.x * view.k; view.y = H / 2 - n.y * view.k; }
        },
        clearEdge: () => doSelectEdge(null),
      };
      // Nearest visible edge within a few px of (mx,my) — point-to-segment.
      const pickEdge = (mx: number, my: number): GLink | null => {
        let best: GLink | null = null, bd = 8 * 8;
        for (const l of links) {
          if (!visL(l)) continue;
          const ax = sx(l.s), ay = sy(l.s), bx = sx(l.t), by = sy(l.t);
          const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1;
          let t = ((mx - ax) * dx + (my - ay) * dy) / len2;
          t = Math.max(0, Math.min(1, t));
          const px = ax + t * dx, py = ay + t * dy;
          const d = (mx - px) ** 2 + (my - py) ** 2;
          if (d < bd) { bd = d; best = l; }
        }
        return best;
      };

      let dragging: GNode | null = null, panning = false, last = { x: 0, y: 0 }, moved = false;
      const rel = (e: PointerEvent) => { const b = cv.getBoundingClientRect(); return { x: e.clientX - b.left, y: e.clientY - b.top }; };
      const onDown = (e: PointerEvent) => {
        cv.setPointerCapture(e.pointerId); const p = rel(e); last = p; moved = false;
        const n = pick(p.x, p.y);
        if (n) { dragging = n; } else panning = true;
      };
      const onMove = (e: PointerEvent) => {
        const p = rel(e);
        if (dragging) { moved = true; dragging.x = (p.x - view.x) / view.k; dragging.y = (p.y - view.y) / view.k; dragging.vx = dragging.vy = 0; alpha = Math.max(alpha, 0.3); return; }
        if (panning) { moved = true; view.x += p.x - last.x; view.y += p.y - last.y; last = p; return; }
        hover = pick(p.x, p.y); cv.style.cursor = hover ? "pointer" : "grab";
      };
      const onUp = () => {
        if (dragging && !moved) doSelect(dragging);
        else if (panning && !moved) {
          const e = pickEdge(last.x, last.y);
          if (e) doSelectEdge(e);
          else doSelect(null);
        }
        dragging = null; panning = false;
      };
      const onWheel = (e: WheelEvent) => {
        e.preventDefault(); const b = cv.getBoundingClientRect(); const mx = e.clientX - b.left, my = e.clientY - b.top;
        const nk = Math.min(6, Math.max(0.2, view.k * Math.exp(-e.deltaY * 0.0012))), r = nk / view.k;
        view.x = mx - (mx - view.x) * r; view.y = my - (my - view.y) * r; view.k = nk;
      };
      cv.addEventListener("pointerdown", onDown);
      cv.addEventListener("pointermove", onMove);
      cv.addEventListener("pointerup", onUp);
      cv.addEventListener("wheel", onWheel, { passive: false });
      cleanup.push(() => {
        cv.removeEventListener("pointerdown", onDown);
        cv.removeEventListener("pointermove", onMove);
        cv.removeEventListener("pointerup", onUp);
        cv.removeEventListener("wheel", onWheel);
      });
    })();

    return () => { disposed = true; cancelAnimationFrame(raf); cleanup.forEach((f) => f()); };
  }, [token, mode]);

  const repaint = () => force((x) => x + 1);
  const setFilter = (patch: Partial<typeof filterRef.current>) => { Object.assign(filterRef.current, patch); repaint(); };
  const toggleBucket = (b: string) => { const off = filterRef.current.off; if (off.has(b)) off.delete(b); else off.add(b); repaint(); };

  const F = filterRef.current;
  const decl = sel ? sel.out.filter((l) => l.k === "d").map((l) => l.t) : [];
  const subs = sel ? sel.in.filter((l) => l.k === "i").map((l) => l.s) : [];

  return (
    <div className="dmg" ref={wrapRef}>
      <style>{DMG_CSS}</style>
      <canvas ref={canvasRef} className="dmg-canvas" />
      <div className="dmg-bar">
        <span className="dmg-mode">
          <button className={mode === "types" ? "on" : ""} onClick={() => setMode("types")}>Types</button>
          <button className={mode === "instances" ? "on" : ""} onClick={() => setMode("instances")}>Instances</button>
        </span>
        <span className="dmg-counts">
          {mode === "instances"
            ? <><b>{counts.n}</b> objects · <b>{counts.d}</b> relations</>
            : <><b>{counts.n}</b> types · <b>{counts.i}</b> inherits · <b>{counts.d}</b> declares</>}
        </span>
        <input className="dmg-search" type="search" placeholder="Find a type…" spellCheck={false}
          onChange={(e) => setFilter({ q: e.target.value.trim() })} />
        <label className="dmg-tog"><input type="checkbox" checked={F.i} onChange={(e) => setFilter({ i: e.target.checked })} /> inherits</label>
        <label className="dmg-tog"><input type="checkbox" checked={F.d} onChange={(e) => setFilter({ d: e.target.checked })} /> declares</label>
      </div>

      {loading && <div className="dmg-msg">Loading graph…</div>}
      {error && <div className="dmg-msg dmg-err">{error}</div>}
      {!loading && !error && counts.n === 0 && (
        <div className="dmg-msg">
          {mode === "instances"
            ? "No objects yet — create some in the panel above, then relate them."
            : "Model is empty — run Sync to graph first."}
        </div>
      )}

      {buckets.length > 0 && (
        <div className="dmg-legend">
          {buckets.map(({ b, n }) => (
            <div key={b} className={"dmg-lrow" + (F.off.has(b) ? " off" : "")} onClick={() => toggleBucket(b)}>
              <span className="dmg-dot" style={{ background: colorOf(b) }} /><span>{b}</span><span className="dmg-n">{n}</span>
            </div>
          ))}
        </div>
      )}

      {sel && (
        <div className="dmg-detail">
          <button className="dmg-close" aria-label="Close" onClick={() => ctrlRef.current?.select(null)}>×</button>
          <span className="dmg-kind"><span className="dmg-dot" style={{ background: colorOf(sel.bucket) }} />{sel.bucket}{sel.abstract ? " · abstract" : ""}</span>
          <h3>{sel.name}</h3>
          <div className="dmg-id">{sel.id}</div>
          <button className={"dmg-focus" + (F.focus ? " on" : "")}
            onClick={() => setFilter({ focus: !F.focus })}>
            {F.focus ? "Show whole graph" : "Focus this type + relations"}
          </button>
          {sel.ext && <div className="dmg-rel">extends <a onClick={() => selectByEntity(nodesRef.current, sel.ext!, ctrlRef.current)}>{sel.ext}</a></div>}
          <div className="dmg-stats">
            <div><b>{sel.fields}</b><span>fields</span></div>
            <div><b>{sel.rels}</b><span>relations</span></div>
            <div><b>{subs.length}</b><span>subtypes</span></div>
          </div>
          {Object.keys(sel.props).length > 0 && (
            <div className="dmg-sec">
              <h4>Stored in graph</h4>
              {Object.entries(sel.props).map(([k, v]) => (
                <div className="dmg-prop" key={k}>
                  <span className="dmg-pk">{k}</span>
                  <span className="dmg-pv">{fmtVal(v)}</span>
                </div>
              ))}
            </div>
          )}
          <RelList title={`Declares → (${decl.length})`} items={decl.slice(0, 30)} ctrl={ctrlRef} />
          {subs.length > 0 && <RelList title={`Subtypes (${subs.length})`} items={subs.slice(0, 30)} ctrl={ctrlRef} />}
        </div>
      )}

      {selEdge && (
        <div className="dmg-detail">
          <button className="dmg-close" aria-label="Close" onClick={() => ctrlRef.current?.clearEdge()}>×</button>
          <span className="dmg-kind">{edgeVerb(selEdge)} edge</span>
          <h3>{selEdge.s.name} <span className="dmg-arrow">→</span> {selEdge.t.name}</h3>
          <div className="dmg-id">{selEdge.s.id} → {selEdge.t.id}</div>
          {Object.keys(selEdge.payload).length > 0 ? (
            <div className="dmg-sec">
              <h4>Edge properties (stored in graph)</h4>
              {Object.entries(selEdge.payload).map(([k, v]) => (
                <div className="dmg-prop" key={k}><span className="dmg-pk">{k}</span><span className="dmg-pv">{fmtVal(v)}</span></div>
              ))}
            </div>
          ) : (
            <div className="dmg-rel dmg-muted" style={{ marginTop: 10 }}>No stored properties on this edge.</div>
          )}
        </div>
      )}
    </div>
  );
}

function edgeVerb(l: GLink): string {
  if (l.type.includes("inherits")) return "inherits";
  if (l.type.includes("declares")) return "declares";
  const toks = l.type.replace(/~$/, "").split(".");
  return toks.length >= 2 ? toks[toks.length - 2] : l.type;
}

function fmtVal(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  return String(v);
}

function selectByEntity(byKey: Map<string, GNode>, entityId: string, ctrl: Ctrl | null) {
  for (const n of byKey.values()) if (n.id === entityId) { ctrl?.select(n.key); return; }
}

function RelList({ title, items, ctrl }: { title: string; items: GNode[]; ctrl: RefObject<Ctrl | null> }) {
  return (
    <div className="dmg-sec">
      <h4>{title}</h4>
      {items.length === 0 ? <div className="dmg-rel dmg-muted">none</div> : items.map((m) => (
        <div key={m.key} className="dmg-rel">
          <a onClick={() => ctrl.current?.select(m.key)}>{m.name}</a><span className="dmg-muted">{m.bucket}</span>
        </div>
      ))}
    </div>
  );
}

const DMG_CSS = `
.dmg { position: relative; width: 100%; height: 70vh; min-height: 420px; border: 1px solid var(--dmg-border, #e3e8ef); border-radius: 12px; overflow: hidden; background: var(--dmg-bg, #f5f7fa); }
.dmg-canvas { display: block; width: 100%; height: 100%; }
.dmg-bar { position: absolute; top: 10px; left: 10px; right: 10px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; font: 12px/1.4 system-ui, sans-serif; }
.dmg-mode { display: inline-flex; border: 1px solid #d7deea; border-radius: 8px; overflow: hidden; }
.dmg-mode button { font: inherit; border: none; background: rgba(255,255,255,.7); color: #64748b; padding: 5px 11px; cursor: pointer; }
.dmg-mode button + button { border-left: 1px solid #d7deea; }
.dmg-mode button.on { background: #2563eb; color: #fff; }
.dmg-counts { color: #64748b; font-variant-numeric: tabular-nums; } .dmg-counts b { color: inherit; }
.dmg-search { font: inherit; padding: 5px 9px; border: 1px solid #d7deea; border-radius: 8px; background: rgba(255,255,255,.8); outline: none; margin-left: auto; }
.dmg-tog { display: inline-flex; gap: 5px; align-items: center; color: #64748b; user-select: none; cursor: pointer; }
.dmg-legend { position: absolute; left: 10px; bottom: 10px; background: rgba(255,255,255,.9); border: 1px solid #e3e8ef; border-radius: 10px; padding: 7px; font: 12px/1.3 system-ui, sans-serif; max-height: 46%; overflow: auto; }
.dmg-lrow { display: flex; gap: 7px; align-items: center; padding: 2px 4px; border-radius: 6px; cursor: pointer; } .dmg-lrow:hover { background: rgba(0,0,0,.04); } .dmg-lrow.off { opacity: .38; }
.dmg-dot { width: 10px; height: 10px; border-radius: 3px; flex: none; } .dmg-n { margin-left: auto; color: #94a3b8; font-variant-numeric: tabular-nums; }
.dmg-detail { position: absolute; right: 10px; top: 44px; width: 270px; max-height: calc(100% - 60px); overflow: auto; background: #fff; border: 1px solid #e3e8ef; border-radius: 12px; padding: 14px; box-shadow: 0 8px 30px rgba(20,30,55,.12); font: 13px/1.5 system-ui, sans-serif; }
.dmg-close { float: right; border: none; background: none; font-size: 18px; line-height: 1; color: #94a3b8; cursor: pointer; }
.dmg-kind { font-size: 10.5px; text-transform: uppercase; letter-spacing: .05em; color: #64748b; display: inline-flex; gap: 6px; align-items: center; }
.dmg-detail h3 { margin: 5px 0 2px; font-size: 17px; } .dmg-id { font: 11.5px var(--mono, monospace); color: #94a3b8; word-break: break-all; }
.dmg-arrow { color: #94a3b8; }
.dmg-focus { margin-top: 10px; width: 100%; font: 12px system-ui, sans-serif; padding: 6px 10px; border: 1px solid #d7deea; border-radius: 8px; background: #f5f7fa; color: #334155; cursor: pointer; }
.dmg-focus:hover { border-color: #2563eb; color: #2563eb; } .dmg-focus.on { background: #2563eb; border-color: #2563eb; color: #fff; }
.dmg-stats { display: flex; gap: 7px; margin: 12px 0; } .dmg-stats > div { flex: 1; background: #f5f7fa; border: 1px solid #e3e8ef; border-radius: 9px; padding: 7px 9px; } .dmg-stats b { display: block; font-size: 17px; font-variant-numeric: tabular-nums; } .dmg-stats span { font-size: 10px; text-transform: uppercase; color: #94a3b8; letter-spacing: .04em; }
.dmg-sec { margin-top: 12px; } .dmg-sec h4 { margin: 0 0 5px; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: #64748b; }
.dmg-rel { padding: 2px 0; display: flex; gap: 6px; } .dmg-rel a { color: #2563eb; cursor: pointer; } .dmg-rel a:hover { text-decoration: underline; } .dmg-muted { color: #94a3b8; font-size: 11.5px; }
.dmg-prop { display: grid; grid-template-columns: 88px 1fr; gap: 8px; padding: 2px 0; align-items: baseline; }
.dmg-pk { color: #64748b; font: 11px var(--mono, monospace); overflow: hidden; text-overflow: ellipsis; }
.dmg-pv { font: 12px var(--mono, monospace); word-break: break-word; }
.dmg-msg { position: absolute; inset: 0; display: grid; place-items: center; color: #64748b; font: 13px system-ui, sans-serif; } .dmg-err { color: #dc2626; }
@media (prefers-color-scheme: dark) {
  .dmg { --dmg-border: #263040; --dmg-bg: #0d1017; }
  .dmg-search { background: rgba(30,38,50,.8); border-color: #2b3646; color: #e7edf6; }
  .dmg-legend, .dmg-detail { background: rgba(21,27,36,.95); border-color: #263040; color: #e7edf6; }
  .dmg-lrow:hover { background: rgba(255,255,255,.06); }
  .dmg-stats > div { background: #10151d; border-color: #263040; }
  .dmg-focus { background: #10151d; border-color: #2b3646; color: #cdd7e5; }
  .dmg-mode { border-color: #2b3646; } .dmg-mode button { background: rgba(30,38,50,.7); color: #93a1b5; } .dmg-mode button + button { border-color: #2b3646; }
}
`;
