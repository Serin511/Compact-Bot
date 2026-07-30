import { describe, expect, it } from "vitest";
import {
  announceRealtimeReady,
  IpcCommandTracker,
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
