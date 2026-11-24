import { clamp, roundHalfUp } from "@/lib/utils";

import { parseTimestamp, defaultWindowRequirement, windowAverage } from "./averaging";
import {
  BREAKPOINTS,
  OZONE_ONE_HOUR_THRESHOLD_UG_M3,
  POLLUTANT_INFO,
  type Segment,
} from "./breakpoints";
import { MAX_AQI, categorizeAqi } from "./categories";
import {
  CPCB_METHODOLOGY,
  NOT_OFFICIAL_DISCLAIMER,
  UNSPECIFIED_SOURCE,
  buildProvenanceLabel,
} from "./provenance";
import {
  checkSufficiency,
  isPollutantId,
  validateConcentrationValue,
  validateReadings,
  validateUnit,
  type NormalizedReadings,
} from "./validation";
import {
  POLLUTANT_IDS,
  type AqiInput,
  type AqiResult,
  type AqiWarning,
  type ConcentrationBasis,
  type DataCompleteness,
  type DataSource,
  type InsufficiencyReason,
  type PollutantId,
  type PollutantReading,
  type SeverePolicy,
  type SubIndex,
  type TimeSeriesAqiInput,
  type TimestampInput,
  type ValidationIssue,
  type WindowReport,
} from "./types";

/**
 * Indian AQI calculation (CPCB methodology).
 *
 *   Ip = [(IHI - ILO) / (BHI - BLO)] x (Cp - BLO) + ILO      (sub-index)
 *   AQI = max(Ip)                                           (overall)
 *
 * All functions here are deterministic and side-effect free. The only
 * non-deterministic input is `calculatedAt`, which defaults to "now" and can be
 * injected. See breakpoints.ts for every documented source ambiguity and
 * provenance.ts for the assumptions carried in each result.
 */

const DEFAULT_SEVERE_POLICY: SeverePolicy = "extrapolate-capped";

/** CPCB's interpolation formula applied to one linear segment. */
function interpolate(segment: Segment, concentration: number): number {
  const { concentrationLow: bLo, concentrationHigh: bHi, indexLow: iLo, indexHigh: iHi } = segment;
  return ((iHi - iLo) / (bHi - bLo)) * (concentration - bLo) + iLo;
}

export interface SubIndexOptions {
  readonly severePolicy?: SeverePolicy;
  readonly basis?: ConcentrationBasis;
}

/**
 * Sub-index for one pollutant concentration, in CPCB's unit for that pollutant
 * (mg/m3 for CO, ug/m3 otherwise). The concentration must already be averaged
 * over the pollutant's window. Throws RangeError for a negative or non-finite
 * concentration: use `calculateAqi` for input that needs validating.
 */
export function calculateSubIndex(
  pollutant: PollutantId,
  concentration: number,
  options: SubIndexOptions = {},
): SubIndex {
  const issue = validateConcentrationValue(concentration, pollutant);
  if (issue) throw new RangeError(issue.message);

  const policy = options.severePolicy ?? DEFAULT_SEVERE_POLICY;
  const { segments } = BREAKPOINTS[pollutant];
  const info = POLLUTANT_INFO[pollutant];

  const hit = segments.find((segment) => concentration <= segment.concentrationHigh);
  const severe = segments[segments.length - 1];
  if (!severe) throw new Error(`no breakpoint segments for ${pollutant}`);

  let exact: number;
  let kind: SubIndex["segment"]["kind"];
  let bounds: Segment;

  if (!hit) {
    // Beyond the assumed Severe width.
    bounds = severe;
    if (policy === "published-floor") {
      exact = severe.indexLow;
      kind = "severe-published-floor";
    } else {
      exact = MAX_AQI;
      kind = "severe-capped";
    }
  } else if (hit.kind === "severe") {
    bounds = hit;
    if (policy === "published-floor") {
      exact = hit.indexLow;
      kind = "severe-published-floor";
    } else {
      exact = interpolate(hit, concentration);
      kind = "severe-extrapolated";
    }
  } else {
    bounds = hit;
    exact = interpolate(hit, concentration);
    kind = hit.kind;
  }

  exact = clamp(exact, 0, MAX_AQI);
  const index = clamp(roundHalfUp(exact), 0, MAX_AQI);

  return {
    pollutant,
    concentration: {
      value: concentration,
      unit: info.unit,
      averagingHours: info.averagingHours,
      basis: options.basis ?? "window-average",
    },
    exact,
    index,
    category: categorizeAqi(index).id,
    segment: {
      kind,
      concentrationLow: bounds.concentrationLow,
      concentrationHigh: bounds.concentrationHigh,
      indexLow: bounds.indexLow,
      indexHigh: bounds.indexHigh,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Result assembly                                                    */
/* ------------------------------------------------------------------ */

function resolveCalculatedAt(input: TimestampInput | undefined): string | null {
  if (input === undefined) return new Date().toISOString();
  const ms = parseTimestamp(input);
  return ms === null ? null : new Date(ms).toISOString();
}

interface Context {
  readonly calculatedAt: string;
  readonly observationTime: string | null;
  readonly dataSource: DataSource;
  readonly severePolicy: SeverePolicy;
}

function commonFields(ctx: Context) {
  return {
    calculatedAt: ctx.calculatedAt,
    observationTime: ctx.observationTime,
    methodology: CPCB_METHODOLOGY,
    dataSource: ctx.dataSource,
    provenanceLabel: buildProvenanceLabel(ctx.dataSource),
    disclaimer: NOT_OFFICIAL_DISCLAIMER,
  };
}

function completeness(
  availableCount: number,
  hasParticulateMatter: boolean,
  requirementsMet: boolean,
  windows: readonly WindowReport[],
): DataCompleteness {
  return {
    level: !requirementsMet ? "insufficient" : availableCount === POLLUTANT_IDS.length ? "full" : "partial",
    availablePollutantCount: availableCount,
    supportedPollutantCount: POLLUTANT_IDS.length,
    minimumPollutantCount: CPCB_METHODOLOGY.minimumPollutants,
    hasParticulateMatter,
    requirementsMet,
    windows,
  };
}

/** Failure result before any sub-index exists (bad input). */
function invalidResult(
  ctx: Context,
  issues: readonly ValidationIssue[],
  normalized?: NormalizedReadings,
): AqiResult {
  return {
    status: "invalid_input",
    aqi: null,
    category: null,
    dominantPollutant: null,
    issues,
    ...commonFields(ctx),
    availablePollutants: [],
    availablePollutantCount: 0,
    missingPollutants: [...POLLUTANT_IDS],
    unsupportedPollutants: normalized?.unsupported ?? [],
    subIndices: [],
    completeness: completeness(0, false, false, []),
    warnings: [],
  };
}

interface EvaluationParams {
  readonly ctx: Context;
  readonly normalized: NormalizedReadings;
  readonly ozoneOneHour: number | null;
  readonly windows: readonly WindowReport[];
  readonly incompleteWindows: readonly PollutantId[];
  readonly extraWarnings: readonly AqiWarning[];
}

function evaluate(params: EvaluationParams): AqiResult {
  const { ctx, normalized, ozoneOneHour, windows, incompleteWindows, extraWarnings } = params;
  const warnings: AqiWarning[] = [...extraWarnings];

  for (const id of normalized.unsupported) {
    warnings.push({
      code: "UNSUPPORTED_POLLUTANT_IGNORED",
      message: `"${id}" is not a pollutant in the CPCB AQI; it was ignored.`,
      pollutant: id,
    });
  }

  // Nothing recognisable was supplied.
  if (normalized.recognised.length === 0) {
    return {
      status: "unsupported_data",
      aqi: null,
      category: null,
      dominantPollutant: null,
      ...commonFields(ctx),
      availablePollutants: [],
      availablePollutantCount: 0,
      missingPollutants: [...POLLUTANT_IDS],
      unsupportedPollutants: normalized.unsupported,
      subIndices: [],
      completeness: completeness(0, false, false, windows),
      warnings,
    };
  }

  const subIndices: SubIndex[] = normalized.valid.map(({ pollutant, value }) => {
    const oneHourApplies =
      pollutant === "o3" && value > OZONE_ONE_HOUR_THRESHOLD_UG_M3;

    if (oneHourApplies && ozoneOneHour !== null) {
      warnings.push({
        code: "OZONE_ONE_HOUR_USED",
        message: `8-hour ozone exceeds ${OZONE_ONE_HOUR_THRESHOLD_UG_M3} ug/m3, so the supplied 1-hour value was used, as CPCB's Very Poor and Severe ozone breakpoints are 1-hour values.`,
        pollutant,
      });
      return calculateSubIndex(pollutant, ozoneOneHour, {
        severePolicy: ctx.severePolicy,
        basis: "one-hour-value",
      });
    }
    if (oneHourApplies) {
      warnings.push({
        code: "OZONE_ONE_HOUR_MISSING",
        message: `8-hour ozone exceeds ${OZONE_ONE_HOUR_THRESHOLD_UG_M3} ug/m3 but no 1-hour value was supplied; the 8-hour value was used, which may misstate this sub-index.`,
        pollutant,
      });
    }
    return calculateSubIndex(pollutant, value, { severePolicy: ctx.severePolicy });
  });

  for (const sub of subIndices) {
    if (sub.segment.kind.startsWith("severe")) {
      warnings.push({
        code: "SEVERE_EXTRAPOLATED",
        message:
          sub.segment.kind === "severe-published-floor"
            ? `${POLLUTANT_INFO[sub.pollutant].label} is in the Severe band; CPCB publishes no upper bound, so only its lower bound (401) is reported.`
            : `${POLLUTANT_INFO[sub.pollutant].label} is in the Severe band; CPCB publishes no upper bound, so the number inside Severe is an engine estimate (the category is unaffected).`,
        pollutant: sub.pollutant,
      });
    }
  }

  const available = subIndices.map((s) => s.pollutant);
  const missing = POLLUTANT_IDS.filter((id) => !available.includes(id));
  const sufficiency = checkSufficiency(available);
  const base = {
    ...commonFields(ctx),
    availablePollutants: available,
    availablePollutantCount: available.length,
    missingPollutants: missing,
    unsupportedPollutants: normalized.unsupported,
    subIndices,
    completeness: completeness(
      sufficiency.availableCount,
      sufficiency.hasParticulateMatter,
      sufficiency.sufficient,
      windows,
    ),
  };

  if (!sufficiency.sufficient) {
    const reasons: readonly InsufficiencyReason[] = sufficiency.reasons;
    if (incompleteWindows.length > 0) {
      return {
        status: "incomplete_window",
        aqi: null,
        category: null,
        dominantPollutant: null,
        reasons,
        incompleteWindows,
        ...base,
        warnings,
      };
    }
    return {
      status: "insufficient_data",
      aqi: null,
      category: null,
      dominantPollutant: null,
      reasons,
      ...base,
      warnings,
    };
  }

  if (available.length < POLLUTANT_IDS.length) {
    warnings.push({
      code: "PARTIAL_POLLUTANT_COVERAGE",
      message: `AQI is based on ${available.length} of ${POLLUTANT_IDS.length} pollutants (missing: ${missing.map((id) => POLLUTANT_INFO[id].label).join(", ")}). Missing pollutants are not assumed to be zero; the true AQI could be higher.`,
    });
  }
  if (ctx.dataSource.kind === "model-estimate") {
    warnings.push({
      code: "MODEL_DATA_NOT_OFFICIAL",
      message:
        "Concentrations are atmospheric model estimates, not measurements from CPCB monitoring stations.",
    });
  }

  // Maximum sub-index; exact ties go to the earlier pollutant in canonical order.
  const dominant = subIndices.reduce((best, sub) => (sub.exact > best.exact ? sub : best));
  const aqi = clamp(roundHalfUp(dominant.exact), 0, MAX_AQI);

  return {
    status: "valid",
    aqi,
    category: categorizeAqi(aqi),
    dominantPollutant: dominant.pollutant,
    ...base,
    warnings,
  };
}

/* ------------------------------------------------------------------ */
/* Public entry points                                                */
/* ------------------------------------------------------------------ */

function makeContext(
  options: Pick<AqiInput, "dataSource" | "calculatedAt" | "severePolicy">,
  observationTime: string | null,
): { ctx: Context } | { error: ValidationIssue } {
  const calculatedAt = resolveCalculatedAt(options.calculatedAt);
  if (calculatedAt === null) {
    return {
      error: { code: "INVALID_TIMESTAMP", message: "calculatedAt is not a valid timestamp." },
    };
  }
  return {
    ctx: {
      calculatedAt,
      observationTime,
      dataSource: options.dataSource ?? UNSPECIFIED_SOURCE,
      severePolicy: options.severePolicy ?? DEFAULT_SEVERE_POLICY,
    },
  };
}

/** Context used only to describe a failure when the real one could not be built. */
function fallbackContext(options: Pick<AqiInput, "dataSource" | "severePolicy">): Context {
  return {
    calculatedAt: new Date(0).toISOString(),
    observationTime: null,
    dataSource: options.dataSource ?? UNSPECIFIED_SOURCE,
    severePolicy: options.severePolicy ?? DEFAULT_SEVERE_POLICY,
  };
}

function validateOneHour(input: AqiInput["ozoneOneHour"]): {
  value: number | null;
  issues: ValidationIssue[];
} {
  if (input === undefined || input.value === null || input.value === undefined) {
    return { value: null, issues: [] };
  }
  const issues: ValidationIssue[] = [];
  const unit = validateUnit(input.unit, "o3");
  if (unit.issue) issues.push(unit.issue);
  const valueIssue = validateConcentrationValue(input.value, "o3 (1-hour)");
  if (valueIssue) issues.push(valueIssue);
  return { value: issues.length === 0 ? input.value : null, issues };
}

/**
 * Overall Indian AQI from ALREADY-AVERAGED concentrations.
 *
 * Returns a discriminated result; it never returns an AQI of 0 for missing
 * data and never throws for bad data. See `AqiResult["status"]`.
 */
export function calculateAqi(input: AqiInput): AqiResult {
  const made = makeContext(input, null);
  if ("error" in made) return invalidResult(fallbackContext(input), [made.error]);
  const { ctx } = made;

  const normalized = validateReadings(input.readings);
  const oneHour = validateOneHour(input.ozoneOneHour);
  const issues = [...normalized.issues, ...oneHour.issues];
  if (issues.length > 0) return invalidResult(ctx, issues, normalized);

  return evaluate({
    ctx,
    normalized,
    ozoneOneHour: oneHour.value,
    windows: [],
    incompleteWindows: [],
    extraWarnings: [],
  });
}

/**
 * Overall Indian AQI from hourly time series. Each pollutant is averaged over
 * its CPCB window (24 h; 8 h for CO and O3) ending at `asOf`, then scored.
 *
 * A pollutant whose window has some data but too little is excluded and
 * reported; if that leaves too few pollutants the status is `incomplete_window`.
 * A pollutant with no data in its window is simply missing.
 */
export function calculateAqiFromTimeSeries(input: TimeSeriesAqiInput): AqiResult {
  const endMs = parseTimestamp(input.asOf);
  const made = makeContext(input, endMs === null ? null : new Date(endMs).toISOString());
  if ("error" in made) return invalidResult(fallbackContext(input), [made.error]);
  const { ctx } = made;
  if (endMs === null) {
    return invalidResult(ctx, [
      { code: "INVALID_TIMESTAMP", message: "asOf is not a valid timestamp." },
    ]);
  }

  const issues: ValidationIssue[] = [];
  const unsupported: string[] = [];
  const seen = new Set<PollutantId>();
  const readings: PollutantReading[] = [];
  const windows: WindowReport[] = [];
  const incomplete: PollutantId[] = [];
  const warnings: AqiWarning[] = [];
  let ozoneOneHour: number | null = null;

  if (input.series.length === 0) {
    issues.push({ code: "EMPTY_DATASET", message: "No pollutant series were provided." });
  }

  for (const series of input.series) {
    const id: unknown = series.pollutant;
    if (!isPollutantId(id)) {
      unsupported.push(String(id));
      continue;
    }
    if (seen.has(id)) {
      issues.push({ code: "DUPLICATE_POLLUTANT", message: `${id} appears more than once.`, pollutant: id });
      continue;
    }
    seen.add(id);

    const unitCheck = validateUnit(series.unit, id);
    if (unitCheck.issue) {
      issues.push(unitCheck.issue);
      continue;
    }

    const windowHours = POLLUTANT_INFO[id].averagingHours;
    const override = input.minValidHours?.[id];
    const requirement =
      override === undefined
        ? defaultWindowRequirement(windowHours)
        : { minValidHours: override, source: "caller-specified" as const };

    let result;
    try {
      result = windowAverage(series.observations, {
        windowHours,
        minValidHours: requirement.minValidHours,
        endTime: endMs,
        ...(input.duplicatePolicy === undefined ? {} : { duplicatePolicy: input.duplicatePolicy }),
      });
    } catch (error) {
      if (error instanceof RangeError) {
        issues.push({ code: "INVALID_WINDOW_CONFIG", message: `${id}: ${error.message}`, pollutant: id });
        continue;
      }
      throw error;
    }

    const { stats } = result;
    const noData = stats.validHours === 0;
    windows.push({
      pollutant: id,
      status: result.status === "complete" ? "complete" : noData ? "no_data" : "incomplete",
      requiredSource: requirement.source,
      stats,
    });

    if (stats.invalidValues > 0 || stats.invalidTimestamps > 0) {
      warnings.push({
        code: "INVALID_OBSERVATIONS_EXCLUDED",
        message: `${POLLUTANT_INFO[id].label}: ${stats.invalidValues} invalid value(s) and ${stats.invalidTimestamps} invalid timestamp(s) were excluded from the average.`,
        pollutant: id,
      });
    }
    if (stats.duplicateSlotsCollapsed > 0) {
      warnings.push({
        code: "DUPLICATE_OBSERVATIONS_COLLAPSED",
        message: `${POLLUTANT_INFO[id].label}: ${stats.duplicateSlotsCollapsed} hour(s) had repeated identical observations, counted once.`,
        pollutant: id,
      });
    }
    if (stats.conflictingSlotsExcluded > 0 || stats.conflictingSlotsResolved > 0) {
      warnings.push({
        code: "CONFLICTING_DUPLICATES",
        message: `${POLLUTANT_INFO[id].label}: ${stats.conflictingSlotsExcluded} hour(s) with conflicting observations were excluded and ${stats.conflictingSlotsResolved} resolved by taking the latest.`,
        pollutant: id,
      });
    }

    if (result.status === "complete") {
      readings.push({ pollutant: id, value: result.average, unit: unitCheck.unit });
      if (id === "o3") {
        const hour = windowAverage(series.observations, {
          windowHours: 1,
          minValidHours: 1,
          endTime: endMs,
          ...(input.duplicatePolicy === undefined ? {} : { duplicatePolicy: input.duplicatePolicy }),
        });
        ozoneOneHour = hour.status === "complete" ? hour.average : null;
      }
    } else {
      readings.push({ pollutant: id, value: null, unit: unitCheck.unit });
      if (!noData) {
        incomplete.push(id);
        warnings.push({
          code: "INCOMPLETE_WINDOW_EXCLUDED",
          message: `${POLLUTANT_INFO[id].label}: only ${stats.validHours} of the ${stats.requiredValidHours} hours required in the ${windowHours}-hour window were valid, so it was excluded.`,
          pollutant: id,
        });
      }
    }
  }

  if (issues.length > 0) {
    return invalidResult(ctx, issues, {
      valid: [],
      missing: [],
      recognised: [],
      unsupported,
      issues,
    });
  }

  const normalized = validateReadings(readings);
  return evaluate({
    ctx,
    normalized: { ...normalized, unsupported },
    ozoneOneHour,
    windows,
    incompleteWindows: incomplete,
    extraWarnings: warnings,
  });
}
