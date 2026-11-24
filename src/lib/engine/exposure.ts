import { INHALATION_RATES } from "@/config/breathingRates";

import type { ActivityIntensity, AgeGroup } from "./types";

/**
 * PM2.5 inhaled-mass estimation: a transparent model, not a dose measurement.
 *
 *   inhaled mass (ug) = C (ug/m3) x BR (m3/hour) x t (hours) x (1 - protection)
 *
 *   C           PM2.5 concentration the person is assumed to breathe in the scenario
 *   BR          breathing rate for the age band and activity level (EPA Exposure Factors Handbook 2011,
 *               Table 6-2, mean; the 95th percentile is reported as a sensitivity bound)
 *   t           duration
 *   protection  fraction of the concentration removed by a respirator or filter; defaults to 0 and is
 *               only ever supplied from a documented source (see `RESPIRATOR_BEST_CASE_REDUCTION`)
 *
 * Comparison: reduction = baseline mass - alternative mass. If either concentration is unknown the
 * result is UNAVAILABLE; nothing is estimated from a missing input.
 *
 * Limits, repeated in every result: ambient model PM2.5 is not personal exposure; breathing rates
 * vary widely between people; indoor infiltration is unknown without a sensor; respirator
 * performance depends on fit and use; the figure is an estimate, never a measured or medical dose.
 */

export const EXPOSURE_FORMULA = "inhaled mass (ug) = C (ug/m3) x BR (m3/hour) x t (hours) x (1 - protection)";

export const EXPOSURE_UNCERTAINTY =
  "Model estimate, not a measured dose. Ambient PM2.5 forecast values are atmospheric-model output for a grid cell, not what a person breathes; breathing rates vary substantially between individuals (the 95th-percentile sensitivity shows only that one input); indoor concentrations and respirator performance depend on factors this model cannot see.";

export const BREATHING_RATE_RANGE = { minM3PerHour: 0.05, maxM3PerHour: 6 } as const;
export const MAX_DURATION_HOURS = 24;

export type BreathingStat = "mean" | "p95";

/** Breathing rate in m3 per HOUR (the handbook prints m3 per minute). */
export function breathingRateM3PerHour(age: AgeGroup, intensity: ActivityIntensity, stat: BreathingStat = "mean"): number {
  const entry = INHALATION_RATES[age][intensity];
  const perMinute = stat === "mean" ? entry.meanPerMinute : entry.p95PerMinute;
  return Number((perMinute * 60).toPrecision(6));
}

export function inhaledMassUg(concentrationUgM3: number, breathingRate: number, durationHours: number, protection = 0): number {
  return concentrationUgM3 * breathingRate * durationHours * (1 - protection);
}

export interface ExposureScenario {
  readonly label: string;
  /** Null means the concentration is unknown, which makes any comparison unavailable. */
  readonly pm25UgM3: number | null;
  /** Where the concentration came from, in words. */
  readonly concentrationSource: string;
  readonly ageGroup: AgeGroup;
  readonly intensity: ActivityIntensity;
  readonly durationMinutes: number;
  /** Optional documented reduction of the concentration breathed (0..1). */
  readonly protection?: { readonly fraction: number; readonly basis: string; readonly bestCase: boolean };
  /** Optional override, validated against `BREATHING_RATE_RANGE`. */
  readonly breathingRateOverrideM3PerHour?: number;
}

export interface ScenarioResult {
  readonly label: string;
  readonly pm25UgM3: number;
  readonly concentrationSource: string;
  readonly breathingRateM3PerHour: number;
  readonly durationHours: number;
  readonly protectionFraction: number;
  readonly inhaledMassUg: number;
}

export interface ExposureInput {
  readonly name: string;
  readonly value: string;
  readonly unit: string;
  readonly source: string;
}

export type ExposureUnavailableReason = "missing-concentration" | "invalid-concentration" | "invalid-duration" | "invalid-breathing-rate" | "invalid-protection";

export interface ExposureEstimate {
  readonly status: "available" | "unavailable";
  readonly reason: ExposureUnavailableReason | null;
  readonly baseline: ScenarioResult | null;
  readonly alternative: ScenarioResult | null;
  readonly difference: {
    readonly direction: "reduction" | "increase" | "no-change";
    /** Always >= 0; `direction` carries the sign. */
    readonly magnitudeUg: number;
    readonly percentOfBaseline: number | null;
  } | null;
  /** Same difference recomputed with the 95th-percentile breathing rate. Sensitivity to ONE input only. */
  readonly sensitivityAtP95BreathingRate: {
    readonly baselineUg: number;
    readonly alternativeUg: number;
    readonly magnitudeUg: number;
  } | null;
  /** True when the alternative relies on a best-case protection ceiling, not an expected value. */
  readonly bestCase: boolean;
  readonly formula: string;
  readonly units: { readonly concentration: "ug/m3"; readonly breathingRate: "m3/hour"; readonly duration: "hours"; readonly result: "ug (micrograms of PM2.5 inhaled)" };
  readonly inputs: readonly ExposureInput[];
  readonly uncertainty: string;
  readonly dataSource: string;
}

const UNITS = {
  concentration: "ug/m3",
  breathingRate: "m3/hour",
  duration: "hours",
  result: "ug (micrograms of PM2.5 inhaled)",
} as const;

const round1 = (v: number): number => Math.round(v * 10) / 10;

function unavailable(reason: ExposureUnavailableReason, dataSource: string): ExposureEstimate {
  return {
    status: "unavailable",
    reason,
    baseline: null,
    alternative: null,
    difference: null,
    sensitivityAtP95BreathingRate: null,
    bestCase: false,
    formula: EXPOSURE_FORMULA,
    units: UNITS,
    inputs: [],
    uncertainty: EXPOSURE_UNCERTAINTY,
    dataSource,
  };
}

type Checked = { ok: true; rate: number; hours: number; protection: number; concentration: number } | { ok: false; reason: ExposureUnavailableReason };

function check(s: ExposureScenario): Checked {
  if (s.pm25UgM3 === null) return { ok: false, reason: "missing-concentration" };
  if (!Number.isFinite(s.pm25UgM3) || s.pm25UgM3 < 0) return { ok: false, reason: "invalid-concentration" };
  const hours = s.durationMinutes / 60;
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_DURATION_HOURS) return { ok: false, reason: "invalid-duration" };
  const rate = s.breathingRateOverrideM3PerHour ?? breathingRateM3PerHour(s.ageGroup, s.intensity);
  if (!Number.isFinite(rate) || rate < BREATHING_RATE_RANGE.minM3PerHour || rate > BREATHING_RATE_RANGE.maxM3PerHour) {
    return { ok: false, reason: "invalid-breathing-rate" };
  }
  const protection = s.protection?.fraction ?? 0;
  if (!Number.isFinite(protection) || protection < 0 || protection >= 1) return { ok: false, reason: "invalid-protection" };
  return { ok: true, rate, hours, protection, concentration: s.pm25UgM3 };
}

function toResult(s: ExposureScenario, c: Extract<Checked, { ok: true }>): ScenarioResult {
  return {
    label: s.label,
    pm25UgM3: c.concentration,
    concentrationSource: s.concentrationSource,
    breathingRateM3PerHour: c.rate,
    durationHours: Number(c.hours.toFixed(4)),
    protectionFraction: c.protection,
    inhaledMassUg: round1(inhaledMassUg(c.concentration, c.rate, c.hours, c.protection)),
  };
}

/** Compare two scenarios. Pure; never throws; unavailable rather than estimated when an input is missing. */
export function compareExposure(baseline: ExposureScenario, alternative: ExposureScenario, dataSource: string): ExposureEstimate {
  const b = check(baseline);
  if (!b.ok) return unavailable(b.reason, dataSource);
  const a = check(alternative);
  if (!a.ok) return unavailable(a.reason, dataSource);

  const baseResult = toResult(baseline, b);
  const altResult = toResult(alternative, a);
  // Differences use the unrounded masses so rounding never invents or hides a change.
  const baseMass = inhaledMassUg(b.concentration, b.rate, b.hours, b.protection);
  const altMass = inhaledMassUg(a.concentration, a.rate, a.hours, a.protection);
  const delta = baseMass - altMass;
  const magnitude = round1(Math.abs(delta));
  const direction = magnitude === 0 ? "no-change" : delta > 0 ? "reduction" : "increase";

  const p95 = (s: ExposureScenario, c: Extract<Checked, { ok: true }>) =>
    inhaledMassUg(
      c.concentration,
      s.breathingRateOverrideM3PerHour ?? breathingRateM3PerHour(s.ageGroup, s.intensity, "p95"),
      c.hours,
      c.protection,
    );
  const baseP95 = p95(baseline, b);
  const altP95 = p95(alternative, a);

  const bestCase = alternative.protection?.bestCase === true || baseline.protection?.bestCase === true;
  const inputs: ExposureInput[] = [
    {
      name: "Breathing rate (baseline)",
      value: String(baseResult.breathingRateM3PerHour),
      unit: "m3/hour",
      source: baseline.breathingRateOverrideM3PerHour === undefined
        ? `U.S. EPA Exposure Factors Handbook 2011, Table 6-2, mean, age ${baseline.ageGroup}, ${baseline.intensity} activity (converted from m3/minute)`
        : "caller-supplied override",
    },
    {
      name: "Breathing rate (alternative)",
      value: String(altResult.breathingRateM3PerHour),
      unit: "m3/hour",
      source: alternative.breathingRateOverrideM3PerHour === undefined
        ? `U.S. EPA Exposure Factors Handbook 2011, Table 6-2, mean, age ${alternative.ageGroup}, ${alternative.intensity} activity (converted from m3/minute)`
        : "caller-supplied override",
    },
    { name: "Concentration (baseline)", value: String(baseResult.pm25UgM3), unit: "ug/m3", source: baseline.concentrationSource },
    { name: "Concentration (alternative)", value: String(altResult.pm25UgM3), unit: "ug/m3", source: alternative.concentrationSource },
    { name: "Duration (baseline)", value: String(baseResult.durationHours), unit: "hours", source: "activity schedule" },
    { name: "Duration (alternative)", value: String(altResult.durationHours), unit: "hours", source: "activity schedule" },
  ];
  for (const [side, s] of [["baseline", baseline], ["alternative", alternative]] as const) {
    if (s.protection !== undefined) {
      inputs.push({ name: `Protection (${side})`, value: String(s.protection.fraction), unit: "fraction of concentration removed", source: s.protection.basis });
    }
  }

  return {
    status: "available",
    reason: null,
    baseline: baseResult,
    alternative: altResult,
    difference: {
      direction,
      magnitudeUg: magnitude,
      percentOfBaseline: baseMass > 0 ? round1((Math.abs(delta) / baseMass) * 100) : null,
    },
    sensitivityAtP95BreathingRate: {
      baselineUg: round1(baseP95),
      alternativeUg: round1(altP95),
      magnitudeUg: round1(Math.abs(baseP95 - altP95)),
    },
    bestCase,
    formula: EXPOSURE_FORMULA,
    units: UNITS,
    inputs,
    uncertainty: EXPOSURE_UNCERTAINTY,
    dataSource,
  };
}
