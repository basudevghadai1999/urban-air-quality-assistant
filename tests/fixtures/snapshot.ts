import { getCityById, type CityId } from "@/config/cities";
import { buildAirSnapshot } from "@/lib/data/airData";
import { mapOpenMeteoResponse } from "@/lib/data/openMeteo/mapper";
import { openMeteoResponseSchema } from "@/lib/data/openMeteo/schema";
import type { NormalizedAirData } from "@/types/air";

import { FETCHED_AT_MS, makeOpenMeteoResponse, type FixtureOptions } from "./openMeteo";

/** A real, valid snapshot built through the production mapper and AQI engine (synthetic input values). */
export function makeSnapshot(
  cityId: CityId = "delhi-ncr",
  fetchedAtMs = FETCHED_AT_MS,
  options: FixtureOptions = {},
  ttlSeconds = 900,
): NormalizedAirData {
  const city = getCityById(cityId);
  if (city === undefined) throw new Error("unknown city");
  const response = openMeteoResponseSchema.parse(makeOpenMeteoResponse(options));
  return buildAirSnapshot(mapOpenMeteoResponse(response, city, fetchedAtMs), city, fetchedAtMs, ttlSeconds);
}
