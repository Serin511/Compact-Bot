import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DISCORD_PERMISSION_TTL_MS,
  PendingDiscordPermissions,
  type DiscordPermissionPrompt,
  type PendingDiscordPermission,
} from "../src/discord-permissions.js";

describe("pending Discord permission lifetime", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function permission(
    edit = vi.fn().mockResolvedValue({}),
  ): PendingDiscordPermission {
    const promptMessage: DiscordPermissionPrompt = {
      content: "🔐 권한 요청: Bash",
      edit,
    };
    return {
      tool_name: "Bash",
      description: "run tests",
      input_preview: '{"command":"npm test"}',
      promptMessage,
    };
  }

  it("defaults to a five-minute TTL", async () => {
    vi.useFakeTimers();
    const sendDeny = vi.fn().mockResolvedValue(true);
    const pending = new PendingDiscordPermissions({ sendDeny });

    pending.set("abcde", permission());
    await vi.advanceTimersByTimeAsync(DEFAULT_DISCORD_PERMISSION_TTL_MS - 1);
    expect(sendDeny).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(sendDeny).toHaveBeenCalledOnce();
  });

  it("automatically denies at TTL and removes the prompt buttons", async () => {
    vi.useFakeTimers();
    const sendDeny = vi.fn().mockResolvedValue(true);
    const edit = vi.fn().mockResolvedValue({});
    const pending = new PendingDiscordPermissions({
      ttlMs: 1_000,
      sendDeny,
    });

    pending.set("abcde", permission(edit));
    await vi.advanceTimersByTimeAsync(999);
    expect(sendDeny).not.toHaveBeenCalled();
    expect(pending.has("abcde")).toBe(true);

    await vi.advanceTimersByTimeAsync(1);
    expect(sendDeny).toHaveBeenCalledWith("abcde");
    expect(pending.has("abcde")).toBe(false);
    expect(edit).toHaveBeenCalledWith({
      content: expect.stringContaining("자동 거부"),
      components: [],
    });
  });

  it("restores a failed manual verdict without extending the deadline", async () => {
    vi.useFakeTimers();
    const sendDeny = vi.fn().mockResolvedValue(true);
    const pending = new PendingDiscordPermissions({
      ttlMs: 1_000,
      sendDeny,
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
    const edit = vi.fn().mockResolvedValue({});
    const pending = new PendingDiscordPermissions({
      ttlMs: 1,
      sendDeny: vi.fn().mockResolvedValue(false),
    });

    pending.set("abcde", permission(edit));
    await vi.advanceTimersByTimeAsync(1);

    expect(edit).toHaveBeenCalledWith({
      content: expect.stringContaining("전달하지 못했습니다"),
      components: [],
    });
  });

  it("dispose cancels outstanding expiry timers", async () => {
    vi.useFakeTimers();
    const sendDeny = vi.fn().mockResolvedValue(true);
    const pending = new PendingDiscordPermissions({
      ttlMs: 1,
      sendDeny,
    });

    pending.set("abcde", permission());
    pending.dispose();
    await vi.runAllTimersAsync();

    expect(sendDeny).not.toHaveBeenCalled();
    expect(pending.has("abcde")).toBe(false);
  });
});
