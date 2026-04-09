/**
 * Tests for prompt-detector module.
 *
 * Covers detection of interactive user prompts from Claude Code's
 * terminal screen output across all supported patterns.
 */

import { describe, it, expect } from "vitest";
import { detectUserPrompt } from "../src/prompt-detector.js";

describe("detectUserPrompt", () => {
  // ── Pattern 1: Ink-style "?" prompt ─────────────────────────────────

  describe("Ink-style question prompt (? prefix)", () => {
    it("detects a simple question with ? prefix", () => {
      const screen = [
        "Some output above",
        "",
        "? Do you want to proceed with this change?",
        "  ❯ Yes",
        "    No",
      ].join("\n");

      const result = detectUserPrompt(screen);
      expect(result).toBe(
        "Do you want to proceed with this change?\n❯ Yes\nNo",
      );
    });

    it("detects a question with indented ? prefix", () => {
      const screen = [
        "Processing...",
        "",
        "  ? Which file should I modify?",
        "    src/index.ts",
        "    src/app.ts",
      ].join("\n");

      const result = detectUserPrompt(screen);
      expect(result).toBe(
        "Which file should I modify?\nsrc/index.ts\nsrc/app.ts",
      );
    });

    it("stops collecting at empty line", () => {
      const screen = [
        "? Select an option",
        "  Option A",
        "  Option B",
        "",
        "Some unrelated text",
      ].join("\n");

      const result = detectUserPrompt(screen);
      expect(result).toBe("Select an option\nOption A\nOption B");
    });

    it("does not match ? in middle of text", () => {
      const screen = [
        "This is some output with a question mark?",
        "And another line",
      ].join("\n");

      const result = detectUserPrompt(screen);
      expect(result).toBeNull();
    });
  });

  // ── Pattern 2: "Type your answer" style prompts ────────────────────

  describe("input prompt phrases", () => {
    it("detects 'Type your answer' prompt", () => {
      const screen = [
        "Some context",
        "",
        "What is the target directory?",
        "Type your answer below:",
      ].join("\n");

      const result = detectUserPrompt(screen);
      expect(result).toBe(
        "What is the target directory?\nType your answer below:",
      );
    });

    it("detects 'Enter your response' prompt", () => {
      const screen = [
        "",
        "Please describe what you need.",
        "Enter your response:",
      ].join("\n");

      const result = detectUserPrompt(screen);
      expect(result).toBe(
        "Please describe what you need.\nEnter your response:",
      );
    });

    it("detects 'your choice' prompt", () => {
      const screen = [
        "Multiple options available:",
        "1) Option A",
        "2) Option B",
        "Enter your choice:",
      ].join("\n");

      const result = detectUserPrompt(screen);
      expect(result).toBe(
        "Multiple options available:\n1) Option A\n2) Option B\nEnter your choice:",
      );
    });
  });

  // ── Pattern 3: Input cursor at end of screen ─────────────────────

  describe("trailing input cursor", () => {
    it("detects > cursor at end", () => {
      const screen = [
        "Some context above",
        "",
        "Enter the file path:",
        "> ",
      ].join("\n");

      const result = detectUserPrompt(screen);
      expect(result).toBe("Enter the file path:\n>");
    });

    it("detects ❯ cursor at end", () => {
      const screen = [
        "Previous output",
        "",
        "Select an item:",
        "❯ ",
      ].join("\n");

      const result = detectUserPrompt(screen);
      expect(result).toBe("Select an item:\n❯");
    });

    it("does not match > in the middle of output", () => {
      const screen = [
        "> Some quoted text",
        "Normal text",
        "More normal text",
      ].join("\n");

      // Pattern 3 only triggers for trailing cursor; "> Some quoted text"
      // is not just ">" so it won't match as a bare cursor
      const result = detectUserPrompt(screen);
      expect(result).toBeNull();
    });
  });

  // ── Pattern 4: Known phrases ──────────────────────────────────────

  describe("known phrase detection", () => {
    it("detects 'has a question'", () => {
      const screen = [
        "Output line 1",
        "",
        "Claude has a question for you:",
        "What API key should I use?",
      ].join("\n");

      const result = detectUserPrompt(screen);
      expect(result).toBe(
        "Claude has a question for you:\nWhat API key should I use?",
      );
    });

    it("detects 'please select'", () => {
      const screen = [
        "",
        "Please select one of the following:",
        "- Production",
        "- Staging",
        "- Development",
      ].join("\n");

      const result = detectUserPrompt(screen);
      expect(result).toBe(
        "Please select one of the following:\n- Production\n- Staging\n- Development",
      );
    });

    it("detects Korean phrase '선택해'", () => {
      const screen = [
        "작업이 필요합니다.",
        "",
        "다음 중 하나를 선택해주세요:",
        "1. 옵션 A",
        "2. 옵션 B",
      ].join("\n");

      const result = detectUserPrompt(screen);
      expect(result).toBe(
        "다음 중 하나를 선택해주세요:\n1. 옵션 A\n2. 옵션 B",
      );
    });

    it("detects Korean phrase '답변해'", () => {
      const screen = [
        "",
        "질문이 있습니다. 답변해주세요.",
        "어떤 파일을 수정할까요?",
      ].join("\n");

      const result = detectUserPrompt(screen);
      expect(result).toBe(
        "질문이 있습니다. 답변해주세요.\n어떤 파일을 수정할까요?",
      );
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("returns null for empty screen", () => {
      expect(detectUserPrompt("")).toBeNull();
    });

    it("returns null for single-line screen", () => {
      expect(detectUserPrompt("Just one line")).toBeNull();
    });

    it("returns null for normal output with no prompt", () => {
      const screen = [
        "Building project...",
        "Compiling src/index.ts",
        "Compiling src/app.ts",
        "Build complete.",
      ].join("\n");

      expect(detectUserPrompt(screen)).toBeNull();
    });

    it("returns null for thinking spinner", () => {
      const screen = [
        "⠋ Thinking...",
        "Processing your request",
      ].join("\n");

      expect(detectUserPrompt(screen)).toBeNull();
    });

    it("handles screen with trailing whitespace lines", () => {
      const screen = [
        "? Choose a file",
        "  file_a.ts",
        "  file_b.ts",
        "   ",
        "   ",
      ].join("\n");

      const result = detectUserPrompt(screen);
      expect(result).toBe("Choose a file\nfile_a.ts\nfile_b.ts");
    });
  });
});
