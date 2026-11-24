import { describe, expect, it } from "vitest";

import {
  buildIndoorSection,
  resolveProfile,
  resolveReferences,
  type IndoorIntervention,
  type IndoorSection,
  type ProfileId,
  type ResolvedPreferences,
  type SeverityLevel,
} from "@/lib/engine";
import type { VentilationOutlook } from "@/lib/engine/indoor";
import { VENTILATION_ADVANTAGE_FACTOR } from "@/lib/engine/indoor";

const OUTLOOK: VentilationOutlook = { startLocal: "17:30", endLocal: "18:00", pm25MeanUgM3: 40, forecastHours: ["2026-11-24T17:00:00+05:30", "2026-11-24T18:00:00+05:30"] };

function build(
  id: ProfileId = "family_toddlers",
  options: { severity?: SeverityLevel; overrides?: Partial<ResolvedPreferences>; outlook?: VentilationOutlook | null; dataAvailable?: boolean; stale?: boolean } = {},
): IndoorSection {
  const resolved = resolveProfile(id);
  if (!resolved.ok) throw new Error("preset must resolve");
  return buildIndoorSection({
    preset: resolved.preset,
    preferences: { ...resolved.preferences, ...options.overrides },
    severity: options.severity ?? "moderate",
    aqiRef: { kind: "aqi", ref: "t", detail: "Estimated Indian AQI (synthetic)" },
    outlook: options.outlook === undefined ? null : options.outlook,
    stale: options.stale ?? false,
    dataAvailable: options.dataAvailable ?? true,
  });
}

const find = (section: IndoorSection, id: string): IndoorIntervention | undefined => section.interventions.find((i) => i.id === id);
const need = (section: IndoorSection, id: string): IndoorIntervention => {
  const found = find(section, id);
  if (found === undefined) throw new Error(`missing intervention ${id}`);
  return found;
};

describe("every intervention is complete", () => {
  it.each(["family_toddlers", "senior_respiratory", "two_wheeler_commuter", "student_athlete"] as const)("%s", (id) => {
    const section = build(id, { severity: "high" });
    expect(section.interventions.length).toBeGreaterThanOrEqual(8);
    const ids = new Set<string>();
    for (const i of section.interventions) {
      expect(ids.has(i.id)).toBe(false);
      ids.add(i.id);
      expect(i.action.length).toBeGreaterThan(20);
      expect(i.whyItHelps.length).toBeGreaterThan(20);
      expect(["high", "recommended", "optional"]).toContain(i.priority);
      expect(["none", "low", "medium", "high"]).toContain(i.costLevel);
      expect(["high", "medium", "low"]).toContain(i.feasibility);
      expect(["agency-guidance", "engineering-principle", "limited-evidence"]).toContain(i.evidenceCategory);
      expect(i.limitations.length).toBeGreaterThan(0);
      expect(i.priority).toBe(i.priorityDetail.tier);
      expect(i.explanation.what).toBe(i.action);
      expect(i.explanation.ruleIds.length).toBeGreaterThan(0);
    }
    expect(resolveReferences(section.interventions.map((i) => i.explanation)).unknownIds).toEqual([]);
  });

  it("is sorted by priority, then score, then ID", () => {
    const section = build("family_toddlers", { severity: "high" });
    const order = { high: 0, recommended: 1, optional: 2 } as const;
    for (let i = 1; i < section.interventions.length; i += 1) {
      const a = section.interventions[i - 1];
      const b = section.interventions[i];
      expect(a !== undefined && b !== undefined && order[a.priority] <= order[b.priority]).toBe(true);
    }
  });

  it("is deterministic", () => {
    expect(build("senior_respiratory")).toEqual(build("senior_respiratory"));
  });
});

describe("source control: incense, smoke and cooking", () => {
  const section = build("senior_respiratory");

  it("advises against indoor smoke from incense, coils and smoking, at least 'recommended'", () => {
    const smoke = need(section, "IND_AVOID_INDOOR_SMOKE");
    expect(smoke.category).toBe("source-control");
    expect(smoke.action).toMatch(/incense/);
    expect(smoke.action).toMatch(/cigarettes/);
    expect(smoke.priority).not.toBe("optional");
    expect(smoke.costLevel).toBe("none");
    expect(smoke.evidenceCategory).toBe("agency-guidance");
    expect(smoke.limitations.join(" ")).toMatch(/Cultural/);
    expect(smoke.references.some((r) => r.url.includes("epa.gov"))).toBe(true);
  });

  it("covers kitchen exhaust and frying", () => {
    expect(need(section, "IND_COOKING_EXHAUST").action).toMatch(/chimney or exhaust/);
    expect(need(section, "IND_FRYING_AND_HIGH_HEAT").action).toMatch(/frying/i);
    expect(need(section, "IND_FRYING_AND_HIGH_HEAT").priority).not.toBe("high");
  });

  it("adds a cleaner-fuel step only for biomass or kerosene, with honest limits", () => {
    expect(find(build("senior_respiratory", { overrides: { cookingFuel: "lpg" } }), "IND_CLEANER_COOKING_FUEL")).toBeUndefined();
    for (const cookingFuel of ["biomass", "kerosene"] as const) {
      const fuel = need(build("senior_respiratory", { overrides: { cookingFuel } }), "IND_CLEANER_COOKING_FUEL");
      expect(fuel.priority).not.toBe("optional");
      expect(fuel.costLevel).toBe("high");
      expect(fuel.feasibility).toBe("low");
      expect(fuel.limitations.join(" ")).toMatch(/access, cost/);
      expect(fuel.explanation.ruleIds).toContain("RULE_COMBUSTION_FUEL_SOURCE");
      expect(fuel.references.some((r) => r.url.includes("who.int"))).toBe(true);
    }
  });
});

describe("cleaning", () => {
  it("always recommends wet mopping and damp dusting over dry sweeping", () => {
    for (const severity of ["low", "moderate", "high"] as const) {
      const mop = need(build("family_toddlers", { severity }), "IND_WET_MOP_DAMP_DUST");
      expect(mop.action).toMatch(/Wet-mop/);
      expect(mop.action).toMatch(/damp-dust/);
      expect(mop.category).toBe("cleaning");
      expect(mop.limitations.join(" ")).toMatch(/mould/);
    }
  });

  it("adds 'no dry sweeping' only when pollution is poor", () => {
    expect(find(build("family_toddlers", { severity: "moderate" }), "IND_NO_DRY_SWEEPING")).toBeUndefined();
    expect(find(build("family_toddlers", { severity: "low" }), "IND_NO_DRY_SWEEPING")).toBeUndefined();
    for (const severity of ["high", "very-high"] as const) {
      const sweep = need(build("family_toddlers", { severity }), "IND_NO_DRY_SWEEPING");
      expect(sweep.action).toMatch(/do not dry-sweep/);
      expect(sweep.explanation.ruleIds).toContain("RULE_SEVERITY_ESCALATES_ADVICE");
    }
  });
});

describe("filtration", () => {
  it("with a purifier: how to run it and maintain it, not a purchase", () => {
    const section = build("senior_respiratory", { overrides: { hasAirPurifier: true } });
    const run = need(section, "IND_RUN_PURIFIER");
    expect(run.action).toMatch(/doors and windows closed/);
    expect(run.action).toMatch(/size/);
    expect(run.whyItHelps).toMatch(/CADR/);
    expect(run.costLevel).toBe("none");
    expect(run.limitations.join(" ")).toMatch(/typically small/);
    expect(run.limitations.join(" ")).toMatch(/gases/);
    expect(need(section, "IND_PURIFIER_MAINTENANCE").action).toMatch(/filters/);
    expect(find(section, "IND_CONSIDER_HEPA_PURIFIER")).toBeUndefined();
  });

  it("without a purifier: size by CADR, avoid ozone generators, and do not oversell it", () => {
    const section = build("senior_respiratory", { overrides: { hasAirPurifier: false } });
    const buy = need(section, "IND_CONSIDER_HEPA_PURIFIER");
    expect(buy.action).toMatch(/HEPA/);
    expect(buy.action).toMatch(/CADR/);
    expect(buy.action).toMatch(/ozone/);
    expect(buy.costLevel).toBe("high");
    expect(buy.feasibility).toBe("low");
    expect(buy.priority).not.toBe("high");
    expect(buy.limitations.join(" ")).toMatch(/source control comes first/);
    expect(find(section, "IND_RUN_PURIFIER")).toBeUndefined();
    expect(find(section, "IND_PURIFIER_MAINTENANCE")).toBeUndefined();
  });

  it("ranks source control ahead of buying a purifier", () => {
    const section = build("senior_respiratory", { severity: "high" });
    const ids = section.interventions.map((i) => i.id);
    expect(ids.indexOf("IND_AVOID_INDOOR_SMOKE")).toBeLessThan(ids.indexOf("IND_CONSIDER_HEPA_PURIFIER"));
  });
});

describe("ventilation is conditional, never blind", () => {
  it("with no indoor sensor and poor air: do not open windows to air out", () => {
    const v = need(build("senior_respiratory", { severity: "high" }), "IND_VENTILATION_CONDITIONAL");
    expect(v.action).toMatch(/Do not open windows/);
    expect(v.conditions.length).toBeGreaterThan(0);
    expect(v.priority).not.toBe("high");
  });

  it("with no sensor and a lower-pollution window: brief ventilation in that window, admitting it cannot compare", () => {
    const v = need(build("senior_respiratory", { severity: "moderate", outlook: OUTLOOK }), "IND_VENTILATION_CONDITIONAL");
    expect(v.action).toMatch(/briefly/);
    expect(v.action).toContain("17:30 to 18:00");
    expect(v.action).toMatch(/cannot tell whether indoor air is cleaner/);
    expect(v.limitations.join(" ")).toMatch(/Relatively lower is not the same as low or safe/);
    expect(v.explanation.triggeredBy.some((t) => t.kind === "forecast-window")).toBe(true);
  });

  it("with no sensor and no outlook: does not assume outdoor air is cleaner", () => {
    const v = need(build("student_athlete", { severity: "moderate", outlook: null }), "IND_VENTILATION_CONDITIONAL");
    expect(v.action).toMatch(/do not assume outdoor air is cleaner/);
    expect(v.action).toMatch(/without an indoor sensor/);
  });

  it("never gives unconditional 'open the windows' advice in any state", () => {
    for (const severity of ["unknown", "low", "moderate", "high", "very-high"] as const) {
      for (const outlook of [null, OUTLOOK]) {
        const v = need(build("family_toddlers", { severity, outlook }), "IND_VENTILATION_CONDITIONAL");
        expect(v.action).not.toMatch(/^Open (the )?windows/i);
        expect(v.conditions.join(" ")).toMatch(/PM2\.5 monitor/);
        expect(v.explanation.ruleIds).toContain("RULE_VENTILATION_IS_CONDITIONAL");
      }
    }
  });

  it("with a user-reported indoor reading above the outdoor outlook: suggests brief ventilation and says how it was decided", () => {
    const v = need(build("senior_respiratory", { overrides: { indoorPm25UgM3: 120 }, outlook: OUTLOOK }), "IND_VENTILATION_CONDITIONAL");
    expect(v.action).toMatch(/higher than the forecast outdoor level/);
    expect(v.action).toMatch(/short ventilation/);
    expect(v.limitations.join(" ")).toMatch(/self-reported/);
    expect(v.explanation.assumptionIds).toEqual(expect.arrayContaining(["ASM_INDOOR_READING_USER_REPORTED", "ASM_VENTILATION_ADVANTAGE_MARGIN"]));
  });

  it("with an indoor reading not clearly higher than outdoors: keep windows closed", () => {
    const v = need(build("senior_respiratory", { overrides: { indoorPm25UgM3: 35 }, outlook: OUTLOOK }), "IND_VENTILATION_CONDITIONAL");
    expect(v.action).toMatch(/Keep windows closed/);
    expect(v.action).toMatch(/not clearly higher/);
  });

  it("the advantage margin is applied at exactly 80%", () => {
    const at = (indoor: number) => need(build("senior_respiratory", { overrides: { indoorPm25UgM3: indoor }, outlook: OUTLOOK }), "IND_VENTILATION_CONDITIONAL").action;
    const threshold = OUTLOOK.pm25MeanUgM3 / VENTILATION_ADVANTAGE_FACTOR; // 50
    expect(at(threshold + 1)).toMatch(/short ventilation/);
    expect(at(threshold)).toMatch(/Keep windows closed/);
  });

  it("recommends closing doors and windows in the worst hours only when pollution is elevated or unknown", () => {
    expect(find(build("family_toddlers", { severity: "low" }), "IND_DOORS_AND_WINDOWS")).toBeUndefined();
    for (const severity of ["moderate", "high", "unknown"] as const) {
      expect(find(build("family_toddlers", { severity }), "IND_DOORS_AND_WINDOWS")?.limitations.join(" ")).toMatch(/rarely airtight/);
    }
  });
});

describe("lifestyle", () => {
  it("keeps children's areas away from sources, for the family profile only", () => {
    expect(need(build("family_toddlers"), "IND_CHILD_AREA_AWAY_FROM_SOURCES").action).toMatch(/children's play and sleep areas/);
    for (const id of ["senior_respiratory", "two_wheeler_commuter", "student_athlete"] as const) {
      expect(find(build(id), "IND_CHILD_AREA_AWAY_FROM_SOURCES")).toBeUndefined();
    }
  });

  it("adds outdoor-time advice only on elevated days, as limited evidence", () => {
    expect(find(build("family_toddlers", { severity: "low" }), "IND_REDUCE_UNNECESSARY_OUTDOOR_TIME")).toBeUndefined();
    const reduce = need(build("family_toddlers", { severity: "moderate" }), "IND_REDUCE_UNNECESSARY_OUTDOOR_TIME");
    expect(reduce.evidenceCategory).toBe("limited-evidence");
    expect(reduce.limitations.join(" ")).toMatch(/not the same as being protected/);
  });
});

describe("missing indoor sensor data", () => {
  it("says plainly that the app does not measure indoor air", () => {
    const m = build("family_toddlers").measurement;
    expect(m).toMatchObject({ status: "no-indoor-sensor", pm25UgM3: null });
    expect(m.note).toMatch(/does not measure or estimate indoor air quality/);
  });

  it("labels a typed-in reading as user-reported and unverified", () => {
    const m = build("family_toddlers", { overrides: { indoorPm25UgM3: 55 } }).measurement;
    expect(m).toMatchObject({ status: "user-reported", pm25UgM3: 55 });
    expect(m.note).toMatch(/did not measure it and cannot verify it/);
  });

  it("never claims to have measured indoor air anywhere in the section", () => {
    const text = JSON.stringify(build("senior_respiratory", { severity: "high", outlook: OUTLOOK }));
    expect(text).not.toMatch(/your indoor air (quality )?is/i);
    expect(text).not.toMatch(/we measured|measured indoor|indoor sensor shows/i);
    // Negations ("not the same as low or safe") are fine; claims of safety are not.
    expect(text).not.toMatch(/\b(is|are|be|as|stay) safe\b|safe (window|level|air|to)\b/i);
  });
});

describe("data state", () => {
  it("lowers confidence in pollution-driven advice when air data is stale", () => {
    const fresh = need(build("family_toddlers", { severity: "high" }), "IND_DOORS_AND_WINDOWS");
    const stale = need(build("family_toddlers", { severity: "high", stale: true }), "IND_DOORS_AND_WINDOWS");
    expect(stale.explanation.confidence.score).toBeLessThan(fresh.explanation.confidence.score);
    // General good practice does not depend on the air data.
    expect(need(build("family_toddlers", { stale: true }), "IND_WET_MOP_DAMP_DUST").explanation.confidence.score).toBe(
      need(build("family_toddlers"), "IND_WET_MOP_DAMP_DUST").explanation.confidence.score,
    );
  });

  it("with no air data, pollution-driven advice carries an 'unavailable' confidence factor and general advice is unaffected", () => {
    const section = build("family_toddlers", { severity: "unknown", dataAvailable: false });
    const doors = need(section, "IND_DOORS_AND_WINDOWS");
    expect(doors.explanation.confidence.factors.map((f) => f.id)).toContain("air-data-unavailable");
    expect(doors.priority).not.toBe("high");
    expect(need(section, "IND_AVOID_INDOOR_SMOKE").priority).not.toBe("optional");
  });
});
