/**
 * Shared types for the deterministic recommendation engine (Phase 3A).
 *
 * Pure TypeScript: no Next.js, no network, no LLM, no clock (callers pass `nowMs`).
 * The same inputs always produce the same outputs.
 *
 * Traceability contract: every recommendation carries an `Explanation` naming what
 * it recommends, why, which data triggered it, which assumptions it relies on
 * (by ID, resolvable in `RecommendationResult.assumptions`), the estimated impact
 * and a confidence. Rule and assumption IDs are resolved against the registries in
 * `assumptions.ts`, so nothing in a result is untraceable.
 */

import type { CityId } from "@/config/cities";
import type { PollutantId } from "@/lib/aqi";
import type { AirWarning, DataSourceInfo, FreshnessStatus } from "@/types/air";

/* ------------------------------------------------------------------ */
/* Profiles and preferences                                           */
/* ------------------------------------------------------------------ */

export const PROFILE_IDS = [
  "family_toddlers",
  "senior_respiratory",
  "two_wheeler_commuter",
  "student_athlete",
] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

export const ACTIVITY_KINDS = [
  "school_commute",
  "college_commute",
  "office_commute",
  "grocery_shopping",
  "morning_walk",
  "outdoor_sports",
  "evening_exercise",
  "errands",
  "outdoor_play",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** Effort level of an activity; selects the breathing rate (EPA Exposure Factors Handbook, Table 6-2). */
export type ActivityIntensity = "light" | "moderate" | "vigorous";

export const TRANSPORT_MODES = [
  "private_car",
  "two_wheeler",
  "metro",
  "bus",
  "carpool",
  "walking",
  "cycling",
] as const;
export type TransportMode = (typeof TRANSPORT_MODES)[number];

export const COOKING_FUELS = ["lpg", "png", "electric", "biomass", "kerosene", "unknown"] as const;
export type CookingFuel = (typeof COOKING_FUELS)[number];

export const VENTILATION_PREFERENCES = ["open_often", "balanced", "mostly_closed"] as const;
export type VentilationPreference = (typeof VENTILATION_PREFERENCES)[number];

/** Age bands for which the EPA handbook publishes short-term inhalation rates and the engine carries them. */
export const AGE_GROUPS = ["3-<6", "6-<11", "21-<31", "31-<41", "61-<71", "71-<81"] as const;
export type AgeGroup = (typeof AGE_GROUPS)[number];

/** One schedule entry. Times are local clock times (IST) as "HH:MM". */
export interface ScheduleItem {
  /** Stable ID, `<activity>-<n>`, assigned when the schedule is resolved. */
  readonly id: string;
  readonly activity: ActivityKind;
  readonly preferredStart: string;
  readonly durationMinutes: number;
  /** Earliest the activity can start. Equal to `latestStart` when the time is fixed. */
  readonly earliestStart: string;
  readonly latestStart: string;
}

/** Fully resolved preferences: every field has a value (preset default or validated override). */
export interface ResolvedPreferences {
  readonly wakeUpTime: string;
  readonly workOrSchoolStart: string;
  readonly commuteMinutes: number;
  /** One-way commute distance. `distanceIsAssumed` is true when it comes from the preset, not the user. */
  readonly commuteDistanceKm: number;
  readonly distanceIsAssumed: boolean;
  readonly commuteDaysPerWeek: number;
  readonly preferredTransport: TransportMode;
  /** People in the vehicle for car / carpool trips. */
  readonly vehicleOccupancy: number;
  readonly outdoorActivityMinutes: number;
  readonly householdSize: number;
  readonly cookingFuel: CookingFuel;
  readonly hasAirPurifier: boolean;
  readonly ventilationPreference: VentilationPreference;
  readonly ageGroup: AgeGroup;
  readonly schedule: readonly ScheduleItem[];
  /** A reading the user typed in. The app has no indoor sensor; this is never presented as measured by it. */
  readonly indoorPm25UgM3: number | null;
}

export interface ProfilePreset {
  readonly id: ProfileId;
  readonly label: string;
  readonly description: string;
  /** Short statement of who the profile is for and what the engine optimises. */
  readonly focus: string;
  /** Sensitive groups use stricter advisory levels (see `advisoryThresholds.ts`). */
  readonly sensitiveGroup: boolean;
  /** 0..1, used by prioritisation. */
  readonly vulnerability: number;
  readonly defaults: ResolvedPreferences;
}

/* ------------------------------------------------------------------ */
/* Confidence                                                         */
/* ------------------------------------------------------------------ */

export type ConfidenceLevel = "high" | "medium" | "low" | "unavailable";

export interface ConfidenceFactor {
  readonly id: string;
  /** Score points removed (0 when informational). */
  readonly penalty: number;
  readonly detail: string;
}

/**
 * How much the INPUT DATA supports a result. It says nothing about health outcomes.
 * score = max(0, 1 - sum(penalties)); high >= 0.75, medium >= 0.5, otherwise low.
 */
export interface Confidence {
  readonly level: ConfidenceLevel;
  readonly score: number;
  readonly factors: readonly ConfidenceFactor[];
}

/* ------------------------------------------------------------------ */
/* Traceability                                                       */
/* ------------------------------------------------------------------ */

export type DataRefKind =
  | "aqi"
  | "forecast-window"
  | "forecast-hour"
  | "profile"
  | "preference"
  | "rule"
  | "calculation";

export interface DataRef {
  readonly kind: DataRefKind;
  /** Stable reference: a timestamp, a rule ID, a preference name. */
  readonly ref: string;
  readonly detail?: string;
}

export interface Explanation {
  /** What is recommended. */
  readonly what: string;
  /** Why it is recommended. */
  readonly why: string;
  /** Which data or rules triggered it. */
  readonly triggeredBy: readonly DataRef[];
  /** IDs resolvable in `RecommendationResult.assumptions`. */
  readonly assumptionIds: readonly string[];
  /** IDs resolvable in `RecommendationResult.rules`. */
  readonly ruleIds: readonly string[];
  /** Estimated impact in words, or null when no number is defensible. */
  readonly impact: string | null;
  readonly confidence: Confidence;
}

export type AssumptionKind =
  /** A published figure from a cited source. */
  | "sourced"
  /** A value the engine chose; configurable, not a health threshold. */
  | "engine-policy"
  /** A default filled in for an evaluator preset; replaceable by the user. */
  | "preset-default";

export interface AssumptionRecord {
  readonly id: string;
  readonly kind: AssumptionKind;
  readonly statement: string;
  readonly source: string | null;
  readonly url: string | null;
}

export interface RuleRecord {
  readonly id: string;
  readonly statement: string;
  /** What the rule rests on. */
  readonly basis: string;
}

/* ------------------------------------------------------------------ */
/* Priorities                                                         */
/* ------------------------------------------------------------------ */

export type PriorityTier = "high" | "recommended" | "optional";
export type CostLevel = "none" | "low" | "medium" | "high";
export type Feasibility = "high" | "medium" | "low";

/* ------------------------------------------------------------------ */
/* Air context                                                        */
/* ------------------------------------------------------------------ */

export type SeverityLevel = "unknown" | "low" | "moderate" | "high" | "very-high";

export interface AirContext {
  readonly aqi: number | null;
  readonly categoryId: string | null;
  readonly categoryLabel: string | null;
  readonly dominantPollutant: PollutantId | null;
  readonly severity: SeverityLevel;
  readonly aqiStatus: string | null;
  readonly provenanceLabel: string | null;
  /** Latest hourly model PM2.5 at or before the reference time (history, not forecast), if any. */
  readonly latestPm25UgM3: number | null;
  readonly latestPm25Time: string | null;
}

export interface DataFreshnessSummary {
  readonly status: FreshnessStatus;
  readonly fetchedAt: string | null;
  readonly ageSeconds: number | null;
  readonly dataTimestamp: string | null;
  readonly forecastRangeStart: string | null;
  readonly forecastRangeEnd: string | null;
}

/* ------------------------------------------------------------------ */
/* Warnings                                                           */
/* ------------------------------------------------------------------ */

export type EngineWarningCode =
  | "AIR_DATA_STALE"
  | "AIR_DATA_UNAVAILABLE"
  | "FORECAST_UNAVAILABLE"
  | "FORECAST_PARTIAL"
  | "POLLUTANT_MISSING"
  | "PRESET_DISTANCE_ASSUMED"
  | "NO_INDOOR_SENSOR"
  | "NO_ROUTE_DATA"
  | "EMISSION_FACTOR_UNAVAILABLE"
  | "ESTIMATES_NOT_MEASUREMENTS";

export interface EngineWarning {
  readonly code: EngineWarningCode;
  readonly message: string;
}

export type { AirWarning, CityId, DataSourceInfo };
