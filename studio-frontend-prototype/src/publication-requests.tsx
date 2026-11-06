/* The platform's publication requests (ADR-0042 §4): every organization's
 * requests to give a gear to the platform, answered by a platform curator --
 * a platform administrator or one of the platform's gear curators
 * (`platform-gear-curator`). Publishing opens the pull request into the
 * platform's gear repository; preview it first. Declining says why.
 *
 * The curators are on the same page: a curator reads the list, and only a
 * platform administrator changes it. */

import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  api,
  type GearCurator,
  type OrgMember,
  type PublicationRequest,
  type RegistryPublishPreview,
} from "./api";
import { errText, relTime } from "./format";
import { personLabel, usePeople } from "./user-names";
import { publishPreviewLines } from "./registry";
import { EmptyState, InfoPopover, PageHeader, StatusChip } from "./ui-standard";

/** One request's key in the page's state. */
const keyOf = (r: PublicationRequest) => `${r.organization_id}/${r.name}`;

export function PublicationRequests({
  token,
  orgId,
}: {
  token: string;
  /** The organization in context: its members are offered as curators. */
  orgId?: string;
}) {
  const [items, setItems] = useState<PublicationRequest[] | null>(null);
  // A request saved without its asker's name: the organization's user list
  // may have it, where the curator may read it.
  const people = usePeople(token, items?.map((r) => r.organization_id) ?? []);
  const [refused, setRefused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, RegistryPublishPreview>>({});
  // The platform gear repository each request goes into, by source id, as the
  // curator picked it (ADR-0046 phase 4); the server's pick until then.
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [declining, setDeclining] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .publicationRequests(token)
      .then((r) => {
        setItems(r.items);
        setRefused(false);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) setRefused(true);
        else setError(errText(e));
        setItems([]);
      });
  }, [token]);
  useEffect(load, [load]);

  const answer = async (r: PublicationRequest, action: "publish" | "decline_publication", dryRun = false) => {
    const key = keyOf(r);
    setBusy(key);
    setError(null);
    setDone(null);
    try {
      const target = action === "publish" ? targets[key] : undefined;
      const after = await api.answerPublication(token, r.organization_id, r.name, {
        action,
        ...(dryRun ? { dry_run: true } : {}),
        ...(target ? { target } : {}),
        ...(action === "decline_publication" ? { reason: reason.trim() } : {}),
        ...(r.version ? { version: r.version } : {}),
      });
      if (dryRun) {
        if (after.publish_preview) {
          const preview = after.publish_preview as RegistryPublishPreview;
          setPreviews((p) => ({ ...p, [key]: preview }));
          if (preview.source_id) setTargets((t) => ({ ...t, [key]: preview.source_id as string }));
        }
        else setError("This backend cannot preview a publish.");
        return;
      }
      setDone(
        action === "publish"
          ? `Published ${r.name}: ${after.contribution?.pr_url ?? "pull request opened"}`
          : `Declined ${r.name}.`,
      );
      setDeclining(null);
      setReason("");
      load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="pubreq" data-publication-requests>
      <style>{PUBREQ_CSS}</style>
      <PageHeader
        title="Publication requests"
        info={
          <>
            Gears organizations ask the platform to take. A platform curator publishes one -- a pull request into the
            platform&apos;s gear repository -- or declines it with a reason. Once the platform&apos;s catalogue has it, it
            is in every organization&apos;s common set.
          </>
        }
        status={
          refused ? (
            <StatusChip tone="warn">no access</StatusChip>
          ) : (
            items !== null && (
              <StatusChip tone={items.length > 0 ? "warn" : "ok"} data-publication-count>
                {items.length > 0 ? `${items.length} open` : "none open"}
              </StatusChip>
            )
          )
        }
      />
      {refused ? (
        <div className="card" data-publication-refused>
          <EmptyState
            title="You cannot answer publication requests."
            body="Only a platform administrator or a platform gear curator answers them."
          />
        </div>
      ) : (
        <>
          {error && <div className="error">{error}</div>}
          {done && <div className="hint">{done}</div>}
          {items === null ? (
            <p className="hint">Loading…</p>
          ) : items.length === 0 ? (
            <div className="card">
              <EmptyState title="No open requests." body="An organization asks from its gear's page; the request lands here." />
            </div>
          ) : (
            <ul className="pubreq-list">
              {items.map((r) => {
                const key = keyOf(r);
                const preview = previews[key];
                return (
                  <li key={key} className="card" data-publication-request>
                    <div className="pubreq-head">
                      <b>{r.name}</b>
                      {r.version && <StatusChip tone="neutral">v{r.version.replace(/^v/, "")}</StatusChip>}
                      <span className="sub">
                        {r.organization_name ?? r.organization_id} · asked by {personLabel(r.requested_by, r.requested_by_name, people)} ·{" "}
                        {relTime(r.at)}
                      </span>
                    </div>
                    {r.reason && <div className="pubreq-reason">“{r.reason}”</div>}
                    {preview && (
                      <div className="hint" data-publication-preview>
                        {publishPreviewLines(preview).map((line) => (
                          <div key={line}>{line}</div>
                        ))}
                      </div>
                    )}
                    {preview && (preview.targets?.length ?? 0) > 1 && (
                      <label className="pubreq-actions" data-publication-target>
                        Into
                        <select
                          value={targets[key] ?? preview.source_id ?? ""}
                          onChange={(e) => {
                            const value = e.target.value;
                            setTargets((t) => ({ ...t, [key]: value }));
                            // Another repository is another pull request: preview it again.
                            setPreviews((p) => {
                              const next = { ...p };
                              delete next[key];
                              return next;
                            });
                          }}
                        >
                          {(preview.targets ?? []).map((t) => (
                            <option key={t.source_id} value={t.source_id}>
                              {t.source_id} ({t.repo}) · {t.gears_in_category} of its category
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    <div className="pubreq-actions">
                      <button type="button" disabled={busy === key} onClick={() => void answer(r, "publish", true)}>
                        {preview ? "Preview again" : "Preview"}
                      </button>
                      <button
                        type="button"
                        className="primary"
                        disabled={busy === key || !preview}
                        title={preview ? "Open the pull request into the platform's gear repository" : "Preview it first"}
                        onClick={() => void answer(r, "publish")}
                      >
                        Publish
                      </button>
                      <button type="button" disabled={busy === key} onClick={() => setDeclining(declining === key ? null : key)}>
                        Decline…
                      </button>
                    </div>
                    {declining === key && (
                      <div className="pubreq-actions">
                        <input
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                          placeholder="required: why the platform does not take it"
                          aria-label="Reason"
                        />
                        <button
                          type="button"
                          className="primary"
                          disabled={busy === key || !reason.trim()}
                          onClick={() => void answer(r, "decline_publication")}
                        >
                          Decline
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <Curators token={token} orgId={orgId} />
        </>
      )}
    </div>
  );
}

function Curators({ token, orgId }: { token: string; orgId?: string }) {
  const [items, setItems] = useState<GearCurator[] | null>(null);
  const [mayManage, setMayManage] = useState(false);
  const [members, setMembers] = useState<OrgMember[]>([]);
  const [pick, setPick] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .gearCurators(token)
      .then((r) => {
        setItems(r.items);
        setMayManage(r.may_manage);
      })
      .catch((e) => setError(errText(e)));
    if (orgId)
      api
        .orgMembers(token, orgId)
        .then(setMembers)
        .catch(() => setMembers([]));
  }, [token, orgId]);

  const save = async (next: GearCurator[]) => {
    setError(null);
    try {
      const r = await api.saveGearCurators(token, next);
      setItems(r.items);
    } catch (e) {
      setError(errText(e));
    }
  };

  const candidates = members.filter((m) => !(items ?? []).some((c) => c.id === m.user_id));
  return (
    <section className="card" data-gear-curators>
      <h3>
        Gear curators{" "}
        <InfoPopover label="About gear curators">
          People who answer publication requests beside the platform&apos;s administrators (the
          <code> platform-gear-curator</code> role). Only a platform administrator changes this list.
        </InfoPopover>
      </h3>
      {error && <div className="error">{error}</div>}
      {items === null ? (
        <p className="hint">Loading…</p>
      ) : items.length === 0 ? (
        <EmptyState title="No curators yet." body="The platform's administrators answer every request." />
      ) : (
        <ul className="pubreq-curators">
          {items.map((c) => (
            <li key={c.id}>
              {c.name ?? c.id}
              {mayManage && (
                <button type="button" className="ghost" onClick={() => void save(items.filter((x) => x.id !== c.id))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {mayManage && (
        <div className="pubreq-actions">
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Person to add">
            <option value="">add a person…</option>
            {candidates.map((m) => (
              <option key={m.user_id} value={m.user_id}>
                {m.display_name || m.email || m.user_id}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!pick}
            onClick={() => {
              const m = members.find((x) => x.user_id === pick);
              void save([...(items ?? []), { id: pick, name: m?.display_name || m?.email || null }]);
              setPick("");
            }}
          >
            Add
          </button>
        </div>
      )}
    </section>
  );
}

const PUBREQ_CSS = `
.pubreq .pubreq-list { list-style:none; padding:0; margin:0 0 1rem; display:grid; gap:12px; }
.pubreq .pubreq-head { display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; }
.pubreq .pubreq-head .sub { color:var(--muted-foreground); font-size:12px; }
.pubreq .pubreq-reason { margin:6px 0; font-size:13px; }
.pubreq .pubreq-actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; }
.pubreq .pubreq-actions input { flex:1; min-width:220px; }
.pubreq .pubreq-curators { list-style:none; padding:0; margin:6px 0; display:grid; gap:4px; }
.pubreq .pubreq-curators li { display:flex; gap:8px; align-items:center; }
`;
