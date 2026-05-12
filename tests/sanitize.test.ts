/**
 * Tests for ``safeAttName`` and ``isSendablePath`` from src/sanitize.ts.
 *
 * Covers delimiter scrubbing for forge-resistance, fallback handling for
 * empty/null filenames, and the CONFIG_HOME boundary check that prevents
 * the reply tool from leaking bot state files.
 */

import { describe, it, expect } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeAttName, isSendablePath } from "../src/sanitize.js";
import { CONFIG_HOME, DATA_DIR } from "../src/paths.js";

describe("safeAttName", () => {
  it("replaces delimiter characters with underscores", () => {
    expect(safeAttName("hello[world]\n;done")).toBe("hello_world___done");
  });

  it("returns the fallback for null/empty input", () => {
    expect(safeAttName(null, "fallback")).toBe("fallback");
    expect(safeAttName("", "fallback")).toBe("fallback");
    expect(safeAttName("   ", "fallback")).toBe("fallback");
  });

  it("uses the default fallback when none provided", () => {
    expect(safeAttName(null)).toBe("file");
  });

  it("preserves benign characters", () => {
    expect(safeAttName("image (1).png")).toBe("image (1).png");
  });
});

describe("isSendablePath", () => {
  const outsideTmp = join(tmpdir(), `compact-bot-test-${Date.now()}`);

  it("accepts paths outside CONFIG_HOME", () => {
    mkdirSync(outsideTmp, { recursive: true });
    const f = join(outsideTmp, "okay.txt");
    writeFileSync(f, "ok");
    try {
      expect(isSendablePath(f)).toBe(true);
    } finally {
      rmSync(outsideTmp, { recursive: true, force: true });
    }
  });

  it("accepts paths inside the attachments inbox", () => {
    const attachmentsDir = join(DATA_DIR, "attachments");
    mkdirSync(attachmentsDir, { recursive: true });
    const f = join(attachmentsDir, "incoming.png");
    writeFileSync(f, "data");
    try {
      expect(isSendablePath(f)).toBe(true);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("rejects paths inside CONFIG_HOME but outside attachments", () => {
    mkdirSync(CONFIG_HOME, { recursive: true });
    const f = join(CONFIG_HOME, "secret.env.test");
    writeFileSync(f, "TOKEN=should-not-leak");
    try {
      expect(isSendablePath(f)).toBe(false);
    } finally {
      rmSync(f, { force: true });
    }
  });

  it("returns true for non-existent paths (let downstream report the error)", () => {
    expect(isSendablePath("/nonexistent/path/that/does/not/exist")).toBe(true);
  });
});
