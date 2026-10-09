/* ── The organization's gear repository (ADR-0042 §2) ──────────────────────
 *
 * One card on the Components page, Ours tab. The organization may name one
 * repository its gears live in: "Create a gear" writes there for a project
 * without a gear repository of its own, and the registry walk reads it, so
 * its gears are the organization's components.
 *
 * Everyone reads it; an organization administrator sets, creates or removes
 * it and creates gears into it. The connection has to be organization-scoped:
 * the card warns before the server refuses anything else. */

import { useEffect, useState } from "react";

import { ApiError, api } from "./api";
import type { Connection, OrgGearRepositoryState, RegistryProjectWalk } from "./api";
import { ScaffoldModal } from "./documents";
import { errText } from "./format";
import {
  connectionScopeWarning,
  gearRepoConnections,
  gearRepoWalkLine,
  normalizeRepo,
  repoUrl,
} from "./org-gear-repository";

type Mode = "view" | "set" | "create" | "new-gear";

export function OrgGearRepositoryCard({
  token,
  tenantId,
  connections,
}: {
  token: string;
  /** The organization on screen. */
  tenantId?: string;
  /** The connections the organization sees (GitHub ones are offered). */
  connections: Connection[];
}) {
  const [state, setState] = useState<OrgGearRepositoryState | null>(null);
  const [walks, setWalks] = useState<RegistryProjectWalk[]>([]);
  const [missing, setMissing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<Mode>("view");
  const offered = gearRepoConnections(connections, tenantId);
  const [connectionId, setConnectionId] = useState("");
  const [repo, setRepo] = useState("");
  const [branch, setBranch] = useState("main");
  const [name, setName] = useState("gears");
  const [owner, setOwner] = useState("");
  const [isOrg, setIsOrg] = useState(true);
  const [isPrivate, setIsPrivate] = useState(true);
  const [gearName, setGearName] = useState("");
  const [gearProblem, setGearProblem] = useState("");
  const [gearCaps, setGearCaps] = useState("");
  const [scaffolding, setScaffolding] = useState<{ slug: string; problem?: string; caps: string[] } | null>(null);

  const load = () => {
    api
      .orgGearRepository(token)
      .then((s) => {
        setState(s);
        setMissing(false);
      })
      .catch((e) => {
        // A backend older than the setting: say nothing rather than an error.
        if (e instanceof ApiError && e.status === 404) setMissing(true);
        else setErr(errText(e));
      });
    api
      .registryProjects(token)
      .then((r) => setWalks(r.items))
      .catch(() => setWalks([]));
  };
  useEffect(load, [token, tenantId]); // eslint-disable-line react-hooks/exhaustive-deps

  const current = state?.gear_repository ?? null;
  const chosen = offered.find((c) => c.id === connectionId) ?? null;
  const warning = connectionScopeWarning(chosen);
  const walk = current ? gearRepoWalkLine(walks, tenantId) : null;

  const startSet = () => {
    setErr(null);
    setConnectionId(current?.connection_id ?? offered[0]?.id ?? "");
    setRepo(current?.repo ?? "");
    setBranch(current?.branch ?? "main");
    setMode("set");
  };
  const startCreate = () => {
    setErr(null);
    setConnectionId(offered[0]?.id ?? "");
    setMode("create");
  };

  const run = async (what: () => Promise<OrgGearRepositoryState>) => {
    setBusy(true);
    setErr(null);
    try {
      setState(await what());
      setMode("view");
      // The walk was queued; its row appears when it has run.
      api
        .registryProjects(token)
        .then((r) => setWalks(r.items))
        .catch(() => undefined);
    } catch (e) {
      setErr(e instanceof ApiError && e.status === 403 ? "Only an organization administrator can change the gear repository." : errText(e));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    const normalized = normalizeRepo(repo);
    if (!normalized) {
      setErr("Name the repository as owner/name.");
      return;
    }
    void run(() => api.setOrgGearRepository(token, { connection_id: connectionId, repo: normalized, branch: branch.trim() || undefined }));
  };
  const create = () => {
    void run(() =>
      api.createOrgGearRepository(token, {
        connection_id: connectionId,
        name: name.trim(),
        ...(owner.trim() ? { owner: owner.trim() } : {}),
        is_org: isOrg,
        private: isPrivate,
      }),
    );
  };
  const remove = () => {
    if (!window.confirm("Stop using this repository as the organization's gear repository? The repository itself is not touched.")) return;
    void run(() => api.deleteOrgGearRepository(token));
  };

  if (missing) return null;
  const connectionOf = current ? connections.find((c) => c.id === current.connection_id) : undefined;

  const connectionPicker = (
    <label style={{ display: "block", margin: "4px 0" }}>
      Connection{" "}
      <select value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
        {offered.length === 0 && <option value="">no GitHub connection</option>}
        {offered.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label} ({c.scope}){c.account ? ` · ${c.account}` : ""}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="gcat-hint" data-org-gear-repository style={{ display: "block" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <b>Gear repository</b>
        {state === null ? (
          <span style={{ opacity: 0.6 }}>loading…</span>
        ) : current ? (
          <>
            <a href={repoUrl(current.repo, connectionOf)} target="_blank" rel="noreferrer">
              <code>{current.repo}</code>
            </a>
            <span style={{ opacity: 0.7 }}>
              @{current.branch}
              {current.connection_label ? ` · via ${current.connection_label}` : ""}
            </span>
          </>
        ) : (
          <span style={{ opacity: 0.75 }}>not set</span>
        )}
        {state?.may_manage && mode === "view" && (
          <span style={{ marginLeft: "auto", display: "inline-flex", gap: 6 }}>
            {current && (
              <button type="button" className="primary" onClick={() => setMode("new-gear")}>
                New gear
              </button>
            )}
            <button type="button" onClick={startSet}>
              {current ? "Change" : "Set"}
            </button>
            <button type="button" onClick={startCreate}>
              Create new
            </button>
            {current && (
              <button type="button" className="ghost" onClick={remove} disabled={busy}>
                Remove
              </button>
            )}
          </span>
        )}
      </div>
      <p style={{ margin: "4px 0 0", fontSize: 12, opacity: 0.8 }}>
        {current
          ? "Where “Create a gear” writes for a project without a gear repository of its own. The registry reads it too, so its gears are the organization's."
          : "The organization has no gear repository: “Create a gear” writes into each project's own repository. Name one so the organization's gears live together."}
      </p>
      {walk && (
        <p style={{ margin: "2px 0 0", fontSize: 12, color: walk.failed ? "var(--danger, #c33)" : undefined, opacity: walk.failed ? 1 : 0.7 }}>
          Last walk: {walk.text}
          {walk.hint && <span style={{ display: "block", opacity: 0.85 }}>{walk.hint}</span>}
        </p>
      )}

      {mode === "set" && (
        <div style={{ marginTop: 8 }}>
          {connectionPicker}
          {warning && <p className="error" style={{ fontSize: 12, margin: "2px 0" }}>{warning}</p>}
          <label style={{ display: "block", margin: "4px 0" }}>
            Repository{" "}
            <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name" />
          </label>
          <label style={{ display: "block", margin: "4px 0" }}>
            Branch <input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" />
          </label>
          <button type="button" className="primary" disabled={busy || !connectionId || !repo.trim()} onClick={save}>
            {busy ? "Saving…" : "Save"}
          </button>{" "}
          <button type="button" className="ghost" onClick={() => setMode("view")}>
            Cancel
          </button>
        </div>
      )}

      {mode === "create" && (
        <div style={{ marginTop: 8 }}>
          {connectionPicker}
          {warning && <p className="error" style={{ fontSize: 12, margin: "2px 0" }}>{warning}</p>}
          <label style={{ display: "block", margin: "4px 0" }}>
            Name <input value={name} onChange={(e) => setName(e.target.value)} placeholder="gears" />
          </label>
          <label style={{ display: "block", margin: "4px 0" }}>
            Owner <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="the connection's account" />
          </label>
          <label style={{ marginRight: 12 }}>
            <input type="checkbox" checked={isOrg} onChange={(e) => setIsOrg(e.target.checked)} /> the owner is a GitHub organization
          </label>
          <label>
            <input type="checkbox" checked={isPrivate} onChange={(e) => setIsPrivate(e.target.checked)} /> private
          </label>
          <div style={{ marginTop: 6 }}>
            <button type="button" className="primary" disabled={busy || !connectionId || !name.trim()} onClick={create}>
              {busy ? "Creating…" : "Create and use it"}
            </button>{" "}
            <button type="button" className="ghost" onClick={() => setMode("view")}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {mode === "new-gear" && current && (
        <div style={{ marginTop: 8 }}>
          <label style={{ display: "block", margin: "4px 0" }}>
            Gear name <input value={gearName} onChange={(e) => setGearName(e.target.value)} placeholder="billing" />
          </label>
          <label style={{ display: "block", margin: "4px 0" }}>
            What it is for{" "}
            <input
              value={gearProblem}
              onChange={(e) => setGearProblem(e.target.value)}
              placeholder="One sentence: the PRD opens with it"
              style={{ width: "min(480px, 100%)" }}
            />
          </label>
          <label style={{ display: "block", margin: "4px 0" }}>
            Capabilities{" "}
            <input value={gearCaps} onChange={(e) => setGearCaps(e.target.value)} placeholder="billing, invoices" />
          </label>
          <button
            type="button"
            className="primary"
            disabled={!gearName.trim()}
            onClick={() =>
              setScaffolding({
                slug: gearName.trim(),
                problem: gearProblem.trim() || undefined,
                caps: gearCaps
                  .split(",")
                  .map((c) => c.trim())
                  .filter(Boolean),
              })
            }
          >
            Preview →
          </button>{" "}
          <button type="button" className="ghost" onClick={() => setMode("view")}>
            Cancel
          </button>
        </div>
      )}

      {err && <p className="error" style={{ fontSize: 12, margin: "6px 0 0" }}>{err}</p>}

      {scaffolding && (
        <ScaffoldModal
          capability={scaffolding.slug}
          token={token}
          problem={scaffolding.problem}
          declares={scaffolding.caps}
          send={(body) => api.scaffoldOrgGear(token, body)}
          onClose={() => {
            setScaffolding(null);
            setMode("view");
          }}
        />
      )}
    </div>
  );
}
