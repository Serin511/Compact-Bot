/**
 * Tests for slack-attachment-handler module.
 *
 * Covers Slack file download with Bearer auth, size limits,
 * missing URLs, and cleanup.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  downloadSlackAttachments,
  cleanupSlackAttachments,
  type SlackFile,
} from "../src/slack-attachment-handler.js";

const ATTACHMENTS_DIR = resolve(process.cwd(), "data", "attachments");

const makeFile = (overrides: Partial<SlackFile> = {}): SlackFile => ({
  id: "F123",
  name: "test.txt",
  mimetype: "text/plain",
  size: 100,
  url_private: "https://files.slack.com/test.txt",
  ...overrides,
});

describe("downloadSlackAttachments", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    // Clean up any test directories
    const dir = join(ATTACHMENTS_DIR, "slack-1234567890-123456");
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty result for no files", async () => {
    const result = await downloadSlackAttachments([], "1234567890.123456", "xoxb-test");
    expect(result.promptPrefix).toBe("");
    expect(result.paths).toEqual([]);
  });

  it("skips files exceeding size limit", async () => {
    const file = makeFile({ size: 11 * 1024 * 1024 });
    const result = await downloadSlackAttachments([file], "1234567890.123456", "xoxb-test");
    expect(result.promptPrefix).toContain("test.txt");
    expect(result.promptPrefix).toMatch(/10\s*MB|크기 제한/);
    expect(result.paths).toEqual([]);
  });

  it("skips files with no download URL", async () => {
    const file = makeFile({
      url_private: undefined,
      url_private_download: undefined,
    });
    const result = await downloadSlackAttachments([file], "1234567890.123456", "xoxb-test");
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
    const result = await downloadSlackAttachments(
      [file],
      "1234567890.123456",
      "xoxb-test-token",
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://files.slack.com/test.txt",
      { headers: { Authorization: "Bearer xoxb-test-token" } },
    );
    expect(result.paths.length).toBe(1);
    expect(result.promptPrefix).toContain("첨부 파일:");
  });

  it("labels image files correctly in prompt prefix", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(Buffer.from("png"), { status: 200 }),
    );

    const file = makeFile({ name: "photo.png", mimetype: "image/png" });
    const result = await downloadSlackAttachments(
      [file],
      "1234567890.123456",
      "xoxb-test",
    );

    expect(result.promptPrefix).toContain("첨부 이미지:");
  });

  it("handles download failure gracefully", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 403 }),
    );

    const file = makeFile();
    const result = await downloadSlackAttachments(
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
    await downloadSlackAttachments([file], "1234567890.123456", "xoxb-test");

    expect(fetchSpy).toHaveBeenCalledWith(
      "https://files.slack.com/download",
      expect.any(Object),
    );
  });
});

describe("cleanupSlackAttachments", () => {
  it("does not throw when directory does not exist", () => {
    expect(() => cleanupSlackAttachments("nonexistent.ts")).not.toThrow();
  });
});
