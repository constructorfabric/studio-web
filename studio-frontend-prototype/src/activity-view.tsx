/** The project's Activity section.
 *
 *  A PageHeader (what is kept is behind its "?"; how many comments and
 *  checks are its line), the kinds as a segmented choice -- Comments first
 *  when there are any, since a check is a machine's and a comment a
 *  person's -- and the table of Event / Document / By / Recorded. A run of
 *  the same check one after another (a sync that checked every document) is
 *  one row, "220 documents", which opens to its events.
 *
 *  The By column writes the detector that made a check -- `leak`, `purpose`,
 *  `bloat` -- where the product writes "Studio": the same claim with the
 *  useful part left in.
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { collapseRuns, type ActivityRow } from "./activity-filter";
import { api, type ActivityEvent, type ActivityEventKind } from "./api";
import { DataTable, When } from "./data-table";
import { errText } from "./format";
import { PageHeader, StatusChip } from "./ui-standard";
import { Tile } from "./view-mode";

const KINDS: { id: ActivityEventKind; label: string }[] = [
  { id: "comment", label: "Comments" },
  { id: "check", label: "Checks" },
];

export function ActivityView({
  token,
  projectTenantId,
  workspaceId,
}: {
  token: string;
  projectTenantId: string;
  /** Parent workspace, for the document bindings that name each subject. */
  workspaceId: string;
}) {
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  /** The kind shown; null until the feed says whether it has comments. */
  const [kind, setKind] = useState<ActivityEventKind | "all" | null>(null);
  /** The collapsed runs opened to their events. */
  const [opened, setOpened] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpened((o) => {
      const next = new Set(o);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const load = useCallback(async () => {
    setErr(null);
    try {
      // Both kinds, in one feed, ordered and named by the gear that owns the
      // nodes.
      setEvents((await api.activityFeed(token, projectTenantId)).items);
    } catch (e) {
      setErr(errText(e));
      setEvents([]);
    }
  }, [token, projectTenantId, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const count = (k: ActivityEventKind) => (events ?? []).filter((e) => e.kind === k).length;
  // Comments when there are any: what people said is what a visit is for.
  const shownKind = kind ?? (events === null ? null : count("comment") > 0 ? "comment" : "all");
  const rows = useMemo<ActivityRow[] | null>(
    () => (events === null ? null : collapseRuns(shownKind === "all" || !shownKind ? events : events.filter((e) => e.kind === shownKind))),
    [events, shownKind],
  );

  const recordedAt = (e: ActivityEvent) => {
    const t = Date.parse(e.recorded ?? "");
    // An undated row sorts last, whichever way the column is turned.
    return Number.isNaN(t) ? -Infinity : t;
  };

  return (
    <>
      <PageHeader
        title="Activity"
        info={
          <p>
            What happened in the project&apos;s documents: the comments people left and the checks the detectors ran.
            Only the latest are kept -- a detector&apos;s verdict is one record per detector per document, so running
            one again replaces its answer rather than adding to it. A run of the same check one after another is one
            row; open it for its documents.
          </p>
        }
        status={
          events &&
          !err && (
            <>
              <StatusChip tone="neutral" data-activity-count="comment">
                {count("comment")} comments
              </StatusChip>
              <StatusChip tone="neutral" data-activity-count="check">
                {count("check")} checks
              </StatusChip>
            </>
          )
        }
      />
      <div className="card">
        <DataTable<ActivityRow>
          list="activity"
          rows={events === null && err ? [] : rows}
          error={err}
          onRetry={() => void load()}
          rowKey={(e) => e.id}
          rowLabel={(e) => `${e.event} ${e.subject}`}
          search={{ placeholder: "Search activity" }}
          searchText={(e) => [e.event, e.subject, e.by, e.severity, e.recorded, ...(e.items ?? []).map((i) => i.subject)]}
          extra={
            <div className="doc-views" role="tablist" aria-label="Which events" style={{ marginBottom: 0 }} data-activity-kind>
              {[...KINDS, { id: "all" as const, label: "Everything" }].map((k) => (
                <button
                  key={k.id}
                  role="tab"
                  aria-selected={shownKind === k.id}
                  className={shownKind === k.id ? "doc-view on" : "doc-view"}
                  onClick={() => setKind(k.id)}
                >
                  {k.label}
                  {k.id !== "all" && events ? ` · ${count(k.id)}` : ""}
                </button>
              ))}
            </div>
          }
          empty={{
            title: "Nothing recorded yet.",
            body: "Run a check on the Specs tab, or sync a repository to pull its comments.",
          }}
          columns={[
            {
              id: "event",
              header: "Event",
              className: "acell-lead",
              cell: (e) => (
                <>
                  {e.event}
                  {e.items && (
                    <>
                      {" "}
                      <StatusChip
                        tone="neutral"
                        onClick={() => toggle(e.id)}
                        expanded={opened.has(e.id)}
                        title={opened.has(e.id) ? "Fold the run" : "Show each event"}
                        data-activity-run-toggle
                      >
                        ×{e.items.length} {opened.has(e.id) ? "▴" : "▾"}
                      </StatusChip>
                    </>
                  )}
                </>
              ),
            },
            { id: "subject", header: "Document", className: "act-subject", cell: (e) => e.subject },
            { id: "by", header: "By", cell: (e) => <span className="sub">{e.by}</span> },
            {
              // Relative, with the full timestamp on hover: an activity row is
              // evidence, and the date is one hover away and sorts.
              id: "recorded",
              header: "Recorded",
              compare: (a, b) => recordedAt(a) - recordedAt(b),
              cell: (e) => <When iso={e.recorded} className="sub" />,
            },
          ]}
          detail={(e) =>
            e.items && opened.has(e.id) ? (
              <ul className="output-files" data-activity-run>
                {e.items.slice(0, 100).map((i) => (
                  <li key={i.id}>
                    <b>{i.subject}</b> <span className="sub">{i.by}</span> <When iso={i.recorded} className="sub" />
                  </li>
                ))}
                {e.items.length > 100 && <li className="sub">and {e.items.length - 100} more; search narrows them</li>}
              </ul>
            ) : null
          }
          tile={(e) => (
            <Tile
              title={e.event}
              subtitle={e.subject}
              tone={e.severity === "high" ? "attn" : undefined}
              stats={[
                { label: "by", value: e.by },
                { label: "severity", value: e.severity ?? "—" },
              ]}
              footer={<When iso={e.recorded} />}
            />
          )}
        />
      </div>
    </>
  );
}
