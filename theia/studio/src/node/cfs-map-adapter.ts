import * as fs from 'fs/promises';
import * as path from 'path';
import Ajv2020, { type ErrorObject } from 'ajv/dist/2020';
import {
    CFS_MAP_SCHEMA_VERSION,
    GRAPH_SCHEMA_VERSION,
    type GraphCategoryOrigin,
    type GraphEdgeKind,
    type GraphMarkerKind,
    type GraphNodeKind,
    type GraphSourceRole,
    type WorkspaceGraphBucketRect,
    type WorkspaceGraphCategory,
    type WorkspaceGraphCategoryBand,
    type WorkspaceGraphDanglingCptUse,
    type WorkspaceGraphEdge,
    type WorkspaceGraphEdgeRef,
    type WorkspaceGraphLocation,
    type WorkspaceGraphNode,
    type WorkspaceGraphSource,
    WorkspaceGraphSnapshot
} from '../common/graph-model';
import type { CfsMapEngine } from './cfs-map-runner';

const MAX_GRAPH_ITEMS = 100_000;
const NODE_KINDS: ReadonlySet<GraphNodeKind> = new Set(['markdown', 'source', 'phantom-cpt']);
const EDGE_TYPES: ReadonlySet<GraphEdgeKind> = new Set(['file-link', 'cpt-doc', 'cpt-impl']);
const SOURCE_ROLES: ReadonlySet<GraphSourceRole> = new Set(['artifacts', 'codebase', 'kits', 'full']);
const CATEGORY_ORIGINS: ReadonlySet<GraphCategoryOrigin> = new Set([
    'override',
    'registry',
    'parent-dir',
    'phantom'
]);
const MARKER_KINDS: ReadonlySet<GraphMarkerKind> = new Set(['scope', 'block-begin', 'block-end', 'md-ref', 'md-def']);
export const CFS_MAP_RUNTIME_SCHEMA_PATH = path.resolve(
    __dirname,
    '../../../.cf-studio/.core/schemas/map.schema.json'
);
const mapSchema = require(CFS_MAP_RUNTIME_SCHEMA_PATH) as object;
const ajv = new Ajv2020({
    allErrors: true,
    strict: false,
    validateFormats: false
});
const validateCanonicalMap = ajv.compile(mapSchema);

export interface CfsMapRegisteredRepository {
    readonly canonicalRoot: string;
    readonly descriptor: {
        readonly repositoryId: string;
        readonly label: string;
    };
}

export interface CfsMapAdapterOptions {
    readonly workspaceId: string;
    readonly revision: string;
    readonly repositories: readonly CfsMapRegisteredRepository[];
    readonly indexedAt?: string;
    readonly engine: CfsMapEngine;
}

export class CfsMapAdapterError extends Error {
    constructor(message: string, readonly path: string) {
        super(`${path}: ${message}`);
    }
}

interface ResolvedSource {
    readonly name: string;
    readonly reachable: boolean;
    readonly role: GraphSourceRole;
    readonly repository?: CfsMapRegisteredRepository;
    readonly canonicalRoot?: string;
    readonly repositoryRelativeRoot?: string;
}

export async function adaptCfsMap(
    payload: unknown,
    options: CfsMapAdapterOptions
): Promise<WorkspaceGraphSnapshot> {
    validateRawCfsMap(payload);
    const root = objectAt(payload, '$');
    equalString(root.version, '1.0', '$.version');
    const generatedAt = dateString(root.generated_at, '$.generated_at');
    const workspace = objectAt(root.workspace, '$.workspace');
    const primarySource = stringAt(workspace.primary, '$.workspace.primary');
    validateScan(root.scan);
    const sourceValues = arrayAt(workspace.sources, '$.workspace.sources', MAX_GRAPH_ITEMS);
    const sources = await Promise.all(sourceValues.map((source, index) =>
        resolveSource(source, `$.workspace.sources[${index}]`, options.repositories)
    ));
    const sourceByName = new Map(sources.map(source => [source.name, source]));
    if (sourceByName.size !== sources.length) {
        throw new CfsMapAdapterError('source names must be unique', '$.workspace.sources');
    }
    const primaryResolvedSource = sourceByName.get(primarySource);
    if (!primaryResolvedSource) {
        throw new CfsMapAdapterError(
            `primary source "${sanitizeLabel(primarySource)}" is not declared`,
            '$.workspace.primary'
        );
    }
    const unownedSourceIndex = sources.findIndex(source => source.reachable && !source.repository);
    if (unownedSourceIndex >= 0) {
        const source = sources[unownedSourceIndex];
        throw new CfsMapAdapterError(
            `reachable source "${sanitizeLabel(source.name)}" does not resolve inside a server-registered repository; register the source before refreshing the graph`,
            `$.workspace.sources[${unownedSourceIndex}].path`
        );
    }

    const layout = optionalObject(root.layout, '$.layout') ?? {};
    const positions = new Map<string, { readonly x: number; readonly y: number }>();
    const positionIndexes = new Map<string, number>();
    for (const [index, value] of arrayAt(layout.vis_nodes ?? [], '$.layout.vis_nodes', MAX_GRAPH_ITEMS).entries()) {
        const position = objectAt(value, `$.layout.vis_nodes[${index}]`);
        const idPath = `$.layout.vis_nodes[${index}].id`;
        const id = stringAt(position.id, idPath);
        if (positions.has(id)) {
            throw new CfsMapAdapterError(`duplicate layout node id "${sanitizeLabel(id)}"`, idPath);
        }
        positions.set(id, {
            x: numberAt(position.x, `$.layout.vis_nodes[${index}].x`),
            y: numberAt(position.y, `$.layout.vis_nodes[${index}].y`)
        });
        positionIndexes.set(id, index);
    }

    const nodes: WorkspaceGraphNode[] = [];
    const includedNodeIds = new Set<string>();
    for (const [index, value] of arrayAt(root.nodes, '$.nodes', MAX_GRAPH_ITEMS).entries()) {
        const nodePath = `$.nodes[${index}]`;
        const node = objectAt(value, nodePath);
        const id = stringAt(node.id, `${nodePath}.id`);
        if (includedNodeIds.has(id)) {
            throw new CfsMapAdapterError(`duplicate node id "${id}"`, `${nodePath}.id`);
        }
        const kind = enumString(node.kind, NODE_KINDS, `${nodePath}.kind`);
        const relPath = nullableString(node.rel_path, `${nodePath}.rel_path`);
        const sourceName = nullableString(node.source, `${nodePath}.source`);
        if (kind === 'phantom-cpt') {
            if (relPath !== null) {
                throw new CfsMapAdapterError('phantom CPT nodes must not reference a file path', `${nodePath}.rel_path`);
            }
            if (sourceName !== null) {
                throw new CfsMapAdapterError('phantom CPT nodes must not reference a source', `${nodePath}.source`);
            }
        } else {
            if (relPath === null) {
                throw new CfsMapAdapterError(`${kind} nodes must reference a file path`, `${nodePath}.rel_path`);
            }
            if (sourceName === null) {
                throw new CfsMapAdapterError(`${kind} nodes must reference a source`, `${nodePath}.source`);
            }
        }
        const source = sourceName === null ? undefined : sourceByName.get(sourceName);
        if (sourceName !== null && !source) {
            throw new CfsMapAdapterError(
                `node "${sanitizeLabel(id)}" references undeclared source "${sanitizeLabel(sourceName)}"`,
                `${nodePath}.source`
            );
        }
        if (relPath !== null && sourceName === null) {
            throw new CfsMapAdapterError(
                `file-backed node "${sanitizeLabel(id)}" must reference a declared, server-owned source`,
                `${nodePath}.source`
            );
        }
        if (sourceName !== null && (!source?.repository || !source.canonicalRoot)) {
            throw new CfsMapAdapterError(
                `node "${sanitizeLabel(id)}" does not resolve inside a server-registered repository`,
                `${nodePath}.source`
            );
        }

        const ownedSource = source?.repository && source.canonicalRoot
            ? source as ResolvedSource & {
                readonly repository: CfsMapRegisteredRepository;
                readonly canonicalRoot: string;
            }
            : undefined;
        const phantomRepository = primaryResolvedSource.repository ?? options.repositories[0];
        const location = relPath === null || !ownedSource
            ? phantomRepository
                ? {
                    workspaceId: options.workspaceId,
                    repositoryId: phantomRepository.descriptor.repositoryId,
                    repositoryRelativePath: '.'
                }
                : (() => {
                    throw new CfsMapAdapterError(
                        `node "${sanitizeLabel(id)}" cannot be assigned to a server-registered repository`,
                        `${nodePath}.source`
                    );
                })()
            : nodeLocation(options.workspaceId, ownedSource, relPath, `${nodePath}.rel_path`);
        const cptDefs = stringArray(node.cpt_defs, `${nodePath}.cpt_defs`);
        const cptUses = arrayAt(node.cpt_uses, `${nodePath}.cpt_uses`, MAX_GRAPH_ITEMS).map((use, useIndex) => {
            const usePath = `${nodePath}.cpt_uses[${useIndex}]`;
            const record = objectAt(use, usePath);
            return {
                cptId: stringAt(record.cpt_id, `${usePath}.cpt_id`),
                line: integerAt(record.line, `${usePath}.line`, 1),
                snippet: stringAt(record.snippet, `${usePath}.snippet`),
                markerKind: enumString(record.marker_kind, MARKER_KINDS, `${usePath}.marker_kind`)
            };
        });
        const position = positions.get(id);
        nodes.push({
            id,
            relPath,
            source: sourceName,
            kind,
            label: sanitizeLabel(relPath === null ? id : path.posix.basename(relPath)),
            language: nullableString(node.language, `${nodePath}.language`),
            category: stringAt(node.category, `${nodePath}.category`),
            categoryOrigin: enumString(node.category_origin, CATEGORY_ORIGINS, `${nodePath}.category_origin`),
            content: nullableString(node.content, `${nodePath}.content`),
            loc: integerAt(node.loc, `${nodePath}.loc`, 0),
            cptDefs,
            cptUses,
            ...(position === undefined ? {} : { position }),
            location
        });
        includedNodeIds.add(id);
    }
    for (const id of positions.keys()) {
        if (!includedNodeIds.has(id)) {
            throw new CfsMapAdapterError(
                `layout node "${sanitizeLabel(id)}" does not reference a canonical node`,
                `$.layout.vis_nodes[${positionIndexes.get(id)}].id`
            );
        }
    }

    const edges: WorkspaceGraphEdge[] = [];
    const edgeIds = new Set<string>();
    // Relation key -> where that relation already sits in `edges`. The same
    // relation can legitimately be reported twice — two files under one kit's
    // examples/ referencing each other is enough — and rejecting the map over
    // it took the whole graph down for content nobody was looking at. Two
    // edges with the same (type, from, to) ARE one relation, so they are
    // merged; a repeated edge *id* stays an error, because ids have to be
    // unique for anything downstream to address one.
    const relationIndex = new Map<string, number>();
    for (const [index, value] of arrayAt(root.edges, '$.edges', MAX_GRAPH_ITEMS).entries()) {
        const edgePath = `$.edges[${index}]`;
        const edge = objectAt(value, edgePath);
        const id = stringAt(edge.id, `${edgePath}.id`);
        if (edgeIds.has(id)) {
            throw new CfsMapAdapterError(`duplicate edge id "${sanitizeLabel(id)}"`, `${edgePath}.id`);
        }
        edgeIds.add(id);
        const from = stringAt(edge.from, `${edgePath}.from`);
        const to = stringAt(edge.to, `${edgePath}.to`);
        const type = enumString(edge.type, EDGE_TYPES, `${edgePath}.type`);
        if (!includedNodeIds.has(from) || !includedNodeIds.has(to)) {
            throw new CfsMapAdapterError(
                'edge endpoint does not reference a canonical node',
                !includedNodeIds.has(from) ? `${edgePath}.from` : `${edgePath}.to`
            );
        }
        const relationKey = `${type}\0${from}\0${to}`;
        const refs = arrayAt(edge.refs, `${edgePath}.refs`, MAX_GRAPH_ITEMS).map((ref, refIndex) => {
            const refPath = `${edgePath}.refs[${refIndex}]`;
            const record = objectAt(ref, refPath);
            return {
                cptId: nullableString(record.cpt_id, `${refPath}.cpt_id`),
                line: integerAt(record.line, `${refPath}.line`, 1),
                snippet: stringAt(record.snippet, `${refPath}.snippet`),
                defLine: nullableInteger(record.def_line, `${refPath}.def_line`, 1),
                defSnippet: nullableString(record.def_snippet, `${refPath}.def_snippet`)
            };
        });
        const parsed: WorkspaceGraphEdge = {
            id,
            from,
            to,
            type,
            refs,
            crossRepo: booleanAt(edge.cross_repo, `${edgePath}.cross_repo`),
            dangling: booleanAt(edge.dangling, `${edgePath}.dangling`)
        };
        const alreadyAt = relationIndex.get(relationKey);
        if (alreadyAt === undefined) {
            relationIndex.set(relationKey, edges.length);
            edges.push(parsed);
        } else {
            edges[alreadyAt] = mergeRelation(edges[alreadyAt], parsed);
        }
    }

    const danglingCptUses: WorkspaceGraphDanglingCptUse[] = arrayAt(root.dangling_cpt_uses, '$.dangling_cpt_uses', MAX_GRAPH_ITEMS)
        .map((value, index) => {
            const itemPath = `$.dangling_cpt_uses[${index}]`;
            const item = objectAt(value, itemPath);
            return {
                cptId: stringAt(item.cpt_id, `${itemPath}.cpt_id`),
                nodeId: stringAt(item.node_id, `${itemPath}.node_id`),
                line: integerAt(item.line, `${itemPath}.line`, 1),
                snippet: stringAt(item.snippet, `${itemPath}.snippet`)
            };
        })
        .map((item, index) => {
            if (!includedNodeIds.has(item.nodeId)) {
                throw new CfsMapAdapterError(
                    'dangling CPT use does not reference a canonical node',
                    `$.dangling_cpt_uses[${index}].node_id`
                );
            }
            return item;
        });
    const categories = normalizeCategories(root.categories);
    const bucketRects = normalizeBucketRects(layout.bucket_rects ?? {});
    const categoryBands = normalizeCategoryBands(layout.category_bands ?? {});

    return {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        mapVersion: CFS_MAP_SCHEMA_VERSION,
        workspaceId: options.workspaceId,
        revision: options.revision,
        repositories: options.repositories.map(repository => ({
            repositoryId: repository.descriptor.repositoryId,
            commitSha: ''
        })),
        primarySource,
        sources: sources.map((source, index): WorkspaceGraphSource => ({
            name: source.name,
            path: stringAt(
                objectAt(sourceValues[index], `$.workspace.sources[${index}]`).path,
                `$.workspace.sources[${index}].path`
            ),
            reachable: source.reachable,
            role: source.role
        })),
        nodes,
        edges,
        danglingCptUses,
        categories,
        bucketRects,
        categoryBands,
        diagnostics: [],
        indexedAt: options.indexedAt ?? generatedAt,
        stale: false
    };
}

function validateScan(value: unknown): void {
    const scan = objectAt(value, '$.scan');
    nullableString(scan.artifacts_toml, '$.scan.artifacts_toml');
    integerAt(scan.systems_scanned, '$.scan.systems_scanned', 0);
    integerAt(scan.systems_docs_only, '$.scan.systems_docs_only', 0);
    stringArray(scan.skip_dirs, '$.scan.skip_dirs');
}

async function resolveSource(
    value: unknown,
    sourcePath: string,
    repositories: readonly CfsMapRegisteredRepository[]
): Promise<ResolvedSource> {
    const source = objectAt(value, sourcePath);
    const name = stringAt(source.name, `${sourcePath}.name`);
    const sourceRoot = stringAt(source.path, `${sourcePath}.path`);
    const reachable = booleanAt(source.reachable, `${sourcePath}.reachable`);
    const role = enumString(source.role, SOURCE_ROLES, `${sourcePath}.role`);
    if (!reachable) {
        return { name, reachable, role };
    }
    let canonicalRoot: string;
    try {
        canonicalRoot = await fs.realpath(sourceRoot);
    } catch {
        return { name, reachable, role };
    }
    const repository = [...repositories]
        .filter(candidate => isWithin(candidate.canonicalRoot, canonicalRoot))
        .sort((left, right) => right.canonicalRoot.length - left.canonicalRoot.length)[0];
    if (!repository) {
        return { name, reachable, role, canonicalRoot };
    }
    return {
        name,
        reachable,
        role,
        repository,
        canonicalRoot,
        repositoryRelativeRoot: normalizeRelativePath(path.relative(repository.canonicalRoot, canonicalRoot)) || '.'
    };
}

function nodeLocation(
    workspaceId: string,
    source: ResolvedSource & { readonly repository: CfsMapRegisteredRepository; readonly canonicalRoot: string },
    relPath: string,
    valuePath: string
): WorkspaceGraphLocation {
    if (path.isAbsolute(relPath)) {
        throw new CfsMapAdapterError('must be repository-relative', valuePath);
    }
    const normalized = normalizeRelativePath(relPath);
    if (!normalized || normalized === '..' || normalized.startsWith('../')) {
        throw new CfsMapAdapterError('must not escape its source root', valuePath);
    }
    const absolutePath = path.resolve(source.canonicalRoot, normalized);
    if (!isWithin(source.canonicalRoot, absolutePath) || !isWithin(source.repository.canonicalRoot, absolutePath)) {
        throw new CfsMapAdapterError('escapes the server-owned repository scope', valuePath);
    }
    return {
        workspaceId,
        repositoryId: source.repository.descriptor.repositoryId,
        repositoryRelativePath: normalizeRelativePath(path.relative(source.repository.canonicalRoot, absolutePath))
    };
}

function normalizeCategories(value: unknown): Readonly<Record<string, WorkspaceGraphCategory>> {
    const categories = objectAt(value, '$.categories');
    return Object.fromEntries(Object.entries(categories).map(([name, raw]) => {
        const categoryPath = `$.categories.${name}`;
        const category = objectAt(raw, categoryPath);
        const origins = objectAt(category.origin_counts, `${categoryPath}.origin_counts`);
        const style = objectAt(category.style, `${categoryPath}.style`);
        const originCounts: Partial<Record<GraphCategoryOrigin, number>> = {};
        for (const [origin, count] of Object.entries(origins)) {
            const normalizedCount = integerAt(count, `${categoryPath}.origin_counts.${origin}`, 0);
            // The canonical schema deliberately permits additional origin
            // counters. Preserve the browser DTO's closed origin vocabulary
            // while still validating extension values from newer cfs builds.
            if (CATEGORY_ORIGINS.has(origin as GraphCategoryOrigin)) {
                originCounts[origin as GraphCategoryOrigin] = normalizedCount;
            }
        }
        return [name, {
            nodeCount: integerAt(category.node_count, `${categoryPath}.node_count`, 0),
            originCounts,
            style: {
                color: stringAt(style.color, `${categoryPath}.style.color`),
                background: stringAt(style.background, `${categoryPath}.style.background`)
            }
        }];
    }));
}

function normalizeBucketRects(value: unknown): Readonly<Record<string, WorkspaceGraphBucketRect>> {
    const rects = objectAt(value, '$.layout.bucket_rects');
    return Object.fromEntries(Object.entries(rects).map(([name, raw]) => {
        const rectPath = `$.layout.bucket_rects.${name}`;
        const rect = objectAt(raw, rectPath);
        return [name, {
            id: stringAt(rect.id, `${rectPath}.id`),
            x: numberAt(rect.x, `${rectPath}.x`),
            y: numberAt(rect.y, `${rectPath}.y`),
            w: numberAt(rect.w, `${rectPath}.w`),
            h: numberAt(rect.h, `${rectPath}.h`),
            label: stringAt(rect.label, `${rectPath}.label`)
        }];
    }));
}

function normalizeCategoryBands(value: unknown): Readonly<Record<string, WorkspaceGraphCategoryBand>> {
    const bands = objectAt(value, '$.layout.category_bands');
    return Object.fromEntries(Object.entries(bands).map(([name, raw]) => {
        const bandPath = `$.layout.category_bands.${name}`;
        const band = objectAt(raw, bandPath);
        return [name, {
            x: numberAt(band.x, `${bandPath}.x`),
            y: numberAt(band.y, `${bandPath}.y`),
            w: numberAt(band.w, `${bandPath}.w`),
            h: numberAt(band.h, `${bandPath}.h`),
            label: stringAt(band.label, `${bandPath}.label`),
            ...(band.fill === undefined ? {} : { fill: stringAt(band.fill, `${bandPath}.fill`) }),
            ...(band.stroke === undefined ? {} : { stroke: stringAt(band.stroke, `${bandPath}.stroke`) }),
            ...(band.title_color === undefined ? {} : { titleColor: stringAt(band.title_color, `${bandPath}.title_color`) })
        }];
    }));
}

function validateRawCfsMap(payload: unknown): void {
    if (validateCanonicalMap(payload)) {
        return;
    }
    const error = validateCanonicalMap.errors?.[0];
    if (!error) {
        throw new CfsMapAdapterError('does not match the canonical map schema', '$');
    }
    throw new CfsMapAdapterError(schemaErrorMessage(error), schemaErrorPath(error));
}

function schemaErrorPath(error: ErrorObject): string {
    const segments = error.instancePath
        .split('/')
        .slice(1)
        .map(segment => segment.replace(/~1/gu, '/').replace(/~0/gu, '~'));
    if (error.keyword === 'required') {
        segments.push((error.params as { missingProperty: string }).missingProperty);
    }
    return segments.reduce((result, segment) => (
        /^(?:0|[1-9]\d*)$/u.test(segment)
            ? `${result}[${segment}]`
            : /^[A-Za-z_$][A-Za-z0-9_$-]*$/u.test(segment)
                ? `${result}.${segment}`
                : `${result}[${JSON.stringify(segment)}]`
    ), '$');
}

function schemaErrorMessage(error: ErrorObject): string {
    if (error.keyword === 'required') {
        return 'expected a required property';
    }
    if (error.keyword === 'const') {
        const expected = (error.params as { allowedValue: unknown }).allowedValue;
        return typeof expected === 'string'
            ? `expected "${sanitizeLabel(expected)}"`
            : 'does not match the supported canonical value';
    }
    return `does not match the canonical map schema (${sanitizeLabel(error.keyword)})`;
}

function objectAt(value: unknown, valuePath: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new CfsMapAdapterError('expected an object', valuePath);
    }
    return value as Record<string, unknown>;
}

function optionalObject(value: unknown, valuePath: string): Record<string, unknown> | undefined {
    return value === undefined ? undefined : objectAt(value, valuePath);
}

function arrayAt(value: unknown, valuePath: string, maxItems: number): readonly unknown[] {
    if (!Array.isArray(value)) {
        throw new CfsMapAdapterError('expected an array', valuePath);
    }
    if (value.length > maxItems) {
        throw new CfsMapAdapterError(`exceeds the ${maxItems} item limit`, valuePath);
    }
    return value;
}

function stringAt(value: unknown, valuePath: string): string {
    if (typeof value !== 'string') {
        throw new CfsMapAdapterError('expected a string', valuePath);
    }
    return value;
}

function nullableString(value: unknown, valuePath: string): string | null {
    return value === null ? null : stringAt(value, valuePath);
}

function dateString(value: unknown, valuePath: string): string {
    const result = stringAt(value, valuePath);
    if (!Number.isFinite(Date.parse(result))) {
        throw new CfsMapAdapterError('expected an ISO date-time string', valuePath);
    }
    return result;
}

function equalString(value: unknown, expected: string, valuePath: string): void {
    if (value !== expected) {
        throw new CfsMapAdapterError(`expected "${expected}"`, valuePath);
    }
}

function booleanAt(value: unknown, valuePath: string): boolean {
    if (typeof value !== 'boolean') {
        throw new CfsMapAdapterError('expected a boolean', valuePath);
    }
    return value;
}

function numberAt(value: unknown, valuePath: string): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new CfsMapAdapterError('expected a finite number', valuePath);
    }
    return value;
}

function integerAt(value: unknown, valuePath: string, minimum: number): number {
    const result = numberAt(value, valuePath);
    if (!Number.isInteger(result) || result < minimum) {
        throw new CfsMapAdapterError(`expected an integer >= ${minimum}`, valuePath);
    }
    return result;
}

function nullableInteger(value: unknown, valuePath: string, minimum: number): number | null {
    return value === null ? null : integerAt(value, valuePath, minimum);
}

function enumString<T extends string>(value: unknown, allowed: ReadonlySet<T>, valuePath: string): T {
    const result = stringAt(value, valuePath);
    if (!allowed.has(result as T)) {
        throw new CfsMapAdapterError(`unsupported value "${result}"`, valuePath);
    }
    return result as T;
}

function stringArray(value: unknown, valuePath: string): readonly string[] {
    return arrayAt(value, valuePath, MAX_GRAPH_ITEMS).map((item, index) =>
        stringAt(item, `${valuePath}[${index}]`)
    );
}

/**
 * Two edges expressing the same relation are one relation, and their `refs`
 * are both its evidence.
 *
 * The kept edge keeps its id, so anything already addressing it still can.
 * `crossRepo` is true if ANY occurrence crossed a repository boundary — the
 * relation does cross one. `dangling` is true only if EVERY occurrence was
 * dangling: one occurrence that resolved means the target exists, and calling
 * the merged relation dangling would hide it.
 */
function mergeRelation(kept: WorkspaceGraphEdge, duplicate: WorkspaceGraphEdge): WorkspaceGraphEdge {
    const seen = new Set(kept.refs.map(refKey));
    const refs = [...kept.refs];
    for (const ref of duplicate.refs) {
        const key = refKey(ref);
        if (!seen.has(key)) {
            seen.add(key);
            refs.push(ref);
        }
    }
    return {
        ...kept,
        // The cap that bounds a single edge's refs bounds the merged list too,
        // so a pathological map cannot grow one edge without limit.
        refs: refs.slice(0, MAX_GRAPH_ITEMS),
        crossRepo: kept.crossRepo || duplicate.crossRepo,
        dangling: kept.dangling && duplicate.dangling
    };
}

/** Identity of a ref, for dropping ones the map reported twice. */
function refKey(ref: WorkspaceGraphEdgeRef): string {
    return [ref.cptId, ref.line, ref.snippet, ref.defLine, ref.defSnippet].join('\0');
}

function sanitizeLabel(value: string): string {
    return value.replace(/[<>&]/gu, '_').replace(/\s+/gu, ' ').trim().slice(0, 240);
}

function normalizeRelativePath(value: string): string {
    return value.replace(/\\/gu, '/');
}

function isWithin(parent: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(candidate));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
