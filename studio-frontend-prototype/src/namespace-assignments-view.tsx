/* Two of Infrastructure's tabs for an organization administrator (ADR-0062):
 *
 *   - Namespaces: which namespace each project deploys into in each
 *     environment, and where its builds run -- for a cluster that gives Studio
 *     namespaces rather than letting it create them. The rules are
 *     namespace-assignments.ts.
 *   - Image retention: how long the organization keeps its projects' images,
 *     for every project without a retention of its own. */

import { useCallback, useEffect, useState } from "react";
import { api, type DeployEnvironment, type ImageRetention, type NamespaceAssignment, type Tenant } from "./api";
import { DataTable } from "./data-table";
import { errText, relTime } from "./format";
import { retentionSummary } from "./images";
import {
  assignmentInput,
  assignmentProblem,
  assignmentRows,
  suggestedNamespace,
  type AssignmentInput,
  type AssignmentRow,
} from "./namespace-assignments";
import { RetentionForm } from "./project-images";
import { EmptyState, StatusChip } from "./ui-standard";

export function NamespaceAssignments({
  token,
  org,
  environments,
  projects,
}: {
  token: string;
  org: string;
  environments: DeployEnvironment[];
  projects: Tenant[];
}) {
  const [items, setItems] = useState<NamespaceAssignment[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<AssignmentInput | null>(null);
  const [tried, setTried] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .namespaceAssignments(token, org)
      .then((r) => {
        setItems(r.items);
        setError(null);
      })
      .catch((e) => {
        setItems([]);
        setError(errText(e));
      });
  }, [token, org]);
  useEffect(load, [load]);

  const clusters = environments.filter((e) => e.kind !== "research");
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const envName = (id: string) => environments.find((e) => e.id === id)?.name ?? id;
  const rows = items ? assignmentRows(items, projectName, envName) : null;
  const problem = editing ? assignmentProblem(editing, environments) : null;
  const env = editing ? environments.find((e) => e.id === editing.environment_id) : undefined;
  const suggestion = editing ? suggestedNamespace(env, projectName(editing.project_id)) : "";

  const save = async () => {
    if (!editing) return;
    setTried(true);
    if (problem) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveNamespaceAssignment(token, org, {
        project_id: editing.project_id,
        environment_id: editing.environment_id,
        namespace: editing.namespace.trim(),
        build_namespace: editing.build_namespace.trim() || null,
      });
      setNotice(`${projectName(saved.project_id)} deploys into ${saved.namespace} in ${envName(saved.environment_id)}.`);
      setEditing(null);
      setTried(false);
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" data-namespace-assignments>
      <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <b>Namespaces</b>
        <span className="sub grow">
          Which namespace each project deploys into in each environment, and where its builds run. Needed where the
          cluster gives Studio namespaces instead of letting it create them; a namespace a run made is recorded here too.
        </span>
        {!editing && (
          <button type="button" className="primary" onClick={() => setEditing(assignmentInput())} disabled={clusters.length === 0} data-assignment-add>
            Assign a namespace
          </button>
        )}
      </div>
      {notice && <div className="hint">{notice}</div>}
      {error && <div className="error">{error}</div>}
      {editing && (
        <form
          className="env-form"
          data-assignment-form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
            <label className="field">
              Project
              <select
                value={editing.project_id}
                onChange={(e) => setEditing({ ...editing, project_id: e.target.value })}
                aria-label="Project"
              >
                <option value="">Pick a project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Environment
              <select
                value={editing.environment_id}
                onChange={(e) => setEditing({ ...editing, environment_id: e.target.value })}
                aria-label="Environment"
              >
                <option value="">Pick an environment…</option>
                {clusters.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Namespace
              {env?.namespaces?.length ? (
                <select
                  value={editing.namespace}
                  onChange={(e) => setEditing({ ...editing, namespace: e.target.value })}
                  aria-label="Namespace"
                >
                  <option value="">Pick one the cluster gives…</option>
                  {env.namespaces.map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={editing.namespace}
                  placeholder={suggestion || "studio-web-dev"}
                  onChange={(e) => setEditing({ ...editing, namespace: e.target.value })}
                  aria-label="Namespace"
                />
              )}
            </label>
            <label className="field">
              Builds run in
              <input
                value={editing.build_namespace}
                placeholder={editing.namespace.trim() || "the same namespace"}
                onChange={(e) => setEditing({ ...editing, build_namespace: e.target.value })}
                aria-label="Builds run in"
              />
            </label>
          </div>
          {suggestion && !editing.namespace && !env?.namespaces?.length && (
            <button type="button" className="linklike" onClick={() => setEditing({ ...editing, namespace: suggestion })}>
              Use {suggestion}, as {env?.name}&apos;s pattern names it
            </button>
          )}
          {tried && problem && <div className="env-field-error">{problem}</div>}
          <div className="env-actions">
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(null);
                setTried(false);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      <DataTable<AssignmentRow>
        list="namespace-assignments"
        rows={rows}
        rowKey={(r) => r.key}
        rowLabel={(r) => `${r.project} in ${r.environment}`}
        defaultView="table"
        empty={{ title: "No namespace assigned yet · Studio creates its own where the cluster lets it" }}
        columns={[
          { id: "project", header: "Project", compare: (a, b) => a.project.localeCompare(b.project), cell: (r) => <b>{r.project}</b> },
          { id: "environment", header: "Environment", compare: (a, b) => a.environment.localeCompare(b.environment), cell: (r) => r.environment },
          { id: "namespace", header: "Namespace", cell: (r) => <code>{r.namespace}</code> },
          { id: "build", header: "Builds in", cell: (r) => (r.build ? <code>{r.build}</code> : <span className="sub">the same</span>) },
          {
            id: "by",
            header: "Assigned by",
            cell: (r) => (
              <span title={r.at ?? undefined}>
                {r.by}
                {r.at ? <span className="sub"> · {relTime(r.at)}</span> : null}
              </span>
            ),
          },
          {
            id: "change",
            header: "",
            cell: (r) => (
              <button type="button" className="linklike" onClick={() => setEditing(assignmentInput(r.assignment))} data-assignment-change={r.key}>
                Change
              </button>
            ),
          },
        ]}
      />
    </section>
  );
}

/** The organization's image retention: what every project without its own
 *  follows. */
export function OrgRetention({ token, org }: { token: string; org: string }) {
  const [retention, setRetention] = useState<ImageRetention | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let live = true;
    api
      .imageRetention(token, { org })
      .then((r) => live && setRetention(r))
      .catch((e) => live && setError(errText(e)));
    return () => {
      live = false;
    };
  }, [token, org]);
  return (
    <section className="card" data-org-retention>
      <div className="row" style={{ gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <b>Image retention</b>
        <StatusChip tone="neutral" data-org-retention-summary>
          {retention ? retentionSummary(retention) : error ? "not known" : "reading…"}
        </StatusChip>
        {saved && <span className="hint">Saved.</span>}
      </div>
      {error && !retention ? (
        <EmptyState title="The retention could not be read" body={error} />
      ) : retention ? (
        <RetentionForm
          token={token}
          owner={{ org }}
          retention={retention}
          onSaved={(r) => {
            setRetention(r);
            setSaved(true);
          }}
        />
      ) : null}
    </section>
  );
}
