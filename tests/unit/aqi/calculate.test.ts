import { describe, expect, it } from "vitest";

import {
  BREAKPOINTS,
  OPEN_METEO_MODEL_SOURCE,
  POLLUTANT_IDS,
  calculateAqi,
  calculateAqiFromTimeSeries,
  calculateSubIndex,
  convertConcentration,
  type AqiInput,
  type AqiResult,
  type Observation,
  type PollutantId,
  type PollutantReading,
  type ValidAqiResult,
} from "@/lib/aqi";

/*
 * Expected values below are computed by hand from CPCB's formula using the
 * Table 3.11 breakpoints (see the arithmetic in each comment). Only the three
 * PM2.5 figures in "CPCB published examples" are CPCB-published numbers; every
 * scenario input is a SYNTHETIC test fixture, not measured data.
 */

const FIXED_TIME = "2025-01-15T12:00:00Z";

const ug = (pollutant: PollutantId, value: number | null): PollutantReading => ({
  pollutant,
  value,
  unit: pollutant === "co" ? "mg/m3" : "ug/m3",
});

const run = (readings: PollutantReading[], extra: Partial<AqiInput> = {}): AqiResult =>
  calculateAqi({ readings, calculatedAt: FIXED_TIME, ...extra });

function expectValid(result: AqiResult): ValidAqiResult {
  expect(result.status).toBe("valid");
  if (result.status !== "valid") throw new Error(`expected valid, got ${result.status}`);
  return result;
}

describe("CPCB published examples (About_AQI.pdf, How_AQI_Calculated.pdf)", () => {
  // "the sub-index for PM2.5 will be 51 at concentration 31, 100 at 60, and 75 at 45 ug/m3"
  it("PM2.5 31 ug/m3 -> 51", () => {
    expect(calculateSubIndex("pm25", 31).index).toBe(51);
  });

  it("PM2.5 60 ug/m3 -> 100", () => {
    expect(calculateSubIndex("pm25", 60).index).toBe(100);
  });

  it("PM2.5 45 ug/m3 -> 75 (74.66 rounds to nearest; truncation would give 74)", () => {
    const sub = calculateSubIndex("pm25", 45);
    expect(sub.exact).toBeCloseTo(74.655172, 5);
    expect(sub.index).toBe(75);
  });
});

describe("calculateSubIndex: breakpoint boundaries for all eight pollutants", () => {
  for (const pollutant of POLLUTANT_IDS) {
    const { bands, reportingStep } = BREAKPOINTS[pollutant];
    const bounded = bands.slice(0, 5);

    it(`${pollutant}: band endpoints map exactly to the band's AQI endpoints`, () => {
      for (const band of bounded) {
        expect(calculateSubIndex(pollutant, band.concentrationLow).exact).toBeCloseTo(band.indexLow, 9);
        expect(calculateSubIndex(pollutant, band.concentrationHigh ?? Number.NaN).exact).toBeCloseTo(band.indexHigh, 9);
      }
    });

    it(`${pollutant}: just below a band's low stays between the bands' AQI values`, () => {
      bounded.slice(1).forEach((band, i) => {
        const previous = bounded[i];
        const exact = calculateSubIndex(pollutant, band.concentrationLow - 1e-6).exact;
        expect(exact).toBeGreaterThanOrEqual(previous?.indexHigh ?? Infinity);
        expect(exact).toBeLessThanOrEqual(band.indexLow);
      });
    });

    it(`${pollutant}: just above a band's high stays between the bands' AQI values`, () => {
      bounded.forEach((band, i) => {
        const next = bands[i + 1];
        const exact = calculateSubIndex(pollutant, (band.concentrationHigh ?? Number.NaN) + 1e-6).exact;
        expect(exact).toBeGreaterThanOrEqual(band.indexHigh);
        expect(exact).toBeLessThanOrEqual(next?.indexLow ?? -Infinity);
      });
    });

    it(`${pollutant}: Severe begins at 401, one reporting step above Very Poor`, () => {
      const veryPoorHigh = bands[4]?.concentrationHigh ?? Number.NaN;
      expect(calculateSubIndex(pollutant, veryPoorHigh).index).toBe(400);
      const severeStart = calculateSubIndex(pollutant, veryPoorHigh + reportingStep);
      expect(severeStart.index).toBe(401);
      expect(severeStart.category).toBe("severe");
    });

    it(`${pollutant}: zero concentration scores 0`, () => {
      expect(calculateSubIndex(pollutant, 0)).toMatchObject({ exact: 0, index: 0, category: "good" });
    });

    it(`${pollutant}: sub-index never decreases as concentration rises, and stays within 0-500`, () => {
      const top = (BREAKPOINTS[pollutant].segments.at(-1)?.concentrationHigh ?? 1) * 1.15;
      let previous = -1;
      for (let step = 0; step <= 3000; step += 1) {
        const exact = calculateSubIndex(pollutant, (top * step) / 3000).exact;
        expect(exact).toBeGreaterThanOrEqual(previous);
        expect(exact).toBeLessThanOrEqual(500);
        previous = exact;
      }
    });
  }
});

describe("calculateSubIndex: interpolation", () => {
  it("interpolates the midpoint of a band (PM10 175.5 in 101-250 -> 101-200)", () => {
    // (200-101)/(250-101) x (175.5-101) + 101 = 150.5
    const sub = calculateSubIndex("pm10", 175.5);
    expect(sub.exact).toBeCloseTo(150.5, 9);
    expect(sub.index).toBe(151); // .5 rounds up
  });

  it("handles decimal concentrations (PM2.5 45.5 -> 75.5 -> 76)", () => {
    // 49/29 x 14.5 + 51 = 75.5
    const sub = calculateSubIndex("pm25", 45.5);
    expect(sub.exact).toBeCloseTo(75.5, 9);
    expect(sub.index).toBe(76);
  });

  it("applies the formula with CO in mg/m3 (5 in 2.1-10 -> 101-200)", () => {
    // 99/7.9 x 2.9 + 101 = 137.34
    expect(calculateSubIndex("co", 5).index).toBe(137);
    expect(calculateSubIndex("co", 1.1).index).toBe(51);
  });

  it("applies the formula to O3, SO2, NH3 and Pb", () => {
    expect(calculateSubIndex("o3", 120).index).toBe(129); // 99/67 x 19 + 101 = 129.07
    expect(calculateSubIndex("so2", 100).index).toBe(107); // 99/299 x 19 + 101 = 107.29
    expect(calculateSubIndex("nh3", 500).index).toBe(126); // 99/399 x 99 + 101 = 125.56
  });

  it("rounds an exact .5 up, not to even", () => {
    // PM10 at the 101-250 band midpoint is exactly 150.5; PM2.5 45.5 is exactly 75.5.
    expect(calculateSubIndex("pm10", 175.5).index).toBe(151);
    expect(calculateSubIndex("pm25", 45.5).index).toBe(76);
  });

  it("records the concentration, unit, averaging period and exact value", () => {
    const sub = calculateSubIndex("co", 5);
    expect(sub.concentration).toEqual({
      value: 5,
      unit: "mg/m3",
      averagingHours: 8,
      basis: "window-average",
    });
    expect(sub.segment.kind).toBe("band");
  });

  it("interpolates across the gap between published bands, never jumping", () => {
    // PM2.5 30 -> 50 and 31 -> 51; 30.5 lies in the gap: 50 + (30.5-30) x (51-50)/(31-30) = 50.5
    const gap = calculateSubIndex("pm25", 30.5);
    expect(gap.segment.kind).toBe("inter-band");
    expect(gap.exact).toBeCloseTo(50.5, 9);
    expect(gap.index).toBe(51);
    expect(calculateSubIndex("pm25", 60.5).index).toBe(101); // 100.5
    expect(calculateSubIndex("pb", 0.55).index).toBe(51); // 50.5, gap between 0.5 and 0.6
  });
});

describe("calculateSubIndex: Severe handling", () => {
  it("PM2.5 250 is the top of Very Poor (400); above it is Severe", () => {
    expect(calculateSubIndex("pm25", 250)).toMatchObject({ index: 400, category: "very_poor" });
    expect(calculateSubIndex("pm25", 250.5).index).toBe(401); // 400.5, still the 400 -> 401 link
    expect(calculateSubIndex("pm25", 251)).toMatchObject({ index: 401, category: "severe" });
  });

  it("extrapolates Severe with Very Poor's concentration width and flags it", () => {
    // Very Poor spans 121-250 (129 wide), so Severe is assumed to span 251-380.
    // 401 + (300-251) x 99/129 = 438.60
    const sub = calculateSubIndex("pm25", 300);
    expect(sub.exact).toBeCloseTo(438.604651, 5);
    expect(sub.index).toBe(439);
    expect(sub.category).toBe("severe");
    expect(sub.segment.kind).toBe("severe-extrapolated");
  });

  it("reaches 500 at the assumed top of Severe and holds there", () => {
    expect(calculateSubIndex("pm25", 380).index).toBe(500);
    const capped = calculateSubIndex("pm25", 5000);
    expect(capped.index).toBe(500);
    expect(capped.exact).toBe(500);
    expect(capped.segment.kind).toBe("severe-capped");
  });

  it("'published-floor' reports Severe as 401 without inventing a slope", () => {
    const options = { severePolicy: "published-floor" } as const;
    expect(calculateSubIndex("pm25", 300, options)).toMatchObject({
      index: 401,
      category: "severe",
      segment: { kind: "severe-published-floor" },
    });
    expect(calculateSubIndex("pm25", 5000, options).index).toBe(401);
    // Below Severe the policy changes nothing.
    expect(calculateSubIndex("pm25", 45, options).index).toBe(75);
  });
});

describe("calculateSubIndex: rejects bad input", () => {
  it.each([-1, -0.0001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "throws RangeError for %s",
    (value) => {
      expect(() => calculateSubIndex("pm25", value)).toThrow(RangeError);
    },
  );
});

describe("calculateAqi: overall AQI is the maximum sub-index", () => {
  it("picks the worst pollutant and names it", () => {
    const result = expectValid(run([ug("pm25", 10), ug("pm10", 20), ug("no2", 15)]));
    // pm25: 50/30 x 10 = 16.67 -> 17; pm10: 20; no2: 50/40 x 15 = 18.75 -> 19
    expect(result.subIndices.map((s) => s.index)).toEqual([17, 20, 19]);
    expect(result.aqi).toBe(20);
    expect(result.dominantPollutant).toBe("pm10");
  });

  it("breaks an exact tie by canonical pollutant order", () => {
    // PM2.5 30 -> 50 and PM10 50 -> 50
    const result = expectValid(run([ug("pm10", 50), ug("pm25", 30), ug("no2", 10)]));
    expect(result.aqi).toBe(50);
    expect(result.dominantPollutant).toBe("pm25");
  });

  it("rounds the overall AQI from the unrounded maximum", () => {
    const result = expectValid(run([ug("pm25", 45.5), ug("pm10", 10), ug("no2", 10)]));
    expect(result.aqi).toBe(76);
  });
});

describe("calculateAqi: realistic scenarios (synthetic inputs)", () => {
  it("clean air -> Good", () => {
    const result = expectValid(run([ug("pm25", 10), ug("pm10", 20), ug("no2", 15)]));
    expect(result.aqi).toBe(20);
    expect(result.category.id).toBe("good");
  });

  it("moderate pollution -> Moderately Polluted, PM2.5-dominant", () => {
    // pm25 85: 99/29 x 24 + 101 = 182.93 -> 183; pm10 150: 99/149 x 49 + 101 = 133.56 -> 134; no2 60: 49/39 x 19 + 51 = 74.87 -> 75
    const result = expectValid(run([ug("pm25", 85), ug("pm10", 150), ug("no2", 60)]));
    expect(result.subIndices.map((s) => s.index)).toEqual([183, 134, 75]);
    expect(result.aqi).toBe(183);
    expect(result.dominantPollutant).toBe("pm25");
    expect(result.category.id).toBe("moderately_polluted");
  });

  it("severe PM2.5 pollution -> Severe, flagged as an estimate inside the band", () => {
    // pm25 300 -> 438.6 -> 439; pm10 380: 99/79 x 29 + 301 = 337.34 -> 337; no2 90: 99/99 x 9 + 101 = 110
    const result = expectValid(run([ug("pm25", 300), ug("pm10", 380), ug("no2", 90)]));
    expect(result.aqi).toBe(439);
    expect(result.category.id).toBe("severe");
    expect(result.dominantPollutant).toBe("pm25");
    expect(result.warnings.map((w) => w.code)).toContain("SEVERE_EXTRAPOLATED");
    const flagged = result.warnings.find((w) => w.code === "SEVERE_EXTRAPOLATED");
    expect(flagged?.pollutant).toBe("pm25");
  });

  it("PM10-dominant pollution -> Poor", () => {
    // pm10 300: 99/99 x 49 + 201 = 250; pm25 60 -> 100; no2 50: 49/39 x 9 + 51 = 62.3 -> 62
    const result = expectValid(run([ug("pm25", 60), ug("pm10", 300), ug("no2", 50)]));
    expect(result.aqi).toBe(250);
    expect(result.dominantPollutant).toBe("pm10");
    expect(result.category.id).toBe("poor");
  });

  it("missing CO: valid, CO listed as missing and never counted as zero", () => {
    const result = expectValid(run([ug("pm25", 60), ug("pm10", 90), ug("no2", 30), ug("co", null)]));
    expect(result.missingPollutants).toContain("co");
    expect(result.availablePollutants).not.toContain("co");
    expect(result.subIndices.find((s) => s.pollutant === "co")).toBeUndefined();
    expect(result.warnings.map((w) => w.code)).toContain("PARTIAL_POLLUTANT_COVERAGE");
  });

  it("missing Pb: valid, Pb listed as missing", () => {
    const result = expectValid(run([ug("pm25", 60), ug("pm10", 90), ug("no2", 30)]));
    expect(result.missingPollutants).toEqual(["so2", "o3", "co", "nh3", "pb"]);
  });

  it("only two pollutants -> insufficient data, with the sub-indices still reported", () => {
    const result = run([ug("pm25", 60), ug("pm10", 90)]);
    expect(result.status).toBe("insufficient_data");
    if (result.status !== "insufficient_data") return;
    expect(result.aqi).toBeNull();
    expect(result.category).toBeNull();
    expect(result.dominantPollutant).toBeNull();
    expect(result.reasons).toEqual(["INSUFFICIENT_POLLUTANT_COUNT"]);
    // pm25 60 -> 100; pm10 90 in 51-100 -> 51-100: (100-51)/(100-51) x (90-51) + 51 = 90
    expect(result.subIndices.map((s) => s.index)).toEqual([100, 90]);
    expect(result.completeness.requirementsMet).toBe(false);
  });

  it("three valid pollutants including PM2.5 -> valid", () => {
    const result = expectValid(run([ug("pm25", 60), ug("so2", 20), ug("o3", 30)]));
    expect(result.availablePollutantCount).toBe(3);
    expect(result.completeness).toMatchObject({ level: "partial", hasParticulateMatter: true, requirementsMet: true });
  });

  it("three pollutants without PM2.5 or PM10 -> insufficient data", () => {
    const result = run([ug("no2", 20), ug("so2", 20), ug("o3", 30)]);
    expect(result.status).toBe("insufficient_data");
    if (result.status === "insufficient_data") {
      expect(result.reasons).toEqual(["MISSING_PARTICULATE_MATTER"]);
    }
  });

  it("all eight pollutants -> full coverage and no partial-coverage warning", () => {
    const result = expectValid(
      run([
        ug("pm25", 40), ug("pm10", 80), ug("no2", 30), ug("so2", 20),
        ug("o3", 40), ug("co", 1.5), ug("nh3", 100), ug("pb", 0.3),
      ]),
    );
    expect(result.completeness.level).toBe("full");
    expect(result.missingPollutants).toEqual([]);
    expect(result.warnings.map((w) => w.code)).not.toContain("PARTIAL_POLLUTANT_COVERAGE");
  });
});

describe("calculateAqi: result states", () => {
  it("valid carries every contract field", () => {
    const result = expectValid(run([ug("pm25", 60), ug("pm10", 90), ug("no2", 30)]));
    expect(result.calculatedAt).toBe("2025-01-15T12:00:00.000Z");
    expect(result.methodology.name).toMatch(/CPCB/);
    expect(result.dataSource.kind).toBe("unspecified");
    expect(result.provenanceLabel).toMatch(/CPCB methodology/);
    expect(result.disclaimer).toMatch(/not an official CPCB/);
    expect(result.availablePollutantCount).toBe(3);
    expect(result.unsupportedPollutants).toEqual([]);
    expect(result.completeness.windows).toEqual([]);
  });

  it("never returns zero for unavailable data", () => {
    const result = run([ug("pm25", null), ug("pm10", null), ug("no2", null)]);
    expect(result.status).toBe("insufficient_data");
    expect(result.aqi).toBeNull();
    expect(result.aqi).not.toBe(0);
  });

  it("a genuine zero concentration is a valid reading, not missing", () => {
    const result = expectValid(run([ug("pm25", 0), ug("pm10", 0), ug("no2", 0)]));
    expect(result.aqi).toBe(0);
    expect(result.category.id).toBe("good");
  });

  it("invalid_input: empty dataset", () => {
    const result = run([]);
    expect(result.status).toBe("invalid_input");
    if (result.status === "invalid_input") {
      expect(result.issues.map((i) => i.code)).toEqual(["EMPTY_DATASET"]);
      expect(result.aqi).toBeNull();
    }
  });

  it.each([
    [-5, "NEGATIVE_VALUE"],
    [Number.NaN, "NAN_VALUE"],
    [Number.POSITIVE_INFINITY, "INFINITE_VALUE"],
  ] as const)("invalid_input: one bad concentration (%s) invalidates the whole calculation", (value, code) => {
    const result = run([ug("pm25", value), ug("pm10", 90), ug("no2", 30)]);
    expect(result.status).toBe("invalid_input");
    if (result.status === "invalid_input") {
      expect(result.issues.map((i) => i.code)).toEqual([code]);
      expect(result.subIndices).toEqual([]);
    }
  });

  it("invalid_input: reports every problem, not just the first", () => {
    const result = run([ug("pm25", -1), ug("pm25", 5), { pollutant: "pm10", value: 5, unit: "ppm" }]);
    expect(result.status).toBe("invalid_input");
    if (result.status === "invalid_input") {
      expect(result.issues.map((i) => i.code).sort()).toEqual(["DUPLICATE_POLLUTANT", "NEGATIVE_VALUE", "UNKNOWN_UNIT"]);
    }
  });

  it("invalid_input: an invalid calculatedAt", () => {
    const result = calculateAqi({
      readings: [ug("pm25", 60), ug("pm10", 90), ug("no2", 30)],
      calculatedAt: "yesterday",
    });
    expect(result.status).toBe("invalid_input");
    if (result.status === "invalid_input") {
      expect(result.issues[0]?.code).toBe("INVALID_TIMESTAMP");
    }
  });

  it("unsupported_data: nothing recognisable was supplied", () => {
    const result = run([
      { pollutant: "co2", value: 420, unit: "ppm" },
      { pollutant: "PM2.5", value: 10, unit: "ug/m3" },
    ]);
    expect(result.status).toBe("unsupported_data");
    expect(result.unsupportedPollutants).toEqual(["co2", "PM2.5"]);
    expect(result.aqi).toBeNull();
  });

  it("unsupported identifiers alongside valid ones are ignored with a warning", () => {
    const result = expectValid(
      run([ug("pm25", 60), ug("pm10", 90), ug("no2", 30), { pollutant: "co2", value: 420, unit: "ppm" }]),
    );
    expect(result.unsupportedPollutants).toEqual(["co2"]);
    expect(result.warnings.map((w) => w.code)).toContain("UNSUPPORTED_POLLUTANT_IGNORED");
  });

  it("is deterministic: identical input and clock give identical output", () => {
    const readings = [ug("pm25", 300), ug("pm10", 380), ug("no2", 90)];
    expect(run(readings)).toEqual(run(readings));
  });
});

describe("calculateAqi: CO unit handling", () => {
  it("rejects CO supplied in ug/m3 rather than converting it", () => {
    const result = run([
      ug("pm25", 60), ug("pm10", 90),
      { pollutant: "co", value: 1500, unit: "ug/m3" },
    ]);
    expect(result.status).toBe("invalid_input");
    if (result.status === "invalid_input") {
      expect(result.issues[0]).toMatchObject({ code: "UNIT_MISMATCH", pollutant: "co" });
    }
  });

  it("accepts CO after an explicit conversion", () => {
    // Open-Meteo-style CO of 1500 ug/m3 = 1.5 mg/m3 -> Satisfactory: 49/0.9 x 0.4 + 51 = 72.8 -> 73
    const co = convertConcentration(1500, "ug/m3", "mg/m3");
    const result = expectValid(run([ug("pm25", 10), ug("pm10", 20), { pollutant: "co", value: co, unit: "mg/m3" }]));
    const sub = result.subIndices.find((s) => s.pollutant === "co");
    expect(sub?.index).toBe(73);
    expect(sub?.concentration.unit).toBe("mg/m3");
  });

  it("accepts a provider's unit spelling, Greek mu included", () => {
    const result = expectValid(
      run([
        { pollutant: "pm25", value: 60, unit: "μg/m³" },
        { pollutant: "pm10", value: 90, unit: "µg/m³" },
        { pollutant: "no2", value: 30, unit: "UG/M3" },
      ]),
    );
    expect(result.availablePollutantCount).toBe(3);
  });
});

describe("calculateAqi: ozone 1-hour rule (Table 3.8 / 3.11 footnote)", () => {
  const base = [ug("pm25", 60), ug("pm10", 90)];

  it("uses the 1-hour value when the 8-hour average exceeds 208 ug/m3", () => {
    // 1-hour 800 is Severe: 401 + (800-749) x 99/539 = 410.37 -> 410
    const result = expectValid(run([...base, ug("o3", 250)], { ozoneOneHour: { value: 800, unit: "ug/m3" } }));
    const o3 = result.subIndices.find((s) => s.pollutant === "o3");
    expect(o3?.index).toBe(410);
    expect(o3?.concentration).toMatchObject({ value: 800, basis: "one-hour-value" });
    expect(result.warnings.map((w) => w.code)).toContain("OZONE_ONE_HOUR_USED");
  });

  it("falls back to the 8-hour value with a warning when no 1-hour value is given", () => {
    const result = expectValid(run([...base, ug("o3", 250)]));
    const o3 = result.subIndices.find((s) => s.pollutant === "o3");
    expect(o3?.concentration.basis).toBe("window-average");
    expect(result.warnings.map((w) => w.code)).toContain("OZONE_ONE_HOUR_MISSING");
  });

  it("ignores the 1-hour value when the 8-hour average is at or below 208", () => {
    const result = expectValid(run([...base, ug("o3", 208)], { ozoneOneHour: { value: 900, unit: "ug/m3" } }));
    const o3 = result.subIndices.find((s) => s.pollutant === "o3");
    expect(o3?.index).toBe(300);
    expect(o3?.concentration.basis).toBe("window-average");
    expect(result.warnings.map((w) => w.code)).not.toContain("OZONE_ONE_HOUR_USED");
  });

  it("rejects an invalid 1-hour value", () => {
    const result = run([...base, ug("o3", 250)], { ozoneOneHour: { value: -1, unit: "ug/m3" } });
    expect(result.status).toBe("invalid_input");
  });
});

describe("calculateAqi: provenance", () => {
  const readings = [ug("pm25", 60), ug("pm10", 90), ug("no2", 30)];

  it("labels Open-Meteo results as estimates, separate from the methodology", () => {
    const result = expectValid(run(readings, { dataSource: OPEN_METEO_MODEL_SOURCE }));
    expect(result.provenanceLabel).toBe(
      "Estimated Indian AQI — calculated using CPCB methodology and Open-Meteo model data.",
    );
    expect(result.dataSource).toEqual(OPEN_METEO_MODEL_SOURCE);
    expect(result.methodology.name).toBe("CPCB National Air Quality Index (Indian AQI)");
    expect(JSON.stringify(result.methodology)).not.toMatch(/open-meteo/i);
    expect(result.warnings.map((w) => w.code)).toContain("MODEL_DATA_NOT_OFFICIAL");
  });

  it("never describes a result as official, government or real-time CPCB", () => {
    const result = expectValid(run(readings, { dataSource: OPEN_METEO_MODEL_SOURCE }));
    expect(result.provenanceLabel).not.toMatch(/official|government|real-time/i);
    expect(result.disclaimer).toMatch(/not an official/);
  });
});

/* ------------------------------------------------------------------ */
/* Time-series pipeline                                               */
/* ------------------------------------------------------------------ */

const END_MS = Date.parse(FIXED_TIME);
const HOUR = 3_600_000;
const at = (k: number): string => new Date(END_MS - k * HOUR).toISOString();
const series = (
  pollutant: string,
  n: number,
  value: (k: number) => number | null,
  unit = pollutant === "co" ? "mg/m3" : "ug/m3",
) => ({
  pollutant,
  unit,
  observations: Array.from({ length: n }, (_, k): Observation => ({ timestamp: at(k), value: value(k) })),
});
const constant = (pollutant: string, n: number, v: number) => series(pollutant, n, () => v);

const runSeries = (input: Partial<Parameters<typeof calculateAqiFromTimeSeries>[0]> & { series: ReturnType<typeof series>[] }) =>
  calculateAqiFromTimeSeries({ asOf: FIXED_TIME, calculatedAt: FIXED_TIME, ...input });

describe("calculateAqiFromTimeSeries", () => {
  it("averages each pollutant over its CPCB window, then scores", () => {
    // pm25 40 -> 66.2 -> 66; pm10 120 -> 113.6 -> 114; no2 30 -> 37.5 -> 38
    const result = expectValid(
      runSeries({ series: [constant("pm25", 24, 40), constant("pm10", 24, 120), constant("no2", 24, 30)] }),
    );
    expect(result.subIndices.map((s) => s.index)).toEqual([66, 114, 38]);
    expect(result.aqi).toBe(114);
    expect(result.dominantPollutant).toBe("pm10");
    expect(result.observationTime).toBe("2025-01-15T12:00:00.000Z");
  });

  it("reports each window's completeness and where its requirement came from", () => {
    const result = expectValid(
      runSeries({
        series: [constant("pm25", 24, 40), constant("pm10", 24, 120), constant("o3", 8, 50)],
      }),
    );
    const byPollutant = Object.fromEntries(result.completeness.windows.map((w) => [w.pollutant, w]));
    expect(byPollutant.pm25).toMatchObject({ status: "complete", requiredSource: "CPCB" });
    expect(byPollutant.pm25?.stats).toMatchObject({ windowHours: 24, requiredValidHours: 16, validHours: 24 });
    expect(byPollutant.o3).toMatchObject({ requiredSource: "engine-default" });
    expect(byPollutant.o3?.stats).toMatchObject({ windowHours: 8, requiredValidHours: 6 });
  });

  it("uses an 8-hour window for CO and O3 even when more history is supplied", () => {
    // Newest 8 hours are 1.0 mg/m3; older hours are huge and must be ignored.
    const co = series("co", 24, (k) => (k < 8 ? 1.0 : 30));
    const result = expectValid(runSeries({ series: [constant("pm25", 24, 10), constant("pm10", 24, 20), co] }));
    expect(result.subIndices.find((s) => s.pollutant === "co")?.concentration.value).toBe(1);
  });

  it("excludes a pollutant with an incomplete window but still succeeds if enough remain", () => {
    const result = expectValid(
      runSeries({
        series: [
          series("pm25", 24, (k) => (k < 10 ? 40 : null)), // 10 valid hours < 16 required
          constant("pm10", 24, 120),
          constant("no2", 24, 30),
          constant("so2", 24, 20),
        ],
      }),
    );
    expect(result.availablePollutants).toEqual(["pm10", "no2", "so2"]);
    expect(result.missingPollutants).toContain("pm25");
    expect(result.warnings.map((w) => w.code)).toContain("INCOMPLETE_WINDOW_EXCLUDED");
    expect(result.completeness.windows.find((w) => w.pollutant === "pm25")?.status).toBe("incomplete");
  });

  it("incomplete_window: too little data in a window leaves too few pollutants", () => {
    const result = runSeries({
      series: [series("pm25", 24, (k) => (k < 10 ? 40 : null)), constant("pm10", 24, 120), constant("no2", 24, 30)],
    });
    expect(result.status).toBe("incomplete_window");
    if (result.status === "incomplete_window") {
      expect(result.aqi).toBeNull();
      expect(result.incompleteWindows).toEqual(["pm25"]);
      expect(result.reasons).toEqual(["INSUFFICIENT_POLLUTANT_COUNT"]);
      expect(result.subIndices.map((s) => s.pollutant)).toEqual(["pm10", "no2"]);
    }
  });

  it("a pollutant with no data at all is missing, not an incomplete window", () => {
    const result = runSeries({
      series: [series("pm25", 0, () => 1), constant("pm10", 24, 120), constant("no2", 24, 30)],
    });
    expect(result.status).toBe("insufficient_data");
    expect(result.missingPollutants).toContain("pm25");
  });

  it("honours a caller-specified minimum and labels it", () => {
    const result = expectValid(
      runSeries({
        series: [series("pm25", 24, (k) => (k < 10 ? 40 : null)), constant("pm10", 24, 120), constant("no2", 24, 30)],
        minValidHours: { pm25: 10 },
      }),
    );
    expect(result.availablePollutants).toContain("pm25");
    expect(result.completeness.windows.find((w) => w.pollutant === "pm25")?.requiredSource).toBe("caller-specified");
  });

  it.each([0, 25, 1.5])("invalid_input: rejects an out-of-range minValidHours override (%s)", (override) => {
    const result = runSeries({
      series: [constant("pm25", 24, 40), constant("pm10", 24, 120), constant("no2", 24, 30)],
      minValidHours: { pm25: override },
    });
    expect(result.status).toBe("invalid_input");
    if (result.status === "invalid_input") {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({ code: "INVALID_WINDOW_CONFIG", pollutant: "pm25" });
    }
  });

  it("derives the ozone 1-hour value from the newest slot", () => {
    // 8-hour mean = (250 x 7 + 800) / 8 = 318.75 > 208, so the 1-hour value 800 is used -> 410
    const o3 = series("o3", 8, (k) => (k === 0 ? 800 : 250));
    const result = expectValid(runSeries({ series: [constant("pm25", 24, 40), constant("pm10", 24, 120), o3] }));
    const sub = result.subIndices.find((s) => s.pollutant === "o3");
    expect(sub?.index).toBe(410);
    expect(sub?.concentration.basis).toBe("one-hour-value");
  });

  it("rejects CO in ug/m3 and succeeds after explicit conversion of the series", () => {
    const raw = series("co", 8, () => 1500, "ug/m3");
    const rejected = runSeries({ series: [constant("pm25", 24, 10), constant("pm10", 24, 20), raw] });
    expect(rejected.status).toBe("invalid_input");

    const converted = {
      ...raw,
      unit: "mg/m3",
      observations: raw.observations.map((o) => ({ ...o, value: convertConcentration(o.value ?? 0, "ug/m3", "mg/m3") })),
    };
    const accepted = expectValid(runSeries({ series: [constant("pm25", 24, 10), constant("pm10", 24, 20), converted] }));
    expect(accepted.subIndices.find((s) => s.pollutant === "co")?.concentration.value).toBe(1.5);
  });

  it("warns about, and excludes, invalid observations", () => {
    const messy = {
      pollutant: "pm25",
      unit: "ug/m3",
      observations: [
        ...constant("pm25", 24, 40).observations,
        { timestamp: "garbage", value: 1 },
        { timestamp: at(30), value: -5 },
      ],
    };
    const result = expectValid(runSeries({ series: [messy, constant("pm10", 24, 120), constant("no2", 24, 30)] }));
    expect(result.warnings.map((w) => w.code)).toContain("INVALID_OBSERVATIONS_EXCLUDED");
    expect(result.subIndices[0]?.concentration.value).toBe(40);
  });

  it("warns about collapsed and conflicting duplicate observations", () => {
    const dup = constant("pm25", 24, 40);
    const conflicting = {
      ...dup,
      observations: [...dup.observations, ...dup.observations.slice(0, 2), { timestamp: at(5), value: 99 }],
    };
    const codes = expectValid(
      runSeries({ series: [conflicting, constant("pm10", 24, 120), constant("no2", 24, 30)] }),
    ).warnings.map((w) => w.code);
    expect(codes).toContain("DUPLICATE_OBSERVATIONS_COLLAPSED");
    expect(codes).toContain("CONFLICTING_DUPLICATES");
  });

  it("labels the result with the data source and never as official", () => {
    const result = expectValid(
      runSeries({
        series: [constant("pm25", 24, 40), constant("pm10", 24, 120), constant("no2", 24, 30)],
        dataSource: OPEN_METEO_MODEL_SOURCE,
      }),
    );
    expect(result.provenanceLabel).toBe(
      "Estimated Indian AQI — calculated using CPCB methodology and Open-Meteo model data.",
    );
  });

  it("invalid_input: bad asOf, empty series list, duplicate series, bad calculatedAt", () => {
    const good = [constant("pm25", 24, 40), constant("pm10", 24, 120), constant("no2", 24, 30)];
    const badAsOf = runSeries({ series: good, asOf: "2025-01-15T12:00:00" });
    expect(badAsOf.status).toBe("invalid_input");
    if (badAsOf.status === "invalid_input") expect(badAsOf.issues[0]?.code).toBe("INVALID_TIMESTAMP");

    const empty = runSeries({ series: [] });
    expect(empty.status).toBe("invalid_input");
    if (empty.status === "invalid_input") expect(empty.issues[0]?.code).toBe("EMPTY_DATASET");

    const twice = runSeries({ series: [...good, constant("pm25", 24, 41)] });
    expect(twice.status).toBe("invalid_input");

    const badClock = runSeries({ series: good, calculatedAt: "now-ish" });
    expect(badClock.status).toBe("invalid_input");
  });

  it("unsupported_data: only unsupported series", () => {
    const result = runSeries({ series: [constant("co2", 24, 420)] });
    expect(result.status).toBe("unsupported_data");
  });

  it("ignores an unsupported series alongside supported ones", () => {
    const result = expectValid(
      runSeries({
        series: [constant("pm25", 24, 40), constant("pm10", 24, 120), constant("no2", 24, 30), constant("co2", 24, 420)],
      }),
    );
    expect(result.unsupportedPollutants).toEqual(["co2"]);
  });

  it("is deterministic", () => {
    const input = { series: [constant("pm25", 24, 40), constant("pm10", 24, 120), constant("no2", 24, 30)] };
    expect(runSeries(input)).toEqual(runSeries(input));
  });
});
