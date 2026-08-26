import { describe, expect, it, vi } from "vitest";
import {
  CodexOutboundWriteGuard,
  codexOutboundCallFingerprint,
  type CodexOutboundCall,
} from "../src/codex-outbound-guard.js";
import type { IpcOrigin } from "../src/ipc.js";

const discordOrigin: IpcOrigin = {
  source: "discord",
  chat_id: "discord-a",
  message_id: "message-a",
  user: "user-a",
};

const slackOrigin: IpcOrigin = {
  source: "slack",
  chat_id: "slack-a",
  message_id: "1000.001",
  user: "user-a",
  thread_ts: "999.001",
};

function discordCall(
  overrides: Partial<CodexOutboundCall> = {},
): CodexOutboundCall {
  return {
    source: "discord",
    server: "compact_bot_discord",
    tool: "reply",
    arguments: {
      chat_id: discordOrigin.chat_id,
      text: "hello",
    },
    ...overrides,
  };
}

function slackCall(
  overrides: Partial<CodexOutboundCall> = {},
): CodexOutboundCall {
  return {
    source: "slack",
    server: "compact_bot_slack",
    tool: "reply",
    arguments: {
      chat_id: slackOrigin.chat_id,
      text: "hello",
      thread_ts: slackOrigin.thread_ts,
    },
    ...overrides,
  };
}

function itemStarted(
  turnId: string,
  itemId: string,
  call: CodexOutboundCall,
): Record<string, unknown> {
  return {
    threadId: "thread-1",
    turnId,
    item: {
      id: itemId,
      type: "mcpToolCall",
      server: call.server,
      tool: call.tool,
      status: "inProgress",
      arguments: call.arguments,
      result: null,
      error: null,
    },
  };
}

describe("Codex outbound write guard", () => {
  it("canonicalizes argument keys while binding source, server, and tool", () => {
    const first = discordCall({
      arguments: {
        text: "hello",
        chat_id: "discord-a",
        files: [{ path: "/tmp/a", label: "a" }],
      },
    });
    const reordered = discordCall({
      arguments: {
        files: [{ label: "a", path: "/tmp/a" }],
        chat_id: "discord-a",
        text: "hello",
      },
    });
    expect(codexOutboundCallFingerprint(first)).toBe(
      codexOutboundCallFingerprint(reordered),
    );
    expect(
      codexOutboundCallFingerprint({
        ...first,
        source: "slack",
        server: "compact_bot_slack",
      }),
    ).not.toBe(codexOutboundCallFingerprint(first));
    expect(
      codexOutboundCallFingerprint({ ...first, tool: "react" }),
    ).not.toBe(codexOutboundCallFingerprint(first));
  });

  it("allows an exact item-first call once and not a second time", async () => {
    vi.useFakeTimers();
    try {
      const origins = new Map([["turn-a", discordOrigin]]);
      const guard = new CodexOutboundWriteGuard(
        (turnId) => origins.get(turnId) ?? null,
        { authorizationTimeoutMs: 50 },
      );
      const call = discordCall();
      guard.observe("item/started", itemStarted("turn-a", "item-a", call));

      await expect(guard.authorize(call)).resolves.toEqual({ ok: true });

      const reused = guard.authorize(call);
      await vi.advanceTimersByTimeAsync(50);
      await expect(reused).resolves.toMatchObject({ ok: false });
      guard.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it("matches query-first authorization when item/started arrives later", async () => {
    const guard = new CodexOutboundWriteGuard(
      (turnId) => turnId === "turn-a" ? discordOrigin : null,
    );
    const call = discordCall();
    const authorization = guard.authorize(call);

    guard.observe("item/started", itemStarted("turn-a", "item-a", call));

    await expect(authorization).resolves.toEqual({ ok: true });
    guard.clear();
  });

  it("requires exact full arguments, not only an allowed channel", async () => {
    vi.useFakeTimers();
    try {
      const guard = new CodexOutboundWriteGuard(
        () => discordOrigin,
        { authorizationTimeoutMs: 50 },
      );
      const started = discordCall({
        arguments: { chat_id: "discord-a", text: "first" },
      });
      const invoked = discordCall({
        arguments: { text: "different", chat_id: "discord-a" },
      });
      guard.observe(
        "item/started",
        itemStarted("turn-a", "item-a", started),
      );

      const authorization = guard.authorize(invoked);
      await vi.advanceTimersByTimeAsync(50);
      await expect(authorization).resolves.toMatchObject({ ok: false });
      guard.clear();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      "Discord channel",
      discordOrigin,
      discordCall({
        arguments: { chat_id: "discord-b", text: "wrong channel" },
      }),
    ],
    [
      "Slack channel",
      slackOrigin,
      slackCall({
        arguments: {
          chat_id: "slack-b",
          text: "wrong channel",
          thread_ts: slackOrigin.thread_ts,
        },
      }),
    ],
    [
      "Slack thread",
      slackOrigin,
      slackCall({
        arguments: {
          chat_id: slackOrigin.chat_id,
          text: "wrong thread",
          thread_ts: "other-thread",
        },
      }),
    ],
  ])("denies a write to the wrong %s", async (_label, origin, call) => {
    const guard = new CodexOutboundWriteGuard(() => origin);
    guard.observe("item/started", itemStarted("turn-a", "item-a", call));
    await expect(guard.authorize(call)).resolves.toMatchObject({ ok: false });
    guard.clear();
  });

  it.each(["react", "edit_message"] as const)(
    "guards %s by exact origin channel",
    async (tool) => {
      const exact = slackCall({
        tool,
        arguments: {
          chat_id: slackOrigin.chat_id,
          message_id: "1001.001",
          thread_ts: slackOrigin.thread_ts,
          ...(tool === "react" ? { emoji: "thumbsup" } : { text: "edit" }),
        },
      });
      const wrong = {
        ...exact,
        arguments: { ...exact.arguments, chat_id: "slack-b" },
      };
      const guard = new CodexOutboundWriteGuard(() => slackOrigin);
      guard.observe(
        "item/started",
        itemStarted("turn-a", "item-exact", exact),
      );
      guard.observe(
        "item/started",
        itemStarted("turn-a", "item-wrong", wrong),
      );

      await expect(guard.authorize(exact)).resolves.toEqual({ ok: true });
      await expect(guard.authorize(wrong)).resolves.toMatchObject({
        ok: false,
      });
      guard.clear();
    },
  );

  it.each(["fetch_messages", "download_attachment"] as const)(
    "guards %s by exact Slack channel and thread",
    async (tool) => {
      const exact = slackCall({
        tool,
        arguments: tool === "fetch_messages"
          ? {
              channel: slackOrigin.chat_id,
              thread_ts: slackOrigin.thread_ts,
              limit: 25,
            }
          : {
              chat_id: slackOrigin.chat_id,
              message_id: "1001.001",
              thread_ts: slackOrigin.thread_ts,
            },
      });
      const missingThread = {
        ...exact,
        arguments: {
          ...exact.arguments,
          thread_ts: undefined,
        },
      };
      const guard = new CodexOutboundWriteGuard(() => slackOrigin);
      guard.observe(
        "item/started",
        itemStarted("turn-a", "item-exact", exact),
      );
      guard.observe(
        "item/started",
        itemStarted("turn-a", "item-missing", missingThread),
      );

      await expect(guard.authorize(exact)).resolves.toEqual({ ok: true });
      await expect(guard.authorize(missingThread)).resolves.toMatchObject({
        ok: false,
      });
      guard.clear();
    },
  );

  it("rejects a Slack thread argument for a top-level conversation", async () => {
    const topLevelOrigin: IpcOrigin = {
      source: "slack",
      chat_id: "slack-a",
      message_id: "1000.001",
      user: "user-a",
    };
    const call = slackCall({
      tool: "fetch_messages",
      arguments: {
        channel: topLevelOrigin.chat_id,
        thread_ts: "unexpected-thread",
        limit: 10,
      },
    });
    const guard = new CodexOutboundWriteGuard(() => topLevelOrigin);
    guard.observe("item/started", itemStarted("turn-a", "item-a", call));

    await expect(guard.authorize(call)).resolves.toMatchObject({ ok: false });
    guard.clear();
  });

  it.each(["fetch_messages", "download_attachment"] as const)(
    "guards Discord %s by exact channel",
    async (tool) => {
      const exact = discordCall({
        tool,
        arguments: tool === "fetch_messages"
          ? { channel: discordOrigin.chat_id, limit: 25 }
          : {
              chat_id: discordOrigin.chat_id,
              message_id: "message-a",
            },
      });
      const wrong = {
        ...exact,
        arguments: tool === "fetch_messages"
          ? { ...exact.arguments, channel: "discord-b" }
          : { ...exact.arguments, chat_id: "discord-b" },
      };
      const guard = new CodexOutboundWriteGuard(() => discordOrigin);
      guard.observe(
        "item/started",
        itemStarted("turn-a", "item-exact", exact),
      );
      guard.observe(
        "item/started",
        itemStarted("turn-a", "item-wrong", wrong),
      );

      await expect(guard.authorize(exact)).resolves.toEqual({ ok: true });
      await expect(guard.authorize(wrong)).resolves.toMatchObject({
        ok: false,
      });
      guard.clear();
    },
  );

  it("waits through ambiguous automatic and explicit turns, then reconciles each owner", async () => {
    const origins = new Map<string, IpcOrigin>();
    const guard = new CodexOutboundWriteGuard(
      (turnId) => origins.get(turnId) ?? null,
    );
    const automaticCall = slackCall({
      arguments: {
        chat_id: "slack-a",
        text: "automatic",
        thread_ts: "999.001",
      },
    });
    const explicitOrigin: IpcOrigin = {
      ...slackOrigin,
      chat_id: "slack-b",
      message_id: "2000.001",
      thread_ts: "1999.001",
    };
    const explicitCall = slackCall({
      arguments: {
        chat_id: "slack-b",
        text: "explicit",
        thread_ts: "1999.001",
      },
    });
    const token = guard.beginAmbiguity();
    guard.observe(
      "item/started",
      itemStarted("turn-auto", "item-auto", automaticCall),
    );
    guard.observe(
      "item/started",
      itemStarted("turn-explicit", "item-explicit", explicitCall),
    );
    const automaticAuthorization = guard.authorize(automaticCall);
    const explicitAuthorization = guard.authorize(explicitCall);

    origins.set("turn-auto", slackOrigin);
    origins.set("turn-explicit", explicitOrigin);
    guard.endAmbiguity(token);

    await expect(automaticAuthorization).resolves.toEqual({ ok: true });
    await expect(explicitAuthorization).resolves.toEqual({ ok: true });
    guard.clear();
  });

  it.each(["item/completed", "turn/completed"] as const)(
    "invalidates an unused permit after %s",
    async (method) => {
      vi.useFakeTimers();
      try {
        const guard = new CodexOutboundWriteGuard(
          () => discordOrigin,
          { authorizationTimeoutMs: 50 },
        );
        const call = discordCall();
        guard.observe(
          "item/started",
          itemStarted("turn-a", "item-a", call),
        );
        guard.observe(
          method,
          method === "item/completed"
            ? {
              threadId: "thread-1",
              turnId: "turn-a",
              item: { id: "item-a", type: "mcpToolCall" },
            }
            : {
              threadId: "thread-1",
              turn: { id: "turn-a", status: "completed" },
            },
        );

        const authorization = guard.authorize(call);
        await vi.advanceTimersByTimeAsync(50);
        await expect(authorization).resolves.toMatchObject({ ok: false });
        guard.clear();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("fails a pending query closed on reset and timeout", async () => {
    vi.useFakeTimers();
    try {
      const guard = new CodexOutboundWriteGuard(
        () => null,
        { authorizationTimeoutMs: 50 },
      );
      const reset = guard.authorize(discordCall());
      guard.clear("generation changed");
      await expect(reset).resolves.toEqual({
        ok: false,
        error: "generation changed",
      });

      const timedOut = guard.authorize(discordCall());
      await vi.advanceTimersByTimeAsync(50);
      await expect(timedOut).resolves.toMatchObject({ ok: false });
      guard.clear();
    } finally {
      vi.useRealTimers();
    }
  });
});
