/**
 * Detect interactive user prompts from Claude Code's terminal output.
 *
 * Analyzes the virtual terminal screen buffer to identify when Claude Code
 * is asking the user a question and waiting for input. Supports multiple
 * detection patterns: Ink-style prompts, input cursors, and known phrases.
 *
 * Exports:
 *   detectUserPrompt — analyze screen text and return detected question or null.
 */

/**
 * Substrings that mark a prompt as off-limits for channel relay.
 *
 * The MCP Channel spec (code.claude.com/docs/en/channels-reference)
 * states: "Project trust and MCP server consent dialogs don't relay;
 * those only appear in the local terminal." We extend that rule to
 * any tool-permission or auth prompt — a remote user answering a
 * Bash / Write / MCP consent prompt via chat sidesteps the local
 * dialog and bypasses the audit trail. When any keyword below
 * appears in the detected text, we refuse to surface it to chat.
 */
const SECURITY_PROMPT_MARKERS = [
  "trust this folder",
  "trust this project",
  "trust this workspace",
  "mcp server",
  "mcp config",
  "permission to run",
  "allow this tool",
  "bash command",
  "run this command",
  "edit this file",
  "write to this file",
  "dangerously",
  "api key",
  "login",
  "authenticate",
];

function containsSecurityMarker(text: string): boolean {
  const lower = text.toLowerCase();
  return SECURITY_PROMPT_MARKERS.some((m) => lower.includes(m));
}

/**
 * Detect whether the terminal screen shows an interactive user prompt.
 *
 * Claude Code's Ink UI renders user-facing questions with a text input
 * area at the bottom of the screen. We detect this by looking for common
 * patterns: question marks, input cursors, selection markers, and known
 * prompt phrases that appear when Claude asks the user something.
 *
 * Any prompt containing security-sensitive keywords is suppressed —
 * see SECURITY_PROMPT_MARKERS for the rationale.
 *
 * Args:
 *   screenText: Plain text content of the terminal screen buffer.
 *
 * Returns:
 *   The detected question text, or null if no prompt found or the
 *   prompt looks security-sensitive.
 */
export function detectUserPrompt(screenText: string): string | null {
  const result = detectUserPromptRaw(screenText);
  if (result === null) return null;
  if (containsSecurityMarker(result)) return null;
  // Also check the surrounding screen — a Bash approval might render
  // the command on a separate line above the detected question.
  if (containsSecurityMarker(screenText)) return null;
  return result;
}

function detectUserPromptRaw(screenText: string): string | null {
  const lines = screenText.split("\n").map((l) => l.trimEnd());

  // Skip empty screens or screens still loading
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length < 2) return null;

  // Pattern 1: Ink-style question prompt — line starting with "?"
  // e.g. "? Do you want to proceed with this change?"
  const questionLineIdx = lines.findIndex((l) => /^\s*\?\s+\S/.test(l));
  if (questionLineIdx >= 0) {
    const questionLines = [lines[questionLineIdx].replace(/^\s*\?\s*/, "").trim()];
    for (let i = questionLineIdx + 1; i < lines.length; i++) {
      const l = lines[i].trim();
      if (!l) break;
      questionLines.push(l);
    }
    return questionLines.join("\n");
  }

  // Pattern 2: "Type your answer" / "Enter your response" style prompts
  const inputPromptIdx = lines.findIndex((l) =>
    /(?:type\s+your|enter\s+your|your\s+(?:answer|response|input|choice))/i.test(l),
  );
  if (inputPromptIdx >= 0) {
    let start = inputPromptIdx;
    for (let i = inputPromptIdx - 1; i >= 0; i--) {
      if (lines[i].trim() === "") break;
      start = i;
    }
    return lines
      .slice(start, inputPromptIdx + 1)
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");
  }

  // Pattern 3: Screen ends with "> " or "❯ " input cursor (last non-empty line)
  const lastNonEmpty = nonEmpty[nonEmpty.length - 1];
  if (/^[>❯]\s*$/.test(lastNonEmpty.trim())) {
    const lastIdx = lines.lastIndexOf(lastNonEmpty);
    let start = lastIdx;
    for (let i = lastIdx - 1; i >= 0; i--) {
      if (lines[i].trim() === "") break;
      start = i;
    }
    const block = lines
      .slice(start, lastIdx + 1)
      .map((l) => l.trim())
      .filter(Boolean)
      .join("\n");
    if (block.length > 2) return block;
  }

  // Pattern 4: Known Claude Code question phrases
  const knownPhrases = [
    "has a question",
    "wants to ask",
    "would like to know",
    "please select",
    "please choose",
    "which option",
    "선택해",
    "답변해",
    "입력해",
  ];
  for (const phrase of knownPhrases) {
    const idx = lines.findIndex((l) => l.toLowerCase().includes(phrase));
    if (idx >= 0) {
      let end = idx + 1;
      for (let i = idx + 1; i < lines.length; i++) {
        if (lines[i].trim() === "") break;
        end = i + 1;
      }
      return lines
        .slice(idx, end)
        .map((l) => l.trim())
        .filter(Boolean)
        .join("\n");
    }
  }

  return null;
}
