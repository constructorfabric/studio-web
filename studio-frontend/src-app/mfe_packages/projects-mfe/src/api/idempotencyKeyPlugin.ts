/**
 * `Idempotency-Key` on a POST that starts background work.
 *
 * Such a POST answers `202` with a `run_id` (docs/api-conventions.md D1). If
 * the answer is lost, the client cannot tell "never arrived" from "arrived";
 * with the header, a retry of the same request answers the run the first one
 * started instead of starting a second. One key per request: the plugin runs
 * once per request, and a plugin retry re-sends the prepared headers, so the
 * retry carries the same key.
 *
 * A plugin rather than a per-call option because the FrontX mutation
 * descriptor takes no headers. It is added to one protocol instance and only
 * touches the POSTs its predicate names.
 */

import { RestPlugin, type RestRequestContext } from '@gears-frontx/react';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

export class IdempotencyKeyPlugin extends RestPlugin {
  constructor(private readonly startsWork: (url: string) => boolean) {
    super();
  }

  onRequest(context: RestRequestContext): RestRequestContext {
    if (
      context.method !== 'POST' ||
      !this.startsWork(context.url) ||
      context.headers[IDEMPOTENCY_KEY_HEADER] !== undefined
    ) {
      return context;
    }
    return {
      ...context,
      headers: { ...context.headers, [IDEMPOTENCY_KEY_HEADER]: crypto.randomUUID() },
    };
  }
}
