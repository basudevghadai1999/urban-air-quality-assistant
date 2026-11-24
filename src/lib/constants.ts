/**
 * Application-wide constants. Safe to import from both server and client code:
 * nothing in this file is secret or environment-dependent.
 */

export const APP_NAME = "Urban Air Intelligence";
export const APP_TAGLINE = "Breathe Smarter. Live Safer.";
export const APP_DESCRIPTION =
  "Live air quality for six Indian cities, turned into clear, personalised guidance for families and communities living with winter smog: daily routines, indoor air and cleaner commutes.";

/** Current build phase, surfaced in the UI so nobody mistakes placeholders for data. */
export const DEVELOPMENT_PHASE = "Phase 2A" as const;

/**
 * Default Gemini model; override with the optional `GEMINI_MODEL` variable.
 * Verified 2026-11-24 with a real generateContent call (structured JSON output) using this project's key.
 * The previous default, `gemini-2.5-flash`, still appears in the model list but is rejected for generation
 * ("no longer available to new users"), which is why it was replaced. Availability can change again:
 * a model error degrades to the deterministic fallback and is never "fixed" by silently switching models.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

/**
 * Names of the server-side environment variables that may hold the Gemini key,
 * in priority order. Names only: values must never be stored in source code.
 */
export const GEMINI_ENV_KEYS = {
  primary: "GEMINI_API_KEY",
  fallback: "GEMINI_KEY",
} as const;

export const GEMINI_MODEL_ENV_KEY = "GEMINI_MODEL";

/**
 * Default Groq model (secondary provider); override with `GROQ_MODEL`.
 * `openai/gpt-oss-20b` is listed by Groq as a PRODUCTION model with strict `json_schema` structured
 * outputs, at the lowest per-token price of those. Confirmed with a real call on 2026-11-24 (see
 * docs/AI_PROVIDER_ARCHITECTURE.md). Groq's older Llama production models are past their announced
 * shutdown date and only support best-effort JSON mode, so they are not used.
 */
export const DEFAULT_GROQ_MODEL = "openai/gpt-oss-20b";
export const GROQ_API_KEY_ENV_KEY = "GROQ_API_KEY";
export const GROQ_MODEL_ENV_KEY = "GROQ_MODEL";

/** All six target cities share one IANA zone. India observes no daylight saving time. */
export const INDIA_TIMEZONE = "Asia/Kolkata" as const;
/** Asia/Kolkata is a fixed UTC+05:30 (19,800 s); verified against Intl in the test suite. */
export const IST_UTC_OFFSET_SECONDS = 19_800;

/** UI-ready disclaimer. Required wording; the data is modelled, not measured at a CPCB station. */
export const AIR_DATA_DISCLAIMER =
  "Estimated Indian AQI calculated using CPCB methodology and Open-Meteo atmospheric model data. This is not an official CPCB monitoring-station reading.";

/** Links Open-Meteo's licence page requires next to any location where its data is displayed. */
export const OPEN_METEO_LINKS = [
  { label: "Weather data by Open-Meteo.com", url: "https://open-meteo.com/" },
  { label: "CC BY 4.0 licence", url: "https://creativecommons.org/licenses/by/4.0/" },
  { label: "Copernicus Atmosphere Monitoring Service", url: "https://atmosphere.copernicus.eu/" },
] as const;

/**
 * Credit text required when displaying this data. Sources (verified 2026-11-24):
 *  - Open-Meteo licence page: CC BY 4.0, credit plus a link to open-meteo.com next to the data.
 *  - Licence to use Copernicus Products (rev. 12), clause 5.1: the "Generated using" notice, or,
 *    because the data is adapted here (hourly derivation, AQI calculation), the "Contains
 *    modified" notice, and a statement that neither the European Commission nor ECMWF is
 *    responsible for any use made of the information.
 * `year` is the year the data was obtained.
 */
export function buildOpenMeteoAttribution(year: number): string {
  return `Weather data by Open-Meteo.com (https://open-meteo.com/), licensed CC BY 4.0. Contains modified Copernicus Atmosphere Monitoring Service information ${year}. Neither the European Commission nor ECMWF is responsible for any use that may be made of the Copernicus information or data it contains.`;
}
