export const MAX_FETCH_MESSAGE_LIMIT = 500;
export const DEFAULT_FETCH_MESSAGE_LIMIT = 20;

/**
 * Bound history reads even when an MCP client bypasses the declared schema.
 *
 * Zero intentionally means the documented maximum. Invalid values fall back
 * to a known-small default instead of creating an unbounded pagination loop.
 */
export function normalizeFetchMessageLimit(
  value: unknown,
  fallback = DEFAULT_FETCH_MESSAGE_LIMIT,
): number {
  const fallbackValue =
    Number.isInteger(fallback) && fallback > 0
      ? Math.min(fallback, MAX_FETCH_MESSAGE_LIMIT)
      : DEFAULT_FETCH_MESSAGE_LIMIT;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < 0) return fallbackValue;
  if (parsed === 0) return MAX_FETCH_MESSAGE_LIMIT;
  return Math.min(parsed, MAX_FETCH_MESSAGE_LIMIT);
}
