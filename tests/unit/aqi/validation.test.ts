import { describe, expect, it } from "vitest";

import {
  checkSufficiency,
  isPollutantId,
  validateConcentrationValue,
  validateReadings,
  validateUnit,
  type PollutantReading,
} from "@/lib/aqi";

const reading = (pollutant: string, value: number | null | undefined, unit = "ug/m3"): PollutantReading => ({
  pollutant,
  value,
  unit,
});

describe("validateConcentrationValue", () => {
  it("accepts zero and positive finite numbers", () => {
    expect(validateConcentrationValue(0)).toBeNull();
    expect(validateConcentrationValue(12.5)).toBeNull();
  });

  it.each([
    [-0.001, "NEGATIVE_VALUE"],
    [-50, "NEGATIVE_VALUE"],
    [Number.NaN, "NAN_VALUE"],
    [Number.POSITIVE_INFINITY, "INFINITE_VALUE"],
    [Number.NEGATIVE_INFINITY, "INFINITE_VALUE"],
    ["12", "INVALID_VALUE_TYPE"],
    [null, "INVALID_VALUE_TYPE"],
    [undefined, "INVALID_VALUE_TYPE"],
    [{}, "INVALID_VALUE_TYPE"],
  ] as const)("rejects %j as %s", (value, code) => {
    expect(validateConcentrationValue(value)?.code).toBe(code);
  });

  it("names the pollutant in the issue", () => {
    expect(validateConcentrationValue(-1, "pm25")).toMatchObject({ pollutant: "pm25" });
  });
});

describe("validateUnit", () => {
  it("accepts each pollutant's CPCB unit, in any spelling", () => {
    expect(validateUnit("μg/m³", "pm25")).toEqual({ unit: "ug/m3", issue: null });
    expect(validateUnit("mg/m3", "co")).toEqual({ unit: "mg/m3", issue: null });
  });

  it("rejects an unrecognised unit", () => {
    expect(validateUnit("ppm", "pm25").issue?.code).toBe("UNKNOWN_UNIT");
    expect(validateUnit(undefined, "pm25").issue?.code).toBe("UNKNOWN_UNIT");
  });

  it("rejects CO in ug/m3 (and others in mg/m3) instead of converting", () => {
    const co = validateUnit("ug/m3", "co");
    expect(co.issue?.code).toBe("UNIT_MISMATCH");
    expect(co.issue?.message).toMatch(/convertConcentration/);
    expect(validateUnit("mg/m3", "pm10").issue?.code).toBe("UNIT_MISMATCH");
  });
});

describe("isPollutantId", () => {
  it("recognises the eight CPCB pollutants only", () => {
    for (const id of ["pm25", "pm10", "no2", "so2", "o3", "co", "nh3", "pb"]) {
      expect(isPollutantId(id)).toBe(true);
    }
    for (const bad of ["PM2.5", "co2", "", "pm2.5", null, 25]) {
      expect(isPollutantId(bad)).toBe(false);
    }
  });
});

describe("validateReadings", () => {
  it("returns valid readings in canonical pollutant order", () => {
    const result = validateReadings([reading("no2", 20), reading("pm10", 80), reading("pm25", 40)]);
    expect(result.issues).toEqual([]);
    expect(result.valid.map((r) => r.pollutant)).toEqual(["pm25", "pm10", "no2"]);
  });

  it("flags an empty dataset", () => {
    expect(validateReadings([]).issues.map((i) => i.code)).toEqual(["EMPTY_DATASET"]);
  });

  it("treats null and undefined as missing, never as zero", () => {
    const result = validateReadings([reading("pm25", null), reading("pm10", undefined), reading("no2", 0)]);
    expect(result.issues).toEqual([]);
    expect(result.missing).toEqual(["pm25", "pm10"]);
    expect(result.valid).toEqual([{ pollutant: "no2", value: 0 }]);
  });

  it("separates unsupported identifiers without failing", () => {
    const result = validateReadings([reading("pm25", 10), reading("co2", 400), reading("PM2.5", 5)]);
    expect(result.unsupported).toEqual(["co2", "PM2.5"]);
    expect(result.issues).toEqual([]);
  });

  it("rejects negative, NaN and infinite concentrations", () => {
    const result = validateReadings([
      reading("pm25", -1),
      reading("pm10", Number.NaN),
      reading("no2", Number.POSITIVE_INFINITY),
    ]);
    expect(result.issues.map((i) => i.code)).toEqual(["NEGATIVE_VALUE", "NAN_VALUE", "INFINITE_VALUE"]);
    expect(result.valid).toEqual([]);
  });

  it("rejects invalid units and does not keep that reading", () => {
    const result = validateReadings([reading("co", 1500, "ug/m3"), reading("pm25", 10, "ppm")]);
    expect(result.issues.map((i) => i.code)).toEqual(["UNIT_MISMATCH", "UNKNOWN_UNIT"]);
    expect(result.valid).toEqual([]);
  });

  it("rejects a pollutant listed twice", () => {
    const result = validateReadings([reading("pm25", 10), reading("pm25", 20)]);
    expect(result.issues.map((i) => i.code)).toEqual(["DUPLICATE_POLLUTANT"]);
    expect(result.valid).toEqual([{ pollutant: "pm25", value: 10 }]);
  });

  it("reports which supported pollutants were present", () => {
    const result = validateReadings([reading("pm25", null), reading("no2", 10)]);
    expect(result.recognised).toEqual(["pm25", "no2"]);
  });
});

describe("checkSufficiency (CPCB: 3 pollutants incl. PM2.5 or PM10)", () => {
  it("accepts three pollutants with PM2.5", () => {
    expect(checkSufficiency(["pm25", "no2", "so2"])).toMatchObject({ sufficient: true, reasons: [] });
  });

  it("accepts three pollutants with PM10 only", () => {
    expect(checkSufficiency(["pm10", "o3", "co"]).sufficient).toBe(true);
  });

  it("accepts all eight", () => {
    expect(checkSufficiency(["pm25", "pm10", "no2", "so2", "o3", "co", "nh3", "pb"]).availableCount).toBe(8);
  });

  it("rejects two pollutants even with particulate matter", () => {
    const result = checkSufficiency(["pm25", "pm10"]);
    expect(result.sufficient).toBe(false);
    expect(result.reasons).toEqual(["INSUFFICIENT_POLLUTANT_COUNT"]);
  });

  it("rejects three pollutants with no particulate matter", () => {
    const result = checkSufficiency(["no2", "so2", "o3"]);
    expect(result.sufficient).toBe(false);
    expect(result.hasParticulateMatter).toBe(false);
    expect(result.reasons).toEqual(["MISSING_PARTICULATE_MATTER"]);
  });

  it("reports both reasons when both fail", () => {
    expect(checkSufficiency(["no2"]).reasons).toEqual([
      "INSUFFICIENT_POLLUTANT_COUNT",
      "MISSING_PARTICULATE_MATTER",
    ]);
  });

  it("handles an empty list", () => {
    expect(checkSufficiency([])).toMatchObject({ sufficient: false, availableCount: 0 });
  });

  it("does not double-count a repeated pollutant", () => {
    expect(checkSufficiency(["pm25", "pm25", "pm25"]).availableCount).toBe(1);
  });
});
