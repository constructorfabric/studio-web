// One pager for every long list on the Specs screens.
//
// A synced repository is thousands of files, and the lists that come out of it
// (rows, findings, clusters, references) used to either mount all of it or cut
// it at an arbitrary 200 or 300 without saying so. A page bounds what is
// mounted and says where in the whole the reader is.
import { useEffect, useMemo, useState } from "react";

export const PAGE_SIZE = 50;

/** The page numbers a pager shows: the first, the last, and two either side of
 *  the current one, with `null` where a run is skipped. */
export function pageWindow(current: number, pages: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let p = 0; p < pages; p++) {
    if (p === 0 || p === pages - 1 || Math.abs(p - current) <= 2) out.push(p);
    else if (out[out.length - 1] !== null) out.push(null);
  }
  return out;
}

export interface Paged<T> {
  /** The rows of the current page. */
  visible: T[];
  /** Index of the first visible row in the whole list. */
  offset: number;
  page: number;
  pages: number;
  total: number;
  setPage: (page: number) => void;
}

/** Page `items`. Back to the first page whenever `resetOn` changes: a new
 *  filter is a new question, and answering it from page 8 of the previous one
 *  would be a strange place to start reading. A list that shrinks under the
 *  reader (a decision moved rows out of it) lands them on its last page. */
export function usePaged<T>(items: readonly T[], resetOn: unknown = null, size = PAGE_SIZE): Paged<T> {
  const [page, setPage] = useState(0);
  useEffect(() => setPage(0), [resetOn]);
  const pages = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(page, pages - 1);
  const visible = useMemo(
    () => items.slice(current * size, (current + 1) * size),
    [items, current, size],
  );
  return { visible, offset: current * size, page: current, pages, total: items.length, setPage };
}

/** « ‹ 1 2 3 … 49 › »  51–100 of 2,446. Renders nothing for a single page. */
export function Pager<T>({ paged, className }: { paged: Paged<T>; className?: string }) {
  const { page, pages, total, offset, visible, setPage } = paged;
  if (pages <= 1) return null;
  return (
    <div className={className ? `pager ${className}` : "pager"}>
      <style>{PAGER_CSS}</style>
      <button onClick={() => setPage(0)} disabled={page === 0} title="First page" aria-label="First page">
        «
      </button>
      <button onClick={() => setPage(page - 1)} disabled={page === 0} title="Previous page" aria-label="Previous page">
        ‹
      </button>
      {pageWindow(page, pages).map((p, i) =>
        p == null ? (
          <span key={`gap-${i}`} className="pager-gap">
            …
          </span>
        ) : (
          <button
            key={p}
            className={p === page ? "on" : undefined}
            aria-current={p === page ? "page" : undefined}
            onClick={() => setPage(p)}
          >
            {p + 1}
          </button>
        ),
      )}
      <button onClick={() => setPage(page + 1)} disabled={page >= pages - 1} title="Next page" aria-label="Next page">
        ›
      </button>
      <button onClick={() => setPage(pages - 1)} disabled={page >= pages - 1} title="Last page" aria-label="Last page">
        »
      </button>
      <span className="pager-range">
        {offset + 1}–{offset + visible.length} of {total.toLocaleString()}
      </span>
    </div>
  );
}

const PAGER_CSS = `
.pager { display: flex; align-items: center; gap: 2px; padding: 8px 0 2px; font-size: 12px; }
.pager button { min-width: 26px; height: 24px; padding: 0 6px; font-size: 12px; line-height: 1; }
.pager button.on { background: var(--primary); color: var(--primary-foreground); border-color: var(--primary); }
.pager-gap { padding: 0 4px; color: var(--muted-foreground); }
.pager-range { margin-left: 8px; color: var(--muted-foreground); font-variant-numeric: tabular-nums; }
`;
