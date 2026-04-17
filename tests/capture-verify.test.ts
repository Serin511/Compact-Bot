/**
 * Verify that capture logic produces clean output without trailing padding.
 *
 * Simulates what the wrapper does: creates a virtual terminal at the new
 * PTY_COLS=75 width, writes Claude-CLI-style output (welcome banner, box
 * borders, short prompt line), then runs the same readScreenOnce logic
 * used in wrapper.ts and checks that each line has no trailing whitespace
 * and no padded-space wrapping.
 */

import { describe, it, expect } from "vitest";
import xtermHeadless from "@xterm/headless";

const { Terminal } = xtermHeadless;

const PTY_COLS = 75;
const PTY_ROWS = 50;

function readScreenOnce(vterm: InstanceType<typeof Terminal>, all: boolean): Promise<string> {
  return new Promise((resolve) => {
    vterm.write("", () => {
      const buf = vterm.buffer.active;
      const lines: string[] = [];
      const start = all ? 0 : buf.baseY;
      const end = all ? buf.length : buf.baseY + PTY_ROWS;
      for (let i = start; i < end; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(true).trimEnd());
      }
      while (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      resolve(lines.join("\n"));
    });
  });
}

describe("capture viewport trimming", () => {
  it("strips trailing whitespace from each line", async () => {
    const vterm = new Terminal({ cols: PTY_COLS, rows: PTY_ROWS, allowProposedApi: true });
    await new Promise<void>((r) => vterm.write("hello\r\n", () => r()));
    await new Promise<void>((r) => vterm.write("❯\r\n", () => r()));
    await new Promise<void>((r) => vterm.write("world short\r\n", () => r()));

    const screen = await readScreenOnce(vterm, false);
    const lines = screen.split("\n");

    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
    expect(lines).toEqual(["hello", "❯", "world short"]);
  });

  it("preserves leading indentation", async () => {
    const vterm = new Terminal({ cols: PTY_COLS, rows: PTY_ROWS, allowProposedApi: true });
    await new Promise<void>((r) => vterm.write("  indented\r\n    deeper\r\n", () => r()));
    const screen = await readScreenOnce(vterm, false);
    expect(screen).toBe("  indented\n    deeper");
  });

  it("drops trailing empty lines", async () => {
    const vterm = new Terminal({ cols: PTY_COLS, rows: PTY_ROWS, allowProposedApi: true });
    await new Promise<void>((r) => vterm.write("content\r\n\r\n\r\n", () => r()));
    const screen = await readScreenOnce(vterm, false);
    expect(screen).toBe("content");
  });

  it("keeps a full-width horizontal rule intact (no forced wrap)", async () => {
    const vterm = new Terminal({ cols: PTY_COLS, rows: PTY_ROWS, allowProposedApi: true });
    const rule = "─".repeat(PTY_COLS);
    await new Promise<void>((r) => vterm.write(`${rule}\r\n`, () => r()));
    const screen = await readScreenOnce(vterm, false);
    // With cols=75, the rule fits on one line and remains untouched.
    expect(screen).toBe(rule);
    expect(screen.split("\n")).toHaveLength(1);
  });

  it("produces no padded-space lines for a sparse prompt row", async () => {
    const vterm = new Terminal({ cols: PTY_COLS, rows: PTY_ROWS, allowProposedApi: true });
    await new Promise<void>((r) => vterm.write("─".repeat(PTY_COLS) + "\r\n", () => r()));
    await new Promise<void>((r) => vterm.write("❯ \r\n", () => r()));
    await new Promise<void>((r) => vterm.write("─".repeat(PTY_COLS) + "\r\n", () => r()));

    const screen = await readScreenOnce(vterm, false);
    const lines = screen.split("\n");
    expect(lines[1]).toBe("❯");
    // Every line fits within PTY_COLS
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(PTY_COLS);
    }
  });
});
