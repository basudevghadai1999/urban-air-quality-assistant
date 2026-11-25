import { z } from "zod";

import { CITY_IDS } from "@/config/cities";
import { AI_REASON_CODES } from "@/lib/ai/errors";
import { AI_PROVIDER_NAMES, AI_STATUSES, type AiEnvelope } from "@/lib/ai/types";
import { CHAT_STATUSES, type ChatEnvelope } from "@/lib/ai/chatTypes";
import { normalizedAirDataSchema } from "@/lib/cache/snapshotSchema";
import { POLLUTANT_IDS } from "@/lib/aqi";
import type { RecommendationResult } from "@/lib/engine";
import {
  ACTIVITY_KINDS,
  AGE_GROUPS,
  COOKING_FUELS,
  PROFILE_IDS,
  TRANSPORT_MODES,
  VENTILATION_PREFERENCES,
} from "@/lib/engine/types";
import { AIR_API_ERROR_CODES, type AirApiError, type NormalizedAirData } from "@/types/air";
import { CHAT_API_ERROR_CODES, RECOMMEND_API_ERROR_CODES, type ChatApiError, type RecommendApiError } from "@/types/api";

/**
 * Runtime validation of what the browser receives from /api/air, /api/recommend and /api/chat.
 *
 * The payloads are built by the server, but a proxy error page, a stale deployment or a bug can put
 * anything on the wire, and the UI dereferences these objects without checks. Every response is parsed
 * here once, and only a value that passes is handed to the UI.
 *
 * Typing: the recommendation, AI and chat schemas are annotated with the existing TypeScript types
 * (`z.ZodType<T>`), so the compiler fails if a schema stops matching its type. Objects are `looseObject`
 * so a field added by a newer server is tolerated; fields the types declare are all required, with
 * enums for every status and kind. The fresh/stale air payload reuses `normalizedAirDataSchema` (the
 * validator the server applies to cached snapshots, including its AQI integrity checks).
 *
 * Client-safe: only zod, constants and types are imported. Nothing here is server-only.
 */

/* ------------------------------------------------------------------ */
/* Shared primitives                                                  */
/* ------------------------------------------------------------------ */

const pollutantId = z.enum(POLLUTANT_IDS);
const providerPollutantId = z.enum(["pm25", "pm10", "no2", "so2", "o3", "co"]);
const nullableString = z.string().nullable();
const nullableNumber = z.number().nullable();
const strings = z.array(z.string());
const retryAfterSeconds = z.number().nonnegative();
const reasonCode = z.enum(AI_REASON_CODES);

/* ------------------------------------------------------------------ */
/* Air                                                                */
/* ------------------------------------------------------------------ */

const hourlyValues = z.partialRecord(providerPollutantId, nullableNumber);
const hourlyRecord = z.looseObject({ time: z.string(), epochSeconds: z.number(), values: hourlyValues });
const hourlyDataset = z.looseObject({
  kind: z.enum(["historical-model", "forecast-model"]),
  label: z.string(),
  rangeStart: nullableString,
  rangeEnd: nullableString,
  hours: z.array(hourlyRecord),
});
const latLon = z.looseObject({ latitude: z.number(), longitude: z.number() });

const airWarning = z.looseObject({
  code: z.enum([
    "STALE_DATA",
    "UPSTREAM_UNAVAILABLE",
    "NO_CACHED_DATA",
    "PROVIDER_DATA_LAGGING",
    "CURRENT_CONDITIONS_UNAVAILABLE",
    "NO_HISTORICAL_DATA",
    "VARIABLE_MISSING",
    "UNEXPECTED_UNIT",
    "NO_VALID_DATA",
    "REFRESH_PAUSED",
  ]),
  message: z.string(),
  pollutant: pollutantId.optional(),
});

const dataSourceInfo = z.looseObject({
  id: z.literal("open-meteo-air-quality"),
  name: z.string(),
  description: z.string(),
  kind: z.literal("atmospheric-model"),
  url: z.string(),
  licence: z.string(),
  attribution: z.string(),
  attributionLinks: z.array(z.looseObject({ label: z.string(), url: z.string() })),
});

/**
 * The explicit "no data" state the server sends with a 503: nothing was ever received for the city,
 * so there is no reading, no age and no AQI. Fully typed: there is no AQI object to describe.
 */
const unavailableAirSchemaShape = z.looseObject({
  cityId: z.enum(CITY_IDS),
  cityName: z.string(),
  state: z.string(),
  dataLocation: z.string(),
  coordinates: z.looseObject({ requested: latLon, grid: latLon.nullable() }),
  timezone: z.string(),
  source: z.literal("open-meteo"),
  sourceName: z.string(),
  sourceDescription: z.string(),
  sourceInfo: dataSourceInfo,
  disclaimer: z.string(),
  fetchedAt: z.null(),
  providerGeneratedAt: nullableString,
  dataTimestamp: z.null(),
  currentConditions: z.null(),
  historicalHourlyData: hourlyDataset,
  forecastHourlyData: hourlyDataset,
  sourceUnits: z.partialRecord(providerPollutantId, z.string()),
  unitConversions: z.array(
    z.looseObject({ pollutant: pollutantId, from: z.literal("ug/m3"), to: z.literal("mg/m3"), factor: z.number(), appliedTo: z.literal("cpcb-aqi-input") }),
  ),
  calculatedAqi: z.null(),
  dataCompleteness: z.null(),
  missingPollutants: z.array(pollutantId),
  pollutantAvailability: z.array(
    z.looseObject({
      pollutant: pollutantId,
      status: z.enum(["available", "unavailable"]),
      reason: z.enum(["not-provided-by-provider", "variable-missing", "unexpected-unit", "no-valid-data", "upstream-unavailable"]).optional(),
      sourceUnit: z.string().optional(),
    }),
  ),
  warnings: z.array(airWarning),
  freshnessStatus: z.literal("unavailable"),
  ageSeconds: z.null(),
  cache: z.looseObject({
    status: z.enum(["miss", "hit", "stale-fallback", "none"]),
    ttlSeconds: z.number(),
    expiresAt: nullableString,
    capability: z.enum(["persistent", "persistent-unavailable", "memory-only"]).optional(),
    degraded: z.boolean().optional(),
  }),
});
/**
 * Assignable to `NormalizedAirData` (checked here). Deliberately NOT mutually equal: it describes only the one
 * unavailable state (nulls and the literal `"unavailable"`), so it is a subset of the full type by design.
 */
export const unavailableAirSchema: z.ZodType<NormalizedAirData> = unavailableAirSchemaShape;

/**
 * A fresh or stale reading. Narrowing by type guard: `normalizedAirDataSchema` checks the structure and the
 * AQI integrity rules, but is deliberately looser than `NormalizedAirData` for nested AQI detail, so it
 * cannot be a typed schema. The guard parses once; nothing is repaired or copied.
 */
export function isAirReading(value: unknown): value is NormalizedAirData {
  return normalizedAirDataSchema.safeParse(value).success;
}

export const airErrorSchema = z.looseObject({
  ok: z.literal(false),
  error: z.looseObject({
    code: z.enum(AIR_API_ERROR_CODES),
    message: z.string(),
    validCityIds: strings.optional(),
    retryAfterSeconds: retryAfterSeconds.optional(),
  }),
});

/** Success envelope. `data` is validated separately (see `isAirReading`), so a bad payload is one failure, not two. */
export const airSuccessSchema = z.looseObject({ ok: z.literal(true), data: z.unknown() });

/* ------------------------------------------------------------------ */
/* Recommendation result                                              */
/* ------------------------------------------------------------------ */

const confidenceLevel = z.enum(["high", "medium", "low", "unavailable"]);
const confidence = z.looseObject({
  level: confidenceLevel,
  score: z.number(),
  factors: z.array(z.looseObject({ id: z.string(), penalty: z.number(), detail: z.string() })),
});
const dataRef = z.looseObject({
  kind: z.enum(["aqi", "forecast-window", "forecast-hour", "profile", "preference", "rule", "calculation"]),
  ref: z.string(),
  detail: z.string().optional(),
});
const explanation = z.looseObject({
  what: z.string(),
  why: z.string(),
  triggeredBy: z.array(dataRef),
  assumptionIds: strings,
  ruleIds: strings,
  impact: nullableString,
  confidence,
});
const priorityTier = z.enum(["high", "recommended", "optional"]);
const costLevel = z.enum(["none", "low", "medium", "high"]);
const feasibility = z.enum(["high", "medium", "low"]);
const intensity = z.enum(["light", "moderate", "vigorous"]);
const transportMode = z.enum(TRANSPORT_MODES);
const windowStatus = z.enum(["recommended", "no-meaningful-difference", "no-suitable-window", "unavailable"]);
const periodId = z.enum(["morning", "afternoon", "evening"]);
const trend = z.enum(["rising", "falling", "steady", "unknown"]);
const sectionStatus = z.enum(["available", "partial", "unavailable"]);
const exposureDirection = z.enum(["lower", "higher", "unknown"]);
const changeDirection = z.enum(["reduction", "increase", "no-change"]);

const timeSlot = z.looseObject({ start: z.string(), end: z.string(), startLocal: z.string(), endLocal: z.string() });

const windowCandidate = z.looseObject({
  startMs: z.number(),
  endMs: z.number(),
  start: z.string(),
  end: z.string(),
  startLocal: z.string(),
  endLocal: z.string(),
  indicator: z.number(),
  limitingPollutant: pollutantId,
  pollutants: z.array(z.looseObject({ pollutant: pollutantId, meanUgM3: z.number(), subIndex: z.number() })),
  pm25MeanUgM3: z.number(),
  forecastHours: strings,
});
const missingPollutant = z.looseObject({
  pollutant: pollutantId,
  reason: z.enum(["not-provided-for-every-hour", "not-supported-by-provider"]),
});
const outdoorWindowAnalysis = z.looseObject({
  status: windowStatus,
  unavailableReason: z.enum(["no-forecast", "no-future-hours", "pm25-incomplete", "no-complete-window"]).nullable(),
  label: z.string(),
  durationMinutes: z.number(),
  intensity,
  best: windowCandidate.nullable(),
  alternative: windowCandidate.nullable(),
  preferred: windowCandidate.nullable(),
  recommended: z.array(windowCandidate),
  higherExposure: z.array(windowCandidate),
  comparison: z
    .looseObject({
      candidateCount: z.number(),
      medianIndicator: z.number(),
      bestIndicator: z.number(),
      worstIndicator: z.number(),
      bestVsMedianPercent: z.number(),
      preferredIndicator: nullableNumber,
      bestVsPreferredPercent: nullableNumber,
      ceiling: z.number(),
    })
    .nullable(),
  trend,
  pollutantsUsed: z.array(pollutantId),
  pollutantsMissing: z.array(missingPollutant),
  confidence,
});

const routineItem = z.looseObject({
  id: z.string(),
  activity: z.enum(ACTIVITY_KINDS),
  label: z.string(),
  durationMinutes: z.number(),
  intensity,
  timing: z.enum(["fixed", "flexible"]),
  usualStartLocal: z.string(),
  suggestedTime: timeSlot.nullable(),
  alternativeTime: timeSlot.nullable(),
  reason: z.string(),
  pollutant: pollutantId.nullable(),
  supportingForecastTimestamps: strings,
  exposureDirection,
  windowStatus,
  windowLabel: z.string(),
  changeVsUsualPercent: nullableNumber,
  confidence,
  instructions: strings,
  indoorAlternative: nullableString,
  explanation,
});
const tripChaining = z.looseObject({
  status: z.enum(["suggested", "not-applicable", "unavailable"]),
  activityIds: strings,
  combinedDurationMinutes: nullableNumber,
  journeysSaved: z.number(),
  suggestedTime: timeSlot.nullable(),
  windowStatus: windowStatus.nullable(),
  reason: z.string(),
  instructions: strings,
  co2: z.looseObject({ status: z.literal("unavailable"), reason: z.string() }),
  explanation: explanation.nullable(),
});

const priorityBreakdown = z.looseObject({
  severity: z.number(),
  vulnerability: z.number(),
  exposureReduction: z.number(),
  feasibility: z.number(),
  cost: z.number(),
  confidence: z.number(),
});
const reference = z.looseObject({ title: z.string(), url: z.string() });
const indoorIntervention = z.looseObject({
  id: z.string(),
  category: z.enum(["source-control", "cleaning", "filtration", "ventilation", "lifestyle"]),
  action: z.string(),
  whyItHelps: z.string(),
  priority: priorityTier,
  priorityDetail: z.looseObject({
    id: z.string(),
    tier: priorityTier,
    score: z.number(),
    breakdown: priorityBreakdown,
    adjustedBy: nullableString,
  }),
  costLevel,
  feasibility,
  evidenceCategory: z.enum(["agency-guidance", "engineering-principle", "limited-evidence"]),
  limitations: strings,
  conditions: strings,
  references: z.array(reference),
  explanation,
});

const emissionsUnavailableReason = z
  .enum(["distance-missing", "occupancy-missing", "carpool-needs-two-or-more-occupants", "no-defensible-factor", "invalid-input"])
  .nullable();
const factorCitation = z.looseObject({
  id: z.string(),
  label: z.string(),
  value: z.number(),
  unit: z.enum(["kgCO2/vehicle-km", "kgCO2/passenger-km"]),
  basis: z.literal("tailpipe-co2"),
  gases: z.literal("CO2 only"),
  vehicleCategory: z.string(),
  occupancyNote: z.string(),
  geography: z.string(),
  source: z
    .looseObject({ title: z.string(), publisher: z.string(), year: z.number(), url: z.string(), locator: z.string() })
    .nullable(),
  notes: z.string(),
});
const tripEmissions = z.looseObject({
  status: z.enum(["available", "unavailable"]),
  reason: emissionsUnavailableReason,
  detail: nullableString,
  mode: transportMode,
  factor: factorCitation.nullable(),
  distanceKm: nullableNumber,
  occupancy: nullableNumber,
  gramsPerPassengerKm: nullableNumber,
  totalGramsPerPassenger: nullableNumber,
  formula: z.string(),
});
const transportOption = z.looseObject({
  mode: transportMode,
  label: z.string(),
  isBaseline: z.boolean(),
  emissions: tripEmissions,
  emissionsVsBaseline: z
    .looseObject({
      status: z.enum(["available", "unavailable"]),
      reason: emissionsUnavailableReason,
      baseline: tripEmissions,
      alternative: tripEmissions,
      difference: z
        .looseObject({ direction: changeDirection, gramsCo2: z.number(), percentOfBaseline: nullableNumber })
        .nullable(),
      gas: z.literal("CO2"),
      basis: z.literal("tailpipe-co2"),
      note: z.string(),
    })
    .nullable(),
  exposure: z.looseObject({ direction: exposureDirection, quantified: z.literal(false), rationale: z.string() }),
  convenience: z.looseObject({
    rating: z.enum(["high", "medium", "low", "not-assessed"]),
    travelMinutes: nullableNumber,
    travelTimeBasis: z.enum(["user-provided", "engine-assumption", "not-provided"]),
    notes: z.string(),
  }),
  practical: z.looseObject({ feasible: z.boolean(), note: z.string() }),
  suggested: z.boolean(),
  suggestionNote: z.string(),
  tradeoff: z.string(),
  explanation,
});

const scenarioResult = z.looseObject({
  label: z.string(),
  pm25UgM3: z.number(),
  concentrationSource: z.string(),
  breathingRateM3PerHour: z.number(),
  durationHours: z.number(),
  protectionFraction: z.number(),
  inhaledMassUg: z.number(),
});
const exposureEstimate = z.looseObject({
  status: z.enum(["available", "unavailable"]),
  reason: z
    .enum(["missing-concentration", "invalid-concentration", "invalid-duration", "invalid-breathing-rate", "invalid-protection"])
    .nullable(),
  baseline: scenarioResult.nullable(),
  alternative: scenarioResult.nullable(),
  difference: z
    .looseObject({ direction: changeDirection, magnitudeUg: z.number(), percentOfBaseline: nullableNumber })
    .nullable(),
  sensitivityAtP95BreathingRate: z
    .looseObject({ baselineUg: z.number(), alternativeUg: z.number(), magnitudeUg: z.number() })
    .nullable(),
  bestCase: z.boolean(),
  formula: z.string(),
  units: z.looseObject({
    concentration: z.literal("ug/m3"),
    breathingRate: z.literal("m3/hour"),
    duration: z.literal("hours"),
    result: z.literal("ug (micrograms of PM2.5 inhaled)"),
  }),
  inputs: z.array(z.looseObject({ name: z.string(), value: z.string(), unit: z.string(), source: z.string() })),
  uncertainty: z.string(),
  dataSource: z.string(),
});

const resolvedPreferences = z.looseObject({
  wakeUpTime: z.string(),
  workOrSchoolStart: z.string(),
  commuteMinutes: z.number(),
  commuteDistanceKm: z.number(),
  distanceIsAssumed: z.boolean(),
  commuteDaysPerWeek: z.number(),
  preferredTransport: transportMode,
  vehicleOccupancy: z.number(),
  outdoorActivityMinutes: z.number(),
  householdSize: z.number(),
  cookingFuel: z.enum(COOKING_FUELS),
  hasAirPurifier: z.boolean(),
  ventilationPreference: z.enum(VENTILATION_PREFERENCES),
  ageGroup: z.enum(AGE_GROUPS),
  schedule: z.array(
    z.looseObject({
      id: z.string(),
      activity: z.enum(ACTIVITY_KINDS),
      preferredStart: z.string(),
      durationMinutes: z.number(),
      earliestStart: z.string(),
      latestStart: z.string(),
    }),
  ),
  indoorPm25UgM3: nullableNumber,
});

const recommendationResultSchemaShape = z.looseObject({
  schemaVersion: z.literal(1),
  status: z.enum(["ok", "air-data-unavailable"]),
  profileId: z.enum(PROFILE_IDS),
  profile: z.looseObject({
    label: z.string(),
    description: z.string(),
    focus: z.string(),
    sensitiveGroup: z.boolean(),
    preferences: resolvedPreferences,
    overriddenPreferences: strings,
  }),
  cityId: z.enum(CITY_IDS),
  cityName: z.string(),
  generatedAt: z.string(),
  dataFreshness: z.looseObject({
    status: z.enum(["fresh", "stale", "unavailable"]),
    fetchedAt: nullableString,
    ageSeconds: nullableNumber,
    dataTimestamp: nullableString,
    forecastRangeStart: nullableString,
    forecastRangeEnd: nullableString,
  }),
  aqiContext: z.looseObject({
    aqi: nullableNumber,
    categoryId: nullableString,
    categoryLabel: nullableString,
    dominantPollutant: pollutantId.nullable(),
    severity: z.enum(["unknown", "low", "moderate", "high", "very-high"]),
    aqiStatus: nullableString,
    provenanceLabel: nullableString,
    latestPm25UgM3: nullableNumber,
    latestPm25Time: nullableString,
  }),
  routine: z.looseObject({ status: sectionStatus, items: z.array(routineItem), tripChaining }),
  outdoorWindows: z.looseObject({
    status: sectionStatus,
    // Pinned by the type (`typeof RELATIVELY_LOWER_LABEL`): the UI must never be handed "safe" wording. The compiler checks this literal.
    wording: z.literal("Relatively lower-pollution window"),
    periods: z.looseObject({
      status: z.enum(["available", "unavailable"]),
      periods: z.array(
        z.looseObject({
          period: periodId,
          label: z.string(),
          hoursCovered: z.number(),
          hoursInPeriod: z.number(),
          indicator: nullableNumber,
          limitingPollutant: pollutantId.nullable(),
          pm25MeanUgM3: nullableNumber,
          forecastHours: strings,
        }),
      ),
      lowestPeriod: periodId.nullable(),
      highestPeriod: periodId.nullable(),
      pollutantsUsed: z.array(pollutantId),
      pollutantsMissing: z.array(missingPollutant),
    }),
    trend,
    primaryActivityId: nullableString,
    analyses: z.record(z.string(), outdoorWindowAnalysis),
    tripChainingAnalysis: outdoorWindowAnalysis.nullable(),
  }),
  indoor: z.looseObject({
    measurement: z.looseObject({ status: z.enum(["no-indoor-sensor", "user-reported"]), pm25UgM3: nullableNumber, note: z.string() }),
    interventions: z.array(indoorIntervention),
  }),
  transport: z.looseObject({
    status: z.enum(["available", "partial"]),
    baselineMode: transportMode,
    distanceKm: z.number(),
    distanceIsAssumed: z.boolean(),
    options: z.array(transportOption),
    routeData: z.looseObject({ available: z.literal(false), note: z.string() }),
  }),
  exposure: z.looseObject({
    items: z.array(
      z.looseObject({ id: z.string(), title: z.string(), activityId: nullableString, estimate: exposureEstimate, explanation }),
    ),
    note: z.string(),
  }),
  emissions: z.looseObject({
    gas: z.literal("CO2"),
    basis: z.literal("tailpipe-co2"),
    baselineMode: transportMode,
    distanceKm: z.number(),
    distanceIsAssumed: z.boolean(),
    scaling: z.looseObject({ tripsPerDay: z.literal(2), daysPerWeek: z.number() }),
    rows: z.array(
      z.looseObject({
        mode: transportMode,
        label: z.string(),
        status: z.enum(["available", "unavailable"]),
        unavailableReason: nullableString,
        direction: changeDirection.nullable(),
        oneWayGramsCo2: nullableNumber,
        weeklyGramsCo2: nullableNumber,
        factorId: nullableString,
        factorSourceUrl: nullableString,
      }),
    ),
    note: z.string(),
  }),
  prioritized: z.array(
    z.looseObject({
      id: z.string(),
      kind: z.enum(["routine", "trip-chaining", "indoor", "transport"]),
      title: z.string(),
      tier: priorityTier,
      score: z.number(),
      breakdown: priorityBreakdown,
      adjustedBy: nullableString,
      exposureReductionUg: nullableNumber,
    }),
  ),
  assumptions: z.array(
    z.looseObject({
      id: z.string(),
      kind: z.enum(["sourced", "engine-policy", "preset-default"]),
      statement: z.string(),
      source: nullableString,
      url: nullableString,
    }),
  ),
  rules: z.array(z.looseObject({ id: z.string(), statement: z.string(), basis: z.string() })),
  warnings: z.array(
    z.looseObject({
      code: z.enum([
        "AIR_DATA_STALE",
        "AIR_DATA_UNAVAILABLE",
        "FORECAST_UNAVAILABLE",
        "FORECAST_PARTIAL",
        "POLLUTANT_MISSING",
        "PRESET_DISTANCE_ASSUMED",
        "NO_INDOOR_SENSOR",
        "NO_ROUTE_DATA",
        "EMISSION_FACTOR_UNAVAILABLE",
        "ESTIMATES_NOT_MEASUREMENTS",
      ]),
      message: z.string(),
    }),
  ),
  confidence,
  limitations: strings,
  provenance: z.looseObject({
    airDataSource: dataSourceInfo,
    attribution: z.string(),
    disclaimer: z.string(),
    aqiProvenanceLabel: nullableString,
    dataLocation: z.string(),
    engine: z.looseObject({
      version: z.string(),
      deterministic: z.literal(true),
      llmUsed: z.literal(false),
      networkUsed: z.literal(false),
    }),
  }),
});
/** Assignable to `RecommendationResult` (checked here) and equal to it on every known key (checked in `ContractInSync`). */
export const recommendationResultSchema: z.ZodType<RecommendationResult> = recommendationResultSchemaShape;

/* ------------------------------------------------------------------ */
/* AI explanation and chat envelopes                                  */
/* ------------------------------------------------------------------ */

const providerName = z.enum(AI_PROVIDER_NAMES);

const aiEnvelopeSchemaShape = z.looseObject({
  status: z.enum(AI_STATUSES),
  reasonCode: reasonCode.nullable(),
  message: z.string(),
  explanation: z
    .looseObject({
      overview: z.string(),
      situationExplanation: z.string(),
      personalizedSummary: z.string(),
      topActions: z.array(
        z.looseObject({ recommendationId: z.string(), explanation: z.string(), practicalGuidance: z.string() }),
      ),
      routineExplanation: z.string(),
      outdoorActivityExplanation: z.string(),
      indoorAirExplanation: z.string(),
      transportExplanation: z.string(),
      impactExplanation: z.string(),
      dataLimitations: strings,
      safetyDisclaimer: z.string(),
    })
    .nullable(),
  provider: providerName,
  model: nullableString,
  attempts: z.array(z.looseObject({ provider: z.enum(["gemini", "groq"]), reasonCode })).optional(),
  tokenUsage: z
    .looseObject({ inputTokens: nullableNumber, outputTokens: nullableNumber, totalTokens: nullableNumber })
    .optional(),
  promptVersion: z.string(),
  retryAfterSeconds: retryAfterSeconds.optional(),
  numbersFromEngine: z.literal(true),
});
/** Assignable to `AiEnvelope` (checked here) and equal to it on every known key (checked in `ContractInSync`). */
export const aiEnvelopeSchema: z.ZodType<AiEnvelope> = aiEnvelopeSchemaShape;

const chatEnvelopeSchemaShape = z.looseObject({
  status: z.enum(CHAT_STATUSES),
  answer: nullableString,
  reasonCode: reasonCode.nullable(),
  message: z.string(),
  provider: providerName,
  model: nullableString,
  promptVersion: z.string(),
  retryAfterSeconds: retryAfterSeconds.optional(),
});
/** Assignable to `ChatEnvelope` (checked here) and equal to it on every known key (checked in `ContractInSync`). */
export const chatEnvelopeSchema: z.ZodType<ChatEnvelope> = chatEnvelopeSchemaShape;

/* ------------------------------------------------------------------ */
/* Recommend and chat envelopes                                       */
/* ------------------------------------------------------------------ */

/** `data` and `ai` are validated on their own, so a bad explanation never discards the deterministic result. */
export const recommendSuccessSchema = z.looseObject({ ok: z.literal(true), data: z.unknown(), ai: z.unknown().optional() });

export const recommendErrorSchema = z.looseObject({
  ok: z.literal(false),
  error: z.looseObject({
    code: z.enum(RECOMMEND_API_ERROR_CODES),
    message: z.string(),
    issues: z.array(z.looseObject({ path: z.string(), message: z.string() })).optional(),
    retryAfterSeconds: retryAfterSeconds.optional(),
  }),
});

export const chatSuccessSchema = z.looseObject({ ok: z.literal(true), chat: chatEnvelopeSchema });

export const chatErrorSchema = z.looseObject({
  ok: z.literal(false),
  error: z.looseObject({
    code: z.enum(CHAT_API_ERROR_CODES),
    message: z.string(),
    issues: z.array(z.looseObject({ path: z.string(), message: z.string() })).optional(),
    retryAfterSeconds: retryAfterSeconds.optional(),
  }),
});

/* ------------------------------------------------------------------ */
/* Server/client drift guard (compile time, no runtime cost)           */
/* ------------------------------------------------------------------ */

/**
 * `z.ZodType<T>` only proves the schema is NARROWER than `T`: an enum member the server adds, and the
 * schema forgets, still compiles. `SameContract` closes that gap by requiring mutual assignability of the
 * known keys (index signatures from `looseObject` are ignored), so adding, removing, renaming or changing
 * the optionality of any field or enum member on either side fails `tsc`. The error codes also share one
 * list with the server (`*_API_ERROR_CODES`), so for them the schema cannot differ at all. (The unavailable-air
 * schema is a deliberate subset of `NormalizedAirData`, so it keeps only the one-way check.)
 */
type KnownShape<T> = T extends readonly (infer U)[]
  ? KnownShape<U>[]
  : T extends object
    ? { -readonly [K in keyof T as string extends K ? never : K]: KnownShape<T[K]> }
    : T;
export type SameContract<Schema, Type> = [KnownShape<Schema>] extends [KnownShape<Type>] ? ([KnownShape<Type>] extends [KnownShape<Schema>] ? true : false) : false;

type MustBeTrue<T extends true> = T;
export type ContractInSync = readonly [
  MustBeTrue<SameContract<z.output<typeof recommendationResultSchemaShape>, RecommendationResult>>,
  MustBeTrue<SameContract<z.output<typeof aiEnvelopeSchemaShape>, AiEnvelope>>,
  MustBeTrue<SameContract<z.output<typeof chatEnvelopeSchemaShape>, ChatEnvelope>>,
  MustBeTrue<SameContract<z.output<typeof airErrorSchema>["error"], AirApiError["error"]>>,
  MustBeTrue<SameContract<z.output<typeof recommendErrorSchema>["error"], RecommendApiError["error"]>>,
  MustBeTrue<SameContract<z.output<typeof chatErrorSchema>["error"], ChatApiError["error"]>>,
];
