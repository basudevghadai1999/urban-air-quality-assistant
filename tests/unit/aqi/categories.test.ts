import { describe, expect, it } from "vitest";

import { AQI_CATEGORIES, categorizeAqi, getCategory } from "@/lib/aqi";

// CPCB technical report, Table 3.2: category ranges.
describe("categorizeAqi", () => {
  it.each([
    [0, "good"],
    [50, "good"],
    [51, "satisfactory"],
    [100, "satisfactory"],
    [101, "moderately_polluted"],
    [200, "moderately_polluted"],
    [201, "poor"],
    [300, "poor"],
    [301, "very_poor"],
    [400, "very_poor"],
    [401, "severe"],
    [500, "severe"],
  ] as const)("AQI %i is %s", (aqi, id) => {
    expect(categorizeAqi(aqi).id).toBe(id);
  });

  it("rejects values outside 0-500", () => {
    expect(() => categorizeAqi(-1)).toThrow(RangeError);
    expect(() => categorizeAqi(501)).toThrow(RangeError);
  });

  it("rejects non-integers and non-finite values", () => {
    expect(() => categorizeAqi(50.5)).toThrow(RangeError);
    expect(() => categorizeAqi(Number.NaN)).toThrow(RangeError);
    expect(() => categorizeAqi(Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("AQI_CATEGORIES", () => {
  it("covers 0-500 contiguously with no gap or overlap", () => {
    expect(AQI_CATEGORIES[0]?.min).toBe(0);
    expect(AQI_CATEGORIES[AQI_CATEGORIES.length - 1]?.max).toBe(500);
    AQI_CATEGORIES.slice(1).forEach((category, i) => {
      expect(category.min).toBe((AQI_CATEGORIES[i]?.max ?? -2) + 1);
    });
  });

  it("has six ranked categories with CPCB labels", () => {
    expect(AQI_CATEGORIES.map((c) => c.label)).toEqual([
      "Good",
      "Satisfactory",
      "Moderately Polluted",
      "Poor",
      "Very Poor",
      "Severe",
    ]);
    expect(AQI_CATEGORIES.map((c) => c.rank)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("looks up a category by id", () => {
    expect(getCategory("poor")).toMatchObject({ min: 201, max: 300 });
  });
});
