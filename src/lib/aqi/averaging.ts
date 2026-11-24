import { validateConcentrationValue } from "./validation";
import type {
  AveragingPeriodHours,
  DuplicatePolicy,
  Observation,
  TimestampInput,
  WindowAverageResult,
  WindowRequirementSource,
  WindowStats,
} from "./types";

/**
 * Rolling-average engine. Provider-independent: it sees only timestamped
 * hourly numbers and knows nothing about where they came from. Averaging
 * hourly MODEL estimates does not turn them into CPCB station measurements.
 *
 * ## What CPCB specifies (How_AQI_Calculated.pdf; technical report s.3.7)
 * - Sub-indices use a 24-hourly average (8-hourly for CO and O3).
 * - The real-time AQI uses a RUNNING average: "AQI at 6am on a day will
 *   incorporate data from 6am on previous day to the current day".
 * - "A minimum of 16 hours' data is considered necessary for calculating
 *   sub-index" (stated for the 24-hour pollutants).
 *
 * ## What CPCB does NOT specify, so is an explicit engine default (overridable)
 * - A minimum for 8-hour windows (16 of 24 is impossible for 8 hours). The
 *   default scales CPCB's 16/24 ratio to the window: ceil(8 x 16/24) = 6.
 * - How to treat several observations in one hour, or which hours must be present.
 *
 * ## Window definition
 * The window ends at `endTime` (inclusive) and spans `windowHours` hourly slots.
 * Slot k (0 = newest) is the interval (end - (k+1)h, end - k h]. A 24-hour
 * window therefore includes a value stamped exactly `endTime` and one stamped
 * 23 hours earlier, but not one stamped 24 hours earlier.
 */

const HOUR_MS = 3_600_000;

/** CPCB-stated minimum valid hours for a 24-hour average. */
export const CPCB_MIN_VALID_HOURS_24H = 16;

export interface WindowRequirement {
  readonly minValidHours: number;
  readonly source: WindowRequirementSource;
}

/** Default completeness requirement for a window of `windowHours`. */
export function defaultWindowRequirement(windowHours: AveragingPeriodHours): WindowRequirement {
  if (windowHours === 24) return { minValidHours: CPCB_MIN_VALID_HOURS_24H, source: "CPCB" };
  return {
    minValidHours: Math.ceil((windowHours * CPCB_MIN_VALID_HOURS_24H) / 24),
    source: "engine-default",
  };
}

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse a timestamp to epoch milliseconds, or null if unusable.
 *
 * Strings need an explicit UTC offset (see TimestampInput). Calendar fields are
 * validated explicitly because `Date.parse` silently rolls impossible dates over
 * (it reads "2025-02-30" as 2 March and accepts 29 February in a non-leap year).
 */
export function parseTimestamp(input: unknown): number | null {
  if (input instanceof Date) {
    const ms = input.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : null;
  }
  if (typeof input === "string") {
    const text = input.trim();
    const match = TIMESTAMP_PATTERN.exec(text);
    if (!match) return null;

    const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map((i) => Number(match[i]));
    const second = Number(match[6] ?? "0");
    const zone = match[7] ?? "";
    if (
      year === undefined || month === undefined || day === undefined ||
      hour === undefined || minute === undefined
    ) {
      return null;
    }
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > daysInMonth) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    if (zone.toUpperCase() !== "Z") {
      const offsetHours = Number(zone.slice(1, 3));
      const offsetMinutes = Number(zone.replace(":", "").slice(3, 5));
      if (offsetHours > 23 || offsetMinutes > 59) return null;
    }

    const ms = Date.parse(text.toUpperCase().replace(" ", "T"));
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

export interface WindowAverageOptions {
  /** Window length in whole hours (8 and 24 are the CPCB periods). */
  readonly windowHours: number;
  /** End of the window, inclusive. */
  readonly endTime: TimestampInput;
  /** Minimum hourly slots that must hold a valid value. */
  readonly minValidHours: number;
  /** Default "exclude". */
  readonly duplicatePolicy?: DuplicatePolicy;
}

interface Candidate {
  readonly time: number;
  readonly value: number;
  readonly order: number;
}

/**
 * Average the hourly values in the window ending at `endTime`.
 *
 * Throws RangeError for a bad CONFIGURATION (non-integer window, unparseable
 * end time, unreachable minimum). Bad DATA never throws: it is excluded and counted.
 *
 * Per observation:
 * - invalid or offset-less timestamp -> excluded, counted in `invalidTimestamps`
 * - after the window end / before the window -> ignored, counted
 * - null or undefined value -> an unfilled hour (never zero)
 * - negative, NaN, infinite or non-numeric value -> excluded, counted in `invalidValues`
 * Per hourly slot with several observations:
 * - all equal -> collapsed to one value
 * - differing -> "exclude" (default) drops the slot; "last" keeps the newest timestamp
 */
export function windowAverage(
  observations: readonly Observation[],
  options: WindowAverageOptions,
): WindowAverageResult {
  const { windowHours, minValidHours } = options;
  if (!Number.isInteger(windowHours) || windowHours < 1) {
    throw new RangeError("windowHours must be a positive integer");
  }
  if (!Number.isInteger(minValidHours) || minValidHours < 1 || minValidHours > windowHours) {
    throw new RangeError("minValidHours must be an integer from 1 to windowHours");
  }
  const end = parseTimestamp(options.endTime);
  if (end === null) throw new RangeError("endTime is not a valid timestamp");
  const policy: DuplicatePolicy = options.duplicatePolicy ?? "exclude";

  const slots = new Map<number, Candidate[]>();
  let invalidTimestamps = 0;
  let invalidValues = 0;
  let futureObservations = 0;
  let outsideWindow = 0;

  observations.forEach((observation, order) => {
    const time = parseTimestamp(observation.timestamp);
    if (time === null) {
      invalidTimestamps += 1;
      return;
    }
    if (time > end) {
      futureObservations += 1;
      return;
    }
    const slot = Math.floor((end - time) / HOUR_MS);
    if (slot >= windowHours) {
      outsideWindow += 1;
      return;
    }
    const raw = observation.value;
    if (raw === null || raw === undefined) return;
    if (validateConcentrationValue(raw) !== null) {
      invalidValues += 1;
      return;
    }
    const list = slots.get(slot) ?? [];
    list.push({ time, value: raw, order });
    slots.set(slot, list);
  });

  let sum = 0;
  let validHours = 0;
  let duplicateSlotsCollapsed = 0;
  let conflictingSlotsExcluded = 0;
  let conflictingSlotsResolved = 0;

  for (let slot = 0; slot < windowHours; slot += 1) {
    const candidates = slots.get(slot);
    if (!candidates || candidates.length === 0) continue;

    let chosen: number;
    const first = candidates[0];
    if (!first) continue;
    if (candidates.every((c) => c.value === first.value)) {
      if (candidates.length > 1) duplicateSlotsCollapsed += 1;
      chosen = first.value;
    } else if (policy === "last") {
      const newest = candidates.reduce((best, c) =>
        c.time > best.time || (c.time === best.time && c.order > best.order) ? c : best,
      );
      conflictingSlotsResolved += 1;
      chosen = newest.value;
    } else {
      conflictingSlotsExcluded += 1;
      continue;
    }
    sum += chosen;
    validHours += 1;
  }

  const stats: WindowStats = {
    windowHours,
    windowEnd: new Date(end).toISOString(),
    windowStart: new Date(end - windowHours * HOUR_MS).toISOString(),
    requiredValidHours: minValidHours,
    validHours,
    missingHours: windowHours - validHours,
    duplicateSlotsCollapsed,
    conflictingSlotsExcluded,
    conflictingSlotsResolved,
    invalidValues,
    invalidTimestamps,
    futureObservations,
    outsideWindow,
  };

  if (validHours >= minValidHours) {
    return { status: "complete", average: sum / validHours, stats };
  }
  return { status: "incomplete", average: null, stats };
}

export interface RollingSeriesOptions {
  readonly windowHours: number;
  readonly minValidHours: number;
  /** One result is produced per end time, in the same order. */
  readonly endTimes: readonly TimestampInput[];
  readonly duplicatePolicy?: DuplicatePolicy;
}

/** Rolling averages evaluated at each requested end time (e.g. every hour of a forecast). */
export function rollingAverageSeries(
  observations: readonly Observation[],
  options: RollingSeriesOptions,
): WindowAverageResult[] {
  return options.endTimes.map((endTime) =>
    windowAverage(observations, {
      windowHours: options.windowHours,
      minValidHours: options.minValidHours,
      endTime,
      ...(options.duplicatePolicy === undefined ? {} : { duplicatePolicy: options.duplicatePolicy }),
    }),
  );
}
