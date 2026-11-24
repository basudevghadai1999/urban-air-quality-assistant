import { canonicalUnit, parseUnit } from "./units";
import type {
  ConcentrationUnit,
  InsufficiencyReason,
  PollutantId,
  PollutantReading,
  ValidationIssue,
} from "./types";
import { POLLUTANT_IDS } from "./types";

/**
 * Input validation.
 *
 * Principles:
 * - A MISSING value (null/undefined) is not an error: the pollutant is simply
 *   unavailable. It is never replaced by zero.
 * - A MALFORMED value (negative, NaN, infinite, non-numeric, wrong unit,
 *   duplicate or unrecognised identifier) is rejected, never repaired.
 *
 * CPCB sufficiency rule (How_AQI_Calculated.pdf, item 2; technical report s.3.7):
 * the overall AQI needs at least three pollutants, at least one of them PM2.5 or PM10.
 */

export const MINIMUM_POLLUTANT_COUNT = 3;
export const PARTICULATE_POLLUTANTS: readonly PollutantId[] = ["pm25", "pm10"];

export function isPollutantId(value: unknown): value is PollutantId {
  return typeof value === "string" && (POLLUTANT_IDS as readonly string[]).includes(value);
}

/** Issue for a concentration that is present but unusable, or null if it is acceptable. */
export function validateConcentrationValue(
  value: unknown,
  pollutant?: string,
): ValidationIssue | null {
  const subject = pollutant === undefined ? "Concentration" : `${pollutant} concentration`;
  const base = pollutant === undefined ? {} : { pollutant };
  if (typeof value !== "number") {
    return { code: "INVALID_VALUE_TYPE", message: `${subject} must be a number.`, ...base };
  }
  if (Number.isNaN(value)) {
    return { code: "NAN_VALUE", message: `${subject} is NaN.`, ...base };
  }
  if (!Number.isFinite(value)) {
    return { code: "INFINITE_VALUE", message: `${subject} is not finite.`, ...base };
  }
  if (value < 0) {
    return { code: "NEGATIVE_VALUE", message: `${subject} must not be negative.`, ...base };
  }
  return null;
}

/**
 * Check a unit label against the unit CPCB uses for `pollutant`.
 * Returns the parsed unit or an issue. A recognised-but-wrong unit (CO in
 * ug/m3) is a UNIT_MISMATCH: the caller must convert explicitly.
 */
export function validateUnit(
  rawUnit: unknown,
  pollutant: PollutantId,
): { unit: ConcentrationUnit; issue: null } | { unit: null; issue: ValidationIssue } {
  const parsed = typeof rawUnit === "string" ? parseUnit(rawUnit) : null;
  if (parsed === null) {
    return {
      unit: null,
      issue: {
        code: "UNKNOWN_UNIT",
        message: `Unrecognised unit for ${pollutant}; expected "ug/m3" or "mg/m3".`,
        pollutant,
      },
    };
  }
  const expected = canonicalUnit(pollutant);
  if (parsed !== expected) {
    return {
      unit: null,
      issue: {
        code: "UNIT_MISMATCH",
        message: `${pollutant} must be supplied in ${expected} (got ${parsed}). Convert explicitly with convertConcentration; no implicit conversion is applied.`,
        pollutant,
      },
    };
  }
  return { unit: parsed, issue: null };
}

export interface NormalizedReading {
  readonly pollutant: PollutantId;
  readonly value: number;
}

export interface NormalizedReadings {
  /** Valid readings in canonical pollutant order. */
  readonly valid: readonly NormalizedReading[];
  /** Supported pollutants present in the input without a value. */
  readonly missing: readonly PollutantId[];
  /** Supported pollutants that appeared at all in the input (with or without a value). */
  readonly recognised: readonly PollutantId[];
  /** Identifiers this engine does not support. */
  readonly unsupported: readonly string[];
  readonly issues: readonly ValidationIssue[];
}

/** Validate a list of already-averaged readings. Does not throw. */
export function validateReadings(readings: readonly PollutantReading[]): NormalizedReadings {
  const issues: ValidationIssue[] = [];
  const unsupported: string[] = [];
  const seen = new Set<PollutantId>();
  const valid = new Map<PollutantId, number>();
  const missing = new Set<PollutantId>();

  if (readings.length === 0) {
    issues.push({ code: "EMPTY_DATASET", message: "No pollutant readings were provided." });
  }

  for (const reading of readings) {
    const id: unknown = reading.pollutant;
    if (!isPollutantId(id)) {
      unsupported.push(String(id));
      continue;
    }
    if (seen.has(id)) {
      issues.push({
        code: "DUPLICATE_POLLUTANT",
        message: `${id} appears more than once.`,
        pollutant: id,
      });
      continue;
    }
    seen.add(id);

    const unitCheck = validateUnit(reading.unit, id);
    if (unitCheck.issue) issues.push(unitCheck.issue);

    if (reading.value === null || reading.value === undefined) {
      missing.add(id);
      continue;
    }
    const valueIssue = validateConcentrationValue(reading.value, id);
    if (valueIssue) {
      issues.push(valueIssue);
      continue;
    }
    if (!unitCheck.issue) valid.set(id, reading.value);
  }

  return {
    valid: POLLUTANT_IDS.flatMap((id) => {
      const value = valid.get(id);
      return value === undefined ? [] : [{ pollutant: id, value }];
    }),
    missing: POLLUTANT_IDS.filter((id) => missing.has(id)),
    recognised: POLLUTANT_IDS.filter((id) => seen.has(id)),
    unsupported,
    issues,
  };
}

export interface Sufficiency {
  readonly sufficient: boolean;
  readonly availableCount: number;
  readonly hasParticulateMatter: boolean;
  readonly reasons: readonly InsufficiencyReason[];
}

/** CPCB rule: at least 3 pollutants available, including PM2.5 or PM10. */
export function checkSufficiency(available: readonly PollutantId[]): Sufficiency {
  const unique = new Set(available);
  const hasParticulateMatter = PARTICULATE_POLLUTANTS.some((id) => unique.has(id));
  const reasons: InsufficiencyReason[] = [];
  if (unique.size < MINIMUM_POLLUTANT_COUNT) reasons.push("INSUFFICIENT_POLLUTANT_COUNT");
  if (!hasParticulateMatter) reasons.push("MISSING_PARTICULATE_MATTER");
  return {
    sufficient: reasons.length === 0,
    availableCount: unique.size,
    hasParticulateMatter,
    reasons,
  };
}
