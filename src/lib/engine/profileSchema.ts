import { z } from "zod";

import { CITY_IDS } from "@/config/cities";

import {
  ACTIVITY_KINDS,
  AGE_GROUPS,
  COOKING_FUELS,
  PROFILE_IDS,
  TRANSPORT_MODES,
  VENTILATION_PREFERENCES,
} from "./types";

/**
 * Validation for everything a caller can send to the recommendation engine.
 *
 * Design rules:
 *  - Every object is STRICT: an unknown key is an error, so nothing unexpected reaches the engine.
 *  - There is NO free-text field anywhere: only enums, bounded numbers and "HH:MM" times. A caller
 *    therefore cannot place instructions where a later model (Phase 3B) could read them as a prompt.
 *  - Only what the engine needs is collected: no name, address, health record, age in years or
 *    precise location. Age is a coarse band; location is a city from the registry.
 *  - Error messages are fixed text and never echo the submitted value.
 */

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const timeOfDaySchema = z.string().regex(TIME, "must be a time like 07:30 (24-hour, HH:MM)");

export function minutesOfDay(time: string): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

const boundedInt = (min: number, max: number) => z.number().int().min(min).max(max);

const scheduleItemInputSchema = z
  .strictObject({
    activity: z.enum(ACTIVITY_KINDS),
    preferredStart: timeOfDaySchema,
    durationMinutes: boundedInt(5, 240),
    /** Omit both to mark the time as fixed. */
    earliestStart: timeOfDaySchema.optional(),
    latestStart: timeOfDaySchema.optional(),
  })
  .superRefine((value, ctx) => {
    const preferred = minutesOfDay(value.preferredStart);
    const earliest = value.earliestStart === undefined ? preferred : minutesOfDay(value.earliestStart);
    const latest = value.latestStart === undefined ? preferred : minutesOfDay(value.latestStart);
    if (earliest > latest) {
      ctx.addIssue({ code: "custom", path: ["earliestStart"], message: "earliestStart must not be after latestStart" });
    }
    if (preferred < earliest || preferred > latest) {
      ctx.addIssue({
        code: "custom",
        path: ["preferredStart"],
        message: "preferredStart must lie between earliestStart and latestStart",
      });
    }
    if (latest + value.durationMinutes > 24 * 60) {
      ctx.addIssue({ code: "custom", path: ["durationMinutes"], message: "the activity must finish before midnight" });
    }
  });

export const preferencesInputSchema = z.strictObject({
  wakeUpTime: timeOfDaySchema.optional(),
  workOrSchoolStart: timeOfDaySchema.optional(),
  commuteMinutes: boundedInt(0, 240).optional(),
  /** One-way distance in kilometres. */
  commuteDistanceKm: z.number().min(0.1).max(100).optional(),
  commuteDaysPerWeek: boundedInt(1, 7).optional(),
  preferredTransport: z.enum(TRANSPORT_MODES).optional(),
  vehicleOccupancy: boundedInt(1, 8).optional(),
  outdoorActivityMinutes: boundedInt(5, 240).optional(),
  householdSize: boundedInt(1, 12).optional(),
  cookingFuel: z.enum(COOKING_FUELS).optional(),
  hasAirPurifier: z.boolean().optional(),
  ventilationPreference: z.enum(VENTILATION_PREFERENCES).optional(),
  ageGroup: z.enum(AGE_GROUPS).optional(),
  schedule: z.array(scheduleItemInputSchema).min(1).max(10).optional(),
  /** A PM2.5 reading the user typed in from their own monitor, in ug/m3. */
  indoorPm25UgM3: z.number().min(0).max(1000).optional(),
});

export type PreferencesInput = z.infer<typeof preferencesInputSchema>;
export type ScheduleItemInput = z.infer<typeof scheduleItemInputSchema>;

export const recommendRequestSchema = z.strictObject({
  cityId: z.enum(CITY_IDS),
  profileId: z.enum(PROFILE_IDS),
  preferences: preferencesInputSchema.optional(),
  /** Ask for a Gemini-written explanation of the (server-computed) result. Default: deterministic result only. */
  explain: z.boolean().optional(),
});

export type RecommendRequest = z.infer<typeof recommendRequestSchema>;

/** Field paths with problems, no values: safe to return to a client. */
export function describeIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.slice(0, 10).map((issue) => ({
    path: issue.path.map(String).join("."),
    // Unknown-key issues name the key (a path); other messages come from the fixed schema texts above or Zod's built-ins.
    message: issue.code === "unrecognized_keys" ? "unsupported field" : issue.message,
  }));
}
