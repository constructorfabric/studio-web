// "Check open pull requests" on the Specs tab.

import { useState } from "react";
import { api } from "./api";
import { checksSummary, type PullRequestChecks } from "./project-checks";

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Run the project's document checks on its open pull requests, and set the
 *  result on each as a `studio/documents` commit status. */
export function PullRequestChecksPanel({ token, projectId }: { token: string; projectId: string }) {
  const [read, setRead] = useState<PullRequestChecks | { error: string } | "running" | null>(null);
  const run = async (publish: boolean) => {
    setRead("running");
    try {
      setRead(await api.runPullRequestChecks(token, projectId, publish));
    } catch (e) {
      setRead({ error: errText(e) });
    }
  };
  return (
    <div className="card pc-panel">
      <div className="pc-head">
        <b>Checks on pull requests</b>
        <span className="pc-actions">
          <button disabled={read === "running"} onClick={() => void run(false)} title="See what the checks say, set nothing">
            Preview
          </button>
          <button
            className="primary"
            disabled={read === "running"}
            onClick={() => void run(true)}
            title="Set a studio/documents status on every open pull request that changes a document"
          >
            Check and set statuses
          </button>
        </span>
      </div>
      <p className="hint">
        Every open pull request that changes a document of this project is checked against its type&apos;s template — one
        shared check for every repository — and the result shows on the pull request.
      </p>
      {read === "running" && <div className="empty">Reading open pull requests…</div>}
      {read && read !== "running" && "error" in read && <div className="error">{read.error}</div>}
      {read && read !== "running" && "items" in read && (
        <>
          <div className="hint">{checksSummary(read)}</div>
          <ul className="rows">
            {read.items.map((c) => (
              <li key={`${c.repo}#${c.number}`} className="pc-row">
                <div className="grow">
                  <div className="name">
                    <span className={c.state === "success" ? "badge ok" : "badge warn"}>
                      {c.state === "success" ? "passes" : "fails"}
                    </span>{" "}
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
