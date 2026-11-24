import { describe, expect, it } from "vitest";

import { canonicalUnit, convertConcentration, parseUnit } from "@/lib/aqi";

describe("parseUnit", () => {
  it.each([
    ["ug/m3", "ug/m3"],
    ["UG/M3", "ug/m3"],
    ["µg/m³", "ug/m3"], // micro sign + superscript three
    ["μg/m³", "ug/m3"], // Greek mu, as Open-Meteo labels it
    [" ug / m3 ", "ug/m3"],
    ["mg/m3", "mg/m3"],
    ["mg/m³", "mg/m3"],
  ] as const)("recognises %j", (raw, expected) => {
    expect(parseUnit(raw)).toBe(expected);
  });

  it.each(["ppm", "ppb", "g/m3", "ng/m3", "", "ug", "m3"])("rejects %j", (raw) => {
    expect(parseUnit(raw)).toBeNull();
  });
});

describe("convertConcentration (explicit; 1 mg/m3 = 1000 ug/m3)", () => {
  it("converts ug/m3 to mg/m3", () => {
    expect(convertConcentration(1000, "ug/m3", "mg/m3")).toBe(1);
    expect(convertConcentration(2500, "ug/m3", "mg/m3")).toBe(2.5);
    expect(convertConcentration(0, "ug/m3", "mg/m3")).toBe(0);
  });

  it("converts mg/m3 to ug/m3", () => {
    expect(convertConcentration(1, "mg/m3", "ug/m3")).toBe(1000);
    expect(convertConcentration(34, "mg/m3", "ug/m3")).toBe(34000);
  });

  it("removes binary float noise", () => {
    // Raw IEEE-754 multiplication is not exact for these inputs:
    expect(16.1 * 1000).not.toBe(16100);
    expect(1.005 * 1000).not.toBe(1005);
    expect(convertConcentration(16.1, "mg/m3", "ug/m3")).toBe(16100);
    expect(convertConcentration(1.005, "mg/m3", "ug/m3")).toBe(1005);
    expect(convertConcentration(16100, "ug/m3", "mg/m3")).toBe(16.1);
  });

  it("returns the value unchanged for identical units", () => {
    expect(convertConcentration(42.5, "ug/m3", "ug/m3")).toBe(42.5);
  });

  it("round-trips", () => {
    for (const v of [0.1, 0.7, 1.9, 10.1, 17.1, 33.99]) {
      expect(convertConcentration(convertConcentration(v, "mg/m3", "ug/m3"), "ug/m3", "mg/m3")).toBe(v);
    }
  });

  it("rejects non-finite input", () => {
    expect(() => convertConcentration(Number.NaN, "ug/m3", "mg/m3")).toThrow(RangeError);
    expect(() => convertConcentration(Number.POSITIVE_INFINITY, "mg/m3", "ug/m3")).toThrow(RangeError);
  });
});

describe("canonicalUnit", () => {
  it("is mg/m3 for CO and ug/m3 for every other pollutant", () => {
    expect(canonicalUnit("co")).toBe("mg/m3");
    for (const id of ["pm25", "pm10", "no2", "so2", "o3", "nh3", "pb"] as const) {
      expect(canonicalUnit(id)).toBe("ug/m3");
    }
  });
});
