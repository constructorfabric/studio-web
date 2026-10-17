/** The Specs list's events: a type decision asked for and refused, a check asked for, and the list changed. */

import '@gears-frontx/react';
import type { Refusal } from '@constructor-studio/mfe-shared';
import type { DecideBindingDto } from '../api/documentTypes';
import type { SpecsCheckTarget } from '../model/specsCheck';

export interface TypeDecisionRequest {
  projectId: string;
  workspaceId: string;
  bindingId: string;
  /** The document's name, for the toast if the decision is refused. */
  name: string;
  decision: DecideBindingDto;
}

/** Check (#691): two Spec Quality runs over these specs. */
export interface SpecsCheckRequest {
  projectId: string;
  workspaceId: string;
  /** The project's name, for the toast. */
  project: string;
  targets: SpecsCheckTarget[];
}

declare module '@gears-frontx/react' {
  interface EventPayloadMap {
    'mfe/projects/type-decision-requested': TypeDecisionRequest;
    'mfe/projects/type-decision-refused': { projectId: string; name: string; refusal: Refusal };
    'mfe/projects/specs-check-requested': SpecsCheckRequest;
    /** `spec-rows` changed (a type decision, a check, an upload): the list is read again. */
    'mfe/projects/specs-changed': { projectId: string };
  }
}
