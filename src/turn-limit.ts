/**
 * Parse Claude Code's optional turn limit.
 *
 * Zero explicitly means unlimited. Every other accepted value must be a
 * positive safe integer so a typo cannot silently disable the limit or pass an
 * unsupported fractional value to the Claude CLI.
 */
export function parseMaxTurns(value: string): number | null {
  const normalized = value.trim();
  if (!/^(0|[1-9]\d*)$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}
