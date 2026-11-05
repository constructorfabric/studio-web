import type { ActivityEvent } from "./api";

/** Free-text filter across everything a row shows.
 *
 *  Across every column, because the search box sits over the table and a
 *  reader typing a detector name into it means "find that", not "find that in
 *  the column I have not told you about".
 *
 *  This stays in the browser deliberately, unlike the fold that produced the
 *  rows: it narrows what is already on screen as somebody types, and a request
 *  per keystroke would be a worse answer to the same question.
 */
export function matchesQuery(event: ActivityEvent, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [event.event, event.subject, event.by, event.severity ?? "", event.recorded ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

/** A row of the Activity table: one event, or a run of the same event one
 *  after another ("220 documents checked"), which opens to its events. */
export interface ActivityRow extends ActivityEvent {
  /** The events a collapsed run stands for, newest first; absent for one. */
  items?: ActivityEvent[];
}

/** Runs shorter than this stay as they are: two of a kind read fine. */
export const RUN_MIN = 3;

/** Folds runs of the same check in a row -- a sync that checked every
 *  document leaves hundreds of "Document checked" -- into one row each. The
 *  feed's order is kept; a run is dated by its newest event. Comments stay
 *  one per row: each is something a person said. */
export function collapseRuns(events: readonly ActivityEvent[], min = RUN_MIN): ActivityRow[] {
  const out: ActivityRow[] = [];
  let i = 0;
  while (i < events.length) {
    let j = i + 1;
    while (j < events.length && events[j].event === events[i].event && events[j].kind === events[i].kind) j++;
    const run = events.slice(i, j);
    if (run.length < min || run[0].kind === "comment") out.push(...run);
    else {
      const by = [...new Set(run.map((e) => e.by))];
      const newest = run.reduce((a, e) => ((e.recorded ?? "") > (a.recorded ?? "") ? e : a), run[0]);
      out.push({
        id: `run:${run[0].id}`,
        kind: run[0].kind,
        event: run[0].event,
        subject: `${run.length} documents`,
        by: by.length <= 3 ? by.join(", ") : `${by.slice(0, 3).join(", ")} +${by.length - 3}`,
        recorded: newest.recorded ?? null,
        severity: run.some((e) => e.severity === "high") ? "high" : null,
        items: run,
      });
    }
    i = j;
  }
  return out;
}
