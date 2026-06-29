import { describe, expect, it } from "vitest";
import { estimateTokens, estimateTokensAll } from "../src/tokens.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("rounds up partial tokens (a partial token still costs a whole token)", () => {
    expect(estimateTokens("ab")).toBe(1); // 2 chars / 4 -> ceil = 1
    expect(estimateTokens("abcd")).toBe(1); // exactly 4 -> 1
    expect(estimateTokens("abcde")).toBe(2); // 5 chars -> ceil(1.25) = 2
  });

  it("scales roughly with length", () => {
    expect(estimateTokens("a".repeat(40))).toBe(10);
  });
});

describe("estimateTokensAll", () => {
  it("sums across many strings", () => {
    expect(estimateTokensAll(["abcd", "abcd", "abcd"])).toBe(3);
  });

  it("returns 0 for an empty list", () => {
    expect(estimateTokensAll([])).toBe(0);
  });
});
