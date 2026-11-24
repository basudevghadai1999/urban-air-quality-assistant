import type { City } from "@/config/cities";
import {
  convertConcentration,
  parseUnit,
  type Observation,
  type PollutantSeries,
} from "@/lib/aqi";
import { IST_UTC_OFFSET_SECONDS } from "@/lib/constants";
import { formatIsoWithOffset } from "@/lib/time";
import type {
  AirWarning,
  CurrentConditions,
  HourlyRecord,
  PollutantAvailability,
  ProviderPollutantId,
  UnitConversion,
} from "@/types/air";

import { OpenMeteoError } from "./errors";
import type { OpenMeteoResponse } from "./schema";
import {
  EXPECTED_PROVIDER_UNIT,
  PROVIDER_POLLUTANT_IDS,
  PROVIDER_VARIABLES,
  UNSUPPORTED_BY_PROVIDER,
  type ProviderVariable,
} from "./types";

/**
 * Provider -> internal mapping.
 *
 * - Variable names map to the AQI engine's pollutant IDs.
 * - Dataset values keep the provider's SOURCE units.
 * - The single unit conversion (CO ug/m3 -> mg/m3) is applied ONLY when building the
 *   CPCB AQI input, with the AQI engine's own explicit `convertConcentration`.
 * - Units are verified against the response's `hourly_units`; a pollutant with an
 *   unexpected unit is excluded, never converted by guesswork.
 * - Historical and forecast data are split at the reference time and never mixed.
 */

export interface MappedOpenMeteoData {
  readonly grid: { readonly latitude: number; readonly longitude: number };
  /** Latest hourly instant at or before the reference time; null if there is none. */
  readonly windowEndMs: number | null;
  readonly current: CurrentConditions | null;
  /** Hourly instants at or before the reference time. */
  readonly historical: readonly HourlyRecord[];
  /** Hourly instants strictly after the reference time. */
  readonly forecast: readonly HourlyRecord[];
  readonly sourceUnits: Readonly<Partial<Record<ProviderPollutantId, string>>>;
  readonly unitConversions: readonly UnitConversion[];
  readonly pollutantAvailability: readonly PollutantAvailability[];
  /** Input for `calculateAqiFromTimeSeries`: historical data only, in CPCB canonical units. */
  readonly aqiSeries: readonly PollutantSeries[];
  readonly warnings: readonly AirWarning[];
}

const CO_UG_TO_MG_FACTOR = 0.001;

function variableOf(pollutant: ProviderPollutantId): ProviderVariable {
  return PROVIDER_VARIABLES[pollutant];
}

export function mapOpenMeteoResponse(
  response: OpenMeteoResponse,
  city: City,
  fetchedAtMs: number,
): MappedOpenMeteoData {
  // All local-time rendering assumes the configured fixed offset; refuse anything else.
  if (response.timezone !== city.timezone || response.utc_offset_seconds !== IST_UTC_OFFSET_SECONDS) {
    throw new OpenMeteoError("UPSTREAM_INVALID_RESPONSE", { detail: "timezone or UTC offset does not match configuration" });
  }
  const offset = response.utc_offset_seconds;
  const warnings: AirWarning[] = [];

  // --- Which pollutants are usable, and in which unit? ---------------------------------
  const availability: PollutantAvailability[] = [];
  const usable: ProviderPollutantId[] = [];
  const sourceUnits: Partial<Record<ProviderPollutantId, string>> = {};

  for (const pollutant of PROVIDER_POLLUTANT_IDS) {
    const variable = variableOf(pollutant);
    const series = response.hourly[variable];
    const unit = response.hourly_units[variable];

    if (series === undefined) {
      availability.push({ pollutant, status: "unavailable", reason: "variable-missing" });
      warnings.push({ code: "VARIABLE_MISSING", pollutant, message: `${pollutant} was not present in the provider response.` });
      continue;
    }
    if (unit === undefined || parseUnit(unit) !== EXPECTED_PROVIDER_UNIT) {
      availability.push({
        pollutant,
        status: "unavailable",
        reason: "unexpected-unit",
        ...(unit === undefined ? {} : { sourceUnit: unit }),
      });
      warnings.push({
        code: "UNEXPECTED_UNIT",
        pollutant,
        message: `${pollutant} was excluded: the provider reported an unexpected unit, and no conversion is guessed.`,
      });
      continue;
    }
    if (!series.some((value) => value !== null)) {
      availability.push({ pollutant, status: "unavailable", reason: "no-valid-data", sourceUnit: unit });
      warnings.push({ code: "NO_VALID_DATA", pollutant, message: `${pollutant} had no values in the requested window.` });
      continue;
    }

    availability.push({ pollutant, status: "available", sourceUnit: unit });
    sourceUnits[pollutant] = unit;
    usable.push(pollutant);
  }
  for (const pollutant of UNSUPPORTED_BY_PROVIDER) {
    availability.push({ pollutant, status: "unavailable", reason: "not-provided-by-provider" });
  }

  // --- Reference time: never later than our own clock, so no future data counts as past ---
  const currentMs = response.current === undefined ? null : response.current.time * 1000;
  if (currentMs === null) {
    warnings.push({ code: "CURRENT_CONDITIONS_UNAVAILABLE", message: "The provider returned no current-conditions block." });
  }
  const referenceMs = Math.min(currentMs ?? fetchedAtMs, fetchedAtMs);

  const times = response.hourly.time;
  let windowEndSeconds: number | null = null;
  for (const time of times) {
    if (time * 1000 <= referenceMs && (windowEndSeconds === null || time > windowEndSeconds)) windowEndSeconds = time;
  }

  // --- Split into historical and forecast -------------------------------------------------
  const historical: HourlyRecord[] = [];
  const forecast: HourlyRecord[] = [];
  times.forEach((time, index) => {
    const values: Partial<Record<ProviderPollutantId, number | null>> = {};
    for (const pollutant of usable) {
      values[pollutant] = response.hourly[variableOf(pollutant)]?.[index] ?? null;
    }
    const record: HourlyRecord = {
      time: formatIsoWithOffset(time * 1000, offset),
      epochSeconds: time,
      values,
    };
    (time * 1000 <= referenceMs ? historical : forecast).push(record);
  });

  if (historical.length === 0) {
    warnings.push({ code: "NO_HISTORICAL_DATA", message: "The response contained no hourly data at or before the current time." });
  }

  // --- Current conditions (a single snapshot; never feeds the AQI) -------------------------
  let current: CurrentConditions | null = null;
  if (response.current !== undefined) {
    const values: Partial<Record<ProviderPollutantId, number | null>> = {};
    for (const pollutant of usable) {
      const variable = variableOf(pollutant);
      const unit = response.current_units?.[variable];
      if (unit !== undefined && parseUnit(unit) === EXPECTED_PROVIDER_UNIT) {
        values[pollutant] = response.current[variable] ?? null;
      }
    }
    current = {
      kind: "model-snapshot",
      timestamp: formatIsoWithOffset(response.current.time * 1000, offset),
      epochSeconds: response.current.time,
      intervalSeconds: response.current.interval,
      values,
    };
  }

  // --- CPCB AQI input: historical only, canonical units, explicit CO conversion ------------
  const aqiSeries: PollutantSeries[] = PROVIDER_POLLUTANT_IDS.map((pollutant): PollutantSeries => {
    const isUsable = usable.includes(pollutant);
    const canonical = pollutant === "co" ? "mg/m3" : "ug/m3";
    const observations: Observation[] = isUsable
      ? historical.map((record) => {
          const raw = record.values[pollutant] ?? null;
          return {
            timestamp: record.epochSeconds * 1000,
            value: raw === null ? null : pollutant === "co" ? convertConcentration(raw, "ug/m3", "mg/m3") : raw,
          };
        })
      : [];
    return { pollutant, unit: canonical, observations };
  });

  const unitConversions: UnitConversion[] = usable.includes("co")
    ? [{ pollutant: "co", from: "ug/m3", to: "mg/m3", factor: CO_UG_TO_MG_FACTOR, appliedTo: "cpcb-aqi-input" }]
    : [];

  return {
    grid: { latitude: response.latitude, longitude: response.longitude },
    windowEndMs: windowEndSeconds === null ? null : windowEndSeconds * 1000,
    current,
    historical,
    forecast,
    sourceUnits,
    unitConversions,
    pollutantAvailability: availability,
    aqiSeries,
    warnings,
  };
}
