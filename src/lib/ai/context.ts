import type { RecommendationResult } from "@/lib/engine";
import type { NormalizedAirData } from "@/types/air";

/**
 * The ONLY data a model receives: a compact, explicitly typed, server-built projection of the
 * deterministic recommendation result and the normalized air data. Nothing here comes from the client
 * except the validated profile ID, city ID and preferences, which the engine has already resolved.
 *
 * Properties:
 *  - Contains no free text from any user: the request schema has no free-text field.
 *  - Contains no secret, header, address or identifier of the requester.
 *  - Is stable for identical results (no clock-dependent fields), so its hash is a sound cache key
 *    and changes whenever any recommendation or number changes.
 *  - Is COMPACT (Phase 3C): only what is needed to explain WHY an action was recommended. Raw hourly
 *    history, forecast arrays, ISO timestamps beyond the data timestamp, formulas, assumption text,
 *    duplicated metadata and unused profile fields are not sent: the dashboard shows those directly
 *    from the deterministic result, and the model is told not to repeat them.
 *  - Numeric keys end in a unit suffix (Percent, Km, Min, Ug, UgM3, GCo2) or are named `aqi`. The
 *    validator reads that suffix to decide which UNIT a number may be quoted with.
 *  - Is bounded: lists are capped and the serialized size is checked before any model call.
 */

export const MAX_CONTEXT_BYTES = 18_000;
const MAX_RECOMMENDATIONS = 12;
const MAX_EXPOSURE_ITEMS = 4;
const MAX_LIMITATIONS = 6;
const MAX_INSTRUCTION_CHARS = 220;

export type ContextValue = string | number | boolean | null | readonly ContextValue[] | { readonly [key: string]: ContextValue };
export type GroundingContext = { readonly [key: string]: ContextValue };

export interface GroundingResult {
  readonly context: GroundingContext;
  /** IDs the model may reference: ranked recommendations and exposure estimates. */
  readonly allowedIds: readonly string[];
  readonly json: string;
}

const slot = (t: { startLocal: string; endLocal: string } | null): ContextValue =>
  t === null ? null : { start: t.startLocal, end: t.endLocal };

/** Instruction text kept short: the dashboard shows the full steps from the deterministic result. */
function brief(value: unknown): ContextValue {
  const text = Array.isArray(value) ? value.map(String).join(" ") : typeof value === "string" ? value : null;
  if (text === null) return null;
  if (text.length <= MAX_INSTRUCTION_CHARS) return text;
  const cut = text.slice(0, MAX_INSTRUCTION_CHARS);
  const space = cut.lastIndexOf(" ");
  return `${cut.slice(0, space > 80 ? space : MAX_INSTRUCTION_CHARS)}...`;
}

function recommendationDetails(result: RecommendationResult, id: string): ContextValue {
  if (id.startsWith("ROUTINE_") && id !== "ROUTINE_TRIP_CHAINING") {
    const item = result.routine.items.find((i) => `ROUTINE_${i.id}` === id);
    if (item === undefined) return null;
    return {
      activity: item.label,
      durationMin: item.durationMinutes,
      effort: item.intensity,
      timing: item.timing,
      usualStart: item.usualStartLocal,
      suggested: slot(item.suggestedTime),
      alternative: slot(item.alternativeTime),
      windowStatus: item.windowStatus,
      exposureDirection: item.exposureDirection,
      changeVsUsualPercent: item.changeVsUsualPercent,
      confidence: item.confidence.level,
      why: item.reason,
      howTo: brief(item.instructions),
      indoorAlternative: item.indoorAlternative,
    };
  }
  if (id === "ROUTINE_TRIP_CHAINING") {
    const c = result.routine.tripChaining;
    return {
      combinedDurationMin: c.combinedDurationMinutes,
      journeysSaved: c.journeysSaved,
      suggested: slot(c.suggestedTime),
      windowStatus: c.windowStatus,
      why: c.reason,
      howTo: brief(c.instructions),
      co2: c.co2.reason,
    };
  }
  if (id.startsWith("INDOOR_")) {
    const iv = result.indoor.interventions.find((i) => `INDOOR_${i.id}` === id);
    if (iv === undefined) return null;
    return {
      category: iv.category,
      action: iv.action,
      why: iv.whyItHelps,
      cost: iv.costLevel,
      feasibility: iv.feasibility,
      evidence: iv.evidenceCategory,
      limits: iv.limitations,
      conditions: iv.conditions,
    };
  }
  if (id.startsWith("TRANSPORT_")) {
    const option = result.transport.options.find((o) => `TRANSPORT_${o.mode}` === id);
    if (option === undefined) return null;
    const diff = option.emissionsVsBaseline?.difference ?? null;
    return {
      mode: option.label,
      co2OneWayGCo2: option.emissions.totalGramsPerPassenger,
      co2VsCurrent: diff === null ? null : { direction: diff.direction, gCo2: diff.gramsCo2 },
      co2Unavailable: option.emissions.status === "unavailable" ? (option.emissions.detail ?? "unavailable") : null,
      exposureVsCurrent: option.exposure.direction,
      exposureNote: option.exposure.rationale,
      convenience: option.convenience.rating,
      travelMin: option.convenience.travelMinutes,
      why: option.suggestionNote,
    };
  }
  return null;
}

export function buildGroundingContext(result: RecommendationResult, air: NormalizedAirData): GroundingResult {
  const ranked = result.prioritized.slice(0, MAX_RECOMMENDATIONS);
  const exposure = result.exposure.items.slice(0, MAX_EXPOSURE_ITEMS);
  const prefs = result.profile.preferences;
  const missing = air.pollutantAvailability.filter((p) => p.status !== "available").map((p) => p.pollutant);

  // Warnings first: a stale-data or missing-data warning must never be the one that is cut.
  const limitations = [...new Set([...result.warnings.map((w) => w.message), ...result.limitations])].slice(0, MAX_LIMITATIONS);

  const context: GroundingContext = {
    place: { city: result.cityName, state: air.state, timezone: air.timezone },
    air: {
      aqi: result.aqiContext.aqi,
      category: result.aqiContext.categoryLabel,
      dominantPollutant: result.aqiContext.dominantPollutant,
      severity: result.aqiContext.severity,
      status: result.aqiContext.aqiStatus,
      freshness: result.dataFreshness.status,
      dataTimestamp: result.dataFreshness.dataTimestamp,
      source: "Open-Meteo / CAMS atmospheric model: modelled estimates, not CPCB station readings",
      missingPollutants: missing,
    },
    profile: {
      id: result.profileId,
      label: result.profile.label,
      sensitiveGroup: result.profile.sensitiveGroup,
      userSuppliedPreferences: result.profile.overriddenPreferences,
      transport: prefs.preferredTransport,
      commuteDistanceKm: prefs.commuteDistanceKm,
      commuteDistanceAssumed: prefs.distanceIsAssumed,
      cookingFuel: prefs.cookingFuel,
      hasAirPurifier: prefs.hasAirPurifier,
      ventilation: prefs.ventilationPreference,
      userReportedIndoorPm25UgM3: prefs.indoorPm25UgM3,
    },
    recommendations: ranked.map((p) => ({ id: p.id, kind: p.kind, priority: p.tier, title: p.title, details: recommendationDetails(result, p.id) })),
    // Every routine item's suggested time, so times quoted for a lower-ranked item are still grounded.
    routine: result.routine.items.map((i) => ({ activity: i.label, suggested: slot(i.suggestedTime), windowStatus: i.windowStatus })),
    outdoor: {
      status: result.outdoorWindows.status,
      wording: result.outdoorWindows.wording,
      trend: result.outdoorWindows.trend,
      lowestPartOfDay: result.outdoorWindows.periods.lowestPeriod,
      highestPartOfDay: result.outdoorWindows.periods.highestPeriod,
    },
    impact: {
      pm25Exposure: exposure.map((e) => ({
        id: e.id,
        title: e.title,
        status: e.estimate.status,
        unavailableReason: e.estimate.reason,
        direction: e.estimate.difference === null ? null : e.estimate.difference.direction,
        changePercent: e.estimate.difference === null ? null : e.estimate.difference.percentOfBaseline,
        bestCaseCeilingNotExpected: e.estimate.bestCase,
      })),
      co2: {
        gas: result.emissions.gas,
        basis: "tailpipe CO2 only (not CO2e, not lifecycle)",
        currentMode: result.emissions.baselineMode,
        oneWayDistanceKm: result.emissions.distanceKm,
        distanceAssumed: result.emissions.distanceIsAssumed,
      },
    },
    limitations,
  };

  const allowedIds = [...ranked.map((p) => p.id), ...exposure.map((e) => e.id)];
  return { context, allowedIds, json: JSON.stringify(context) };
}
