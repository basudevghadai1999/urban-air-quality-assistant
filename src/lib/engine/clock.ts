import { IST_UTC_OFFSET_SECONDS } from "@/lib/constants";
import { formatIsoWithOffset } from "@/lib/time";

/** Local-clock helpers for Asia/Kolkata (fixed UTC+05:30). Pure. */

const DAY_S = 86_400;

export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;

/** Minutes since local midnight for an instant. */
export function localMinutesOfDay(epochMs: number): number {
  const local = Math.floor(epochMs / 1000) + IST_UTC_OFFSET_SECONDS;
  return Math.floor((((local % DAY_S) + DAY_S) % DAY_S) / 60);
}

export function formatLocalTime(epochMs: number): string {
  const minutes = localMinutesOfDay(epochMs);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function toIsoIst(epochMs: number): string {
  return formatIsoWithOffset(epochMs, IST_UTC_OFFSET_SECONDS);
}

/** "HH:MM" to minutes since midnight. Assumes a validated string. */
export function parseClock(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}
