import type { ProviderPollutantId } from "@/types/air";

/**
 * Open-Meteo Air Quality API: request definition and provider vocabulary.
 * Documentation: https://open-meteo.com/en/docs/air-quality-api
 *
 * ## Dataset used for India
 * India is outside the CAMS Europe domain, so the data is the CAMS GLOBAL
 * atmospheric composition forecast: 0.4 degree (~45 km) grid, 3-hourly native
 * resolution, updated every 12 hours (per Open-Meteo's data-source table).
 * The hourly series is derived by Open-Meteo from that coarser model output; it
 * is not an independent hourly measurement. We pin `domains=cams_global` so a
 * city can never silently switch to the Europe domain.
 */

/** Fixed endpoint. The host is never derived from user input (no SSRF surface). */
export const OPEN_METEO_AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality";

/** Provider variable name for each pollutant Open-Meteo supplies for India. */
export const PROVIDER_VARIABLES = {
  pm25: "pm2_5",
  pm10: "pm10",
  no2: "nitrogen_dioxide",
  so2: "sulphur_dioxide",
  o3: "ozone",
  co: "carbon_monoxide",
} as const satisfies Record<ProviderPollutantId, string>;

export type ProviderVariable = (typeof PROVIDER_VARIABLES)[ProviderPollutantId];

/** Canonical order, matching the AQI engine. */
export const PROVIDER_POLLUTANT_IDS = ["pm25", "pm10", "no2", "so2", "o3", "co"] as const satisfies readonly ProviderPollutantId[];

/**
 * NOT requested: Open-Meteo documents ammonia as "only available for Europe"
 * (a live request for India returns all-null), and it offers no lead (Pb) at all.
 */
export const UNSUPPORTED_BY_PROVIDER = ["nh3", "pb"] as const;

/** All six variables are documented in ug/m3 (and verified against `hourly_units` on every response). */
export const EXPECTED_PROVIDER_UNIT = "ug/m3" as const;

/**
 * Time window requested.
 *
 * `past_hours` counts hours BEFORE the current hour; `forecast_hours` counts
 * from the current hour INCLUSIVE (verified against the live API). So:
 *   past_hours = 24      -> the 24 hours before the current hour (the CPCB 24-hour
 *                           window needs 24 slots ending at the current hour;
 *                           this adds one hour of margin for grid alignment)
 *   forecast_hours = 49  -> the current hour plus the next 48 hours
 */
export const PAST_HOURS = 24;
export const FORECAST_HOURS = 49;

export const PROVIDER_DOMAIN = "cams_global";

/** Upper bound on hourly points we will accept (defence against unbounded responses). */
export const MAX_HOURLY_POINTS = 200;

/** Upper bound on response body size, in bytes. A normal response is about 4 KB. */
export const MAX_RESPONSE_BYTES = 512 * 1024;

export const DEFAULT_TIMEOUT_MS = 8_000;
