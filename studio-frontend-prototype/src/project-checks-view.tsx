// "Checks on pull requests" on the Specs tab. It used to be a card of its own
// with a paragraph on every visit; it is two items of the header's menu now
// (Preview, Check and set statuses), a status chip once they ran, and the
// result under the header while that chip is open.

import { useState } from "react";
import { api } from "./api";
import { checksChip, checksSummary, type PullRequestChecks } from "./project-checks";
import { StatusChip } from "./ui-standard";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type ChecksRead = PullRequestChecks | { error: string } | "running" | null;

/** Run the project's document checks on its open pull requests, and set the
 *  result on each as a `studio/documents` commit status when `publish`. */
export function usePullRequestChecks(token: string, projectId: string) {
  const [read, setRead] = useState<ChecksRead>(null);
  const [open, setOpen] = useState(false);
  const run = async (publish: boolean) => {
    setRead("running");
    setOpen(true);
    try {
      setRead(await api.runPullRequestChecks(token, projectId, publish));
    } catch (e) {
      setRead({ error: errText(e) });
    }
  };
  return { read, open, setOpen, run };
}

/** The menu's two items. Each says what it does in its title, which the card's
 *  paragraph used to. */
export function PullRequestChecksMenu({ read, run }: { read: ChecksRead; run: (publish: boolean) => Promise<void> }) {
  return (
    <>
      <div className="ing-menu-sep" role="separator">
        Pull requests
      </div>
      <button
        disabled={read === "running"}
        onClick={() => void run(false)}
        title="Check every open pull request that changes a document against its type's template; set nothing"
        data-pr-checks="preview"
      >
        Preview checks
      </button>
      <button
        disabled={read === "running"}
        onClick={() => void run(true)}
        title="Check them and set a studio/documents status on each pull request, one shared check for every repository"
        data-pr-checks="publish"
      >
        Check and set statuses
      </button>
    </>
  );
}

/** Where the last run stands, as a chip that opens its result. Nothing until
 *  the checks ran. */
export function PullRequestChecksChip({ read, open, onToggle }: { read: ChecksRead; open: boolean; onToggle: () => void }) {
  if (read === null) return null;
  if (read === "running") return <StatusChip tone="running">checking pull requests…</StatusChip>;
  if ("error" in read)
    return (
      <StatusChip tone="danger" onClick={onToggle} expanded={open}>
        PR checks failed
      </StatusChip>
    );
  const chip = checksChip(read);
  return (
    <StatusChip tone={chip.tone} onClick={onToggle} expanded={open} data-pr-checks-chip>
      {chip.text}
    </StatusChip>
  );
}

/** The last run, pull request by pull request. */
export function PullRequestChecksResult({ read, onClose }: { read: ChecksRead; onClose: () => void }) {
  if (read === null || read === "running") return null;
  return (
    <div className="card pc-panel" data-pr-checks-result>
      <div className="pc-head">
        <b>Checks on pull requests</b>
        <span className="pc-actions">
          <button type="button" className="ghost" onClick={onClose}>
            Close
          </button>
        </span>
      </div>
      {"error" in read && <div className="error">{read.error}</div>}
      {"items" in read && (
        <>
          <div className="hint">{checksSummary(read)}</div>
          <ul className="rows">
            {read.items.map((c) => (
              <li key={`${c.repo}#${c.number}`} className="pc-row">
                <div className="grow">
                  <div className="name">
                    <StatusChip tone={c.state === "success" ? "ok" : "warn"}>
                      {c.state === "success" ? "passes" : "fails"}
                    </StatusChip>{" "}
                    {c.url ? (
                      <a href={c.url} target="_blank" rel="noreferrer">
                        {c.repo}#{c.number}
                      </a>
                    ) : (
                      `${c.repo}#${c.number}`
                    )}{" "}
                    {c.title}
                  </div>
                  <div className="sub">{c.description}</div>
                  {c.files
                    .filter((f) => !f.conforms)
                    .map((f) => (
                      <div key={f.path} className="sub">
                        {f.path}: {f.issues.join("; ")}
                      </div>
                    ))}
                  {c.publish_error && <div className="sub pc-err">Status not set: {c.publish_error}</div>}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
