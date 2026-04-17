/**
 * End-to-end pipeline reproduction.
 *
 * Pushes raw bytes (with ANSI sequences) through the same xterm-headless
 * terminal that ``wrapper.ts`` uses, then runs the resulting screen text
 * through ``detectUserPrompt`` — exactly the path that produces the
 * Slack/Discord "Claude의 질문" message.
 */

import { describe, it, expect } from "vitest";
import xtermHeadless from "@xterm/headless";
import { detectUserPrompt } from "../src/prompt-detector.js";

const { Terminal } = xtermHeadless;

const PTY_COLS = 200;
const PTY_ROWS = 50;

/**
 * Mimic ``readScreenOnce(false)`` from ``src/wrapper.ts``.
 */
function readViewport(vterm: InstanceType<typeof Terminal>): Promise<string> {
  return new Promise((resolve) => {
    vterm.write("", () => {
      const buf = vterm.buffer.active;
      const lines: string[] = [];
      for (let i = buf.baseY; i < buf.baseY + PTY_ROWS; i++) {
        const line = buf.getLine(i);
        if (line) lines.push(line.translateToString(false));
      }
      while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
        lines.pop();
      }
      const maxLen = lines.reduce((m, l) => Math.max(m, l.trimEnd().length), 0);
      resolve(lines.map((l) => l.slice(0, maxLen)).join("\n"));
    });
  });
}

function makeTerm(): InstanceType<typeof Terminal> {
  return new Terminal({ cols: PTY_COLS, rows: PTY_ROWS, allowProposedApi: true });
}

describe("AskUserQuestion full pipeline (raw bytes → vterm → prompt-detector)", () => {
  it("relays the entire Ink widget — question, options, nav hint — as one blob", async () => {
    // Realistic byte stream: a colored "?" question mark, options with
    // a bold-cyan focused row, and a final dim navigation hint.
    const ESC = "\x1b";
    const RESET = `${ESC}[0m`;
    const CYAN_BOLD = `${ESC}[1;36m`;
    const DIM = `${ESC}[2m`;

    const raw =
      `Some prior tool output\r\n` +
      `\r\n` +
      `${CYAN_BOLD}?${RESET} 다음 단계는 무엇으로 진행할까요?\r\n` +
      `  ${CYAN_BOLD}❯ A안: 즉시 커밋${RESET}\r\n` +
      `      working tree에 uncommitted 상태\r\n` +
      `    B안: 다음 세션으로 deferred\r\n` +
      `      네가 옵션 선택해주면 그때 진행할게\r\n` +
      `    Other (custom answer)\r\n` +
      `  ${DIM}↑/↓ 선택  Enter 확인${RESET}\r\n`;

    const vterm = makeTerm();
    vterm.write(raw);
    const screen = await readViewport(vterm);
    const result = detectUserPrompt(screen);

    // The Slack relay text contains the navigation hint and every option
    // body — none of which the user actually wanted to read.
    expect(result).toContain("↑/↓ 선택");
    expect(result).toContain("Other (custom answer)");
    expect(result?.split("\n").length).toBeGreaterThan(5);
  });

  it("preserves literal `**` and `\\n` tokens that travelled in the description string", async () => {
    // What the previous Claude turn passed as a single-line description:
    const description =
      "**uncommitted 상태** — `/push` 쳐줘\\n• **다음 단계는 deferred** — A/B 선택해줘\\n• /loop 멈춤";

    const raw = `\r\n? 진행할 옵션 선택\r\n  ❯ ${description}\r\n  ↑/↓ 선택  Enter 확인\r\n`;

    const vterm = makeTerm();
    vterm.write(raw);
    const screen = await readViewport(vterm);
    const result = detectUserPrompt(screen) ?? "";

    expect(result).toContain("\\n");
    expect(result).toContain("**uncommitted");
    expect(result).toContain("`/push`");
    // No real newline before the bullet — proves the user sees one long line.
    expect(result.includes("\n• ")).toBe(false);
  });

  it("turns a multiline preview block into the 'question' itself", async () => {
    // The second screenshot: a diff `preview` rendered as part of the option,
    // with no blank line between it and the surrounding widget chrome.
    let preview = "";
    for (let n = 723; n <= 761; n++) preview += `${n} +   diff content line\r\n`;

    const raw =
      `\r\n? 어느 변경 묶음을 진행할까요?\r\n` +
      `  ❯ Phase-2B fix\r\n` +
      preview +
      `  ↑/↓ 선택  Enter 확인\r\n`;

    const vterm = makeTerm();
    vterm.write(raw);
    const screen = await readViewport(vterm);
    const result = detectUserPrompt(screen) ?? "";

    // The "question" Slack receives is dominated by diff lines.
    expect(result).toContain("723 +");
    expect(result).toContain("761 +");
    expect(result.split("\n").length).toBeGreaterThan(35);
  });
});
