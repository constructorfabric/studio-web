/**
 * Components › Levels (ADR-0061): the organization's catalogue or one
 * project's, each component with its passport and documents; the platform
 * release (a pin per platform source); and the publications a project
 * proposes, which an administrator answers. The rules are
 * `catalogue-levels.ts`.
 */
import { useCallback, useEffect, useState } from "react";
import { api, type CatalogNode, type CatalogPublication, type ComponentDoc, type PlatformPins } from "./api";
import { errText } from "./format";
import {
  TIER_LABEL,
  byTier,
  docLink,
  docsOf,
  mayPropose,
  passportFacts,
  passportFile,
  pinRows,
  pinsFrom,
  type PinRow,
} from "./catalogue-levels";

export function CatalogueLevelsPanel({ token, projects }: { token: string; projects: { id: string; name: string }[] }) {
  /** "" is the organization; otherwise a project's id. */
  const [scope, setScope] = useState("");
  const [nodes, setNodes] = useState<CatalogNode[] | null>(null);
  const [profiles, setProfiles] = useState<Record<string, Record<string, unknown>>>({});
  const [status, setStatus] = useState("");
  const [round, setRound] = useState(0);
  const [doc, setDoc] = useState<ComponentDoc | null>(null);

  useEffect(() => {
    let live = true;
    setNodes(null);
    const project = scope || undefined;
    Promise.all([api.listComponents(token, project), api.listComponentProfiles(token, project).catch(() => ({ nodes: [] }))])
      .then(([c, p]) => {
        if (!live) return;
        const byName: Record<string, Record<string, unknown>> = {};
        for (const n of p.nodes ?? []) {
          const name = typeof n.value.gear_name === "string" ? n.value.gear_name : "";
          if (name) byName[name] = n.value as Record<string, unknown>;
        }
        setProfiles(byName);
        setNodes(c.nodes ?? []);
      })
      .catch((e) => live && (setStatus(errText(e)), setNodes([])));
    return () => {
      live = false;
    };
  }, [token, scope, round]);

  const sync = async () => {
    if (!scope) return;
    try {
      const { run_id } = await api.syncProjectCatalogue(token, scope);
      setStatus(`Reading the project's repositories (run ${run_id.slice(0, 8)})… reload in a minute.`);
    } catch (e) {
      setStatus(errText(e));
    }
  };

  const propose = async (n: CatalogNode) => {
    if (!scope) return;
    const ref = window.prompt(`Publish ${n.value.name} to the organization at which tag or commit?`, String(n.value.git_ref ?? ""));
    if (ref === null) return;
    try {
      const p = await api.requestCatalogPublication(token, scope, {
        name: String(n.value.name ?? ""),
        type_id: n.type_id,
        git_ref: ref.trim() || undefined,
      });
      setStatus(`Proposed ${p.name} at ${p.git_ref}${p.version ? ` (version ${p.version})` : ""}; an administrator answers it.`);
      setRound((r) => r + 1);
    } catch (e) {
      setStatus(errText(e));
    }
  };

  const openDoc = async (n: CatalogNode, path: string) => {
    try {
      setDoc(await api.componentDoc(token, String(n.value.name ?? ""), path, scope || undefined));
    } catch (e) {
      setStatus(errText(e));
    }
  };

  return (
    <div className="catalogue-levels" data-catalogue-levels>
      <div className="org-toolbar">
        <label>
          Catalogue of{" "}
          <select value={scope} onChange={(e) => setScope(e.target.value)} data-catalogue-scope>
            <option value="">the organization</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                project {p.name}
              </option>
            ))}
          </select>
        </label>
        {scope && (
          <button className="ghost" onClick={() => void sync()} data-sync-project-catalogue>
            Read the project's repositories
          </button>
        )}
      </div>
      <p className="gcat-hint">
        {scope
          ? "The organization's components and this project's own, found in its repositories by their passports. Only this project sees its own until one is published."
          : "The platform's components (every organization sees them, and may pin each source to a version) and the organization's own."}
      </p>
      {status && <p className="gcat-hint">{status}</p>}
      {!scope && <PlatformRelease token={token} />}
      {nodes === null ? (
        <p className="gcat-hint">Reading…</p>
      ) : (
        byTier(nodes).map((g) => (
          <section key={g.tier} data-tier={g.tier}>
            <h3>
              {TIER_LABEL[g.tier]} <span className="muted">{g.nodes.length}</span>
            </h3>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Component</th>
                  <th>Passport</th>
                  <th>Facts</th>
                  <th>Documents</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {g.nodes.map((n) => (
                  <tr key={`${n.type_id}|${n.instance_id}`} data-component={String(n.value.name ?? "")}>
                    <td>
                      <strong>{String(n.value.name ?? n.instance_id)}</strong>
                      {n.value.description ? <div className="muted">{String(n.value.description)}</div> : null}
                    </td>
                    <td>{passportFile(n) ?? "—"}</td>
                    <td>
                      {passportFacts(n, profiles[String(n.value.name ?? "")]).map(([k, v]) => (
                        <div key={k}>
                          <span className="muted">{k}:</span> {v}
                        </div>
                      ))}
                    </td>
                    <td>
                      {docsOf(n).map((d) => (
                        <div key={d}>
                          <button className="link" onClick={() => void openDoc(n, d)}>
                            {d}
                          </button>
                          {docLink(n, d) && (
                            <>
                              {" "}
                              <a href={docLink(n, d) ?? undefined} target="_blank" rel="noreferrer">
                                ↗
                              </a>
                            </>
                          )}
                        </div>
                      ))}
                    </td>
                    <td>
                      {mayPropose(n) && (
                        <button className="ghost" onClick={() => void propose(n)} data-propose>
                          Propose to the organization
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))
      )}
      <Publications token={token} projectId={scope || undefined} round={round} onAnswered={() => setRound((r) => r + 1)} />
      {doc && (
        <div className="modal-backdrop" onClick={() => setDoc(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()} data-component-doc>
            <h3>
              {doc.path}{" "}
              <a href={doc.url} target="_blank" rel="noreferrer" className="muted">
                {doc.repo}@{doc.git_ref}
              </a>
            </h3>
            <pre style={{ whiteSpace: "pre-wrap", maxHeight: "60vh", overflow: "auto" }}>{doc.text}</pre>
            {doc.truncated && <p className="muted">Cut at 200 KiB.</p>}
            <button onClick={() => setDoc(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The organization's platform release: a pin per platform source. */
function PlatformRelease({ token }: { token: string }) {
  const [pins, setPins] = useState<PlatformPins | null>(null);
  const [rows, setRows] = useState<PinRow[]>([]);
  const [status, setStatus] = useState("");
  useEffect(() => {
    let live = true;
    api
      .platformPins(token)
      .then((p) => {
        if (!live) return;
        setPins(p);
        setRows(pinRows(p.items));
      })
      .catch((e) => live && setStatus(errText(e)));
    return () => {
      live = false;
    };
  }, [token]);
  if (!pins || pins.items.length === 0) return status ? <p className="gcat-hint">{status}</p> : null;
  const save = async () => {
    try {
      const p = await api.setPlatformPins(token, pinsFrom(rows));
      setPins(p);
      setRows(pinRows(p.items));
      setStatus("Saved: the organization holds these platform sources at the versions pinned.");
    } catch (e) {
      setStatus(errText(e));
    }
  };
  return (
    <section data-platform-release>
      <h3>Platform release</h3>
      <p className="gcat-hint">Every platform source is always shown. A pin holds one at a tag or commit; empty follows the platform.</p>
      <table className="data-table">
        <thead>
          <tr>
            <th>Platform source</th>
            <th>Platform reads</th>
            <th>Pinned at</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.repo}>
              <td>{r.repo}</td>
              <td>{r.platformRef}</td>
              <td>
                <input
                  value={r.pinned}
                  disabled={!pins.may_manage}
                  placeholder="follows the platform"
                  onChange={(e) => setRows((cur) => cur.map((x, j) => (j === i ? { ...x, pinned: e.target.value } : x)))}
                  data-pin={r.repo}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {pins.may_manage && <button onClick={() => void save()}>Save the pins</button>}
      {status && <p className="gcat-hint">{status}</p>}
    </section>
  );
}

/** What projects proposed, and the administrator's answer. */
function Publications({ token, projectId, round, onAnswered }: { token: string; projectId?: string; round: number; onAnswered: () => void }) {
  const [items, setItems] = useState<CatalogPublication[] | null>(null);
  const [mayDecide, setMayDecide] = useState(false);
  const [status, setStatus] = useState("");
  const load = useCallback(() => {
    api
      .catalogPublications(token, projectId)
      .then((r) => {
        setItems(r.items ?? []);
        setMayDecide(r.may_decide);
      })
      .catch((e) => setStatus(errText(e)));
  }, [token, projectId]);
  useEffect(load, [load, round]);
  if (!items || items.length === 0) return status ? <p className="gcat-hint">{status}</p> : null;
  const decide = async (p: CatalogPublication, action: "approve" | "decline") => {
    const reason = action === "decline" ? window.prompt("Why is it declined?") ?? undefined : undefined;
    if (action === "decline" && !reason) return;
    try {
      await api.decideCatalogPublication(token, p.id, action, reason);
      onAnswered();
    } catch (e) {
      setStatus(errText(e));
    }
  };
  return (
    <section data-publications>
      <h3>Publications</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>Component</th>
            <th>From</th>
            <th>Version</th>
            <th>State</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((p) => (
            <tr key={p.id} data-publication={p.state}>
              <td>{p.name}</td>
              <td>{p.project_name ?? p.project_id}</td>
              <td>
                {p.git_ref}
                {p.version ? ` · ${p.version}` : ""}
              </td>
              <td>
                {p.state}
                {p.decline_reason ? ` — ${p.decline_reason}` : ""}
              </td>
              <td>
                {mayDecide && p.state === "requested" && (
                  <>
                    <button onClick={() => void decide(p, "approve")}>Approve</button>{" "}
                    <button className="ghost" onClick={() => void decide(p, "decline")}>
                      Decline
                    </button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {status && <p className="gcat-hint">{status}</p>}
    </section>
  );
}
