/** The Specs list's events: a type decision asked for and refused, and the list changed. */

import '@gears-frontx/react';
import type { Refusal } from '@constructor-studio/mfe-shared';
import type { DecideBindingDto } from '../api/documentTypes';

export interface TypeDecisionRequest {
  projectId: string;
  workspaceId: string;
  bindingId: string;
  /** The document's name, for the toast if the decision is refused. */
  name: string;
  decision: DecideBindingDto;
}

declare module '@gears-frontx/react' {
  interface EventPayloadMap {
    'mfe/projects/type-decision-requested': TypeDecisionRequest;
    'mfe/projects/type-decision-refused': { projectId: string; name: string; refusal: Refusal };
    /** `spec-rows` changed (a type decision, a check, an upload): the list is read again. */
    'mfe/projects/specs-changed': { projectId: string };
  }
}
