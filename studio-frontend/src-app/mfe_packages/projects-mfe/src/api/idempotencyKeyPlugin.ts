/**
 * `Idempotency-Key` on a POST that starts background work.
 *
 * Such a POST answers `202` with a `run_id` (docs/api-conventions.md D1). If
 * the answer is lost, the client cannot tell "never arrived" from "arrived";
 * with the header, a retry of the same request answers the run the first one
 * started instead of starting a second.
 *
 * One key per body object, remembered. A plugin retry (the auth plugin's
 * refresh after a 401, say) rebuilds the request from the context as it was
 * before the onRequest chain, so the header is gone and this plugin runs again;
 * the body is the same object, so it gets the same key. A caller that sends
 * the same body object again is repeating one intent and gets the same key
 * too. A new body object is a new intent and gets a new key.
 *
 * A plugin rather than a per-call option because the FrontX mutation
 * descriptor takes no headers. It is added to one protocol instance and only
 * touches the POSTs its predicate names.
 */

import { RestPlugin, type RestRequestContext } from '@gears-frontx/react';

export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key';

export class IdempotencyKeyPlugin extends RestPlugin {
  private readonly keys = new WeakMap<object, string>();

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
      headers: { ...context.headers, [IDEMPOTENCY_KEY_HEADER]: this.keyFor(context.body) },
    };
  }

  private keyFor(body: unknown): string {
    if (typeof body !== 'object' || body === null) return crypto.randomUUID();
    let key = this.keys.get(body);
    if (key === undefined) {
      key = crypto.randomUUID();
      this.keys.set(body, key);
    }
    return key;
  }
}
