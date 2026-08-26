import { describe, expect, it } from "vitest";
import {
  DEFAULT_FETCH_MESSAGE_LIMIT,
  MAX_FETCH_MESSAGE_LIMIT,
  normalizeFetchMessageLimit,
} from "../src/fetch-limit.js";

describe("normalizeFetchMessageLimit", () => {
  it.each([
    [undefined, DEFAULT_FETCH_MESSAGE_LIMIT],
    ["", DEFAULT_FETCH_MESSAGE_LIMIT],
    ["not-a-number", DEFAULT_FETCH_MESSAGE_LIMIT],
    [-1, DEFAULT_FETCH_MESSAGE_LIMIT],
    [1.5, DEFAULT_FETCH_MESSAGE_LIMIT],
    [1, 1],
    ["25", 25],
    [0, MAX_FETCH_MESSAGE_LIMIT],
    [500, MAX_FETCH_MESSAGE_LIMIT],
    [1_000_000, MAX_FETCH_MESSAGE_LIMIT],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeFetchMessageLimit(input)).toBe(expected);
  });
});
