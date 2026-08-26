/**
 * Tests for slack-attachment-handler module.
 *
 * Covers Slack file download with Bearer auth, size limits,
 * missing URLs, and cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  downloadSlackAttachments,
  cleanupSlackAttachments,
  type SlackFile,
} from "../src/slack-attachment-handler.js";

const ATTACHMENTS_DIR = join(
  tmpdir(),
  `compact-bot-slack-attachments-${process.pid}`,
);
const TEN_MB = 10 * 1024 * 1024;

const makeFile = (overrides: Partial<SlackFile> = {}): SlackFile => ({
  id: "F123",
  name: "test.txt",
  mimetype: "text/plain",
  size: 100,
  url_private: "https://files.slack.com/test.txt",
  ...overrides,
});

const downloadTestSlackAttachments = (
  files: SlackFile[],
  messageTs = "1234567890.123456",
  token = "xoxb-test",
) => downloadSlackAttachments(files, messageTs, token, ATTACHMENTS_DIR);

describe("downloadSlackAttachments", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (existsSync(ATTACHMENTS_DIR)) {
      rmSync(ATTACHMENTS_DIR, { recursive: true, force: true });
    }
  });

  it("returns empty result for no files", async () => {
    const result = await downloadTestSlackAttachments([]);
    expect(result.promptPrefix).toBe("");
    expect(result.paths).toEqual([]);
  });

  it("skips files exceeding size limit", async () => {
    const file = makeFile({ size: 11 * 1024 * 1024 });
    const result = await downloadTestSlackAttachments([file]);
    expect(result.promptPrefix).toContain("test.txt");
    expect(result.promptPrefix).toMatch(/10\s*MB|크기 제한/);
    expect(result.paths).toEqual([]);
  });

  it("skips files with no download URL", async () => {
    const file = makeFile({
      url_private: undefined,
      url_private_download: undefined,
    });
    const result = await downloadTestSlackAttachments([file]);
    expect(result.promptPrefix).toContain("test.txt");
    expect(result.promptPrefix).toMatch(/URL/i);
    expect(result.paths).toEqual([]);
  });

  it("downloads file with Bearer auth header", async () => {
    const fileContent = Buffer.from("hello");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(fileContent, { status: 200 }),
    );

    const file = makeFile();
    const result = await downloadTestSlackAttachments(
      [file],
      "1234567890.123456",
      "xoxb-test-token",
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://files.slack.com/test.txt",
      expect.objectContaining({
        headers: { Authorization: "Bearer xoxb-test-token" },
        signal: expect.any(AbortSignal),
      }),
    );
    expect(result.paths.length).toBe(1);
    expect(result.promptPrefix).toContain("첨부 파일:");
  });

  it("labels image files correctly in prompt prefix", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(Buffer.from("png"), { status: 200 }),
    );

    const file = makeFile({ name: "photo.png", mimetype: "image/png" });
    const result = await downloadTestSlackAttachments(
      [file],
      "1234567890.123456",
      "xoxb-test",
    );

    expect(result.promptPrefix).toContain("첨부 이미지:");
  });

  it("stores path-like uploader filenames inside the message directory", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(Buffer.from("safe"), { status: 200 }),
    );

    const result = await downloadTestSlackAttachments(
      [makeFile({ name: "../../../escaped.txt" })],
      "1234567890.123456",
      "xoxb-test",
    );
    const expectedRoot =
      join(ATTACHMENTS_DIR, "slack-1234567890-123456") + sep;

    expect(result.paths).toHaveLength(1);
    expect(result.paths[0]?.startsWith(expectedRoot)).toBe(true);
    expect(result.paths[0]).toContain(".._.._.._escaped.txt");
  });

  it("handles download failure gracefully", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 403 }),
    );

    const file = makeFile();
    const result = await downloadTestSlackAttachments(
      [file],
      "1234567890.123456",
      "xoxb-test",
    );

    expect(result.promptPrefix).toContain("다운로드 실패");
    expect(result.paths).toEqual([]);
  });

  it("prefers url_private_download over url_private", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(Buffer.from("data"), { status: 200 }),
    );

    const file = makeFile({
      url_private: "https://files.slack.com/private",
      url_private_download: "https://files.slack.com/download",
    });
    await downloadTestSlackAttachments([file]);

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://files.slack.com/download",
      expect.any(Object),
    );
  });

  it("enforces the aggregate download limit for one message", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(Buffer.alloc(TEN_MB), { status: 200 }),
    );
    const files = Array.from({ length: 6 }, (_, index) =>
      makeFile({
        id: `F${index}`,
        name: `part-${index}.bin`,
        size: TEN_MB,
        url_private: `https://files.slack.com/part-${index}.bin`,
      }),
    );

    const result = await downloadTestSlackAttachments(files);

    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect(result.paths).toHaveLength(5);
    expect(result.promptPrefix).toContain("총 다운로드 제한(50MB)");
    expect(result.promptPrefix).toContain("part-5.bin");
  });
});

describe("cleanupSlackAttachments", () => {
  it("does not throw when directory does not exist", () => {
    expect(() =>
      cleanupSlackAttachments("nonexistent.ts", ATTACHMENTS_DIR)
    ).not.toThrow();
  });
});
