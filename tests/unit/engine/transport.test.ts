import { describe, expect, it } from "vitest";

import { EMISSION_FACTORS, type EmissionFactor } from "@/config/emissionFactors";
import { MODE_LABELS, compareTransport, resolveProfile, resolveReferences, type ResolvedPreferences, type SeverityLevel, type TransportMode } from "@/lib/engine";
import { TRANSPORT_POLICY } from "@/lib/engine/transport";
import { TRANSPORT_MODES } from "@/lib/engine/types";

function prefs(profileId: Parameters<typeof resolveProfile>[0], overrides: Partial<ResolvedPreferences> = {}): ResolvedPreferences {
  const r = resolveProfile(profileId);
  if (!r.ok) throw new Error("preset must resolve");
  return { ...r.preferences, ...overrides };
}

const run = (p: ResolvedPreferences, severity: SeverityLevel = "moderate", registry?: Record<TransportMode, EmissionFactor>) =>
  compareTransport({ preferences: p, severity, ...(registry === undefined ? {} : { registry }) });

const option = (section: ReturnType<typeof run>, mode: TransportMode) => {
  const o = section.options.find((x) => x.mode === mode);
  if (o === undefined) throw new Error(`no option ${mode}`);
  return o;
};

describe("structure", () => {
  const section = run(prefs("two_wheeler_commuter"));

  it("compares all seven modes with exactly one baseline", () => {
    expect(section.options.map((o) => o.mode)).toEqual([...TRANSPORT_MODES]);
    expect(section.options.filter((o) => o.isBaseline)).toHaveLength(1);
    expect(option(section, "two_wheeler").isBaseline).toBe(true);
    expect(section.baselineMode).toBe("two_wheeler");
    for (const o of section.options) expect(o.label).toBe(MODE_LABELS[o.mode]);
  });

  it("describes every option on three separate axes", () => {
    for (const o of section.options) {
      expect(o.emissions).toBeDefined();
      expect(o.exposure).toMatchObject({ quantified: false });
      expect(o.convenience.rating).toMatch(/high|medium|low|not-assessed/);
      expect(o.tradeoff).toMatch(/Environment:.*Exposure:.*Convenience:/);
    }
  });

  it("states that route-level pollution data is not available and never quantifies mode exposure", () => {
    expect(section.routeData.available).toBe(false);
    expect(section.routeData.note).toMatch(/Route-level pollution data is not available/);
    for (const o of section.options) {
      expect(o.exposure.quantified).toBe(false);
      expect(JSON.stringify(o.exposure)).not.toMatch(/ug|µg|microgram/);
    }
  });

  it("flags a preset distance as assumed", () => {
    expect(section.distanceIsAssumed).toBe(true);
    expect(section.options.every((o) => o.explanation.assumptionIds.includes("ASM_PRESET_DISTANCE"))).toBe(true);
    expect(run(prefs("two_wheeler_commuter", { distanceIsAssumed: false })).options.some((o) => o.explanation.assumptionIds.includes("ASM_PRESET_DISTANCE"))).toBe(false);
  });

  it("every assumption and rule it cites exists in the registries", () => {
    const refs = resolveReferences(section.options.map((o) => o.explanation));
    expect(refs.unknownIds).toEqual([]);
    expect(refs.assumptions.map((a) => a.id)).toContain("ASM_EMISSION_FACTORS_TAILPIPE_CO2");
  });
});

describe("metro versus two-wheeler", () => {
  const section = run(prefs("two_wheeler_commuter"), "moderate");
  const metro = option(section, "metro");

  it("has no CO2 comparison, because no defensible factor exists, and says so", () => {
    expect(metro.emissions.status).toBe("unavailable");
    expect(metro.emissions.reason).toBe("no-defensible-factor");
    expect(metro.emissionsVsBaseline?.status).toBe("unavailable");
    expect(metro.emissionsVsBaseline?.difference).toBeNull();
    expect(metro.explanation.impact).toBe("CO2 comparison unavailable.");
    expect(section.status).toBe("partial");
  });

  it("is qualitatively lower in exposure, with the caveat, and not assessed for convenience", () => {
    expect(metro.exposure.direction).toBe("lower");
    expect(metro.exposure.rationale).toMatch(/Qualitative only/);
    expect(metro.convenience).toMatchObject({ rating: "not-assessed", travelMinutes: null, travelTimeBasis: "not-provided" });
  });

  it("is put forward for its exposure advantage, with the missing CO2 comparison stated", () => {
    expect(metro.suggested).toBe(true);
    expect(metro.suggestionNote).toMatch(/CO2 comparison is unavailable/);
  });

  it("still compares a bus against the two-wheeler in CO2", () => {
    const bus = option(section, "bus");
    expect(bus.emissionsVsBaseline?.difference?.direction).toBe("reduction");
    expect(bus.emissionsVsBaseline?.difference?.gramsCo2).toBe(234.3);
    expect(bus.exposure.direction).toBe("unknown");
    expect(bus.suggested).toBe(true);
  });
});

describe("carpool versus private car", () => {
  const section = run(prefs("family_toddlers", { preferredTransport: "private_car", vehicleOccupancy: 1, commuteDistanceKm: 10 }));
  const carpool = option(section, "carpool");

  it("divides the same vehicle's emissions among at least three occupants", () => {
    expect(carpool.emissions.occupancy).toBe(3);
    expect(carpool.emissions.totalGramsPerPassenger).toBe(466.7);
    expect(carpool.emissionsVsBaseline?.difference).toMatchObject({ direction: "reduction", gramsCo2: 933.3 });
    expect(carpool.explanation.assumptionIds).toContain("ASM_CARPOOL_OCCUPANCY");
  });

  it("respects a household that states a larger occupancy", () => {
    const bigger = run(prefs("family_toddlers", { preferredTransport: "private_car", vehicleOccupancy: 4, commuteDistanceKm: 10 }));
    expect(option(bigger, "carpool").emissions.occupancy).toBe(4);
  });

  it("makes no exposure claim between two enclosed vehicles", () => {
    expect(carpool.exposure.direction).toBe("unknown");
    expect(carpool.suggested).toBe(true);
  });
});

describe("walking and cycling when pollution is high", () => {
  const near = (severity: SeverityLevel) => run(prefs("two_wheeler_commuter", { commuteDistanceKm: 1.5 }), severity);

  it("emit no tailpipe CO2 but are held back while air quality is poor", () => {
    for (const severity of ["high", "very-high"] as const) {
      const walking = option(near(severity), "walking");
      expect(walking.emissions.totalGramsPerPassenger).toBe(0);
      expect(walking.emissionsVsBaseline?.difference?.direction).toBe("reduction");
      expect(walking.suggested).toBe(false);
      expect(walking.suggestionNote).toMatch(/lower carbon is not lower exposure/);
      expect(option(near(severity), "cycling").suggested).toBe(false);
    }
  });

  it("are put forward on a cleaner day when they are practical and lower-carbon", () => {
    expect(option(near("low"), "walking").suggested).toBe(true);
    expect(option(near("moderate"), "walking").suggested).toBe(true);
  });

  it("show that lower carbon is not lower exposure", () => {
    const fromCar = run(prefs("family_toddlers", { preferredTransport: "private_car", commuteDistanceKm: 1.5 }), "moderate");
    const walking = option(fromCar, "walking");
    expect(walking.emissionsVsBaseline?.difference?.direction).toBe("reduction");
    expect(walking.exposure.direction).toBe("higher");
    expect(walking.tradeoff).toMatch(/qualitatively higher/);
    expect(walking.explanation.ruleIds).toContain("RULE_ACTIVE_MODE_HELD_BACK_WHEN_POOR");
  });

  it("is not blind to effort: against an open two-wheeler the exposure comparison is unknown", () => {
    expect(option(near("moderate"), "walking").exposure.direction).toBe("unknown");
  });
});

describe("practicality and travel time", () => {
  const far = run(prefs("student_athlete", { commuteDistanceKm: 8, commuteMinutes: 30 }), "low");

  it("does not suggest walking beyond the practical distance but allows cycling within its range", () => {
    expect(option(far, "walking").practical.feasible).toBe(false);
    expect(option(far, "walking").suggested).toBe(false);
    expect(option(far, "walking").suggestionNote).toMatch(new RegExp(`Over ${TRANSPORT_POLICY.maxWalkingKm} km`));
    expect(option(far, "cycling").practical.feasible).toBe(true);
    const veryFar = run(prefs("student_athlete", { commuteDistanceKm: 12 }), "low");
    expect(option(veryFar, "cycling").practical.feasible).toBe(false);
  });

  it("uses the user's commute time for the baseline and labelled assumptions for others", () => {
    const baseline = option(far, "two_wheeler");
    expect(baseline.convenience).toMatchObject({ rating: "high", travelMinutes: 30, travelTimeBasis: "user-provided" });
    const walking = option(far, "walking");
    expect(walking.convenience.travelMinutes).toBe(96);
    expect(walking.convenience.travelTimeBasis).toBe("engine-assumption");
    expect(walking.convenience.rating).toBe("low");
    expect(option(far, "cycling").convenience.travelMinutes).toBe(32);
    expect(option(far, "cycling").convenience.rating).toBe("high");
    expect(walking.explanation.assumptionIds).toContain("ASM_ACTIVE_TRAVEL_SPEEDS");
  });
});

describe("missing distance, occupancy or emission factors", () => {
  it("missing distance: no CO2 figure is produced for any mode", () => {
    const section = run(prefs("two_wheeler_commuter", { commuteDistanceKm: Number.NaN }));
    expect(section.status).toBe("partial");
    for (const o of section.options) {
      expect(o.emissions.status).toBe("unavailable");
      expect(o.emissions.totalGramsPerPassenger).toBeNull();
      expect(o.emissionsVsBaseline === null || o.emissionsVsBaseline.difference === null).toBe(true);
    }
  });

  it("missing occupancy on the baseline vehicle: comparisons are unavailable rather than assumed", () => {
    const section = run(prefs("two_wheeler_commuter", { vehicleOccupancy: 0 }));
    expect(option(section, "two_wheeler").emissions.reason).toBe("invalid-input");
    expect(option(section, "bus").emissionsVsBaseline?.status).toBe("unavailable");
    expect(option(section, "bus").emissionsVsBaseline?.difference).toBeNull();
    // The bus itself is still computable: only the comparison is not.
    expect(option(section, "bus").emissions.status).toBe("available");
  });

  it("a missing emission factor for one mode leaves only that mode unavailable (SYNTHETIC registry)", () => {
    const registry: Record<TransportMode, EmissionFactor> = {
      ...EMISSION_FACTORS,
      bus: { id: "x", status: "unavailable", mode: "bus", label: "Bus", reason: "synthetic: no factor in this test registry" },
    };
    const section = run(prefs("two_wheeler_commuter"), "low", registry);
    expect(option(section, "bus").emissions.status).toBe("unavailable");
    expect(option(section, "bus").emissionsVsBaseline?.status).toBe("unavailable");
    expect(option(section, "private_car").emissions.status).toBe("available");
    expect(option(section, "bus").suggested).toBe(false);
  });
});

describe("determinism", () => {
  it("returns identical results for identical input", () => {
    expect(run(prefs("senior_respiratory"))).toEqual(run(prefs("senior_respiratory")));
  });
});
