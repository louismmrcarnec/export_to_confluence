import { describe, it, expect } from "vitest";
import { booleanOr } from "./helpers";

describe("booleanOr", () => {
  it("returns true when value is boolean true", () => {
    expect(booleanOr(true, false)).toBe(true);
  });

  it("returns false when value is boolean false", () => {
    expect(booleanOr(false, true)).toBe(false);
  });

  it("parses the string 'true' as true", () => {
    expect(booleanOr("true", false)).toBe(true);
  });

  it("parses the string 'false' as false", () => {
    expect(booleanOr("false", true)).toBe(false);
  });

  it("returns the fallback for null", () => {
    expect(booleanOr(null, true)).toBe(true);
    expect(booleanOr(null, false)).toBe(false);
  });

  it("returns the fallback for undefined", () => {
    expect(booleanOr(undefined, true)).toBe(true);
  });

  it("returns the fallback for unrecognised types", () => {
    expect(booleanOr(42, false)).toBe(false);
    expect(booleanOr({}, true)).toBe(true);
  });
});
