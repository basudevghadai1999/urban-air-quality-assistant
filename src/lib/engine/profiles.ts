import { PROFILE_PRESETS } from "@/config/profiles";

import { preferencesInputSchema, type PreferencesInput } from "./profileSchema";
import type { ProfileId, ProfilePreset, ResolvedPreferences, ScheduleItem } from "./types";

export { PROFILE_PRESETS, listProfileOptions } from "@/config/profiles";

export type ResolveResult =
  | {
      readonly ok: true;
      readonly preset: ProfilePreset;
      readonly preferences: ResolvedPreferences;
      /** Names of the preferences the caller overrode; everything else is a preset default. */
      readonly overridden: readonly string[];
    }
  | { readonly ok: false; readonly reason: "unknown-profile" | "invalid-preferences" };

/**
 * Merge a preset with validated overrides. Pure. Preferences are re-validated here so the
 * engine is safe even when called directly, without going through the API.
 *
 * Overriding the schedule replaces it wholesale (IDs are assigned `<activity>-<n>`).
 * Supplying a commute distance clears the "assumed" flag; the flag is what lets the output
 * say honestly when a CO2 figure rests on a preset distance.
 */
export function resolveProfile(profileId: ProfileId | string, input?: unknown): ResolveResult {
  // Own-property check: "constructor" and "__proto__" must not resolve to Object.prototype members.
  if (!Object.hasOwn(PROFILE_PRESETS, profileId)) return { ok: false, reason: "unknown-profile" };
  const preset: ProfilePreset | undefined = (PROFILE_PRESETS as Readonly<Record<string, ProfilePreset | undefined>>)[profileId];
  if (preset === undefined) return { ok: false, reason: "unknown-profile" };

  const parsed = preferencesInputSchema.safeParse(input ?? {});
  if (!parsed.success) return { ok: false, reason: "invalid-preferences" };
  const overrides: PreferencesInput = parsed.data;

  const { schedule: scheduleInput, commuteDistanceKm, indoorPm25UgM3, ...rest } = overrides;
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));

  let schedule: readonly ScheduleItem[] = preset.defaults.schedule;
  if (scheduleInput !== undefined) {
    const counts = new Map<string, number>();
    schedule = scheduleInput.map((entry) => {
      const n = (counts.get(entry.activity) ?? 0) + 1;
      counts.set(entry.activity, n);
      return {
        id: `${entry.activity}-${n}`,
        activity: entry.activity,
        preferredStart: entry.preferredStart,
        durationMinutes: entry.durationMinutes,
        earliestStart: entry.earliestStart ?? entry.preferredStart,
        latestStart: entry.latestStart ?? entry.preferredStart,
      };
    });
  }

  const preferences: ResolvedPreferences = {
    ...preset.defaults,
    ...(defined as Partial<ResolvedPreferences>),
    schedule,
    commuteDistanceKm: commuteDistanceKm ?? preset.defaults.commuteDistanceKm,
    distanceIsAssumed: commuteDistanceKm === undefined ? preset.defaults.distanceIsAssumed : false,
    indoorPm25UgM3: indoorPm25UgM3 ?? preset.defaults.indoorPm25UgM3,
  };

  const overridden = [
    ...Object.keys(defined),
    ...(scheduleInput === undefined ? [] : ["schedule"]),
    ...(commuteDistanceKm === undefined ? [] : ["commuteDistanceKm"]),
    ...(indoorPm25UgM3 === undefined ? [] : ["indoorPm25UgM3"]),
  ].sort();

  return { ok: true, preset, preferences, overridden };
}
