import { describe, expect, it } from "vitest";

import { WINDOW_INDICATOR_CEILING, WINDOW_POLICY } from "@/config/advisoryThresholds";
import {
  RELATIVELY_LOWER_LABEL,
  comparePeriods,
  evaluateOutdoorWindows,
  type OutdoorWindowAnalysis,
  type WindowQuery,
} from "@/lib/engine";
import type { HourlyRecord } from "@/types/air";

import { CLEAN_FLAT, EVENING_DIP, NOW, PM25_DIPS_NO2_SOARS, RISING, SEVERE_FLAT, snapshot } from "../../fixtures/engine";
import { CURRENT_HOUR_S, HOUR } from "../../fixtures/openMeteo";

/** All forecast data here is SYNTHETIC (tests/fixtures/engine.ts). */

const forecastOf = (options = EVENING_DIP) => snapshot(options).forecastHourlyData.hours;

function analyze(overrides: Partial<WindowQuery> = {}, options = EVENING_DIP): OutdoorWindowAnalysis {
  return evaluateOutdoorWindows({
    hours: forecastOf(options),
    nowMs: NOW,
    durationMinutes: 45,
    earliestStart: "05:30",
    latestStart: "21:00",
    preferredStart: "06:00",
    intensity: "light",
    sensitive: false,
    stale: false,
    ...overrides,
  });
}

/** Forecast hours from 14:00 IST built directly, for exact-arithmetic tests. */
function makeHours(values: (hourIndex: number) => Partial<Record<"pm25" | "pm10" | "no2" | "so2" | "o3" | "co", number | null>>, count = 30): HourlyRecord[] {
  return Array.from({ length: count }, (_, i) => {
    const epochSeconds = CURRENT_HOUR_S + (i + 1) * HOUR;
    return {
      time: new Date(epochSeconds * 1000).toISOString(),
      epochSeconds,
      values: { pm25: 20, pm10: 40, no2: 10, so2: 5, o3: 20, co: 300, ...values(i) },
    };
  });
}

describe("lower-pollution window detection", () => {
  const analysis = analyze();

  it("finds the clean evening and says so with the required wording", () => {
    expect(analysis.status).toBe("recommended");
    expect(analysis.label).toBe(RELATIVELY_LOWER_LABEL);
    expect(analysis.label).toBe("Relatively lower-pollution window");
    expect(["17:30", "18:00"]).toContain(analysis.best?.startLocal);
    expect(analysis.comparison?.bestVsMedianPercent).toBeLessThanOrEqual(-WINDOW_POLICY.minRelativeImprovement * 100);
  });

  it("never describes a window as safe", () => {
    expect(JSON.stringify(analysis)).not.toMatch(/\bsafe\b/i);
  });

  it("names the responsible pollutant and shows every pollutant's contribution", () => {
    expect(["pm25", "pm10"]).toContain(analysis.best?.limitingPollutant);
    const names = analysis.best?.pollutants.map((p) => p.pollutant);
    expect(names).toEqual(expect.arrayContaining(["pm25", "pm10", "no2", "so2", "o3", "co"]));
    const limiting = analysis.best?.pollutants.find((p) => p.pollutant === analysis.best?.limitingPollutant);
    expect(limiting?.subIndex).toBe(analysis.best?.indicator);
    for (const p of analysis.best?.pollutants ?? []) expect(p.subIndex).toBeLessThanOrEqual(analysis.best?.indicator ?? 0);
  });

  it("lists non-overlapping lower windows, best first, all under the advisory ceiling", () => {
    expect(analysis.recommended.length).toBeGreaterThan(0);
    expect(analysis.recommended.length).toBeLessThanOrEqual(WINDOW_POLICY.maxListed);
    expect(analysis.recommended[0]).toEqual(analysis.best);
    for (let i = 0; i < analysis.recommended.length; i += 1) {
      const w = analysis.recommended[i];
      expect(w?.indicator).toBeLessThanOrEqual(WINDOW_INDICATOR_CEILING.general.light);
      for (let j = i + 1; j < analysis.recommended.length; j += 1) {
        const o = analysis.recommended[j];
        expect(w !== undefined && o !== undefined && (w.endMs <= o.startMs || o.endMs <= w.startMs)).toBe(true);
        expect(o?.indicator).toBeGreaterThanOrEqual(w?.indicator ?? 0);
      }
    }
  });

  it("lists the dirty early-morning hours as higher-exposure windows", () => {
    expect(analysis.higherExposure.length).toBeGreaterThan(0);
    expect((analysis.higherExposure[0]?.startLocal ?? "99") < "08:00").toBe(true);
    expect(analysis.higherExposure[0]?.indicator).toBeGreaterThan(analysis.comparison?.medianIndicator ?? Infinity);
  });

  it("compares the best window with the day's other windows and with the usual time", () => {
    const c = analysis.comparison;
    expect(c?.candidateCount).toBeGreaterThan(10);
    expect(c?.bestIndicator).toBeLessThan(c?.medianIndicator ?? 0);
    expect(c?.medianIndicator).toBeLessThan(c?.worstIndicator ?? 0);
    expect(analysis.preferred?.startLocal).toBe("06:00");
    expect(c?.preferredIndicator).toBe(analysis.preferred?.indicator);
    expect(c?.bestVsPreferredPercent).toBeLessThan(0);
    expect(analysis.alternative).not.toBeNull();
    expect(analysis.alternative?.startMs).not.toBe(analysis.best?.startMs);
  });

  it("suggests an alternative that does not overlap the best window", () => {
    const best = analysis.best;
    const alt = analysis.alternative;
    expect(best !== null && alt !== null && (alt.endMs <= best.startMs || alt.startMs >= best.endMs)).toBe(true);
  });
});

describe("forecast timestamps are respected", () => {
  const analysis = analyze();
  const stamps = new Set(forecastOf().map((h) => new Date(h.epochSeconds * 1000).getTime()));

  it("only starts windows in the future and inside the 24-hour horizon", () => {
    for (const w of [analysis.best, analysis.alternative, ...analysis.recommended, ...analysis.higherExposure]) {
      expect(w).not.toBeNull();
      expect(w?.startMs).toBeGreaterThanOrEqual(NOW);
      expect(w?.startMs).toBeLessThan(NOW + WINDOW_POLICY.horizonHours * 3_600_000);
    }
  });

  it("cites only real forecast hours, in +05:30, covering the whole window", () => {
    const best = analysis.best;
    expect(best?.forecastHours.length).toBeGreaterThanOrEqual(1);
    for (const iso of best?.forecastHours ?? []) {
      expect(iso).toMatch(/\+05:30$/);
      expect(stamps.has(new Date(iso).getTime())).toBe(true);
    }
    expect(best?.start).toMatch(/\+05:30$/);
    expect(new Date(best?.end ?? "").getTime() - new Date(best?.start ?? "").getTime()).toBe(45 * 60_000);
  });

  it("respects the activity's allowed start range", () => {
    const narrow = analyze({ earliestStart: "07:00", latestStart: "09:00" });
    for (const w of [narrow.best, narrow.alternative, ...narrow.recommended, ...narrow.higherExposure]) {
      if (w === null) continue;
      expect(w.startLocal >= "07:00" && w.startLocal <= "09:00").toBe(true);
    }
  });

  it("evaluates exactly one window for a fixed-time activity", () => {
    const fixed = analyze({ earliestStart: "18:00", latestStart: "18:00", preferredStart: "18:00" });
    expect(fixed.comparison?.candidateCount).toBe(1);
    expect(fixed.best?.startLocal).toBe("18:00");
    expect(fixed.preferred?.startLocal).toBe("18:00");
  });

  it("never reads hours before now", () => {
    const later = evaluateOutdoorWindows({ ...baseQuery(), nowMs: NOW + 6 * 3_600_000 });
    for (const w of [later.best, ...later.recommended]) expect(w === null || w.startMs >= NOW + 6 * 3_600_000).toBe(true);
  });
});

function baseQuery(): WindowQuery {
  return { hours: forecastOf(), nowMs: NOW, durationMinutes: 45, earliestStart: "05:30", latestStart: "21:00", preferredStart: "06:00", intensity: "light", sensitive: false, stale: false };
}

describe("pollution trend", () => {
  it("reports rising pollution and prefers the earliest window", () => {
    const rising = analyze({ earliestStart: "05:00", latestStart: "22:00", preferredStart: null }, RISING);
    expect(rising.trend).toBe("rising");
    expect(rising.best?.startLocal).toBe("14:00");
  });

  it("reports a falling trend when pollution declines over the next hours", () => {
    const falling = analyze({}, { values: { pm2_5: (h) => Math.max(10, 120 - Math.max(0, h) * 7), pm10: (h) => Math.max(20, 200 - Math.max(0, h) * 10) } });
    expect(falling.trend).toBe("falling");
  });

  it("compares the first and last hours of the next 12, so a dip that recovers overnight reads as rising", () => {
    // 14:00-17:00 sits on the way down to the 18:00 minimum; 22:00-01:00 is the climb back up.
    expect(analyze().trend).toBe("rising");
  });

  it("reports steady for flat air", () => {
    expect(analyze({}, CLEAN_FLAT).trend).toBe("steady");
  });
});

describe("multiple pollutants", () => {
  const analysis = analyze({}, PM25_DIPS_NO2_SOARS);

  it("does not recommend a window where PM2.5 falls but NO2 becomes much worse", () => {
    expect(analysis.best).not.toBeNull();
    const startHour = Number(analysis.best?.startLocal.slice(0, 2));
    expect(startHour >= 16 && startHour < 20).toBe(false);
  });

  it("identifies NO2 as the pollutant responsible for the worst windows", () => {
    expect(analysis.higherExposure[0]?.limitingPollutant).toBe("no2");
    const pm25 = analysis.higherExposure[0]?.pollutants.find((p) => p.pollutant === "pm25");
    const no2 = analysis.higherExposure[0]?.pollutants.find((p) => p.pollutant === "no2");
    expect(pm25?.subIndex).toBeLessThan(no2?.subIndex ?? 0);
  });
});

describe("missing pollutant data lowers confidence and is disclosed", () => {
  const complete = analyze();

  it("PM10 missing", () => {
    const a = analyze({}, { ...EVENING_DIP, omit: ["pm10"] });
    expect(a.status).not.toBe("unavailable");
    expect(a.pollutantsUsed).not.toContain("pm10");
    expect(a.pollutantsMissing).toContainEqual({ pollutant: "pm10", reason: "not-provided-for-every-hour" });
    expect(a.confidence.factors.map((f) => f.id)).toContain("pm10-missing");
    expect(a.confidence.score).toBeLessThan(complete.confidence.score);
  });

  it("a gas missing for only some hours is excluded everywhere, never treated as zero", () => {
    const a = analyze({}, { ...EVENING_DIP, values: { ...EVENING_DIP.values, nitrogen_dioxide: (h) => (h === 5 ? null : 25) } });
    expect(a.pollutantsUsed).not.toContain("no2");
    expect(a.pollutantsMissing.map((m) => m.pollutant)).toContain("no2");
    for (const w of [a.best, ...a.recommended, ...a.higherExposure]) {
      expect(w?.pollutants.map((p) => p.pollutant) ?? []).not.toContain("no2");
    }
  });

  it("always discloses NH3 and Pb as not supported by the provider", () => {
    expect(complete.pollutantsMissing).toEqual(
      expect.arrayContaining([
        { pollutant: "nh3", reason: "not-supported-by-provider" },
        { pollutant: "pb", reason: "not-supported-by-provider" },
      ]),
    );
  });

  it("more missing gases mean lower confidence", () => {
    const some = analyze({}, { ...EVENING_DIP, omit: ["ozone"] });
    const more = analyze({}, { ...EVENING_DIP, omit: ["ozone", "sulphur_dioxide", "nitrogen_dioxide"] });
    expect(some.confidence.score).toBeLessThan(complete.confidence.score);
    expect(more.confidence.score).toBeLessThan(some.confidence.score);
  });

  it("PM2.5 missing makes the result unavailable rather than guessing", () => {
    const a = analyze({}, { ...EVENING_DIP, values: { ...EVENING_DIP.values, pm2_5: (h) => (h === 3 ? null : 40) } });
    expect(a.status).toBe("unavailable");
    expect(a.unavailableReason).toBe("pm25-incomplete");
    expect(a.best).toBeNull();
    expect(a.recommended).toEqual([]);
    expect(a.confidence.level).toBe("unavailable");
  });

  it("PM2.5 omitted from the provider response is unavailable too", () => {
    const a = analyze({}, { ...EVENING_DIP, omit: ["pm2_5"] });
    expect(a.status).toBe("unavailable");
    expect(a.unavailableReason).toBe("pm25-incomplete");
  });
});

describe("missing timestamps and incomplete forecasts", () => {
  it("skips windows that would span a missing hour, rather than interpolating", () => {
    const hours = forecastOf().filter((h) => {
      const hr = new Date(h.epochSeconds * 1000 + 19_800_000).getUTCHours();
      return !(hr === 17 || hr === 18);
    });
    const a = evaluateOutdoorWindows({ ...baseQuery(), hours });
    expect(a.status).not.toBe("unavailable");
    for (const w of [a.best, a.alternative, ...a.recommended, ...a.higherExposure]) {
      expect(w !== null && w.startLocal >= "16:30" && w.startLocal < "19:00").toBe(false);
    }
    expect(a.confidence.factors.map((f) => f.id)).toContain("forecast-gaps");
  });

  it("a short forecast only offers windows it fully covers and lowers confidence", () => {
    const hours = forecastOf().slice(0, 6); // 14:00 to 20:00
    const a = evaluateOutdoorWindows({ ...baseQuery(), hours });
    expect(a.status).not.toBe("unavailable");
    for (const w of [a.best, ...a.recommended]) expect((w?.endMs ?? 0)).toBeLessThanOrEqual(NOW + 6 * 3_600_000 + 13 * 60_000);
    expect(a.confidence.factors.map((f) => f.id)).toContain("forecast-gaps");
  });

  it("is unavailable when no allowed start has complete coverage", () => {
    const hours = forecastOf().slice(0, 6);
    const a = evaluateOutdoorWindows({ ...baseQuery(), hours, earliestStart: "07:00", latestStart: "09:00" });
    expect(a.status).toBe("unavailable");
    expect(a.unavailableReason).toBe("no-complete-window");
  });

  it("is unavailable when the stored forecast is entirely in the past", () => {
    const a = evaluateOutdoorWindows({ ...baseQuery(), nowMs: NOW + 72 * 3_600_000 });
    expect(a.status).toBe("unavailable");
    expect(a.unavailableReason).toBe("no-future-hours");
  });
});

describe("no suitable window", () => {
  it("says so for severe air, listing nothing as recommended but still reporting the best available", () => {
    const a = analyze({}, SEVERE_FLAT);
    expect(a.status).toBe("no-suitable-window");
    expect(a.recommended).toEqual([]);
    expect(a.best).not.toBeNull();
    expect(a.label).toMatch(/above the engine's advisory level/);
    expect(a.label).not.toBe(RELATIVELY_LOWER_LABEL);
    expect(a.comparison?.bestIndicator).toBeGreaterThan(a.comparison?.ceiling ?? Infinity);
  });

  it("applies stricter ceilings to harder effort and to sensitive groups", () => {
    const ceilings = WINDOW_INDICATOR_CEILING;
    expect(ceilings.general.vigorous).toBeLessThan(ceilings.general.moderate);
    expect(ceilings.general.moderate).toBeLessThan(ceilings.general.light);
    for (const effort of ["light", "moderate", "vigorous"] as const) {
      expect(ceilings.sensitive[effort]).toBeLessThanOrEqual(ceilings.general[effort]);
    }
    // Flat PM2.5 of 70 ug/m3 (indicator about 130): acceptable for a general moderate effort, not for a sensitive group.
    const options = { values: { pm2_5: () => 70, pm10: () => 100 } };
    const general = analyze({ intensity: "moderate", sensitive: false }, options);
    const sensitive = analyze({ intensity: "moderate", sensitive: true }, options);
    expect(general.status).not.toBe("no-suitable-window");
    expect(sensitive.status).toBe("no-suitable-window");
    expect(analyze({ intensity: "vigorous", sensitive: false }, options).status).toBe("no-suitable-window");
  });
});

describe("a dirty usual time is worth moving even when most windows are clean", () => {
  it("compares with the usual time as well as the median", () => {
    // Clean from 07:00 to 09:59 and dirty otherwise: with a 05:30-09:00 range most candidates are clean,
    // so the median is clean too, yet the usual 06:00 start is dirty.
    const options = { values: { pm2_5: (_h: number, t: number) => { const hr = ((((t + 19_800) % 86_400) + 86_400) % 86_400) / 3600; return hr >= 7 && hr < 10 ? 20 : 90; }, pm10: (_h: number, t: number) => { const hr = ((((t + 19_800) % 86_400) + 86_400) % 86_400) / 3600; return hr >= 7 && hr < 10 ? 36 : 162; }, nitrogen_dioxide: () => 10, sulphur_dioxide: () => 5, ozone: () => 20, carbon_monoxide: () => 300 } };
    const a = analyze({ earliestStart: "05:30", latestStart: "09:00", preferredStart: "06:00" }, options);
    expect(a.comparison?.bestVsMedianPercent).toBeGreaterThan(-15);
    expect(a.comparison?.bestVsPreferredPercent).toBeLessThan(-15);
    expect(a.status).toBe("recommended");
    expect(a.recommended.length).toBeGreaterThan(0);
  });

  it("without a usual time the median alone decides", () => {
    const a = analyze({ earliestStart: "05:30", latestStart: "09:00", preferredStart: null }, { values: { pm2_5: () => 20, pm10: () => 36 } });
    expect(a.status).toBe("no-meaningful-difference");
  });
});

describe("no meaningful difference", () => {
  it("does not invent a better time when the air is flat", () => {
    const a = analyze({}, CLEAN_FLAT);
    expect(a.status).toBe("no-meaningful-difference");
    expect(a.recommended).toEqual([]);
    expect(a.label).not.toBe(RELATIVELY_LOWER_LABEL);
    expect(a.best).not.toBeNull();
  });
});

describe("no forecast available", () => {
  it("returns an explicit unavailable state and invents no time", () => {
    const a = evaluateOutdoorWindows({ ...baseQuery(), hours: [] });
    expect(a).toMatchObject({ status: "unavailable", unavailableReason: "no-forecast", best: null, alternative: null, preferred: null, comparison: null, trend: "unknown" });
    expect(a.recommended).toEqual([]);
    expect(a.higherExposure).toEqual([]);
    expect(a.confidence.level).toBe("unavailable");
  });
});

describe("confidence", () => {
  it("is lower for stale data", () => {
    expect(analyze({ stale: true }).confidence.score).toBeLessThan(analyze().confidence.score);
    expect(analyze({ stale: true }).confidence.factors.map((f) => f.id)).toContain("stale-data");
  });

  it("is lower for windows further ahead", () => {
    const soon = analyze({ earliestStart: "14:00", latestStart: "14:30", preferredStart: null });
    const far = analyze({ earliestStart: "05:00", latestStart: "07:00", preferredStart: null });
    expect(far.confidence.score).toBeLessThan(soon.confidence.score);
  });

  it("always notes that values are model estimates", () => {
    expect(analyze().confidence.factors.map((f) => f.id)).toContain("model-data");
  });
});

describe("window arithmetic", () => {
  it("takes a time-weighted mean across hour boundaries", () => {
    // Hours alternate 10 and 30 ug/m3; a 60-minute window starting at HH:30 spans half of each hour.
    const hours = makeHours((i) => ({ pm25: i % 2 === 0 ? 10 : 30 }));
    const a = evaluateOutdoorWindows({ hours, nowMs: NOW, durationMinutes: 60, earliestStart: "14:30", latestStart: "14:30", preferredStart: "14:30", intensity: "light", sensitive: false, stale: false });
    expect(a.best?.startLocal).toBe("14:30");
    expect(a.best?.pm25MeanUgM3).toBe(20);
    expect(a.best?.forecastHours).toHaveLength(2);
  });

  it("lets the worst pollutant govern the indicator", () => {
    const hours = makeHours(() => ({ pm25: 20, pm10: 300 }));
    const a = evaluateOutdoorWindows({ hours, nowMs: NOW, durationMinutes: 30, earliestStart: "15:00", latestStart: "15:00", preferredStart: "15:00", intensity: "light", sensitive: false, stale: false });
    expect(a.best?.limitingPollutant).toBe("pm10");
  });

  it("is deterministic", () => {
    expect(analyze()).toEqual(analyze());
  });
});

describe("morning, afternoon and evening comparison", () => {
  it("ranks the parts of the day for the evening-dip forecast", () => {
    const c = comparePeriods(forecastOf(), NOW);
    expect(c.status).toBe("available");
    expect(c.periods.map((p) => p.period)).toEqual(["morning", "afternoon", "evening"]);
    expect(c.lowestPeriod).toBe("evening");
    expect(c.highestPeriod).toBe("morning");
    const [morning, , evening] = c.periods;
    expect(morning?.indicator).toBeGreaterThan(evening?.indicator ?? Infinity);
    expect(morning?.pm25MeanUgM3).toBeGreaterThan(evening?.pm25MeanUgM3 ?? Infinity);
    expect(morning?.label).toBe("Morning 05:00 to 11:00");
    for (const p of c.periods) for (const iso of p.forecastHours) expect(iso).toMatch(/\+05:30$/);
  });

  it("leaves a period unavailable when less than half of it is covered", () => {
    const c = comparePeriods(forecastOf().slice(0, 5), NOW); // 14:00 to 19:00
    const morning = c.periods.find((p) => p.period === "morning");
    expect(morning?.indicator).toBeNull();
    expect(morning?.forecastHours).toEqual([]);
    expect(c.lowestPeriod).not.toBe("morning");
  });

  it("is unavailable without a forecast or without PM2.5", () => {
    expect(comparePeriods([], NOW).status).toBe("unavailable");
    const noPm25 = comparePeriods(snapshot({ ...EVENING_DIP, omit: ["pm2_5"] }).forecastHourlyData.hours, NOW);
    expect(noPm25.status).toBe("unavailable");
    expect(noPm25.lowestPeriod).toBeNull();
  });
});
