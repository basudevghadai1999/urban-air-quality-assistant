/** Timezone-explicit time helpers. Pure and deterministic. */

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** "+05:30" for 19800, "-03:00" for -10800, "+00:00" for 0. */
export function formatUtcOffset(offsetSeconds: number): string {
  const sign = offsetSeconds < 0 ? "-" : "+";
  const total = Math.abs(offsetSeconds);
  return `${sign}${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}`;
}

/**
 * Render an absolute instant as an ISO-8601 string in a fixed UTC offset, for
 * example 2026-11-24T13:00:00+05:30. The instant itself is unchanged; only its
 * local-clock representation differs.
 */
export function formatIsoWithOffset(epochMs: number, offsetSeconds: number): string {
  if (!Number.isFinite(epochMs)) throw new RangeError("epochMs must be finite");
  const local = new Date(epochMs + offsetSeconds * 1000);
  const date = `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
  const time = `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}`;
  return `${date}T${time}${formatUtcOffset(offsetSeconds)}`;
}

/** Whole seconds elapsed from `fromMs` to `toMs`, never negative. */
export function ageSeconds(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / 1000));
}

const DAY_MS = 86_400_000;

/** `YYYYMMDD` for the UTC day containing `ms`. */
export function utcDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** Milliseconds from `ms` to the next 00:00 UTC; a full day when `ms` is exactly midnight. */
export function msUntilNextUtcMidnight(ms: number): number {
  return DAY_MS - (((ms % DAY_MS) + DAY_MS) % DAY_MS);
}

/** Whole seconds until the next 00:00 UTC, at least 1. */
export function secondsUntilUtcReset(ms: number): number {
  return Math.max(1, Math.ceil(msUntilNextUtcMidnight(ms) / 1000));
}
