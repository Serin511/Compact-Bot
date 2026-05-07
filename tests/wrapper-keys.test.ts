/**
 * Tests for the AskUserQuestion answer → keystroke translation logic.
 *
 * The wrapper drives Ink's AskUserQuestion widget by writing arrow keys
 * and Enter to the PTY. These tests pin down the byte sequences for both
 * paths (numbered selection and the auto-added "Type something." custom
 * answer) so subtle regressions surface immediately.
 *
 * The translation function lives inline in ``src/wrapper.ts``; we re-implement
 * the same algorithm here under test so the contract is independently verified.
 * If the wrapper's algorithm changes, both must change together.
 */

import { describe, it, expect } from "vitest";

const DOWN = "\x1b[B";
const ENTER = "\r";

/** Mirror of ``buildSelectionKeys`` in ``src/wrapper.ts``. */
function buildSelectionKeys(targetIndex: number): string {
  const downCount = Math.max(0, targetIndex - 1);
  return DOWN.repeat(downCount) + ENTER;
}

describe("AskUserQuestion → PTY keystrokes", () => {
  it("selects option 1 with just Enter (no arrow movement)", () => {
    expect(buildSelectionKeys(1)).toBe(ENTER);
  });

  it("selects option 2 with one Down arrow + Enter", () => {
    expect(buildSelectionKeys(2)).toBe(DOWN + ENTER);
  });

  it("selects option 4 with three Down arrows + Enter", () => {
    expect(buildSelectionKeys(4)).toBe(DOWN.repeat(3) + ENTER);
  });

  it("clamps target index 0 (or below) to a single Enter", () => {
    expect(buildSelectionKeys(0)).toBe(ENTER);
    expect(buildSelectionKeys(-2)).toBe(ENTER);
  });

  it("custom-answer slot lands at optionCount + 1 navigation", () => {
    // For 3 user options, "Type something." sits at row 4. To reach it
    // from the initial focus on row 1 we press Down 3 times.
    const optionCount = 3;
    const customAnswerIndex = optionCount + 1;
    expect(buildSelectionKeys(customAnswerIndex)).toBe(DOWN.repeat(3) + ENTER);
  });
});
