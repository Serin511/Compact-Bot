/**
 * Recover the channel origin that causally precedes a Claude Code hook.
 *
 * Channel notifications are persisted as user records in Claude's JSONL
 * transcript. PreToolUse hooks include both that transcript path and the
 * current tool-use ID, which lets us follow the exact parent chain instead of
 * guessing from whichever Slack/Discord message arrived most recently.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { IpcOrigin } from "./ipc.js";

const TRANSCRIPT_READ_CHUNK_BYTES = 64 * 1024;
/**
 * PreToolUse hooks have a short execution deadline. The channel message and
 * its AskUserQuestion tool call should be adjacent in an append-only
 * transcript, so looking through an unbounded session history is both
 * unnecessary and dangerous for hook latency.
 */
const MAX_TRANSCRIPT_LOOKBACK_BYTES = 16 * 1024 * 1024;
const MAX_TRANSCRIPT_LINE_BYTES = 8 * 1024 * 1024;
const MAX_TRANSCRIPT_RECORDS = 50_000;

interface TranscriptRecord {
  uuid?: string;
  parentUuid?: string | null;
  type?: string;
  origin?: {
    kind?: string;
    server?: string;
  };
  message?: {
    content?: unknown;
  };
}

function decodeXmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function parseChannelOrigin(record: TranscriptRecord): IpcOrigin | null {
  if (
    record.type !== "user" ||
    record.origin?.kind !== "channel" ||
    typeof record.message?.content !== "string"
  ) {
    return null;
  }

  const openingTag = /^<channel\s+([^>\n]+)>/.exec(record.message.content);
  if (!openingTag) return null;
  const attributes = new Map<string, string>();
  for (const match of openingTag[1].matchAll(
    /([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"/g,
  )) {
    attributes.set(match[1], decodeXmlAttribute(match[2]));
  }

  const rawSource =
    attributes.get("source") ?? record.origin.server ?? "";
  const source = rawSource.toLowerCase().includes("slack")
    ? "slack"
    : rawSource.toLowerCase().includes("discord")
      ? "discord"
      : null;
  const chatId = attributes.get("chat_id");
  const messageId = attributes.get("message_id");
  if (!source || !chatId || !messageId) return null;

  return {
    source,
    chat_id: chatId,
    message_id: messageId,
    ...(attributes.get("user_id")
      ? { user: attributes.get("user_id") }
      : {}),
    ...(attributes.get("ts") ? { ts: attributes.get("ts") } : {}),
    ...(source === "slack" && attributes.get("thread_ts")
      ? { thread_ts: attributes.get("thread_ts") }
      : {}),
  };
}

function containsToolUse(
  record: TranscriptRecord,
  toolUseId: string,
): boolean {
  const content = record.message?.content;
  return Array.isArray(content) &&
    content.some(
      (block) =>
        block !== null &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "tool_use" &&
        (block as Record<string, unknown>).id === toolUseId,
    );
}

type ReverseScanControl = "continue" | "stop";

function parseTranscriptLine(line: Buffer): TranscriptRecord | null {
  if (line.length > 0 && line[line.length - 1] === 0x0d) {
    line = line.subarray(0, line.length - 1);
  }
  if (line.length === 0) return null;
  if (line.length > MAX_TRANSCRIPT_LINE_BYTES) {
    throw new Error("Transcript row exceeds the hook scan limit");
  }

  const parsed = JSON.parse(line.toString("utf8")) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Transcript row must be a JSON object");
  }
  return parsed as TranscriptRecord;
}

/**
 * Scan the recent tail of an append-only JSONL transcript from newest to
 * oldest.
 *
 * Newlines are located as raw bytes, which is safe for UTF-8 because the ASCII
 * newline byte cannot occur inside a multibyte code point. Only the current
 * row crosses chunk boundaries, keeping memory proportional to one bounded
 * row rather than the full transcript. The lookback bound makes hook latency
 * independent of a long session's total transcript size.
 */
function scanTranscriptBackwards(
  transcriptPath: string,
  onRecord: (record: TranscriptRecord) => ReverseScanControl,
): void {
  const fd = openSync(transcriptPath, "r");

  try {
    const fileSize = fstatSync(fd).size;
    const scanStart = Math.max(
      0,
      fileSize - MAX_TRANSCRIPT_LOOKBACK_BYTES,
    );
    let startsAtLineBoundary = scanStart === 0;
    if (scanStart > 0) {
      const previousByte = Buffer.allocUnsafe(1);
      startsAtLineBoundary =
        readSync(fd, previousByte, 0, 1, scanStart - 1) === 1 &&
        previousByte[0] === 0x0a;
    }

    const buffer = Buffer.allocUnsafe(TRANSCRIPT_READ_CHUNK_BYTES);
    let position = fileSize;
    let laterFragments: Buffer[] = [];
    let laterFragmentsBytes = 0;
    let parsedRecords = 0;

    const emitLine = (earlierFragment: Buffer): boolean => {
      const lineLength = earlierFragment.length + laterFragmentsBytes;
      if (lineLength > MAX_TRANSCRIPT_LINE_BYTES) {
        throw new Error("Transcript row exceeds the hook scan limit");
      }
      const line = laterFragments.length === 0
        ? earlierFragment
        : Buffer.concat([earlierFragment, ...laterFragments], lineLength);
      laterFragments = [];
      laterFragmentsBytes = 0;
      const record = parseTranscriptLine(line);
      if (record === null) return false;
      parsedRecords += 1;
      if (parsedRecords > MAX_TRANSCRIPT_RECORDS) {
        throw new Error("Transcript record count exceeds the hook scan limit");
      }
      return onRecord(record) === "stop";
    };

    while (position > scanStart) {
      const readStart = Math.max(
        scanStart,
        position - TRANSCRIPT_READ_CHUNK_BYTES,
      );
      const requested = position - readStart;
      const bytesRead = readSync(fd, buffer, 0, requested, readStart);
      if (bytesRead !== requested) {
        throw new Error("Transcript changed while scanning");
      }

      let lineEnd = bytesRead;
      for (let index = bytesRead - 1; index >= 0; index -= 1) {
        if (buffer[index] !== 0x0a) continue;
        if (emitLine(buffer.subarray(index + 1, lineEnd))) return;
        lineEnd = index;
      }

      const earlierFragment = buffer.subarray(0, lineEnd);
      const combinedLength = earlierFragment.length + laterFragmentsBytes;
      if (combinedLength > MAX_TRANSCRIPT_LINE_BYTES) {
        throw new Error("Transcript row exceeds the hook scan limit");
      }
      if (earlierFragment.length > 0) {
        laterFragments.unshift(Buffer.from(earlierFragment));
        laterFragmentsBytes = combinedLength;
      }
      position = readStart;
    }

    // A bounded scan may begin in the middle of an old row. Never parse that
    // partial JSON as if it were a complete record.
    if (laterFragmentsBytes > 0 && startsAtLineBoundary) {
      emitLine(Buffer.alloc(0));
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Find the nearest channel-origin user record on one tool call's parent chain.
 *
 * Returns null for missing, malformed, non-channel, or already-rotated
 * transcripts. Hooks treat that as a compatibility fallback and let the
 * wrapper use its short-lived realtime origin tracker.
 */
export function findClaudeHookOrigin(
  transcriptPath: string | undefined,
  toolUseId: string | undefined,
): IpcOrigin | null {
  if (!transcriptPath || !toolUseId) return null;

  let foundTool = false;
  let wantedParentUuid: string | null = null;
  let resolvedOrigin: IpcOrigin | null = null;
  const visited = new Set<string>();
  try {
    scanTranscriptBackwards(transcriptPath, (record) => {
      if (!foundTool) {
        if (!containsToolUse(record, toolUseId)) return "continue";
        foundTool = true;
        const origin = parseChannelOrigin(record);
        if (origin) {
          resolvedOrigin = origin;
          return "stop";
        }
        wantedParentUuid = record.parentUuid ?? null;
        if (!wantedParentUuid) return "stop";
        visited.add(wantedParentUuid);
        return "continue";
      }

      if (!wantedParentUuid || record.uuid !== wantedParentUuid) {
        return "continue";
      }

      const origin = parseChannelOrigin(record);
      if (origin) {
        resolvedOrigin = origin;
        return "stop";
      }

      const parentUuid = record.parentUuid ?? null;
      if (!parentUuid || visited.has(parentUuid)) {
        wantedParentUuid = null;
        return "stop";
      }
      visited.add(parentUuid);
      wantedParentUuid = parentUuid;
      return "continue";
    });
  } catch {
    return null;
  }

  return resolvedOrigin;
}
