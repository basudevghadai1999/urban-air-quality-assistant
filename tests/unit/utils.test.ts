import { describe, expect, it } from "vitest";

import { clamp, cn, isBlank, roundHalfUp, roundToDecimals } from "@/lib/utils";

describe("roundHalfUp", () => {
  it("rounds to the nearest integer", () => {
    expect(roundHalfUp(74.655)).toBe(75);
    expect(roundHalfUp(74.4)).toBe(74);
    expect(roundHalfUp(0)).toBe(0);
  });

  it("rounds exact halves up, not to even", () => {
    expect(roundHalfUp(0.5)).toBe(1);
    expect(roundHalfUp(1.5)).toBe(2);
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(150.5)).toBe(151);
  });

  it("absorbs float error just below a .5 tie", () => {
    expect(roundHalfUp(100.49999999999999)).toBe(100 + 1);
    expect(roundHalfUp(100.4999)).toBe(100);
  });
});

describe("roundToDecimals", () => {
  it("removes binary float noise", () => {
    expect(roundToDecimals(0.6 - 0.5, 6)).toBe(0.1);
    expect(roundToDecimals(1.1 * 1000, 6)).toBe(1100);
  });

  it("rounds to the requested places", () => {
    expect(roundToDecimals(3.14159, 2)).toBe(3.14);
    expect(roundToDecimals(2.5, 0)).toBe(3);
  });
});

describe("cn", () => {
  it("joins truthy class names", () => {
    expect(cn("a", "b")).toBe("a b");
  });

  it("skips false, null, undefined and empty strings", () => {
    expect(cn("a", false, null, undefined, "", "b")).toBe("a b");
  });

  it("returns an empty string when nothing is truthy", () => {
    expect(cn(false, null)).toBe("");
  });
});

describe("clamp", () => {
  it("returns the value when inside the range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("limits to the bounds, inclusive", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
    expect(clamp(0, 0, 10)).toBe(0);
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it("throws when min exceeds max", () => {
    expect(() => clamp(1, 5, 2)).toThrow(RangeError);
  });
});

describe("isBlank", () => {
  it("is true for null, undefined, empty and whitespace-only strings", () => {
    expect(isBlank(null)).toBe(true);
    expect(isBlank(undefined)).toBe(true);
    expect(isBlank("")).toBe(true);
    expect(isBlank(" \n\t")).toBe(true);
  });

  it("is false when the string has content", () => {
    expect(isBlank("a")).toBe(false);
    expect(isBlank(" a ")).toBe(false);
  });
});
