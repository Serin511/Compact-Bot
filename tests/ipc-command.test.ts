import { describe, expect, it, vi } from "vitest";
import {
  announceRealtimeNotReady,
  announceRealtimeReady,
  IpcCommandTracker,
  IpcRoutedResultTracker,
  IpcOutboundAuthorizationTracker,
  isAllowedInputAnswer,
  isOriginForPlatform,
  isMatchingInputRequest,
  sameConversationOrigin,
  type IpcCommandResult,
  type IpcMessageSender,
  type IpcOrigin,
  type PeerToWrapper,
  type WrapperToMcp,
} from "../src/ipc.js";

class FakeSender implements IpcMessageSender {
  readonly messages: Array<PeerToWrapper | WrapperToMcp> = [];

  send(message: PeerToWrapper | WrapperToMcp): void {
    this.messages.push(message);
  }
}

const slackOrigin: IpcOrigin = {
  source: "slack",
  chat_id: "C123",
  message_id: "1000.001",
  user: "U123",
  ts: "2026-07-30T00:00:00.000Z",
  thread_ts: "999.001",
};

describe("IPC conversation origins", () => {
  it("routes only to the named platform", () => {
    expect(isOriginForPlatform(slackOrigin, "slack")).toBe(true);
    expect(isOriginForPlatform(slackOrigin, "discord")).toBe(false);
    expect(isOriginForPlatform(undefined, "slack")).toBe(false);
  });

  it("accepts a later Slack answer only from the same channel, thread, and user", () => {
    expect(
      sameConversationOrigin(slackOrigin, {
        ...slackOrigin,
        message_id: "1001.002",
      }),
    ).toBe(true);
    expect(
      sameConversationOrigin(slackOrigin, {
        ...slackOrigin,
        chat_id: "C999",
      }),
    ).toBe(false);
    expect(
      sameConversationOrigin(slackOrigin, {
        ...slackOrigin,
        thread_ts: "888.001",
      }),
    ).toBe(false);
    expect(
      sameConversationOrigin(slackOrigin, {
        ...slackOrigin,
        user: "U999",
      }),
    ).toBe(false);
  });

  it("does not require an answer message to reuse the request message ID", () => {
    const expected: IpcOrigin = {
      source: "discord",
      chat_id: "123",
      message_id: "456",
      user: "789",
    };
    expect(
      sameConversationOrigin(expected, {
        ...expected,
        message_id: "new-answer-message",
      }),
    ).toBe(true);
  });
});

describe("IPC question input policy", () => {
  const restrictedWidget = {
    header: null,
    question: "Choose",
    options: [
      { label: "Alpha", description: null },
      { label: "Beta", description: null },
    ],
    allowOther: false,
    questionIndex: 1,
    questionTotal: 1,
  };

  it("accepts a valid option number or exact label when free-form input is disabled", () => {
    expect(isAllowedInputAnswer(restrictedWidget, "1")).toBe(true);
    expect(isAllowedInputAnswer(restrictedWidget, " 2 ")).toBe(true);
    expect(isAllowedInputAnswer(restrictedWidget, "Alpha")).toBe(true);
  });

  it("rejects out-of-range numbers and arbitrary text without consuming the question", () => {
    expect(isAllowedInputAnswer(restrictedWidget, "0")).toBe(false);
    expect(isAllowedInputAnswer(restrictedWidget, "3")).toBe(false);
    expect(isAllowedInputAnswer(restrictedWidget, "alpha")).toBe(false);
    expect(isAllowedInputAnswer(restrictedWidget, "anything else")).toBe(false);
  });

  it("preserves legacy free-form behaviour when allowOther is omitted", () => {
    expect(
      isAllowedInputAnswer(
        { ...restrictedWidget, allowOther: undefined },
        "anything else",
      ),
    ).toBe(true);
  });

  it("cancels only the exactly correlated pending input request", () => {
    expect(isMatchingInputRequest("request-a", "request-a")).toBe(true);
    expect(isMatchingInputRequest("request-b", "request-a")).toBe(false);
    expect(isMatchingInputRequest(undefined, "request-a")).toBe(false);
  });
});

describe("realtime platform readiness", () => {
  it("registers only a process with a usable realtime connection", () => {
    const sender = new FakeSender();

    expect(announceRealtimeReady(sender, "slack", false)).toBe(false);
    expect(sender.messages).toEqual([]);

    expect(announceRealtimeReady(sender, "slack", true)).toBe(true);
    expect(sender.messages).toEqual([
      { type: "ready", source: "slack" },
    ]);
  });

  it("does not throw when wrapper IPC is unavailable", () => {
    expect(announceRealtimeReady(null, "discord", true)).toBe(false);
    expect(announceRealtimeNotReady(null, "discord")).toBe(false);
  });

  it("unregisters the exact realtime platform on disconnect", () => {
    const sender = new FakeSender();
    expect(announceRealtimeNotReady(sender, "slack")).toBe(true);
    expect(sender.messages).toEqual([
      { type: "not_ready", source: "slack" },
    ]);
  });
});

describe("IpcCommandTracker", () => {
  it("adds correlation data and preserves /raw origin metadata", async () => {
    const sender = new FakeSender();
    const tracker = new IpcCommandTracker();
    const pending = tracker.request(sender, {
      type: "raw",
      text: "status",
      origin: slackOrigin,
      success_message: "sent",
    });

    const request = sender.messages[0];
    expect(request).toMatchObject({
      type: "raw",
      text: "status",
      origin: slackOrigin,
      success_message: "sent",
    });
    expect(request).toHaveProperty("request_id");
    if (!request || request.type !== "raw" || !request.request_id) {
      throw new Error("raw request was not sent");
    }

    const result: IpcCommandResult = {
      type: "command_result",
      request_id: request.request_id,
      command: "raw",
      ok: true,
      origin: slackOrigin,
      message: "sent",
    };
    expect(tracker.settle(result)).toBe(true);
    await expect(pending).resolves.toEqual(result);
    // A duplicate received by the same child is suppressed.
    expect(tracker.settle(result)).toBe(true);
  });

  it("marks a result unknown in a replacement child for direct target delivery", () => {
    const tracker = new IpcCommandTracker();
    expect(
      tracker.settle({
        type: "command_result",
        request_id: "from-old-child",
        command: "goal",
        ok: true,
        origin: slackOrigin,
        message: "goal set",
      }),
    ).toBe(false);
  });

  it("returns a failure instead of claiming success without wrapper IPC", async () => {
    const tracker = new IpcCommandTracker();
    await expect(
      tracker.request(null, {
        type: "goal",
        args: "ship it",
        origin: slackOrigin,
      }),
    ).resolves.toMatchObject({
      type: "command_result",
      command: "goal",
      ok: false,
      origin: slackOrigin,
      error: "wrapper 연결 없음",
    });
  });
});

describe("IpcRoutedResultTracker", () => {
  type CaptureResult = Extract<
    WrapperToMcp,
    { type: "capture_result" }
  >;

  it("preserves a routed request origin and suppresses a local duplicate", async () => {
    const sender = new FakeSender();
    const tracker = new IpcRoutedResultTracker<CaptureResult>();
    const pending = tracker.request(sender, {
      type: "capture",
      request_id: "capture-local",
      all: true,
      origin: slackOrigin,
    });

    expect(sender.messages).toEqual([{
      type: "capture",
      request_id: "capture-local",
      all: true,
      origin: slackOrigin,
    }]);

    const result: CaptureResult = {
      type: "capture_result",
      request_id: "capture-local",
      text: "captured",
      all: true,
      origin: slackOrigin,
    };
    expect(tracker.settle(result)).toBe(true);
    await expect(pending).resolves.toEqual(result);
    expect(tracker.settle(result)).toBe(true);
  });

  it("leaves an old-child result unknown in a replacement process", () => {
    const tracker = new IpcRoutedResultTracker<CaptureResult>();
    expect(
      tracker.settle({
        type: "capture_result",
        request_id: "capture-from-old-child",
        text: "captured",
        origin: slackOrigin,
      }),
    ).toBe(false);
  });

  it("accepts an uncorrelated legacy result only for one pending request", async () => {
    const sender = new FakeSender();
    const single = new IpcRoutedResultTracker<CaptureResult>();
    const pending = single.request(sender, {
      type: "capture",
      request_id: "only-request",
      origin: slackOrigin,
    });
    const legacy: CaptureResult = {
      type: "capture_result",
      text: "legacy",
    };
    expect(single.settle(legacy)).toBe(true);
    await expect(pending).resolves.toEqual(legacy);

    const ambiguous = new IpcRoutedResultTracker<CaptureResult>();
    void ambiguous.request(sender, {
      type: "capture",
      request_id: "request-a",
      origin: slackOrigin,
    });
    void ambiguous.request(sender, {
      type: "capture",
      request_id: "request-b",
      origin: slackOrigin,
    });
    expect(ambiguous.settle(legacy)).toBe(false);
  });

  it("returns null immediately when wrapper IPC is unavailable", async () => {
    const tracker = new IpcRoutedResultTracker<CaptureResult>();
    await expect(
      tracker.request(null, {
        type: "capture",
        request_id: "capture-offline",
        origin: slackOrigin,
      }),
    ).resolves.toBeNull();
  });
});

describe("IpcOutboundAuthorizationTracker", () => {
  it("correlates a direct authorization response without realtime readiness", async () => {
    const sender = new FakeSender();
    const tracker = new IpcOutboundAuthorizationTracker();
    const pending = tracker.request(sender, {
      source: "slack",
      server: "compact_bot_slack",
      tool: "reply",
      arguments: {
        chat_id: slackOrigin.chat_id,
        thread_ts: slackOrigin.thread_ts,
        text: "hello",
      },
    });
    const request = sender.messages[0];
    if (!request || request.type !== "authorize_outbound") {
      throw new Error("authorization request was not sent");
    }
    const result = {
      type: "outbound_authorization_result" as const,
      request_id: request.request_id,
      ok: true,
    };
    expect(tracker.settle(result)).toBe(true);
    await expect(pending).resolves.toEqual(result);
  });

  it("denies when IPC is absent or disconnects with a pending request", async () => {
    const tracker = new IpcOutboundAuthorizationTracker();
    await expect(
      tracker.request(null, {
        source: "discord",
        server: "compact_bot_discord",
        tool: "react",
        arguments: {
          chat_id: "discord-a",
          message_id: "message-a",
          emoji: "👍",
        },
      }),
    ).resolves.toMatchObject({ ok: false, error: "wrapper 연결 없음" });

    const sender = new FakeSender();
    const pending = tracker.request(sender, {
      source: "discord",
      server: "compact_bot_discord",
      tool: "edit_message",
      arguments: {
        chat_id: "discord-a",
        message_id: "message-a",
        text: "edit",
      },
    });
    tracker.denyAll("socket closed");
    await expect(pending).resolves.toMatchObject({
      ok: false,
      error: "socket closed",
    });
  });

  it("denies immediately when sending on the IPC socket throws", async () => {
    const tracker = new IpcOutboundAuthorizationTracker();
    const throwingSender: IpcMessageSender = {
      send(): void {
        throw new Error("socket already closed");
      },
    };
    await expect(
      tracker.request(throwingSender, {
        source: "slack",
        server: "compact_bot_slack",
        tool: "reply",
        arguments: { chat_id: "C123", text: "hello" },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: "socket already closed",
    });
  });

  it("keeps the outer IPC deadline longer than the guard decision window", async () => {
    vi.useFakeTimers();
    try {
      const tracker = new IpcOutboundAuthorizationTracker();
      const sender = new FakeSender();
      let settled = false;
      const pending = tracker.request(sender, {
        source: "discord",
        server: "compact_bot_discord",
        tool: "reply",
        arguments: { chat_id: "discord-a", text: "hello" },
      }).then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(pending).resolves.toMatchObject({
        ok: false,
        error: "outbound authorization timeout",
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
