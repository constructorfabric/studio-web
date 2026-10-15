import { eventBus } from '@gears-frontx/react';
import type { TypeDecisionRequest } from '../events/specsEvents';
import '../events/specsEvents';

/** A person's decision on a repository file's type, from the Type menu (#690). */
export function requestTypeDecision(request: TypeDecisionRequest): void {
  eventBus.emit('mfe/projects/type-decision-requested', request);
}
