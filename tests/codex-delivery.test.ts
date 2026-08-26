import { describe, expect, it } from "vitest";
import {
  canMutateCodexGoal,
  canUseActiveCodexTurn,
  CodexDeliveryTracker,
} from "../src/codex-delivery.js";
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
      arguments: {
        chat_id: discordOrigin.chat_id,
        text: `final for ${turnId}`,
      },
      result: { content: [{ type: "text", text: "sent" }] },
      error: null,
      ...overrides,
    },
  };
}

describe("CodexDeliveryTracker", () => {
  it("allows only the exact owner to steer an active turn", () => {
    expect(
      canUseActiveCodexTurn(slackOrigin, {
        ...slackOrigin,
        message_id: "later-message",
      }),
    ).toBe(true);
    expect(
      canUseActiveCodexTurn(slackOrigin, {
        ...slackOrigin,
        thread_ts: "other-thread",
      }),
    ).toBe(false);
    expect(
      canUseActiveCodexTurn(slackOrigin, {
        ...slackOrigin,
        user: "other-user",
      }),
    ).toBe(false);
    expect(canUseActiveCodexTurn(null, slackOrigin)).toBe(false);
    expect(canUseActiveCodexTurn(slackOrigin, undefined)).toBe(false);
  });

  it("allows only the owner to replace or clear an active native goal", () => {
    const snapshot = { origin: slackOrigin, active: true };
    expect(
      canMutateCodexGoal(snapshot, {
        ...slackOrigin,
        message_id: "later-message",
      }),
    ).toBe(true);
    expect(
      canMutateCodexGoal(snapshot, {
        ...slackOrigin,
        thread_ts: "other-thread",
      }),
    ).toBe(false);
    expect(
      canMutateCodexGoal(snapshot, {
        ...slackOrigin,
        user: "other-user",
      }),
    ).toBe(false);
    expect(canMutateCodexGoal(snapshot, undefined)).toBe(false);
    expect(
      canMutateCodexGoal({ origin: null, active: true }, slackOrigin),
    ).toBe(false);
    expect(
      canMutateCodexGoal({ ...snapshot, active: false }, {
        ...slackOrigin,
        thread_ts: "other-thread",
      }),
    ).toBe(true);
  });

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
          text: "final for turn-exact-thread",
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

  it("does not move a completing turn when a fresh submission is only pending", () => {
    const tracker = new CodexDeliveryTracker();
    startTurn(tracker, "turn-finishing", discordOrigin);
    tracker.setCurrentOrigin(slackOrigin);

    expect(completeTurn(tracker, "turn-finishing")).toEqual({
      origin: discordOrigin,
      text: "final for turn-finishing",
    });
  });

  it("falls back with the final answer when only a progress reply was delivered", () => {
    const tracker = new CodexDeliveryTracker();
    startTurn(tracker, "turn-progress-only", discordOrigin);
    tracker.observe(
      "item/completed",
      replyItem("turn-progress-only", {
        arguments: {
          chat_id: discordOrigin.chat_id,
          text: "작업 중입니다.",
        },
      }),
    );

    expect(completeTurn(tracker, "turn-progress-only")).toEqual({
      origin: discordOrigin,
      text: "final for turn-progress-only",
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

  it("does not resurrect delivery state after completion beats submit response", () => {
    const tracker = new CodexDeliveryTracker();
    startTurn(tracker, "turn-completed-first", discordOrigin);
    expect(completeTurn(tracker, "turn-completed-first")).toEqual({
      origin: discordOrigin,
      text: "final for turn-completed-first",
    });

    tracker.setOriginForTurn("turn-completed-first", slackOrigin);
    tracker.observe("turn/started", {
      threadId: "thread-1",
      turn: { id: "turn-completed-first", status: "inProgress" },
    });
    const laterOrigin: IpcOrigin = {
      ...discordOrigin,
      message_id: "later-message",
    };
    tracker.setCurrentOrigin(laterOrigin);

    expect(tracker.originForTurn("turn-completed-first")).toEqual(laterOrigin);
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

  it("keeps later automatic goal turns bound to the goal creator", () => {
    const tracker = new CodexDeliveryTracker();
    tracker.setGoalOrigin(discordOrigin);
    tracker.observe("thread/goal/updated", {
      threadId: "thread-1",
      turnId: null,
      goal: { status: "active" },
    });
    tracker.observe("turn/started", {
      threadId: "thread-1",
      turn: { id: "goal-turn-1" },
    });

    const steered = tracker.beginExplicitSubmission(slackOrigin);
    tracker.acceptExplicitSubmission(steered, "goal-turn-1");
    expect(tracker.originForTurn("goal-turn-1")).toEqual(slackOrigin);
    completeTurn(tracker, "goal-turn-1");

    tracker.observe("thread/goal/updated", {
      threadId: "thread-1",
      turnId: "goal-turn-1",
      goal: { status: "active" },
    });
    tracker.observe("turn/started", {
      threadId: "thread-1",
      turn: { id: "goal-turn-2" },
    });

    expect(tracker.originForTurn("goal-turn-2")).toEqual(discordOrigin);
  });

  it("uses a pending explicit origin before the accepted turn id is returned", () => {
    const tracker = new CodexDeliveryTracker();
    const submission = tracker.beginExplicitSubmission(slackOrigin);

    // Server requests and item completion can precede turn/started and the
    // turn/start response. Both must already route to the explicit sender.
    tracker.observe("item/completed", {
      threadId: "thread-1",
      turnId: "explicit-turn",
      item: {
        type: "agentMessage",
        phase: "final_answer",
        text: "explicit answer",
      },
    });
    expect(tracker.originForTurn("explicit-turn")).toEqual(slackOrigin);
    expect(
      tracker.authorizationOriginForTurn("explicit-turn"),
    ).toBeNull();

    expect(completeTurn(tracker, "explicit-turn")).toBeNull();
    expect(
      tracker.acceptExplicitSubmission(submission, "explicit-turn"),
    ).toEqual([{
      origin: slackOrigin,
      text: "explicit answer",
    }]);
  });

  it("never leaks a completed automatic goal turn to a pending sender", () => {
    const tracker = new CodexDeliveryTracker();
    tracker.setCurrentOrigin(discordOrigin);
    tracker.setGoalOrigin(discordOrigin);
    tracker.observe("thread/goal/updated", {
      threadId: "thread-1",
      turnId: null,
      goal: { status: "active" },
    });
    const submission = tracker.beginExplicitSubmission(slackOrigin);

    // A server request is allowed to race the lifecycle stream. Until an
    // observed turn can be classified, neither the goal owner nor the pending
    // sender is a safe destination.
    expect(tracker.originForTurn("not-yet-observed")).toBeNull();

    tracker.observe("turn/started", {
      threadId: "thread-1",
      turn: { id: "automatic-goal-turn" },
    });
    tracker.observe("item/completed", {
      threadId: "thread-1",
      turnId: "automatic-goal-turn",
      item: {
        type: "agentMessage",
        phase: "final_answer",
        text: "automatic answer",
      },
    });
    expect(tracker.originForTurn("automatic-goal-turn")).toBeNull();
    expect(
      tracker.authorizationOriginForTurn("automatic-goal-turn"),
    ).toBeNull();
    expect(
      tracker.observe("turn/completed", {
        threadId: "thread-1",
        turn: { id: "automatic-goal-turn", status: "completed" },
      }),
    ).toBeNull();

    expect(
      tracker.acceptExplicitSubmission(submission, "returned-explicit-turn"),
    ).toEqual([{
      origin: discordOrigin,
      text: "automatic answer",
    }]);

    expect(tracker.originForTurn("returned-explicit-turn")).toEqual(slackOrigin);
    expect(
      tracker.authorizationOriginForTurn("returned-explicit-turn"),
    ).toEqual(slackOrigin);
  });

  it("flushes an explicit turn that completes before turn/start returns to its sender", () => {
    const tracker = new CodexDeliveryTracker();
    tracker.setCurrentOrigin(discordOrigin);
    tracker.setGoalOrigin(discordOrigin);
    tracker.observe("thread/goal/updated", {
      threadId: "thread-1",
      turnId: null,
      goal: { status: "active" },
    });
    const submission = tracker.beginExplicitSubmission(slackOrigin);

    tracker.observe("turn/started", {
      threadId: "thread-1",
      turn: { id: "explicit-before-response" },
    });
    tracker.observe("item/completed", {
      threadId: "thread-1",
      turnId: "explicit-before-response",
      item: {
        type: "agentMessage",
        phase: "final_answer",
        text: "explicit answer",
      },
    });
    expect(
      tracker.observe("turn/completed", {
        threadId: "thread-1",
        turn: { id: "explicit-before-response", status: "completed" },
      }),
    ).toBeNull();

    expect(
      tracker.acceptExplicitSubmission(
        submission,
        "explicit-before-response",
      ),
    ).toEqual([{
      origin: slackOrigin,
      text: "explicit answer",
    }]);
  });

  it("restores the previous goal owner when a replacement is rejected", () => {
    const tracker = new CodexDeliveryTracker();
    tracker.setGoalOrigin(discordOrigin);
    const previous = tracker.snapshotGoalOrigin();

    tracker.setGoalOrigin(slackOrigin);
    tracker.restoreGoalOrigin(previous);
    tracker.observe("turn/started", {
      threadId: "thread-1",
      turn: { id: "continuing-old-goal" },
    });

    expect(tracker.originForTurn("continuing-old-goal")).toEqual(discordOrigin);
  });

  it("clears the goal owner on clear and session reset", () => {
    const tracker = new CodexDeliveryTracker();
    tracker.setGoalOrigin(discordOrigin);
    tracker.observe("thread/goal/cleared", { threadId: "thread-1" });
    tracker.observe("turn/started", {
      threadId: "thread-1",
      turn: { id: "after-clear" },
    });
    expect(tracker.originForTurn("after-clear")).toBeNull();

    tracker.setGoalOrigin(discordOrigin);
    tracker.clearTurns();
    tracker.observe("turn/started", {
      threadId: "thread-2",
      turn: { id: "after-reset" },
    });
    expect(tracker.originForTurn("after-reset")).toBeNull();
  });

  it("does not carry a prior conversation into an originless new session", () => {
    const tracker = new CodexDeliveryTracker();
    tracker.setCurrentOrigin(slackOrigin);
    tracker.clearTurns();

    tracker.observe("turn/started", {
      threadId: "fresh-thread",
      turn: { id: "originless-fresh-turn" },
    });

    expect(tracker.originForTurn("originless-fresh-turn")).toBeNull();
    expect(
      tracker.authorizationOriginForTurn("originless-fresh-turn"),
    ).toBeNull();
  });

  it.each([
    "complete",
    "completed",
    "failed",
    "cancelled",
    "canceled",
  ])("clears the goal owner while status is terminal: %s", (status) => {
    const tracker = new CodexDeliveryTracker();
    tracker.setGoalOrigin(discordOrigin);

    tracker.observe("thread/goal/updated", {
      threadId: "thread-1",
      turnId: "goal-turn",
      goal: { status },
    });

    expect(tracker.snapshotGoalOrigin()).toEqual({
      origin: null,
      active: false,
    });
  });

  it("keeps an active goal with no known owner fail-closed", () => {
    const tracker = new CodexDeliveryTracker();
    tracker.setCurrentOrigin(discordOrigin);
    tracker.observe("thread/goal/updated", {
      threadId: "thread-1",
      goal: { status: "active" },
    });

    expect(tracker.snapshotGoalOrigin()).toEqual({
      origin: null,
      active: true,
    });
    expect(tracker.originForTurn("not-yet-observed")).toBeNull();

    tracker.observe("turn/started", {
      threadId: "thread-1",
      turn: { id: "ownerless-goal-turn" },
    });
    expect(tracker.originForTurn("ownerless-goal-turn")).toBeNull();
    expect(
      tracker.authorizationOriginForTurn("ownerless-goal-turn"),
    ).toBeNull();

    // Even if the goal later terminates, the already-classified turn must not
    // inherit whichever channel happened to be current.
    tracker.observe("thread/goal/updated", {
      threadId: "thread-1",
      goal: { status: "failed" },
    });
    expect(tracker.originForTurn("ownerless-goal-turn")).toBeNull();
  });

  it.each([
    "paused",
    "blocked",
    "usageLimited",
    "budgetLimited",
  ])("retains the goal owner while status is %s", (status) => {
    const tracker = new CodexDeliveryTracker();
    tracker.setGoalOrigin(discordOrigin);
    tracker.observe("thread/goal/updated", {
      threadId: "thread-1",
      turnId: null,
      goal: { status },
    });
    tracker.observe("turn/started", {
      threadId: "thread-1",
      turn: { id: `resumed-${status}` },
    });

    expect(tracker.originForTurn(`resumed-${status}`)).toEqual(discordOrigin);
  });
});
