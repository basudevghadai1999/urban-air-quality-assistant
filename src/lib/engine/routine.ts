import { CONFIDENCE_PENALTY, WINDOW_POLICY } from "@/config/advisoryThresholds";
import { POLLUTANT_INFO, type PollutantId } from "@/lib/aqi";
import type { HourlyRecord } from "@/types/air";

import { parseClock } from "./clock";
import { buildConfidence } from "./confidence";
import {
  evaluateOutdoorWindows,
  type OutdoorWindowAnalysis,
  type WindowCandidate,
  type WindowStatus,
} from "./outdoorWindows";
import type {
  ActivityIntensity,
  ActivityKind,
  Confidence,
  ConfidenceFactor,
  DataRef,
  Explanation,
  ProfilePreset,
  ResolvedPreferences,
  ScheduleItem,
  SeverityLevel,
} from "./types";

/**
 * Low-emission daily routine.
 *
 * For every scheduled activity the engine evaluates the forecast windows it could move to and says,
 * in plain terms: when to do it, an alternative time, why, which pollutant drives the choice, which
 * forecast hours support it, whether the suggested time is expected to mean lower or higher exposure
 * than a typical time of day, how confident the engine is, and how to carry it out.
 *
 * Direction compares the suggested time with the user's USUAL time when the activity is moved,
 * and otherwise with the MEDIAN window the activity could take (for a fixed-time activity: the median
 * over the whole waking day), using the same 15% margin that defines a meaningful difference. "unknown" means no suggestion or no meaningful difference.
 *
 * Trip chaining: two or more errand-type activities can be combined into one journey placed in one
 * window. No CO2 saving is claimed for it, because no errand distances are known.
 */

export const ACTIVITY_LABELS: Readonly<Record<ActivityKind, string>> = {
  school_commute: "School commute",
  college_commute: "College commute",
  office_commute: "Office commute",
  grocery_shopping: "Grocery shopping",
  morning_walk: "Morning walk",
  outdoor_sports: "Outdoor sports",
  evening_exercise: "Evening exercise",
  errands: "Errands",
  outdoor_play: "Outdoor play",
};

/** Effort level, selecting the breathing rate and the advisory ceiling. */
export const ACTIVITY_INTENSITY: Readonly<Record<ActivityKind, ActivityIntensity>> = {
  school_commute: "light",
  college_commute: "light",
  office_commute: "light",
  grocery_shopping: "light",
  errands: "light",
  morning_walk: "light",
  outdoor_play: "moderate",
  evening_exercise: "moderate",
  outdoor_sports: "vigorous",
};

const COMMUTES: ReadonlySet<ActivityKind> = new Set(["school_commute", "college_commute", "office_commute"]);
const ERRANDS: ReadonlySet<ActivityKind> = new Set(["grocery_shopping", "errands"]);
const EXERCISE: ReadonlySet<ActivityKind> = new Set(["morning_walk", "outdoor_sports", "evening_exercise", "outdoor_play"]);

/** Wide range used to put a fixed-time activity in context. */
const CONTEXT_EARLIEST = "05:00";
const CONTEXT_LATEST = "21:30";

export interface TimeSlot {
  readonly start: string;
  readonly end: string;
  readonly startLocal: string;
  readonly endLocal: string;
}

export type ExposureDirection = "lower" | "higher" | "unknown";

export interface RoutineItem {
  readonly id: string;
  readonly activity: ActivityKind;
  readonly label: string;
  readonly durationMinutes: number;
  readonly intensity: ActivityIntensity;
  readonly timing: "fixed" | "flexible";
  /** The user's usual start (local clock), from the schedule. */
  readonly usualStartLocal: string;
  readonly suggestedTime: TimeSlot | null;
  readonly alternativeTime: TimeSlot | null;
  readonly reason: string;
  readonly pollutant: PollutantId | null;
  readonly supportingForecastTimestamps: readonly string[];
  readonly exposureDirection: ExposureDirection;
  readonly windowStatus: WindowStatus;
  readonly windowLabel: string;
  /** Suggested vs usual time, in percent of the window indicator (negative = lower). Null when not comparable. */
  readonly changeVsUsualPercent: number | null;
  readonly confidence: Confidence;
  readonly instructions: readonly string[];
  readonly indoorAlternative: string | null;
  readonly explanation: Explanation;
}

export interface TripChaining {
  readonly status: "suggested" | "not-applicable" | "unavailable";
  readonly activityIds: readonly string[];
  readonly combinedDurationMinutes: number | null;
  readonly journeysSaved: number;
  readonly suggestedTime: TimeSlot | null;
  readonly windowStatus: WindowStatus | null;
  readonly reason: string;
  readonly instructions: readonly string[];
  /** Never claimed: no errand distances are known. */
  readonly co2: { readonly status: "unavailable"; readonly reason: string };
  readonly explanation: Explanation | null;
}

export interface RoutineSection {
  readonly status: "available" | "partial" | "unavailable";
  readonly items: readonly RoutineItem[];
  readonly tripChaining: TripChaining;
}

export interface RoutineInput {
  readonly preset: ProfilePreset;
  readonly preferences: ResolvedPreferences;
  readonly nowMs: number;
  readonly forecastHours: readonly HourlyRecord[];
  readonly severity: SeverityLevel;
  readonly stale: boolean;
  readonly dataAvailable: boolean;
  readonly aqiRef: DataRef | null;
}

export interface RoutineResult {
  readonly section: RoutineSection;
  /** Full analysis per item ID, kept for the exposure estimates and the outdoor-windows section. */
  readonly analyses: Readonly<Record<string, OutdoorWindowAnalysis>>;
  readonly chainAnalysis: OutdoorWindowAnalysis | null;
}

const slot = (c: WindowCandidate): TimeSlot => ({ start: c.start, end: c.end, startLocal: c.startLocal, endLocal: c.endLocal });

const INDOOR_ALTERNATIVE: Partial<Record<ActivityKind, string>> = {
  morning_walk: "Walk or do gentle stretching indoors (a hallway, a corridor or a room with space), keeping the same duration.",
  outdoor_sports: "Move the session indoors (gym, home strength or mobility work, or a lower-intensity workout) instead of training hard outdoors.",
  evening_exercise: "Do the session indoors (home workout, yoga or a gym) at a lower intensity.",
  outdoor_play: "Offer indoor play: active games, building, or a safe indoor space away from kitchen and smoke sources.",
  grocery_shopping: "Postpone non-urgent shopping, or use delivery or a single combined trip.",
  errands: "Postpone non-urgent errands, or combine them into one trip.",
};

function windowReason(
  analysis: OutdoorWindowAnalysis,
  chosen: WindowCandidate,
  usual: WindowCandidate | null,
): string {
  const parts: string[] = [];
  const limiting = POLLUTANT_INFO[chosen.limitingPollutant].label;
  if (usual !== null && usual.startMs !== chosen.startMs) {
    parts.push(
      `Forecast PM2.5 averages about ${chosen.pm25MeanUgM3} ug/m3 from ${chosen.startLocal} to ${chosen.endLocal}, against about ${usual.pm25MeanUgM3} ug/m3 at your usual ${usual.startLocal}.`,
    );
  } else {
    parts.push(`Forecast PM2.5 averages about ${chosen.pm25MeanUgM3} ug/m3 from ${chosen.startLocal} to ${chosen.endLocal}.`);
  }
  parts.push(`The pollutant that sets the comparison is ${limiting}.`);
  if (usual !== null && usual.startMs !== chosen.startMs && usual.indicator > 0) {
    const pct = Math.round(((chosen.indicator - usual.indicator) / usual.indicator) * 1000) / 10;
    parts.push(`On the CPCB scale applied to model values, that window is ${Math.abs(pct)}% ${pct <= 0 ? "below" : "above"} your usual time.`);
  } else if (analysis.comparison !== null) {
    parts.push(
      `That window is ${Math.abs(analysis.comparison.bestVsMedianPercent)}% ${analysis.comparison.bestVsMedianPercent <= 0 ? "below" : "above"} the middle of the windows this activity could take today, on the CPCB scale applied to model values.`,
    );
  }
  if (analysis.pollutantsMissing.some((m) => m.reason === "not-provided-for-every-hour")) {
    const names = analysis.pollutantsMissing.filter((m) => m.reason === "not-provided-for-every-hour").map((m) => POLLUTANT_INFO[m.pollutant].label);
    parts.push(`Not compared because forecast values are incomplete: ${names.join(", ")}.`);
  }
  return parts.join(" ");
}

function directionOf(chosen: WindowCandidate | null, analysis: OutdoorWindowAnalysis): ExposureDirection {
  if (chosen === null || analysis.comparison === null) return "unknown";
  // Moving the activity: compare with the usual time. Keeping it: compare with the typical window.
  const usual = analysis.preferred;
  const reference = usual !== null && usual.start !== chosen.start ? usual.indicator : analysis.comparison.medianIndicator;
  if (reference <= 0) return "unknown";
  const rel = (chosen.indicator - reference) / reference;
  if (rel <= -WINDOW_POLICY.minRelativeImprovement) return "lower";
  if (rel >= WINDOW_POLICY.higherExposureMargin) return "higher";
  return "unknown";
}

function instructionsFor(
  schedule: ScheduleItem,
  preset: ProfilePreset,
  prefs: ResolvedPreferences,
  severity: SeverityLevel,
  status: WindowStatus,
  suggested: TimeSlot | null,
): string[] {
  const out: string[] = [];
  const activity = schedule.activity;
  const elevated = severity === "moderate" || severity === "high" || severity === "very-high";
  const poor = severity === "high" || severity === "very-high";

  if (suggested !== null) out.push(`Plan to start at ${suggested.startLocal} and finish by ${suggested.endLocal}.`);
  if (status === "no-suitable-window") {
    out.push(
      COMMUTES.has(activity)
        ? "Every start time is above the engine's advisory level today; the suggested time is only the lowest available. Use the mitigations below."
        : "No forecast window is below the engine's advisory level for this activity today. Prefer the indoor alternative.",
    );
  }

  if (COMMUTES.has(activity)) {
    if (elevated) out.push("If you can, choose the more enclosed option for the journey (train, or a car with windows closed).");
    if (prefs.preferredTransport === "two_wheeler" && elevated) {
      out.push("If you ride on a high-pollution day, a well-fitting certified particulate respirator (such as N95 or FFP2) can reduce what you breathe in, but only if it seals properly; a loose cloth mask does little.");
    }
    if (activity === "school_commute") out.push("Keep children in the vehicle until you reach the gate, and avoid idling near the school entrance.");
    if (suggested === null || !(suggested.startLocal === schedule.preferredStart)) {
      out.push("Check that the earlier or later start still gets you to school or work on time.");
    }
  } else if (EXERCISE.has(activity)) {
    out.push(poor ? "Keep any outdoor part short and gentle." : "Keep the effort moderate and stop if you feel unwell.");
    if (preset.sensitiveGroup) out.push("Follow your doctor's guidance about outdoor activity; this tool does not give medical advice.");
    if (activity === "outdoor_sports" || activity === "evening_exercise") {
      out.push("A temporary dip in the forecast is not a reason to train hard outdoors: the harder you breathe, the more you take in.");
    }
  } else if (ERRANDS.has(activity)) {
    out.push("Combine this with your other errands into one journey where you can (see the trip-chaining suggestion).");
  }
  return out.slice(0, 5);
}

export function buildRoutine(input: RoutineInput): RoutineResult {
  const { preset, preferences: prefs, nowMs, forecastHours: hours, severity, stale } = input;
  const analyses: Record<string, OutdoorWindowAnalysis> = {};
  const items: RoutineItem[] = [];

  for (const entry of prefs.schedule) {
    const fixed = parseClock(entry.earliestStart) === parseClock(entry.latestStart);
    const intensity = ACTIVITY_INTENSITY[entry.activity];
    const query = {
      hours,
      nowMs,
      durationMinutes: entry.durationMinutes,
      earliestStart: fixed ? CONTEXT_EARLIEST : entry.earliestStart,
      latestStart: fixed ? CONTEXT_LATEST : entry.latestStart,
      preferredStart: entry.preferredStart,
      intensity,
      sensitive: preset.sensitiveGroup,
      stale,
    };
    const analysis = evaluateOutdoorWindows(query);
    analyses[entry.id] = analysis;

    // Which window do we suggest?
    let chosen: WindowCandidate | null = null;
    if (fixed) chosen = analysis.preferred;
    else if (analysis.status === "recommended") chosen = analysis.best;
    else if (analysis.status === "no-meaningful-difference") chosen = analysis.preferred ?? analysis.best;
    else if (
      analysis.status === "no-suitable-window" &&
      COMMUTES.has(entry.activity) &&
      analysis.comparison !== null &&
      analysis.comparison.bestVsMedianPercent <= -WINDOW_POLICY.minRelativeImprovement * 100
    ) {
      // A trip that cannot be skipped still gets the lowest-pollution start, with the caveat spelled out below.
      chosen = analysis.best;
    }

    const direction = directionOf(chosen, analysis);
    const usual = analysis.preferred;
    const changePercent =
      chosen !== null && usual !== null && usual.indicator > 0 && chosen.startMs !== usual.startMs
        ? Math.round(((chosen.indicator - usual.indicator) / usual.indicator) * 1000) / 10
        : null;

    let reason: string;
    if (analysis.status === "unavailable") {
      reason = (analysis.confidence.factors[0]?.detail ?? "No forecast window is available.") + " Keep your usual time and check again when data returns.";
    } else if (analysis.status === "no-suitable-window" && chosen !== null) {
      reason = `Every start time today is above the engine's advisory level for ${intensity} effort${preset.sensitiveGroup ? " for this profile" : ""}, but this trip is hard to skip, so ${chosen.startLocal} is suggested as the lowest option. ${windowReason(analysis, chosen, usual)} This is a comparison with other times, not a statement that the air is acceptable.`;
    } else if (analysis.status === "no-suitable-window") {
      reason = `Every window this activity could take today is above the engine's advisory level for ${intensity} effort${preset.sensitiveGroup ? " for this profile" : ""}. The lowest is ${analysis.best?.startLocal ?? ""} to ${analysis.best?.endLocal ?? ""}, not recommended for this activity. This is advisory policy, not a medical threshold.`;
    } else if (fixed) {
      reason =
        chosen === null
          ? "The usual start is outside the forecast coverage, so it cannot be compared."
          : `This activity has a fixed start, so the time is not moved. ${windowReason(analysis, chosen, null)} Compared with other times of the day this slot looks ${direction === "unknown" ? "typical" : direction}.`;
    } else if (chosen === null) {
      reason = "No window with complete forecast coverage was found in the allowed times.";
    } else if (analysis.status === "no-meaningful-difference") {
      reason = `Timing makes little difference today: the best window is less than ${Math.round(WINDOW_POLICY.minRelativeImprovement * 100)}% below both your usual time and the middle of the windows available, so your usual time is kept. ${windowReason(analysis, chosen, null)}`;
    } else {
      reason = windowReason(analysis, chosen, usual);
    }

    const suggestedSlot = chosen === null ? null : slot(chosen);
    const alternativeSlot = analysis.status === "recommended" && analysis.alternative !== null && !fixed ? slot(analysis.alternative) : null;
    const instructions = instructionsFor(entry, preset, prefs, severity, analysis.status, suggestedSlot);

    const factors: ConfidenceFactor[] = [...analysis.confidence.factors.filter((f) => f.penalty > 0)];
    if (analysis.status === "unavailable") factors.length = 0;
    const confidence: Confidence = analysis.status === "unavailable" ? analysis.confidence : buildConfidence(factors.length === 0 ? [{ id: "model-data", penalty: CONFIDENCE_PENALTY.modelOnly, detail: "Atmospheric-model values." }] : factors);

    const triggeredBy: DataRef[] = [
      ...(input.aqiRef === null ? [] : [input.aqiRef]),
      ...(chosen === null ? [] : [{ kind: "forecast-window" as const, ref: chosen.start, detail: `${chosen.startLocal} to ${chosen.endLocal}, PM2.5 about ${chosen.pm25MeanUgM3} ug/m3` }]),
      ...(chosen === null ? [] : chosen.forecastHours.map((h): DataRef => ({ kind: "forecast-hour", ref: h }))),
      { kind: "preference", ref: `schedule.${entry.id}`, detail: `${entry.preferredStart} for ${entry.durationMinutes} min` },
      { kind: "rule", ref: "RULE_WINDOW_COMPARISON" },
    ];

    const explanation: Explanation = {
      what: suggestedSlot === null ? `${ACTIVITY_LABELS[entry.activity]}: no time change suggested.` : `${ACTIVITY_LABELS[entry.activity]}: ${suggestedSlot.startLocal} to ${suggestedSlot.endLocal}.`,
      why: reason,
      triggeredBy,
      assumptionIds: [
        "ASM_WINDOW_CPCB_SCALE_INDICATOR",
        "ASM_HOURLY_VALUE_STEP",
        "ASM_ADVISORY_CEILINGS_ARE_POLICY",
        ...(prefs.schedule.length > 0 ? ["ASM_PRESET_SCHEDULE"] : []),
      ],
      ruleIds: ["RULE_WINDOW_COMPARISON", "RULE_NEVER_CALL_SAFE", ...(intensity === "vigorous" ? ["RULE_DIP_IS_NOT_AN_INVITATION"] : [])],
      impact:
        changePercent === null
          ? null
          : `The suggested window's pollution indicator is ${Math.abs(changePercent)}% ${changePercent <= 0 ? "lower" : "higher"} than at your usual time (model-based, CPCB scale).`,
      confidence,
    };

    items.push({
      id: entry.id,
      activity: entry.activity,
      label: ACTIVITY_LABELS[entry.activity],
      durationMinutes: entry.durationMinutes,
      intensity,
      timing: fixed ? "fixed" : "flexible",
      usualStartLocal: entry.preferredStart,
      suggestedTime: suggestedSlot,
      alternativeTime: alternativeSlot,
      reason,
      pollutant: chosen?.limitingPollutant ?? analysis.best?.limitingPollutant ?? null,
      supportingForecastTimestamps: chosen?.forecastHours ?? analysis.best?.forecastHours ?? [],
      exposureDirection: direction,
      windowStatus: analysis.status,
      windowLabel: analysis.label,
      changeVsUsualPercent: changePercent,
      confidence,
      instructions,
      indoorAlternative: INDOOR_ALTERNATIVE[entry.activity] ?? null,
      explanation,
    });
  }

  const chain = buildTripChaining(input);
  const usable = items.filter((i) => i.windowStatus !== "unavailable").length;
  return {
    section: {
      status: !input.dataAvailable || usable === 0 ? "unavailable" : usable === items.length ? "available" : "partial",
      items,
      tripChaining: chain.chaining,
    },
    analyses,
    chainAnalysis: chain.analysis,
  };
}

function buildTripChaining(input: RoutineInput): { chaining: TripChaining; analysis: OutdoorWindowAnalysis | null } {
  const { preset, preferences: prefs } = input;
  const errands = prefs.schedule.filter((s) => ERRANDS.has(s.activity));
  const none = (status: TripChaining["status"], reason: string): { chaining: TripChaining; analysis: null } => ({
    chaining: {
      status,
      activityIds: errands.map((e) => e.id),
      combinedDurationMinutes: null,
      journeysSaved: 0,
      suggestedTime: null,
      windowStatus: null,
      reason,
      instructions: [],
      co2: { status: "unavailable", reason: CHAIN_CO2_REASON },
      explanation: null,
    },
    analysis: null,
  });
  if (errands.length < 2) return none("not-applicable", "Trip chaining needs at least two errand-type activities in the schedule.");

  const earliest = Math.max(...errands.map((e) => parseClock(e.earliestStart)));
  const latest = Math.min(...errands.map((e) => parseClock(e.latestStart)));
  if (earliest > latest) return none("unavailable", "The allowed times of these errands do not overlap, so they cannot be combined into one journey.");

  const total = errands.reduce((sum, e) => sum + e.durationMinutes, 0);
  const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  if (latest + total > 24 * 60) return none("unavailable", "The combined journey would run past midnight.");

  const analysis = evaluateOutdoorWindows({
    hours: input.forecastHours,
    nowMs: input.nowMs,
    durationMinutes: total,
    earliestStart: fmt(earliest),
    latestStart: fmt(latest),
    preferredStart: null,
    intensity: "light",
    sensitive: preset.sensitiveGroup,
    stale: input.stale,
  });
  const chosen = analysis.status === "recommended" || analysis.status === "no-meaningful-difference" ? analysis.best : null;
  const saved = errands.length - 1;
  const triggeredBy: DataRef[] = [
    ...errands.map((e): DataRef => ({ kind: "preference", ref: `schedule.${e.id}`, detail: `${e.durationMinutes} min` })),
    ...(chosen === null ? [] : [{ kind: "forecast-window" as const, ref: chosen.start, detail: `${chosen.startLocal} to ${chosen.endLocal}` }]),
    { kind: "rule", ref: "RULE_TRIP_CHAINING" },
  ];
  const confidence = chosen === null ? analysis.confidence : analysis.confidence;
  const reason = chosen === null
    ? analysis.status === "no-suitable-window"
      ? `These errands can be combined into one journey, saving ${saved} separate trip${saved === 1 ? "" : "s"}, but every window is above the engine's advisory level for this effort today. Postpone non-urgent errands if you can, and keep the combined journey short.`
      : "These errands can be combined into one journey, but no forecast window with complete coverage was found to place it in."
    : `${errands.length} errands can be done in one journey of about ${total} minutes, saving ${saved} separate trip${saved === 1 ? "" : "s"} outdoors. The forecast window ${chosen.startLocal} to ${chosen.endLocal} (PM2.5 about ${chosen.pm25MeanUgM3} ug/m3) is the lowest available${analysis.status === "no-meaningful-difference" ? ", though timing makes little difference today" : ""}.`;
  return {
    chaining: {
      status: "suggested",
      activityIds: errands.map((e) => e.id),
      combinedDurationMinutes: total,
      journeysSaved: saved,
      suggestedTime: chosen === null ? null : slot(chosen),
      windowStatus: analysis.status,
      reason,
      instructions: [
        "List everything you need first and order the stops so the route does not double back.",
        "Do the stops that are closest to home or on your usual route first.",
        "Carry what you need so you do not make an extra trip.",
      ],
      co2: { status: "unavailable", reason: CHAIN_CO2_REASON },
      explanation: {
        what: `Combine ${errands.map((e) => ACTIVITY_LABELS[e.activity]).join(" and ")} into one journey.`,
        why: reason,
        triggeredBy,
        assumptionIds: ["ASM_NO_CHAINING_CO2", "ASM_WINDOW_CPCB_SCALE_INDICATOR", "ASM_HOURLY_VALUE_STEP"],
        ruleIds: ["RULE_TRIP_CHAINING", "RULE_NEVER_CALL_SAFE"],
        impact: `${saved} fewer separate outdoor trip${saved === 1 ? "" : "s"}; no CO2 or exposure figure is claimed because errand distances are not known.`,
        confidence,
      },
    },
    analysis,
  };
}

const CHAIN_CO2_REASON =
  "No errand distances are known, so the engine does not estimate CO2 savings from combining journeys.";
