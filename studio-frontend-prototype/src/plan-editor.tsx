/** The report's plan, edited in Studio.
 *
 *  The planning team's `gears.yaml` -- teams, people, consumer projects, and
 *  per gear when each project needs it -- in tabs, one section saved at a
 *  time against the revision it was read at. The first save makes Studio the
 *  plan's home: a file it was read from is let go. "Export gears.yaml" hands
 *  the text back for the planning script or a backup. */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { ApiError, api } from "./api";
import { errText } from "./format";
import {
  NEED_SUGGESTIONS,
  move,
  needOf,
  optional,
  parseNumber,
  quarters,
  linkOf,
  teamChoices,
  withNeed,
  type LinkState,
  type PlanPeople,
  type Plan,
  type PlanSection,
} from "./plan-model";

const HINT: CSSProperties = { color: "var(--muted-foreground)", fontSize: 12, margin: 0 };
const TABLE: CSSProperties = { borderCollapse: "collapse", width: "100%", fontSize: 13 };
const CELL: CSSProperties = { padding: "2px 4px", borderBottom: "1px solid var(--border)", verticalAlign: "middle" };
const INPUT: CSSProperties = { width: "100%", minWidth: 60, boxSizing: "border-box" };
const NUM: CSSProperties = { width: 64 };

const TABS: { id: PlanSection; label: string }[] = [
  { id: "units", label: "Teams" },
  { id: "people", label: "People" },
  { id: "projects", label: "Projects" },
  { id: "needs", label: "Needs" },
  { id: "lanes", label: "Lanes" },
];

function sectionOf(p: Plan, s: PlanSection): unknown {
  return s === "units" ? [p.units, p.no_unit_color] : p[s];
}

function same(a: Plan, b: Plan, s: PlanSection): boolean {
  return JSON.stringify(sectionOf(a, s)) === JSON.stringify(sectionOf(b, s));
}

/** A number input that keeps what is typed until it reads as a number. */
function NumberField({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  useEffect(() => setText(value == null ? "" : String(value)), [value]);
  const parsed = parseNumber(text);
  return (
    <input
      style={{ ...NUM, borderColor: parsed === undefined ? "var(--destructive, #dc2626)" : undefined }}
      value={text}
      inputMode="decimal"
      onChange={(e) => {
        setText(e.target.value);
        const v = parseNumber(e.target.value);
        if (v !== undefined) onChange(v);
      }}
    />
  );
}

function RowButtons({ onUp, onDown, onRemove }: { onUp?: () => void; onDown?: () => void; onRemove: () => void }) {
  return (
    <span style={{ display: "flex", gap: 2, whiteSpace: "nowrap" }}>
      {onUp && (
        <button className="iconbtn" title="Move up" onClick={onUp}>
          ↑
        </button>
      )}
      {onDown && (
        <button className="iconbtn" title="Move down" onClick={onDown}>
          ↓
        </button>
      )}
      <button className="iconbtn" title="Remove" onClick={onRemove}>
        ×
      </button>
    </span>
  );
}

/** Who a login is in Studio, in a word or two. */
function LinkCell({
  state,
  nameOf,
  available,
}: {
  state: LinkState;
  nameOf: (id: string) => string;
  available: boolean;
}) {
  if (!available) return <span style={HINT}>—</span>;
  switch (state.kind) {
    case "member":
      return <span title="An active member, by their confirmed GitHub account">✓ {nameOf(state.personId)}</span>;
    case "outsider":
      return (
        <span style={HINT} title="A Studio person by this GitHub account, but not a member of this organization">
          {nameOf(state.personId)} · not a member
        </span>
      );
    case "unknown":
      return (
        <span style={HINT} title="Nobody in Studio has confirmed this GitHub account">
          not in Studio
        </span>
      );
    case "unsaved":
      return (
        <span style={HINT} title="Matched once the people are saved">
          …
        </span>
      );
  }
}

export function PlanEditor({
  token,
  report,
  org,
  studioProjects = [],
  onSaved,
}: {
  token: string;
  report: string;
  /** The organization on screen: its members name the linked people. */
  org?: string;
  /** The organization's Studio projects, which a consumer project can be. */
  studioProjects?: { id: string; name: string }[];
  onSaved?: () => void;
}) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [draft, setDraft] = useState<Plan | null>(null);
  const [tab, setTab] = useState<PlanSection>("units");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [filter, setFilter] = useState("");
  const [links, setLinks] = useState<PlanPeople | null>(null);
  const [names, setNames] = useState<Map<string, string>>(new Map());

  const loadLinks = useCallback(() => {
    api
      .reportPlanPeople(token, report)
      .then(setLinks)
      .catch(() => setLinks(null));
  }, [token, report]);

  const load = useCallback(() => {
    setStale(false);
    api
      .reportPlan(token, report)
      .then((p) => {
        setPlan(p);
        setDraft(p);
      })
      .catch((e) => setNote(errText(e)));
    loadLinks();
  }, [token, report, loadLinks]);
  useEffect(load, [load]);

  // Names come from the members list, which needs `people.view`; without it
  // a linked person is shown by id.
  useEffect(() => {
    if (!org) return;
    api
      .orgMembers(token, org)
      .then((ms) => setNames(new Map(ms.map((m) => [m.user_id, m.display_name || m.email || m.user_id]))))
      .catch(() => setNames(new Map()));
  }, [token, org]);
  const nameOf = (id: string) => names.get(id) ?? `${id.slice(0, 8)}…`;

  const suggestions = useMemo(() => [...NEED_SUGGESTIONS, ...quarters(new Date())], []);

  if (!plan || !draft) return <p style={HINT}>{note ?? "Reading the plan…"}</p>;

  const dirty = (s: PlanSection) => !same(plan, draft, s);
  const set = (p: Partial<Plan>) => setDraft((d) => (d ? { ...d, ...p } : d));

  const save = async (s: PlanSection) => {
    if (plan.file && !window.confirm(`The plan is read from ${plan.file}. Saving here makes Studio its home, and refreshes stop reading the file. Save?`)) {
      return;
    }
    setBusy(true);
    setNote(null);
    try {
      const saved = await api.updateReportPlan(token, report, s, { ...draft, revision: plan.revision });
      setPlan(saved);
      // The other sections keep whatever is still being edited in them.
      setDraft((d) => {
        if (!d) return saved;
        const next: Plan = { ...saved };
        for (const t of TABS) {
          if (t.id !== s && !same(plan, d, t.id)) {
            if (t.id === "units") {
              next.units = d.units;
              next.no_unit_color = d.no_unit_color;
            } else {
              (next as unknown as Record<string, unknown>)[t.id] = d[t.id];
            }
          }
        }
        return next;
      });
      setNote("Saved.");
      if (s === "people") loadLinks();
      onSaved?.();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setStale(true);
        setNote("Somebody saved the plan since you opened it. Reload to see their change; what you typed here is lost on reload.");
      } else {
        setNote(errText(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const exportYaml = async () => {
    try {
      const blob = await api.exportReportPlan(token, report);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "gears.yaml";
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setNote(errText(e));
    }
  };

  const teams = teamChoices(draft.units);
  const projects = draft.projects;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`iconbtn${tab === t.id ? " primary" : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {dirty(t.id) ? " •" : ""}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        <button className="iconbtn" disabled={plan.revision === 0} onClick={exportYaml}>
          Export gears.yaml
        </button>
      </div>
      <p style={HINT}>
        {plan.revision === 0
          ? "No plan yet: start it here, or load gears.yaml above."
          : `Revision ${plan.revision}${plan.from ? `, ${plan.from === "studio" ? "edited here" : `from ${plan.from}`}` : ""}${plan.changed_at ? `, ${plan.changed_at.slice(0, 16).replace("T", " ")}` : ""}.`}
        {plan.file && ` Read from ${plan.file}: the first save here lets the file go.`}
      </p>

      {tab === "units" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {draft.units.map((u, ui) => {
            const setUnit = (patch: Partial<typeof u>) =>
              set({ units: draft.units.map((x, i) => (i === ui ? { ...x, ...patch } : x)) });
            return (
              <div key={ui} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 8 }}>
                <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 6 }}>
                  <input style={{ width: 180 }} placeholder="Unit" value={u.name} onChange={(e) => setUnit({ name: e.target.value })} />
                  <input style={{ width: 90 }} placeholder="colour" value={u.color ?? ""} onChange={(e) => setUnit({ color: optional(e.target.value) })} />
                  <span style={{ flex: 1 }} />
                  <RowButtons
                    onUp={ui > 0 ? () => set({ units: move(draft.units, ui, ui - 1) }) : undefined}
                    onDown={ui < draft.units.length - 1 ? () => set({ units: move(draft.units, ui, ui + 1) }) : undefined}
                    onRemove={() => set({ units: draft.units.filter((_, i) => i !== ui) })}
                  />
                </div>
                <table style={TABLE}>
                  <thead>
                    <tr>
                      {["Tag", "Team", "Colour", "People", "Power", ""].map((h) => (
                        <th key={h} style={{ ...CELL, textAlign: "left" }}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {u.teams.map((t, ti) => {
                      const setTeam = (patch: Partial<typeof t>) =>
                        setUnit({ teams: u.teams.map((x, i) => (i === ti ? { ...x, ...patch } : x)) });
                      return (
                        <tr key={ti}>
                          <td style={CELL}>
                            <input style={INPUT} value={t.tag} onChange={(e) => setTeam({ tag: e.target.value })} />
                          </td>
                          <td style={CELL}>
                            <input style={INPUT} value={t.name} onChange={(e) => setTeam({ name: e.target.value })} />
                          </td>
                          <td style={CELL}>
                            <input style={{ width: 80 }} value={t.color ?? ""} onChange={(e) => setTeam({ color: optional(e.target.value) })} />
                          </td>
                          <td style={CELL}>
                            <NumberField value={t.people} onChange={(v) => setTeam({ people: v })} />
                          </td>
                          <td style={CELL}>
                            <NumberField value={t.power} onChange={(v) => setTeam({ power: v })} />
                          </td>
                          <td style={CELL}>
                            <RowButtons onRemove={() => setUnit({ teams: u.teams.filter((_, i) => i !== ti) })} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <button
                  className="iconbtn"
                  style={{ marginTop: 4 }}
                  onClick={() => setUnit({ teams: [...u.teams, { tag: "", name: "", color: u.color, people: null, power: null }] })}
                >
                  Add team
                </button>
              </div>
            );
          })}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="iconbtn" onClick={() => set({ units: [...draft.units, { name: "", color: null, teams: [] }] })}>
              Add unit
            </button>
            <span style={HINT}>Colour of a person in no unit</span>
            <input style={{ width: 90 }} value={draft.no_unit_color ?? ""} onChange={(e) => set({ no_unit_color: optional(e.target.value) })} />
          </div>
        </div>
      )}

      {tab === "people" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <input placeholder="Filter by login, alias or team" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <table style={TABLE}>
            <thead>
              <tr>
                {["GitHub login", "In Studio", "Alias", "Team", "Power", "Email", ""].map((h) => (
                  <th key={h} style={{ ...CELL, textAlign: "left" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {draft.people.map((p, pi) => {
                const f = filter.trim().toLowerCase();
                if (f && ![p.login, p.alias ?? "", p.team ?? ""].some((v) => v.toLowerCase().includes(f))) return null;
                const setPerson = (patch: Partial<typeof p>) =>
                  set({ people: draft.people.map((x, i) => (i === pi ? { ...x, ...patch } : x)) });
                return (
                  <tr key={pi}>
                    <td style={CELL}>
                      <input style={INPUT} value={p.login} onChange={(e) => setPerson({ login: e.target.value })} />
                    </td>
                    <td style={{ ...CELL, whiteSpace: "nowrap" }}>
                      <LinkCell state={linkOf(links, p.login)} nameOf={nameOf} available={links?.identities_available ?? false} />
                    </td>
                    <td style={CELL}>
                      <input style={INPUT} value={p.alias ?? ""} onChange={(e) => setPerson({ alias: optional(e.target.value) })} />
                    </td>
                    <td style={CELL}>
                      <select style={INPUT} value={p.team ?? ""} onChange={(e) => setPerson({ team: optional(e.target.value) })}>
                        <option value="">—</option>
                        {p.team && !teams.some((t) => t.tag === p.team) && <option value={p.team}>{p.team}</option>}
                        {teams.map((t) => (
                          <option key={t.tag} value={t.tag}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={CELL}>
                      <NumberField value={p.power} onChange={(v) => setPerson({ power: v })} />
                    </td>
                    <td style={CELL}>
                      <input style={INPUT} value={p.email ?? ""} onChange={(e) => setPerson({ email: optional(e.target.value) })} />
                    </td>
                    <td style={CELL}>
                      <RowButtons onRemove={() => set({ people: draft.people.filter((_, i) => i !== pi) })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <button
            className="iconbtn"
            style={{ alignSelf: "flex-start" }}
            onClick={() =>
              set({ people: [...draft.people, { login: "", alias: null, team: null, unit: null, power: 1, email: null }] })
            }
          >
            Add person
          </button>
          {links && links.identities_available && (links.unplanned.length > 0 || links.members_without_github > 0) && (
            <div style={{ borderTop: "1px solid var(--border)", paddingTop: 6 }}>
              {links.unplanned.length > 0 && (
                <>
                  <p style={{ ...HINT, marginBottom: 4 }}>Members of the organization the plan does not list:</p>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {links.unplanned
                      .filter((u) => !draft.people.some((p) => u.github.some((g) => g.toLowerCase() === p.login.trim().toLowerCase())))
                      .map((u) => (
                        <span key={u.person_id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                          <span>{nameOf(u.person_id)}</span>
                          <code>{u.github.join(", ")}</code>
                          <button
                            className="iconbtn"
                            onClick={() =>
                              set({
                                people: [
                                  ...draft.people,
                                  {
                                    login: u.github[0],
                                    alias: names.get(u.person_id) ?? null,
                                    team: null,
                                    unit: null,
                                    power: 1,
                                    email: null,
                                  },
                                ],
                              })
                            }
                          >
                            Add to the plan
                          </button>
                        </span>
                      ))}
                  </div>
                </>
              )}
              {links.members_without_github > 0 && (
                <p style={HINT}>
                  {links.members_without_github} member(s) have no confirmed GitHub account, so the plan cannot name them
                  until they confirm one.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "projects" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <table style={TABLE}>
            <thead>
              <tr>
                {["Key", "Name", "Source column", "Studio project", ""].map((h) => (
                  <th key={h} style={{ ...CELL, textAlign: "left" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {projects.map((p, pi) => {
                const setProject = (patch: Partial<typeof p>) =>
                  set({ projects: projects.map((x, i) => (i === pi ? { ...x, ...patch } : x)) });
                return (
                  <tr key={pi}>
                    <td style={CELL}>
                      <input style={INPUT} value={p.key} onChange={(e) => setProject({ key: e.target.value })} />
                    </td>
                    <td style={CELL}>
                      <input style={INPUT} value={p.name} onChange={(e) => setProject({ name: e.target.value })} />
                    </td>
                    <td style={CELL}>
                      <input style={INPUT} value={p.source_header ?? ""} onChange={(e) => setProject({ source_header: optional(e.target.value) })} />
                    </td>
                    <td style={CELL}>
                      <select
                        style={INPUT}
                        value={p.studio_project ?? ""}
                        onChange={(e) => setProject({ studio_project: optional(e.target.value) })}
                      >
                        <option value="">— outside Studio</option>
                        {p.studio_project && !studioProjects.some((s) => s.id === p.studio_project) && (
                          <option value={p.studio_project}>{p.studio_project.slice(0, 8)}… (not in this organization)</option>
                        )}
                        {studioProjects.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td style={CELL}>
                      <RowButtons
                        onUp={pi > 0 ? () => set({ projects: move(projects, pi, pi - 1) }) : undefined}
                        onDown={pi < projects.length - 1 ? () => set({ projects: move(projects, pi, pi + 1) }) : undefined}
                        onRemove={() => set({ projects: projects.filter((_, i) => i !== pi) })}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p style={HINT}>The order here is the order of the needs' columns in the workbook.</p>
          <button
            className="iconbtn"
            style={{ alignSelf: "flex-start" }}
            onClick={() => set({ projects: [...projects, { key: "", name: "", source_header: null, studio_project: null }] })}
          >
            Add project
          </button>
        </div>
      )}

      {tab === "needs" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, overflowX: "auto" }}>
          <datalist id={`need-suggestions-${report}`}>
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
          <table style={TABLE}>
            <thead>
              <tr>
                <th style={{ ...CELL, textAlign: "left" }}>#</th>
                <th style={{ ...CELL, textAlign: "left" }}>Gear</th>
                {projects.map((p) => (
                  <th key={p.key} style={{ ...CELL, textAlign: "left" }} title={p.key}>
                    {p.name}
                  </th>
                ))}
                <th style={CELL} />
              </tr>
            </thead>
            <tbody>
              {draft.needs.map((n, ni) => {
                const setNeed = (next: typeof n) => set({ needs: draft.needs.map((x, i) => (i === ni ? next : x)) });
                return (
                  <tr key={ni}>
                    <td style={CELL}>
                      <input style={{ width: 64 }} value={n.number} onChange={(e) => setNeed({ ...n, number: e.target.value })} />
                    </td>
                    <td style={CELL}>
                      <input style={{ ...INPUT, minWidth: 200 }} value={n.title ?? ""} onChange={(e) => setNeed({ ...n, title: optional(e.target.value) })} />
                    </td>
                    {projects.map((p) => (
                      <td key={p.key} style={CELL}>
                        <input
                          style={{ width: 72 }}
                          list={`need-suggestions-${report}`}
                          value={needOf(n, p.key)}
                          onChange={(e) => setNeed(withNeed(n, p.key, e.target.value, projects))}
                        />
                      </td>
                    ))}
                    <td style={CELL}>
                      <RowButtons onRemove={() => set({ needs: draft.needs.filter((_, i) => i !== ni) })} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p style={HINT}>A cell is when the project needs the gear: a quarter (Q3&apos;26), YES (already), no, or ?. Empty means not asked.</p>
          <button
            className="iconbtn"
            style={{ alignSelf: "flex-start" }}
            onClick={() => set({ needs: [...draft.needs, { number: "", title: null, gear: null, group: null, needs: [] }] })}
          >
            Add gear
          </button>
        </div>
      )}

      {tab === "lanes" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <table style={TABLE}>
            <thead>
              <tr>
                {["Group", "Shown as", ""].map((h) => (
                  <th key={h} style={{ ...CELL, textAlign: "left" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {draft.lanes.order.map((g, gi) => {
                const label = draft.lanes.labels.find((l) => l.group.toUpperCase() === g.toUpperCase())?.label ?? "";
                const setLanes = (order: string[], labels = draft.lanes.labels) => set({ lanes: { order, labels } });
                return (
                  <tr key={gi}>
                    <td style={CELL}>
                      <input
                        style={INPUT}
                        value={g}
                        onChange={(e) => setLanes(draft.lanes.order.map((x, i) => (i === gi ? e.target.value : x)))}
                      />
                    </td>
                    <td style={CELL}>
                      <input
                        style={INPUT}
                        value={label}
                        onChange={(e) => {
                          const rest = draft.lanes.labels.filter((l) => l.group.toUpperCase() !== g.toUpperCase());
                          const labels = e.target.value.trim() ? [...rest, { group: g, label: e.target.value }] : rest;
                          setLanes(draft.lanes.order, labels);
                        }}
                      />
                    </td>
                    <td style={CELL}>
                      <RowButtons
                        onUp={gi > 0 ? () => setLanes(move(draft.lanes.order, gi, gi - 1)) : undefined}
                        onDown={gi < draft.lanes.order.length - 1 ? () => setLanes(move(draft.lanes.order, gi, gi + 1)) : undefined}
                        onRemove={() => setLanes(draft.lanes.order.filter((_, i) => i !== gi))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p style={HINT}>A group is the prefix of a gear&apos;s title on the board (&quot;CORE - …&quot;). Groups not listed come after these.</p>
          <button
            className="iconbtn"
            style={{ alignSelf: "flex-start" }}
            onClick={() => set({ lanes: { ...draft.lanes, order: [...draft.lanes.order, ""] } })}
          >
            Add lane
          </button>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="iconbtn primary" disabled={busy || stale || !dirty(tab)} onClick={() => void save(tab)}>
          {busy ? "Saving…" : `Save ${TABS.find((t) => t.id === tab)?.label.toLowerCase()}`}
        </button>
        <button className="iconbtn" disabled={busy || !dirty(tab)} onClick={() => setDraft((d) => (d ? ({ ...d, ...(tab === "units" ? { units: plan.units, no_unit_color: plan.no_unit_color } : { [tab]: plan[tab] }) } as Plan) : d))}>
          Undo changes
        </button>
        {stale && (
          <button className="iconbtn" onClick={load}>
            Reload
          </button>
        )}
        {note && <span style={stale ? { ...HINT, color: "var(--destructive, #dc2626)" } : HINT}>{note}</span>}
      </div>
    </div>
  );
}
