/**
 * The wizard's steps, as data.
 */

// @cpt-dod:cpt-studiofrontend-dod-project-create-steps:p1
// @cpt-algo:cpt-studiofrontend-algo-project-create-steps:p2
import { hasRequiredSource, isNameUsable, type ProjectDraft } from './projectDraft';

export type WizardStepKey = 'details' | 'repositories';

export interface WizardStep {
  readonly key: WizardStepKey;
  readonly titleKey: string;
  isApplicable(draft: ProjectDraft): boolean;
  isComplete(draft: ProjectDraft): boolean;
}

const details: WizardStep = {
  key: 'details',
  titleKey: 'title',
  isApplicable: () => true,
  isComplete: (draft) => isNameUsable(draft.name) && draft.mode !== null,
};

const repositories: WizardStep = {
  key: 'repositories',
  titleKey: 'repos_title',
  isApplicable: (draft) => draft.mode === 'modernize',
  isComplete: hasRequiredSource,
};

export const WIZARD_STEPS: readonly WizardStep[] = [details, repositories];

export const FIRST_STEP_KEY: WizardStepKey = 'details';

// @cpt-begin:cpt-studiofrontend-algo-project-create-steps:p2:inst-1
function applicable(draft: ProjectDraft): readonly WizardStep[] {
  return WIZARD_STEPS.filter((step) => step.isApplicable(draft));
}
// @cpt-end:cpt-studiofrontend-algo-project-create-steps:p2:inst-1

// @cpt-begin:cpt-studiofrontend-algo-project-create-steps:p2:inst-2
// @cpt-begin:cpt-studiofrontend-algo-project-create-steps:p2:inst-3
export function stepFor(draft: ProjectDraft, key: WizardStepKey): WizardStep {
  const open = applicable(draft);
  return open.find((step) => step.key === key) ?? open[0]!;
}
// @cpt-end:cpt-studiofrontend-algo-project-create-steps:p2:inst-2
// @cpt-end:cpt-studiofrontend-algo-project-create-steps:p2:inst-3

// @cpt-begin:cpt-studiofrontend-algo-project-create-steps:p2:inst-4
export function nextStep(draft: ProjectDraft, key: WizardStepKey): WizardStep | null {
  const open = applicable(draft);
  const index = open.findIndex((step) => step.key === key);
  return index >= 0 ? (open[index + 1] ?? null) : null;
}

export function prevStep(draft: ProjectDraft, key: WizardStepKey): WizardStep | null {
  const open = applicable(draft);
  const index = open.findIndex((step) => step.key === key);
  return index > 0 ? (open[index - 1] ?? null) : null;
}

// @cpt-end:cpt-studiofrontend-algo-project-create-steps:p2:inst-4

// @cpt-begin:cpt-studiofrontend-algo-project-create-steps:p2:inst-5
export function isFinalStep(draft: ProjectDraft, key: WizardStepKey): boolean {
  return nextStep(draft, key) === null;
}
// @cpt-end:cpt-studiofrontend-algo-project-create-steps:p2:inst-5
