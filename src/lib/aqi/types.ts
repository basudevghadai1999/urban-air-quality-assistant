/**
 * Types for the Indian AQI (CPCB) calculation engine.
 *
 * This module tree is pure TypeScript: no Next.js, no network, no LLM, no
 * clock access except an optional, injectable `calculatedAt`. It is safe to
 * import from server and client code.
 */

/* ------------------------------------------------------------------ */
/* Pollutants and units                                               */
/* ------------------------------------------------------------------ */

/** Canonical order: also used to break exact ties for the dominant pollutant. */
export const POLLUTANT_IDS = [
  "pm25",
  "pm10",
  "no2",
  "so2",
  "o3",
  "co",
  "nh3",
  "pb",
] as const;

export type PollutantId = (typeof POLLUTANT_IDS)[number];

/** ASCII identifiers for the two units CPCB uses: µg/m³ and mg/m³. */
export type ConcentrationUnit = "ug/m3" | "mg/m3";

/** Averaging period CPCB prescribes for a pollutant's sub-index. */
export type AveragingPeriodHours = 8 | 24;

/* ------------------------------------------------------------------ */
/* AQI categories                                                     */
/* ------------------------------------------------------------------ */

export const AQI_CATEGORY_IDS = [
  "good",
  "satisfactory",
  "moderately_polluted",
  "poor",
  "very_poor",
  "severe",
] as const;

export type AqiCategoryId = (typeof AQI_CATEGORY_IDS)[number];

export interface AqiCategory {
  readonly id: AqiCategoryId;
  readonly label: string;
  /** Inclusive AQI range. */
  readonly min: number;
  readonly max: number;
  /** 0 (Good) to 5 (Severe). */
  readonly rank: number;
}

/* ------------------------------------------------------------------ */
/* Time and observations                                              */
/* ------------------------------------------------------------------ */

/**
 * Accepted timestamp forms. Strings MUST carry an explicit UTC offset
 * ("Z" or "+05:30"); offset-less strings are rejected because their meaning
 * depends on the machine's time zone, which would make results non-deterministic.
 */
export type TimestampInput = string | number | Date;

/** One hourly concentration observation, in the series' declared unit. */
export interface Observation {
  readonly timestamp: TimestampInput;
  readonly value: number | null | undefined;
}

/** What to do when one hourly slot holds several observations with different values. */
export type DuplicatePolicy = "exclude" | "last";

/* ------------------------------------------------------------------ */
/* Input                                                              */
/* ------------------------------------------------------------------ */

/**
 * An already-averaged concentration. `pollutant` and `unit` are plain strings
 * because they arrive from outside the type system and are validated at runtime.
 */
export interface PollutantReading {
  readonly pollutant: string;
  readonly value: number | null | undefined;
  readonly unit: string;
}

export interface OneHourValue {
  readonly value: number | null | undefined;
  readonly unit: string;
}

export type DataSourceKind =
  | "model-estimate"
  | "station-observation"
  | "unspecified";

/** Where the concentrations came from. Kept separate from the methodology. */
export interface DataSource {
  readonly kind: DataSourceKind;
  /** Human-readable name used in the provenance label, e.g. "Open-Meteo model data". */
  readonly name: string;
  readonly url?: string;
}

/**
 * How concentrations above the Very Poor upper breakpoint are scored.
 * CPCB publishes no upper concentration bound for Severe, so this is an
 * explicit engine policy (see breakpoints.ts).
 */
export type SeverePolicy = "extrapolate-capped" | "published-floor";

export interface AqiOptions {
  readonly dataSource?: DataSource;
  /** Injectable for determinism; defaults to the current time. */
  readonly calculatedAt?: TimestampInput;
  readonly severePolicy?: SeverePolicy;
}

export interface AqiInput extends AqiOptions {
  /** Concentrations ALREADY averaged over each pollutant's CPCB window, in canonical units. */
  readonly readings: readonly PollutantReading[];
  /**
   * Latest 1-hour ozone concentration (µg/m³). CPCB's Very Poor and Severe
   * ozone breakpoints are defined on 1-hour values; it is used only when the
   * 8-hour average exceeds the Poor upper breakpoint.
   */
  readonly ozoneOneHour?: OneHourValue;
}

export interface PollutantSeries {
  readonly pollutant: string;
  /** Unit of every observation in `observations`; no implicit conversion is applied. */
  readonly unit: string;
  readonly observations: readonly Observation[];
}

export interface TimeSeriesAqiInput extends AqiOptions {
  readonly series: readonly PollutantSeries[];
  /** End of every averaging window (the "current" time). */
  readonly asOf: TimestampInput;
  /** Override the minimum number of valid hourly values per pollutant window. */
  readonly minValidHours?: Partial<Record<PollutantId, number>>;
  readonly duplicatePolicy?: DuplicatePolicy;
}

/* ------------------------------------------------------------------ */
/* Validation                                                         */
/* ------------------------------------------------------------------ */

export type ValidationIssueCode =
  | "EMPTY_DATASET"
  | "UNSUPPORTED_POLLUTANT"
  | "DUPLICATE_POLLUTANT"
  | "UNKNOWN_UNIT"
  | "UNIT_MISMATCH"
  | "INVALID_VALUE_TYPE"
  | "NAN_VALUE"
  | "INFINITE_VALUE"
  | "NEGATIVE_VALUE"
  | "INVALID_TIMESTAMP"
  /** A caller-supplied averaging setting (e.g. minValidHours) is out of range. */
  | "INVALID_WINDOW_CONFIG";

export interface ValidationIssue {
  readonly code: ValidationIssueCode;
  readonly message: string;
  readonly pollutant?: string;
}

export type InsufficiencyReason =
  | "INSUFFICIENT_POLLUTANT_COUNT"
  | "MISSING_PARTICULATE_MATTER";

/* ------------------------------------------------------------------ */
/* Averaging                                                          */
/* ------------------------------------------------------------------ */

export interface WindowStats {
  readonly windowHours: number;
  /** ISO end of the window (inclusive). */
  readonly windowEnd: string;
  /** ISO start of the window (exclusive). */
  readonly windowStart: string;
  readonly requiredValidHours: number;
  /** Hourly slots that contributed a value. */
  readonly validHours: number;
  /** Hourly slots with no usable value. */
  readonly missingHours: number;
  /** Slots with several observations that all agreed (collapsed to one). */
  readonly duplicateSlotsCollapsed: number;
  /** Slots with disagreeing observations that were excluded. */
  readonly conflictingSlotsExcluded: number;
  /** Slots with disagreeing observations resolved by the "last" policy. */
  readonly conflictingSlotsResolved: number;
  /** Observations dropped for a negative, NaN, infinite or non-numeric value. */
  readonly invalidValues: number;
  /** Observations dropped for an unparseable or offset-less timestamp. */
  readonly invalidTimestamps: number;
  /** Observations stamped after the window end. */
  readonly futureObservations: number;
  /** Observations older than the window. */
  readonly outsideWindow: number;
}

export type WindowAverageResult =
  | { readonly status: "complete"; readonly average: number; readonly stats: WindowStats }
  | { readonly status: "incomplete"; readonly average: null; readonly stats: WindowStats };

export type WindowRequirementSource =
  | "CPCB"
  | "engine-default"
  | "caller-specified";

export interface WindowReport {
  readonly pollutant: PollutantId;
  readonly status: "complete" | "incomplete" | "no_data";
  readonly requiredSource: WindowRequirementSource;
  readonly stats: WindowStats;
}

/* ------------------------------------------------------------------ */
/* Sub-indices                                                        */
/* ------------------------------------------------------------------ */

/** Which piece of the piecewise-linear scale produced a sub-index. */
export type SubIndexSegmentKind =
  /** Inside a published band, e.g. PM2.5 31-60 -> 51-100. */
  | "band"
  /** Between two published bands, e.g. PM2.5 30 -> 31 maps 50 -> 51. */
  | "inter-band"
  /** Above the Very Poor bound; scaled with an assumed width (engine policy). */
  | "severe-extrapolated"
  /** Beyond the assumed Severe width; held at 500. */
  | "severe-capped"
  /** "published-floor" policy: Severe reported as its published lower bound, 401. */
  | "severe-published-floor";

export type ConcentrationBasis = "window-average" | "one-hour-value";

export interface SubIndex {
  readonly pollutant: PollutantId;
  readonly concentration: {
    readonly value: number;
    readonly unit: ConcentrationUnit;
    readonly averagingHours: AveragingPeriodHours;
    readonly basis: ConcentrationBasis;
  };
  /** Unrounded sub-index. */
  readonly exact: number;
  /** Sub-index rounded to the nearest integer (CPCB reports whole numbers). */
  readonly index: number;
  readonly category: AqiCategoryId;
  readonly segment: {
    readonly kind: SubIndexSegmentKind;
    readonly concentrationLow: number;
    readonly concentrationHigh: number;
    readonly indexLow: number;
    readonly indexHigh: number;
  };
}

/* ------------------------------------------------------------------ */
/* Result contract                                                    */
/* ------------------------------------------------------------------ */

export type AqiStatus =
  | "valid"
  | "insufficient_data"
  | "invalid_input"
  | "incomplete_window"
  | "unsupported_data";

export type AqiWarningCode =
  | "UNSUPPORTED_POLLUTANT_IGNORED"
  | "SEVERE_EXTRAPOLATED"
  | "OZONE_ONE_HOUR_USED"
  | "OZONE_ONE_HOUR_MISSING"
  | "PARTIAL_POLLUTANT_COVERAGE"
  | "MODEL_DATA_NOT_OFFICIAL"
  | "INCOMPLETE_WINDOW_EXCLUDED"
  | "DUPLICATE_OBSERVATIONS_COLLAPSED"
  | "CONFLICTING_DUPLICATES"
  | "INVALID_OBSERVATIONS_EXCLUDED";

export interface AqiWarning {
  readonly code: AqiWarningCode;
  readonly message: string;
  readonly pollutant?: PollutantId | string;
}

export interface DataCompleteness {
  /** "full" only when all eight pollutants contributed. */
  readonly level: "full" | "partial" | "insufficient";
  readonly availablePollutantCount: number;
  readonly supportedPollutantCount: number;
  readonly minimumPollutantCount: number;
  readonly hasParticulateMatter: boolean;
  /** CPCB's "3 pollutants including PM2.5 or PM10" rule. */
  readonly requirementsMet: boolean;
  /** Per-pollutant window reports; empty when averages were supplied by the caller. */
  readonly windows: readonly WindowReport[];
}

/** The scientific method, described independently of any data source. */
export interface MethodologyInfo {
  readonly name: string;
  readonly engineVersion: string;
  readonly breakpointTable: string;
  readonly formula: string;
  readonly aggregation: string;
  readonly rounding: string;
  readonly references: readonly string[];
  readonly minimumPollutants: number;
  readonly requiresParticulateMatter: boolean;
  readonly minimumValidHoursFor24HourAverage: number;
  /** Decisions the CPCB documents do not make; flagged as engine assumptions, not CPCB rules. */
  readonly engineAssumptions: readonly string[];
}

interface AqiResultBase {
  readonly status: AqiStatus;
  /** ISO-8601 time the calculation was made. */
  readonly calculatedAt: string;
  /** End of the averaging windows, when computed from a time series. */
  readonly observationTime: string | null;
  readonly methodology: MethodologyInfo;
  readonly dataSource: DataSource;
  /** Safe-to-display provenance statement. Never claims an official CPCB reading. */
  readonly provenanceLabel: string;
  readonly disclaimer: string;
  readonly availablePollutants: readonly PollutantId[];
  readonly availablePollutantCount: number;
  /** Supported pollutants that contributed no sub-index. Never treated as zero. */
  readonly missingPollutants: readonly PollutantId[];
  /** Identifiers present in the input that this engine does not support. */
  readonly unsupportedPollutants: readonly string[];
  readonly subIndices: readonly SubIndex[];
  readonly completeness: DataCompleteness;
  readonly warnings: readonly AqiWarning[];
}

export interface ValidAqiResult extends AqiResultBase {
  readonly status: "valid";
  /** Overall AQI, integer 0-500. */
  readonly aqi: number;
  readonly category: AqiCategory;
  readonly dominantPollutant: PollutantId;
}

export interface InsufficientDataResult extends AqiResultBase {
  readonly status: "insufficient_data";
  readonly aqi: null;
  readonly category: null;
  readonly dominantPollutant: null;
  readonly reasons: readonly InsufficiencyReason[];
}

export interface InvalidInputResult extends AqiResultBase {
  readonly status: "invalid_input";
  readonly aqi: null;
  readonly category: null;
  readonly dominantPollutant: null;
  readonly issues: readonly ValidationIssue[];
}

export interface IncompleteWindowResult extends AqiResultBase {
  readonly status: "incomplete_window";
  readonly aqi: null;
  readonly category: null;
  readonly dominantPollutant: null;
  readonly reasons: readonly InsufficiencyReason[];
  readonly incompleteWindows: readonly PollutantId[];
}

export interface UnsupportedDataResult extends AqiResultBase {
  readonly status: "unsupported_data";
  readonly aqi: null;
  readonly category: null;
  readonly dominantPollutant: null;
}

export type AqiResult =
  | ValidAqiResult
  | InsufficientDataResult
  | InvalidInputResult
  | IncompleteWindowResult
  | UnsupportedDataResult;
