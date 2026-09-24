import type { EndpointDescriptor } from '@gears-frontx/react';

/**
 * The HTTP status a transport error carries, or `undefined` when the failure
 * never got an answer (a network error, an abort, a thrown non-error). The one
 * place that knows the error shape the API client throws.
 */
export function responseStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  return (error as { response?: { status?: number } }).response?.status;
}

/**
 * A 404 from a tenant-metadata read is data, not a failure: AM answers it for a
 * tenant whose metadata of that type was never written. Anything else stays an
 * error, so a broken proxy is not silently read as "no attributes".
 */
export function isNotFound(error: unknown): boolean {
  return responseStatus(error) === 404;
}

/**
 * The same descriptor, resolving to `null` on a 404 instead of rejecting.
 * The cache key is the descriptor's own, so nothing about invalidation changes.
 */
export function orNullOnNotFound<T>(
  descriptor: EndpointDescriptor<T>
): EndpointDescriptor<T | null> {
  return {
    ...descriptor,
    fetch: (options) =>
      descriptor.fetch(options).catch((error: unknown) => {
        if (isNotFound(error)) return null;
        throw error;
      }),
  };
}
