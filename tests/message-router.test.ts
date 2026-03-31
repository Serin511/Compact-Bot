/**
 * Tests for message-router module.
 *
 * Covers command classification and argument extraction for all
 * supported commands and regular messages.
 */

import { describe, it, expect } from "vitest";
import { routeMessage } from "../src/message-router.js";

describe("routeMessage", () => {
  it("routes /compact without args", () => {
    expect(routeMessage("/compact")).toEqual({ type: "compact" });
  });

  it("routes /compact with focus hint", () => {
    expect(routeMessage("/compact API 변경사항 중심으로")).toEqual({
      type: "compact",
      args: "API 변경사항 중심으로",
    });
  });

  it("routes /clear", () => {
    expect(routeMessage("/clear")).toEqual({ type: "clear" });
  });

  it("routes /cost", () => {
    expect(routeMessage("/cost")).toEqual({ type: "cost" });
  });

  it("routes /status", () => {
    expect(routeMessage("/status")).toEqual({ type: "status" });
  });

  it("routes /model with arg", () => {
    expect(routeMessage("/model sonnet")).toEqual({
      type: "model",
      args: "sonnet",
    });
  });

  it("routes /model without arg", () => {
    expect(routeMessage("/model")).toEqual({ type: "model" });
  });

  it("routes /cwd with path", () => {
    expect(routeMessage("/cwd /home/user/projects/myapp")).toEqual({
      type: "cwd",
      args: "/home/user/projects/myapp",
    });
  });

  it("routes /help", () => {
    expect(routeMessage("/help")).toEqual({ type: "help" });
  });

  it("routes regular messages", () => {
    expect(routeMessage("Box를 만들어줘")).toEqual({
      type: "message",
      args: "Box를 만들어줘",
    });
  });

  it("trims whitespace from input", () => {
    expect(routeMessage("  /clear  ")).toEqual({ type: "clear" });
  });

  it("trims whitespace from args", () => {
    expect(routeMessage("/compact   focus hint   ")).toEqual({
      type: "compact",
      args: "focus hint",
    });
  });

  it("routes /capture", () => {
    expect(routeMessage("/capture")).toEqual({ type: "capture" });
  });

  it("does not match partial command names", () => {
    expect(routeMessage("/compacting")).toEqual({
      type: "message",
      args: "/compacting",
    });
  });
});
