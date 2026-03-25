/**
 * Tests for session-manager module.
 *
 * Covers session CRUD, usage tracking, and stale session cleanup.
 * Uses a temporary directory for persistence file isolation.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { unlinkSync } from "node:fs";
import { join } from "node:path";

// Mock config before importing SessionManager
vi.mock("../src/config.js", () => ({
  config: {
    discordBotToken: "test",
    defaultModel: "claude-sonnet-4-6",
    defaultCwd: "/tmp/test",
    maxTurns: 50,
    sessionTimeoutHours: 24,
    allowedChannelIds: ["chan-1", "chan-2"],

  },
}));

import { SessionManager } from "../src/session-manager.js";

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    try {
      unlinkSync(join(process.cwd(), "data", "sessions.json"));
    } catch {
      // File may not exist
    }
    manager = new SessionManager();
  });

  it("creates and retrieves a session", () => {
    manager.create("chan-1", "session-abc", "/tmp", "claude-sonnet-4-6");
    const session = manager.get("chan-1");

    expect(session).toBeDefined();
    expect(session!.sessionId).toBe("session-abc");
    expect(session!.cwd).toBe("/tmp");
    expect(session!.totalInputTokens).toBe(0);
  });

  it("returns undefined for nonexistent channel", () => {
    expect(manager.get("nonexistent")).toBeUndefined();
  });

  it("updates session fields", () => {
    manager.create("chan-1", "session-abc");
    manager.update("chan-1", { model: "claude-opus-4-6" });

    expect(manager.get("chan-1")!.model).toBe("claude-opus-4-6");
  });

  it("deletes a session", () => {
    manager.create("chan-1", "session-abc");
    manager.delete("chan-1");

    expect(manager.get("chan-1")).toBeUndefined();
  });

  it("tracks token usage", () => {
    manager.create("chan-1", "session-abc");
    manager.addUsage("chan-1", 1000, 500);
    manager.addUsage("chan-1", 2000, 800);

    const session = manager.get("chan-1")!;
    expect(session.totalInputTokens).toBe(3000);
    expect(session.totalOutputTokens).toBe(1300);
    expect(session.turnCount).toBe(2);
  });

  it("checks channel allowlist", () => {
    expect(manager.isChannelAllowed("chan-1")).toBe(true);
    expect(manager.isChannelAllowed("chan-2")).toBe(true);
    expect(manager.isChannelAllowed("chan-3")).toBe(false);
  });

  it("archives and restores sessions", () => {
    manager.create("chan-1", "session-aaa");
    manager.update("chan-1", { turnCount: 5 });

    expect(manager.archive("chan-1")).toBe(true);
    expect(manager.get("chan-1")).toBeUndefined();
    expect(manager.getHistory("chan-1")).toHaveLength(1);

    manager.create("chan-1", "session-bbb");

    const restored = manager.restore("chan-1", "session-aaa");
    expect(restored).toBeDefined();
    expect(restored!.sessionId).toBe("session-aaa");
    expect(restored!.turnCount).toBe(5);

    // Previous active session moved to history
    const hist = manager.getHistory("chan-1");
    expect(hist).toHaveLength(1);
    expect(hist[0].sessionId).toBe("session-bbb");
  });

  it("returns false when archiving non-existent session", () => {
    expect(manager.archive("no-such-channel")).toBe(false);
  });

  it("returns undefined when restoring non-existent session", () => {
    expect(manager.restore("chan-1", "no-such")).toBeUndefined();
  });
});
