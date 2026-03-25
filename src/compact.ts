/**
 * /compact emulation using the real Claude Code compact prompt.
 *
 * Sends the compact summarization prompt to the existing session,
 * extracts the <summary> content, then creates a new session with
 * the summary injected via --append-system-prompt.
 *
 * Exports:
 *   compactSession.
 *
 * Example:
 *   >>> await compactSession(sessionManager, "channel-123");
 */

import { runClaudeSync } from "./claude-cli.js";
import { COMPACT_PROMPT, systemPrompt } from "./config.js";
import { type SessionManager, type SessionState } from "./session-manager.js";

export interface CompactResult {
  summary: string;
  newSessionId: string;
  previousInputTokens: number;
  previousOutputTokens: number;
  summaryLength: number;
}

/**
 * Perform context compaction on an existing session.
 *
 * Sends the compact prompt to the current session to generate a summary,
 * then creates a new session with the summary injected as system prompt context.
 *
 * Args:
 *   manager: SessionManager instance.
 *   channelId: Discord channel ID.
 *   focusHint: Optional hint to focus the summary on specific topics.
 *
 * Returns:
 *   CompactResult with the summary and new session metadata.
 *
 * Raises:
 *   Error: If no active session exists for the channel.
 */
export async function compactSession(
  manager: SessionManager,
  channelId: string,
  focusHint?: string,
): Promise<CompactResult> {
  const session = manager.get(channelId);
  if (!session) {
    throw new Error("No active session for this channel.");
  }

  let prompt = COMPACT_PROMPT;
  if (focusHint) {
    prompt += `\n\nFocus especially on: ${focusHint}`;
  }

  // 1. Send compact prompt to existing session
  const result = await runClaudeSync({
    prompt,
    resume: session.sessionId,
    cwd: session.cwd,
    model: session.model,
    maxTurns: 1,
  });

  // 2. Extract <summary> tags
  const summaryMatch = result.text.match(/<summary>([\s\S]*?)<\/summary>/);
  const summary = summaryMatch?.[1]?.trim() ?? result.text;

  const previousInputTokens = session.totalInputTokens;
  const previousOutputTokens = session.totalOutputTokens;

  // 3. Create new session with summary injected
  const summaryPrompt = `Previous conversation summary:\n<summary>\n${summary}\n</summary>`;
  const appendPrompt = systemPrompt
    ? `${summaryPrompt}\n\n${systemPrompt}`
    : summaryPrompt;

  const initResult = await runClaudeSync({
    prompt: "Understood. I have the context from the previous conversation summary. Ready to continue.",
    cwd: session.cwd,
    model: session.model,
    appendSystemPrompt: appendPrompt,
    maxTurns: 1,
  });

  const newSessionId = initResult.sessionId;

  // 4. Replace session
  manager.create(channelId, newSessionId, session.cwd, session.model);
  manager.update(channelId, { conversationSummary: summary });

  return {
    summary,
    newSessionId,
    previousInputTokens,
    previousOutputTokens,
    summaryLength: summary.length,
  };
}
