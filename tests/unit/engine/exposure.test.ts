import { describe, expect, it } from "vitest";

import { BREATHING_RATE_SOURCE, INHALATION_RATES, RESPIRATOR_BEST_CASE_REDUCTION } from "@/config/breathingRates";
import {
  EXPOSURE_FORMULA,
  breathingRateM3PerHour,
  compareExposure,
  inhaledMassUg,
  type ExposureScenario,
} from "@/lib/engine";
import { BREATHING_RATE_RANGE, EXPOSURE_UNCERTAINTY } from "@/lib/engine/exposure";
import { AGE_GROUPS } from "@/lib/engine/types";

/** Concentrations here are SYNTHETIC test inputs. */

const scenario = (overrides: Partial<ExposureScenario> = {}): ExposureScenario => ({
  label: "scenario",
  pm25UgM3: 100,
  concentrationSource: "synthetic test value",
  ageGroup: "21-<31",
  intensity: "light",
  durationMinutes: 60,
  ...overrides,
});

const SOURCE = "synthetic test source";

describe("formula accuracy", () => {
  it("multiplies concentration, breathing rate and duration", () => {
    expect(inhaledMassUg(40, 0.72, 0.5)).toBeCloseTo(14.4, 10);
    expect(inhaledMassUg(100, 1.5, 2)).toBe(300);
    expect(inhaledMassUg(0, 1.5, 2)).toBe(0);
    expect(inhaledMassUg(100, 1.5, 0)).toBe(0);
  });

  it("applies protection as a fraction removed", () => {
    expect(inhaledMassUg(100, 0.72, 1, 0.9)).toBeCloseTo(7.2, 10);
    expect(inhaledMassUg(100, 0.72, 1, 0)).toBeCloseTo(72, 10);
  });

  it("states the formula in every result", () => {
    const e = compareExposure(scenario(), scenario({ pm25UgM3: 40 }), SOURCE);
    expect(e.formula).toBe(EXPOSURE_FORMULA);
    expect(e.formula).toContain("C (ug/m3)");
    expect(e.formula).toContain("BR (m3/hour)");
    expect(e.formula).toContain("t (hours)");
  });
});

describe("units", () => {
  it("converts the handbook's m3/minute to m3/hour by a factor of exactly 60", () => {
    expect(breathingRateM3PerHour("21-<31", "light")).toBe(0.72);
    expect(breathingRateM3PerHour("6-<11", "moderate")).toBe(1.32);
    expect(breathingRateM3PerHour("21-<31", "vigorous")).toBe(3);
    expect(breathingRateM3PerHour("3-<6", "light", "p95")).toBe(0.84);
  });

  it("carries the six age bands and three activity levels, with p95 above the mean and effort increasing the rate", () => {
    for (const age of AGE_GROUPS) {
      const table = INHALATION_RATES[age];
      expect(table.light.meanPerMinute).toBeLessThan(table.moderate.meanPerMinute);
      expect(table.moderate.meanPerMinute).toBeLessThan(table.vigorous.meanPerMinute);
      for (const level of [table.light, table.moderate, table.vigorous]) {
        expect(level.p95PerMinute).toBeGreaterThan(level.meanPerMinute);
        // Plausible physiology: between 0.05 and 6 m3/hour once converted.
        expect(level.meanPerMinute * 60).toBeGreaterThan(BREATHING_RATE_RANGE.minM3PerHour);
        expect(level.p95PerMinute * 60).toBeLessThan(BREATHING_RATE_RANGE.maxM3PerHour);
      }
    }
  });

  it("names the data source and the result units", () => {
    expect(BREATHING_RATE_SOURCE.url).toContain("epa.gov");
    expect(BREATHING_RATE_SOURCE.year).toBe(2011);
    const e = compareExposure(scenario(), scenario({ pm25UgM3: 40 }), SOURCE);
    expect(e.units).toEqual({ concentration: "ug/m3", breathingRate: "m3/hour", duration: "hours", result: "ug (micrograms of PM2.5 inhaled)" });
  });
});

describe("baseline versus alternative", () => {
  const e = compareExposure(scenario({ label: "baseline" }), scenario({ label: "alternative", pm25UgM3: 40 }), SOURCE);

  it("computes each scenario and the reduction", () => {
    expect(e.status).toBe("available");
    expect(e.baseline).toMatchObject({ label: "baseline", pm25UgM3: 100, breathingRateM3PerHour: 0.72, durationHours: 1, inhaledMassUg: 72 });
    expect(e.alternative).toMatchObject({ label: "alternative", pm25UgM3: 40, inhaledMassUg: 28.8 });
    expect(e.difference).toEqual({ direction: "reduction", magnitudeUg: 43.2, percentOfBaseline: 60 });
  });

  it("reports an increase as an increase with a non-negative magnitude", () => {
    const worse = compareExposure(scenario({ pm25UgM3: 40 }), scenario({ pm25UgM3: 100 }), SOURCE);
    expect(worse.difference?.direction).toBe("increase");
    expect(worse.difference?.magnitudeUg).toBe(43.2);
  });

  it("reports no change when the scenarios match", () => {
    const same = compareExposure(scenario(), scenario(), SOURCE);
    expect(same.difference).toEqual({ direction: "no-change", magnitudeUg: 0, percentOfBaseline: 0 });
  });

  it("scales with duration and breathing rate: harder effort for longer inhales more", () => {
    const walk = compareExposure(scenario({ intensity: "light", durationMinutes: 30 }), scenario({ intensity: "light", durationMinutes: 30, pm25UgM3: 0 }), SOURCE);
    const run = compareExposure(scenario({ intensity: "vigorous", durationMinutes: 60 }), scenario({ intensity: "vigorous", durationMinutes: 60, pm25UgM3: 0 }), SOURCE);
    expect(walk.baseline?.inhaledMassUg).toBe(36);
    expect(run.baseline?.inhaledMassUg).toBe(300);
  });

  it("uses age-appropriate breathing rates", () => {
    const child = compareExposure(scenario({ ageGroup: "6-<11", intensity: "moderate" }), scenario({ ageGroup: "6-<11", intensity: "moderate", pm25UgM3: 0 }), SOURCE);
    expect(child.baseline?.breathingRateM3PerHour).toBe(1.32);
  });

  it("credits a respirator only as a documented protection fraction, flagged as best case", () => {
    const protection = { fraction: RESPIRATOR_BEST_CASE_REDUCTION.fraction, basis: RESPIRATOR_BEST_CASE_REDUCTION.source, bestCase: true };
    const r = compareExposure(scenario(), scenario({ protection }), SOURCE);
    expect(r.alternative?.inhaledMassUg).toBe(7.2);
    expect(r.difference?.magnitudeUg).toBe(64.8);
    expect(r.bestCase).toBe(true);
    expect(r.inputs.map((i) => i.name)).toContain("Protection (alternative)");
    expect(r.inputs.find((i) => i.name === "Protection (alternative)")?.source).toMatch(/OSHA/);
    expect(RESPIRATOR_BEST_CASE_REDUCTION.fraction).toBe(0.9);
    // Without protection, the result is not labelled best case.
    expect(e.bestCase).toBe(false);
  });

  it("is deterministic", () => {
    expect(compareExposure(scenario({ label: "baseline" }), scenario({ label: "alternative", pm25UgM3: 40 }), SOURCE)).toEqual(e);
  });
});

describe("invalid breathing rates and other inputs are unavailable, never estimated", () => {
  const unavailable = (a: Partial<ExposureScenario>, b: Partial<ExposureScenario> = {}) => compareExposure(scenario(a), scenario(b), SOURCE);

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.01, 50])("rejects a breathing-rate override of %s", (rate) => {
    const e = unavailable({ breathingRateOverrideM3PerHour: rate });
    expect(e.status).toBe("unavailable");
    expect(e.reason).toBe("invalid-breathing-rate");
    expect(e.baseline).toBeNull();
    expect(e.difference).toBeNull();
  });

  it("accepts an override inside the physiological range and says it was caller-supplied", () => {
    const e = unavailable({ breathingRateOverrideM3PerHour: 0.5 }, { breathingRateOverrideM3PerHour: 0.5, pm25UgM3: 50 });
    expect(e.status).toBe("available");
    expect(e.baseline?.breathingRateM3PerHour).toBe(0.5);
    expect(e.inputs.find((i) => i.name === "Breathing rate (baseline)")?.source).toBe("caller-supplied override");
  });

  it("missing concentration (baseline or alternative) is unavailable, not zero", () => {
    for (const e of [unavailable({ pm25UgM3: null }), unavailable({}, { pm25UgM3: null })]) {
      expect(e.status).toBe("unavailable");
      expect(e.reason).toBe("missing-concentration");
      expect(e.baseline).toBeNull();
      expect(e.alternative).toBeNull();
      expect(e.difference).toBeNull();
      expect(e.sensitivityAtP95BreathingRate).toBeNull();
    }
  });

  it.each([-5, Number.NaN, Number.POSITIVE_INFINITY])("rejects concentration %s", (c) => {
    expect(unavailable({ pm25UgM3: c }).reason).toBe("invalid-concentration");
  });

  it.each([0, -30, Number.NaN, 24 * 60 + 1])("rejects duration %s minutes", (d) => {
    expect(unavailable({ durationMinutes: d }).reason).toBe("invalid-duration");
  });

  it.each([1, 1.5, -0.1, Number.NaN])("rejects protection fraction %s", (fraction) => {
    expect(unavailable({}, { protection: { fraction, basis: "x", bestCase: false } }).reason).toBe("invalid-protection");
  });

  it("an unavailable result still carries the formula, units and uncertainty statement", () => {
    const e = unavailable({ pm25UgM3: null });
    expect(e.formula).toBe(EXPOSURE_FORMULA);
    expect(e.uncertainty).toBe(EXPOSURE_UNCERTAINTY);
    expect(e.dataSource).toBe(SOURCE);
  });
});

describe("uncertainty reporting", () => {
  const e = compareExposure(scenario(), scenario({ pm25UgM3: 40 }), SOURCE);

  it("states that the result is an estimate, not a measured dose, and why", () => {
    expect(e.uncertainty).toMatch(/not a measured dose/i);
    expect(e.uncertainty).toMatch(/breathing rates vary/i);
    expect(e.uncertainty).toMatch(/indoor/i);
    expect(e.uncertainty).toMatch(/respirator/i);
  });

  it("reports sensitivity to the breathing rate using the 95th percentile", () => {
    expect(e.sensitivityAtP95BreathingRate).toEqual({ baselineUg: 96, alternativeUg: 38.4, magnitudeUg: 57.6 });
    expect(e.sensitivityAtP95BreathingRate?.magnitudeUg).toBeGreaterThan(e.difference?.magnitudeUg ?? Infinity);
  });

  it("lists every input with its value, unit and source, and echoes the data source", () => {
    expect(e.dataSource).toBe(SOURCE);
    for (const input of e.inputs) {
      expect(input.name.length).toBeGreaterThan(0);
      expect(input.unit.length).toBeGreaterThan(0);
      expect(input.source.length).toBeGreaterThan(0);
    }
    expect(e.inputs.find((i) => i.name === "Breathing rate (baseline)")?.source).toMatch(/Exposure Factors Handbook 2011, Table 6-2/);
  });

  it("never describes the figure as a dose actually received", () => {
    expect(JSON.stringify(e)).not.toMatch(/\bsafe\b/i);
  });
});

describe("methodology document", () => {
  it("its breathing-rate table and worked example match the code", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const doc = readFileSync(join(__dirname, "..", "..", "..", "docs", "ENVIRONMENTAL_IMPACT_METHODOLOGY.md"), "utf8");
    for (const age of AGE_GROUPS) {
      const row = `| ${age.replace("-<", " to <")} | ${["light", "moderate", "vigorous"].map((l) => breathingRateM3PerHour(age, l as "light").toFixed(2)).join(" | ")} |`;
      expect(doc).toContain(row);
    }
    const e = compareExposure(scenario({ ageGroup: "61-<71", durationMinutes: 45, pm25UgM3: 90 }), scenario({ ageGroup: "61-<71", durationMinutes: 45, pm25UgM3: 20 }), "x");
    expect(e.baseline?.inhaledMassUg).toBe(48.6);
    expect(e.alternative?.inhaledMassUg).toBe(10.8);
    expect(e.difference).toMatchObject({ magnitudeUg: 37.8, percentOfBaseline: 77.8 });
    expect(doc).toContain("48.6 ug");
    expect(doc).toContain("37.8 ug (77.8%)");
  });
});
