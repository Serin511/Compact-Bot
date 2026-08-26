import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findClaudeHookOrigin } from "../src/claude-transcript-origin.js";

const temporaryPaths: string[] = [];

function transcript(records: unknown[]): string {
  return transcriptText(records.map((record) => JSON.stringify(record)).join("\n"));
}

function transcriptText(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "compact-bot-transcript-"));
  temporaryPaths.push(dir);
  const path = join(dir, "session.jsonl");
  writeFileSync(path, contents);
  return path;
}

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("findClaudeHookOrigin", () => {
  it("follows the exact tool parent chain instead of the latest channel row", () => {
    const path = transcript([
      {
        type: "user",
        uuid: "channel-a",
        parentUuid: null,
        origin: { kind: "channel", server: "slack-bot" },
        message: {
          content:
            '<channel source="slack-bot" chat_id="CA" message_id="1" user_id="UA" ts="2026-07-30T00:00:00Z" thread_ts="0.5">\nA\n</channel>',
        },
      },
      {
        type: "assistant",
        uuid: "thinking-a",
        parentUuid: "channel-a",
        message: { content: [{ type: "thinking", text: "..." }] },
      },
      {
        type: "assistant",
        uuid: "ask-a",
        parentUuid: "thinking-a",
        message: {
          content: [{
            type: "tool_use",
            id: "tool-a",
            name: "AskUserQuestion",
          }],
        },
      },
      {
        type: "user",
        uuid: "channel-b",
        parentUuid: "ask-a",
        origin: { kind: "channel", server: "discord-bot" },
        message: {
          content:
            '<channel source="discord-bot" chat_id="CB" message_id="2" user_id="UB">\nB\n</channel>',
        },
      },
    ]);

    expect(findClaudeHookOrigin(path, "tool-a")).toEqual({
      source: "slack",
      chat_id: "CA",
      message_id: "1",
      user: "UA",
      ts: "2026-07-30T00:00:00Z",
      thread_ts: "0.5",
    });
  });

  it("decodes channel attributes and supports Discord ancestry", () => {
    const path = transcript([
      {
        type: "user",
        uuid: "channel",
        origin: { kind: "channel", server: "discord-bot" },
        message: {
          content:
            '<channel source="discord-bot" chat_id="C&amp;1" message_id="M&quot;2" user_id="U3">\nquestion\n</channel>',
        },
      },
      {
        type: "assistant",
        uuid: "ask",
        parentUuid: "channel",
        message: {
          content: [{ type: "tool_use", id: "tool", name: "AskUserQuestion" }],
        },
      },
    ]);

    expect(findClaudeHookOrigin(path, "tool")).toEqual({
      source: "discord",
      chat_id: "C&1",
      message_id: 'M"2',
      user: "U3",
    });
  });

  it("fails closed for missing or malformed transcripts", () => {
    expect(findClaudeHookOrigin("/does/not/exist", "tool")).toBeNull();
    expect(findClaudeHookOrigin(undefined, "tool")).toBeNull();
    const path = transcript([{ not: "jsonl origin data" }]);
    expect(findClaudeHookOrigin(path, "tool")).toBeNull();

    const malformedOnAncestry = transcriptText([
      "{not-valid-json",
      JSON.stringify({
        type: "assistant",
        uuid: "ask",
        parentUuid: "channel",
        message: {
          content: [{ type: "tool_use", id: "tool", name: "AskUserQuestion" }],
        },
      }),
    ].join("\n"));
    expect(findClaudeHookOrigin(malformedOnAncestry, "tool")).toBeNull();

    const malformedTail = transcriptText([
      JSON.stringify({
        type: "assistant",
        uuid: "ask",
        message: {
          content: [{ type: "tool_use", id: "tool", name: "AskUserQuestion" }],
        },
      }),
      "{not-valid-json",
    ].join("\n"));
    expect(findClaudeHookOrigin(malformedTail, "tool")).toBeNull();
  });

  it("handles UTF-8 and CRLF records split across read chunk boundaries", () => {
    const openingTag =
      '<channel source="discord-bot" chat_id="C1" message_id="M1">';
    const makeChannel = (padding: string) => JSON.stringify({
      type: "user",
      uuid: "channel",
      origin: { kind: "channel", server: "discord-bot" },
      message: {
        content: `${openingTag}${padding}가\nquestion\n</channel>`,
      },
    });
    const markerOffset = Buffer.from(makeChannel("")).indexOf(
      Buffer.from("가"),
    );
    const paddingLength = (64 * 1024 - 1 - markerOffset + 64 * 1024) %
      (64 * 1024);
    const channelLine = makeChannel("x".repeat(paddingLength));
    expect(Buffer.from(channelLine).indexOf(Buffer.from("가"))).toBe(
      64 * 1024 - 1,
    );

    const toolLine = JSON.stringify({
      type: "assistant",
      uuid: "ask",
      parentUuid: "channel",
      message: {
        content: [{ type: "tool_use", id: "tool", name: "AskUserQuestion" }],
      },
    });
    const path = transcriptText(`${channelLine}\r\n${toolLine}\r\n`);

    expect(findClaudeHookOrigin(path, "tool")).toEqual({
      source: "discord",
      chat_id: "C1",
      message_id: "M1",
    });
  });

  it("resolves from the tail without parsing a large unrelated history", () => {
    const fillerLine = JSON.stringify({
      type: "assistant",
      message: { content: "x".repeat(1024) },
    });
    const channelLine = JSON.stringify({
      type: "user",
      uuid: "channel",
      origin: { kind: "channel", server: "slack-bot" },
      message: {
        content:
          '<channel source="slack-bot" chat_id="CLARGE" message_id="MLARGE">\nquestion\n</channel>',
      },
    });
    const toolLine = JSON.stringify({
      type: "assistant",
      uuid: "ask",
      parentUuid: "channel",
      message: {
        content: [{
          type: "tool_use",
          id: "large-tool",
          name: "AskUserQuestion",
        }],
      },
    });
    const path = transcriptText(
      `{malformed-old-history\n${
        Array(24_000).fill(fillerLine).join("\n")
      }\n${channelLine}\n${toolLine}`,
    );

    const startedAt = performance.now();
    expect(findClaudeHookOrigin(path, "large-tool")).toEqual({
      source: "slack",
      chat_id: "CLARGE",
      message_id: "MLARGE",
    });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("fails safely within the hook deadline when ancestry is too old", () => {
    const channelLine = JSON.stringify({
      type: "user",
      uuid: "channel",
      origin: { kind: "channel", server: "slack-bot" },
      message: {
        content:
          '<channel source="slack-bot" chat_id="COLD" message_id="MOLD">\nquestion\n</channel>',
      },
    });
    const fillerLine = JSON.stringify({
      type: "assistant",
      message: { content: "x".repeat(32 * 1024) },
    });
    const toolLine = JSON.stringify({
      type: "assistant",
      uuid: "ask",
      parentUuid: "channel",
      message: {
        content: [{
          type: "tool_use",
          id: "old-parent-tool",
          name: "AskUserQuestion",
        }],
      },
    });
    // More than the implementation's bounded 16 MiB reverse lookback.
    const path = transcriptText(
      `${channelLine}\n${
        Array(530).fill(fillerLine).join("\n")
      }\n${toolLine}`,
    );

    const startedAt = performance.now();
    expect(findClaudeHookOrigin(path, "old-parent-tool")).toBeNull();
    expect(performance.now() - startedAt).toBeLessThan(2_500);
  });

  it("terminates on cyclic parent chains without using an unrelated origin", () => {
    const path = transcript([
      {
        type: "user",
        uuid: "unrelated",
        origin: { kind: "channel", server: "slack-bot" },
        message: {
          content:
            '<channel source="slack-bot" chat_id="OTHER" message_id="OTHER">\nother\n</channel>',
        },
      },
      {
        type: "assistant",
        uuid: "a",
        parentUuid: "b",
        message: { content: [{ type: "thinking", text: "a" }] },
      },
      {
        type: "assistant",
        uuid: "b",
        parentUuid: "a",
        message: { content: [{ type: "thinking", text: "b" }] },
      },
      {
        type: "assistant",
        uuid: "ask",
        parentUuid: "a",
        message: {
          content: [{ type: "tool_use", id: "tool", name: "AskUserQuestion" }],
        },
      },
    ]);

    expect(findClaudeHookOrigin(path, "tool")).toBeNull();
  });
});
