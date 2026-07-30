/**
 * Tests for the newline-aware ``chunkText`` splitter.
 *
 * Covers no-split passthrough, paragraph/line/space preference order,
 * and hard-cut fallback when no usable boundary lands past the
 * half-window.
 */

import { describe, it, expect } from "vitest";
import { chunkCodeBlock, chunkText } from "../src/chunk.js";

describe("chunkText", () => {
  it("returns the input unchanged when it fits", () => {
    expect(chunkText("hello", 10)).toEqual(["hello"]);
  });

  it("prefers a paragraph boundary over a line boundary", () => {
    const text = "first paragraph\nstill first\n\nsecond paragraph";
    const out = chunkText(text, 30);
    expect(out).toHaveLength(2);
    expect(out[0]).toBe("first paragraph\nstill first");
    expect(out[1]).toBe("second paragraph");
  });

  it("falls back to a line boundary when no paragraph is in range", () => {
    const text = "line a\nline b\nline c that is somewhat long";
    const out = chunkText(text, 14);
    expect(out[0]).toBe("line a\nline b");
  });

  it("falls back to a space when no line break is in range", () => {
    const text = "alpha beta gamma delta";
    const out = chunkText(text, 12);
    expect(out[0]).toBe("alpha beta");
    expect(out.join(" ").replace(/\s+/g, " ")).toContain("gamma delta");
  });

  it("hard-cuts when no boundary lands past half the window", () => {
    const text = "x".repeat(20) + " tail";
    const out = chunkText(text, 10);
    expect(out[0]).toHaveLength(10);
  });

  it("drops leading newlines on subsequent chunks", () => {
    // The split lands inside the run of newlines; the first chunk may
    // keep one trailing "\n" (it was the first half of the paragraph
    // boundary), but every following chunk must have no leading "\n".
    const text = "head\n\n\n\ntail";
    const out = chunkText(text, 5);
    expect(out[0].trimEnd()).toBe("head");
    expect(out[1]).toBe("tail");
  });

  it("throws on non-positive maxLen", () => {
    expect(() => chunkText("hi", 0)).toThrow();
  });
});

describe("chunkCodeBlock", () => {
  it("wraps every long-output chunk in an independent code fence", () => {
    const text = "x".repeat(50);
    const chunks = chunkCodeBlock(text, 24, "ansi");

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 24)).toBe(true);
    expect(chunks.every((chunk) => chunk.startsWith("```ansi\n"))).toBe(true);
    expect(chunks.every((chunk) => chunk.endsWith("\n```"))).toBe(true);
    expect(
      chunks
        .map((chunk) => chunk.slice("```ansi\n".length, -"\n```".length))
        .join(""),
    ).toBe(text);
  });

  it("keeps nested backticks from closing the outer platform fence", () => {
    const chunks = chunkCodeBlock("before ``` nested ``` after", 80);
    expect(chunks).toEqual([
      "```\nbefore ``\u200b` nested ``\u200b` after\n```",
    ]);
    expect(chunks[0].replaceAll("\u200b", "")).toBe(
      "```\nbefore ``` nested ``` after\n```",
    );
  });

  it("rejects a limit that cannot contain the fences", () => {
    expect(() => chunkCodeBlock("output", 7)).toThrow(
      /too small for code fences/,
    );
  });
});
