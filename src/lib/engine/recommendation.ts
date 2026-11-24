import { RESPIRATOR_BEST_CASE_REDUCTION } from "@/config/breathingRates";
import type { CityId } from "@/config/cities";
import { WINDOW_POLICY } from "@/config/advisoryThresholds";
import type { PollutantId } from "@/lib/aqi";
import type { DataSourceInfo, FreshnessStatus, NormalizedAirData } from "@/types/air";

import { ASSUMPTIONS, RULES, resolveReferences } from "./assumptions";
import { buildConfidence, UNAVAILABLE_CONFIDENCE, weakest } from "./confidence";
import { buildIndoorSection, type IndoorSection, type VentilationOutlook } from "./indoor";
import { compareExposure, type ExposureEstimate } from "./exposure";
import { evaluateOutdoorWindows, comparePeriods, RELATIVELY_LOWER_LABEL, type OutdoorWindowAnalysis, type PeriodComparison, type Trend, type WindowCandidate } from "./outdoorWindows";
import { compareByPriority, prioritize, type PriorityResult } from "./prioritization";
import { resolveProfile } from "./profiles";
import { ACTIVITY_LABELS, buildRoutine, type RoutineItem, type RoutineSection } from "./routine";
import { compareTransport, MODE_LABELS, type TransportOption, type TransportSection } from "./transport";
import type {
  AirContext,
  AssumptionRecord,
  RuleRecord,
  Confidence,
  CostLevel,
  DataFreshnessSummary,
  DataRef,
  EngineWarning,
  Explanation,
  Feasibility,
  PriorityTier,
  ProfileId,
  ResolvedPreferences,
  SeverityLevel,
  TransportMode,
} from "./types";
import { AGE_GROUPS } from "./types";

/**
 * The recommendation engine's single entry point. Pure and deterministic: it reads the normalized
 * air data it is given (never the network), the validated profile, and the clock value passed in.
 * No LLM is involved; Phase 3B may explain these results but never changes them.
 */

export const ENGINE_VERSION = "3A.1";

export interface RecommendationInput {
  readonly air: NormalizedAirData;
  readonly profileId: ProfileId | string;
  /** Raw preferences; validated here. */
  readonly preferences?: unknown;
  readonly nowMs: number;
}

export type RecommendationFailure = "unknown-profile" | "invalid-preferences";

export type RecommendationOutcome =
  | { readonly ok: true; readonly result: RecommendationResult }
  | { readonly ok: false; readonly reason: RecommendationFailure };

export interface ExposureItem {
  readonly id: string;
  readonly title: string;
  readonly activityId: string | null;
  readonly estimate: ExposureEstimate;
  readonly explanation: Explanation;
}

export interface EmissionsRow {
  readonly mode: TransportMode;
  readonly label: string;
  readonly status: "available" | "unavailable";
  readonly unavailableReason: string | null;
  readonly direction: "reduction" | "increase" | "no-change" | null;
  /** Grams CO2 per passenger, one way, always >= 0. */
  readonly oneWayGramsCo2: number | null;
  /** Round trip each commuting day, then per week: scaled by 2 trips and the commute days per week. */
  readonly weeklyGramsCo2: number | null;
  readonly factorId: string | null;
  readonly factorSourceUrl: string | null;
}

export interface EmissionsSection {
  readonly gas: "CO2";
  readonly basis: "tailpipe-co2";
  readonly baselineMode: TransportMode;
  readonly distanceKm: number;
  readonly distanceIsAssumed: boolean;
  readonly scaling: { readonly tripsPerDay: 2; readonly daysPerWeek: number };
  readonly rows: readonly EmissionsRow[];
  readonly note: string;
}

export interface PrioritizedRecommendation {
  readonly id: string;
  readonly kind: "routine" | "trip-chaining" | "indoor" | "transport";
  readonly title: string;
  readonly tier: PriorityTier;
  readonly score: number;
  readonly breakdown: PriorityResult["breakdown"];
  readonly adjustedBy: string | null;
  readonly exposureReductionUg: number | null;
}

export interface OutdoorWindowsSection {
  readonly status: "available" | "partial" | "unavailable";
  /** Wording the UI should use. Never "safe". */
  readonly wording: typeof RELATIVELY_LOWER_LABEL;
  readonly periods: PeriodComparison;
  readonly trend: Trend;
  /** The profile's main outdoor activity: the one the section is centred on. */
  readonly primaryActivityId: string | null;
  readonly analyses: Readonly<Record<string, OutdoorWindowAnalysis>>;
  readonly tripChainingAnalysis: OutdoorWindowAnalysis | null;
}

export interface RecommendationResult {
  readonly schemaVersion: 1;
  readonly status: "ok" | "air-data-unavailable";
  readonly profileId: ProfileId;
  readonly profile: {
    readonly label: string;
    readonly description: string;
    readonly focus: string;
    readonly sensitiveGroup: boolean;
    readonly preferences: ResolvedPreferences;
    /** Preferences the caller supplied; every other value is a preset default. */
    readonly overriddenPreferences: readonly string[];
  };
  readonly cityId: CityId;
  readonly cityName: string;
  readonly generatedAt: string;
  readonly dataFreshness: DataFreshnessSummary;
  readonly aqiContext: AirContext;
  readonly routine: RoutineSection;
  readonly outdoorWindows: OutdoorWindowsSection;
  readonly indoor: IndoorSection;
  readonly transport: TransportSection;
  readonly exposure: { readonly items: readonly ExposureItem[]; readonly note: string };
  readonly emissions: EmissionsSection;
  /** Everything above ranked, with the score breakdown behind each tier. */
  readonly prioritized: readonly PrioritizedRecommendation[];
  readonly assumptions: readonly AssumptionRecord[];
  readonly rules: readonly RuleRecord[];
  readonly warnings: readonly EngineWarning[];
  readonly confidence: Confidence;
  readonly limitations: readonly string[];
  readonly provenance: {
    readonly airDataSource: DataSourceInfo;
    readonly attribution: string;
    readonly disclaimer: string;
    readonly aqiProvenanceLabel: string | null;
    readonly dataLocation: string;
    readonly engine: {
      readonly version: string;
      readonly deterministic: true;
      readonly llmUsed: false;
      readonly networkUsed: false;
    };
  };
}

export const LIMITATIONS: readonly string[] = [
  "All pollution values are atmospheric-model estimates for a grid cell, not measurements at a monitoring station, a road or a home.",
  "No window, level or action is medically safe. 'Relatively lower-pollution' only compares times of day.",
  "Exposure figures are model estimates of inhaled PM2.5 mass, not measured doses; breathing rates vary substantially between people.",
  "There is no route-level pollution data and no indoor sensor; mode exposure is qualitative and indoor advice is conditional.",
  "Emission figures are tailpipe CO2 only from a 2015 consultation-draft source; they exclude other greenhouse gases, fuel production and vehicle lifecycle.",
  "Preset values (times, distances, age band) are illustrative defaults and are flagged as assumed.",
  "This is general information, not medical advice; follow your clinician's guidance.",
];

const ESTIMATE_NOTE =
  "Model estimates of PM2.5 inhaled mass (ug), not measured doses. Each item shows its formula, inputs, units and uncertainty.";

function severityOf(air: NormalizedAirData): SeverityLevel {
  const aqi = air.calculatedAqi;
  if (air.freshnessStatus === "unavailable" || aqi === null || aqi.status !== "valid" || aqi.category === null) return "unknown";
  const rank = aqi.category.rank;
  if (rank <= 1) return "low";
  if (rank === 2) return "moderate";
  if (rank === 3) return "high";
  return "very-high";
}

function airContextOf(air: NormalizedAirData, severity: SeverityLevel): AirContext {
  const aqi = air.calculatedAqi;
  const usable = aqi !== null && aqi.status === "valid";
  let latest: { value: number; time: string } | null = null;
  for (const hour of air.historicalHourlyData.hours) {
    const v = hour.values.pm25;
    if (v !== null && v !== undefined) latest = { value: v, time: hour.time };
  }
  return {
    aqi: usable ? aqi.aqi : null,
    categoryId: usable ? (aqi.category?.id ?? null) : null,
    categoryLabel: usable ? (aqi.category?.label ?? null) : null,
    dominantPollutant: usable ? aqi.dominantPollutant : null,
    severity,
    aqiStatus: aqi?.status ?? null,
    provenanceLabel: aqi?.provenanceLabel ?? null,
    latestPm25UgM3: air.freshnessStatus === "unavailable" ? null : (latest?.value ?? null),
    latestPm25Time: air.freshnessStatus === "unavailable" ? null : (latest?.time ?? null),
  };
}

function freshnessOf(air: NormalizedAirData): DataFreshnessSummary {
  return {
    status: air.freshnessStatus,
    fetchedAt: air.fetchedAt,
    ageSeconds: air.ageSeconds,
    dataTimestamp: air.dataTimestamp,
    forecastRangeStart: air.forecastHourlyData.rangeStart,
    forecastRangeEnd: air.forecastHourlyData.rangeEnd,
  };
}

const candidateAt = (analysis: OutdoorWindowAnalysis, start: string | undefined): WindowCandidate | null =>
  start === undefined ? null : ([analysis.best, analysis.preferred].find((c) => c !== null && c.start === start) ?? null);

function exposureItems(
  air: NormalizedAirData,
  prefs: ResolvedPreferences,
  overridden: readonly string[],
  routine: readonly RoutineItem[],
  analyses: Readonly<Record<string, OutdoorWindowAnalysis>>,
  severity: SeverityLevel,
  aqiRef: DataRef | null,
): ExposureItem[] {
  const items: ExposureItem[] = [];
  const source = `Open-Meteo Air Quality API (CAMS global model) hourly forecast, fetched ${air.fetchedAt ?? "unknown"}; window mean PM2.5`;
  const ageAssumption = overridden.includes("ageGroup") ? [] : ["ASM_PRESET_AGE_GROUP"];
  const base = ["ASM_BREATHING_RATES_EPA", "ASM_AMBIENT_NOT_PERSONAL", ...ageAssumption];

  for (const item of routine) {
    const analysis = analyses[item.id];
    if (analysis === undefined) continue;
    // Null when no time is suggested (for example an optional activity on a no-suitable-window day).
    const chosen = candidateAt(analysis, item.suggestedTime?.start);
    const usual = analysis.preferred;

    // 1. Moving the activity.
    if ((analysis.status === "recommended" || analysis.status === "no-suitable-window") && chosen !== null && usual !== null && chosen.start !== usual.start && chosen.start === analysis.best?.start) {
      const estimate = compareExposure(
        { label: `${item.label} at your usual ${usual.startLocal}`, pm25UgM3: usual.pm25MeanUgM3, concentrationSource: `${source}, ${usual.startLocal} to ${usual.endLocal}`, ageGroup: prefs.ageGroup, intensity: item.intensity, durationMinutes: item.durationMinutes },
        { label: `${item.label} at ${chosen.startLocal}`, pm25UgM3: chosen.pm25MeanUgM3, concentrationSource: `${source}, ${chosen.startLocal} to ${chosen.endLocal}`, ageGroup: prefs.ageGroup, intensity: item.intensity, durationMinutes: item.durationMinutes },
        source,
      );
      items.push({
        id: `EXP_SHIFT_${item.id}`,
        title: `Move ${item.label.toLowerCase()} from ${usual.startLocal} to ${chosen.startLocal}`,
        activityId: item.id,
        estimate,
        explanation: {
          what: `Estimated PM2.5 inhaled-mass change from moving ${item.label.toLowerCase()} to ${chosen.startLocal}.`,
          why: "Same activity, breathing rate and duration; only the forecast PM2.5 differs between the two times.",
          triggeredBy: [...(aqiRef === null ? [] : [aqiRef]), { kind: "forecast-window", ref: usual.start, detail: `usual: PM2.5 ${usual.pm25MeanUgM3} ug/m3` }, { kind: "forecast-window", ref: chosen.start, detail: `suggested: PM2.5 ${chosen.pm25MeanUgM3} ug/m3` }, { kind: "calculation", ref: "inhaled mass = C x BR x t" }],
          assumptionIds: base,
          ruleIds: ["RULE_TIMING_SHIFT_EXPOSURE", "RULE_NEVER_CALL_SAFE"],
          impact: estimate.difference === null ? null : `${estimate.difference.direction} of about ${estimate.difference.magnitudeUg} ug of PM2.5 inhaled (estimate).`,
          confidence: item.confidence,
        },
      });
    }

    // 2. A respirator on an open two-wheeler commute: best-case ceiling only.
    const isCommute = item.activity === "office_commute" || item.activity === "college_commute" || item.activity === "school_commute";
    const elevated = severity === "moderate" || severity === "high" || severity === "very-high";
    if (isCommute && prefs.preferredTransport === "two_wheeler" && elevated && chosen !== null && !items.some((i) => i.id === `EXP_RESPIRATOR_${item.id}`)) {
      const protection = { fraction: RESPIRATOR_BEST_CASE_REDUCTION.fraction, basis: RESPIRATOR_BEST_CASE_REDUCTION.source, bestCase: true };
      const common = { ageGroup: prefs.ageGroup, intensity: item.intensity, durationMinutes: item.durationMinutes, pm25UgM3: chosen.pm25MeanUgM3, concentrationSource: `${source}, ${chosen.startLocal} to ${chosen.endLocal}` } as const;
      const estimate = compareExposure({ ...common, label: `${item.label} without a respirator` }, { ...common, label: `${item.label} with a well-fitted certified respirator (best case)`, protection }, source);
      items.push({
        id: `EXP_RESPIRATOR_${item.id}`,
        title: `Best-case effect of a well-fitted certified respirator on the ${item.label.toLowerCase()}`,
        activityId: item.id,
        estimate,
        explanation: {
          what: "Best-case ceiling on PM2.5 inhaled mass if a certified respirator fits properly and is worn for the whole ride.",
          why: "Open-air riding in elevated pollution; a respirator is the only measure here that acts on the ride itself.",
          triggeredBy: [...(aqiRef === null ? [] : [aqiRef]), { kind: "preference", ref: "preferredTransport", detail: "two_wheeler" }, { kind: "rule", ref: "RULE_RESPIRATOR_CONDITIONAL" }],
          assumptionIds: [...base, "ASM_RESPIRATOR_BEST_CASE"],
          ruleIds: ["RULE_RESPIRATOR_CONDITIONAL", "RULE_NEVER_CALL_SAFE"],
          impact: estimate.difference === null ? null : `Up to about ${estimate.difference.magnitudeUg} ug less PM2.5 inhaled in the best case; real benefit depends on fit and can be far smaller.`,
          confidence: buildConfidence([{ id: "best-case", penalty: 0.35, detail: "Respirator benefit is a best-case ceiling; it depends on fit and consistent use." }, { id: "model-data", penalty: 0.05, detail: "Atmospheric-model values." }]),
        },
      });
    }

    // 3. Replacing a hard or long outdoor session with an indoor one: needs an indoor concentration.
    if (analysis.status === "no-suitable-window" && (item.activity === "outdoor_sports" || item.activity === "evening_exercise" || item.activity === "morning_walk" || item.activity === "outdoor_play") && usual !== null) {
      const indoor = prefs.indoorPm25UgM3;
      const estimate = compareExposure(
        { label: `${item.label} outdoors at your usual ${usual.startLocal}`, pm25UgM3: usual.pm25MeanUgM3, concentrationSource: source, ageGroup: prefs.ageGroup, intensity: item.intensity, durationMinutes: item.durationMinutes },
        { label: `${item.label} indoors`, pm25UgM3: indoor, concentrationSource: "PM2.5 reading entered by the user (unverified)", ageGroup: prefs.ageGroup, intensity: item.intensity, durationMinutes: item.durationMinutes },
        source,
      );
      items.push({
        id: `EXP_INDOOR_${item.id}`,
        title: `Replace ${item.label.toLowerCase()} outdoors with an indoor version`,
        activityId: item.id,
        estimate,
        explanation: {
          what: "Estimated PM2.5 inhaled-mass change from doing the activity indoors.",
          why: indoor === null ? "Unavailable: the indoor PM2.5 level is unknown (no sensor, and the app does not estimate it)." : "Compares the forecast outdoor window with your self-reported indoor reading.",
          triggeredBy: [...(aqiRef === null ? [] : [aqiRef]), { kind: "forecast-window", ref: usual.start, detail: `usual: PM2.5 ${usual.pm25MeanUgM3} ug/m3` }, { kind: "rule", ref: "RULE_DIP_IS_NOT_AN_INVITATION" }],
          assumptionIds: [...base, "ASM_NO_INDOOR_SENSOR", ...(indoor === null ? [] : ["ASM_INDOOR_READING_USER_REPORTED"])],
          ruleIds: ["RULE_DIP_IS_NOT_AN_INVITATION", "RULE_NEVER_CALL_SAFE"],
          impact: estimate.difference === null ? "Not estimated: indoor concentration unknown." : `${estimate.difference.direction} of about ${estimate.difference.magnitudeUg} ug of PM2.5 inhaled (estimate).`,
          confidence: estimate.status === "available" ? buildConfidence([{ id: "user-reading", penalty: 0.25, detail: "Indoor value is self-reported." }]) : UNAVAILABLE_CONFIDENCE("indoor concentration unknown"),
        },
      });
    }
  }
  return items;
}

function emissionsSection(transport: TransportSection, prefs: ResolvedPreferences): EmissionsSection {
  const rows: EmissionsRow[] = transport.options
    .filter((o) => !o.isBaseline)
    .map((o) => {
      const cmp = o.emissionsVsBaseline;
      const available = cmp !== null && cmp.status === "available" && cmp.difference !== null;
      const grams = available ? cmp.difference.gramsCo2 : null;
      return {
        mode: o.mode,
        label: o.label,
        status: available ? "available" : "unavailable",
        unavailableReason: available ? null : (o.emissions.detail ?? cmp?.baseline.detail ?? "Unavailable."),
        direction: available ? cmp.difference.direction : null,
        oneWayGramsCo2: grams,
        weeklyGramsCo2: grams === null ? null : Math.round(grams * 2 * prefs.commuteDaysPerWeek * 10) / 10,
        factorId: o.emissions.factor?.id ?? null,
        factorSourceUrl: o.emissions.factor?.source?.url ?? null,
      };
    });
  return {
    gas: "CO2",
    basis: "tailpipe-co2",
    baselineMode: transport.baselineMode,
    distanceKm: transport.distanceKm,
    distanceIsAssumed: transport.distanceIsAssumed,
    scaling: { tripsPerDay: 2, daysPerWeek: prefs.commuteDaysPerWeek },
    rows,
    note: "Per passenger, tailpipe CO2 only, relative to the current mode. A 'reduction' is a modelled difference, not a measured saving. Distance is " + (transport.distanceIsAssumed ? "a preset assumption." : "the one you supplied."),
  };
}

const TRANSPORT_FEASIBILITY = (o: TransportOption): Feasibility =>
  o.convenience.rating === "high" ? "high" : o.convenience.rating === "low" ? "low" : "medium";
const TRANSPORT_COST: Readonly<Record<TransportMode, CostLevel>> = { walking: "none", cycling: "low", carpool: "none", bus: "low", metro: "low", two_wheeler: "none", private_car: "none" };

export function generateRecommendations(input: RecommendationInput): RecommendationOutcome {
  const resolved = resolveProfile(input.profileId, input.preferences);
  if (!resolved.ok) return { ok: false, reason: resolved.reason };
  const { preset, preferences: prefs, overridden } = resolved;
  const { air, nowMs } = input;

  const severity = severityOf(air);
  const dataAvailable = air.freshnessStatus !== "unavailable";
  const stale = air.freshnessStatus === "stale";
  const aqiContext = airContextOf(air, severity);
  const aqiRef: DataRef | null =
    aqiContext.aqi === null
      ? null
      : { kind: "aqi", ref: air.calculatedAqi?.calculatedAt ?? "aqi", detail: `Estimated Indian AQI ${aqiContext.aqi} (${aqiContext.categoryLabel}), dominant pollutant ${aqiContext.dominantPollutant ?? "n/a"}` };

  const forecastHours = dataAvailable ? air.forecastHourlyData.hours : [];

  const routineResult = buildRoutine({ preset, preferences: prefs, nowMs, forecastHours, severity, stale, dataAvailable, aqiRef });
  const periods = comparePeriods(forecastHours, nowMs);

  // A generic half-hour light window, used only to time brief ventilation.
  const ventilation = evaluateOutdoorWindows({ hours: forecastHours, nowMs, durationMinutes: 30, earliestStart: "06:00", latestStart: "21:00", preferredStart: null, intensity: "light", sensitive: preset.sensitiveGroup, stale });
  const outlook: VentilationOutlook | null =
    ventilation.status === "recommended" && ventilation.best !== null
      ? { startLocal: ventilation.best.startLocal, endLocal: ventilation.best.endLocal, pm25MeanUgM3: ventilation.best.pm25MeanUgM3, forecastHours: ventilation.best.forecastHours }
      : null;

  const indoor = buildIndoorSection({ preset, preferences: prefs, severity, aqiRef, outlook, stale, dataAvailable });
  const transport = compareTransport({ preferences: prefs, severity });
  const emissions = emissionsSection(transport, prefs);
  const exposure = exposureItems(air, prefs, overridden, routineResult.section.items, routineResult.analyses, severity, aqiRef);

  // Outdoor-windows section.
  const primary =
    routineResult.section.items.find((i) => i.activity === "morning_walk" || i.activity === "outdoor_sports" || i.activity === "evening_exercise" || i.activity === "outdoor_play") ??
    routineResult.section.items[0] ??
    null;
  const primaryAnalysis = primary === null ? null : (routineResult.analyses[primary.id] ?? null);
  const analysesList = Object.values(routineResult.analyses);
  const windowsStatus: OutdoorWindowsSection["status"] =
    analysesList.length === 0 || analysesList.every((a) => a.status === "unavailable") ? "unavailable" : analysesList.some((a) => a.status === "unavailable") ? "partial" : "available";

  // Prioritisation across everything.
  const prioritized: PrioritizedRecommendation[] = [];
  const push = (kind: PrioritizedRecommendation["kind"], id: string, title: string, p: PriorityResult, exposureReductionUg: number | null) =>
    prioritized.push({ id, kind, title, tier: p.tier, score: p.score, breakdown: p.breakdown, adjustedBy: p.adjustedBy, exposureReductionUg });

  for (const item of routineResult.section.items) {
    const est = exposure.find((e) => e.id === `EXP_SHIFT_${item.id}`)?.estimate;
    const reduction = est?.difference?.direction === "reduction" ? est.difference.magnitudeUg : null;
    const changed = item.windowStatus === "recommended" || item.windowStatus === "no-suitable-window";
    const p = prioritize({
      id: `ROUTINE_${item.id}`,
      severity,
      vulnerability: preset.vulnerability,
      exposureReductionUg: reduction,
      feasibility: item.timing === "fixed" ? "medium" : "high",
      cost: "none",
      confidence: item.confidence,
      ...(changed ? {} : { maxTier: "optional" as const }),
    });
    push("routine", `ROUTINE_${item.id}`, item.suggestedTime === null ? `${item.label}: ${item.windowStatus === "no-suitable-window" ? "prefer the indoor alternative" : "no time change"}` : `${item.label}: ${item.suggestedTime.startLocal} to ${item.suggestedTime.endLocal}`, p, reduction);
  }
  const chain = routineResult.section.tripChaining;
  if (chain.status === "suggested") {
    const p = prioritize({ id: "ROUTINE_TRIP_CHAINING", severity, vulnerability: preset.vulnerability, exposureReductionUg: null, feasibility: "medium", cost: "none", confidence: chain.explanation?.confidence ?? UNAVAILABLE_CONFIDENCE("no analysis"), maxTier: "recommended" });
    push("trip-chaining", "ROUTINE_TRIP_CHAINING", `Combine ${chain.activityIds.length} errands into one journey`, p, null);
  }
  for (const iv of indoor.interventions) push("indoor", `INDOOR_${iv.id}`, iv.action.split(/(?<=\.)\s/)[0] ?? iv.action, iv.priorityDetail, null);
  for (const option of transport.options) {
    if (!option.suggested) continue;
    const p = prioritize({ id: `TRANSPORT_${option.mode}`, severity, vulnerability: preset.vulnerability, exposureReductionUg: null, feasibility: TRANSPORT_FEASIBILITY(option), cost: TRANSPORT_COST[option.mode], confidence: option.explanation.confidence, maxTier: "recommended" });
    push("transport", `TRANSPORT_${option.mode}`, `Consider ${MODE_LABELS[option.mode].toLowerCase()} instead of ${MODE_LABELS[transport.baselineMode].toLowerCase()}`, p, null);
  }
  prioritized.sort(compareByPriority);

  // Traceability registries.
  const explanations: Explanation[] = [
    ...routineResult.section.items.map((i) => i.explanation),
    ...(chain.explanation === null ? [] : [chain.explanation]),
    ...indoor.interventions.map((i) => i.explanation),
    ...transport.options.map((o) => o.explanation),
    ...exposure.map((e) => e.explanation),
    { what: "", why: "", triggeredBy: [], assumptionIds: [], ruleIds: ["RULE_PRIORITY_SCORE", "RULE_NEVER_CALL_SAFE"], impact: null, confidence: UNAVAILABLE_CONFIDENCE("registry") },
  ];
  const refs = resolveReferences(explanations);

  // Warnings.
  const warnings: EngineWarning[] = [];
  if (air.freshnessStatus === "unavailable") warnings.push({ code: "AIR_DATA_UNAVAILABLE", message: "Air quality data is unavailable, so nothing that depends on pollution levels or the forecast is recommended. General guidance is still shown." });
  if (stale) warnings.push({ code: "AIR_DATA_STALE", message: `The air data was fetched earlier and is ${air.ageSeconds ?? "unknown"} seconds old because the provider could not be reached. Only forecast hours still in the future are used.` });
  if (dataAvailable && air.forecastHourlyData.hours.length === 0) warnings.push({ code: "FORECAST_UNAVAILABLE", message: "No hourly forecast is available, so no time windows can be suggested." });
  const missing = new Set<PollutantId>();
  for (const a of analysesList) for (const m of a.pollutantsMissing) if (m.reason === "not-provided-for-every-hour") missing.add(m.pollutant);
  if (missing.size > 0) warnings.push({ code: "POLLUTANT_MISSING", message: `Forecast values are incomplete for ${[...missing].join(", ")}; they are excluded from window comparisons and lower confidence.` });
  if (analysesList.some((a) => a.status === "unavailable") && dataAvailable && air.forecastHourlyData.hours.length > 0) warnings.push({ code: "FORECAST_PARTIAL", message: "Some activities could not be compared because forecast coverage was incomplete for their times." });
  if (prefs.distanceIsAssumed) warnings.push({ code: "PRESET_DISTANCE_ASSUMED", message: `The ${prefs.commuteDistanceKm} km commute distance is a preset default; CO2 figures scale with it. Provide your own distance for a personal estimate.` });
  if (prefs.indoorPm25UgM3 === null) warnings.push({ code: "NO_INDOOR_SENSOR", message: "No indoor air sensor is connected; indoor advice is general and conditional." });
  if (prefs.schedule.some((s) => s.activity.endsWith("commute"))) warnings.push({ code: "NO_ROUTE_DATA", message: "Route-level pollution data is not available; no road-specific exposure is claimed." });
  if (transport.options.some((o) => o.emissions.status === "unavailable" && o.emissions.reason === "no-defensible-factor")) warnings.push({ code: "EMISSION_FACTOR_UNAVAILABLE", message: "No defensible emission factor is available for the metro, so its CO2 comparison is unavailable." });
  warnings.push({ code: "ESTIMATES_NOT_MEASUREMENTS", message: "Pollution, exposure and emission figures are model estimates, not measurements or medical advice." });

  const itemConfidences = routineResult.section.items.map((i) => i.confidence);
  const confidence: Confidence = !dataAvailable
    ? UNAVAILABLE_CONFIDENCE("Air quality data is unavailable.")
    : weakest(itemConfidences.length === 0 ? [UNAVAILABLE_CONFIDENCE("no activities")] : itemConfidences);

  const result: RecommendationResult = {
    schemaVersion: 1,
    status: dataAvailable ? "ok" : "air-data-unavailable",
    profileId: preset.id,
    profile: { label: preset.label, description: preset.description, focus: preset.focus, sensitiveGroup: preset.sensitiveGroup, preferences: prefs, overriddenPreferences: overridden },
    cityId: air.cityId,
    cityName: air.cityName,
    generatedAt: new Date(nowMs).toISOString(),
    dataFreshness: freshnessOf(air),
    aqiContext,
    routine: routineResult.section,
    outdoorWindows: {
      status: windowsStatus,
      wording: RELATIVELY_LOWER_LABEL,
      periods,
      trend: primaryAnalysis?.trend ?? "unknown",
      primaryActivityId: primary?.id ?? null,
      analyses: routineResult.analyses,
      tripChainingAnalysis: routineResult.chainAnalysis,
    },
    indoor,
    transport,
    exposure: { items: exposure, note: ESTIMATE_NOTE },
    emissions,
    prioritized,
    assumptions: refs.assumptions,
    rules: refs.rules,
    warnings,
    confidence,
    limitations: LIMITATIONS,
    provenance: {
      airDataSource: air.sourceInfo,
      attribution: air.sourceInfo.attribution,
      disclaimer: air.disclaimer,
      aqiProvenanceLabel: aqiContext.provenanceLabel,
      dataLocation: air.dataLocation,
      engine: { version: ENGINE_VERSION, deterministic: true, llmUsed: false, networkUsed: false },
    },
  };

  return { ok: true, result };
}

export { ASSUMPTIONS, RULES, ACTIVITY_LABELS, AGE_GROUPS, WINDOW_POLICY };
export type { FreshnessStatus };
