/**
 * Reproduction tests for the broken AskUserQuestion relay.
 *
 * Simulates how Claude Code's interactive AskUserQuestion tool renders
 * to the PTY screen and verifies what `detectUserPrompt` actually emits
 * to the Discord/Slack relay path.
 *
 * The intent here is *diagnosis*, not green-on-master: tests document
 * the failure modes so the actual fix can later assert the corrected
 * behaviour.
 */

import { describe, it, expect } from "vitest";
import { detectUserPrompt } from "../src/prompt-detector.js";

describe("AskUserQuestion → Slack/Discord relay reproduction", () => {
  it("collapses multi-section option block into one wall of text", () => {
    // What Claude Code's Ink UI roughly puts on the PTY when AskUserQuestion
    // fires with one question + two options. There are no blank lines inside
    // the widget — Ink draws the whole control as one contiguous block.
    const screen = [
      "Some prior tool output",
      "",
      "? 다음 단계는 무엇으로 진행할까요?",
      "  ❯ 1. A안: 즉시 커밋",
      "      working tree에 uncommitted 상태 — /push 쳐줘",
      "    2. B안: 다음 세션으로 deferred",
      "      네가 A/B 옵션 선택해주면 그때 진행할게",
      "    3. Other (custom answer)",
      "  ↑/↓ 선택  Enter 확인",
    ].join("\n");

    const result = detectUserPrompt(screen);

    // Failure mode #1: the question, every option, and the navigation hint
    // (↑/↓/Enter) are all glued into a single string and shoved into the
    // Slack template. The user sees a blob, not a question + choices.
    expect(result).toContain("↑/↓ 선택");
    expect(result).toContain("Enter 확인");
    expect(result?.split("\n").length).toBeGreaterThan(5);
  });

  it("emits literal ** and \\n tokens when previous turn embedded them in description", () => {
    // Reproduces the first screenshot. A prior Claude turn passed an option
    // `description` containing markdown asterisks and a literal "\n" (backslash-n,
    // not a real newline) — e.g. because it was hand-built as a single-line
    // string. Ink renders that string verbatim, so the asterisks AND the "\n"
    // travel through to Slack untouched.
    const description =
      "**working tree에 uncommitted 상태** — 커밋하려면 `/push` 쳐줘\\n• " +
      "**다음 단계(`make_cylinder` wire orientation fix)는 다음 세션으로 deferred** " +
      "— 네가 A/B 옵션 선택해주면 그때 진행할게\\n• /loop는 이번 응답으로 멈출게.";

    const screen = [
      "",
      "? 다음으로 진행할 옵션을 선택해주세요",
      `  ❯ ${description}`,
      "  ↑/↓ 선택  Enter 확인",
    ].join("\n");

    const result = detectUserPrompt(screen) ?? "";

    // The relayed text contains literal \n (escape token, not a real newline)
    // and bare ** markdown — exactly the artefacts visible in the user's screenshot.
    expect(result).toContain("\\n");
    expect(result).toContain("**");
    expect(result.includes("\n• ")).toBe(false); // no real line break before bullet
  });

  it("captures preview block with line numbers as if it were the question", () => {
    // Reproduces the second screenshot. AskUserQuestion's `preview` field is
    // rendered as a code/diff block directly under the focused option. Pattern 1
    // grabs everything up to the first blank line, so the entire preview lands
    // in `question`.
    const previewLines = [];
    for (let n = 723; n <= 761; n++) {
      previewLines.push(`${n} +   diff line content here`);
    }
    const screen = [
      "",
      "? 어느 변경 묶음을 진행할까요?",
      "  ❯ Phase-2B fix",
      ...previewLines,
      "  ↑/↓ 선택  Enter 확인",
    ].join("\n");

    const result = detectUserPrompt(screen) ?? "";

    // The "question" sent to Slack is dominated by diff content, not by the
    // actual user-facing question. This is exactly what produced the giant
    // wall-of-numbers screenshot.
    const lineCount = result.split("\n").length;
    expect(lineCount).toBeGreaterThan(35);
    expect(result).toContain("723 +");
    expect(result).toContain("761 +");
  });

  it("does not strip ANSI box-drawing characters that Ink uses around options", () => {
    // Ink frequently draws option boxes with U+2500-series characters and pipes.
    // ptyToText (in wrapper.ts) is only applied to the *log* path, not to the
    // captureScreen output that feeds detectUserPrompt — so these characters
    // survive into the relayed message.
    const screen = [
      "",
      "? 어떤 모델로 전환할까요?",
      "  ┌────────────────────┐",
      "  │ ❯ sonnet           │",
      "  │   opus             │",
      "  │   haiku            │",
      "  └────────────────────┘",
    ].join("\n");

    const result = detectUserPrompt(screen) ?? "";
    expect(result).toMatch(/[┌└│─]/);
  });
});
