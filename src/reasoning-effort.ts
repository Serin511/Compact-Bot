/**
 * Reasoning-effort values understood by current Codex app-server models.
 *
 * Individual models expose a subset through `model/list`; the shared list is
 * used for command syntax validation before model-specific validation.
 */

export const KNOWN_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type ReasoningEffort = (typeof KNOWN_REASONING_EFFORTS)[number];

export function normalizeReasoningEffort(
  value: string,
): ReasoningEffort | null {
  const normalized = value.trim().toLowerCase();
  return (KNOWN_REASONING_EFFORTS as readonly string[]).includes(normalized)
    ? (normalized as ReasoningEffort)
    : null;
}
