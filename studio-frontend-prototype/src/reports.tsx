/** Reports: every report this Studio draws, configured once per organization.
 *
 *  A report's source is a GitHub connection and the plan file in a
 *  repository; the plan can name the board, its roots and its consumers
 *  itself, so the rest of the form is only for a plan that does not yet.
 *  Refresh reads the plan again and syncs the board (`reports.refresh`); a
 *  schedule does the same every hour when switched on. */

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { api, type Connection } from "./api";
import { errText } from "./format";
import { RoadmapReportBody, downloadReport } from "./roadmap-report-view";
import {
  canRefresh,
  draftOf,
  inputOf,
  needsAttention,
  stateOf,
  stateText,
  type Report,
  type ReportSchedule,
  type SourceDraft,
} from "./reports-model";

const CARD: CSSProperties = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 12,
  display: "flex",
  flexDirection: "column",
  gap: 8,
};
const ROW: CSSProperties = { display: "grid", gridTemplateColumns: "140px 1fr", gap: 8, alignItems: "center" };
const HINT: CSSProperties = { color: "var(--muted-foreground)", fontSize: 12, margin: 0 };
const ATTENTION: CSSProperties = {
  margin: 0,
  padding: "8px 10px",
  borderRadius: 6,
  fontSize: 13,
  border: "1px solid color-mix(in srgb, var(--destructive, #dc2626) 45%, transparent)",
  background: "color-mix(in srgb, var(--destructive, #dc2626) 8%, transparent)",
  color: "var(--destructive, #dc2626)",
};

/** Poll a run until it ends. `org` is the tenant it was queued in. */
async function finished(
  token: string,
  runId: string,
  org: string | undefined,
): Promise<{ ok: boolean; message: string | null }> {
  for (let i = 0; i < 120; i++) {
    const run = await api.taskRun(token, runId, org);
    if (run.state === "succeeded") return { ok: true, message: run.summary ?? null };
    if (run.state === "failed" || run.state === "cancelled") return { ok: false, message: run.last_error ?? run.state };
    await new Promise((r) => setTimeout(r, 1500));
  }
  return { ok: false, message: "still running — look under Background work" };
}

export function ReportsScreen({ token, tenantId }: { token: string; tenantId: string | undefined }) {
  const [reports, setReports] = useState<Report[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);

  // The organization on screen, not the caller's home tenant: the connection
  // list below is this organization's, so the report must be too.
  const load = useCallback(() => {
    api
      .reports(token, tenantId)
      .then((r) => setReports(r.items))
      .catch((e) => setErr(errText(e)));
  }, [token, tenantId]);

  useEffect(load, [load]);
  useEffect(() => {
    if (!tenantId) return;
    api
      .connections(token, tenantId)
      .then((r) => setConnections(r.items.filter((c) => c.provider === "github")))
      .catch(() => setConnections([]));
  }, [token, tenantId]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16, padding: 16 }}>
      <div>
        <h1 style={{ margin: 0, fontSize: 20 }}>Reports</h1>
        <p style={HINT}>
          Each report is configured once for the organization: where its board and its plan come from. Everyone who
          opens it reads the same.
        </p>
      </div>
      {err && <p className="gcat-err">{err}</p>}
      {!reports && !err && <p style={HINT}>Reading the reports…</p>}
      {reports?.map((r) => (
        <ReportCard
          key={r.id}
          token={token}
          org={tenantId}
          report={r}
          connections={connections}
          onChanged={load}
        />
      ))}
    </div>
  );
}

function ReportCard({
  token,
  org,
  report,
  connections,
  onChanged,
}: {
  token: string;
  org: string | undefined;
  report: Report;
  connections: Connection[];
  onChanged: () => void;
}) {
  const [schedule, setSchedule] = useState<ReportSchedule | null>(null);
  const pick = useRef<HTMLInputElement>(null);
  useEffect(() => {
    api
      .reportSchedule(token, report.id, org)
      .then(setSchedule)
      .catch(() => setSchedule(null));
  }, [token, report.id, org]);
  const [draft, setDraft] = useState<SourceDraft>(() => draftOf(report.source));
  const [upload, setUpload] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [advanced, setAdvanced] = useState(
    () => !!(report.source.board || report.source.roots.length || Object.keys(report.source.consumers).length),
  );

  useEffect(() => setDraft(draftOf(report.source)), [report.source]);

  const set = (p: Partial<SourceDraft>) => setDraft((d) => ({ ...d, ...p }));
  const act = async (label: string, f: () => Promise<string | null | void>) => {
    setBusy(label);
    setNote(null);
    try {
      const msg = await f();
      if (msg) setNote(msg);
    } catch (e) {
      setNote(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    act("save", async () => {
      await api.updateReportSource(token, report.id, inputOf(draft), org);
      setUpload(null);
      onChanged();
      return "Saved.";
    });

  const refresh = () =>
    act("refresh", async () => {
      await api.updateReportSource(token, report.id, inputOf(draft), org);
      const run = await api.syncReport(token, report.id, org);
      const done = await finished(token, run.run_id, org);
      if (!done.ok) {
        onChanged();
        return `Refresh failed: ${done.message}`;
      }
      // The refresh only queues the board sync; wait for that too, so the
      // gears below -- or why there are none -- are the ones it read.
      const after = await api.reports(token, org);
      const sync = after.items.find((r) => r.id === report.id)?.source.last_refresh?.sync_run;
      const synced = sync ? await finished(token, sync, org) : null;
      onChanged();
      setVersion((v) => v + 1);
      if (synced && !synced.ok) return `Board sync failed: ${synced.message}`;
      return `Refreshed: ${synced?.message ?? done.message ?? "plan read, board sync queued"}.`;
    });

  const hourly = (on: boolean) =>
    act("schedule", async () => {
      setSchedule(await api.updateReportSchedule(token, report.id, on, org));
      return on ? "Refreshes every hour." : "No longer refreshes on its own.";
    });

  const state = stateOf(report.source);
  const refreshable = canRefresh(draft, report.source);
  return (
    <section style={CARD}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
        <h2 style={{ margin: 0, fontSize: 16, flex: 1 }}>{report.title}</h2>
        <button
          className="iconbtn"
          disabled={!!busy || !refreshable}
          title={refreshable ? "Read the plan again and sync the board" : "Name the board, a plan file, or upload the plan first"}
          onClick={refresh}
        >
          {busy === "refresh" ? "Refreshing…" : "Refresh"}
        </button>
        <button
          className="iconbtn primary"
          disabled={!!busy}
          onClick={() => act("download", () => downloadReport(token, report.id, undefined, org))}
        >
          {busy === "download" ? "Writing…" : "Download .xlsx"}
        </button>
      </div>
      <p style={HINT}>{report.description}</p>
      <p style={HINT}>
        Drawn with <code>{report.definition}</code>
        {report.sheets.length > 0 && ` — ${report.sheets.join(", ")}`}.
        {report.definition_error && <span className="gcat-err"> The plan&apos;s own definition does not read: {report.definition_error}</span>}
      </p>
      <p style={needsAttention(state) ? ATTENTION : HINT} role={needsAttention(state) ? "alert" : undefined}>
        {stateText(state)}
      </p>

      <div style={ROW}>
        <span>Connection</span>
        <select value={draft.connectionId} onChange={(e) => set({ connectionId: e.target.value })}>
          <option value="">{connections.length ? "First GitHub connection" : "No GitHub connection"}</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label || c.account || c.id.slice(0, 8)}
            </option>
          ))}
        </select>
        <span>Plan file</span>
        <input
          placeholder="owner/repo:path/gears.yaml@main"
          value={draft.planFile}
          onChange={(e) => set({ planFile: e.target.value })}
        />
        <span>or upload</span>
        <span style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button className="iconbtn" type="button" onClick={() => pick.current?.click()}>
            {report.source.plan_uploaded || upload ? "Replace…" : "Load gears.yaml…"}
          </button>
          <input
              ref={pick}
              type="file"
              accept=".yaml,.yml,text/yaml"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                void file.text().then((text) => {
                  setUpload(file.name);
                  set({ planYaml: text });
                });
              }}
            />
          {upload && <code>{upload}</code>}
          {!upload && report.source.plan_uploaded && <span style={HINT}>an uploaded plan is in use</span>}
          {(upload || report.source.plan_uploaded) && (
            <button
              className="iconbtn"
              onClick={() => {
                setUpload(null);
                set({ planYaml: "" });
              }}
            >
              Clear
            </button>
          )}
        </span>
      </div>
      <button className="iconbtn" style={{ alignSelf: "flex-start" }} onClick={() => setAdvanced((a) => !a)}>
        {advanced ? "Hide" : "Board, roots and consumers…"}
      </button>
      {advanced && (
        <div style={ROW}>
          <span>Board</span>
          <input placeholder="owner/number — or `board:` in the plan" value={draft.board} onChange={(e) => set({ board: e.target.value })} />
          <span>Root issues</span>
          <input placeholder="3342 owner/repo#4507 — or `roots:` in the plan" value={draft.roots} onChange={(e) => set({ roots: e.target.value })} />
          <span>Consumers</span>
          <input
            placeholder="A=Acronis, C=Constructor — or `consumers:` in the plan"
            value={draft.consumers}
            onChange={(e) => set({ consumers: e.target.value })}
          />
        </div>
      )}
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <button className="iconbtn primary" disabled={!!busy} onClick={save}>
          {busy === "save" ? "Saving…" : "Save"}
        </button>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
          <input
            type="checkbox"
            disabled={!!busy}
            checked={!!schedule?.enabled}
            title={schedule?.next_run_at ? `Next: ${schedule.next_run_at.slice(0, 16).replace("T", " ")} UTC` : undefined}
            onChange={(e) => hourly(e.target.checked)}
          />
          Refresh every hour
        </label>
        {note && <span style={HINT}>{note}</span>}
      </div>
      <p style={HINT}>
        The plan can carry everything but the connection: <code>board: owner/48</code>, <code>roots: [3342, 4507]</code>,{" "}
        <code>consumers: {"{ A: Acronis }"}</code>, and <code>report: back_roadmap</code> or a definition of its own.
      </p>

      {report.id === "roadmap" && <RoadmapReportBody token={token} org={org} version={version} />}
    </section>
  );
}
