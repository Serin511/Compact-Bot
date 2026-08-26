/**
 * Slack Block Kit size guards.
 *
 * A section block accepts at most 3,000 characters and a message accepts at
 * most 50 blocks. Interactive messages reserve one block for their actions,
 * so long question and permission-detail bodies are split across at most 49
 * mrkdwn sections.
 */

import { chunkText } from "./chunk.js";

export const SLACK_SECTION_TEXT_LIMIT = 3_000;
export const SLACK_MESSAGE_TEXT_LIMIT = 39_000;
export const SLACK_INTERACTIVE_SECTION_LIMIT = 49;

export type SlackMrkdwnSectionBlock = {
  type: "section";
  text: {
    type: "mrkdwn";
    text: string;
  };
};

const OMITTED_TEXT = "\n\n… _(Slack 표시 한도로 일부 생략)_";

function safeCut(text: string, maxLength: number): string {
  let end = Math.min(text.length, maxLength);
  if (
    end > 0 &&
    end < text.length &&
    /[\uD800-\uDBFF]/.test(text[end - 1]!) &&
    /[\uDC00-\uDFFF]/.test(text[end]!)
  ) {
    end -= 1;
  }
  return text.slice(0, end);
}

function repairSurrogateBoundaries(
  chunks: string[],
  maxLength: number,
): string[] {
  const repaired: string[] = [];
  let carry = "";

  for (let index = 0; index < chunks.length; index++) {
    let current = carry + chunks[index]!;
    carry = "";

    while (current.length > maxLength) {
      const prefix = safeCut(current, maxLength);
      repaired.push(prefix);
      current = current.slice(prefix.length);
    }

    const next = chunks[index + 1];
    if (
      next &&
      /[\uD800-\uDBFF]/.test(current.at(-1) ?? "") &&
      /[\uDC00-\uDFFF]/.test(next[0] ?? "")
    ) {
      carry = current.slice(-1);
      current = current.slice(0, -1);
    }
    if (current) repaired.push(current);
  }
  if (carry) repaired.push(carry);
  return repaired;
}

/**
 * Split text into Slack-safe mrkdwn section blocks.
 *
 * ``maxBlocks`` defaults to 49 so callers can append one actions block
 * without exceeding Slack's 50-block message limit. Extremely large input is
 * visibly truncated rather than producing an API-invalid payload.
 */
export function buildSlackMrkdwnSections(
  text: string,
  maxBlocks = SLACK_INTERACTIVE_SECTION_LIMIT,
): SlackMrkdwnSectionBlock[] {
  if (maxBlocks <= 0) {
    throw new Error(`buildSlackMrkdwnSections: maxBlocks must be positive`);
  }

  const chunks = repairSurrogateBoundaries(
    chunkText(text || "\u200b", SLACK_SECTION_TEXT_LIMIT),
    SLACK_SECTION_TEXT_LIMIT,
  );
  const bounded = chunks.slice(0, maxBlocks);
  if (chunks.length > maxBlocks) {
    bounded[maxBlocks - 1] =
      safeCut(
        bounded[maxBlocks - 1]!,
        SLACK_SECTION_TEXT_LIMIT - OMITTED_TEXT.length,
      ) + OMITTED_TEXT;
  }

  return bounded.map((chunk) => ({
    type: "section" as const,
    text: {
      type: "mrkdwn" as const,
      text: chunk,
    },
  }));
}

/** Bound the accessibility/fallback ``text`` field below Slack's 40k cap. */
export function truncateSlackFallbackText(text: string): string {
  if (text.length <= SLACK_MESSAGE_TEXT_LIMIT) return text;
  return (
    safeCut(
      text,
      SLACK_MESSAGE_TEXT_LIMIT - OMITTED_TEXT.length,
    ) + OMITTED_TEXT
  );
}
