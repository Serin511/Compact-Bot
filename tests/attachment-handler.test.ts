/**
 * Tests for attachment-handler module (Discord).
 *
 * Covers Discord attachment download, size limits, image/file labelling,
 * graceful failure handling, and cleanup. Discord attachments are fetched
 * from a public CDN, so no auth header is involved (unlike Slack).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { Message } from "discord.js";
import {
  downloadAttachments,
  cleanupAttachments,
} from "../src/attachment-handler.js";

const ATTACHMENTS_DIR = join(
  tmpdir(),
  `compact-bot-discord-attachments-${process.pid}`,
);
const TEST_MESSAGE_ID = "msg-test-attachment-handler";
const TEN_MB = 10 * 1024 * 1024;

interface FakeAttachment {
  id: string;
  name: string;
  size: number;
  url: string;
  contentType: string | null;
}

const makeAttachment = (
  overrides: Partial<FakeAttachment> = {},
): FakeAttachment => ({
  id: "A123",
  name: "test.txt",
  size: 100,
  url: "https://cdn.discordapp.com/test.txt",
  contentType: "text/plain",
  ...overrides,
});

/** Build a minimal Message stub carrying the given attachments. */
const makeMessage = (attachments: FakeAttachment[]): Message =>
  ({
    id: TEST_MESSAGE_ID,
    attachments: new Map(attachments.map((a) => [a.id, a])),
  }) as unknown as Message;

const downloadTestAttachments = (message: Message) =>
  downloadAttachments(message, ATTACHMENTS_DIR);

describe("downloadAttachments", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(ATTACHMENTS_DIR)) {
      rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
    }
  });

  it("returns empty result for a message with no attachments", async () => {
    const result = await downloadTestAttachments(makeMessage([]));
    expect(result.promptPrefix).toBe("");
    expect(result.paths).toEqual([]);
    expect(result.metadata).toEqual([]);
  });

  it("skips files exceeding the size limit", async () => {
    const att = makeAttachment({ size: 11 * 1024 * 1024 });
    const result = await downloadTestAttachments(makeMessage([att]));
    expect(result.promptPrefix).toContain("test.txt");
    expect(result.promptPrefix).toMatch(/10\s*MB|크기 제한/);
    expect(result.paths).toEqual([]);
  });

  it("downloads a file and labels it as a generic attachment", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(Buffer.from("hello"), { status: 200 }),
    );

    const result = await downloadTestAttachments(makeMessage([makeAttachment()]));

    expect(result.paths.length).toBe(1);
    expect(result.promptPrefix).toContain("첨부 파일:");
    expect(result.metadata[0]?.name).toBe("test.txt");
  });

  it("labels image files correctly in the prompt prefix", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(Buffer.from("png"), { status: 200 }),
    );

    const att = makeAttachment({ name: "photo.png", contentType: "image/png" });
    const result = await downloadTestAttachments(makeMessage([att]));

    expect(result.promptPrefix).toContain("첨부 이미지:");
  });

  it("stores path-like uploader filenames inside the message directory", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(Buffer.from("safe"), { status: 200 }),
    );

    const result = await downloadTestAttachments(
      makeMessage([makeAttachment({ name: "../../../escaped.txt" })]),
    );
    const expectedRoot = join(ATTACHMENTS_DIR, TEST_MESSAGE_ID) + sep;

    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]?.startsWith(expectedRoot)).toBe(true);
    expect(result.paths[0]).toContain(".._.._.._escaped.txt");
  });

  it("handles download failure gracefully", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 404 }),
    );

    const result = await downloadTestAttachments(makeMessage([makeAttachment()]));

    expect(result.promptPrefix).toContain("다운로드 실패");
    expect(result.paths).toEqual([]);
  });

  it("enforces the aggregate download limit for one message", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(Buffer.alloc(TEN_MB), { status: 200 }),
    );
    const attachments = Array.from({ length: 6 }, (_, index) =>
      makeAttachment({
        id: `A${index}`,
        name: `part-${index}.bin`,
        size: TEN_MB,
        url: `https://cdn.discordapp.com/part-${index}.bin`,
      }),
    );

    const result = await downloadTestAttachments(makeMessage(attachments));

    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(result.paths).toHaveLength(5);
    expect(result.promptPrefix).toContain("총 다운로드 제한(50MB)");
    expect(result.promptPrefix).toContain("part-5.bin");
  });
});

describe("cleanupAttachments", () => {
  it("does not throw when the directory does not exist", () => {
    expect(() =>
      cleanupAttachments("nonexistent-message-id", ATTACHMENTS_DIR)
    ).not.toThrow();
  });
});
