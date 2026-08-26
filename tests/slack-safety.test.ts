import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildSlackMrkdwnSections,
  SLACK_INTERACTIVE_SECTION_LIMIT,
  SLACK_MESSAGE_TEXT_LIMIT,
  SLACK_SECTION_TEXT_LIMIT,
  truncateSlackFallbackText,
} from "../src/slack-ui.js";
import { uploadSlackReplyFiles } from "../src/slack-reply.js";
import {
  PendingSlackPermissions,
  type PendingSlackPermission,
} from "../src/slack-permissions.js";

describe("Slack Block Kit size guards", () => {
  it("chunks question and permission detail text into <= 3000-char sections", () => {
    const text = "x".repeat(SLACK_SECTION_TEXT_LIMIT * 2 + 17);
    const sections = buildSlackMrkdwnSections(text);

    expect(sections).toHaveLength(3);
    expect(sections.map((block) => block.text.text).join("")).toBe(text);
    expect(
      sections.every(
        (block) => block.text.text.length <= SLACK_SECTION_TEXT_LIMIT,
      ),
    ).toBe(true);
  });

  it("does not split a surrogate pair at a hard section boundary", () => {
    const text = `${"a".repeat(SLACK_SECTION_TEXT_LIMIT - 1)}😀tail`;
    const chunks = buildSlackMrkdwnSections(text).map(
      (block) => block.text.text,
    );

    expect(chunks.join("")).toBe(text);
    expect(chunks[0]?.endsWith("\uD83D")).toBe(false);
    expect(chunks[1]?.startsWith("\uDE00")).toBe(false);
  });

  it("reserves an actions block and visibly truncates beyond 50 blocks", () => {
    const sections = buildSlackMrkdwnSections(
      "x".repeat(
        SLACK_SECTION_TEXT_LIMIT *
          (SLACK_INTERACTIVE_SECTION_LIMIT + 2),
      ),
    );

    expect(sections).toHaveLength(SLACK_INTERACTIVE_SECTION_LIMIT);
    expect(sections.at(-1)?.text.text).toContain("일부 생략");
    expect(
      sections.every(
        (block) => block.text.text.length <= SLACK_SECTION_TEXT_LIMIT,
      ),
    ).toBe(true);
  });

  it("bounds the fallback text field below Slack's message cap", () => {
    const fallback = truncateSlackFallbackText(
      "x".repeat(SLACK_MESSAGE_TEXT_LIMIT + 100),
    );
    expect(fallback.length).toBeLessThanOrEqual(SLACK_MESSAGE_TEXT_LIMIT);
    expect(fallback).toContain("일부 생략");
  });
});

describe("Slack reply file uploads", () => {
  it("returns isError when filesUploadV2 rejects after text was sent", async () => {
    const upload = vi.fn().mockRejectedValue(new Error("upload denied"));
    const result = await uploadSlackReplyFiles({
      channelId: "C1",
      threadTs: "100.1",
      files: [{ file: "/tmp/result.png", filename: "result.png" }],
      sentTimestamps: ["200.2"],
      upload,
    });

    expect(result).toMatchObject({
      isError: true,
      content: [{
        type: "text",
        text: expect.stringContaining("upload denied"),
      }],
    });
    expect(result?.content[0]?.text).toContain("1 message(s) sent");
  });

  it("returns no error after a successful upload", async () => {
    const upload = vi.fn().mockResolvedValue({});
    await expect(
      uploadSlackReplyFiles({
        channelId: "C1",
        files: [{ file: "/tmp/result.png", filename: "result.png" }],
        sentTimestamps: [],
        upload,
      }),
    ).resolves.toBeNull();
  });
});

describe("pending Slack permission lifetime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function permission(): PendingSlackPermission {
    return {
      tool_name: "Bash",
      description: "run tests",
      input_preview: '{"command":"npm test"}',
      channelId: "C1",
      promptTs: "200.2",
      promptText: ":lock: 권한 요청",
    };
  }

  it("automatically denies at TTL and removes the prompt buttons", async () => {
    vi.useFakeTimers();
    const sendDeny = vi.fn().mockResolvedValue(true);
    const updatePrompt = vi.fn().mockResolvedValue({});
    const pending = new PendingSlackPermissions({
      ttlMs: 1_000,
      sendDeny,
      updatePrompt,
    });

    pending.set("abcde", permission());
    await vi.advanceTimersByTimeAsync(999);
    expect(sendDeny).not.toHaveBeenCalled();
    expect(pending.has("abcde")).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(sendDeny).toHaveBeenCalledOnce();
    expect(sendDeny).toHaveBeenCalledWith("abcde");
    expect(pending.has("abcde")).toBe(false);
    expect(updatePrompt).toHaveBeenCalledWith(expect.objectContaining({
      channel: "C1",
      ts: "200.2",
      text: expect.stringContaining("자동 거부"),
      blocks: [],
    }));
  });

  it("restores a failed manual verdict without extending the deadline", async () => {
    vi.useFakeTimers();
    const sendDeny = vi.fn().mockResolvedValue(true);
    const pending = new PendingSlackPermissions({
      ttlMs: 1_000,
      sendDeny,
      updatePrompt: vi.fn().mockResolvedValue({}),
    });

    pending.set("abcde", permission());
    await vi.advanceTimersByTimeAsync(600);
    const claim = pending.take("abcde");
    expect(claim).toBeDefined();
    expect(pending.restore(claim!)).toBe(true);

    await vi.advanceTimersByTimeAsync(399);
    expect(sendDeny).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(sendDeny).toHaveBeenCalledWith("abcde");
  });

  it("disables stale buttons even if the deny notification cannot be delivered", async () => {
    vi.useFakeTimers();
    const updatePrompt = vi.fn().mockResolvedValue({});
    const pending = new PendingSlackPermissions({
      ttlMs: 1,
      sendDeny: vi.fn().mockResolvedValue(false),
      updatePrompt,
    });

    pending.set("abcde", permission());
    await vi.advanceTimersByTimeAsync(1);

    expect(updatePrompt).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining("전달하지 못했습니다"),
      blocks: [],
    }));
  });
});
