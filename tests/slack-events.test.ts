/**
 * Tests for slack-events module.
 *
 * Covers which Slack message subtypes are treated as processable user
 * input — in particular that file uploads (subtype "file_share") are not
 * dropped along with bot/system subtypes.
 */

import { describe, it, expect } from "vitest";
import {
  isProcessableSlackMessage,
  resolveSlackBlockActionContext,
} from "../src/slack-events.js";

describe("isProcessableSlackMessage", () => {
  it("processes plain messages with no subtype", () => {
    expect(isProcessableSlackMessage(undefined)).toBe(true);
    expect(isProcessableSlackMessage("")).toBe(true);
  });

  it("processes file_share — a real user message carrying an attachment", () => {
    expect(isProcessableSlackMessage("file_share")).toBe(true);
  });

  it("drops bot and system subtypes", () => {
    expect(isProcessableSlackMessage("bot_message")).toBe(false);
    expect(isProcessableSlackMessage("message_changed")).toBe(false);
    expect(isProcessableSlackMessage("message_deleted")).toBe(false);
    expect(isProcessableSlackMessage("channel_join")).toBe(false);
    expect(isProcessableSlackMessage("thread_broadcast")).toBe(false);
  });
});

describe("resolveSlackBlockActionContext", () => {
  it("prefers message fields and preserves a thread root", () => {
    expect(
      resolveSlackBlockActionContext({
        channel: { id: "C-message" },
        message: {
          ts: "200.2",
          thread_ts: "100.1",
          text: "question",
        },
        container: {
          channel_id: "C-container",
          message_ts: "300.3",
          thread_ts: "100.0",
        },
        user: { id: "U1" },
      }),
    ).toEqual({
      channelId: "C-message",
      messageTs: "200.2",
      threadTs: "100.1",
      userId: "U1",
      originalText: "question",
    });
  });

  it("falls back to the required container location fields", () => {
    expect(
      resolveSlackBlockActionContext({
        container: {
          channel_id: "C-container",
          message_ts: "300.3",
          thread_ts: "100.0",
        },
        user: { id: "U2" },
      }),
    ).toEqual({
      channelId: "C-container",
      messageTs: "300.3",
      threadTs: "100.0",
      userId: "U2",
      originalText: "",
    });
  });
});
