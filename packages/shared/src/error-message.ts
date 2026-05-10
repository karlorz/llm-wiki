/**
 * Extract a human-readable message from a caught value.
 * Handles both Error instances and non-Error throws (strings, numbers, etc.).
 */
export function getErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
