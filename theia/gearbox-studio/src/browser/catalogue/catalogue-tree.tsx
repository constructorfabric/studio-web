import React from "@theia/core/shared/react";
import { rowKey, type Row } from "../../common/protocol";
import { MaturityBadge } from "../gear/gear-facts";
import { GEARBOX_DRAG_MIME } from "../ai/gearbox-context";
import { buildCatalogue, type CatalogueNode, type CatalogueQuery } from "./catalogue-model";
export interface CatalogueTreeProps extends CatalogueQuery {
    readonly rows: readonly Row[];
    readonly selectedKey?: string;
    readonly selectedHost?: string;
    readonly surface: "catalogue" | "add";
    readonly inProduct: (id: string) => boolean;
    readonly onSelect: (node: CatalogueNode) => void;
    readonly onReveal?: (row: Row) => void;
    readonly actions?: (node: CatalogueNode, selected: boolean) => React.ReactNode;
}
interface Visible {
    node: CatalogueNode;
    depth: number;
    parent?: string;
}
/** One renderer and keyboard model for browsing and adding, with local disclosure state. */
export function CatalogueTree(props: CatalogueTreeProps): React.ReactElement {
    const model = buildCatalogue(props.rows, props);
    const root = React.useRef<HTMLDivElement>(null) as {
        current: HTMLDivElement | null;
    };
    const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
    const [focused, setFocused] = React.useState<string>();
    const [copyError, setCopyError] = React.useState<string>();
    const [preferred, setPreferred] = React.useState<string>();
    const select = (node: CatalogueNode): void => { setPreferred(node.key); props.onSelect(node); };
    const ownedFocus = React.useRef(false);
    const focusRequest = React.useRef<string | undefined>(undefined);
    const all: Visible[] = [];
    const index = (nodes: CatalogueNode[], depth: number, parent?: string): void => {
        for (const node of nodes) {
            all.push({ node, depth, parent });
            index(node.children, depth + 1, node.key);
        }
    };
    index(model.nodes, 1);
    const candidates = all.filter(v => v.node.row && rowKey(v.node.row) === props.selectedKey);
    const selected = (candidates.find(v => v.node.key === preferred && (!props.selectedHost || v.node.host?.id === props.selectedHost)) ??
        candidates.find(v => props.selectedHost && v.node.host?.id === props.selectedHost) ?? candidates.find(v => !v.node.host) ?? candidates[0])?.node.key;
    const searching = !!props.search?.trim();
    const branch = (node: CatalogueNode): boolean => node.kind !== "row" || node.children.length > 0;
    const stateKey = (key: string): string => `${props.grouped}:${key}`;
    const isOpen = (node: CatalogueNode): boolean => searching || (expanded[stateKey(node.key)] ?? node.kind !== "point");
    const visible: Visible[] = [];
    const walk = (nodes: CatalogueNode[], depth: number, parent?: string): void => {
        for (const node of nodes) {
            visible.push({ node, depth, parent });
            if (branch(node) && isOpen(node))
                walk(node.children, depth + 1, node.key);
        }
    };
    walk(model.nodes, 1);
    const tabKey = visible.some(v => v.node.key === focused) ? focused : visible.some(v => v.node.key === selected) ? selected : visible[0]?.node.key;
    const focus = (key: string): void => {
        focusRequest.current = key;
        setFocused(key);
    };
    React.useLayoutEffect(() => {
        const target = focusRequest.current ?? (ownedFocus.current && document.activeElement === document.body ? tabKey : undefined);
        if (target)
            Array.from(root.current?.querySelectorAll<HTMLElement>("[data-occurrence-key]") ?? []).find(e => e.dataset.occurrenceKey === target)?.focus();
        focusRequest.current = undefined;
    });
    // Reveal the selected occurrence after a view/selection change, without changing the
    // user's saved fold state during a search or when merely clearing the search box.
    React.useEffect(() => {
        if (!selected || searching)
            return;
        const ancestors: string[] = [];
        let at = all.find(v => v.node.key === selected);
        while (at?.parent) {
            ancestors.push(at.parent);
            at = all.find(v => v.node.key === at!.parent);
        }
        setExpanded((previous: Record<string, boolean>) => ({ ...previous, ...Object.fromEntries(ancestors.map(k => [stateKey(k), true])) }));
        if (ownedFocus.current)
            focus(selected);
    }, [props.grouped, props.selectedKey, props.selectedHost, selected]);
    const toggle = (node: CatalogueNode): void => setExpanded((previous: Record<string, boolean>) => ({ ...previous, [stateKey(node.key)]: !isOpen(node) }));
    const move = (event: React.KeyboardEvent, item: Visible): void => {
        if (event.target !== event.currentTarget)
            return;
        const at = visible.findIndex(v => v.node.key === item.node.key);
        let target: Visible | undefined;
        if (event.key === "ArrowDown")
            target = visible[Math.min(at + 1, visible.length - 1)];
        if (event.key === "ArrowUp")
            target = visible[Math.max(at - 1, 0)];
        if (event.key === "Home")
            target = visible[0];
        if (event.key === "End")
            target = visible[visible.length - 1];
        if (event.key === "ArrowRight" && branch(item.node)) {
            if (!isOpen(item.node))
                toggle(item.node);
            else
                target = visible[at + 1]?.parent === item.node.key ? visible[at + 1] : undefined;
        }
        else if (event.key === "ArrowLeft") {
            if (branch(item.node) && isOpen(item.node) && !searching)
                toggle(item.node);
            else
                target = visible.find(v => v.node.key === item.parent);
        }
        else if (event.key === "Enter" || event.key === " ") {
            if (item.node.row) {
                if (event.key === "Enter" && selected === item.node.key && props.onReveal)
                    props.onReveal(item.node.row);
                else
                    select(item.node);
            }
            else
                toggle(item.node);
        }
        if (["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft", "Home", "End", "Enter", " "].includes(event.key)) {
            event.preventDefault();
            event.stopPropagation();
        }
        if (target) {
            focus(target.node.key);
            if (target.node.row)
                select(target.node);
        }
    };
    const render = (nodes: CatalogueNode[], depth: number): React.ReactNode => nodes.map((node, position) => {
        const row = node.row, chosen = selected === node.key, open = branch(node) ? isOpen(node) : undefined;
        const id = row && row.kind !== "pending" ? row.gear.id : undefined;
        const item = all.find(v => v.node.key === node.key)!;
        return <React.Fragment key={node.key}>
      <div role="treeitem" aria-level={depth} aria-posinset={position + 1} aria-setsize={nodes.length} aria-expanded={open} aria-selected={row ? chosen : undefined} aria-label={node.label} data-occurrence-key={node.key} data-row-key={row ? rowKey(row) : undefined} data-catalogue-host={node.host?.id} data-catalogue-point={node.kind === "point" ? node.point : undefined} data-add-gear-select={props.surface === "add" ? id : undefined} data-context-only={node.context || undefined} data-category={node.kind === "category" ? node.label : undefined} data-collapsed={open === undefined ? undefined : String(!open)} className={`${row ? "gbx-row gbx-catalogue-entry" : "gbx-tree-branch"} ${chosen ? "gbx-selected" : ""} ${row?.kind === "pending" ? "gbx-pending" : ""}`} tabIndex={tabKey === node.key ? 0 : -1} onFocus={e => { if (e.target === e.currentTarget)
            setFocused(node.key); }} onKeyDown={e => move(e, item)} onClick={() => { if (row)
            select(node);
        else
            toggle(node); }} onDoubleClick={() => { if (row)
            props.onReveal?.(row); }} style={{ paddingInlineStart: `${Math.max(0, depth - 1) * 12 + 6}px` }}>
        <span className="gbx-tree-disclosure">{branch(node) && <button type="button" tabIndex={-1} aria-label={`${open ? "Collapse" : "Expand"} ${node.label}`} aria-expanded={open} onClick={e => { e.stopPropagation(); toggle(node); }}>{open ? "▾" : "▸"}</button>}</span>
        {row ? <>
          <span className="gbx-row-main gbx-catalogue-facts">
            <span className="gbx-row-name">{node.label}</span>
            <span className="gbx-catalogue-badges">
              {row.kind === "projected" && <><span>{row.gear.implements ? "Plugin" : "Gear"}{row.gear.extension_points?.length ? " · Host" : ""}</span><MaturityBadge maturity={row.gear.maturity}/></>}
              {id && props.inProduct(id) && <span className="gbx-badge gbx-badge-in-product" data-in-product-badge={id}>in product</span>}
              {row.kind === "pending" && <span className="gbx-waiting">{props.loading ? "parsing…" : "did not project"}</span>}
            </span>
            {row.kind !== "pending" && row.gear.description && <span className="gbx-catalogue-description">{row.gear.description}</span>}
            {chosen && <details className="gbx-catalogue-technical" onClick={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
              <summary tabIndex={chosen ? 0 : -1}>Details</summary>
              {id && <code className="gbx-id gbx-drag-handle" draggable={row.kind === "projected"} onDragStart={e => {
                            e.dataTransfer.setData(GEARBOX_DRAG_MIME, JSON.stringify({ kind: "gear", id }));
                            e.dataTransfer.setData("text/plain", id);
                        }}>{id}</code>}
              <span>Source: {row.gear.source}</span><code>{row.gear.gdl_path}</code>
                            {row.kind === "projected" && !!row.gear.runtime_caps?.length && <span>Capabilities: {row.gear.runtime_caps.join(", ")}</span>}
                            {id && <button type="button" aria-label={`Copy ${id}`} onClick={() => {
                                setCopyError(undefined);
                                void navigator.clipboard.writeText(id).catch(reason => setCopyError(String(reason)));
                            }}>Copy ID</button>}
              {props.onReveal && <button type="button" tabIndex={chosen ? 0 : -1} onClick={() => props.onReveal!(row)}>Open GDL</button>}
            </details>}
          </span>
          {props.actions?.(node, chosen)}
        </> : <span className="gbx-tree-label">{node.label} <span className="gbx-group-count">{node.count}</span></span>}
      </div>
      {open && <>{render(node.children, depth + 1)}{node.hint && <p className="gbx-tree-hint" role="note">{node.hint}</p>}</>}
    </React.Fragment>;
    });
    return <div className="gbx-catalogue-browser">
    <div className="gbx-catalogue-results" data-catalogue-count={model.count}>{model.count} of {model.total} components</div>
    <div role="tree" aria-label={props.surface === "add" ? "Available gears" : "Gear catalogue"} ref={root} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") event.stopPropagation(); }} onFocusCapture={() => { ownedFocus.current = true; }} onBlurCapture={e => { if (e.relatedTarget && !e.currentTarget.contains(e.relatedTarget as Node))
        ownedFocus.current = false; }}>
      {render(model.nodes, 1)}
    </div>
    {copyError && <p role="alert">Could not copy ID: {copyError}</p>}
        {!model.count && <p className="gbx-empty">No matching components.{props.loading ? " More entries become available as the catalogue loads." : ""}</p>}
  </div>;
}
