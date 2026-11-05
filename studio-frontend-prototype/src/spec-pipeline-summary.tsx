/* The spec pipeline on Specs, in one line that opens to a compact table: one
 * row per document type the workspace defines, how many documents the
 * project has of it (written here or bound from the repository) and how many
 * pass the type's checks. Moved here from the project's Overview, which now
 * answers "how is the project doing" and leaves the detail to this tab.
 *
 * One read, `GET /studio-documents/v1/spec-pipeline`, folded by the server: a
 * file a scan only guessed at is shown as unconfirmed and left out of the
 * count -- a guess is not coverage. */

import { useEffect, useState } from "react";

import { api, type PipelineRow } from "./api";
import { errText } from "./format";
import { InfoPopover } from "./ui-standard";

export function SpecPipelineSummary({ token, projectId }: { token: string; projectId: string }) {
  const [rows, setRows] = useState<PipelineRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    api
      .specPipeline(token, projectId)
      .then((r) => live && setRows(r.items))
      .catch((e) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [token, projectId]);

  if (error) return <p className="sub spc-pipe-err">Spec pipeline not readable: {error}</p>;
  if (!rows || rows.length === 0) return null;
  const started = rows.filter((r) => !r.untouched);
  const notStarted = rows.filter((r) => r.untouched);
  const total = started.reduce((n, r) => n + r.total, 0);
  const valid = started.reduce((n, r) => n + r.valid, 0);
  return (
    <details className="spc-pipe" data-spec-pipeline>
      <style>{SPC_PIPE_CSS}</style>
      <summary>
        <b>Spec pipeline</b>
        <span data-spec-pipeline-types>
          {started.length} of {rows.length} types started
        </span>
        <span>·</span>
        <span data-spec-pipeline-valid>
          {valid} of {total} documents pass their type
        </span>
        <InfoPopover label="About the spec pipeline">
          One row per document type the workspace defines, counting documents written here and repository files bound
          to that type alike, and how many satisfy the type&apos;s required sections. A file a scan only guessed at is
          shown as unconfirmed and left out of the count: a guess is not coverage.
        </InfoPopover>
      </summary>
      <table className="spc-pipe-table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Documents</th>
            <th>Valid</th>
          </tr>
        </thead>
        <tbody>
          {started.map((r) => {
            const pct = r.total === 0 ? 0 : Math.round((r.valid / r.total) * 100);
            return (
              <tr key={r.type_key} data-pipeline-type={r.type_key}>
                <td>{r.type_name}</td>
                <td>
                  {r.total}
                  {r.proposed.length > 0 && <span className="sub"> · {r.proposed.length} unconfirmed</span>}
                </td>
                <td>
                  <span className="spc-pipe-meter" aria-hidden>
                    <span style={{ width: `${pct}%` }} />
                  </span>
                  {r.valid}/{r.total}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {notStarted.length > 0 && (
        <p className="sub spc-pipe-none">Not started: {notStarted.map((r) => r.type_name).join(", ")}.</p>
      )}
    </details>
  );
}

const SPC_PIPE_CSS = `
.spc-pipe { margin:0 0 10px; font-size:13px; }
.spc-pipe > summary { cursor:pointer; display:flex; align-items:center; gap:6px; flex-wrap:wrap; color:var(--muted-foreground); }
.spc-pipe > summary b { color:var(--foreground); font-weight:600; }
.spc-pipe-table { margin-top:8px; border-collapse:collapse; width:auto; min-width:min(520px,100%); }
.spc-pipe-table th, .spc-pipe-table td { text-align:left; padding:3px 14px 3px 0; border-bottom:1px solid var(--border); font-size:12.5px; }
.spc-pipe-table th { font-weight:600; color:var(--muted-foreground); font-size:12px; }
.spc-pipe-meter { display:inline-block; width:60px; height:6px; border-radius:3px; background:var(--muted); margin-right:6px; vertical-align:middle; overflow:hidden; }
.spc-pipe-meter > span { display:block; height:100%; background:var(--success); }
.spc-pipe-none { margin:6px 0 0; }
.spc-pipe-err { margin:0 0 10px; }
`;
