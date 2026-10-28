import { rowKey, type Row } from "../../common/protocol";
import { pointsOf, implementsPointOf } from "../../common/extension-points";
import type { GearDescriptor } from "../../common/generated/GearDescriptor";
export interface CatalogueNode {
    readonly key: string;
    readonly label: string;
    readonly kind: "category" | "point" | "row";
    readonly row?: Row;
    readonly host?: GearDescriptor;
    readonly point?: string;
    readonly context?: boolean;
    readonly children: CatalogueNode[];
    readonly count?: number;
    readonly hint?: string;
}
export interface CatalogueQuery {
    readonly grouped: boolean;
    readonly search?: string;
    readonly category?: string;
    readonly host?: string;
    readonly point?: string;
    readonly loading?: boolean;
}
export interface CatalogueModel {
    readonly nodes: CatalogueNode[];
    readonly matchedKeys: ReadonlySet<string>;
    readonly count: number;
    readonly total: number;
}
const key = (...parts: string[]): string => JSON.stringify(parts);
export const rowLabel = (row: Row): string => row.gear.display_name || (row.kind === "pending" ? row.gear.gdl_path : row.gear.id);
/** Match entities first; ancestors are context, never additional search results. */
export function searchScore(row: Row, query: string): number | undefined {
    const text = query.trim().toLowerCase();
    if (!text)
        return 0;
    const id = row.kind === "pending" ? "" : row.gear.id.toLowerCase();
    const name = rowLabel(row).toLowerCase();
    const description = row.kind === "pending" ? "" : [row.gear.description ?? "", ...(row.gear.scenarios ?? []).map(s => s.text)].join(" ").toLowerCase();
    const interfaces = row.kind === "projected" ? [
        ...(row.gear.extension_points ?? []).flatMap(p => [p.spec, p.trait_ident, p.sdk_lib]),
        row.gear.implements?.spec ?? "", row.gear.implements?.point?.trait_ident ?? "",
        ...(row.gear.provides ?? []).map(p => JSON.stringify(p)),
        ...(row.gear.consumes ?? []).map(p => JSON.stringify(p)),
    ].join(" ").toLowerCase() : "";
    const metadata = `${row.gear.category ?? ""} ${row.gear.gdl_path}`.toLowerCase();
    if (!text.split(/\s+/).every(word => `${id} ${name} ${description} ${interfaces} ${metadata}`.includes(word)))
        return undefined;
    if (id === text || name === text)
        return 0;
    if (id.startsWith(text) || name.startsWith(text))
        return 1;
    if (id.includes(text) || name.includes(text))
        return 2;
    if (description.includes(text))
        return 3;
    return 4;
}
export function buildCatalogue(rows: readonly Row[], options: CatalogueQuery): CatalogueModel {
    const projected = rows.filter((r): r is Extract<Row, {
        kind: "projected";
    }> => r.kind === "projected");
    const scopeHost = projected.find(r => r.gear.id === options.host)?.gear;
    const eligible = rows.filter(row => {
        if (!options.host && !options.point)
            return true;
        return row.kind === "projected" && !!row.gear.implements &&
            (!options.point || row.gear.implements.spec === options.point) &&
            (!options.host || (!!scopeHost && implementsPointOf(row.gear, scopeHost)));
    });
    const scores = new Map<string, number>();
    for (const row of eligible) {
        const score = searchScore(row, options.search ?? "");
        if (score !== undefined && (!options.category || row.gear.category === options.category))
            scores.set(rowKey(row), score);
    }
    const matches = new Set(scores.keys());
    const groups = new Map<string, CatalogueNode[]>();
    const category = (label: string, node: CatalogueNode): void => {
        const items = groups.get(label) ?? [];
        items.push(node);
        groups.set(label, items);
    };
    const occurrence = (row: Row, host?: GearDescriptor, point?: string): CatalogueNode => ({
        key: host ? key("plugin", host.source, host.gdl_path, point!, rowKey(row)) : key("row", rowKey(row)),
        kind: "row", row, host, point, label: rowLabel(row), children: [], context: !matches.has(rowKey(row)),
    });
    if (!options.grouped) {
        for (const row of eligible)
            if (matches.has(rowKey(row)))
                category(row.gear.category ?? "uncategorised", occurrence(row));
    }
    else {
        for (const row of rows) {
            if (row.kind !== "projected") {
                if (matches.has(rowKey(row)))
                    category(row.gear.category ?? "uncategorised", occurrence(row));
                continue;
            }
            const gear = row.gear;
            const points = pointsOf(gear);
            const hosts = gear.implements ? projected.filter(h => implementsPointOf(gear, h.gear)) : [];
            // A host which also implements a plugin has its own root, plus leaf links under other hosts.
            if (!gear.implements || points.length > 0) {
                const root = occurrence(row);
                for (const point of points) {
                    if (options.host && gear.id !== options.host)
                        continue;
                    if (options.point && point.spec !== options.point)
                        continue;
                    const plugins = projected.filter(p => p.gear.implements?.spec === point.spec);
                    const children = plugins.filter(p => matches.has(rowKey(p))).map(p => occurrence(p, gear, point.spec));
                    if (!matches.has(rowKey(row)) && children.length === 0)
                        continue;
                    root.children.push({ key: key("point", rowKey(row), point.spec), kind: "point", label: point.trait_ident,
                        point: point.spec, host: gear, children, count: children.length,
                        hint: children.length ? undefined : options.loading ? "Loading compatible plugins…" : "No compatible plugins in the loaded catalogue.",
                    });
                }
                if (matches.has(rowKey(row)) || root.children.length)
                    category(gear.implements && hosts.length === 0 ? "Without a matching host" : gear.category ?? "uncategorised", root);
            }
            if (gear.implements && hosts.length === 0 && points.length === 0 && matches.has(rowKey(row))) {
                category("Without a matching host", occurrence(row));
            }
        }
    }
    const rank = (node: CatalogueNode): number => Math.min(node.row ? scores.get(rowKey(node.row)) ?? Infinity : Infinity, ...node.children.map(rank));
    const sort = (nodes: CatalogueNode[]): CatalogueNode[] => nodes.sort((a, b) => ((options.search?.trim() ? rank(a) - rank(b) : 0) || a.label.localeCompare(b.label) || a.key.localeCompare(b.key)));
    const collect = (nodes: CatalogueNode[], result = new Set<string>()): Set<string> => {
        for (const node of nodes) {
            if (node.row && !node.context)
                result.add(rowKey(node.row));
            collect(node.children, result);
        }
        return result;
    };
    const nodes = [...groups].map(([label, children]): CatalogueNode => {
        for (const child of children)
            for (const point of child.children)
                sort(point.children);
        sort(children);
        return { key: key("category", label), kind: "category", label, children, count: collect(children).size,
            hint: label === "Without a matching host" && options.loading ? "Compatibility is still being determined while the catalogue loads." : undefined };
    });
    return { nodes: sort(nodes), matchedKeys: matches, count: matches.size, total: eligible.length };
}
