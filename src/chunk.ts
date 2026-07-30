/**
 * Newline-aware message chunking shared by both MCP servers.
 *
 * Exports:
 *   chunkText — split long text along paragraph / line / space boundaries.
 *   chunkCodeBlock — split text into independently fenced Markdown code blocks.
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

/**
 * Split text into Markdown code blocks that are each independently renderable.
 *
 * Backtick runs in terminal output are separated with an invisible character
 * so Slack and Discord, which both document triple-backtick fences, cannot
 * mistake captured Markdown for the outer closing fence. ``maxLen`` includes
 * the opening/closing fences.
 */
export function chunkCodeBlock(
  text: string,
  maxLen: number,
  language = "",
): string[] {
  const fence = "```";
  const safeText = text.replace(/```/g, "``\u200b`");
  const safeLanguage = language.replace(/[\r\n`]/g, "");
  const prefix = `${fence}${safeLanguage}\n`;
  const suffix = `\n${fence}`;
  const contentLimit = maxLen - prefix.length - suffix.length;
  if (contentLimit <= 0) {
    throw new Error(
      `chunkCodeBlock: maxLen ${maxLen} is too small for code fences`,
    );
  }
  return chunkText(safeText, contentLimit).map(
    (chunk) => `${prefix}${chunk}${suffix}`,
  );
}
