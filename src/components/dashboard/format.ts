import { AQI_CATEGORIES, POLLUTANT_INFO, type AqiCategoryId, type PollutantId } from "@/lib/aqi";
import type { ConfidenceLevel } from "@/lib/engine/types";

/** Display helpers for the dashboard. Pure; they format what the API returned and never compute a result. */

export const IST = "Asia/Kolkata";

const stamp = new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

/** "24 Nov, 2:00 pm IST" for an ISO timestamp, or null if it does not parse. */
export function formatIst(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${stamp.format(ms)} IST` : null;
}

const dayKey = new Intl.DateTimeFormat("en-CA", { timeZone: IST, year: "numeric", month: "2-digit", day: "2-digit" });
const dayName = new Intl.DateTimeFormat("en-IN", { timeZone: IST, day: "numeric", month: "short" });

/**
 * "Today", "Tomorrow" or "26 Nov": which Asia/Kolkata calendar day `iso` falls on, relative to `referenceIso`
 * (when the server produced the result). The forecast covers future hours only, so a clock time such as
 * 16:00 that has already passed today means tomorrow; without this label it reads as the past.
 */
export function dayLabel(iso: string, referenceIso: string): string | null {
  const at = Date.parse(iso);
  const ref = Date.parse(referenceIso);
  if (!Number.isFinite(at) || !Number.isFinite(ref)) return null;
  const days = Math.round((Date.parse(`${dayKey.format(at)}T00:00:00Z`) - Date.parse(`${dayKey.format(ref)}T00:00:00Z`)) / 86_400_000);
  return days === 0 ? "Today" : days === 1 ? "Tomorrow" : dayName.format(at);
}

/** "Tomorrow, 16:00 to 16:40 IST". The clock times are the engine's own Asia/Kolkata strings. */
export function slotText(slot: { readonly start: string; readonly startLocal: string; readonly endLocal: string }, referenceIso: string): string {
  const day = dayLabel(slot.start, referenceIso);
  const nextDay = slot.endLocal < slot.startLocal ? " (ends the next day)" : "";
  return `${day === null ? "" : `${day}, `}${slot.startLocal} to ${slot.endLocal} IST${nextDay}`;
}

/** "just now", "12 minutes ago", "3 hours ago", "2 days ago". Input is a server-computed age. */
export function formatAge(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 90) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hours ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/** Static class names per category, so Tailwind can see them. Colours are tokens (see globals.css). */
export const AQI_STYLES: Readonly<Record<AqiCategoryId, { readonly badge: string; readonly bar: string }>> = {
  good: { badge: "bg-aqi-good-bg text-aqi-good-ink border-aqi-good-ink", bar: "bg-aqi-good-bar" },
  satisfactory: { badge: "bg-aqi-satisfactory-bg text-aqi-satisfactory-ink border-aqi-satisfactory-ink", bar: "bg-aqi-satisfactory-bar" },
  moderately_polluted: { badge: "bg-aqi-moderately_polluted-bg text-aqi-moderately_polluted-ink border-aqi-moderately_polluted-ink", bar: "bg-aqi-moderately_polluted-bar" },
  poor: { badge: "bg-aqi-poor-bg text-aqi-poor-ink border-aqi-poor-ink", bar: "bg-aqi-poor-bar" },
  very_poor: { badge: "bg-aqi-very_poor-bg text-aqi-very_poor-ink border-aqi-very_poor-ink", bar: "bg-aqi-very_poor-bar" },
  severe: { badge: "bg-aqi-severe-bg text-aqi-severe-ink border-aqi-severe-ink", bar: "bg-aqi-severe-bar" },
};

export const isCategoryId = (id: string | null): id is AqiCategoryId => id !== null && AQI_CATEGORIES.some((c) => c.id === id);

/** CPCB unit strings in readable form. */
export const UNIT_LABEL = { "ug/m3": "µg/m³", "mg/m3": "mg/m³" } as const;

export const pollutantLabel = (id: PollutantId): string => POLLUTANT_INFO[id].label;

/** Up to 2 decimals, no trailing zeros. */
export const formatNumber = (value: number, digits = 1): string => String(Number(value.toFixed(digits)));

export const CONFIDENCE_LABEL: Readonly<Record<ConfidenceLevel, string>> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
  unavailable: "Confidence unavailable",
};
