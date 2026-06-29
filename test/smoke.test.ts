import { describe, expect, it } from "vitest";
import * as thrift from "../src/index.js";

describe("public API surface", () => {
  it("exports a version string", () => {
    expect(typeof thrift.VERSION).toBe("string");
    expect(thrift.VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exports the token estimator", () => {
    expect(typeof thrift.estimateTokens).toBe("function");
    expect(thrift.estimateTokens("abcd")).toBe(1);
  });
});
