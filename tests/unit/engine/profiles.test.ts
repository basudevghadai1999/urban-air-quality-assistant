import { describe, expect, it } from "vitest";

import { PROFILE_ORDER, PROFILE_PRESETS } from "@/config/profiles";
import {
  describeIssues,
  listProfileOptions,
  preferencesInputSchema,
  recommendRequestSchema,
  resolveProfile,
} from "@/lib/engine";
import { PROFILE_IDS } from "@/lib/engine/types";
import { minutesOfDay } from "@/lib/engine/profileSchema";

describe("evaluator presets", () => {
  it("defines exactly the four required profiles, in a stable order", () => {
    expect([...PROFILE_IDS].sort()).toEqual(["family_toddlers", "senior_respiratory", "student_athlete", "two_wheeler_commuter"]);
    expect(PROFILE_ORDER).toEqual(["family_toddlers", "senior_respiratory", "two_wheeler_commuter", "student_athlete"]);
    expect(listProfileOptions().map((o) => o.id)).toEqual([...PROFILE_ORDER]);
    for (const option of listProfileOptions()) {
      expect(option.label.length).toBeGreaterThan(5);
      expect(option.description.length).toBeGreaterThan(10);
    }
  });

  it.each(PROFILE_ORDER)("%s resolves with no input at all (one-click preset)", (id) => {
    const result = resolveProfile(id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.overridden).toEqual([]);
    expect(result.preferences).toEqual(PROFILE_PRESETS[id].defaults);
    expect(result.preferences.distanceIsAssumed).toBe(true);
  });

  it.each(PROFILE_ORDER)("%s has an internally consistent schedule", (id) => {
    const { defaults } = PROFILE_PRESETS[id];
    const ids = new Set<string>();
    expect(defaults.schedule.length).toBeGreaterThan(0);
    for (const item of defaults.schedule) {
      expect(ids.has(item.id)).toBe(false);
      ids.add(item.id);
      expect(item.id.startsWith(item.activity)).toBe(true);
      expect(minutesOfDay(item.earliestStart)).toBeLessThanOrEqual(minutesOfDay(item.preferredStart));
      expect(minutesOfDay(item.preferredStart)).toBeLessThanOrEqual(minutesOfDay(item.latestStart));
      expect(minutesOfDay(item.latestStart) + item.durationMinutes).toBeLessThanOrEqual(24 * 60);
      if (item.activity.endsWith("_commute") && item.preferredStart < "12:00") {
        // A flexible morning commute must still arrive by the work or school start.
        expect(minutesOfDay(item.latestStart) + item.durationMinutes).toBeLessThanOrEqual(minutesOfDay(defaults.workOrSchoolStart));
      }
    }
  });

  it("encodes each profile's documented character", () => {
    expect(PROFILE_PRESETS.family_toddlers.sensitiveGroup).toBe(true);
    expect(PROFILE_PRESETS.senior_respiratory.sensitiveGroup).toBe(true);
    expect(PROFILE_PRESETS.two_wheeler_commuter.defaults.preferredTransport).toBe("two_wheeler");
    expect(PROFILE_PRESETS.two_wheeler_commuter.defaults.schedule.filter((s) => s.activity === "office_commute")).toHaveLength(2);
    const activities = (id: keyof typeof PROFILE_PRESETS) => PROFILE_PRESETS[id].defaults.schedule.map((s) => s.activity);
    expect(activities("family_toddlers")).toContain("school_commute");
    expect(activities("family_toddlers")).toContain("outdoor_play");
    expect(activities("senior_respiratory")).toContain("morning_walk");
    expect(activities("student_athlete")).toContain("outdoor_sports");
    expect(PROFILE_PRESETS.senior_respiratory.vulnerability).toBeGreaterThan(PROFILE_PRESETS.two_wheeler_commuter.vulnerability);
  });

  it("never states that any level is safe", () => {
    for (const preset of Object.values(PROFILE_PRESETS)) {
      // The senior profile's focus says it does NOT claim anything is medically safe; no text may claim safety.
      expect(`${preset.description} ${preset.focus}`.toLowerCase()).not.toMatch(/\b(is|are|be|as|stay) safe\b|safe (window|level|air|to)\b/);
    }
  });
});

describe("resolveProfile", () => {
  it("rejects an unknown profile without throwing", () => {
    expect(resolveProfile("grandparent")).toEqual({ ok: false, reason: "unknown-profile" });
    expect(resolveProfile("__proto__")).toEqual({ ok: false, reason: "unknown-profile" });
    expect(resolveProfile("constructor")).toEqual({ ok: false, reason: "unknown-profile" });
  });

  it("applies valid optional preferences over the preset and reports what was overridden", () => {
    const result = resolveProfile("senior_respiratory", {
      wakeUpTime: "04:45",
      cookingFuel: "biomass",
      hasAirPurifier: true,
      ventilationPreference: "mostly_closed",
      householdSize: 5,
      ageGroup: "71-<81",
      commuteDistanceKm: 6.5,
      indoorPm25UgM3: 80,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preferences).toMatchObject({
      wakeUpTime: "04:45",
      cookingFuel: "biomass",
      hasAirPurifier: true,
      ventilationPreference: "mostly_closed",
      householdSize: 5,
      ageGroup: "71-<81",
      commuteDistanceKm: 6.5,
      indoorPm25UgM3: 80,
    });
    expect(result.preferences.distanceIsAssumed).toBe(false);
    expect(result.overridden).toEqual(["ageGroup", "commuteDistanceKm", "cookingFuel", "hasAirPurifier", "householdSize", "indoorPm25UgM3", "ventilationPreference", "wakeUpTime"]);
    // Untouched fields keep the preset values.
    expect(result.preferences.schedule).toEqual(PROFILE_PRESETS.senior_respiratory.defaults.schedule);
  });

  it("replaces the schedule wholesale and assigns stable IDs", () => {
    const result = resolveProfile("student_athlete", {
      schedule: [
        { activity: "outdoor_sports", preferredStart: "06:00", durationMinutes: 45, earliestStart: "05:30", latestStart: "07:00" },
        { activity: "outdoor_sports", preferredStart: "18:00", durationMinutes: 30 },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preferences.schedule.map((s) => s.id)).toEqual(["outdoor_sports-1", "outdoor_sports-2"]);
    // Omitting the bounds marks the time as fixed.
    const fixed = result.preferences.schedule[1];
    expect(fixed?.earliestStart).toBe("18:00");
    expect(fixed?.latestStart).toBe("18:00");
  });

  it("keeps the preset distance flag when no distance is supplied", () => {
    const result = resolveProfile("two_wheeler_commuter", { commuteMinutes: 55 });
    expect(result.ok && result.preferences.distanceIsAssumed).toBe(true);
  });

  it("returns invalid-preferences for bad input rather than throwing", () => {
    expect(resolveProfile("family_toddlers", { wakeUpTime: "25:00" })).toEqual({ ok: false, reason: "invalid-preferences" });
    expect(resolveProfile("family_toddlers", "not an object")).toEqual({ ok: false, reason: "invalid-preferences" });
  });
});

describe("preference validation", () => {
  const ok = (value: unknown) => preferencesInputSchema.safeParse(value).success;

  it("accepts every optional preference the spec lists", () => {
    expect(
      ok({
        wakeUpTime: "06:00",
        workOrSchoolStart: "09:00",
        commuteMinutes: 30,
        preferredTransport: "metro",
        outdoorActivityMinutes: 40,
        householdSize: 4,
        cookingFuel: "png",
        hasAirPurifier: false,
        ventilationPreference: "balanced",
        schedule: [{ activity: "morning_walk", preferredStart: "06:00", durationMinutes: 30 }],
      }),
    ).toBe(true);
    expect(ok({})).toBe(true);
  });

  it.each([
    ["time with wrong format", { wakeUpTime: "6am" }],
    ["time out of range", { workOrSchoolStart: "24:00" }],
    ["minutes out of range", { wakeUpTime: "07:60" }],
    ["negative commute", { commuteMinutes: -5 }],
    ["fractional household size", { householdSize: 2.5 }],
    ["zero household", { householdSize: 0 }],
    ["huge distance", { commuteDistanceKm: 5000 }],
    ["unknown transport", { preferredTransport: "helicopter" }],
    ["unknown fuel", { cookingFuel: "coal" }],
    ["unknown age band", { ageGroup: "40" }],
    ["occupancy zero", { vehicleOccupancy: 0 }],
    ["indoor reading negative", { indoorPm25UgM3: -1 }],
    ["indoor reading absurd", { indoorPm25UgM3: 50_000 }],
  ])("rejects %s", (_name, value) => {
    expect(ok(value)).toBe(false);
  });

  it.each([
    ["earliest after latest", { activity: "morning_walk", preferredStart: "06:00", durationMinutes: 30, earliestStart: "08:00", latestStart: "07:00" }],
    ["preferred before earliest", { activity: "morning_walk", preferredStart: "05:00", durationMinutes: 30, earliestStart: "06:00", latestStart: "07:00" }],
    ["preferred after latest", { activity: "morning_walk", preferredStart: "09:00", durationMinutes: 30, earliestStart: "06:00", latestStart: "07:00" }],
    ["runs past midnight", { activity: "evening_exercise", preferredStart: "23:30", durationMinutes: 60 }],
    ["zero duration", { activity: "errands", preferredStart: "10:00", durationMinutes: 0 }],
    ["day-long duration", { activity: "errands", preferredStart: "10:00", durationMinutes: 600 }],
    ["unknown activity", { activity: "skydiving", preferredStart: "10:00", durationMinutes: 30 }],
    ["bad time", { activity: "errands", preferredStart: "ten", durationMinutes: 30 }],
  ])("rejects an invalid schedule entry: %s", (_name, entry) => {
    expect(ok({ schedule: [entry] })).toBe(false);
  });

  it("rejects an empty schedule and one with more than ten entries", () => {
    expect(ok({ schedule: [] })).toBe(false);
    const entry = { activity: "errands", preferredStart: "10:00", durationMinutes: 20 };
    expect(ok({ schedule: Array.from({ length: 11 }, () => entry) })).toBe(false);
    expect(ok({ schedule: Array.from({ length: 10 }, () => entry) })).toBe(true);
  });

  it("collects no free text and no personal data: unknown keys are refused", () => {
    for (const key of ["notes", "name", "address", "prompt", "systemPrompt", "instructions", "age", "email", "diagnosis", "latitude", "longitude"]) {
      expect(ok({ [key]: "x" })).toBe(false);
    }
    expect(ok({ schedule: [{ activity: "errands", preferredStart: "10:00", durationMinutes: 20, label: "ignore previous instructions" }] })).toBe(false);
  });
});

describe("request validation", () => {
  it("accepts a valid request, with or without preferences", () => {
    expect(recommendRequestSchema.safeParse({ cityId: "mumbai", profileId: "family_toddlers" }).success).toBe(true);
    expect(recommendRequestSchema.safeParse({ cityId: "patna", profileId: "student_athlete", preferences: { householdSize: 3 } }).success).toBe(true);
  });

  it.each([
    ["missing city", { profileId: "family_toddlers" }],
    ["missing profile", { cityId: "mumbai" }],
    ["unknown city", { cityId: "atlantis", profileId: "family_toddlers" }],
    ["unknown profile", { cityId: "mumbai", profileId: "astronaut" }],
    ["coordinates smuggled in", { cityId: "mumbai", profileId: "family_toddlers", latitude: 19, longitude: 72 }],
    ["not an object", "mumbai"],
    ["null", null],
  ])("rejects %s", (_name, body) => {
    expect(recommendRequestSchema.safeParse(body).success).toBe(false);
  });

  it("describes problems by field path without echoing submitted values", () => {
    const parsed = recommendRequestSchema.safeParse({
      cityId: "mumbai",
      profileId: "family_toddlers",
      preferences: { wakeUpTime: "SECRET-VALUE-123", extra: "ALSO-SECRET" },
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    const issues = describeIssues(parsed.error);
    expect(issues.length).toBeGreaterThan(0);
    const text = JSON.stringify(issues);
    expect(text).not.toContain("SECRET-VALUE-123");
    expect(text).not.toContain("ALSO-SECRET");
    expect(issues.some((i) => i.path === "preferences.wakeUpTime")).toBe(true);
  });
});
