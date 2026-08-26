import { describe, expect, it } from "vitest";
import {
  isAllowedChannel,
  isOperator,
  isPrivilegedCommand,
} from "../src/access-control.js";

describe("isAllowedChannel", () => {
  it("preserves the empty-list means all compatibility contract", () => {
    expect(isAllowedChannel("channel-a", [])).toBe(true);
  });

  it("rejects channels outside an explicit routing boundary", () => {
    expect(isAllowedChannel("channel-a", ["channel-a", "channel-b"])).toBe(true);
    expect(isAllowedChannel("channel-c", ["channel-a", "channel-b"])).toBe(false);
  });
});

describe("isOperator", () => {
  it("preserves trusted-channel compatibility when no IDs are configured", () => {
    expect(isOperator(undefined, [])).toBe(true);
    expect(isOperator("any-user", [])).toBe(true);
  });

  it("accepts only configured operator IDs when the list is non-empty", () => {
    expect(isOperator("owner", ["owner", "backup"])).toBe(true);
    expect(isOperator("member", ["owner", "backup"])).toBe(false);
    expect(isOperator(undefined, ["owner"])).toBe(false);
  });
});

describe("isPrivilegedCommand", () => {
  it("keeps normal messages and help public", () => {
    expect(isPrivilegedCommand("message")).toBe(false);
    expect(isPrivilegedCommand("help")).toBe(false);
  });

  it.each([
    "new",
    "clear",
    "compact",
    "model",
    "effort",
    "cwd",
    "capture",
    "esc",
    "raw",
    "goal",
  ] as const)("treats %s as operator-only", (type) => {
    expect(isPrivilegedCommand(type)).toBe(true);
  });
});
