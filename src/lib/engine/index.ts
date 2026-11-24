/**
 * Deterministic recommendation engine (Phase 3A): public API.
 *
 * Pure TypeScript: no Next.js, no network, no LLM. Safe on server and client.
 */

export * from "./types";
export { ASSUMPTIONS, RULES, resolveReferences } from "./assumptions";
export { CONFIDENCE_THRESHOLDS, buildConfidence, confidenceLevel } from "./confidence";
export { PROFILE_PRESETS, listProfileOptions, resolveProfile, type ResolveResult } from "./profiles";
export {
  describeIssues,
  preferencesInputSchema,
  recommendRequestSchema,
  type PreferencesInput,
  type RecommendRequest,
} from "./profileSchema";
export {
  RELATIVELY_LOWER_LABEL,
  comparePeriods,
  evaluateOutdoorWindows,
  type OutdoorWindowAnalysis,
  type PeriodComparison,
  type WindowCandidate,
  type WindowQuery,
  type WindowStatus,
} from "./outdoorWindows";
export { ACTIVITY_INTENSITY, ACTIVITY_LABELS, buildRoutine, type RoutineItem, type RoutineSection } from "./routine";
export { buildIndoorSection, type IndoorIntervention, type IndoorSection } from "./indoor";
export { MODE_LABELS, compareTransport, type TransportOption, type TransportSection } from "./transport";
export {
  EXPOSURE_FORMULA,
  breathingRateM3PerHour,
  compareExposure,
  inhaledMassUg,
  type ExposureEstimate,
  type ExposureScenario,
} from "./exposure";
export { compareEmissions, computeTripEmissions, type EmissionsComparison, type TripEmissions, type TripSpec } from "./impact";
export { compareByPriority, prioritize, PRIORITY_WEIGHTS, TIER_THRESHOLDS, type PriorityInput, type PriorityResult } from "./prioritization";
export {
  ENGINE_VERSION,
  LIMITATIONS,
  generateRecommendations,
  type RecommendationInput,
  type RecommendationOutcome,
  type RecommendationResult,
} from "./recommendation";
