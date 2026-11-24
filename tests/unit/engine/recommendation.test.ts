import { describe, expect, it } from "vitest";

import { AIR_DATA_DISCLAIMER } from "@/lib/constants";
import {
  ENGINE_VERSION,
  LIMITATIONS,
  PROFILE_PRESETS,
  generateRecommendations,
  resolveReferences,
  type Explanation,
  type RecommendationResult,
  type ProfileId,
} from "@/lib/engine";
import { PROFILE_IDS } from "@/lib/engine/types";
import type { NormalizedAirData } from "@/types/air";

import { CLEAN_FLAT, EVENING_DIP, HIGH_DIP, MORNING_DIP, NOW, SEVERE_FLAT, snapshot, stale, unavailable } from "../../fixtures/engine";

/** All air data is SYNTHETIC (tests/fixtures/engine.ts), built through the real mapper and CPCB engine. */

function run(profileId: ProfileId | string, air: NormalizedAirData, preferences?: unknown, nowMs = NOW): RecommendationResult {
  const out = generateRecommendations({ air, profileId, preferences, nowMs });
  if (!out.ok) throw new Error(`unexpected failure: ${out.reason}`);
  return out.result;
}

/** Every object in the result that looks like an Explanation. */
function explanationsIn(value: unknown, found: Explanation[] = []): Explanation[] {
  if (Array.isArray(value)) for (const v of value) explanationsIn(v, found);
  else if (typeof value === "object" && value !== null) {
    const rec = value as Record<string, unknown>;
    if ("assumptionIds" in rec && "ruleIds" in rec && "triggeredBy" in rec && "what" in rec) found.push(value as Explanation);
    else for (const v of Object.values(rec)) explanationsIn(v, found);
  }
  return found;
}

describe("failure outcomes", () => {
  it("rejects an unknown profile and invalid preferences without throwing", () => {
    const air = snapshot();
    expect(generateRecommendations({ air, profileId: "nobody", nowMs: NOW })).toEqual({ ok: false, reason: "unknown-profile" });
    expect(generateRecommendations({ air, profileId: "family_toddlers", preferences: { wakeUpTime: "x" }, nowMs: NOW })).toEqual({ ok: false, reason: "invalid-preferences" });
  });
});

describe.each(PROFILE_IDS)("%s: the full result contract", (profileId) => {
  const air = snapshot(MORNING_DIP);
  const r = run(profileId, air);

  it("carries every section the contract promises", () => {
    expect(r.schemaVersion).toBe(1);
    expect(r.status).toBe("ok");
    expect(r.profileId).toBe(profileId);
    expect(r.cityId).toBe("delhi-ncr");
    expect(r.cityName).toBe(air.cityName);
    expect(r.generatedAt).toBe(new Date(NOW).toISOString());
    for (const key of ["profile", "dataFreshness", "aqiContext", "routine", "outdoorWindows", "indoor", "transport", "exposure", "emissions", "prioritized", "assumptions", "rules", "warnings", "confidence", "limitations", "provenance"] as const) {
      expect(r).toHaveProperty(key);
    }
    expect(r.profile.label).toBe(PROFILE_PRESETS[profileId].label);
    expect(r.profile.overriddenPreferences).toEqual([]);
    expect(r.routine.items.length).toBe(PROFILE_PRESETS[profileId].defaults.schedule.length);
    expect(r.indoor.interventions.length).toBeGreaterThan(5);
    expect(r.transport.options).toHaveLength(7);
    expect(r.limitations).toEqual(LIMITATIONS);
  });

  it("reports the data's freshness and AQI context from the real air data", () => {
    expect(r.dataFreshness).toMatchObject({ status: "fresh", fetchedAt: air.fetchedAt, ageSeconds: air.ageSeconds, dataTimestamp: air.dataTimestamp });
    expect(r.dataFreshness.forecastRangeStart).toBe(air.forecastHourlyData.rangeStart);
    expect(r.aqiContext.aqi).toBe(air.calculatedAqi?.aqi);
    expect(r.aqiContext.categoryLabel).toBe(air.calculatedAqi?.category?.label);
    expect(r.aqiContext.dominantPollutant).toBe(air.calculatedAqi?.dominantPollutant);
    expect(r.aqiContext.provenanceLabel).toBe(air.calculatedAqi?.provenanceLabel);
    expect(r.aqiContext.latestPm25UgM3).not.toBeNull();
  });

  it("keeps provenance, attribution and the not-an-official-reading disclaimer", () => {
    expect(r.provenance.airDataSource.id).toBe("open-meteo-air-quality");
    expect(r.provenance.attribution).toMatch(/Open-Meteo\.com/);
    expect(r.provenance.attribution).toMatch(/Copernicus/);
    expect(r.provenance.disclaimer).toBe(AIR_DATA_DISCLAIMER);
    expect(r.provenance.dataLocation).toBe(air.dataLocation);
    expect(r.provenance.engine).toEqual({ version: ENGINE_VERSION, deterministic: true, llmUsed: false, networkUsed: false });
    expect(r.warnings.map((w) => w.code)).toContain("ESTIMATES_NOT_MEASUREMENTS");
  });

  it("makes every recommendation traceable: each ID resolves, each explanation names data, rules and confidence", () => {
    const explanations = explanationsIn(r);
    expect(explanations.length).toBeGreaterThan(15);
    const refs = resolveReferences(explanations);
    expect(refs.unknownIds).toEqual([]);
    const listedAssumptions = new Set(r.assumptions.map((a) => a.id));
    const listedRules = new Set(r.rules.map((x) => x.id));
    for (const e of explanations) {
      expect(e.what).not.toBe("");
      for (const id of e.assumptionIds) expect(listedAssumptions.has(id)).toBe(true);
      for (const id of e.ruleIds) expect(listedRules.has(id)).toBe(true);
      expect(["high", "medium", "low", "unavailable"]).toContain(e.confidence.level);
    }
    for (const a of r.assumptions) {
      expect(a.statement.length).toBeGreaterThan(20);
      expect(["sourced", "engine-policy", "preset-default"]).toContain(a.kind);
      if (a.kind === "sourced") expect(a.url).toMatch(/^https:\/\//);
    }
    // Everything with a recommendation behind it cites a rule or a data reference.
    for (const item of r.routine.items) expect(item.explanation.triggeredBy.some((t) => t.kind === "rule" || t.kind === "aqi" || t.kind === "forecast-window")).toBe(true);
    for (const iv of r.indoor.interventions) expect(iv.explanation.ruleIds.length).toBeGreaterThan(0);
    for (const o of r.transport.options) expect(o.explanation.assumptionIds.length).toBeGreaterThan(0);
  });

  it("ranks everything with a documented score and a breakdown", () => {
    expect(r.prioritized.length).toBeGreaterThan(8);
    const kinds = new Set(r.prioritized.map((p) => p.kind));
    expect(kinds.has("routine")).toBe(true);
    expect(kinds.has("indoor")).toBe(true);
    const order = { high: 0, recommended: 1, optional: 2 } as const;
    for (let i = 1; i < r.prioritized.length; i += 1) {
      const a = r.prioritized[i - 1];
      const b = r.prioritized[i];
      expect(a !== undefined && b !== undefined && (order[a.tier] < order[b.tier] || (order[a.tier] === order[b.tier] && a.score >= b.score))).toBe(true);
    }
    for (const p of r.prioritized) {
      expect(p.score).toBeGreaterThanOrEqual(0);
      expect(p.score).toBeLessThanOrEqual(1);
      expect(Object.keys(p.breakdown)).toEqual(["severity", "vulnerability", "exposureReduction", "feasibility", "cost", "confidence"]);
    }
    expect(r.rules.map((x) => x.id)).toContain("RULE_PRIORITY_SCORE");
  });

  it("warns about presets, missing sensors and route data, and never claims safety", () => {
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toContain("PRESET_DISTANCE_ASSUMED");
    expect(codes).toContain("NO_INDOOR_SENSOR");
    expect(codes).toContain("EMISSION_FACTOR_UNAVAILABLE");
    if (r.profile.preferences.schedule.some((s) => s.activity.endsWith("commute"))) expect(codes).toContain("NO_ROUTE_DATA");
    // The registries state the rule 'nothing is described as safe', so scan everything else.
    const { assumptions: _a, rules: _r, ...claims } = r;
    void _a;
    void _r;
    expect(JSON.stringify(claims)).not.toMatch(/\b(is|are|be|as|stay) safe\b|safe (window|level|air|to)\b/i);
  });

  it("is deterministic and does not mutate its input", () => {
    const before = structuredClone(air);
    const again = run(profileId, air);
    expect(again).toEqual(r);
    expect(JSON.stringify(again)).toBe(JSON.stringify(r));
    expect(air).toEqual(before);
  });
});

describe("all four profiles evaluated on the same city and forecast", () => {
  const air = snapshot(MORNING_DIP);
  const results = PROFILE_IDS.map((id) => run(id, air));

  it("share identical air context, freshness and forecast range, so differences come only from the profile", () => {
    const [first, ...rest] = results;
    for (const r of rest) {
      expect(r.aqiContext).toEqual(first?.aqiContext);
      expect(r.dataFreshness).toEqual(first?.dataFreshness);
      expect(r.cityId).toBe(first?.cityId);
      expect(r.outdoorWindows.periods).toEqual(first?.outdoorWindows.periods);
    }
  });

  it("differ in what they recommend", () => {
    expect(new Set(results.map((r) => r.routine.items.map((i) => i.activity).join())).size).toBe(4);
    expect(results.find((r) => r.profileId === "family_toddlers")?.indoor.interventions.some((i) => i.id === "IND_CHILD_AREA_AWAY_FROM_SOURCES")).toBe(true);
    expect(results.find((r) => r.profileId === "two_wheeler_commuter")?.transport.baselineMode).toBe("two_wheeler");
  });

  it("every profile works with no input beyond the profile ID", () => {
    for (const r of results) expect(r.status).toBe("ok");
  });
});

describe("exposure estimates", () => {
  it("quantifies moving a walk into the clean spell, with formula, inputs, units and uncertainty", () => {
    const r = run("senior_respiratory", snapshot(MORNING_DIP));
    const shift = r.exposure.items.find((e) => e.id === "EXP_SHIFT_morning_walk-1");
    expect(shift?.estimate.status).toBe("available");
    expect(shift?.estimate.difference?.direction).toBe("reduction");
    expect(shift?.estimate.difference?.magnitudeUg).toBeGreaterThan(0);
    expect(shift?.estimate.baseline?.pm25UgM3).toBe(90);
    expect(shift?.estimate.alternative?.pm25UgM3).toBe(20);
    expect(shift?.estimate.formula).toMatch(/C \(ug\/m3\) x BR \(m3\/hour\) x t \(hours\)/);
    expect(shift?.estimate.uncertainty).toMatch(/not a measured dose/);
    expect(shift?.estimate.dataSource).toMatch(/Open-Meteo Air Quality API/);
    expect(shift?.explanation.ruleIds).toContain("RULE_TIMING_SHIFT_EXPOSURE");
    expect(shift?.explanation.assumptionIds).toEqual(expect.arrayContaining(["ASM_BREATHING_RATES_EPA", "ASM_AMBIENT_NOT_PERSONAL"]));
    // 45 minutes at the light-effort rate for ages 61-<71: 90 vs 20 ug/m3.
    expect(shift?.estimate.baseline?.inhaledMassUg).toBe(48.6);
    expect(shift?.estimate.alternative?.inhaledMassUg).toBe(10.8);
    expect(r.exposure.note).toMatch(/not measured doses/);
  });

  it("uses the age band the user chose instead of the preset's, and stops listing the preset-age assumption", () => {
    const preset = run("senior_respiratory", snapshot(MORNING_DIP));
    const chosen = run("senior_respiratory", snapshot(MORNING_DIP), { ageGroup: "71-<81" });
    const presetShift = preset.exposure.items.find((e) => e.id === "EXP_SHIFT_morning_walk-1");
    const chosenShift = chosen.exposure.items.find((e) => e.id === "EXP_SHIFT_morning_walk-1");
    expect(presetShift?.explanation.assumptionIds).toContain("ASM_PRESET_AGE_GROUP");
    expect(chosenShift?.explanation.assumptionIds).not.toContain("ASM_PRESET_AGE_GROUP");
    expect(chosenShift?.estimate.baseline?.breathingRateM3PerHour).toBe(0.72);
  });

  it("gives a respirator benefit only as a best-case ceiling, and only on elevated days", () => {
    const r = run("two_wheeler_commuter", snapshot(MORNING_DIP), { schedule: [{ activity: "office_commute", preferredStart: "08:00", durationMinutes: 40, earliestStart: "06:00", latestStart: "10:00" }] });
    expect(r.aqiContext.severity).not.toBe("low");
    const respirator = r.exposure.items.find((e) => e.id.startsWith("EXP_RESPIRATOR_"));
    expect(respirator?.estimate.bestCase).toBe(true);
    expect(respirator?.estimate.alternative?.protectionFraction).toBe(0.9);
    expect(respirator?.explanation.assumptionIds).toContain("ASM_RESPIRATOR_BEST_CASE");
    expect(respirator?.explanation.impact).toMatch(/best case/);
    expect(respirator?.explanation.impact).toMatch(/can be far smaller/);
    const clean = run("two_wheeler_commuter", snapshot(CLEAN_FLAT));
    expect(clean.exposure.items.some((e) => e.id.startsWith("EXP_RESPIRATOR_"))).toBe(false);
    const car = run("two_wheeler_commuter", snapshot(MORNING_DIP), { preferredTransport: "private_car" });
    expect(car.exposure.items.some((e) => e.id.startsWith("EXP_RESPIRATOR_"))).toBe(false);
  });

  it("an indoor alternative is unavailable without an indoor concentration, and quantified with a user-reported one", () => {
    const without = run("student_athlete", snapshot(HIGH_DIP));
    const missing = without.exposure.items.find((e) => e.id === "EXP_INDOOR_outdoor_sports-1");
    expect(missing?.estimate.status).toBe("unavailable");
    expect(missing?.estimate.reason).toBe("missing-concentration");
    expect(missing?.explanation.confidence.level).toBe("unavailable");
    expect(missing?.explanation.impact).toMatch(/Not estimated/);

    const withReading = run("student_athlete", snapshot(HIGH_DIP), { indoorPm25UgM3: 30 });
    const quantified = withReading.exposure.items.find((e) => e.id === "EXP_INDOOR_outdoor_sports-1");
    expect(quantified?.estimate.status).toBe("available");
    expect(quantified?.estimate.alternative?.pm25UgM3).toBe(30);
    expect(quantified?.estimate.alternative?.concentrationSource).toMatch(/entered by the user \(unverified\)/);
    expect(quantified?.explanation.assumptionIds).toContain("ASM_INDOOR_READING_USER_REPORTED");
  });

  it("no estimate is produced when nothing meaningful changes", () => {
    expect(run("senior_respiratory", snapshot(CLEAN_FLAT)).exposure.items).toEqual([]);
  });
});

describe("emissions section", () => {
  const r = run("two_wheeler_commuter", snapshot(EVENING_DIP));

  it("reports tailpipe CO2 per passenger, with weekly scaling, and never a negative number", () => {
    expect(r.emissions).toMatchObject({ gas: "CO2", basis: "tailpipe-co2", baselineMode: "two_wheeler", distanceKm: 14, distanceIsAssumed: true });
    expect(r.emissions.scaling).toEqual({ tripsPerDay: 2, daysPerWeek: 5 });
    expect(r.emissions.rows.map((x) => x.mode).sort()).toEqual(["bus", "carpool", "cycling", "metro", "private_car", "walking"]);
    for (const row of r.emissions.rows) {
      if (row.oneWayGramsCo2 !== null) {
        expect(row.oneWayGramsCo2).toBeGreaterThanOrEqual(0);
        expect(row.weeklyGramsCo2).toBeCloseTo(row.oneWayGramsCo2 * 2 * 5, 0);
      }
    }
    const bus = r.emissions.rows.find((x) => x.mode === "bus");
    expect(bus).toMatchObject({ status: "available", direction: "reduction", oneWayGramsCo2: 234.3, weeklyGramsCo2: 2343 });
    expect(bus?.factorSourceUrl).toMatch(/indiaghgp\.org/);
    const car = r.emissions.rows.find((x) => x.mode === "private_car");
    expect(car?.direction).toBe("increase");
    expect(r.emissions.note).toMatch(/preset assumption/);
  });

  it("marks metro unavailable and never fabricates a figure", () => {
    const metro = r.emissions.rows.find((x) => x.mode === "metro");
    expect(metro).toMatchObject({ status: "unavailable", direction: null, oneWayGramsCo2: null, weeklyGramsCo2: null, factorId: null });
    expect(metro?.unavailableReason).toMatch(/unavailable/);
  });

  it("uses the user's own distance and drops the preset-distance warning", () => {
    const own = run("two_wheeler_commuter", snapshot(EVENING_DIP), { commuteDistanceKm: 5 });
    expect(own.emissions.distanceIsAssumed).toBe(false);
    expect(own.warnings.map((w) => w.code)).not.toContain("PRESET_DISTANCE_ASSUMED");
    expect(own.emissions.note).toMatch(/the one you supplied/);
    expect(own.profile.overriddenPreferences).toEqual(["commuteDistanceKm"]);
    const shorter = own.emissions.rows.find((x) => x.mode === "bus")?.oneWayGramsCo2 ?? 0;
    expect(shorter).toBeLessThan(234.3);
  });
});

describe("prioritisation does not exaggerate", () => {
  const tiers = (r: RecommendationResult) => new Set(r.prioritized.map((p) => p.tier));

  it("raises no 'high' priority in clean air", () => {
    const r = run("senior_respiratory", snapshot(CLEAN_FLAT));
    expect(r.aqiContext.severity).toBe("low");
    expect(tiers(r).has("high")).toBe(false);
  });

  it("raises 'high' priorities for sensitive profiles when air is severe", () => {
    const r = run("senior_respiratory", snapshot(SEVERE_FLAT));
    expect(["high", "very-high"]).toContain(r.aqiContext.severity);
    expect(tiers(r).has("high")).toBe(true);
    const sensitive = r.prioritized.filter((p) => p.tier === "high").length;
    const commuter = run("two_wheeler_commuter", snapshot(SEVERE_FLAT)).prioritized.filter((p) => p.tier === "high").length;
    expect(sensitive).toBeGreaterThanOrEqual(commuter);
  });

  it("never puts the qualitative transport suggestions or trip chaining above 'recommended'", () => {
    for (const id of PROFILE_IDS) {
      const r = run(id, snapshot(SEVERE_FLAT));
      for (const p of r.prioritized) if (p.kind === "transport" || p.kind === "trip-chaining") expect(p.tier).not.toBe("high");
    }
  });
});

describe("stale data", () => {
  const fresh = run("senior_respiratory", snapshot(MORNING_DIP));
  const old = run("senior_respiratory", stale(snapshot(MORNING_DIP)));

  it("still recommends, flags the age, and lowers confidence", () => {
    expect(old.status).toBe("ok");
    expect(old.dataFreshness).toMatchObject({ status: "stale", ageSeconds: 5400 });
    expect(old.warnings.map((w) => w.code)).toContain("AIR_DATA_STALE");
    expect(old.warnings.find((w) => w.code === "AIR_DATA_STALE")?.message).toMatch(/5400 seconds old/);
    expect(old.confidence.score).toBeLessThan(fresh.confidence.score);
    const walk = old.routine.items.find((i) => i.id === "morning_walk-1");
    expect(walk?.confidence.factors.map((f) => f.id)).toContain("stale-data");
  });

  it("uses only forecast hours still in the future", () => {
    const later = run("senior_respiratory", stale(snapshot(MORNING_DIP)), undefined, NOW + 20 * 3_600_000);
    for (const item of later.routine.items) {
      if (item.suggestedTime !== null) expect(new Date(item.suggestedTime.start).getTime()).toBeGreaterThanOrEqual(NOW + 20 * 3_600_000);
    }
  });

  it("a forecast that has fully passed gives unavailable windows, not invented ones", () => {
    const gone = run("senior_respiratory", stale(snapshot(MORNING_DIP)), undefined, NOW + 80 * 3_600_000);
    expect(gone.routine.items.every((i) => i.windowStatus === "unavailable" && i.suggestedTime === null)).toBe(true);
    expect(gone.outdoorWindows.status).toBe("unavailable");
  });
});

describe("unavailable data", () => {
  const r = run("family_toddlers", unavailable());

  it("is an explicit unavailable state: no AQI, no windows, no exposure estimates, no confidence", () => {
    expect(r.status).toBe("air-data-unavailable");
    expect(r.dataFreshness.status).toBe("unavailable");
    expect(r.aqiContext).toMatchObject({ aqi: null, categoryLabel: null, severity: "unknown", latestPm25UgM3: null });
    expect(r.routine.status).toBe("unavailable");
    expect(r.routine.items.every((i) => i.suggestedTime === null)).toBe(true);
    expect(r.outdoorWindows.status).toBe("unavailable");
    expect(r.outdoorWindows.periods.status).toBe("unavailable");
    expect(r.exposure.items).toEqual([]);
    expect(r.confidence.level).toBe("unavailable");
    expect(r.warnings.map((w) => w.code)).toContain("AIR_DATA_UNAVAILABLE");
  });

  it("still gives guidance that does not depend on air data, and data-independent CO2 comparisons", () => {
    expect(r.indoor.interventions.some((i) => i.id === "IND_AVOID_INDOOR_SMOKE")).toBe(true);
    expect(r.indoor.interventions.some((i) => i.id === "IND_WET_MOP_DAMP_DUST")).toBe(true);
    expect(r.indoor.interventions.some((i) => i.id === "IND_NO_DRY_SWEEPING")).toBe(false);
    expect(r.emissions.rows.some((x) => x.status === "available")).toBe(true);
    expect(r.prioritized.every((p) => p.tier !== "high" || p.kind !== "routine")).toBe(true);
  });

  it("does not use the stale forecast of an unavailable snapshot", () => {
    expect(r.provenance.airDataSource.id).toBe("open-meteo-air-quality");
    expect(r.outdoorWindows.trend).toBe("unknown");
  });
});

describe("severity mapping", () => {
  it("follows the CPCB category rank of the estimated AQI", () => {
    const sev = (options: Parameters<typeof snapshot>[0]) => run("two_wheeler_commuter", snapshot(options)).aqiContext.severity;
    expect(sev(CLEAN_FLAT)).toBe("low");
    expect(["high", "very-high"]).toContain(sev(SEVERE_FLAT));
  });
});
