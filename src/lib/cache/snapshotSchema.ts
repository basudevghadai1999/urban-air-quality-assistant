import { z } from "zod";

import { CITY_IDS } from "@/config/cities";
import { POLLUTANT_IDS } from "@/lib/aqi";
import { AIR_DATA_DISCLAIMER } from "@/lib/constants";
import type { NormalizedAirData } from "@/types/air";

/**
 * Validation for snapshots read back from a shared cache.
 *
 * Whatever sits in Redis (a corrupt write, an older deployment's shape, or a
 * tampered value) must not reach API consumers unchecked. Entries that fail
 * these checks are treated as a miss, never repaired and never served.
 *
 * Strict where consumers depend on a field; `looseObject` for nested detail that
 * is passed through. Integrity rules are enforced too: for example a `valid` AQI
 * must equal the maximum of its own sub-indices, and a non-valid result must not
 * carry a number (so "unavailable" can never be turned into a reading).
 */

const pollutantId = z.enum(POLLUTANT_IDS);
const providerPollutantId = z.enum(["pm25", "pm10", "no2", "so2", "o3", "co"]);
const isoUtc = z.iso.datetime();
const isoWithOffset = z.iso.datetime({ offset: true });
const nonNegativeInt = z.number().int().min(0);

const warning = z.looseObject({
  code: z.string().min(1),
  message: z.string(),
  pollutant: z.string().optional(),
});

const readings = z.partialRecord(providerPollutantId, z.number().nullable());

const hourlyRecord = z.looseObject({
  time: isoWithOffset,
  epochSeconds: z.number().int(),
  values: readings,
});

const hourlyDataset = z.looseObject({
  kind: z.enum(["historical-model", "forecast-model"]),
  label: z.string(),
  rangeStart: isoWithOffset.nullable(),
  rangeEnd: isoWithOffset.nullable(),
  hours: z.array(hourlyRecord).max(200),
});

const currentConditions = z.looseObject({
  kind: z.literal("model-snapshot"),
  timestamp: isoWithOffset,
  epochSeconds: z.number().int(),
  intervalSeconds: z.number().int().positive(),
  values: readings,
});

const subIndex = z.looseObject({
  pollutant: pollutantId,
  exact: z.number().min(0).max(500),
  index: z.number().int().min(0).max(500),
  category: z.string().min(1),
  concentration: z.looseObject({
    value: z.number().min(0),
    unit: z.enum(["ug/m3", "mg/m3"]),
    averagingHours: z.union([z.literal(8), z.literal(24)]),
    basis: z.string(),
  }),
  segment: z.looseObject({
    kind: z.string(),
    concentrationLow: z.number(),
    concentrationHigh: z.number(),
    indexLow: z.number(),
    indexHigh: z.number(),
  }),
});

const aqiResult = z
  .looseObject({
    status: z.enum(["valid", "insufficient_data", "invalid_input", "incomplete_window", "unsupported_data"]),
    aqi: z.number().int().min(0).max(500).nullable(),
    category: z
      .looseObject({ id: z.string().min(1), label: z.string().min(1), min: z.number(), max: z.number(), rank: z.number() })
      .nullable(),
    dominantPollutant: pollutantId.nullable(),
    calculatedAt: isoUtc,
    observationTime: isoUtc.nullable(),
    methodology: z.looseObject({ name: z.string().min(1) }),
    dataSource: z.looseObject({ kind: z.enum(["model-estimate", "station-observation", "unspecified"]), name: z.string() }),
    provenanceLabel: z.string().min(1),
    disclaimer: z.string().min(1),
    availablePollutants: z.array(pollutantId),
    availablePollutantCount: nonNegativeInt,
    missingPollutants: z.array(pollutantId),
    unsupportedPollutants: z.array(z.string()),
    subIndices: z.array(subIndex).max(8),
    completeness: z.looseObject({
      level: z.enum(["full", "partial", "insufficient"]),
      availablePollutantCount: nonNegativeInt,
      requirementsMet: z.boolean(),
      windows: z.array(
        z.looseObject({
          pollutant: pollutantId,
          status: z.string(),
          stats: z.looseObject({ validHours: nonNegativeInt, requiredValidHours: nonNegativeInt }),
        }),
      ),
    }),
    warnings: z.array(warning),
  })
  .superRefine((value, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["aqi"], message });
    if (value.status === "valid") {
      if (value.aqi === null || value.category === null || value.dominantPollutant === null) {
        issue("a valid result must carry an AQI, a category and a dominant pollutant");
        return;
      }
      const maxIndex = Math.max(...value.subIndices.map((s) => s.index));
      if (value.subIndices.length === 0 || value.aqi !== maxIndex) issue("AQI does not equal the maximum sub-index");
    } else if (value.aqi !== null || value.category !== null || value.dominantPollutant !== null) {
      issue("a result without a valid estimate must not carry an AQI");
    }
  });

export const normalizedAirDataSchema = z.looseObject({
  cityId: z.enum(CITY_IDS),
  cityName: z.string().min(1),
  state: z.string().min(1),
  dataLocation: z.string().min(1),
  coordinates: z.looseObject({
    requested: z.looseObject({ latitude: z.number(), longitude: z.number() }),
    grid: z.looseObject({ latitude: z.number(), longitude: z.number() }).nullable(),
  }),
  timezone: z.literal("Asia/Kolkata"),
  source: z.literal("open-meteo"),
  sourceName: z.string().min(1),
  sourceDescription: z.string().min(1),
  sourceInfo: z.looseObject({
    id: z.literal("open-meteo-air-quality"),
    attribution: z.string().min(1),
    attributionLinks: z.array(z.looseObject({ label: z.string(), url: z.url() })).min(1),
  }),
  disclaimer: z.literal(AIR_DATA_DISCLAIMER),
  // A snapshot only exists because the provider answered, so these cannot be null.
  fetchedAt: isoUtc,
  providerGeneratedAt: z.null(),
  dataTimestamp: isoWithOffset.nullable(),
  currentConditions: currentConditions.nullable(),
  historicalHourlyData: hourlyDataset,
  forecastHourlyData: hourlyDataset,
  sourceUnits: z.partialRecord(providerPollutantId, z.string()),
  unitConversions: z.array(z.looseObject({ pollutant: pollutantId })),
  calculatedAqi: aqiResult,
  dataCompleteness: z.looseObject({ level: z.enum(["full", "partial", "insufficient"]) }),
  missingPollutants: z.array(pollutantId),
  pollutantAvailability: z.array(
    z.looseObject({ pollutant: pollutantId, status: z.enum(["available", "unavailable"]) }),
  ),
  warnings: z.array(warning),
  // "unavailable" is never cached: it is a state, not a reading.
  freshnessStatus: z.enum(["fresh", "stale"]),
  ageSeconds: nonNegativeInt,
  cache: z.looseObject({
    status: z.enum(["miss", "hit", "stale-fallback", "none"]),
    ttlSeconds: z.number().int().positive(),
    expiresAt: isoUtc.nullable(),
  }),
});

/** Envelope written to Redis. `v` lets a future shape change invalidate old entries cleanly. */
export const SNAPSHOT_FORMAT_VERSION = 1;

export const storedSnapshotSchema = z.looseObject({
  v: z.literal(SNAPSHOT_FORMAT_VERSION),
  storedAtMs: z.number().int().positive(),
  value: normalizedAirDataSchema,
});

export type SnapshotParseResult =
  | { readonly ok: true; readonly storedAtMs: number; readonly value: NormalizedAirData }
  | { readonly ok: false; readonly reason: "corrupt-json" | "invalid-schema" };

/** Parse and validate a stored entry. Never throws. */
export function parseStoredSnapshot(raw: string): SnapshotParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "corrupt-json" };
  }
  const parsed = storedSnapshotSchema.safeParse(json);
  if (!parsed.success) return { ok: false, reason: "invalid-schema" };
  return {
    ok: true,
    storedAtMs: parsed.data.storedAtMs,
    // Validated above; the schema is intentionally looser than the TypeScript type for nested detail.
    value: parsed.data.value as unknown as NormalizedAirData,
  };
}
