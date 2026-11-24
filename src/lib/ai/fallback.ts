import { POLLUTANT_INFO } from "@/lib/aqi";
import type { RecommendationResult } from "@/lib/engine";

import { LIMITS } from "./schema";
import type { AiExplanation, AiTopAction } from "./types";

/**
 * Deterministic explanations: what the user sees whenever the model is unavailable, over budget,
 * rate limited, slow, or its output is rejected. Built only from the recommendation result, by
 * plain templates, so it contains no number, time or claim the engine did not produce. It has the
 * same shape as a model explanation, so the UI renders both the same way, and the tests require it
 * to pass the same validator that guards model output.
 */

export const SAFETY_DISCLAIMER =
  "This is general information based on modelled data, not medical advice. It cannot diagnose conditions or say that any air is safe. If you or a family member has a health condition or feels unwell, follow your doctor's guidance.";

/** Keep whole sentences up to `max` characters; if the first sentence alone is too long, cut at a word. */
export function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  // A sentence ends at . ! or ? followed by a space or the end, so "PM2.5" and "11.4" are not split.
  const sentences = clean.match(/.*?[.!?]+(?=\s|$)\s*/g) ?? [];
  let out = "";
  for (const sentence of sentences) {
    if ((out + sentence).trim().length > max) break;
    out += sentence;
  }
  if (out.trim().length > 0) return out.trim();
  const cut = clean.slice(0, max - 1);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 20 ? cut.lastIndexOf(" ") : cut.length).trim()}.`;
}

const joinSentences = (parts: readonly (string | null | undefined)[]): string =>
  parts.filter((p): p is string => typeof p === "string" && p.trim().length > 0).join(" ");

function topActions(result: RecommendationResult): AiTopAction[] {
  const actions: AiTopAction[] = [];
  for (const p of result.prioritized) {
    if (actions.length >= LIMITS.topActionsMax) break;
    let explanation: string | null = null;
    let guidance: string | null = null;

    if (p.id === "ROUTINE_TRIP_CHAINING") {
      const c = result.routine.tripChaining;
      explanation = c.reason;
      guidance = c.instructions.slice(0, 2).join(" ");
    } else if (p.id.startsWith("ROUTINE_")) {
      const item = result.routine.items.find((i) => `ROUTINE_${i.id}` === p.id);
      if (item === undefined) continue;
      explanation = item.reason;
      guidance = joinSentences([item.instructions.slice(0, 2).join(" "), item.suggestedTime === null ? item.indoorAlternative : null]);
    } else if (p.id.startsWith("INDOOR_")) {
      const iv = result.indoor.interventions.find((i) => `INDOOR_${i.id}` === p.id);
      if (iv === undefined) continue;
      explanation = iv.whyItHelps;
      guidance = iv.action;
    } else if (p.id.startsWith("TRANSPORT_")) {
      const option = result.transport.options.find((o) => `TRANSPORT_${o.mode}` === p.id);
      if (option === undefined) continue;
      explanation = option.suggestionNote;
      guidance = option.tradeoff;
    }
    if (explanation === null || guidance === null || guidance.trim() === "") continue;
    actions.push({
      recommendationId: p.id,
      explanation: clip(explanation, LIMITS.actionExplanation),
      practicalGuidance: clip(guidance, LIMITS.actionGuidance),
    });
  }
  return actions;
}

export function buildFallbackExplanation(result: RecommendationResult): AiExplanation {
  const { aqiContext: aqi, dataFreshness: fresh } = result;
  const unavailable = result.status === "air-data-unavailable";
  const stale = fresh.status === "stale";

  const overview = unavailable
    ? `Air quality data is not available for ${result.cityName} right now, so recommendations that depend on pollution levels cannot be given. General guidance is shown instead.`
    : joinSentences([
        `The estimated Indian AQI for ${result.cityName} is ${aqi.aqi ?? "unavailable"}${aqi.categoryLabel === null ? "" : ` (${aqi.categoryLabel})`}.`,
        // Staleness comes before the provenance note: the overview limit must never cut it.
        stale ? "The data is not current: it comes from an earlier fetch." : null,
        "Modelled from Open-Meteo data with CPCB methodology: not an official CPCB monitoring-station reading.",
      ]);

  const situation = unavailable
    ? "No air quality reading or forecast is available, so no time windows, exposure estimates or pollution-based advice are shown. Check again later."
    : joinSentences([
        aqi.dominantPollutant === null ? null : `The pollutant that sets the estimated AQI is ${POLLUTANT_INFO[aqi.dominantPollutant].label}.`,
        "The AQI describes recent modelled conditions, while times for activities come from the model's hourly forecast, which is less certain the further ahead it looks.",
        stale ? "Because the data is stale, only forecast hours that are still ahead are used." : null,
        result.outdoorWindows.trend === "unknown" ? null : `Over the next hours the modelled pollution trend is ${result.outdoorWindows.trend}.`,
      ]);

  const personalised = joinSentences([result.profile.description, result.profile.focus]);

  const routineLines = result.routine.items.map((i) =>
    i.suggestedTime === null
      ? `${i.label}: no time change is suggested${i.windowStatus === "no-suitable-window" ? " because every time today is above the engine's advisory level" : ""}.`
      : `${i.label}: ${i.suggestedTime.startLocal} to ${i.suggestedTime.endLocal}.`,
  );
  const routine = joinSentences([
    unavailable ? "The daily routine cannot be compared without a forecast." : routineLines.join(" "),
    result.routine.tripChaining.status === "suggested" ? "Several errands can be combined into one journey, which avoids extra trips outdoors." : null,
  ]);

  const lowest = result.outdoorWindows.periods.lowestPeriod;
  const outdoor = unavailable
    ? "Forecast-based timing is unavailable."
    : joinSentences([
        lowest === null ? "The parts of the day cannot be compared with the data available." : `Of morning, afternoon and evening, the ${lowest} looks relatively lower in modelled pollution.`,
        "A relatively lower-pollution window is only a comparison with other times of day; it is not a statement that the air is safe.",
        "Harder activity means breathing in more air, so vigorous exercise is held to a stricter level than a walk.",
      ]);

  const indoorTop = result.indoor.interventions.slice(0, 2).map((i) => i.action);
  const indoor = joinSentences([
    result.indoor.measurement.note,
    ...indoorTop,
    "Source control comes first, then cleaning, filtration and only conditional ventilation.",
  ]);

  const suggested = result.transport.options.filter((o) => o.suggested);
  const transport = joinSentences([
    suggested.length === 0
      ? "No alternative to your current transport is put forward on the data available."
      : `Alternatives worth considering: ${suggested.map((o) => o.label).join(", ")}.`,
    "A lower-carbon option is not automatically a lower-exposure one, so walking and cycling are held back when air quality is poor.",
    result.transport.routeData.note,
  ]);

  const exposureLines = result.exposure.items
    .filter((e) => e.estimate.status === "available" && e.estimate.difference !== null)
    .slice(0, 3)
    .map((e) => `${e.title}: an estimated ${e.estimate.difference?.direction === "increase" ? "increase" : "reduction"} in the PM2.5 you would inhale${e.estimate.bestCase ? " (a best-case ceiling, not an expected value)" : ""}.`);
  const co2 = result.emissions.rows.find((r) => r.status === "available" && r.direction === "reduction");
  const impact = joinSentences([
    // First, so the length limit can never cut the "estimates, not measurements" statement.
    "These are model estimates under stated assumptions, not measurements.",
    exposureLines.length === 0 ? "No PM2.5 exposure estimate is available for this result." : exposureLines.join(" "),
    co2 === undefined
      ? "No CO2 comparison shows a reduction for your current transport."
      : `Switching from your current transport to ${co2.label.toLowerCase()} is estimated to lower tailpipe CO2 per passenger one way.`,
  ]);

  const limitations = [
    ...result.limitations.slice(0, 4),
    ...result.warnings.filter((w) => w.code !== "ESTIMATES_NOT_MEASUREMENTS").slice(0, 2).map((w) => w.message),
  ]
    .map((l) => clip(l, LIMITS.limitation))
    .slice(0, LIMITS.limitationsMax);

  return {
    overview: clip(overview, LIMITS.overview),
    situationExplanation: clip(situation, LIMITS.paragraph),
    personalizedSummary: clip(personalised, LIMITS.paragraph),
    topActions: topActions(result),
    routineExplanation: clip(routine, LIMITS.paragraph),
    outdoorActivityExplanation: clip(outdoor, LIMITS.paragraph),
    indoorAirExplanation: clip(indoor, LIMITS.paragraph),
    transportExplanation: clip(transport, LIMITS.paragraph),
    impactExplanation: clip(impact, LIMITS.paragraph),
    dataLimitations: limitations,
    safetyDisclaimer: SAFETY_DISCLAIMER,
  };
}
