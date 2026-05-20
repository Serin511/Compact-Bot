/**
 * Tests for slack-events module.
 *
 * Covers which Slack message subtypes are treated as processable user
 * input — in particular that file uploads (subtype "file_share") are not
 * dropped along with bot/system subtypes.
 */

import { describe, it, expect } from "vitest";
import { isProcessableSlackMessage } from "../src/slack-events.js";

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
