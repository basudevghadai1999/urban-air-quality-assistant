import { getCityById, type CityId } from "@/config/cities";
import { buildUnavailableAirData } from "@/lib/data/airData";
import type { NormalizedAirData } from "@/types/air";

import { FETCHED_AT_MS, type FixtureOptions } from "./openMeteo";
import { makeSnapshot } from "./snapshot";

/**
 * SYNTHETIC forecast shapes for the recommendation-engine tests. They are invented numbers that
 * exercise specific situations; none is a production reading. Everything goes through the real
 * mapper and CPCB engine, so the engine under test receives genuine `NormalizedAirData`.
 *
 * Reference instant: 2026-11-24 13:47 IST. The forecast starts at 14:00 IST and runs 49 hours, so
 * the next 24 hours cover 14:00 today to 14:00 tomorrow.
 */

export const NOW = FETCHED_AT_MS;

const localHour = (epochSeconds: number): number => ((((epochSeconds + 19_800) % 86_400) + 86_400) % 86_400) / 3600;

/** Low background gases, so the particulate signal in each shape is not masked by the fixture defaults. */
const LOW_GASES = {
  nitrogen_dioxide: () => 10,
  sulphur_dioxide: () => 5,
  ozone: () => 20,
  carbon_monoxide: () => 300,
} as const;

/** Cleanest around 18:00 local, dirtiest around 06:00 local. PM10 follows PM2.5. */
export const EVENING_DIP: FixtureOptions = {
  values: {
    ...LOW_GASES,
    pm2_5: (_h, t) => 60 + 40 * Math.cos((2 * Math.PI * (localHour(t) - 6)) / 24),
    pm10: (_h, t) => 1.8 * (60 + 40 * Math.cos((2 * Math.PI * (localHour(t) - 6)) / 24)),
  },
};

/** Gets steadily worse hour by hour. */
export const RISING: FixtureOptions = {
  values: {
    ...LOW_GASES,
    pm2_5: (h) => 30 + Math.max(0, h) * 4,
    pm10: (h) => 50 + Math.max(0, h) * 6,
  },
};

/** Constant, low enough to satisfy every advisory ceiling. */
export const CLEAN_FLAT: FixtureOptions = {
  values: { pm2_5: () => 12, pm10: () => 30, nitrogen_dioxide: () => 10, sulphur_dioxide: () => 5, ozone: () => 20, carbon_monoxide: () => 300 },
};

/** Constant and severe: no window can qualify. */
export const SEVERE_FLAT: FixtureOptions = {
  values: { pm2_5: () => 320, pm10: () => 480 },
};

/** PM2.5 dips in the evening while NO2 climbs sharply: the dip must not be recommended on its own. */
export const PM25_DIPS_NO2_SOARS: FixtureOptions = {
  values: {
    ...LOW_GASES,
    pm2_5: (_h, t) => (localHour(t) >= 16 && localHour(t) < 20 ? 15 : 70),
    pm10: (_h, t) => (localHour(t) >= 16 && localHour(t) < 20 ? 30 : 100),
    nitrogen_dioxide: (_h, t) => (localHour(t) >= 16 && localHour(t) < 20 ? 390 : 20),
  },
};

export function snapshot(options: FixtureOptions = EVENING_DIP, cityId: CityId = "delhi-ncr"): NormalizedAirData {
  return makeSnapshot(cityId, FETCHED_AT_MS, options);
}

/** The same snapshot presented as a stale fallback (provider unreachable), `ageSeconds` old. */
export function stale(air: NormalizedAirData, ageSeconds = 5400): NormalizedAirData {
  return {
    ...air,
    freshnessStatus: "stale",
    ageSeconds,
    cache: { ...air.cache, status: "stale-fallback" },
  };
}

export function unavailable(cityId: CityId = "delhi-ncr"): NormalizedAirData {
  const city = getCityById(cityId);
  if (city === undefined) throw new Error("unknown city");
  return buildUnavailableAirData(city, 900, undefined, NOW);
}

/** Dirty all day except a clean spell from 07:00 to 09:59 local. */
export const MORNING_DIP: FixtureOptions = {
  values: {
    ...LOW_GASES,
    pm2_5: (_h, t) => (localHour(t) >= 7 && localHour(t) < 10 ? 20 : 90),
    pm10: (_h, t) => (localHour(t) >= 7 && localHour(t) < 10 ? 36 : 162),
  },
};

/** Cleanest at 18:00 but never clean: even the best window exceeds the advisory ceilings. */
export const HIGH_DIP: FixtureOptions = {
  values: {
    ...LOW_GASES,
    pm2_5: (_h, t) => 190 + 80 * Math.cos((2 * Math.PI * (localHour(t) - 6)) / 24),
    pm10: (_h, t) => 1.8 * (190 + 80 * Math.cos((2 * Math.PI * (localHour(t) - 6)) / 24)),
  },
};
