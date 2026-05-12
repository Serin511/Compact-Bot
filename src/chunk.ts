/**
 * Newline-aware message chunking shared by both MCP servers.
 *
 * Exports:
 *   chunkText — split long text along paragraph / line / space boundaries.
 *
 * Example:
 *   >>> chunkText("para1\n\npara2", 8);
 *   ["para1", "para2"]
 */

/**
 * Split ``text`` into chunks of at most ``maxLen`` characters, preferring
 * paragraph and line boundaries over hard cuts.
 *
 * Order of preferred split points within the first ``maxLen`` window:
 *   1. Last double-newline (paragraph break).
 *   2. Last single newline.
 *   3. Last space.
 *   4. Hard cut at ``maxLen`` when none of the above lands past
 *      ``maxLen / 2`` — falling back to a hard cut earlier would produce
 *      a tiny leading chunk and waste capacity.
 *
 * Args:
 *   text: Source string to split.
 *   maxLen: Maximum chunk length.
 *
 * Returns:
 *   Array of chunks. Leading newlines that fall on a split boundary are
 *   dropped from the start of each subsequent chunk so paragraph breaks
 *   don't get re-emitted.
 */
export function chunkText(text: string, maxLen: number): string[] {
  if (maxLen <= 0) throw new Error(`chunkText: maxLen must be positive, got ${maxLen}`);
  if (text.length <= maxLen) return [text];

  const out: string[] = [];
  let rest = text;
  const half = Math.floor(maxLen / 2);

  while (rest.length > maxLen) {
    const para = rest.lastIndexOf("\n\n", maxLen);
    const line = rest.lastIndexOf("\n", maxLen);
    const space = rest.lastIndexOf(" ", maxLen);

    let cut: number;
    if (para > half) cut = para;
    else if (line > half) cut = line;
    else if (space > half) cut = space;
    else cut = maxLen;

    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, "");
  }
  if (rest.length > 0) out.push(rest);
  return out;
}
