import type { City } from "@/config/cities";
import {
  OPEN_METEO_MODEL_SOURCE,
  POLLUTANT_IDS,
  calculateAqiFromTimeSeries,
} from "@/lib/aqi";
import {
  AIR_DATA_DISCLAIMER,
  IST_UTC_OFFSET_SECONDS,
  OPEN_METEO_LINKS,
  buildOpenMeteoAttribution,
} from "@/lib/constants";
import { ageSeconds, formatIsoWithOffset } from "@/lib/time";
import type {
  AirWarning,
  DataSourceInfo,
  HourlyDataset,
  HourlyRecord,
  NormalizedAirData,
  PollutantAvailability,
} from "@/types/air";

import type { MappedOpenMeteoData } from "./openMeteo/mapper";
import { PROVIDER_POLLUTANT_IDS, UNSUPPORTED_BY_PROVIDER } from "./openMeteo/types";

/**
 * Pure builders for the normalized air data contract. No I/O, no clock access:
 * every timestamp is passed in, so output is deterministic and testable.
 */

/** If the newest historical instant is older than this at fetch time, the data is treated as stale. */
export const PROVIDER_LAG_LIMIT_SECONDS = 3 * 3_600;

/** Source metadata, including the attribution the provider terms require. `year` is when the data was obtained. */
export function openMeteoSourceInfo(year: number): DataSourceInfo {
  return {
    id: "open-meteo-air-quality",
    name: "Open-Meteo Air Quality API (CAMS global model)",
    description:
      "Atmospheric model output, not station measurements. For India this is the CAMS global composition forecast (about 45 km grid, 3-hourly native resolution, updated every 12 hours); the hourly series is derived by Open-Meteo.",
    kind: "atmospheric-model",
    url: "https://open-meteo.com/en/docs/air-quality-api",
    licence: "CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/)",
    attribution: buildOpenMeteoAttribution(year),
    attributionLinks: OPEN_METEO_LINKS,
  };
}

const SOURCE_NAME = "Open-Meteo Air Quality API";
const SOURCE_DESCRIPTION =
  "Atmospheric model data from Open-Meteo (CAMS global forecast). Model estimates, not CPCB station measurements.";

const iso = (ms: number): string => new Date(ms).toISOString();

function dataset(
  kind: HourlyDataset["kind"],
  label: string,
  hours: readonly HourlyRecord[],
): HourlyDataset {
  return {
    kind,
    label,
    rangeStart: hours[0]?.time ?? null,
    rangeEnd: hours[hours.length - 1]?.time ?? null,
    hours,
  };
}

const HISTORICAL_LABEL =
  "Historical hourly model values: instants at or before the reference time. Model-derived, not station observations.";
const FORECAST_LABEL =
  "Forecast hourly model values: instants after the reference time. Predictions, not observations.";

/** Human-readable duration, e.g. "42 minutes" or "3 hours 5 minutes". */
export function describeAge(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hoursText = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rest === 0 ? hoursText : `${hoursText} ${rest} minute${rest === 1 ? "" : "s"}`;
}

/**
 * Assemble a fresh snapshot from mapped provider data.
 *
 * The CPCB AQI is computed from the HISTORICAL series only, ending at the latest
 * hourly instant at or before the reference time. Forecast values and the single
 * "current" snapshot never enter it. The engine's own completeness rules decide
 * whether an estimate is produced; when they are not met the result says so.
 */
export function buildAirSnapshot(
  mapped: MappedOpenMeteoData,
  city: City,
  fetchedAtMs: number,
  ttlSeconds: number,
): NormalizedAirData {
  const calculatedAqi = calculateAqiFromTimeSeries({
    series: mapped.aqiSeries,
    asOf: mapped.windowEndMs ?? fetchedAtMs,
    dataSource: OPEN_METEO_MODEL_SOURCE,
    calculatedAt: fetchedAtMs,
  });

  const warnings: AirWarning[] = [...mapped.warnings];
  let freshness: NormalizedAirData["freshnessStatus"] = "fresh";
  if (mapped.windowEndMs !== null) {
    const lag = ageSeconds(mapped.windowEndMs, fetchedAtMs);
    if (lag > PROVIDER_LAG_LIMIT_SECONDS) {
      freshness = "stale";
      warnings.push({
        code: "PROVIDER_DATA_LAGGING",
        message: `The newest model data is ${describeAge(lag)} older than the time it was fetched, so it may not reflect current conditions.`,
      });
    }
  }

  return {
    cityId: city.id,
    cityName: city.displayName,
    state: city.state,
    dataLocation: city.dataLocation,
    coordinates: {
      requested: { latitude: city.latitude, longitude: city.longitude },
      grid: mapped.grid,
    },
    timezone: city.timezone,
    source: "open-meteo",
    sourceName: SOURCE_NAME,
    sourceDescription: SOURCE_DESCRIPTION,
    sourceInfo: openMeteoSourceInfo(new Date(fetchedAtMs).getUTCFullYear()),
    disclaimer: AIR_DATA_DISCLAIMER,
    fetchedAt: iso(fetchedAtMs),
    providerGeneratedAt: null,
    dataTimestamp: mapped.windowEndMs === null ? null : formatIsoWithOffset(mapped.windowEndMs, IST_UTC_OFFSET_SECONDS),
    currentConditions: mapped.current,
    historicalHourlyData: dataset("historical-model", HISTORICAL_LABEL, mapped.historical),
    forecastHourlyData: dataset("forecast-model", FORECAST_LABEL, mapped.forecast),
    sourceUnits: mapped.sourceUnits,
    unitConversions: mapped.unitConversions,
    calculatedAqi,
    dataCompleteness: calculatedAqi.completeness,
    missingPollutants: calculatedAqi.missingPollutants,
    pollutantAvailability: mapped.pollutantAvailability,
    warnings,
    freshnessStatus: freshness,
    ageSeconds: 0,
    cache: { status: "miss", ttlSeconds, expiresAt: iso(fetchedAtMs + ttlSeconds * 1000) },
  };
}

export interface PresentOptions {
  readonly nowMs: number;
  readonly ttlSeconds: number;
  /**
   * "stale-fallback": the provider failed.
   * "stale-paused": the provider was deliberately not called (request limiting unavailable).
   */
  readonly mode: "hit" | "miss" | "stale-fallback" | "stale-paused";
}

/**
 * Derive the response for a stored snapshot.
 *
 * `fetchedAt`, `dataTimestamp`, the datasets and the AQI are carried over
 * UNCHANGED: serving old data never makes it look newer. Only the age,
 * freshness status, cache metadata and (for fallbacks) the stale warning are
 * recomputed.
 */
export function presentSnapshot(snapshot: NormalizedAirData, options: PresentOptions): NormalizedAirData {
  const { nowMs, ttlSeconds, mode } = options;
  if (snapshot.fetchedAt === null) throw new Error("cannot present a snapshot that was never fetched");
  const fetchedAtMs = Date.parse(snapshot.fetchedAt);
  const age = ageSeconds(fetchedAtMs, nowMs);

  const warnings: AirWarning[] = [...snapshot.warnings];
  let freshness = snapshot.freshnessStatus;
  if (mode === "stale-fallback" || mode === "stale-paused") {
    freshness = "stale";
    warnings.push(
      mode === "stale-fallback"
        ? { code: "UPSTREAM_UNAVAILABLE", message: "The air quality provider could not be reached just now." }
        : {
            code: "REFRESH_PAUSED",
            message: "Refreshing is paused because request limiting is temporarily unavailable.",
          },
    );
    warnings.push({
      code: "STALE_DATA",
      message: `Showing the last successful reading, fetched ${describeAge(age)} ago (${snapshot.fetchedAt}). Conditions may have changed since.`,
    });
  }

  return {
    ...snapshot,
    warnings,
    freshnessStatus: freshness,
    ageSeconds: age,
    cache: {
      status: mode === "stale-paused" ? "stale-fallback" : mode,
      ttlSeconds,
      expiresAt: iso(fetchedAtMs + ttlSeconds * 1000),
    },
  };
}

/** Explicit "no data" state. Contains no readings, no timestamps and no AQI: nothing is invented. */
export function buildUnavailableAirData(
  city: City,
  ttlSeconds: number,
  detail?: string,
  nowMs: number = Date.now(),
): NormalizedAirData {
  const availability: PollutantAvailability[] = [
    ...PROVIDER_POLLUTANT_IDS.map((pollutant): PollutantAvailability => ({
      pollutant,
      status: "unavailable",
      reason: "upstream-unavailable",
    })),
    ...UNSUPPORTED_BY_PROVIDER.map((pollutant): PollutantAvailability => ({
      pollutant,
      status: "unavailable",
      reason: "not-provided-by-provider",
    })),
  ];

  return {
    cityId: city.id,
    cityName: city.displayName,
    state: city.state,
    dataLocation: city.dataLocation,
    coordinates: { requested: { latitude: city.latitude, longitude: city.longitude }, grid: null },
    timezone: city.timezone,
    source: "open-meteo",
    sourceName: SOURCE_NAME,
    sourceDescription: SOURCE_DESCRIPTION,
    sourceInfo: openMeteoSourceInfo(new Date(nowMs).getUTCFullYear()),
    disclaimer: AIR_DATA_DISCLAIMER,
    fetchedAt: null,
    providerGeneratedAt: null,
    dataTimestamp: null,
    currentConditions: null,
    historicalHourlyData: dataset("historical-model", HISTORICAL_LABEL, []),
    forecastHourlyData: dataset("forecast-model", FORECAST_LABEL, []),
    sourceUnits: {},
    unitConversions: [],
    calculatedAqi: null,
    dataCompleteness: null,
    missingPollutants: [...POLLUTANT_IDS],
    pollutantAvailability: availability,
    warnings: [
      {
        code: "UPSTREAM_UNAVAILABLE",
        message: detail ?? "The air quality provider could not be reached.",
      },
      {
        code: "NO_CACHED_DATA",
        message: "No previous reading is available, so no air quality data can be shown for this city right now.",
      },
    ],
    freshnessStatus: "unavailable",
    ageSeconds: null,
    cache: { status: "none", ttlSeconds, expiresAt: null },
  };
}
