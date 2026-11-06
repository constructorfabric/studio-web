// The shell's project fields (project-filters.ts) as screens use them: which
// fields are registered under a workspace, the chip a field draws, the menu
// that moves a project's field, and the editors a field brings to the
// workspace's settings. Screens import this file, never a field's own module:
// the project lifecycle is the first field to be registered here, and a kit's
// fields will be the next.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { api } from "./api";
import { MenuButton } from "./menu-button";
import { errText } from "./problem";
import { BUILTIN_PHASES, lifecycleField, type ProjectPhase } from "./project-lifecycle";
import { PhasesEditor, loadPhases } from "./project-lifecycle-view";
import {
  fieldOptions,
  matchField,
  projectFields,
  reposField,
  scalarAttributes,
  templateField,
  type FieldMove,
  type ProjectFacts,
  type ProjectField,
} from "./project-filters";
import { BUILTIN_TEMPLATES, parseTemplates, type ProjectTemplate } from "./project-types";
import { StatusChip } from "./ui-standard";

/** Fired with the project's id after a field of its config changed, so a list
 *  showing it can read it again. */
export const PROJECT_FIELDS_CHANGED = "studio:project-fields-changed";

/** Fired after a field's settings (the phase list) were saved. */
const FIELD_SETTINGS_CHANGED = "studio:project-field-settings-changed";

/** The fields registered under a workspace (or, with no workspace, under an
 *  organization): the lifecycle, the template, the repositories. Each reads
 *  what it needs; until then it works from its built-in defaults. */
export function useProjectFields(token: string, workspaceId: string | null, orgId: string | null): ProjectField[] {
  const [phases, setPhases] = useState<ProjectPhase[]>(BUILTIN_PHASES);
  const [templates, setTemplates] = useState<ProjectTemplate[]>(BUILTIN_TEMPLATES);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const changed = () => setTick((n) => n + 1);
    window.addEventListener(FIELD_SETTINGS_CHANGED, changed);
    return () => window.removeEventListener(FIELD_SETTINGS_CHANGED, changed);
  }, []);
  useEffect(() => {
    let alive = true;
    void loadPhases(token, workspaceId, orgId).then((p) => alive && setPhases(p));
    const tenant = workspaceId ?? orgId;
    if (tenant)
      api
        .projectTypes(token, tenant)
        .then((raw) => alive && setTemplates(parseTemplates(raw, [])))
        .catch(() => {});
    return () => {
      alive = false;
    };
  }, [token, workspaceId, orgId, tick]);
  return useMemo(() => [lifecycleField(phases), templateField(templates), reposField], [phases, templates]);
}

/** The DataTable filters for `fields` over `rows`: the registered ones and the
 *  generic ones the rows' attributes add. */
export function fieldFilters<T>(
  registered: ProjectField[],
  rows: T[],
  facts: (row: T) => ProjectFacts | undefined,
): { id: string; allLabel: string; kind: "select"; options: ReturnType<typeof fieldOptions>; match: (row: T, value: string) => boolean }[] {
  const all = rows.map(facts);
  return projectFields(registered, all).map((f) => ({
    id: f.id,
    allLabel: f.allLabel,
    kind: "select" as const,
    options: fieldOptions(f, all),
    match: (row: T, value: string) => matchField(f, facts(row), value),
  }));
}

/** A field's chip for a project, or nothing when the field draws none. */
export function FieldChip({ field, facts }: { field: ProjectField; facts: ProjectFacts | undefined }) {
  if (!field.chip || !facts) return null;
  const c = field.chip(facts);
  return (
    <StatusChip tone={c.tone} title={c.title} data-project-field={field.id} data-field-value={c.key}>
      {c.text}
    </StatusChip>
  );
}

/** Every chip the fields draw, side by side. */
export function FieldChips({ fields, facts }: { fields: ProjectField[]; facts: ProjectFacts | undefined }) {
  return (
    <>
      {fields
        .filter((f) => f.chip)
        .map((f) => (
          <FieldChip key={f.id} field={f} facts={facts} />
        ))}
    </>
  );
}

/** Write `patch` into a project's config: read, changed, written back whole,
 *  as every writer of that document does. */
export async function patchProjectConfig(token: string, projectId: string, patch: Record<string, unknown>): Promise<void> {
  const cfg = (await api.projectConfig(token, projectId)) ?? {};
  await api.putProjectConfig(token, projectId, { ...cfg, ...patch });
  window.dispatchEvent(new CustomEvent(PROJECT_FIELDS_CHANGED, { detail: projectId }));
}

/** The moves of every field, as menu items that write them. */
export function fieldMoveItems(
  fields: ProjectField[],
  facts: ProjectFacts | undefined,
  write: (patch: Record<string, unknown>) => void,
): { label: string; onSelect: () => void }[] {
  if (!facts) return [];
  return fields.flatMap((f) => (f.moves?.(facts) ?? []).map((m: FieldMove) => ({ label: m.label, onSelect: () => write(m.patch) })));
}

/** What a new project's config starts with, from every field. */
export { initialAttributes } from "./project-filters";

/** In a project's tab bar: each field that draws a chip, as a button opening
 *  the moves from where the project is. */
export function ProjectFieldControls({
  token,
  projectId,
  workspaceId,
  orgId,
}: {
  token: string;
  projectId: string;
  workspaceId: string | null;
  orgId: string | null;
}) {
  const fields = useProjectFields(token, workspaceId, orgId);
  const [facts, setFacts] = useState<ProjectFacts | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    setFacts(undefined);
    api
      .projectConfig(token, projectId)
      .then((cfg) => alive && setFacts({ attributes: scalarAttributes(cfg as Record<string, unknown> | null) }))
      .catch(() => alive && setFacts({ attributes: null }));
    return () => {
      alive = false;
    };
  }, [token, projectId]);

  const write = useCallback(
    async (patch: Record<string, unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await patchProjectConfig(token, projectId, patch);
        setFacts((f) => ({ ...f, attributes: { ...(f?.attributes ?? {}), ...patch } }));
      } catch (e) {
        setError(errText(e));
      } finally {
        setBusy(false);
      }
    },
    [token, projectId],
  );

  if (!facts) return null;
  return (
    <span className="field-controls" data-field-controls>
      {fields
        .filter((f) => f.chip)
        .map((f) => (
          <MenuButton
            key={f.id}
            label={`${f.chip!(facts).text}: change the project's ${f.label.toLowerCase()}`}
            buttonClassName="field-trigger"
            trigger={
              <>
                <FieldChip field={f} facts={facts} />
                <span className="field-caret" aria-hidden>
                  ▾
                </span>
              </>
            }
            heading={<FieldLadder field={f} facts={facts} />}
            items={fieldMoveItems([f], facts, (patch) => void write(patch)).map((i) => ({ ...i, disabled: busy }))}
          />
        ))}
      {error && (
        <span className="error field-error" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}

/** A field's choices in order with the project's marked: where it is. */
function FieldLadder({ field, facts }: { field: ProjectField; facts: ProjectFacts }) {
  const choices = field.choices?.() ?? [];
  if (choices.length === 0) return null;
  const current = field.value(facts);
  return (
    <ol className="field-ladder" aria-label={field.label}>
      {choices.map((c) => (
        <li key={c.value} className={c.value === current ? "on" : undefined}>
          {c.label}
        </li>
      ))}
    </ol>
  );
}

/** The settings the registered fields bring to a workspace's Templates &
 *  phases section. */
export function ProjectFieldSettings({
  token,
  workspace,
}: {
  token: string;
  workspace: { id: string; orgId: string; orgName: string };
}): ReactNode {
  return (
    <PhasesEditor
      token={token}
      workspace={workspace}
      onSaved={() => window.dispatchEvent(new CustomEvent(FIELD_SETTINGS_CHANGED))}
    />
  );
}
