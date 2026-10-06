import * as React from '@theia/core/shared/react';
import { inject, injectable, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { Message } from '@theia/core/lib/browser/widgets/widget';
import { StudioApi, isSignedOut } from './studio-api';
import { OpenInEditorFrontendController } from './open-in-editor-controller';

// Local mirror of the studio-artifact-ingest DTOs. Index signatures let the
// inspector surface every field the graph store returns, not just the typed few.
interface ArtifactNode {
    readonly type_id: string;
    readonly instance_id: string;
    readonly value: {
        repo?: string;
        full_path?: string;
        path?: string;
        number?: number;
        title?: string;
        login?: string;
        [key: string]: unknown;
    };
    readonly [key: string]: unknown;
}

// GET /v1/edges — a relation between two nodes, endpoints by instance id.
// type_id ~ `…rel.authored_by…`, `…rel.modifies…`, `…rel.artifact_of…`,
// `…rel.contains…`.
interface ArtifactEdge {
    readonly type_id: string;
    readonly from: string;
    readonly to: string;
    readonly [key: string]: unknown;
}

type GraphKind = 'repo' | 'issue' | 'pr' | 'file' | 'user' | 'finding' | 'comment' | 'commit';
const ALL_KINDS: readonly GraphKind[] = ['repo', 'issue', 'pr', 'file', 'user', 'finding', 'comment', 'commit'];

const GRAPH_COLORS: Record<GraphKind, string> = {
    repo: '#3b82f6',
    issue: '#10b981',
    pr: '#8b5cf6',
    file: '#f59e0b',
    user: '#ec4899',
    finding: '#fb7185',
    comment: '#22d3ee',
    commit: '#a3a3a3',
};

const KIND_LABEL: Record<GraphKind, string> = {
    repo: 'Repository',
    issue: 'Issue',
    pr: 'Pull request',
    file: 'File',
    user: 'User',
    finding: 'Spec finding',
    comment: 'Comment',
    commit: 'Commit',
};

function nodeKind(n: ArtifactNode): GraphKind {
    const t = n.type_id;
    if (t.includes('spec_finding')) {
        return 'finding';
    }
    if (t.includes('comment')) {
        return 'comment';
    }
    if (t.includes('commit')) {
        return 'commit';
    }
    if (t.includes('pull_request')) {
        return 'pr';
    }
    if (t.includes('issue')) {
        return 'issue';
    }
    if (t.includes('file')) {
        return 'file';
    }
    if (t.includes('user') || t.includes('actor') || t.includes('account')) {
        return 'user';
    }
    return 'repo';
}

function nodeLabel(n: ArtifactNode): string {
    const v = n.value;
    const kind = nodeKind(n);
    if (kind === 'file') {
        return String(v.path ?? '(file)');
    }
    if (kind === 'user') {
        return String(v.login ?? v.title ?? '(user)');
    }
    if (kind === 'finding') {
        return String(v.title ?? v.summary ?? v.detector ?? 'finding');
    }
    if (kind === 'comment') {
        return String(v.title ?? (v.target_number != null ? `comment on #${v.target_number}` : 'comment'));
    }
    if (kind === 'commit') {
        return String(v.title ?? v.short_sha ?? 'commit');
    }
    if (kind === 'repo') {
        return String(v.full_path ?? v.repo ?? 'repository');
    }
    return `${v.number != null ? `#${v.number} ` : ''}${v.title ?? '(untitled)'}`;
}

function shortLabel(kind: GraphKind, label: string): string {
    if (kind === 'file') {
        const base = label.split('/').pop() ?? label;
        return base.length > 26 ? `${base.slice(0, 25)}…` : base;
    }
    return label.length > 30 ? `${label.slice(0, 29)}…` : label;
}

// ── Clustering ──
// A 2000-file repo renders as one hub with a uniform burst of leaves. Grouping
// assigns each node a cluster; the layout then anchors clusters apart and the
// draw pass tints each as a labelled region, so the burst reads as structure.
type GroupMode = 'folder' | 'repo' | 'type';
const GROUP_LABEL: Record<GroupMode, string> = { folder: 'Folder', repo: 'Repository', type: 'Type' };

/** Stable low-saturation hue from a cluster key, for its hull tint. */
function clusterHue(key: string): number {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % 360;
}

/** The cluster a node falls into under the current grouping, plus a short label
 *  for the hull. `repoNames` maps a repo instance id to its display label. */
function clusterOf(n: ArtifactNode, mode: GroupMode, repoNames: Map<string, string>): { key: string; label: string } {
    const kind = nodeKind(n);
    if (mode === 'type') {
        return { key: `t:${kind}`, label: KIND_LABEL[kind] };
    }
    const repoId = kind === 'repo'
        ? n.instance_id
        : (typeof n.value.repo === 'string' ? n.value.repo : '');
    const repoLabel = (repoId && repoNames.get(repoId)) || (repoId ? repoId.slice(0, 8) : 'unscoped');
    if (mode === 'repo') {
        return { key: `r:${repoId || 'none'}`, label: repoLabel };
    }
    // folder: files cluster by their top path segment (within their repo);
    // everything else clusters by kind so issues/PRs/users stay coherent.
    if (kind === 'file') {
        const p = typeof n.value.path === 'string' ? n.value.path : '';
        const segs = p.replace(/^\/+/, '').split('/');
        const dir = segs.length > 1 ? segs[0] : '(root)';
        return { key: `f:${repoId}:${dir}`, label: dir };
    }
    return { key: `t:${kind}`, label: KIND_LABEL[kind] };
}

/** Human relation name from an edge type_id (`…rel.modifies…` → `modifies`). */
function relLabel(typeId: string): string {
    const m = /rel\.([a-z_]+)/.exec(typeId);
    if (m) {
        return m[1].replace(/_/g, ' ');
    }
    const parts = typeId.split('.');
    return parts[parts.length - 1] || typeId;
}

/** Full-text match over the fields a user would search by. Shared by the graph
 *  (highlight) and the shell (results list) so the two never disagree. */
function nodeMatches(n: ArtifactNode, q: string): boolean {
    const s = q.trim().toLowerCase();
    if (s.length === 0) {
        return false;
    }
    const v = n.value;
    const num = s.startsWith('#') ? s.slice(1) : s;
    const fields = [v.title, v.path, v.full_path, v.login, v.repo];
    for (const f of fields) {
        if (typeof f === 'string' && f.toLowerCase().includes(s)) {
            return true;
        }
    }
    if (v.number != null && String(v.number).includes(num)) {
        return true;
    }
    return false;
}

// ── Simulation types ──

interface SimNode {
    x: number;
    y: number;
    vx: number;
    vy: number;
    r: number;
    degree: number;
    kind: GraphKind;
    label: string;
    short: string;
    node: ArtifactNode;
    cluster: string;
    clusterLabel: string;
    fx: number | undefined;
    fy: number | undefined;
}

interface SimEdge {
    a: number;
    b: number;
    edge: ArtifactEdge; // real or synthesized — always inspectable
}

interface ThemeColors {
    bg: string;
    text: string;
    muted: string;
    border: string;
}

function themeColors(el: HTMLElement): ThemeColors {
    const cs = getComputedStyle(el);
    const v = (name: string, fb: string): string => {
        const x = cs.getPropertyValue(name).trim();
        return x.length > 0 ? x : fb;
    };
    return {
        bg: v('--theia-editor-background', '#0e1116'),
        text: v('--theia-foreground', '#e6e6e6'),
        muted: v('--theia-descriptionForeground', '#9aa0a6'),
        border: v('--theia-editorWidget-border', '#30363d'),
    };
}

interface GraphModel {
    sim: SimNode[];
    edges: SimEdge[];
    adj: number[][];
    idIndex: Map<string, number>;
    anchors: Map<string, { x: number; y: number }>;
}

function buildModel(
    nodes: readonly ArtifactNode[],
    edges: readonly ArtifactEdge[],
    visibleKinds: ReadonlySet<GraphKind>,
    hideLeafFiles: boolean,
    groupMode: GroupMode,
): GraphModel {
    const visible = nodes.filter(n => visibleKinds.has(nodeKind(n)));
    const indexById = new Map<string, number>();
    visible.forEach((n, i) => indexById.set(n.instance_id, i));

    const pairs: Array<{ a: number; b: number; edge: ArtifactEdge }> = [];
    for (const e of edges) {
        const a = indexById.get(e.from);
        const b = indexById.get(e.to);
        if (a !== undefined && b !== undefined && a !== b) {
            pairs.push({ a, b, edge: e });
        }
    }
    if (pairs.length === 0) {
        visible.forEach((n, i) => {
            const repoId = typeof n.value.repo === 'string' ? n.value.repo : undefined;
            const repoRef = repoId !== undefined ? indexById.get(repoId) : undefined;
            if (repoRef !== undefined && repoRef !== i) {
                pairs.push({
                    a: repoRef,
                    b: i,
                    edge: { type_id: 'studio.rel.contains.synthesized', from: repoId!, to: n.instance_id },
                });
            }
        });
    }

    const degree = new Array<number>(visible.length).fill(0);
    for (const p of pairs) {
        degree[p.a]++;
        degree[p.b]++;
    }

    let keep = visible.map((_, i) => i);
    if (hideLeafFiles) {
        const drop = new Set<number>();
        visible.forEach((n, i) => {
            if (nodeKind(n) === 'file' && degree[i] <= 1) {
                drop.add(i);
            }
        });
        keep = keep.filter(i => !drop.has(i));
    }
    const remap = new Map<number, number>();
    keep.forEach((old, neu) => remap.set(old, neu));

    const GOLDEN = 2.399963229728653;
    // Repo id → label, so folder/repo clusters get a human name.
    const repoNames = new Map<string, string>();
    for (const n of visible) {
        if (nodeKind(n) === 'repo') {
            repoNames.set(n.instance_id, nodeLabel(n));
        }
    }
    const idIndex = new Map<string, number>();
    const sim: SimNode[] = keep.map((old, i) => {
        const n = visible[old];
        const kind = nodeKind(n);
        const label = nodeLabel(n);
        const deg = degree[old];
        const rad = 6 * Math.sqrt(i + 1);
        const cl = clusterOf(n, groupMode, repoNames);
        idIndex.set(n.instance_id, i);
        return {
            x: Math.cos(i * GOLDEN) * rad,
            y: Math.sin(i * GOLDEN) * rad,
            vx: 0,
            vy: 0,
            r: Math.min(16, 3.5 + Math.sqrt(deg) * 1.7),
            degree: deg,
            kind,
            label,
            short: shortLabel(kind, label),
            node: n,
            cluster: cl.key,
            clusterLabel: cl.label,
            fx: undefined,
            fy: undefined,
        };
    });

    // Cluster anchors: the largest cluster sits at the centre, the rest spiral
    // out on a golden angle so groups occupy distinct regions of the canvas
    // instead of collapsing into one burst around the hub.
    const clusterSizes = new Map<string, number>();
    for (const s of sim) {
        clusterSizes.set(s.cluster, (clusterSizes.get(s.cluster) ?? 0) + 1);
    }
    const anchors = new Map<string, { x: number; y: number }>();
    [...clusterSizes.entries()]
        .sort((a, b) => b[1] - a[1])
        .forEach(([key], i) => {
            const ar = 150 * Math.sqrt(i);
            const aa = i * GOLDEN;
            anchors.set(key, { x: Math.cos(aa) * ar, y: Math.sin(aa) * ar });
        });

    const simEdges: SimEdge[] = [];
    for (const p of pairs) {
        const na = remap.get(p.a);
        const nb = remap.get(p.b);
        if (na !== undefined && nb !== undefined) {
            simEdges.push({ a: na, b: nb, edge: p.edge });
        }
    }
    const adj: number[][] = sim.map(() => []);
    for (const e of simEdges) {
        adj[e.a].push(e.b);
        adj[e.b].push(e.a);
    }
    return { sim, edges: simEdges, adj, idIndex, anchors };
}

// Distance from point p to segment ab (world units).
function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
}

// ── Force-directed canvas graph ──

interface ForceGraphProps {
    readonly nodes: readonly ArtifactNode[];
    readonly edges: readonly ArtifactEdge[];
    readonly kindsKey: string;
    readonly hideLeafFiles: boolean;
    readonly groupMode: GroupMode;
    readonly showClusters: boolean;
    readonly query: string;
    readonly selectedToken: string;                       // 'node:<id>' | 'edge:<from>|<to>' | ''
    readonly onSelectNode: (n: ArtifactNode | undefined) => void;
    readonly onSelectEdge: (e: ArtifactEdge) => void;
    readonly fitSignal: number;
    readonly focusId: string | undefined;
    readonly focusSignal: number;
}

function ForceGraph(props: ForceGraphProps): React.ReactElement {
    const containerRef = React.useRef<HTMLDivElement | null>(null);
    const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

    const model = React.useRef<GraphModel>(
        { sim: [], edges: [], adj: [], idIndex: new Map(), anchors: new Map() });
    const view = React.useRef({ k: 1, tx: 0, ty: 0 });
    const alpha = React.useRef(1);
    const running = React.useRef(false);
    const raf = React.useRef(0);
    const hover = React.useRef<number>(-1);
    const matched = React.useRef<Set<number>>(new Set());
    const matchActive = React.useRef(false);
    const selNode = React.useRef<number>(-1);
    const selEdge = React.useRef<{ a: number; b: number } | undefined>(undefined);
    const drag = React.useRef<{ idx: number; moved: boolean } | undefined>(undefined);
    const pan = React.useRef<{ x: number; y: number; moved: boolean } | undefined>(undefined);
    const size = React.useRef({ w: 1, h: 1, dpr: 1 });

    const {
        nodes, edges, kindsKey, hideLeafFiles, groupMode, showClusters, query, selectedToken,
        onSelectNode, onSelectEdge, fitSignal, focusId, focusSignal,
    } = props;

    const recomputeMatches = React.useCallback((q: string): void => {
        const set = new Set<number>();
        const active = q.trim().length > 0;
        if (active) {
            model.current.sim.forEach((s, i) => {
                if (nodeMatches(s.node, q)) {
                    set.add(i);
                }
            });
        }
        matched.current = set;
        matchActive.current = active;
    }, []);

    const applySelection = React.useCallback((tok: string): void => {
        if (tok.startsWith('node:')) {
            selNode.current = model.current.idIndex.get(tok.slice(5)) ?? -1;
            selEdge.current = undefined;
        } else if (tok.startsWith('edge:')) {
            const sep = tok.indexOf('|');
            const a = model.current.idIndex.get(tok.slice(5, sep));
            const b = model.current.idIndex.get(tok.slice(sep + 1));
            selEdge.current = a !== undefined && b !== undefined ? { a, b } : undefined;
            selNode.current = -1;
        } else {
            selNode.current = -1;
            selEdge.current = undefined;
        }
    }, []);

    React.useEffect(() => {
        const visibleKinds = new Set(kindsKey.split(',').filter(Boolean) as GraphKind[]);
        model.current = buildModel(nodes, edges, visibleKinds, hideLeafFiles, groupMode);
        recomputeMatches(query);
        applySelection(selectedToken);
        alpha.current = 1;
        reheat();
        const t = window.setTimeout(() => fit(), 900);
        return () => window.clearTimeout(t);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [nodes, edges, kindsKey, hideLeafFiles, groupMode]);

    React.useEffect(() => {
        draw();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showClusters]);

    React.useEffect(() => {
        recomputeMatches(query);
        draw();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [query]);

    React.useEffect(() => {
        applySelection(selectedToken);
        draw();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedToken]);

    React.useEffect(() => {
        if (fitSignal > 0) {
            fit();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fitSignal]);

    React.useEffect(() => {
        if (focusSignal > 0 && focusId) {
            focusOn(focusId);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [focusSignal]);

    function reheat(target = 0.5): void {
        alpha.current = Math.max(alpha.current, target);
        if (!running.current) {
            running.current = true;
            raf.current = window.requestAnimationFrame(step);
        }
    }

    function fit(): void {
        const sim = model.current.sim;
        if (sim.length === 0) {
            return;
        }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of sim) {
            minX = Math.min(minX, n.x);
            minY = Math.min(minY, n.y);
            maxX = Math.max(maxX, n.x);
            maxY = Math.max(maxY, n.y);
        }
        const { w, h } = size.current;
        const k = Math.min(w / (Math.max(1, maxX - minX) + 160), h / (Math.max(1, maxY - minY) + 160));
        view.current.k = Math.max(0.03, Math.min(2.5, k));
        view.current.tx = w / 2 - view.current.k * ((minX + maxX) / 2);
        view.current.ty = h / 2 - view.current.k * ((minY + maxY) / 2);
        draw();
    }

    function focusOn(id: string): void {
        const idx = model.current.idIndex.get(id);
        if (idx === undefined) {
            return;
        }
        const s = model.current.sim[idx];
        const { w, h } = size.current;
        view.current.k = Math.max(view.current.k, 1.3);
        view.current.tx = w / 2 - view.current.k * s.x;
        view.current.ty = h / 2 - view.current.k * s.y;
        draw();
    }

    function simulate(): void {
        const { sim, edges: es } = model.current;
        const a = alpha.current;
        const n = sim.length;
        if (n === 0) {
            return;
        }
        const CELL = 72;
        const REP = 1400;
        const SPRING = 0.045;
        const LINK = 46;
        const GRAVITY = 0.025;
        const VDECAY = 0.82;
        const MAXV = 40;
        // Pull toward the node's cluster anchor instead of the origin, so groups
        // settle into separate regions. Springs to a super-hub (a repo with
        // hundreds of contained files) are damped, or every leaf snaps back to
        // the centre and the clustering is undone.
        const CLUSTER_PULL = 0.05;
        const HUB_DEGREE = 120;
        const anchors = model.current.anchors;

        const grid = new Map<number, number[]>();
        const key = (cx: number, cy: number): number => (cx + 16384) * 40000 + (cy + 16384);
        for (let i = 0; i < n; i++) {
            const cx = Math.floor(sim[i].x / CELL);
            const cy = Math.floor(sim[i].y / CELL);
            const kk = key(cx, cy);
            const b = grid.get(kk);
            if (b) {
                b.push(i);
            } else {
                grid.set(kk, [i]);
            }
        }

        const ax = new Float64Array(n);
        const ay = new Float64Array(n);

        for (let i = 0; i < n; i++) {
            const ni = sim[i];
            const cx = Math.floor(ni.x / CELL);
            const cy = Math.floor(ni.y / CELL);
            for (let gx = -1; gx <= 1; gx++) {
                for (let gy = -1; gy <= 1; gy++) {
                    const b = grid.get(key(cx + gx, cy + gy));
                    if (!b) {
                        continue;
                    }
                    for (const j of b) {
                        if (j <= i) {
                            continue;
                        }
                        const nj = sim[j];
                        let dx = ni.x - nj.x;
                        let dy = ni.y - nj.y;
                        let d2 = dx * dx + dy * dy;
                        if (d2 > (CELL * 2) * (CELL * 2)) {
                            continue;
                        }
                        if (d2 < 0.01) {
                            dx = (i - j) * 0.1 + 0.05;
                            dy = 0.05;
                            d2 = dx * dx + dy * dy;
                        }
                        const invd = 1 / Math.sqrt(d2);
                        const f = (REP * a) / d2;
                        const fx = f * dx * invd;
                        const fy = f * dy * invd;
                        ax[i] += fx;
                        ay[i] += fy;
                        ax[j] -= fx;
                        ay[j] -= fy;
                    }
                }
            }
        }

        for (const e of es) {
            const na = sim[e.a];
            const nb = sim[e.b];
            const dx = nb.x - na.x;
            const dy = nb.y - na.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 0.01;
            const spring = (na.degree > HUB_DEGREE || nb.degree > HUB_DEGREE) ? SPRING * 0.12 : SPRING;
            const f = ((d - LINK) / d) * spring * a;
            ax[e.a] += dx * f;
            ay[e.a] += dy * f;
            ax[e.b] -= dx * f;
            ay[e.b] -= dy * f;
        }

        for (let i = 0; i < n; i++) {
            const an = anchors.get(sim[i].cluster);
            if (an) {
                ax[i] += (an.x - sim[i].x) * CLUSTER_PULL * a;
                ay[i] += (an.y - sim[i].y) * CLUSTER_PULL * a;
            } else {
                ax[i] += -sim[i].x * GRAVITY * a;
                ay[i] += -sim[i].y * GRAVITY * a;
            }
        }

        for (let i = 0; i < n; i++) {
            const s = sim[i];
            if (s.fx !== undefined && s.fy !== undefined) {
                s.x = s.fx;
                s.y = s.fy;
                s.vx = 0;
                s.vy = 0;
                continue;
            }
            s.vx = (s.vx + ax[i]) * VDECAY;
            s.vy = (s.vy + ay[i]) * VDECAY;
            const v = Math.hypot(s.vx, s.vy);
            if (v > MAXV) {
                s.vx = (s.vx / v) * MAXV;
                s.vy = (s.vy / v) * MAXV;
            }
            s.x += s.vx;
            s.y += s.vy;
        }

        alpha.current += (0 - alpha.current) * 0.02;
    }

    function step(): void {
        const active = alpha.current > 0.01;
        if (active) {
            simulate();
        }
        draw();
        if (active || drag.current) {
            raf.current = window.requestAnimationFrame(step);
        } else {
            running.current = false;
        }
    }

    function isLit(i: number, neighbours: Set<number> | undefined): boolean {
        if (matchActive.current && !matched.current.has(i)) {
            return false;
        }
        if (hover.current >= 0) {
            return i === hover.current || (neighbours !== undefined && neighbours.has(i));
        }
        return true;
    }

    function draw(): void {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) {
            return;
        }
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            return;
        }
        const { w, h, dpr } = size.current;
        const theme = themeColors(container);
        const { sim, edges: es, adj } = model.current;
        const { k, tx, ty } = view.current;
        const hi = hover.current;
        const neighbours = hi >= 0 ? new Set(adj[hi]) : undefined;
        const dim = matchActive.current || hi >= 0;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = theme.bg;
        ctx.fillRect(0, 0, w, h);
        ctx.translate(tx, ty);
        ctx.scale(k, k);

        // Cluster hulls: a soft tinted disc + label behind each group, at
        // overview zoom, so a 2000-node burst reads as labelled regions.
        if (showClusters && k < 2.2 && sim.length > 0) {
            const acc = new Map<string, { x: number; y: number; n: number; label: string }>();
            for (const s of sim) {
                const g = acc.get(s.cluster);
                if (g) {
                    g.x += s.x;
                    g.y += s.y;
                    g.n++;
                } else {
                    acc.set(s.cluster, { x: s.x, y: s.y, n: 1, label: s.clusterLabel });
                }
            }
            const rad = new Map<string, number>();
            for (const [key, g] of acc) {
                g.x /= g.n;
                g.y /= g.n;
                rad.set(key, 0);
            }
            for (const s of sim) {
                const g = acc.get(s.cluster)!;
                const d = Math.hypot(s.x - g.x, s.y - g.y);
                if (d > (rad.get(s.cluster) ?? 0)) {
                    rad.set(s.cluster, d);
                }
            }
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.font = `${Math.max(11, 15 / Math.sqrt(k))}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
            for (const [key, g] of acc) {
                if (g.n < 3) {
                    continue;
                }
                const rr = (rad.get(key) ?? 0) + 14;
                const hue = clusterHue(key);
                ctx.beginPath();
                ctx.arc(g.x, g.y, rr, 0, Math.PI * 2);
                ctx.fillStyle = `hsla(${hue}, 55%, 55%, 0.07)`;
                ctx.fill();
                ctx.lineWidth = 1 / k;
                ctx.strokeStyle = `hsla(${hue}, 55%, 55%, 0.28)`;
                ctx.stroke();
                ctx.fillStyle = theme.muted;
                ctx.fillText(`${g.label} · ${g.n}`, g.x, g.y - rr - 2 / k);
            }
        }

        // Edges.
        ctx.strokeStyle = theme.text;
        ctx.lineWidth = 1 / k;
        for (const e of es) {
            const lit = isLit(e.a, neighbours) && isLit(e.b, neighbours);
            const touchesHover = hi >= 0 && (e.a === hi || e.b === hi);
            ctx.globalAlpha = touchesHover ? 0.55 : (dim ? (lit ? 0.32 : 0.04) : 0.16);
            ctx.beginPath();
            ctx.moveTo(sim[e.a].x, sim[e.a].y);
            ctx.lineTo(sim[e.b].x, sim[e.b].y);
            ctx.stroke();
        }
        ctx.globalAlpha = 1;

        // Selected edge overlay.
        const se = selEdge.current;
        if (se) {
            ctx.strokeStyle = theme.text;
            ctx.lineWidth = 2.5 / k;
            ctx.globalAlpha = 1;
            ctx.beginPath();
            ctx.moveTo(sim[se.a].x, sim[se.a].y);
            ctx.lineTo(sim[se.b].x, sim[se.b].y);
            ctx.stroke();
        }

        // Nodes.
        for (let i = 0; i < sim.length; i++) {
            const s = sim[i];
            const lit = isLit(i, neighbours);
            const isMatch = matchActive.current && matched.current.has(i);
            ctx.globalAlpha = lit ? 1 : 0.22;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
            ctx.fillStyle = GRAPH_COLORS[s.kind];
            ctx.fill();
            if (i === hi || isMatch) {
                ctx.lineWidth = 2 / k;
                ctx.strokeStyle = theme.text;
                ctx.stroke();
            }
        }
        ctx.globalAlpha = 1;

        // Selected node ring.
        if (selNode.current >= 0 && selNode.current < sim.length) {
            const s = sim[selNode.current];
            ctx.strokeStyle = theme.text;
            ctx.lineWidth = 2.5 / k;
            ctx.beginPath();
            ctx.arc(s.x, s.y, s.r + 3 / k, 0, Math.PI * 2);
            ctx.stroke();
        }

        // Labels.
        const showAll = k > 1.7;
        ctx.font = `${Math.max(9, 11 / Math.sqrt(k))}px -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let i = 0; i < sim.length; i++) {
            const s = sim[i];
            const isHub = s.degree >= 8 || s.kind === 'repo';
            const near = hi >= 0 && (i === hi || (neighbours !== undefined && neighbours.has(i)));
            const isMatch = matchActive.current && matched.current.has(i);
            const show = isMatch || near || i === selNode.current || (showAll && isLit(i, neighbours)) || (isHub && !dim);
            if (!show) {
                continue;
            }
            ctx.fillStyle = near || i === hi || isMatch || i === selNode.current ? theme.text : theme.muted;
            ctx.fillText(s.short, s.x, s.y + s.r + 2);
        }
    }

    function toWorld(clientX: number, clientY: number): { x: number; y: number } {
        const canvas = canvasRef.current!;
        const rect = canvas.getBoundingClientRect();
        const { k, tx, ty } = view.current;
        return { x: (clientX - rect.left - tx) / k, y: (clientY - rect.top - ty) / k };
    }

    function pick(clientX: number, clientY: number): number {
        const p = toWorld(clientX, clientY);
        const { sim } = model.current;
        let best = -1;
        let bestD = Infinity;
        for (let i = 0; i < sim.length; i++) {
            const s = sim[i];
            const d = Math.hypot(s.x - p.x, s.y - p.y);
            const hitR = s.r + 4 / view.current.k;
            if (d < hitR && d < bestD) {
                bestD = d;
                best = i;
            }
        }
        return best;
    }

    function pickEdge(clientX: number, clientY: number): SimEdge | undefined {
        const p = toWorld(clientX, clientY);
        const { sim, edges: es } = model.current;
        const th = 6 / view.current.k;
        let best: SimEdge | undefined;
        let bestD = th;
        for (const e of es) {
            const d = distToSegment(p.x, p.y, sim[e.a].x, sim[e.a].y, sim[e.b].x, sim[e.b].y);
            if (d < bestD) {
                bestD = d;
                best = e;
            }
        }
        return best;
    }

    React.useEffect(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) {
            return;
        }

        const resize = (): void => {
            const dpr = window.devicePixelRatio || 1;
            const w = container.clientWidth || 1;
            const h = container.clientHeight || 1;
            size.current = { w, h, dpr };
            canvas.width = Math.round(w * dpr);
            canvas.height = Math.round(h * dpr);
            canvas.style.width = `${w}px`;
            canvas.style.height = `${h}px`;
            draw();
        };
        resize();
        const ro = new ResizeObserver(resize);
        ro.observe(container);

        const onMove = (ev: MouseEvent): void => {
            if (pan.current) {
                view.current.tx += ev.clientX - pan.current.x;
                view.current.ty += ev.clientY - pan.current.y;
                pan.current = { x: ev.clientX, y: ev.clientY, moved: true };
                draw();
                return;
            }
            if (drag.current) {
                const p = toWorld(ev.clientX, ev.clientY);
                const s = model.current.sim[drag.current.idx];
                s.fx = p.x;
                s.fy = p.y;
                drag.current.moved = true;
                reheat(0.3);
                return;
            }
            const idx = pick(ev.clientX, ev.clientY);
            if (idx !== hover.current) {
                hover.current = idx;
                canvas.style.cursor = idx >= 0 ? 'pointer' : 'default';
                draw();
            }
        };

        const onDown = (ev: MouseEvent): void => {
            const idx = pick(ev.clientX, ev.clientY);
            if (idx >= 0) {
                const s = model.current.sim[idx];
                s.fx = s.x;
                s.fy = s.y;
                drag.current = { idx, moved: false };
            } else {
                pan.current = { x: ev.clientX, y: ev.clientY, moved: false };
                canvas.style.cursor = 'grabbing';
            }
        };

        const onUp = (ev: MouseEvent): void => {
            if (drag.current) {
                const d = drag.current;
                const s = model.current.sim[d.idx];
                s.fx = undefined;
                s.fy = undefined;
                if (!d.moved) {
                    onSelectNode(s.node);
                }
                drag.current = undefined;
                reheat(0.2);
            } else if (pan.current) {
                const wasClick = !pan.current.moved;
                pan.current = undefined;
                canvas.style.cursor = 'default';
                if (wasClick) {
                    const e = pickEdge(ev.clientX, ev.clientY);
                    if (e) {
                        onSelectEdge(e.edge);
                    } else {
                        onSelectNode(undefined);
                    }
                }
            }
        };

        const onWheel = (ev: WheelEvent): void => {
            ev.preventDefault();
            const rect = canvas.getBoundingClientRect();
            const mx = ev.clientX - rect.left;
            const my = ev.clientY - rect.top;
            const factor = Math.exp(-ev.deltaY * 0.0015);
            const k0 = view.current.k;
            const k1 = Math.max(0.02, Math.min(6, k0 * factor));
            view.current.tx = mx - (mx - view.current.tx) * (k1 / k0);
            view.current.ty = my - (my - view.current.ty) * (k1 / k0);
            view.current.k = k1;
            draw();
        };

        const onLeave = (): void => {
            if (hover.current !== -1) {
                hover.current = -1;
                draw();
            }
        };

        canvas.addEventListener('mousemove', onMove);
        canvas.addEventListener('mousedown', onDown);
        window.addEventListener('mouseup', onUp);
        canvas.addEventListener('wheel', onWheel, { passive: false });
        canvas.addEventListener('mouseleave', onLeave);

        return () => {
            ro.disconnect();
            canvas.removeEventListener('mousemove', onMove);
            canvas.removeEventListener('mousedown', onDown);
            window.removeEventListener('mouseup', onUp);
            canvas.removeEventListener('wheel', onWheel);
            canvas.removeEventListener('mouseleave', onLeave);
            if (raf.current) {
                window.cancelAnimationFrame(raf.current);
            }
            running.current = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <div ref={containerRef} style={{ position: 'relative', width: '100%', height: '100%', minHeight: 0 }}>
            <canvas ref={canvasRef} style={{ display: 'block', width: '100%', height: '100%' }} />
        </div>
    );
}

// ── Inspector (properties panel) ──

const MONO = 'var(--theia-editor-font-family, monospace)';

function isUrl(s: string): boolean {
    return /^https?:\/\//.test(s);
}

function renderFieldValue(v: unknown): React.ReactNode {
    if (v === null || v === undefined || v === '') {
        return <span style={{ color: 'var(--theia-descriptionForeground)' }}>—</span>;
    }
    if (typeof v === 'string') {
        if (isUrl(v)) {
            return <a href={v} target='_blank' rel='noreferrer' style={{ color: 'var(--theia-textLink-foreground)', wordBreak: 'break-all' }}>{v}</a>;
        }
        return <span style={{ wordBreak: 'break-word' }}>{v}</span>;
    }
    if (typeof v === 'number' || typeof v === 'boolean') {
        return <span>{String(v)}</span>;
    }
    return (
        <pre style={{
            margin: 0, maxHeight: 160, overflow: 'auto', fontFamily: MONO, fontSize: 11,
            background: 'var(--theia-editorWidget-background, rgba(127,127,127,0.08))', padding: 6, borderRadius: 4,
        }}>{JSON.stringify(v, null, 2)}</pre>
    );
}

function FieldRows({ obj }: { obj: Record<string, unknown> }): React.ReactElement {
    const keys = Object.keys(obj).sort();
    if (keys.length === 0) {
        return <div style={{ color: 'var(--theia-descriptionForeground)', fontSize: 12 }}>No fields.</div>;
    }
    return (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 38%) 1fr', gap: '2px 10px', fontSize: 12 }}>
            {keys.map(key => (
                <React.Fragment key={key}>
                    <div style={{ color: 'var(--theia-descriptionForeground)', fontFamily: MONO, fontSize: 11, padding: '3px 0', wordBreak: 'break-word' }}>{key}</div>
                    <div style={{ padding: '3px 0' }}>{renderFieldValue(obj[key])}</div>
                </React.Fragment>
            ))}
        </div>
    );
}

// ── Widget shell ──

type Selection = { kind: 'node'; node: ArtifactNode } | { kind: 'edge'; edge: ArtifactEdge };

interface Relation {
    edge: ArtifactEdge;
    other: ArtifactNode | undefined;
    dir: 'out' | 'in';
}

/**
 * Renders the studio-artifact-ingest graph (repos + issues/PRs/files/users and
 * their relations) as an Obsidian-style force-directed graph on a canvas, with
 * type filters, full-text search over the typed entities, and a properties
 * inspector that surfaces every field the graph store holds for a node or edge.
 * Reads the same backend data the portal shows (`/studio-artifact-ingest/v1/nodes`
 * + `/edges`) — so it needs NO `cfs map` capability. ADR-0022 experiment.
 */
@injectable()
export class ArtifactGraphWidget extends ReactWidget {
    static readonly ID = 'studio:artifact-graph';
    static readonly LABEL = 'Artifact Graph';

    protected nodes: ArtifactNode[] | undefined;
    protected edges: ArtifactEdge[] = [];
    protected error: string | undefined;
    protected loading = false;
    protected hideLeafFiles = false;
    protected groupMode: GroupMode = 'folder';
    protected showClusters = true;
    protected selection: Selection | undefined;
    protected fitSignal = 0;
    protected focusSignal = 0;
    protected focusId: string | undefined;
    protected query = '';
    protected activeKinds: Set<GraphKind> = new Set(ALL_KINDS);

    @inject(OpenInEditorFrontendController)
    protected readonly opener!: OpenInEditorFrontendController;

    @postConstruct()
    protected init(): void {
        this.id = ArtifactGraphWidget.ID;
        this.title.label = ArtifactGraphWidget.LABEL;
        this.title.caption = ArtifactGraphWidget.LABEL;
        this.title.closable = true;
        this.title.iconClass = 'codicon codicon-type-hierarchy';
        this.update();
        void this.reload();
    }

    protected override onActivateRequest(msg: Message): void {
        super.onActivateRequest(msg);
        this.node.focus();
    }

    async reload(): Promise<void> {
        this.loading = true;
        this.error = undefined;
        this.update();
        try {
            // Scope both reads to the tenant that opened this session, so the
            // graph shows only its artifacts (a workspace shows every project
            // under it; a project shows just itself).
            // Both lists are paged (50 per page by default), and a graph needs
            // all of it — one page would draw a fraction of the artifacts and
            // look like an ingest that never finished.
            const [nodes, edges] = await Promise.all([
                StudioApi.fetchAllPages<ArtifactNode>(
                    StudioApi.scoped('/studio-artifact-ingest/v1/nodes'), 'nodes',
                ),
                StudioApi.fetchAllPages<ArtifactEdge>(
                    StudioApi.scoped('/studio-artifact-ingest/v1/edges'), 'edges',
                ).catch(() => [] as ArtifactEdge[]),
            ]);
            this.nodes = nodes;
            this.edges = edges;
        } catch (e) {
            this.error = graphLoadError(e);
            this.nodes = this.nodes ?? [];
        } finally {
            this.loading = false;
            this.update();
        }
    }

    protected selectNode = (n: ArtifactNode | undefined): void => {
        this.selection = n ? { kind: 'node', node: n } : undefined;
        this.update();
    };

    protected selectEdge = (e: ArtifactEdge): void => {
        this.selection = { kind: 'edge', edge: e };
        this.update();
    };

    protected toggleKind(kind: GraphKind): void {
        if (this.activeKinds.has(kind)) {
            this.activeKinds.delete(kind);
        } else {
            this.activeKinds.add(kind);
        }
        this.update();
    }

    protected focusNode(n: ArtifactNode): void {
        this.focusId = n.instance_id;
        this.focusSignal++;
        this.selection = { kind: 'node', node: n };
        this.update();
    }

    protected kindsKey(): string {
        return ALL_KINDS.filter(k => this.activeKinds.has(k)).join(',');
    }

    protected selectionToken(): string {
        const s = this.selection;
        if (!s) {
            return '';
        }
        return s.kind === 'node' ? `node:${s.node.instance_id}` : `edge:${s.edge.from}|${s.edge.to}`;
    }

    protected matchList(): ArtifactNode[] {
        const q = this.query.trim();
        if (q.length === 0 || !this.nodes) {
            return [];
        }
        return this.nodes.filter(n => this.activeKinds.has(nodeKind(n)) && nodeMatches(n, q));
    }

    /** Edges touching a node, resolved to the other endpoint. Falls back to
     *  repo membership when the store returned no edges. */
    protected relationsOf(node: ArtifactNode, byId: Map<string, ArtifactNode>): Relation[] {
        const id = node.instance_id;
        const out: Relation[] = [];
        if (this.edges.length > 0) {
            for (const e of this.edges) {
                if (e.from === id) {
                    out.push({ edge: e, other: byId.get(e.to), dir: 'out' });
                } else if (e.to === id) {
                    out.push({ edge: e, other: byId.get(e.from), dir: 'in' });
                }
            }
        } else {
            const repoId = typeof node.value.repo === 'string' ? node.value.repo : undefined;
            if (repoId && byId.has(repoId)) {
                out.push({ edge: { type_id: 'studio.rel.contains.synthesized', from: repoId, to: id }, other: byId.get(repoId), dir: 'in' });
            }
            if (this.nodes) {
                for (const m of this.nodes) {
                    if (m.value.repo === id) {
                        out.push({ edge: { type_id: 'studio.rel.contains.synthesized', from: id, to: m.instance_id }, other: m, dir: 'out' });
                    }
                }
            }
        }
        return out;
    }

    protected copy(text: string): void {
        try {
            void navigator.clipboard?.writeText(text);
        } catch {
            /* clipboard unavailable — ignore */
        }
    }

    /** Open a file node in the IDE editor (ADR-0022 openInEditor), resolved
     *  against the first workspace root. Same path used by the portal bridge. */
    protected openFileInEditor(path: string): void {
        void this.opener.onOpenInEditor({ relativePath: path });
    }

    protected renderInspector(byId: Map<string, ArtifactNode>): React.ReactNode {
        const sel = this.selection;
        if (!sel) {
            return undefined;
        }
        const closeBtn = (
            <button className='theia-button secondary' onClick={() => this.selectNode(undefined)} title='Close' style={{ minWidth: 0, padding: '0 8px' }}>×</button>
        );

        if (sel.kind === 'edge') {
            const e = sel.edge;
            const from = byId.get(e.from);
            const to = byId.get(e.to);
            const extra: Record<string, unknown> = {};
            for (const k of Object.keys(e)) {
                if (k !== 'type_id' && k !== 'from' && k !== 'to') {
                    extra[k] = e[k];
                }
            }
            const endpoint = (n: ArtifactNode | undefined, raw: string): React.ReactNode =>
                n
                    ? <a onClick={() => this.focusNode(n)} style={{ color: 'var(--theia-textLink-foreground)', cursor: 'pointer' }}>{nodeLabel(n)}</a>
                    : <span style={{ fontFamily: MONO, fontSize: 11 }}>{raw}</span>;
            return (
                <div style={{ padding: 12, overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                        <strong style={{ textTransform: 'capitalize' }}>Relation · {relLabel(e.type_id)}</strong>
                        {closeBtn}
                    </div>
                    <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--theia-descriptionForeground)', wordBreak: 'break-all', marginBottom: 10 }}>{e.type_id}</div>
                    <div style={{ display: 'grid', gridTemplateColumns: '48px 1fr', gap: '4px 8px', fontSize: 12, marginBottom: 10 }}>
                        <div style={{ color: 'var(--theia-descriptionForeground)' }}>from</div><div>{endpoint(from, e.from)}</div>
                        <div style={{ color: 'var(--theia-descriptionForeground)' }}>to</div><div>{endpoint(to, e.to)}</div>
                    </div>
                    {Object.keys(extra).length > 0 && <FieldRows obj={extra} />}
                </div>
            );
        }

        const n = sel.node;
        const kind = nodeKind(n);
        const rels = this.relationsOf(n, byId).slice(0, 200);
        const extraTop: Record<string, unknown> = {};
        for (const k of Object.keys(n)) {
            if (k !== 'type_id' && k !== 'instance_id' && k !== 'value') {
                extraTop[k] = n[k];
            }
        }
        const fields: Record<string, unknown> = { ...n.value, ...extraTop };
        return (
            <div style={{ padding: 12, overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6, gap: 8 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                        <span style={{ width: 10, height: 10, borderRadius: '50%', background: GRAPH_COLORS[kind], flex: '0 0 auto' }} />
                        <strong>{KIND_LABEL[kind]}</strong>
                    </span>
                    {closeBtn}
                </div>
                <div style={{ fontSize: 13, marginBottom: 8, wordBreak: 'break-word' }}>{nodeLabel(n)}</div>
                <div style={{ fontFamily: MONO, fontSize: 11, color: 'var(--theia-descriptionForeground)', wordBreak: 'break-all', marginBottom: 4 }}>{n.type_id}</div>
                <div
                    onClick={() => this.copy(n.instance_id)}
                    title='Click to copy instance id'
                    style={{ fontFamily: MONO, fontSize: 11, color: 'var(--theia-descriptionForeground)', wordBreak: 'break-all', marginBottom: 12, cursor: 'copy' }}>
                    {n.instance_id}
                </div>

                {kind === 'file' && typeof n.value.path === 'string' && n.value.path && (
                    <button
                        className='theia-button'
                        style={{ marginBottom: 12 }}
                        onClick={() => this.openFileInEditor(n.value.path as string)}
                        title='Open this file in the editor'>
                        Open in editor
                    </button>
                )}

                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--theia-descriptionForeground)', margin: '0 0 6px' }}>Fields</div>
                <FieldRows obj={fields} />

                <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: 0.5, color: 'var(--theia-descriptionForeground)', margin: '14px 0 6px' }}>
                    Relations · {rels.length}
                </div>
                {rels.length === 0
                    ? <div style={{ fontSize: 12, color: 'var(--theia-descriptionForeground)' }}>No relations stored.</div>
                    : (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                            {rels.map((r, i) => (
                                <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                                    <span style={{ color: 'var(--theia-descriptionForeground)', fontSize: 11, minWidth: 74 }}>
                                        {r.dir === 'out' ? '→' : '←'} {relLabel(r.edge.type_id)}
                                    </span>
                                    {r.other
                                        ? <a onClick={() => this.focusNode(r.other!)} title={nodeLabel(r.other)}
                                            style={{ color: 'var(--theia-textLink-foreground)', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                            {shortLabel(nodeKind(r.other), nodeLabel(r.other))}
                                        </a>
                                        : <span style={{ fontFamily: MONO, fontSize: 11 }}>{r.dir === 'out' ? r.edge.to : r.edge.from}</span>}
                                </div>
                            ))}
                        </div>
                    )}
            </div>
        );
    }

    protected render(): React.ReactNode {
        const nodes = this.nodes;
        const edges = this.edges;
        const hasData = !!nodes && nodes.length > 0;
        const matches = this.matchList();
        const searching = this.query.trim().length > 0;
        const byId = new Map<string, ArtifactNode>((nodes ?? []).map(n => [n.instance_id, n] as [string, ArtifactNode]));
        const showInspector = !!this.selection;
        const showResults = !showInspector && searching && matches.length > 0;

        const chip = (kind: GraphKind): React.ReactElement => {
            const on = this.activeKinds.has(kind);
            return (
                <button key={kind} onClick={() => this.toggleKind(kind)} title={`Toggle ${KIND_LABEL[kind]}`}
                    style={{
                        display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                        fontSize: 11, padding: '2px 8px', borderRadius: 11,
                        border: `1px solid ${on ? GRAPH_COLORS[kind] : 'var(--theia-editorWidget-border)'}`,
                        background: on ? `${GRAPH_COLORS[kind]}22` : 'transparent',
                        color: on ? 'var(--theia-foreground)' : 'var(--theia-descriptionForeground)',
                        opacity: on ? 1 : 0.6,
                    }}>
                    <span style={{ width: 9, height: 9, borderRadius: '50%', background: GRAPH_COLORS[kind], display: 'inline-block' }} />
                    {KIND_LABEL[kind]}
                </button>
            );
        };

        return (
            <div style={{ display: 'flex', flexDirection: 'column', height: '100%', boxSizing: 'border-box' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 12px 4px', flexWrap: 'wrap' }}>
                    <h3 style={{ margin: 0 }}>Artifact Graph</h3>
                    <span style={{ color: 'var(--theia-descriptionForeground)', fontSize: 12 }}>
                        {nodes ? `${nodes.length} nodes · ${edges.length} edges` : ''}
                    </span>
                    <span style={{ flex: 1 }} />
                    <input type='search' placeholder='Search #123, title, path, user…' value={this.query}
                        onChange={e => { this.query = e.target.value; this.update(); }}
                        className='theia-input' style={{ minWidth: 220, fontSize: 12 }} />
                    {searching && (
                        <>
                            <span style={{ fontSize: 11, color: 'var(--theia-descriptionForeground)' }}>{matches.length} match{matches.length === 1 ? '' : 'es'}</span>
                            <button className='theia-button secondary' disabled={matches.length === 0}
                                onClick={() => { const first = matches[0]; if (first) { this.focusNode(first); } }}>Go</button>
                        </>
                    )}
                    <button className='theia-button secondary' onClick={() => { this.fitSignal++; this.update(); }} disabled={!hasData}>Fit</button>
                    <button className='theia-button secondary' onClick={() => void this.reload()} disabled={this.loading}>
                        {this.loading ? 'Loading…' : 'Refresh'}
                    </button>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 12px 8px', flexWrap: 'wrap' }}>
                    {ALL_KINDS.map(chip)}
                    <span style={{ flex: 1 }} />
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                        Group by
                        <select value={this.groupMode} className='theia-select'
                            onChange={e => { this.groupMode = e.target.value as GroupMode; this.update(); }}
                            style={{ fontSize: 11 }}>
                            {(['folder', 'repo', 'type'] as GroupMode[]).map(m => (
                                <option key={m} value={m}>{GROUP_LABEL[m]}</option>
                            ))}
                        </select>
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                        <input type='checkbox' checked={this.showClusters} onChange={e => { this.showClusters = e.target.checked; this.update(); }} />
                        Clusters
                    </label>
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11 }}>
                        <input type='checkbox' checked={this.hideLeafFiles} onChange={e => { this.hideLeafFiles = e.target.checked; this.update(); }} />
                        Hide unlinked files
                    </label>
                </div>

                {this.error && (
                    <p style={{ color: 'var(--theia-errorForeground, #f14c4c)', padding: '0 12px', margin: '0 0 6px' }}>
                        {this.error}
                    </p>
                )}

                <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex' }}>
                    <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
                        {!nodes
                            ? <p style={{ padding: 12 }}>Loading…</p>
                            : !hasData
                                // A graph that could not load is not an empty one:
                                // the error above says why, and "no ingested
                                // artifacts" would send the member to Sync for nothing.
                                ? (this.error ? null : <p style={{ padding: 12, color: 'var(--theia-descriptionForeground)' }}>
                                    No ingested artifacts — run Sync on a repository in the portal to build the graph.
                                </p>)
                                : <ForceGraph
                                    nodes={nodes}
                                    edges={edges}
                                    kindsKey={this.kindsKey()}
                                    hideLeafFiles={this.hideLeafFiles}
                                    groupMode={this.groupMode}
                                    showClusters={this.showClusters}
                                    query={this.query}
                                    selectedToken={this.selectionToken()}
                                    onSelectNode={this.selectNode}
                                    onSelectEdge={this.selectEdge}
                                    fitSignal={this.fitSignal}
                                    focusId={this.focusId}
                                    focusSignal={this.focusSignal}
                                />}
                    </div>

                    {(showInspector || showResults) && (
                        <aside style={{
                            width: 300, flex: '0 0 300px', borderLeft: '1px solid var(--theia-editorWidget-border)',
                            background: 'var(--theia-editor-background)', minHeight: 0, display: 'flex', flexDirection: 'column',
                        }}>
                            {showInspector
                                ? this.renderInspector(byId)
                                : (
                                    <div style={{ overflowY: 'auto' }}>
                                        <div style={{ padding: '6px 10px', fontSize: 11, color: 'var(--theia-descriptionForeground)' }}>
                                            {matches.length} result{matches.length === 1 ? '' : 's'}
                                        </div>
                                        {matches.slice(0, 60).map(n => {
                                            const kind = nodeKind(n);
                                            return (
                                                <div key={n.instance_id} onClick={() => this.focusNode(n)} title={nodeLabel(n)}
                                                    style={{
                                                        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', cursor: 'pointer',
                                                        fontSize: 12, borderBottom: '1px solid var(--theia-editorWidget-border)',
                                                    }}>
                                                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: GRAPH_COLORS[kind], flex: '0 0 auto' }} />
                                                    <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                                                        {shortLabel(kind, nodeLabel(n))}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                        {matches.length > 60 && (
                                            <div style={{ padding: '5px 10px', fontSize: 11, color: 'var(--theia-descriptionForeground)' }}>+{matches.length - 60} more…</div>
                                        )}
                                    </div>
                                )}
                        </aside>
                    )}
                </div>
            </div>
        );
    }
}

/**
 * What the graph says when it could not load. Signed out is the member's to
 * fix, so it says how -- a raw "HTTP 503" said only that something broke.
 */
export function graphLoadError(error: unknown): string {
    if (isSignedOut(error)) {
        return 'Sign in to Constructor Studio to see the traceability graph: the Studio view has Sign in.';
    }
    return `Failed to load: ${error instanceof Error ? error.message : String(error)}`;
}
