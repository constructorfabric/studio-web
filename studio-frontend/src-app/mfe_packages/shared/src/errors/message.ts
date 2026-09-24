/**
 * The message of whatever was thrown, for a log line: an `Error`'s own
 * message, anything else stringified.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
