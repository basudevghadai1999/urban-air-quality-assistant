import {
  REQUIRED_WINDOW_POLLUTANT,
  WINDOW_INDICATOR_CEILING,
  WINDOW_POLICY,
  WINDOW_POLLUTANTS,
  CONFIDENCE_PENALTY,
} from "@/config/advisoryThresholds";
import { POLLUTANT_INFO, calculateSubIndex, convertConcentration, type PollutantId } from "@/lib/aqi";
import type { HourlyRecord, ProviderPollutantId } from "@/types/air";

import { HOUR_MS, MINUTE_MS, formatLocalTime, localMinutesOfDay, parseClock, toIsoIst } from "./clock";
import { buildConfidence } from "./confidence";
import type { ActivityIntensity, Confidence, ConfidenceFactor } from "./types";

/**
 * Outdoor activity window engine.
 *
 * Question answered: given the hourly MODEL FORECAST, which start times for an activity of a given
 * length and effort give relatively lower pollution than other times in the next 24 hours?
 * It never answers "is it safe": see `advisoryThresholds.ts`.
 *
 * Method, in order:
 *  1. Keep forecast hours that are still in the future (an hour already over is ignored; history is
 *     never reused as forecast, and forecast is never read as an observation).
 *  2. Choose the pollutants usable for the WHOLE horizon: every hour present and non-null. PM2.5 is
 *     required. Pollutants with any gap are excluded for every window (so windows are compared on
 *     the same basis) and disclosed, and they lower confidence. Missing values are never zero.
 *  3. Candidate windows: every start on the step grid inside the horizon whose local clock time lies
 *     between the earliest and latest allowed start, with every overlapped hour present.
 *  4. Window concentration per pollutant = time-weighted mean of the overlapped hourly values (each
 *     hourly value is treated as representing the clock hour that begins at its timestamp).
 *  5. Window indicator = the highest CPCB-scale sub-index over the usable pollutants. A window is not
 *     favoured when one pollutant falls while another rises.
 *  6. Best window = lowest indicator (ties: earliest). Status:
 *       no-suitable-window       best exceeds the ceiling for this effort level and sensitivity
 *       no-meaningful-difference best is under the ceiling but < 15% below both the median window
 *                                and the user's usual time
 *       recommended              best is under the ceiling and >= 15% below the median or the usual time
 */

type Values = Partial<Record<ProviderPollutantId, number | null>>;

export type WindowStatus = "recommended" | "no-meaningful-difference" | "no-suitable-window" | "unavailable";

export type UnavailableReason =
  | "no-forecast"
  | "no-future-hours"
  | "pm25-incomplete"
  | "no-complete-window";

export interface WindowPollutant {
  readonly pollutant: PollutantId;
  readonly meanUgM3: number;
  /** Window-mean concentration on the CPCB scale for this pollutant. Not an AQI. */
  readonly subIndex: number;
}

export interface WindowCandidate {
  readonly startMs: number;
  readonly endMs: number;
  readonly start: string;
  readonly end: string;
  readonly startLocal: string;
  readonly endLocal: string;
  readonly indicator: number;
  readonly limitingPollutant: PollutantId;
  readonly pollutants: readonly WindowPollutant[];
  readonly pm25MeanUgM3: number;
  /** Timestamps (ISO, +05:30) of the forecast hours this window reads. */
  readonly forecastHours: readonly string[];
}

export interface WindowComparison {
  readonly candidateCount: number;
  readonly medianIndicator: number;
  readonly bestIndicator: number;
  readonly worstIndicator: number;
  /** (best - median) / median x 100. Negative means lower than the median. */
  readonly bestVsMedianPercent: number;
  readonly preferredIndicator: number | null;
  /** (best - preferred) / preferred x 100, or null without a preferred-time window. */
  readonly bestVsPreferredPercent: number | null;
  readonly ceiling: number;
}

export type Trend = "rising" | "falling" | "steady" | "unknown";

export interface MissingPollutant {
  readonly pollutant: PollutantId;
  readonly reason: "not-provided-for-every-hour" | "not-supported-by-provider";
}

export interface OutdoorWindowAnalysis {
  readonly status: WindowStatus;
  readonly unavailableReason: UnavailableReason | null;
  /** Wording the UI may show. Never "safe". */
  readonly label: string;
  readonly durationMinutes: number;
  readonly intensity: ActivityIntensity;
  readonly best: WindowCandidate | null;
  /** Next-best window that does not overlap `best`. */
  readonly alternative: WindowCandidate | null;
  readonly preferred: WindowCandidate | null;
  readonly recommended: readonly WindowCandidate[];
  readonly higherExposure: readonly WindowCandidate[];
  readonly comparison: WindowComparison | null;
  readonly trend: Trend;
  readonly pollutantsUsed: readonly PollutantId[];
  readonly pollutantsMissing: readonly MissingPollutant[];
  readonly confidence: Confidence;
}

export interface WindowQuery {
  /** Forecast hours only (`forecastHourlyData.hours`). */
  readonly hours: readonly HourlyRecord[];
  readonly nowMs: number;
  readonly durationMinutes: number;
  readonly earliestStart: string;
  readonly latestStart: string;
  readonly preferredStart: string | null;
  readonly intensity: ActivityIntensity;
  readonly sensitive: boolean;
  /** True when the underlying air data is a stale fallback. */
  readonly stale: boolean;
}

export const RELATIVELY_LOWER_LABEL = "Relatively lower-pollution window";
const BEST_AVAILABLE_LABEL = "Best available window (not meaningfully lower than other times)";
const ABOVE_CEILING_LABEL = "Best available window (above the engine's advisory level for this activity)";
const UNAVAILABLE_LABEL = "No window available";

const NO_PROVIDER_POLLUTANTS: readonly PollutantId[] = ["nh3", "pb"];

interface HourIndex {
  readonly byEpoch: ReadonlyMap<number, Values>;
  /** Seconds past the hour at which this provider's hours start (1800 for IST half-hour zones, 0 otherwise). */
  readonly phase: number;
}

function indexHours(hours: readonly HourlyRecord[]): HourIndex | null {
  const first = hours[0];
  if (first === undefined) return null;
  const byEpoch = new Map<number, Values>();
  for (const hour of hours) byEpoch.set(hour.epochSeconds, hour.values);
  return { byEpoch, phase: ((first.epochSeconds % 3600) + 3600) % 3600 };
}

const median = (sorted: readonly number[]): number => {
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? hi : ((sorted[mid - 1] ?? hi) + hi) / 2;
};

const round = (value: number, places = 1): number => {
  const f = 10 ** places;
  return Math.round(value * f) / f;
};

function hourStartEpoch(epochSeconds: number, phase: number): number {
  return Math.floor((epochSeconds - phase) / 3600) * 3600 + phase;
}

/** Concentration, in CPCB's unit for the pollutant, from a value in ug/m3. */
function toCpcbUnit(pollutant: PollutantId, ugM3: number): number {
  return POLLUTANT_INFO[pollutant].unit === "mg/m3" ? convertConcentration(ugM3, "ug/m3", "mg/m3") : ugM3;
}

/**
 * Time-weighted mean of each pollutant over [startMs, endMs), or null if any overlapped hour is
 * missing or null for a pollutant. Also returns the hour timestamps read.
 */
function windowMeans(
  index: HourIndex,
  pollutants: readonly PollutantId[],
  startMs: number,
  endMs: number,
): { means: Map<PollutantId, number>; stamps: string[] } | null {
  const sums = new Map<PollutantId, number>(pollutants.map((p) => [p, 0]));
  const stamps: string[] = [];
  const startS = startMs / 1000;
  const endS = endMs / 1000;
  for (let h = hourStartEpoch(startS, index.phase); h < endS; h += 3600) {
    const values = index.byEpoch.get(h);
    if (values === undefined) return null;
    const overlapS = Math.min(endS, h + 3600) - Math.max(startS, h);
    if (overlapS <= 0) continue;
    for (const pollutant of pollutants) {
      const v = values[pollutant as ProviderPollutantId];
      if (v === null || v === undefined || !Number.isFinite(v) || v < 0) return null;
      sums.set(pollutant, (sums.get(pollutant) ?? 0) + v * overlapS);
    }
    stamps.push(toIsoIst(h * 1000));
  }
  const means = new Map<PollutantId, number>();
  for (const [pollutant, sum] of sums) means.set(pollutant, sum / (endS - startS));
  return { means, stamps };
}

function scoreWindow(
  means: ReadonlyMap<PollutantId, number>,
  pollutants: readonly PollutantId[],
): { indicator: number; limiting: PollutantId; detail: WindowPollutant[] } {
  const detail: WindowPollutant[] = pollutants.map((pollutant) => {
    const mean = means.get(pollutant) ?? 0;
    const sub = calculateSubIndex(pollutant, toCpcbUnit(pollutant, mean));
    return { pollutant, meanUgM3: round(mean, 2), subIndex: round(sub.exact, 1) };
  });
  // Canonical pollutant order breaks exact ties, so the choice is deterministic.
  let limiting = detail[0];
  for (const entry of detail) if (limiting === undefined || entry.subIndex > limiting.subIndex) limiting = entry;
  if (limiting === undefined) throw new Error("scoreWindow needs at least one pollutant");
  return { indicator: limiting.subIndex, limiting: limiting.pollutant, detail };
}

function makeCandidate(
  index: HourIndex,
  pollutants: readonly PollutantId[],
  startMs: number,
  durationMs: number,
): WindowCandidate | null {
  const endMs = startMs + durationMs;
  const read = windowMeans(index, pollutants, startMs, endMs);
  if (read === null) return null;
  const scored = scoreWindow(read.means, pollutants);
  return {
    startMs,
    endMs,
    start: toIsoIst(startMs),
    end: toIsoIst(endMs),
    startLocal: formatLocalTime(startMs),
    endLocal: formatLocalTime(endMs),
    indicator: scored.indicator,
    limitingPollutant: scored.limiting,
    pollutants: scored.detail,
    pm25MeanUgM3: round(read.means.get("pm25") ?? 0, 2),
    forecastHours: read.stamps,
  };
}

/** Greedy non-overlapping selection from an already-ordered list. */
function pickNonOverlapping(ordered: readonly WindowCandidate[], max: number): WindowCandidate[] {
  const picked: WindowCandidate[] = [];
  for (const candidate of ordered) {
    if (picked.length >= max) break;
    if (picked.every((p) => candidate.endMs <= p.startMs || candidate.startMs >= p.endMs)) picked.push(candidate);
  }
  return picked;
}

interface Usable {
  readonly pollutants: readonly PollutantId[];
  readonly missing: readonly MissingPollutant[];
  readonly firstBoundaryMs: number;
  readonly horizonEndMs: number;
  readonly presentHours: number;
  readonly expectedHours: number;
}

/** Pollutants with a finite, non-negative value in every horizon hour. */
function assessHorizon(hours: readonly HourlyRecord[], nowMs: number): Usable {
  const firstBoundaryMs = Math.ceil(nowMs / HOUR_MS) * HOUR_MS;
  const horizonEndMs = nowMs + WINDOW_POLICY.horizonHours * HOUR_MS;
  const inHorizon = hours.filter((h) => h.epochSeconds * 1000 + HOUR_MS > nowMs && h.epochSeconds * 1000 < horizonEndMs);
  const pollutants: PollutantId[] = [];
  const missing: MissingPollutant[] = [];
  for (const pollutant of WINDOW_POLLUTANTS) {
    const complete =
      inHorizon.length > 0 &&
      inHorizon.every((h) => {
        const v = h.values[pollutant];
        return v !== null && v !== undefined && Number.isFinite(v) && v >= 0;
      });
    if (complete) pollutants.push(pollutant);
    else missing.push({ pollutant, reason: "not-provided-for-every-hour" });
  }
  for (const pollutant of NO_PROVIDER_POLLUTANTS) missing.push({ pollutant, reason: "not-supported-by-provider" });
  return {
    pollutants,
    missing,
    firstBoundaryMs,
    horizonEndMs,
    presentHours: inHorizon.length,
    expectedHours: WINDOW_POLICY.horizonHours,
  };
}

function trendOf(index: HourIndex, usable: Usable): Trend {
  const series: number[] = [];
  for (let h = 0; h < WINDOW_POLICY.trendHours; h += 1) {
    const startMs = usable.firstBoundaryMs + h * HOUR_MS;
    const read = windowMeans(index, usable.pollutants, startMs, startMs + HOUR_MS);
    if (read === null) return "unknown";
    series.push(scoreWindow(read.means, usable.pollutants).indicator);
  }
  const edge = WINDOW_POLICY.trendEdgeHours;
  if (series.length < edge * 2) return "unknown";
  const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const first = mean(series.slice(0, edge));
  const last = mean(series.slice(-edge));
  if (first <= 0) return "unknown";
  const change = (last - first) / first;
  if (change >= WINDOW_POLICY.trendChangeFraction) return "rising";
  if (change <= -WINDOW_POLICY.trendChangeFraction) return "falling";
  return "steady";
}

function unavailable(
  query: WindowQuery,
  reason: UnavailableReason,
  usable: Pick<Usable, "pollutants" | "missing"> = { pollutants: [], missing: [] },
): OutdoorWindowAnalysis {
  return {
    status: "unavailable",
    unavailableReason: reason,
    label: UNAVAILABLE_LABEL,
    durationMinutes: query.durationMinutes,
    intensity: query.intensity,
    best: null,
    alternative: null,
    preferred: null,
    recommended: [],
    higherExposure: [],
    comparison: null,
    trend: "unknown",
    pollutantsUsed: usable.pollutants,
    pollutantsMissing: usable.missing,
    confidence: {
      level: "unavailable",
      score: 0,
      factors: [{ id: reason, penalty: 1, detail: UNAVAILABLE_REASON_TEXT[reason] }],
    },
  };
}

export const UNAVAILABLE_REASON_TEXT: Readonly<Record<UnavailableReason, string>> = {
  "no-forecast": "No hourly forecast is available, so no time can be suggested.",
  "no-future-hours": "The stored forecast no longer covers any future hours.",
  "pm25-incomplete": "PM2.5 forecast values are missing for part of the horizon; PM2.5 is required to compare windows.",
  "no-complete-window": "No window in the allowed time range has complete forecast coverage.",
};

export function evaluateOutdoorWindows(query: WindowQuery): OutdoorWindowAnalysis {
  const index = indexHours(query.hours);
  if (index === null) return unavailable(query, "no-forecast");

  const usable = assessHorizon(query.hours, query.nowMs);
  if (usable.presentHours === 0) return unavailable(query, "no-future-hours");
  if (!usable.pollutants.includes(REQUIRED_WINDOW_POLLUTANT)) return unavailable(query, "pm25-incomplete", usable);

  const earliest = parseClock(query.earliestStart);
  const latest = parseClock(query.latestStart);
  const durationMs = query.durationMinutes * MINUTE_MS;
  const stepMs = WINDOW_POLICY.stepMinutes * MINUTE_MS;

  const candidates: WindowCandidate[] = [];
  for (let t = Math.ceil(query.nowMs / stepMs) * stepMs; t < usable.horizonEndMs; t += stepMs) {
    const tod = localMinutesOfDay(t);
    if (tod < earliest || tod > latest) continue;
    const candidate = makeCandidate(index, usable.pollutants, t, durationMs);
    if (candidate !== null) candidates.push(candidate);
  }
  if (candidates.length === 0) return unavailable(query, "no-complete-window", usable);

  const byQuality = [...candidates].sort((a, b) => a.indicator - b.indicator || a.startMs - b.startMs);
  const best = byQuality[0];
  if (best === undefined) return unavailable(query, "no-complete-window", usable);

  const sortedIndicators = candidates.map((c) => c.indicator).sort((a, b) => a - b);
  const med = median(sortedIndicators);
  const worst = sortedIndicators[sortedIndicators.length - 1] ?? best.indicator;

  const preferredMinutes = query.preferredStart === null ? null : parseClock(query.preferredStart);
  const preferred =
    preferredMinutes === null ? null : (candidates.find((c) => localMinutesOfDay(c.startMs) === preferredMinutes) ?? null);

  const ceiling = (query.sensitive ? WINDOW_INDICATOR_CEILING.sensitive : WINDOW_INDICATOR_CEILING.general)[query.intensity];
  // A window is a real improvement if it beats the typical window, or the user's own usual time.
  // (When most windows are clean, the median is clean too, yet a dirty usual time is still worth moving.)
  const improvementOver = (reference: number): number => (reference > 0 ? (reference - best.indicator) / reference : 0);
  const improvement = Math.max(improvementOver(med), preferred === null ? 0 : improvementOver(preferred.indicator));
  const status: WindowStatus =
    best.indicator > ceiling
      ? "no-suitable-window"
      : improvement < WINDOW_POLICY.minRelativeImprovement
        ? "no-meaningful-difference"
        : "recommended";

  const lowerPool =
    status === "recommended"
      ? byQuality.filter((c) => {
          if (c.indicator > ceiling) return false;
          const overMedian = (med - c.indicator) / (med || 1);
          const overUsual = preferred === null || preferred.indicator <= 0 ? 0 : (preferred.indicator - c.indicator) / preferred.indicator;
          return Math.max(overMedian, overUsual) >= WINDOW_POLICY.minRelativeImprovement;
        })
      : [];
  const recommended = pickNonOverlapping(lowerPool, WINDOW_POLICY.maxListed);

  const higherPool = [...candidates]
    .filter((c) => med > 0 && (c.indicator - med) / med >= WINDOW_POLICY.higherExposureMargin)
    .sort((a, b) => b.indicator - a.indicator || a.startMs - b.startMs);
  const higherExposure = pickNonOverlapping(higherPool, WINDOW_POLICY.maxListed);

  const alternative = pickNonOverlapping(byQuality, 2)[1] ?? null;

  const factors: ConfidenceFactor[] = [
    { id: "model-data", penalty: CONFIDENCE_PENALTY.modelOnly, detail: "Values are atmospheric-model estimates, not station measurements." },
  ];
  if (query.stale) {
    factors.push({ id: "stale-data", penalty: CONFIDENCE_PENALTY.staleData, detail: "The forecast comes from an earlier fetch; the provider could not be reached." });
  }
  if (!usable.pollutants.includes("pm10")) {
    factors.push({ id: "pm10-missing", penalty: CONFIDENCE_PENALTY.pm10Missing, detail: "PM10 is not available for every forecast hour." });
  }
  for (const pollutant of ["no2", "so2", "o3", "co"] as const) {
    if (!usable.pollutants.includes(pollutant)) {
      factors.push({
        id: `${pollutant}-missing`,
        penalty: CONFIDENCE_PENALTY.otherGasMissingEach,
        detail: `${POLLUTANT_INFO[pollutant].label} is not available for every forecast hour, so it is not part of the comparison.`,
      });
    }
  }
  const leadHours = (best.startMs - query.nowMs) / HOUR_MS;
  if (leadHours > 12) {
    factors.push({
      id: "long-lead-time",
      penalty: leadHours > 24 ? CONFIDENCE_PENALTY.forecastLeadOver24h : CONFIDENCE_PENALTY.forecastLeadOver12h,
      detail: `The suggested window starts ${round(leadHours, 0)} hours from now; forecasts are less certain further ahead.`,
    });
  }
  if (usable.presentHours < usable.expectedHours - 1) {
    factors.push({
      id: "forecast-gaps",
      penalty: CONFIDENCE_PENALTY.forecastGapsInHorizon,
      detail: `Only ${usable.presentHours} of ${usable.expectedHours} forecast hours are present in the next day.`,
    });
  }

  const label =
    status === "recommended" ? RELATIVELY_LOWER_LABEL : status === "no-suitable-window" ? ABOVE_CEILING_LABEL : BEST_AVAILABLE_LABEL;

  return {
    status,
    unavailableReason: null,
    label,
    durationMinutes: query.durationMinutes,
    intensity: query.intensity,
    best,
    alternative,
    preferred,
    recommended,
    higherExposure,
    comparison: {
      candidateCount: candidates.length,
      medianIndicator: round(med),
      bestIndicator: best.indicator,
      worstIndicator: worst,
      bestVsMedianPercent: med > 0 ? round(((best.indicator - med) / med) * 100) : 0,
      preferredIndicator: preferred?.indicator ?? null,
      bestVsPreferredPercent:
        preferred !== null && preferred.indicator > 0
          ? round(((best.indicator - preferred.indicator) / preferred.indicator) * 100)
          : null,
      ceiling,
    },
    trend: trendOf(index, usable),
    pollutantsUsed: usable.pollutants,
    pollutantsMissing: usable.missing,
    confidence: buildConfidence(factors),
  };
}

/* ------------------------------------------------------------------ */
/* Morning / afternoon / evening comparison                            */
/* ------------------------------------------------------------------ */

export type PeriodId = "morning" | "afternoon" | "evening";

export interface PeriodSummary {
  readonly period: PeriodId;
  readonly label: string;
  readonly hoursCovered: number;
  readonly hoursInPeriod: number;
  /** Highest pollutant sub-index of the period-mean concentrations, or null when too little is covered. */
  readonly indicator: number | null;
  readonly limitingPollutant: PollutantId | null;
  readonly pm25MeanUgM3: number | null;
  readonly forecastHours: readonly string[];
}

export interface PeriodComparison {
  readonly status: "available" | "unavailable";
  readonly periods: readonly PeriodSummary[];
  /** Lowest-indicator period among those with enough coverage; ties go to the earlier period. */
  readonly lowestPeriod: PeriodId | null;
  readonly highestPeriod: PeriodId | null;
  readonly pollutantsUsed: readonly PollutantId[];
  readonly pollutantsMissing: readonly MissingPollutant[];
}

const PERIOD_LABELS: Readonly<Record<PeriodId, string>> = {
  morning: "Morning",
  afternoon: "Afternoon",
  evening: "Evening",
};

/** Compare the next occurrence of each part of the day. A period needs at least half its hours covered. */
export function comparePeriods(hours: readonly HourlyRecord[], nowMs: number): PeriodComparison {
  const index = indexHours(hours);
  const usable = index === null ? null : assessHorizon(hours, nowMs);
  if (index === null || usable === null || usable.presentHours === 0 || !usable.pollutants.includes("pm25")) {
    return {
      status: "unavailable",
      periods: [],
      lowestPeriod: null,
      highestPeriod: null,
      pollutantsUsed: usable?.pollutants ?? [],
      pollutantsMissing: usable?.missing ?? [],
    };
  }

  const periods: PeriodSummary[] = (Object.keys(WINDOW_POLICY.periods) as PeriodId[]).map((period) => {
    const [startHour, endHour] = WINDOW_POLICY.periods[period];
    const hoursInPeriod = endHour - startHour;
    const present = hours.filter((h) => {
      const ms = h.epochSeconds * 1000;
      if (ms < usable.firstBoundaryMs - HOUR_MS || ms >= usable.horizonEndMs) return false;
      if (ms + HOUR_MS <= nowMs) return false;
      const hourOfDay = Math.floor(localMinutesOfDay(ms) / 60);
      return hourOfDay >= startHour && hourOfDay < endHour;
    });
    const complete = present.filter((h) => usable.pollutants.every((p) => (h.values[p as ProviderPollutantId] ?? null) !== null));
    if (complete.length < hoursInPeriod / 2) {
      return {
        period,
        label: `${PERIOD_LABELS[period]} ${String(startHour).padStart(2, "0")}:00 to ${String(endHour).padStart(2, "0")}:00`,
        hoursCovered: complete.length,
        hoursInPeriod,
        indicator: null,
        limitingPollutant: null,
        pm25MeanUgM3: null,
        forecastHours: [],
      };
    }
    const means = new Map<PollutantId, number>(
      usable.pollutants.map((p) => [
        p,
        complete.reduce((sum, h) => sum + (h.values[p as ProviderPollutantId] ?? 0), 0) / complete.length,
      ]),
    );
    const scored = scoreWindow(means, usable.pollutants);
    return {
      period,
      label: `${PERIOD_LABELS[period]} ${String(startHour).padStart(2, "0")}:00 to ${String(endHour).padStart(2, "0")}:00`,
      hoursCovered: complete.length,
      hoursInPeriod,
      indicator: scored.indicator,
      limitingPollutant: scored.limiting,
      pm25MeanUgM3: round(means.get("pm25") ?? 0, 2),
      forecastHours: complete.map((h) => toIsoIst(h.epochSeconds * 1000)),
    };
  });

  const scored = periods.filter((p): p is PeriodSummary & { indicator: number } => p.indicator !== null);
  const lowest = [...scored].sort((a, b) => a.indicator - b.indicator)[0];
  const highest = [...scored].sort((a, b) => b.indicator - a.indicator)[0];
  return {
    status: scored.length > 0 ? "available" : "unavailable",
    periods,
    lowestPeriod: lowest?.period ?? null,
    highestPeriod: highest?.period ?? null,
    pollutantsUsed: usable.pollutants,
    pollutantsMissing: usable.missing,
  };
}
