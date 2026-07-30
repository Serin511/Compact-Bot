import { describe, expect, it } from "vitest";
import { CodexDeliveryTracker } from "../src/codex-delivery.js";
import type { IpcOrigin } from "../src/ipc.js";

const discordOrigin: IpcOrigin = {
  source: "discord",
  chat_id: "discord-channel",
  message_id: "discord-message",
  user: "discord-user",
};

const slackOrigin: IpcOrigin = {
  source: "slack",
  chat_id: "slack-channel",
  message_id: "1000.001",
  user: "slack-user",
  thread_ts: "999.001",
};

function startTurn(
  tracker: CodexDeliveryTracker,
  turnId: string,
  origin: IpcOrigin,
): void {
  tracker.setOrigin(origin);
  tracker.observe("turn/started", {
    threadId: "thread-1",
    turn: { id: turnId, status: "inProgress" },
  });
  tracker.observe("item/completed", {
    threadId: "thread-1",
    turnId,
    item: {
      id: `${turnId}-answer`,
      type: "agentMessage",
      phase: "final_answer",
      text: `final for ${turnId}`,
    },
  });
}

function completeTurn(
  tracker: CodexDeliveryTracker,
  turnId: string,
) {
  return tracker.observe("turn/completed", {
    threadId: "thread-1",
    turn: { id: turnId, status: "completed", error: null },
  });
}

function replyItem(
  turnId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    threadId: "thread-1",
    turnId,
    item: {
      id: `${turnId}-reply`,
      type: "mcpToolCall",
      server: "compact_bot_discord",
      tool: "reply",
      status: "completed",
      arguments: { chat_id: discordOrigin.chat_id },
      result: { content: [{ type: "text", text: "sent" }] },
      error: null,
      ...overrides,
    },
  };
}

describe("CodexDeliveryTracker", () => {
  it("suppresses fallback after a successful reply to the exact Discord target", () => {
    const tracker = new CodexDeliveryTracker();
    startTurn(tracker, "turn-success", discordOrigin);
    tracker.observe(
      "item/completed",
      replyItem("turn-success"),
    );

    expect(completeTurn(tracker, "turn-success")).toBeNull();
    // Completion is single-shot; a duplicate cannot emit a fallback.
    expect(completeTurn(tracker, "turn-success")).toBeNull();
  });

  it("requires the exact Slack channel and thread before suppressing fallback", () => {
    const wrongThread = new CodexDeliveryTracker();
    startTurn(wrongThread, "turn-wrong-thread", slackOrigin);
    wrongThread.observe(
      "item/completed",
      replyItem("turn-wrong-thread", {
        server: "compact_bot_slack",
        arguments: {
          chat_id: slackOrigin.chat_id,
          thread_ts: "different-thread",
        },
      }),
    );
    expect(completeTurn(wrongThread, "turn-wrong-thread")).toEqual({
      origin: slackOrigin,
      text: "final for turn-wrong-thread",
    });

    const exactThread = new CodexDeliveryTracker();
    startTurn(exactThread, "turn-exact-thread", slackOrigin);
    exactThread.observe(
      "item/completed",
      replyItem("turn-exact-thread", {
        server: "compact_bot_slack",
        arguments: {
          chat_id: slackOrigin.chat_id,
          thread_ts: slackOrigin.thread_ts,
        },
      }),
    );
    expect(completeTurn(exactThread, "turn-exact-thread")).toBeNull();
  });

  it.each([
    [
      "wrong channel",
      { arguments: { chat_id: "different-channel" } },
    ],
    [
      "wrong server",
      { server: "third_party_discord_bridge" },
    ],
    [
      "failed status",
      { status: "failed" },
    ],
    [
      "item error",
      { error: { message: "gateway unavailable" } },
    ],
    [
      "MCP error result",
      { result: { isError: true, content: [] } },
    ],
  ])("falls back when the reply has a %s", (_label, overrides) => {
    const tracker = new CodexDeliveryTracker();
    startTurn(tracker, "turn-fallback", discordOrigin);
    tracker.observe(
      "item/completed",
      replyItem("turn-fallback", overrides),
    );

    expect(completeTurn(tracker, "turn-fallback")).toEqual({
      origin: discordOrigin,
      text: "final for turn-fallback",
    });
  });

  it("uses the most recent steered-message origin for an active turn", () => {
    const tracker = new CodexDeliveryTracker();
    startTurn(tracker, "turn-steered", discordOrigin);
    tracker.setOrigin(slackOrigin, "turn-steered");

    expect(tracker.originForTurn("turn-steered")).toEqual(slackOrigin);
    expect(completeTurn(tracker, "turn-steered")).toEqual({
      origin: slackOrigin,
      text: "final for turn-steered",
    });
  });

  it("keeps an explicitly bound turn origin when turn/started arrives late", () => {
    const tracker = new CodexDeliveryTracker();
    tracker.setCurrentOrigin(discordOrigin);
    tracker.setOriginForTurn("turn-delayed", discordOrigin);
    tracker.setCurrentOrigin(slackOrigin);

    tracker.observe("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-delayed", status: "inProgress" },
    });
    tracker.observe("item/completed", {
      threadId: "thread-1",
      turnId: "turn-delayed",
      item: {
        type: "agentMessage",
        phase: "final_answer",
        text: "bound response",
      },
    });

    expect(completeTurn(tracker, "turn-delayed")).toEqual({
      origin: discordOrigin,
      text: "bound response",
    });
  });

  it("requires another platform reply after the active turn origin changes", () => {
    const tracker = new CodexDeliveryTracker();
    startTurn(tracker, "turn-resteered", discordOrigin);
    tracker.observe(
      "item/completed",
      replyItem("turn-resteered"),
    );

    const laterDiscordOrigin: IpcOrigin = {
      ...discordOrigin,
      message_id: "later-discord-message",
    };
    tracker.setOriginForTurn("turn-resteered", laterDiscordOrigin);

    expect(completeTurn(tracker, "turn-resteered")).toEqual({
      origin: laterDiscordOrigin,
      text: "final for turn-resteered",
    });
  });

  it("preserves a successful reply when the same origin is rebound", () => {
    const tracker = new CodexDeliveryTracker();
    tracker.setCurrentOrigin(discordOrigin);
    tracker.observe("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-same-origin", status: "inProgress" },
    });
    tracker.observe(
      "item/completed",
      replyItem("turn-same-origin"),
    );
    tracker.setOriginForTurn("turn-same-origin", discordOrigin);

    expect(
      tracker.observe("turn/completed", {
        threadId: "thread-1",
        turn: {
          id: "turn-same-origin",
          status: "failed",
          error: { message: "failed after reply" },
        },
      }),
    ).toBeNull();
  });

  it.each([
    [
      "failed status",
      { id: "turn-failed", status: "failed", error: null },
      "⚠️ Codex 턴이 실패했습니다.",
    ],
    [
      "turn error",
      {
        id: "turn-error",
        status: "failed",
        error: { message: "model unavailable" },
      },
      "⚠️ Codex 턴이 실패했습니다: model unavailable",
    ],
  ])(
    "routes a warning to the bound origin for a textless %s",
    (_label, turn, warning) => {
      const tracker = new CodexDeliveryTracker();
      tracker.setOriginForTurn(String(turn.id), slackOrigin);
      tracker.observe("turn/started", {
        threadId: "thread-1",
        turn: { id: turn.id, status: "inProgress" },
      });

      expect(
        tracker.observe("turn/completed", {
          threadId: "thread-1",
          turn,
        }),
      ).toEqual({
        origin: slackOrigin,
        text: warning,
      });
    },
  );

  it("does not treat commentary as a final fallback response", () => {
    const tracker = new CodexDeliveryTracker();
    tracker.setOrigin(discordOrigin);
    tracker.observe("turn/started", {
      turn: { id: "turn-commentary" },
    });
    tracker.observe("item/completed", {
      turnId: "turn-commentary",
      item: {
        type: "agentMessage",
        phase: "commentary",
        text: "working...",
      },
    });

    expect(completeTurn(tracker, "turn-commentary")).toBeNull();
  });
});
