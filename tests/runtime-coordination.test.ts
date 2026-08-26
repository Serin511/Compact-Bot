import { describe, expect, it, vi } from "vitest";
import type { IpcOrigin } from "../src/ipc.js";
import {
  attemptNotificationDelivery,
  buildCodexAppServerEnvironment,
  buildClaudePtyEnvironment,
  disconnectThenRelease,
  InputRecipientTracker,
  isCodexStartupSuperseded,
  isRealtimeUnavailableLifecycle,
  RecentOriginTracker,
  requiresWrapperIpc,
  restorePendingValueIfAbsent,
  takePendingValue,
} from "../src/runtime-coordination.js";

const origin: IpcOrigin = {
  source: "slack",
  chat_id: "C1",
  message_id: "100.1",
  user: "U1",
};

describe("buildClaudePtyEnvironment", () => {
  it("keeps agent auth while removing platform and mutable IPC secrets", () => {
    const env = buildClaudePtyEnvironment(
      {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "agent-auth-must-remain",
        DISCORD_BOT_TOKEN: "discord-secret",
        SLACK_BOT_TOKEN: "slack-secret",
        SLACK_APP_TOKEN: "slack-app-secret",
        WRAPPER_SOCKET: "/private/platform.sock",
        COMPACT_BOT_IPC_AUTH_TOKEN: "platform-capability",
        COMPACT_BOT_HOOK_IPC_AUTH_TOKEN: "stale-hook-capability",
      },
      "/private/hook.sock",
      "fresh-hook-capability",
    );

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "agent-auth-must-remain",
      COMPACT_BOT_WRAPPER_SOCKET: "/private/hook.sock",
      COMPACT_BOT_HOOK_IPC_AUTH_TOKEN: "fresh-hook-capability",
    });
    expect(env).not.toHaveProperty("DISCORD_BOT_TOKEN");
    expect(env).not.toHaveProperty("SLACK_BOT_TOKEN");
    expect(env).not.toHaveProperty("SLACK_APP_TOKEN");
    expect(env).not.toHaveProperty("WRAPPER_SOCKET");
    expect(env).not.toHaveProperty("COMPACT_BOT_IPC_AUTH_TOKEN");
  });
});

describe("buildCodexAppServerEnvironment", () => {
  it("removes every platform and wrapper capability from model shell env", () => {
    const env = buildCodexAppServerEnvironment({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "codex-auth-must-remain",
      DISCORD_BOT_TOKEN: "discord-secret",
      SLACK_BOT_TOKEN: "slack-secret",
      SLACK_APP_TOKEN: "slack-app-secret",
      WRAPPER_SOCKET: "/private/wrapper.sock",
      COMPACT_BOT_IPC_AUTH_TOKEN: "wrapper-control-secret",
      COMPACT_BOT_WRAPPER_SOCKET: "/private/hook.sock",
      COMPACT_BOT_HOOK_IPC_AUTH_TOKEN: "hook-secret",
    });

    expect(env).toEqual({
      PATH: "/usr/bin",
      OPENAI_API_KEY: "codex-auth-must-remain",
    });
  });
});

describe("isCodexStartupSuperseded", () => {
  it("recognizes an explicit retiring event or a concrete replacement", () => {
    const starting = {};
    expect(isCodexStartupSuperseded(starting, starting, false)).toBe(true);
    expect(isCodexStartupSuperseded(starting, {}, true)).toBe(true);
  });

  it("does not hide a genuine startup failure after its process exited", () => {
    const starting = {};
    expect(isCodexStartupSuperseded(starting, starting, true)).toBe(false);
    // The exit handler may clear the current pointer before start() rejects.
    expect(isCodexStartupSuperseded(starting, null, true)).toBe(false);
  });
});

describe("InputRecipientTracker", () => {
  it("counts each failed or disconnected peer only once", () => {
    const first = {};
    const second = {};
    const tracker = new InputRecipientTracker([first, second]);

    expect(tracker.remove(first)).toBe(true);
    expect(tracker.remove(first)).toBe(false);
    expect(tracker.size).toBe(1);
    expect(tracker.has(second)).toBe(true);
    expect(tracker.remove(second)).toBe(true);
    expect(tracker.size).toBe(0);

    expect(tracker.add(first)).toBe(true);
    expect(tracker.add(first)).toBe(false);
    expect(tracker.has(first)).toBe(true);
    expect(tracker.size).toBe(1);
  });
});

describe("RecentOriginTracker", () => {
  it("returns only a recent origin owned by a ready peer", () => {
    const peer = {};
    const tracker = new RecentOriginTracker<object>(1_000);
    tracker.remember(origin, peer, 100);

    expect(tracker.current((candidate) => candidate === peer, 1_000)).toEqual(
      origin,
    );
    expect(tracker.current(() => true, 1_101)).toBeNull();
  });

  it("forgets an origin as soon as its peer is lost", () => {
    const peer = {};
    const tracker = new RecentOriginTracker<object>(1_000);
    tracker.remember(origin, peer, 100);
    tracker.forgetPeer(peer);
    expect(tracker.current(() => true, 101)).toBeNull();
  });
});

describe("takePendingValue", () => {
  it("lets only the first concurrent handler claim a request", () => {
    const pending = new Map([["request", { tool: "Bash" }]]);
    expect(takePendingValue(pending, "request")).toEqual({ tool: "Bash" });
    expect(takePendingValue(pending, "request")).toBeUndefined();
  });
});

describe("restorePendingValueIfAbsent", () => {
  it("restores a claimed request without overwriting a newer collision", () => {
    const pending = new Map<string, { tool: string }>();
    expect(
      restorePendingValueIfAbsent(pending, "request", { tool: "Bash" }),
    ).toBe(true);
    expect(
      restorePendingValueIfAbsent(pending, "request", { tool: "Write" }),
    ).toBe(false);
    expect(pending.get("request")).toEqual({ tool: "Bash" });
  });
});

describe("attemptNotificationDelivery", () => {
  it("reports host notification acceptance explicitly", async () => {
    await expect(
      attemptNotificationDelivery(() => Promise.resolve()),
    ).resolves.toBe(true);
    const onError = vi.fn();
    await expect(
      attemptNotificationDelivery(
        () => Promise.reject(new Error("closed")),
        onError,
      ),
    ).resolves.toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({
      message: "closed",
    }));
  });
});

describe("runtime availability policy", () => {
  it("fails closed without wrapper IPC only in Codex mode", () => {
    expect(requiresWrapperIpc("codex")).toBe(true);
    expect(requiresWrapperIpc("claude")).toBe(false);
  });

  it.each(["reconnecting", "disconnecting", "disconnected"])(
    "treats Slack %s as unable to receive interactions",
    (state) => {
      expect(isRealtimeUnavailableLifecycle(state)).toBe(true);
    },
  );

  it("keeps connected Socket Mode available", () => {
    expect(isRealtimeUnavailableLifecycle("connected")).toBe(false);
  });
});

describe("disconnectThenRelease", () => {
  it("releases ownership only after realtime disconnect completes", async () => {
    const events: string[] = [];
    let finishDisconnect!: () => void;
    const disconnect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishDisconnect = () => {
            events.push("disconnected");
            resolve();
          };
        }),
    );
    const release = vi.fn(() => events.push("released"));

    const shutdown = disconnectThenRelease(disconnect, release);
    expect(events).toEqual([]);
    finishDisconnect();
    await shutdown;
    expect(events).toEqual(["disconnected", "released"]);
  });

  it("does not release early when disconnect fails", async () => {
    const release = vi.fn();
    await expect(
      disconnectThenRelease(
        () => Promise.reject(new Error("disconnect failed")),
        release,
      ),
    ).rejects.toThrow("disconnect failed");
    expect(release).not.toHaveBeenCalled();
  });
});
