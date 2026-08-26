import { describe, expect, it, vi } from "vitest";
import {
  findSlackConversationMessage,
  type SlackConversationApi,
} from "../src/slack-conversation.js";

function api(
  overrides: Partial<SlackConversationApi>,
): SlackConversationApi {
  return {
    replies: vi.fn(async () => ({ messages: [] })),
    history: vi.fn(async () => ({ messages: [] })),
    ...overrides,
  };
}

describe("findSlackConversationMessage", () => {
  it("requires an exact timestamp for top-level history", async () => {
    const exactApi = api({
      history: vi.fn(async () => ({
        messages: [{ ts: "100.2", user: "U1" }],
      })),
    });
    const adjacentApi = api({
      history: vi.fn(async () => ({
        messages: [{ ts: "100.1", user: "U2" }],
      })),
    });

    await expect(
      findSlackConversationMessage(exactApi, "C1", "100.2"),
    ).resolves.toMatchObject({ user: "U1" });
    await expect(
      findSlackConversationMessage(adjacentApi, "C1", "100.2"),
    ).resolves.toBeUndefined();
  });

  it("finds only messages returned by the exact thread", async () => {
    const replies = vi
      .fn()
      .mockResolvedValueOnce({
        messages: [{ ts: "200.1" }],
        response_metadata: { next_cursor: "next" },
      })
      .mockResolvedValueOnce({
        messages: [{ ts: "200.2", user: "U2" }],
      });
    const threadApi = api({ replies });

    await expect(
      findSlackConversationMessage(threadApi, "C1", "200.2", "200.0"),
    ).resolves.toMatchObject({ user: "U2" });
    expect(replies).toHaveBeenNthCalledWith(2, expect.objectContaining({
      channel: "C1",
      ts: "200.0",
      cursor: "next",
    }));
  });

  it("stops after 500 thread messages", async () => {
    const replies = vi.fn(async () => ({
      messages: Array.from({ length: 100 }, (_, index) => ({
        ts: String(index),
      })),
      response_metadata: { next_cursor: "again" },
    }));

    await expect(
      findSlackConversationMessage(api({ replies }), "C1", "missing", "1.0"),
    ).resolves.toBeUndefined();
    expect(replies).toHaveBeenCalledTimes(5);
  });
});
