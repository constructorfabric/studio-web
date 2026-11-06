/* ── The one list component ─────────────────────────────────────────────────
 *
 * Every table and tile list in the prototype is this component, so every one
 * behaves the way docs/list-standard.md says: the same toolbar, row click,
 * "…" menu, confirm, sorting headers, filter chips, pager, address, time
 * format, and empty / loading / failed states. A screen describes what is its
 * own — columns, rows, filters, actions — and nothing about behaviour.
 *
 * Rows come from one of two sources, and the person cannot tell which:
 *   - `rows`: the whole list is here; search, filters, sort and paging run in
 *     the browser (`applyClient`).
 *   - `load`: the backend pages; the table asks it for exactly the page on
 *     screen, with the search, filters and sort as query parameters.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from "react";

import { errText, relTime } from "./format";
import { applyClient, useListState } from "./list-state";
import type { ClientFilter, ListState } from "./list-state";
import { Modal } from "./modal";
import { PAGE_SIZE, PAGE_SIZES, Pager } from "./pager";
import type { Paged } from "./pager";
import { EmptyState } from "./ui-standard";
import { TileGrid, ViewToggle, usePageSize, useViewMode } from "./view-mode";
import type { ViewMode } from "./view-mode";

/* ── Pieces a screen may use on its own ──────────────────────────────────── */

/** A time, the one way: relative, with the full timestamp on hover. "—" when
 *  there is no time or it does not parse. */
export function When({ iso, className }: { iso: string | null | undefined; className?: string }) {
  const parsed = iso ? Date.parse(iso) : Number.NaN;
  if (!iso || Number.isNaN(parsed)) return <span className={className}>—</span>;
  const full = new Date(parsed).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <time className={className} dateTime={iso} title={full}>
      {relTime(iso)}
    </time>
  );
}

export interface ConfirmSpec {
  /** "Delete project “studio-web”?" */
  title: string;
  /** What happens, in one or two sentences. */
  body?: ReactNode;
  /** The button: "Delete", "Detach", "Revoke". */
  confirmLabel: string;
}

/** The one confirm dialog for destructive actions (never `window.confirm`). */
export function ConfirmDialog({
  spec,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  spec: ConfirmSpec;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal label={spec.title} onClose={busy ? () => undefined : onCancel} cardClassName="dt-confirm">
      <h3>{spec.title}</h3>
      {spec.body && <div className="dt-confirm-body">{spec.body}</div>}
      {error && <div className="error">{error}</div>}
      <div className="dt-confirm-actions">
        <button className="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="danger" onClick={onConfirm} disabled={busy}>
          {busy ? "Working…" : spec.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}

/** A confirm around any action: `ask(spec, run)` opens the dialog and runs
 *  `run` on confirm, keeping the dialog open with the error if it fails. */
export function useConfirm(): [(spec: ConfirmSpec, run: () => Promise<unknown> | unknown) => void, ReactNode] {
  const [pending, setPending] = useState<{ spec: ConfirmSpec; run: () => Promise<unknown> | unknown } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ask = useCallback((spec: ConfirmSpec, run: () => Promise<unknown> | unknown) => {
    setError(null);
    setPending({ spec, run });
  }, []);
  const dialog = pending ? (
    <ConfirmDialog
      spec={pending.spec}
      busy={busy}
      error={error}
      onCancel={() => setPending(null)}
      onConfirm={async () => {
        setBusy(true);
        setError(null);
        try {
          await pending.run();
          setPending(null);
        } catch (e) {
          setError(errText(e));
        } finally {
          setBusy(false);
        }
      }}
    />
  ) : null;
  return [ask, dialog];
}

export interface RowAction {
  label: string;
  onSelect: () => Promise<unknown> | unknown;
  /** Destructive: last in the menu, styled as danger, and always confirmed. */
  danger?: ConfirmSpec;
  disabled?: boolean;
}

/** The "…" menu. Closes on Escape, on a click outside, and after a choice —
 *  never because the pointer wandered off it. Arrow keys move between items. */
export function RowMenu({
  label,
  actions,
  onRun,
}: {
  label: string;
  actions: RowAction[];
  onRun: (action: RowAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    // Pointer DOWN outside, not click: it cannot be the click that opened the
    // menu, which is what closed the old one before it was ever seen (#568).
    const onDown = (e: PointerEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    root.current?.querySelector<HTMLButtonElement>('[role="menuitem"]:not([disabled])')?.focus();
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Destructive last, whatever order the screen listed them in.
  const ordered = [...actions.filter((a) => !a.danger), ...actions.filter((a) => a.danger)];
  if (ordered.length === 0) return null;

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "ArrowDown" ? (at + 1) % items.length : (at - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div className="prowmenu dt-noopen" ref={root}>
      <button
        ref={button}
        className="ghost"
        aria-label={`Actions for ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        …
      </button>
      {open && (
        <div className="prowmenu-list" role="menu" id={menuId} onKeyDown={onMenuKey}>
          {ordered.map((action) => (
            <button
              key={action.label}
              role="menuitem"
              className={action.danger ? "danger" : undefined}
              disabled={action.disabled}
              onClick={() => {
                setOpen(false);
                onRun(action);
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── The table ───────────────────────────────────────────────────────────── */

export interface Column<T> {
  id: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Sorts in the browser with this comparator (ascending). */
  compare?: (a: T, b: T) => number;
  /** Sorts on the server under this column's id (with `load`). */
  serverSort?: boolean;
  /** A number: right-aligned, tabular, as narrow as it can be. */
  num?: boolean;
  width?: string;
  className?: string;
}

export interface FilterOption {
  value: string;
  label: string;
  /** A list paged by the backend cannot count its own options: the screen
   *  may say how many there are. Unknown, the chip shows no count at all. */
  count?: number;
}

export interface Filter<T> {
  id: string;
  /** The "all" choice's label: "All kinds". */
  allLabel: string;
  options: FilterOption[];
  /** Chips when there are a few options, a select when there are many. */
  kind?: "chips" | "select";
  /** Required for `rows`; with `load` the value is sent as `f.<id>`. */
  match?: (row: T, value: string) => boolean;
}

/** What EmptyState (ui-standard.tsx) shows when the list holds nothing. */
export interface EmptySpec {
  /** "No projects yet." */
  title: string;
  /** What would put something here. */
  body?: ReactNode;
  action?: ReactNode;
}

export interface PageRequest {
  q: string;
  filters: Record<string, string>;
  sort: ListState["sort"];
  offset: number;
  limit: number;
}

export interface PageResult<T> {
  items: T[];
  total: number;
}

interface CommonProps<T> {
  /** Names the list: the view preference key, and the address prefix when a
   *  screen has more than one list (`urlPrefix`). */
  list: string;
  urlPrefix?: string;
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** The row's name, for the "…" button's label and the tile. */
  rowLabel: (row: T) => string;
  /** Opens the row: row click, Enter or Space. Omitted, rows are not clickable. */
  onOpen?: (row: T) => void;
  /** Which rows have something to open; the rest do not look clickable. */
  canOpen?: (row: T) => boolean;
  /** The row the pointer or focus is on, `null` once it leaves the table:
   *  for a screen that previews a row before it is opened. */
  onPeek?: (row: T | null) => void;
  actions?: (row: T) => RowAction[];
  /** An inline action beside the menu, when the row exists for one. */
  inline?: (row: T) => ReactNode;
  /** Details a ▸ toggle expands under the row. */
  expand?: (row: T) => ReactNode;
  /** The row itself is the toggle too: a click, Enter or Space anywhere on it
   *  expands it. For a list whose rows exist to be looked into; with `onOpen`
   *  the row opens instead. */
  expandOnClick?: boolean;
  /** A panel the SCREEN opens under a row — an editor, a browser — from one
   *  of the row's actions. Shown whenever it returns something. */
  detail?: (row: T) => ReactNode;
  search?: { placeholder: string };
  filters?: Filter<T>[];
  /** Tiles as the other view; omitted, the list is a table only. */
  tile?: (row: T, open: (() => void) | undefined) => ReactNode;
  /** Heading on the toolbar's left: "Projects". */
  title?: ReactNode;
  /** The list's primary action, on the toolbar's right. */
  primary?: ReactNode;
  empty: EmptySpec;
  /** The page size until the reader picks one in the pager. */
  pageSize?: number;
  /** The view until the reader picks one: a table, unless the list reads
   *  better as cards. */
  defaultView?: ViewMode;
  /** Anything else to put in the toolbar, after the filters. */
  extra?: ReactNode;
}

interface RowsProps<T> extends CommonProps<T> {
  /** `null` while loading. */
  rows: T[] | null;
  error?: string | null;
  onRetry?: () => void;
  searchText?: (row: T) => (string | null | undefined)[];
  load?: never;
}

interface LoadProps<T> extends CommonProps<T> {
  load: (req: PageRequest) => Promise<PageResult<T>>;
  /** Anything that should load the list again when it changes. */
  reloadKey?: unknown;
  /** Told each page as it arrives — for a screen that refreshes while what
   *  is on it is still moving. */
  onLoaded?: (page: PageResult<T>) => void;
  rows?: never;
  searchText?: never;
}

export type DataTableProps<T> = RowsProps<T> | LoadProps<T>;

const INTERACTIVE = "button, a, input, select, textarea, label, summary, [role=menu], .dt-noopen";

export function DataTable<T>(props: DataTableProps<T>) {
  const [size, setSize] = usePageSize(`${props.list}.size`, props.pageSize ?? PAGE_SIZE, PAGE_SIZES);
  const [state, list] = useListState(props.urlPrefix ?? "");
  const [view, setView] = useViewMode(`${props.list}.view`, props.defaultView);
  const mode = props.tile ? view : "table";
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [ask, confirmDialog] = useConfirm();
  const [actionError, setActionError] = useState<string | null>(null);

  /* Whole list: everything in the browser. */
  const clientFilters: ClientFilter<T>[] = useMemo(
    () =>
      (props.filters ?? [])
        .filter((f) => f.match)
        .map((f) => ({ id: f.id, match: f.match!, options: f.options })),
    [props.filters],
  );
  const comparators = useMemo(() => {
    const out: Record<string, (a: T, b: T) => number> = {};
    for (const c of props.columns) if (c.compare) out[c.id] = c.compare;
    return out;
  }, [props.columns]);
  const client = useMemo(() => {
    if (props.load || !props.rows) return null;
    return applyClient(props.rows, state, {
      searchText: props.searchText,
      filters: clientFilters,
      comparators,
    });
  }, [props.load, props.rows, props.searchText, state, clientFilters, comparators]);

  /* Paged by the backend: ask for the page on screen. */
  const [server, setServer] = useState<{ items: T[]; total: number } | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [serverLoading, setServerLoading] = useState(false);
  const [retryTick, setRetryTick] = useState(0);
  const load = props.load;
  const reloadKey = props.load ? (props as LoadProps<T>).reloadKey : undefined;
  const onLoadedRef = useRef<((page: PageResult<T>) => void) | undefined>(undefined);
  onLoadedRef.current = props.load ? (props as LoadProps<T>).onLoaded : undefined;
  const stateKey = JSON.stringify(state);
  useEffect(() => {
    if (!load) return;
    let live = true;
    setServerLoading(true);
    load({ q: state.q, filters: state.filters, sort: state.sort, offset: state.page * size, limit: size })
      .then((page) => {
        if (!live) return;
        setServerError(null);
        setServer(page);
        onLoadedRef.current?.(page);
      })
      .catch((e) => live && setServerError(errText(e)))
      .finally(() => live && setServerLoading(false));
    return () => {
      live = false;
    };
    // `stateKey` stands for `state`, which is a new object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load, stateKey, size, reloadKey, retryTick]);

  const error = props.load ? serverError : (props as RowsProps<T>).error ?? null;
  // A failure is shown as one, never as "Loading…" that does not end.
  const loading = !error && (props.load ? serverLoading && !server : props.rows === null);
  const retry = props.load ? () => setRetryTick((t) => t + 1) : (props as RowsProps<T>).onRetry;

  const total = props.load ? server?.total ?? 0 : client?.matched.length ?? 0;
  const pages = Math.max(1, Math.ceil(total / size));
  const page = Math.min(state.page, pages - 1);
  const visible: T[] = props.load
    ? server?.items ?? []
    : (client?.matched ?? []).slice(page * size, (page + 1) * size);
  const everything = props.load ? null : props.rows?.length ?? 0;
  const filtered = state.q.trim() !== "" || Object.keys(state.filters).length > 0;

  const paged: Paged<T> = {
    visible,
    offset: page * size,
    page,
    pages,
    total,
    setPage: list.setPage,
  };

  const run = (action: RowAction) => {
    setActionError(null);
    if (action.danger) {
      ask(action.danger, action.onSelect);
      return;
    }
    Promise.resolve()
      .then(action.onSelect)
      .catch((e) => setActionError(errText(e)));
  };

  const opens = (row: T) => !!props.onOpen && (props.canOpen?.(row) ?? true);
  const toggles = !props.onOpen && !!props.expand && !!props.expandOnClick;
  const clickable = (row: T) => opens(row) || toggles;
  const activate = (row: T) => (opens(row) ? props.onOpen!(row) : toggle(props.rowKey(row)));
  const openFrom = (row: T) => (e: ReactMouseEvent) => {
    if (!clickable(row)) return;
    if (e.target instanceof Element && e.target.closest(INTERACTIVE)) return;
    activate(row);
  };
  const keyOpen = (row: T) => (e: ReactKeyboardEvent) => {
    if (!clickable(row) || e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate(row);
    }
  };
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const count =
    everything === null
      ? server
        ? total.toLocaleString()
        : "—"
      : filtered
        ? `${total.toLocaleString()} of ${everything.toLocaleString()}`
        : everything.toLocaleString();

  const hasActions = !!props.actions || !!props.inline;
  const colCount = props.columns.length + (props.expand ? 1 : 0) + (hasActions ? 1 : 0);

  return (
    <div className="dt">
      <div className="dt-toolbar">
        <div className="dt-toolbar-left">
          {props.title && (
            <h2 className="dt-title">
              {props.title} <span className="dt-count">· {count}</span>
            </h2>
          )}
          {props.search && (
            <input
              className="dt-search"
              type="search"
              placeholder={props.search.placeholder}
              aria-label={props.search.placeholder}
              value={state.q}
              onChange={(e) => list.setQ(e.target.value)}
            />
          )}
          {(props.filters ?? []).map((f) =>
            (f.kind ?? (f.options.length <= 5 ? "chips" : "select")) === "chips" ? (
              <div key={f.id} className="dt-chips" role="group" aria-label={f.allLabel}>
                <button
                  className={`chip ${!state.filters[f.id] ? "on" : ""}`}
                  aria-pressed={!state.filters[f.id]}
                  onClick={() => list.setFilter(f.id, null)}
                >
                  {f.allLabel}
                </button>
                {f.options.map((o) => (
                  <button
                    key={o.value}
                    className={`chip ${state.filters[f.id] === o.value ? "on" : ""}`}
                    aria-pressed={state.filters[f.id] === o.value}
                    onClick={() => list.setFilter(f.id, state.filters[f.id] === o.value ? null : o.value)}
                  >
                    {o.label}
                    {client && !error ? (
                      <span className="dt-chip-n">{client.counts[f.id]?.[o.value] ?? 0}</span>
                    ) : (
                      o.count !== undefined && <span className="dt-chip-n">{o.count.toLocaleString()}</span>
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <select
                key={f.id}
                className="dt-select"
                aria-label={f.allLabel}
                value={state.filters[f.id] ?? ""}
                onChange={(e) => list.setFilter(f.id, e.target.value || null)}
              >
                <option value="">{f.allLabel}</option>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                    {client && !error ? ` (${client.counts[f.id]?.[o.value] ?? 0})` : ""}
                  </option>
                ))}
              </select>
            ),
          )}
          {props.extra}
        </div>
        <div className="dt-toolbar-right">
          {props.tile && <ViewToggle mode={view} onChange={setView} />}
          {props.primary}
        </div>
      </div>

      {actionError && <div className="error">{actionError}</div>}

      {loading ? (
        <div className="dt-state" role="status">
          Loading…
        </div>
      ) : error ? (
        <div className="dt-state dt-failed" role="alert">
          <div className="error">{error}</div>
          {retry && (
            <button className="ghost" onClick={retry}>
              Retry
            </button>
          )}
        </div>
      ) : total === 0 && !filtered ? (
        <EmptyState {...props.empty} />
      ) : total === 0 ? (
        <EmptyState
          title="Nothing matches."
          action={
            <button className="ghost" onClick={list.clearFilters}>
              Clear filters
            </button>
          }
        />
      ) : mode === "tiles" && props.tile ? (
        <TileGrid>
          {visible.map((row) => (
            <div key={props.rowKey(row)} className="dt-tile">
              {props.tile!(row, opens(row) ? () => props.onOpen!(row) : undefined)}
            </div>
          ))}
        </TileGrid>
      ) : (
        <table className="ptable dt-table">
          <thead>
            <tr>
              {props.expand && <th className="dt-twisty-col" aria-label="Details" />}
              {props.columns.map((c) => {
                const sortable = !!c.compare || (!!c.serverSort && !!props.load);
                const sorted = state.sort?.key === c.id ? state.sort.dir : null;
                return (
                  <th
                    key={c.id}
                    className={[c.num ? "pnum" : "", c.className ?? ""].join(" ").trim() || undefined}
                    style={c.width ? { width: c.width } : undefined}
                    aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : sortable ? "none" : undefined}
                  >
                    {sortable ? (
                      <button className="dt-sort" onClick={() => list.toggleSort(c.id)}>
                        {c.header}
                        <span className="dt-sort-mark" aria-hidden>
                          {sorted === "asc" ? "▲" : sorted === "desc" ? "▼" : "↕"}
                        </span>
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
              {hasActions && <th className="pactions" aria-label="Actions" />}
            </tr>
          </thead>
          <tbody
            onMouseLeave={props.onPeek ? () => props.onPeek!(null) : undefined}
            onBlur={
              props.onPeek
                ? (e) => {
                    // Focus moving to another row peeks that one.
                    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) props.onPeek!(null);
                  }
                : undefined
            }
          >
            {visible.map((row) => {
              const key = props.rowKey(row);
              const open = expanded.has(key);
              return [
                <tr
                  key={key}
                  className={clickable(row) ? "dt-row dt-open" : "dt-row"}
                  tabIndex={clickable(row) ? 0 : undefined}
                  aria-expanded={toggles ? open : undefined}
                  onClick={openFrom(row)}
                  onKeyDown={keyOpen(row)}
                  onMouseEnter={props.onPeek ? () => props.onPeek!(row) : undefined}
                  onFocus={props.onPeek ? () => props.onPeek!(row) : undefined}
                >
                  {props.expand && (
                    <td className="dt-twisty-col">
                      <button
                        className="ghost dt-twisty"
                        aria-expanded={open}
                        aria-label={`${open ? "Hide" : "Show"} details of ${props.rowLabel(row)}`}
                        onClick={() => toggle(key)}
                      >
                        {open ? "▾" : "▸"}
                      </button>
                    </td>
                  )}
                  {props.columns.map((c) => (
                    <td key={c.id} className={[c.num ? "pnum" : "", c.className ?? ""].join(" ").trim() || undefined}>
                      {c.cell(row)}
                    </td>
                  ))}
                  {hasActions && (
                    <td className="pactions">
                      {props.inline?.(row)}
                      {props.actions && (
                        <RowMenu label={props.rowLabel(row)} actions={props.actions(row)} onRun={run} />
                      )}
                    </td>
                  )}
                </tr>,
                open && props.expand ? (
                  <tr key={`${key}:detail`} className="dt-detail">
                    <td colSpan={colCount}>{props.expand(row)}</td>
                  </tr>
                ) : null,
                (() => {
                  const panel = props.detail?.(row);
                  return panel ? (
                    <tr key={`${key}:panel`} className="dt-detail">
                      <td colSpan={colCount}>{panel}</td>
                    </tr>
                  ) : null;
                })(),
              ];
            })}
          </tbody>
        </table>
      )}

      {!loading && !error && total > 0 && (
        <Pager
          paged={paged}
          pageSize={{
            size,
            // A new size is a new set of pages: page 8 of the old one would
            // land somewhere nobody chose.
            onSize: (next) => {
              setSize(next);
              list.setPage(0);
            },
          }}
        />
      )}
      {confirmDialog}
    </div>
  );
}
