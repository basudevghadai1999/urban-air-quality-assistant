import { z } from "zod";

import { MAX_HOURLY_POINTS } from "./types";

/**
 * Zod schema for the Open-Meteo Air Quality response, requested with
 * `timeformat=unixtime`. Structure only: whether a unit is the one we expect is
 * decided by the mapper, so one odd pollutant does not discard the whole response.
 *
 * Extra fields are tolerated (the provider adds fields over time); missing or
 * null pollutant values are expected and handled downstream.
 */

/** 2020-01-01 and 2100-01-01 UTC, in seconds: anything outside is not a plausible model timestamp. */
const MIN_EPOCH_SECONDS = 1_577_836_800;
const MAX_EPOCH_SECONDS = 4_102_444_800;
const HOUR_SECONDS = 3_600;

const epochSeconds = z.number().int().min(MIN_EPOCH_SECONDS).max(MAX_EPOCH_SECONDS);
const nullableNumber = z.number().nullable();
const hourlySeries = z.array(nullableNumber).max(MAX_HOURLY_POINTS);

const POLLUTANT_KEYS = [
  "pm2_5",
  "pm10",
  "carbon_monoxide",
  "nitrogen_dioxide",
  "sulphur_dioxide",
  "ozone",
] as const;

const hourlySchema = z.looseObject({
  time: z.array(epochSeconds).min(1).max(MAX_HOURLY_POINTS),
  pm2_5: hourlySeries.optional(),
  pm10: hourlySeries.optional(),
  carbon_monoxide: hourlySeries.optional(),
  nitrogen_dioxide: hourlySeries.optional(),
  sulphur_dioxide: hourlySeries.optional(),
  ozone: hourlySeries.optional(),
});

const hourlyUnitsSchema = z.looseObject({
  /** We request unixtime; anything else means the time axis cannot be trusted. */
  time: z.literal("unixtime"),
  pm2_5: z.string().min(1).optional(),
  pm10: z.string().min(1).optional(),
  carbon_monoxide: z.string().min(1).optional(),
  nitrogen_dioxide: z.string().min(1).optional(),
  sulphur_dioxide: z.string().min(1).optional(),
  ozone: z.string().min(1).optional(),
});

const currentSchema = z.looseObject({
  time: epochSeconds,
  interval: z.number().int().positive(),
  pm2_5: nullableNumber.optional(),
  pm10: nullableNumber.optional(),
  carbon_monoxide: nullableNumber.optional(),
  nitrogen_dioxide: nullableNumber.optional(),
  sulphur_dioxide: nullableNumber.optional(),
  ozone: nullableNumber.optional(),
});

const currentUnitsSchema = z.looseObject({
  pm2_5: z.string().optional(),
  pm10: z.string().optional(),
  carbon_monoxide: z.string().optional(),
  nitrogen_dioxide: z.string().optional(),
  sulphur_dioxide: z.string().optional(),
  ozone: z.string().optional(),
});

export const openMeteoResponseSchema = z
  .looseObject({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    elevation: z.number().optional(),
    generationtime_ms: z.number().nonnegative().optional(),
    utc_offset_seconds: z.number().int().min(-18 * 3600).max(18 * 3600),
    timezone: z.string().min(1),
    timezone_abbreviation: z.string().optional(),
    current: currentSchema.optional(),
    current_units: currentUnitsSchema.optional(),
    hourly: hourlySchema,
    hourly_units: hourlyUnitsSchema,
  })
  .superRefine((value, ctx) => {
    const { hourly, hourly_units: units } = value;

    // Every series must line up with the time axis, and carry a unit.
    for (const key of POLLUTANT_KEYS) {
      const series = hourly[key];
      if (series === undefined) continue;
      if (series.length !== hourly.time.length) {
        ctx.addIssue({
          code: "custom",
          path: ["hourly", key],
          message: `length ${series.length} does not match time axis length ${hourly.time.length}`,
        });
      }
      if (units[key] === undefined) {
        ctx.addIssue({ code: "custom", path: ["hourly_units", key], message: "missing unit for returned series" });
      }
    }

    // Time axis: strictly increasing, exactly hourly.
    for (let i = 1; i < hourly.time.length; i += 1) {
      const previous = hourly.time[i - 1];
      const current = hourly.time[i];
      if (previous === undefined || current === undefined) continue;
      if (current - previous !== HOUR_SECONDS) {
        ctx.addIssue({
          code: "custom",
          path: ["hourly", "time", i],
          message: "hourly timestamps must be strictly increasing in one-hour steps",
        });
        break;
      }
    }
  });

export type OpenMeteoResponse = z.infer<typeof openMeteoResponseSchema>;

/** Provider error envelope, e.g. {"error":true,"reason":"..."}. The `reason` is never forwarded. */
export const openMeteoErrorEnvelopeSchema = z.looseObject({ error: z.literal(true) });

/** Compact, value-free description of why validation failed, safe for server logs. */
export function summarizeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.code}`)
    .join("; ");
}
