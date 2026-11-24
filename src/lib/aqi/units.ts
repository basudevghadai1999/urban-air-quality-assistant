import { POLLUTANT_INFO } from "./breakpoints";
import type { ConcentrationUnit, PollutantId } from "./types";

/**
 * Units.
 *
 * CPCB expresses CO in mg/m3 and every other pollutant in ug/m3. Some data
 * providers (Open-Meteo among them) report CO in ug/m3. The engine NEVER
 * converts silently: a CO value tagged "ug/m3" is rejected as a UNIT_MISMATCH.
 * Callers convert explicitly with `convertConcentration` first.
 */

/** 1 mg/m3 = 1000 ug/m3. */
export const UG_PER_MG = 1000;

/**
 * Parse a unit label into a canonical identifier. Accepts the spelling
 * variants providers use (micro sign U+00B5, Greek mu U+03BC, superscript 3,
 * any case). This recognises a unit; it never changes a number.
 */
export function parseUnit(raw: string): ConcentrationUnit | null {
  const normalised = raw
    .trim()
    .toLowerCase()
    .replace(/[µμ]/g, "u")
    .replace(/³/g, "3")
    .replace(/\s+/g, "");
  if (normalised === "ug/m3") return "ug/m3";
  if (normalised === "mg/m3") return "mg/m3";
  return null;
}

/**
 * Explicitly convert a concentration between ug/m3 and mg/m3.
 * Result is rounded to 15 significant digits to remove binary float noise
 * (1.1 * 1000 would otherwise give 1100.0000000000002).
 */
export function convertConcentration(
  value: number,
  from: ConcentrationUnit,
  to: ConcentrationUnit,
): number {
  if (!Number.isFinite(value)) {
    throw new RangeError("convertConcentration: value must be a finite number");
  }
  if (from === to) return value;
  const converted = from === "ug/m3" ? value / UG_PER_MG : value * UG_PER_MG;
  return Number(converted.toPrecision(15));
}

/** The unit CPCB's breakpoints use for `pollutant`. */
export function canonicalUnit(pollutant: PollutantId): ConcentrationUnit {
  return POLLUTANT_INFO[pollutant].unit;
}
