import type { CityId } from "@/config/cities";
import type { AqiResult, DataCompleteness, PollutantId } from "@/lib/aqi";

/**
 * Provider-independent air quality contract returned by `/api/air`.
 *
 * Three kinds of data are kept in SEPARATE fields and must never be merged:
 *   - `currentConditions`    one provider snapshot; never used to compute an AQI
 *   - `historicalHourlyData` model values at or before the reference time; the
 *                            only input to the current AQI
 *   - `forecastHourlyData`   model predictions after the reference time
 * None of them is a CPCB station measurement.
 */

/** Pollutants the Open-Meteo Air Quality API provides for India. NH3 and Pb are not among them. */
export type ProviderPollutantId = Extract<PollutantId, "pm25" | "pm10" | "no2" | "so2" | "o3" | "co">;

export type FreshnessStatus = "fresh" | "stale" | "unavailable";

export type AirWarningCode =
  | "STALE_DATA"
  | "UPSTREAM_UNAVAILABLE"
  | "NO_CACHED_DATA"
  | "PROVIDER_DATA_LAGGING"
  | "CURRENT_CONDITIONS_UNAVAILABLE"
  | "NO_HISTORICAL_DATA"
  | "VARIABLE_MISSING"
  | "UNEXPECTED_UNIT"
  | "NO_VALID_DATA"
  /** A refresh was deliberately skipped (request limiting unavailable); an older reading is shown. */
  | "REFRESH_PAUSED";

export interface AirWarning {
  readonly code: AirWarningCode;
  readonly message: string;
  readonly pollutant?: PollutantId;
}

export type PollutantUnavailableReason =
  | "not-provided-by-provider"
  | "variable-missing"
  | "unexpected-unit"
  | "no-valid-data"
  | "upstream-unavailable";

export interface PollutantAvailability {
  readonly pollutant: PollutantId;
  readonly status: "available" | "unavailable";
  readonly reason?: PollutantUnavailableReason;
  /** Unit string exactly as the provider reported it. */
  readonly sourceUnit?: string;
}

/** One hourly instant. Values are in SOURCE units (see `NormalizedAirData.sourceUnits`). */
export interface HourlyRecord {
  /** ISO-8601 with an explicit offset, e.g. 2026-11-24T13:00:00+05:30. */
  readonly time: string;
  readonly epochSeconds: number;
  readonly values: Readonly<Partial<Record<ProviderPollutantId, number | null>>>;
}

export interface HourlyDataset {
  readonly kind: "historical-model" | "forecast-model";
  readonly label: string;
  readonly rangeStart: string | null;
  readonly rangeEnd: string | null;
  readonly hours: readonly HourlyRecord[];
}

export interface CurrentConditions {
  readonly kind: "model-snapshot";
  /** Provider-declared time of the snapshot, with offset. */
  readonly timestamp: string;
  readonly epochSeconds: number;
  readonly intervalSeconds: number;
  /** Source units. A single snapshot is never used to compute the AQI. */
  readonly values: Readonly<Partial<Record<ProviderPollutantId, number | null>>>;
}

export interface UnitConversion {
  readonly pollutant: PollutantId;
  readonly from: "ug/m3";
  readonly to: "mg/m3";
  readonly factor: number;
  /** Conversions apply only to the CPCB AQI input; dataset values stay in source units. */
  readonly appliedTo: "cpcb-aqi-input";
}

export interface AttributionLink {
  readonly label: string;
  readonly url: string;
}

export interface DataSourceInfo {
  readonly id: "open-meteo-air-quality";
  readonly name: string;
  readonly description: string;
  readonly kind: "atmospheric-model";
  readonly url: string;
  readonly licence: string;
  /** Full required credit text, including the Copernicus notices. Display it wherever the data is shown. */
  readonly attribution: string;
  /** Links the terms require next to displayed data (Open-Meteo, the licence). */
  readonly attributionLinks: readonly AttributionLink[];
}

/**
 * Whether last-known-good data survives a server restart.
 *   persistent              Redis is configured and responding
 *   persistent-unavailable  Redis is configured but failing right now; memory-only meanwhile
 *   memory-only             Redis is not configured; data lives in this instance's memory
 */
export type CacheCapability = "persistent" | "persistent-unavailable" | "memory-only";

export interface CacheInfo {
  readonly status: "miss" | "hit" | "stale-fallback" | "none";
  readonly ttlSeconds: number;
  /** When the cached snapshot stops being fresh, or null if there is none. */
  readonly expiresAt: string | null;
  /** Present when the service knows its cache backend. Never claims durability that is not there. */
  readonly capability?: CacheCapability;
  /** True when a production deployment is running without working durable caching. */
  readonly degraded?: boolean;
}

export interface NormalizedAirData {
  readonly cityId: CityId;
  readonly cityName: string;
  readonly state: string;
  readonly dataLocation: string;
  /** The configured point, and the grid-cell centre the provider actually used. */
  readonly coordinates: {
    readonly requested: { readonly latitude: number; readonly longitude: number };
    readonly grid: { readonly latitude: number; readonly longitude: number } | null;
  };
  readonly timezone: string;

  readonly source: "open-meteo";
  readonly sourceName: string;
  readonly sourceDescription: string;
  readonly sourceInfo: DataSourceInfo;
  /** UI-ready, required disclaimer. */
  readonly disclaimer: string;

  /** When WE received the data from the provider (ISO, UTC). Null if nothing was ever received. */
  readonly fetchedAt: string | null;
  /** Open-Meteo reports no generation timestamp (only a duration), so this is always null. */
  readonly providerGeneratedAt: string | null;
  /** End of the historical window the AQI describes. Null if there is no usable history. */
  readonly dataTimestamp: string | null;

  readonly currentConditions: CurrentConditions | null;
  readonly historicalHourlyData: HourlyDataset;
  readonly forecastHourlyData: HourlyDataset;
  /** Provider units exactly as reported. */
  readonly sourceUnits: Readonly<Partial<Record<ProviderPollutantId, string>>>;
  readonly unitConversions: readonly UnitConversion[];

  /** CPCB-methodology estimate from historical data only. Null when no data exists at all. */
  readonly calculatedAqi: AqiResult | null;
  readonly dataCompleteness: DataCompleteness | null;
  /** Pollutants (of CPCB's eight) with no usable data. Never treated as zero. */
  readonly missingPollutants: readonly PollutantId[];
  readonly pollutantAvailability: readonly PollutantAvailability[];
  readonly warnings: readonly AirWarning[];

  readonly freshnessStatus: FreshnessStatus;
  /** Seconds since `fetchedAt`; null when unavailable. */
  readonly ageSeconds: number | null;
  readonly cache: CacheInfo;
}

/** The one list of `/api/air` error codes: the type, the client validator and the tests all derive from it. */
export const AIR_API_ERROR_CODES = [
  "MISSING_CITY_ID",
  "INVALID_CITY_ID",
  "UNSUPPORTED_PARAMETER",
  "DUPLICATE_PARAMETER",
  "REQUEST_TOO_LARGE",
  "RATE_LIMITED",
  "RATE_LIMITING_UNAVAILABLE",
  "AIR_DATA_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;
export type AirApiErrorCode = (typeof AIR_API_ERROR_CODES)[number];

export interface AirApiSuccess {
  readonly ok: true;
  readonly data: NormalizedAirData;
}

export interface AirApiError {
  readonly ok: false;
  readonly error: {
    readonly code: AirApiErrorCode;
    readonly message: string;
    /** Valid city IDs, included for INVALID_CITY_ID so clients can self-correct. */
    readonly validCityIds?: readonly string[];
    /** Seconds to wait before retrying, for RATE_LIMITED and RATE_LIMITING_UNAVAILABLE. */
    readonly retryAfterSeconds?: number;
  };
  /** Present for AIR_DATA_UNAVAILABLE: the explicit unavailable state. */
  readonly data?: NormalizedAirData;
}
