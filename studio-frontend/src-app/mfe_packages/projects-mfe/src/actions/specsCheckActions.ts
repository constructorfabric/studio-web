import { eventBus } from '@gears-frontx/react';
import type { SpecsCheckRequest } from '../events/specsEvents';
import '../events/specsEvents';

/** Check from the Specs header (#691). */
export function requestSpecsCheck(request: SpecsCheckRequest): void {
  eventBus.emit('mfe/projects/specs-check-requested', request);
}
