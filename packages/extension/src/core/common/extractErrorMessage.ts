/**
 * Extract a human-readable message from an unknown error value.
 *
 * @param err - The caught error value (may be anything).
 * @returns A string message suitable for logging or user-facing display.
 */
export function extractErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
