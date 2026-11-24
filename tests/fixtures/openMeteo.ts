import type { ProviderVariable } from "@/lib/data/openMeteo/types";

/**
 * Builds Open-Meteo-shaped responses for tests, mirroring the real API
 * (verified against a live response recorded in open-meteo-delhi-recorded.json):
 *   - `timeformat=unixtime`, `timezone=Asia/Kolkata` (UTC+05:30)
 *   - hourly instants on LOCAL-hour boundaries (:30 UTC)
 *   - `current.time` on a UTC-hour boundary, so it is not itself in the hourly array
 *   - `past_hours` counts hours before the current hour; `forecast_hours` counts
 *     from the current hour inclusive.
 *
 * All values are SYNTHETIC test data.
 */

export const HOUR = 3_600;
export const IST_OFFSET = 19_800;

/** The instant our code "fetched" the data: 2026-11-24T08:17:11Z = 13:47:11 IST. */
export const FETCHED_AT_MS = Date.UTC(2026, 10, 24, 8, 17, 11);
const FETCHED_AT_S = Math.floor(FETCHED_AT_MS / 1000);

/** Local-hour floor of the fetch time: 13:00 IST = 07:30Z. This is the newest "past" instant. */
export const CURRENT_HOUR_S = Math.floor((FETCHED_AT_S + IST_OFFSET) / HOUR) * HOUR - IST_OFFSET;
/** Provider `current.time`: the UTC hour, 08:00Z = 13:30 IST. */
export const CURRENT_BLOCK_S = Math.floor(FETCHED_AT_S / HOUR) * HOUR;

export const VARIABLES: readonly ProviderVariable[] = [
  "pm2_5",
  "pm10",
  "carbon_monoxide",
  "nitrogen_dioxide",
  "sulphur_dioxide",
  "ozone",
];

export type ValueFn = (hourOffset: number, epochSeconds: number) => number | null;

/** Default per-variable values (constant), giving a predictable AQI. */
export const DEFAULT_VALUES: Record<ProviderVariable, number> = {
  pm2_5: 40, // -> sub-index 66
  pm10: 120, // -> 114
  carbon_monoxide: 1500, // ug/m3 -> 1.5 mg/m3 -> 73
  nitrogen_dioxide: 30, // -> 38
  sulphur_dioxide: 20, // -> 25
  ozone: 50, // -> 50
};

export interface FixtureOptions {
  readonly pastHours?: number;
  readonly forecastHours?: number;
  /** Per-variable value generators. `hourOffset` is relative to the current hour (negative = past). */
  readonly values?: Partial<Record<ProviderVariable, ValueFn>>;
  /** Variables to leave out of `hourly` and `hourly_units` entirely. */
  readonly omit?: readonly ProviderVariable[];
  readonly units?: Partial<Record<ProviderVariable, string>>;
  readonly includeCurrent?: boolean;
  readonly timezone?: string;
  readonly utcOffsetSeconds?: number;
}

export function makeOpenMeteoResponse(options: FixtureOptions = {}): Record<string, unknown> {
  const past = options.pastHours ?? 24;
  const forecast = options.forecastHours ?? 49;
  const omit = new Set(options.omit ?? []);
  const activeVariables = VARIABLES.filter((v) => !omit.has(v));

  const times: number[] = [];
  for (let k = -past; k < forecast; k += 1) times.push(CURRENT_HOUR_S + k * HOUR);

  const series = (variable: ProviderVariable): (number | null)[] => {
    const fn = options.values?.[variable] ?? (() => DEFAULT_VALUES[variable]);
    return times.map((t, i) => fn(i - past, t));
  };

  const unit = (variable: ProviderVariable): string => options.units?.[variable] ?? "μg/m³";

  const hourly: Record<string, unknown> = { time: times };
  const hourlyUnits: Record<string, unknown> = { time: "unixtime" };
  const currentUnits: Record<string, unknown> = { time: "unixtime", interval: "seconds" };
  const current: Record<string, unknown> = { time: CURRENT_BLOCK_S, interval: 3600 };

  for (const variable of activeVariables) {
    hourly[variable] = series(variable);
    hourlyUnits[variable] = unit(variable);
    currentUnits[variable] = unit(variable);
    current[variable] = DEFAULT_VALUES[variable];
  }

  return {
    latitude: 28.599998,
    longitude: 77.20001,
    generationtime_ms: 0.3,
    utc_offset_seconds: options.utcOffsetSeconds ?? IST_OFFSET,
    timezone: options.timezone ?? "Asia/Kolkata",
    timezone_abbreviation: "GMT+5:30",
    elevation: 214,
    ...(options.includeCurrent === false ? {} : { current_units: currentUnits, current }),
    hourly_units: hourlyUnits,
    hourly,
  };
}

/** A `fetch` stand-in returning `body` as JSON. */
export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}
