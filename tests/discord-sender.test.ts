/**
 * Tests for discord-sender module.
 *
 * Covers message splitting logic, tool use formatting,
 * and DiscordSender helper methods.
 */

import { describe, it, expect, vi } from "vitest";

import { splitMessage, formatToolUse, DiscordSender } from "../src/discord-sender.js";

describe("splitMessage", () => {
  it("returns single chunk for short messages", () => {
    const result = splitMessage("Hello, world!");
    expect(result).toEqual(["Hello, world!"]);
  });

  it("splits long messages at newline boundaries", () => {
    const line = "a".repeat(100) + "\n";
    const text = line.repeat(25); // 2525 chars
    const chunks = splitMessage(text, 1000);

    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1010); // small tolerance for code block closing
    }
    // Reassembled content should match original
    expect(chunks.join("")).toBe(text);
  });

  it("handles messages exactly at the limit", () => {
    const text = "x".repeat(1900);
    const result = splitMessage(text);
    expect(result).toEqual([text]);
  });

  it("handles empty string", () => {
    expect(splitMessage("")).toEqual([""]);
  });
});

describe("formatToolUse", () => {
  it("formats Read tool", () => {
    expect(formatToolUse("Read", { file_path: "src/main.py" })).toBe(
      "🔧 Read: `src/main.py`",
    );
  });

  it("formats Bash tool with truncation", () => {
    const longCmd = "python " + "x".repeat(200);
    const result = formatToolUse("Bash", { command: longCmd });
    expect(result.length).toBeLessThan(150);
    expect(result).toContain("...");
  });

  it("formats Grep tool", () => {
    expect(formatToolUse("Grep", { pattern: "TODO" })).toBe(
      "🔧 Grep: `TODO`",
    );
  });

  it("formats unknown tool", () => {
    expect(formatToolUse("CustomTool", {})).toBe("🔧 CustomTool");
  });
});

describe("DiscordSender", () => {
  function createMockMessage() {
    const mockMessage = {
      channel: {
        send: vi.fn().mockResolvedValue({ id: "bot-1" }),
      },
    } as unknown as import("discord.js").Message;
    return mockMessage;
  }

  describe("hasContent", () => {
    it("returns false when buffer is empty", () => {
      const sender = new DiscordSender(createMockMessage());
      expect(sender.hasContent()).toBe(false);
    });

    it("returns true after appendText", async () => {
      const sender = new DiscordSender(createMockMessage());
      await sender.appendText("hello");
      expect(sender.hasContent()).toBe(true);
    });

    it("returns false for whitespace-only buffer", async () => {
      const sender = new DiscordSender(createMockMessage());
      await sender.appendText("   ");
      expect(sender.hasContent()).toBe(false);
    });

    it("returns true after addToolUse", () => {
      const sender = new DiscordSender(createMockMessage());
      sender.addToolUse("Read", { file_path: "foo.ts" });
      expect(sender.hasContent()).toBe(true);
    });
  });

  describe("editCurrentMessage", () => {
    it("does nothing when no current message exists", async () => {
      const sender = new DiscordSender(createMockMessage());
      // Should not throw
      await sender.editCurrentMessage("test");
    });

    it("edits the current message after startProcessing", async () => {
      const mockEdit = vi.fn().mockResolvedValue(undefined);
      const mockMsg = createMockMessage();
      (mockMsg.channel as any).send = vi.fn().mockResolvedValue({
        id: "bot-1",
        edit: mockEdit,
      });

      const sender = new DiscordSender(mockMsg);
      await sender.startProcessing();
      await sender.editCurrentMessage("updated text");

      expect(mockEdit).toHaveBeenCalledWith("updated text");
    });
  });
});
