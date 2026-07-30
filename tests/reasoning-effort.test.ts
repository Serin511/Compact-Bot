import { describe, expect, it } from "vitest";
import {
  KNOWN_REASONING_EFFORTS,
  normalizeReasoningEffort,
} from "../src/reasoning-effort.js";

describe("reasoning effort", () => {
  it("recognizes every Codex effort level used by the command", () => {
    for (const effort of KNOWN_REASONING_EFFORTS) {
      expect(normalizeReasoningEffort(effort)).toBe(effort);
    }
  });

  it("normalizes whitespace and case", () => {
    expect(normalizeReasoningEffort("  ULTRA ")).toBe("ultra");
  });

  it("rejects unknown values", () => {
    expect(normalizeReasoningEffort("extreme")).toBeNull();
  });
});
