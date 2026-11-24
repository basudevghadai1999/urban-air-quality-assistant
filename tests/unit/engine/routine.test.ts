import { describe, expect, it } from "vitest";

import {
  ACTIVITY_INTENSITY,
  ACTIVITY_LABELS,
  buildRoutine,
  resolveProfile,
  resolveReferences,
  type ProfileId,
  type ResolvedPreferences,
  type RoutineItem,
  type ScheduleItem,
  type SeverityLevel,
} from "@/lib/engine";
import { ACTIVITY_KINDS } from "@/lib/engine/types";
import type { HourlyRecord } from "@/types/air";

import { CLEAN_FLAT, EVENING_DIP, HIGH_DIP, MORNING_DIP, NOW, SEVERE_FLAT, snapshot } from "../../fixtures/engine";
import type { FixtureOptions } from "../../fixtures/openMeteo";

/** All forecast data is SYNTHETIC (tests/fixtures/engine.ts). */

const sched = (id: string, activity: ScheduleItem["activity"], preferredStart: string, durationMinutes: number, earliestStart = preferredStart, latestStart = preferredStart): ScheduleItem => ({
  id,
  activity,
  preferredStart,
  durationMinutes,
  earliestStart,
  latestStart,
});

function routine(
  profileId: ProfileId,
  options: { fixture?: FixtureOptions; hours?: readonly HourlyRecord[]; schedule?: readonly ScheduleItem[]; overrides?: Partial<ResolvedPreferences>; severity?: SeverityLevel; stale?: boolean; dataAvailable?: boolean } = {},
) {
  const resolved = resolveProfile(profileId);
  if (!resolved.ok) throw new Error("preset must resolve");
  const hours = options.hours ?? snapshot(options.fixture ?? EVENING_DIP).forecastHourlyData.hours;
  return buildRoutine({
    preset: resolved.preset,
    preferences: { ...resolved.preferences, ...(options.schedule === undefined ? {} : { schedule: options.schedule }), ...options.overrides },
    nowMs: NOW,
    forecastHours: hours,
    severity: options.severity ?? "moderate",
    stale: options.stale ?? false,
    dataAvailable: options.dataAvailable ?? true,
    aqiRef: { kind: "aqi", ref: "t", detail: "Estimated Indian AQI (synthetic)" },
  });
}

const item = (r: ReturnType<typeof routine>, id: string): RoutineItem => {
  const found = r.section.items.find((i) => i.id === id);
  if (found === undefined) throw new Error(`no routine item ${id}`);
  return found;
};

describe("every profile gets a complete routine", () => {
  it.each(["family_toddlers", "senior_respiratory", "two_wheeler_commuter", "student_athlete"] as const)("%s", (id) => {
    const r = routine(id, { fixture: MORNING_DIP });
    const resolved = resolveProfile(id);
    expect(resolved.ok && r.section.items.map((i) => i.id)).toEqual(resolved.ok ? resolved.preferences.schedule.map((s) => s.id) : []);
    for (const i of r.section.items) {
      expect(i.label).toBe(ACTIVITY_LABELS[i.activity]);
      expect(i.intensity).toBe(ACTIVITY_INTENSITY[i.activity]);
      expect(["lower", "higher", "unknown"]).toContain(i.exposureDirection);
      expect(i.reason.length).toBeGreaterThan(20);
      expect(i.confidence.level).toMatch(/high|medium|low/);
      expect(Array.isArray(i.instructions)).toBe(true);
      expect(i.explanation.triggeredBy.length).toBeGreaterThan(0);
      expect(i.explanation.ruleIds).toEqual(expect.arrayContaining(["RULE_WINDOW_COMPARISON", "RULE_NEVER_CALL_SAFE"]));
    }
    expect(resolveReferences([...r.section.items.map((i) => i.explanation), ...(r.section.tripChaining.explanation ? [r.section.tripChaining.explanation] : [])]).unknownIds).toEqual([]);
  });

  it("maps every activity kind to an intensity and a label", () => {
    for (const kind of ACTIVITY_KINDS) {
      expect(ACTIVITY_LABELS[kind].length).toBeGreaterThan(3);
      expect(["light", "moderate", "vigorous"]).toContain(ACTIVITY_INTENSITY[kind]);
    }
    expect(ACTIVITY_INTENSITY.outdoor_sports).toBe("vigorous");
    expect(ACTIVITY_INTENSITY.morning_walk).toBe("light");
  });

  it("is deterministic", () => {
    expect(routine("senior_respiratory", { fixture: MORNING_DIP })).toEqual(routine("senior_respiratory", { fixture: MORNING_DIP }));
  });
});

describe("moving an activity into a lower-pollution window", () => {
  const r = routine("senior_respiratory", { fixture: MORNING_DIP });
  const walk = item(r, "morning_walk-1");

  it("suggests the clean spell, with an alternative, instead of the usual dirty hour", () => {
    expect(walk.windowStatus).toBe("recommended");
    expect(walk.windowLabel).toBe("Relatively lower-pollution window");
    expect(walk.timing).toBe("flexible");
    expect(walk.usualStartLocal).toBe("06:00");
    const start = walk.suggestedTime?.startLocal ?? "";
    expect(start >= "07:00" && start <= "08:15").toBe(true);
    expect(walk.suggestedTime?.endLocal).toBeDefined();
    expect(walk.alternativeTime).not.toBeNull();
    expect(walk.alternativeTime?.startLocal).not.toBe(walk.suggestedTime?.startLocal);
  });

  it("reports lower exposure, the pollutant and supporting forecast timestamps", () => {
    expect(walk.exposureDirection).toBe("lower");
    expect(["pm25", "pm10"]).toContain(walk.pollutant);
    expect(walk.changeVsUsualPercent).toBeLessThan(0);
    expect(walk.supportingForecastTimestamps.length).toBeGreaterThanOrEqual(1);
    for (const ts of walk.supportingForecastTimestamps) expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/);
  });

  it("explains the reason with the numbers behind it", () => {
    expect(walk.reason).toMatch(/Forecast PM2\.5 averages about 20 ug\/m3/);
    expect(walk.reason).toMatch(/against about 90 ug\/m3 at your usual 06:00/);
    expect(walk.reason).toMatch(/% below your usual time/);
    expect(walk.reason).toMatch(/pollutant that sets the comparison/);
    expect(walk.explanation.impact).toMatch(/lower than at your usual time/);
    expect(walk.explanation.impact).toMatch(/model-based/);
  });

  it("gives practical instructions including the start time and a medical-advice disclaimer for sensitive profiles", () => {
    expect(walk.instructions[0]).toMatch(/^Plan to start at \d{2}:\d{2}/);
    expect(walk.instructions.join(" ")).toMatch(/doctor's guidance/);
    expect(walk.instructions.join(" ")).toMatch(/does not give medical advice/);
    expect(walk.indoorAlternative).toMatch(/indoors/);
  });
});

describe("fixed-time activities are not moved", () => {
  const r = routine("two_wheeler_commuter", { fixture: MORNING_DIP, schedule: [sched("office_commute-1", "office_commute", "08:00", 40)] });
  const commute = item(r, "office_commute-1");

  it("keeps the usual time and says the start is fixed", () => {
    expect(commute.timing).toBe("fixed");
    expect(commute.suggestedTime?.startLocal).toBe("08:00");
    expect(commute.alternativeTime).toBeNull();
    expect(commute.reason).toMatch(/fixed start/);
  });

  it("still puts the fixed slot in context against the rest of the waking day", () => {
    expect(["lower", "higher", "unknown"]).toContain(commute.exposureDirection);
    // 08:00-08:40 lies inside the synthetic clean spell, so it is lower than the day's typical window.
    expect(commute.exposureDirection).toBe("lower");
    const dirty = routine("two_wheeler_commuter", { fixture: MORNING_DIP, schedule: [sched("office_commute-1", "office_commute", "13:00", 40)] });
    expect(item(dirty, "office_commute-1").exposureDirection).not.toBe("lower");
  });
});

describe("no suitable window", () => {
  it("an optional outdoor activity is not scheduled; the indoor alternative is offered instead", () => {
    const r = routine("student_athlete", { fixture: HIGH_DIP, schedule: [sched("outdoor_sports-1", "outdoor_sports", "06:30", 60, "05:30", "20:00")] });
    const sport = item(r, "outdoor_sports-1");
    expect(sport.windowStatus).toBe("no-suitable-window");
    expect(sport.suggestedTime).toBeNull();
    expect(sport.alternativeTime).toBeNull();
    expect(sport.exposureDirection).toBe("unknown");
    expect(sport.indoorAlternative).toMatch(/indoor/);
    expect(sport.reason).toMatch(/advisory policy, not a medical threshold/);
    expect(sport.instructions.join(" ")).toMatch(/Prefer the indoor alternative/);
  });

  it("an essential commute still gets the lowest-pollution start, with the caveat spelled out", () => {
    const r = routine("two_wheeler_commuter", { fixture: HIGH_DIP, schedule: [sched("office_commute-1", "office_commute", "08:00", 40, "06:00", "18:00")] });
    const commute = item(r, "office_commute-1");
    expect(commute.windowStatus).toBe("no-suitable-window");
    expect(commute.suggestedTime).not.toBeNull();
    expect(["17:00", "17:30", "18:00"]).toContain(commute.suggestedTime?.startLocal);
    expect(commute.reason).toMatch(/hard to skip/);
    expect(commute.reason).toMatch(/not a statement that the air is acceptable/);
    expect(commute.instructions.join(" ")).toMatch(/only the lowest available/);
  });

  it("an essential commute is left alone when no start is meaningfully lower", () => {
    const r = routine("two_wheeler_commuter", { fixture: SEVERE_FLAT, schedule: [sched("office_commute-1", "office_commute", "08:00", 40, "06:00", "18:00")] });
    expect(item(r, "office_commute-1").suggestedTime).toBeNull();
  });

  it("a flat dip is not an invitation: vigorous sport on hazy air is not scheduled even when a window is lowest", () => {
    const r = routine("student_athlete", { fixture: HIGH_DIP });
    const sports = item(r, "outdoor_sports-1");
    expect(sports.suggestedTime).toBeNull();
    expect(sports.explanation.ruleIds).toContain("RULE_DIP_IS_NOT_AN_INVITATION");
  });
});

describe("no meaningful difference", () => {
  const r = routine("senior_respiratory", { fixture: CLEAN_FLAT });
  const walk = item(r, "morning_walk-1");

  it("keeps the usual time and says timing makes little difference", () => {
    expect(walk.windowStatus).toBe("no-meaningful-difference");
    expect(walk.suggestedTime?.startLocal).toBe("06:00");
    expect(walk.alternativeTime).toBeNull();
    expect(walk.exposureDirection).toBe("unknown");
    expect(walk.reason).toMatch(/Timing makes little difference today/);
    expect(walk.changeVsUsualPercent).toBeNull();
  });
});

describe("unavailable data", () => {
  it("returns an explicit unavailable state for every item and invents no time", () => {
    const r = routine("family_toddlers", { hours: [], severity: "unknown", dataAvailable: false });
    expect(r.section.status).toBe("unavailable");
    for (const i of r.section.items) {
      expect(i.windowStatus).toBe("unavailable");
      expect(i.suggestedTime).toBeNull();
      expect(i.alternativeTime).toBeNull();
      expect(i.supportingForecastTimestamps).toEqual([]);
      expect(i.pollutant).toBeNull();
      expect(i.exposureDirection).toBe("unknown");
      expect(i.confidence.level).toBe("unavailable");
      expect(i.reason).toMatch(/Keep your usual time/);
      expect(i.explanation.impact).toBeNull();
    }
    expect(r.section.tripChaining.suggestedTime).toBeNull();
  });

  it("reports 'partial' when only some activities can be compared", () => {
    const short = snapshot(MORNING_DIP).forecastHourlyData.hours.slice(0, 8); // 14:00 to 22:00
    const r = routine("senior_respiratory", { hours: short });
    const statuses = new Set(r.section.items.map((i) => i.windowStatus));
    expect(statuses.has("unavailable")).toBe(true);
    expect(r.section.status).toBe("partial");
  });

  it("stale data is flagged through lower confidence", () => {
    const fresh = routine("senior_respiratory", { fixture: MORNING_DIP });
    const stale = routine("senior_respiratory", { fixture: MORNING_DIP, stale: true });
    expect(item(stale, "morning_walk-1").confidence.score).toBeLessThan(item(fresh, "morning_walk-1").confidence.score);
  });
});

describe("trip chaining", () => {
  it("combines errand-type activities into one journey within their overlapping allowed times", () => {
    const r = routine("family_toddlers", { fixture: EVENING_DIP });
    const chain = r.section.tripChaining;
    expect(chain.status).toBe("suggested");
    expect(chain.activityIds).toEqual(["grocery_shopping-1", "errands-1"]);
    expect(chain.combinedDurationMinutes).toBe(100);
    expect(chain.journeysSaved).toBe(1);
    expect(chain.suggestedTime).not.toBeNull();
    // Overlap of grocery (10:00-19:30) and errands (10:00-17:00).
    expect((chain.suggestedTime?.startLocal ?? "") >= "10:00" && (chain.suggestedTime?.startLocal ?? "99") <= "17:00").toBe(true);
    expect(chain.reason).toMatch(/2 errands can be done in one journey/);
    expect(chain.instructions.length).toBeGreaterThanOrEqual(2);
    expect(chain.explanation?.ruleIds).toContain("RULE_TRIP_CHAINING");
    expect(r.chainAnalysis).not.toBeNull();
  });

  it("never claims CO2 or exposure savings for chaining, because errand distances are unknown", () => {
    const chain = routine("family_toddlers", { fixture: MORNING_DIP }).section.tripChaining;
    expect(chain.co2.status).toBe("unavailable");
    expect(chain.co2.reason).toMatch(/No errand distances are known/);
    expect(chain.explanation?.impact).toMatch(/no CO2 or exposure figure is claimed/);
    expect(JSON.stringify(chain)).not.toMatch(/grams|g CO2|kg CO2/);
    expect(chain.explanation?.assumptionIds).toContain("ASM_NO_CHAINING_CO2");
  });

  it("is not applicable with fewer than two errand-type activities", () => {
    const chain = routine("student_athlete", { fixture: MORNING_DIP }).section.tripChaining;
    expect(chain.status).toBe("not-applicable");
    expect(chain.suggestedTime).toBeNull();
    expect(chain.reason).toMatch(/at least two errand-type activities/);
  });

  it("is unavailable when the errands' allowed times do not overlap", () => {
    const r = routine("family_toddlers", {
      fixture: MORNING_DIP,
      schedule: [sched("grocery_shopping-1", "grocery_shopping", "07:00", 30, "06:00", "08:00"), sched("errands-1", "errands", "20:00", 30, "19:00", "21:00")],
    });
    expect(r.section.tripChaining.status).toBe("unavailable");
    expect(r.section.tripChaining.reason).toMatch(/do not overlap/);
  });

  it("is unavailable when the combined journey would run past midnight", () => {
    const r = routine("family_toddlers", {
      fixture: MORNING_DIP,
      schedule: [sched("grocery_shopping-1", "grocery_shopping", "22:30", 60, "22:30", "22:30"), sched("errands-1", "errands", "22:30", 60, "22:30", "22:30")],
    });
    expect(r.section.tripChaining.status).toBe("unavailable");
    expect(r.section.tripChaining.reason).toMatch(/past midnight/);
  });

  it("when every window exceeds the advisory level, still reports the saving but suggests no time", () => {
    const chain = routine("family_toddlers", { fixture: HIGH_DIP }).section.tripChaining;
    expect(chain.status).toBe("suggested");
    expect(chain.suggestedTime).toBeNull();
    expect(chain.windowStatus).toBe("no-suitable-window");
    expect(chain.reason).toMatch(/above the engine's advisory level/);
    expect(chain.reason).toMatch(/Postpone non-urgent errands/);
  });

  it("suggests no time when the forecast cannot place the journey, but still reports the saving", () => {
    const r = routine("family_toddlers", { hours: [] });
    expect(r.section.tripChaining.status).toBe("suggested");
    expect(r.section.tripChaining.suggestedTime).toBeNull();
    expect(r.section.tripChaining.reason).toMatch(/no forecast window with complete coverage/);
  });
});

describe("instructions", () => {
  it("mentions a respirator only for open two-wheeler commutes on elevated days, and stresses fit", () => {
    const text = (severity: SeverityLevel, transport: ResolvedPreferences["preferredTransport"]) =>
      item(routine("two_wheeler_commuter", { fixture: MORNING_DIP, severity, overrides: { preferredTransport: transport } }), "office_commute-1").instructions.join(" ");
    expect(text("high", "two_wheeler")).toMatch(/certified particulate respirator/);
    expect(text("high", "two_wheeler")).toMatch(/only if it seals properly/);
    expect(text("moderate", "two_wheeler")).toMatch(/respirator/);
    expect(text("low", "two_wheeler")).not.toMatch(/respirator/);
    expect(text("high", "private_car")).not.toMatch(/respirator/);
  });

  it("warns that a temporary dip is not a reason to train hard outdoors", () => {
    const sports = item(routine("student_athlete", { fixture: MORNING_DIP }), "outdoor_sports-1");
    expect(sports.instructions.join(" ")).toMatch(/not a reason to train hard outdoors/);
  });

  it("points errands towards trip chaining", () => {
    expect(item(routine("family_toddlers", { fixture: MORNING_DIP }), "errands-1").instructions.join(" ")).toMatch(/trip-chaining/);
  });

  it("gives school-run guidance for the family profile", () => {
    expect(item(routine("family_toddlers", { fixture: MORNING_DIP }), "school_commute-1").instructions.join(" ")).toMatch(/avoid idling near the school entrance/);
  });

  it("never calls any time or level safe", () => {
    const text = JSON.stringify(routine("senior_respiratory", { fixture: MORNING_DIP }).section);
    expect(text).not.toMatch(/\b(is|are|be|as|stay) safe\b|safe (window|level|air|to)\b/i);
  });
});
