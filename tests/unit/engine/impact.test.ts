import { describe, expect, it } from "vitest";

import { EMISSION_FACTORS, GRID_EMISSION_FACTOR, type EmissionFactor } from "@/config/emissionFactors";
import { compareEmissions, computeTripEmissions } from "@/lib/engine";
import { EMISSIONS_NOTE } from "@/lib/engine/impact";
import { TRANSPORT_MODES, type TransportMode } from "@/lib/engine/types";

describe("emission-factor provenance", () => {
  it("covers every transport mode exactly once", () => {
    expect(Object.keys(EMISSION_FACTORS).sort()).toEqual([...TRANSPORT_MODES].sort());
    for (const mode of TRANSPORT_MODES) expect(EMISSION_FACTORS[mode].mode).toBe(mode);
  });

  it("uses the figures printed in the cited India GHG Program paper, unaltered", () => {
    const value = (mode: TransportMode) => {
      const f = EMISSION_FACTORS[mode];
      return f.status === "available" ? f.value : null;
    };
    expect(value("two_wheeler")).toBe(0.0319);
    expect(value("private_car")).toBe(0.14);
    expect(value("carpool")).toBe(0.14);
    expect(value("bus")).toBe(0.015161);
    expect(value("walking")).toBe(0);
    expect(value("cycling")).toBe(0);
    expect(value("metro")).toBeNull();
  });

  it("documents source, year, unit, category, occupancy, geography and basis for every sourced factor", () => {
    for (const mode of ["two_wheeler", "private_car", "carpool", "bus"] as const) {
      const f = EMISSION_FACTORS[mode];
      expect(f.status).toBe("available");
      if (f.status !== "available") continue;
      expect(f.source?.url).toMatch(/^https:\/\/indiaghgp\.org\//);
      expect(f.source?.year).toBe(2015);
      expect(f.source?.publisher).toMatch(/India GHG Program/);
      expect(f.source?.locator.length).toBeGreaterThan(5);
      expect(["kgCO2/vehicle-km", "kgCO2/passenger-km"]).toContain(f.unit);
      expect(f.vehicleCategory.length).toBeGreaterThan(3);
      expect(f.occupancyNote.length).toBeGreaterThan(10);
      expect(f.geography).toMatch(/India/);
      expect(f.basis).toBe("tailpipe-co2");
      expect(f.gases).toBe("CO2 only");
    }
  });

  it("states the basis of every factor as tailpipe CO2 and never claims well-to-wheel or lifecycle", () => {
    for (const f of Object.values(EMISSION_FACTORS)) {
      if (f.status !== "available") continue;
      expect(f.basis).toBe("tailpipe-co2");
      expect(JSON.stringify(f)).not.toMatch(/well-to-wheel factor|lifecycle factor/i);
    }
    expect(EMISSIONS_NOTE).toMatch(/tailpipe CO2 only/i);
    expect(EMISSIONS_NOTE).toMatch(/methane/);
  });

  it("explains that the zero factors are definitions, not measurements, and that lifecycle is excluded", () => {
    for (const mode of ["walking", "cycling"] as const) {
      const f = EMISSION_FACTORS[mode];
      expect(f.status === "available" && f.notes).toMatch(/no fuel is burned/);
      expect(f.status === "available" && f.notes).toMatch(/lifecycle/);
      expect(f.status === "available" && f.source).toBeNull();
    }
  });

  it("marks metro as having no defensible factor, with the reason", () => {
    const metro = EMISSION_FACTORS.metro;
    expect(metro.status).toBe("unavailable");
    expect(metro.status === "unavailable" && metro.reason).toMatch(/unavailable until a sourced figure/);
  });

  it("records the CEA grid factor with its source for the future metro comparison, without using it", () => {
    expect(GRID_EMISSION_FACTOR.weightedAverageExcludingRes).toBe(0.823);
    expect(GRID_EMISSION_FACTOR.weightedAverageIncludingRes).toBe(0.716);
    expect(GRID_EMISSION_FACTOR.fiscalYear).toBe("2022-23");
    expect(GRID_EMISSION_FACTOR.source.publisher).toMatch(/Central Electricity Authority/);
    // Metro stays unavailable: a grid factor alone is not a per-passenger-km factor.
    expect(computeTripEmissions({ mode: "metro", distanceKm: 10, occupancy: null }).status).toBe("unavailable");
  });
});

describe("trip emissions", () => {
  it("two-wheeler, rider only: per-vehicle factor over occupancy 1", () => {
    const e = computeTripEmissions({ mode: "two_wheeler", distanceKm: 14, occupancy: 1 });
    expect(e.status).toBe("available");
    expect(e.gramsPerPassengerKm).toBe(31.9);
    expect(e.totalGramsPerPassenger).toBe(446.6);
    expect(e.factor?.id).toBe("in-ghgp-2015-motorcycle-lt125cc");
    expect(e.formula).toMatch(/\/ occupancy/);
  });

  it("a pillion halves the per-person figure", () => {
    expect(computeTripEmissions({ mode: "two_wheeler", distanceKm: 14, occupancy: 2 }).totalGramsPerPassenger).toBe(223.3);
  });

  it("bus: per-passenger factor, occupancy ignored", () => {
    const a = computeTripEmissions({ mode: "bus", distanceKm: 14, occupancy: null });
    const b = computeTripEmissions({ mode: "bus", distanceKm: 14, occupancy: 5 });
    expect(a.totalGramsPerPassenger).toBe(212.3);
    expect(b.totalGramsPerPassenger).toBe(212.3);
    expect(a.occupancy).toBeNull();
    expect(a.formula).not.toMatch(/occupancy/);
  });

  it("walking and cycling are zero tailpipe CO2", () => {
    expect(computeTripEmissions({ mode: "walking", distanceKm: 2, occupancy: null }).totalGramsPerPassenger).toBe(0);
    expect(computeTripEmissions({ mode: "cycling", distanceKm: 6, occupancy: null }).totalGramsPerPassenger).toBe(0);
  });
});

describe("CO2 savings", () => {
  it("two-wheeler to bus saves the difference", () => {
    const c = compareEmissions({ mode: "two_wheeler", distanceKm: 14, occupancy: 1 }, { mode: "bus", distanceKm: 14, occupancy: null });
    expect(c.status).toBe("available");
    expect(c.difference).toEqual({ direction: "reduction", gramsCo2: 234.3, percentOfBaseline: 52.5 });
    expect(c.gas).toBe("CO2");
    expect(c.basis).toBe("tailpipe-co2");
    expect(c.note).toBe(EMISSIONS_NOTE);
  });

  it("carpool versus a solo car", () => {
    const c = compareEmissions({ mode: "private_car", distanceKm: 10, occupancy: 1 }, { mode: "carpool", distanceKm: 10, occupancy: 3 });
    expect(c.baseline.totalGramsPerPassenger).toBe(1400);
    expect(c.alternative.totalGramsPerPassenger).toBe(466.7);
    expect(c.difference?.gramsCo2).toBe(933.3);
  });

  it("different occupancy assumptions change the saving in the expected direction", () => {
    const saving = (occupancy: number) =>
      compareEmissions({ mode: "private_car", distanceKm: 10, occupancy: 1 }, { mode: "carpool", distanceKm: 10, occupancy }).difference?.gramsCo2 ?? 0;
    expect(saving(2)).toBe(700);
    expect(saving(4)).toBe(1050);
    expect(saving(2)).toBeLessThan(saving(4));
  });

  it("never reports a negative saving: more emissions are an 'increase' with a positive magnitude", () => {
    const c = compareEmissions({ mode: "walking", distanceKm: 2, occupancy: null }, { mode: "private_car", distanceKm: 2, occupancy: 1 });
    expect(c.difference?.direction).toBe("increase");
    expect(c.difference?.gramsCo2).toBe(280);
    expect(c.difference?.gramsCo2).toBeGreaterThan(0);
    expect(c.difference?.percentOfBaseline).toBeNull();
  });

  it("identical modes are 'no-change'", () => {
    const c = compareEmissions({ mode: "bus", distanceKm: 5, occupancy: null }, { mode: "bus", distanceKm: 5, occupancy: null });
    expect(c.difference).toEqual({ direction: "no-change", gramsCo2: 0, percentOfBaseline: 0 });
  });

  it("is deterministic and proportional to distance", () => {
    const at = (km: number) => compareEmissions({ mode: "two_wheeler", distanceKm: km, occupancy: 1 }, { mode: "walking", distanceKm: km, occupancy: null }).difference?.gramsCo2 ?? 0;
    expect(at(10)).toBe(at(10));
    expect(at(20)).toBeCloseTo(at(10) * 2, 0);
  });
});

describe("missing or invalid inputs are unavailable, never fabricated", () => {
  it("missing distance", () => {
    const e = computeTripEmissions({ mode: "two_wheeler", distanceKm: null, occupancy: 1 });
    expect(e).toMatchObject({ status: "unavailable", reason: "distance-missing", totalGramsPerPassenger: null, gramsPerPassengerKm: null, factor: null });
    const c = compareEmissions({ mode: "two_wheeler", distanceKm: null, occupancy: 1 }, { mode: "bus", distanceKm: 10, occupancy: null });
    expect(c).toMatchObject({ status: "unavailable", reason: "distance-missing", difference: null });
  });

  it.each([0, -4, Number.NaN, Number.POSITIVE_INFINITY])("invalid distance %s", (km) => {
    expect(computeTripEmissions({ mode: "bus", distanceKm: km, occupancy: null }).reason).toBe("invalid-input");
  });

  it("missing occupancy where the factor is per vehicle", () => {
    expect(computeTripEmissions({ mode: "private_car", distanceKm: 8, occupancy: null }).reason).toBe("occupancy-missing");
    expect(computeTripEmissions({ mode: "two_wheeler", distanceKm: 8, occupancy: null }).reason).toBe("occupancy-missing");
  });

  it.each([0, 1.5, -2])("invalid occupancy %s", (occupancy) => {
    expect(computeTripEmissions({ mode: "private_car", distanceKm: 8, occupancy }).reason).toBe("invalid-input");
  });

  it("a carpool needs at least two occupants", () => {
    expect(computeTripEmissions({ mode: "carpool", distanceKm: 8, occupancy: 1 }).reason).toBe("carpool-needs-two-or-more-occupants");
  });

  it("missing emission factor: metro is unavailable and the comparison with it is too", () => {
    const e = computeTripEmissions({ mode: "metro", distanceKm: 10, occupancy: null });
    expect(e).toMatchObject({ status: "unavailable", reason: "no-defensible-factor", totalGramsPerPassenger: null });
    expect(e.detail).toMatch(/unavailable/);
    const c = compareEmissions({ mode: "two_wheeler", distanceKm: 10, occupancy: 1 }, { mode: "metro", distanceKm: 10, occupancy: null });
    expect(c.status).toBe("unavailable");
    expect(c.reason).toBe("no-defensible-factor");
    expect(c.difference).toBeNull();
  });

  it("a registry without a factor for the mode is unavailable, not guessed", () => {
    const registry = { ...EMISSION_FACTORS } as Record<TransportMode, EmissionFactor | undefined>;
    delete registry.bus;
    const e = computeTripEmissions({ mode: "bus", distanceKm: 4, occupancy: null }, registry as Record<TransportMode, EmissionFactor>);
    expect(e.status).toBe("unavailable");
    expect(e.reason).toBe("no-defensible-factor");
  });

  it("works with a factor supplied through the registry (SYNTHETIC factor, to prove the path, not a real metro figure)", () => {
    const registry: Record<TransportMode, EmissionFactor> = {
      ...EMISSION_FACTORS,
      metro: { id: "synthetic-metro", status: "available", mode: "metro", label: "SYNTHETIC metro", unit: "kgCO2/passenger-km", value: 0.02, basis: "tailpipe-co2", gases: "CO2 only", vehicleCategory: "synthetic", needsOccupancy: false, occupancyNote: "n/a", geography: "synthetic", source: null, notes: "synthetic test factor" },
    };
    const c = compareEmissions({ mode: "two_wheeler", distanceKm: 10, occupancy: 1 }, { mode: "metro", distanceKm: 10, occupancy: null }, registry);
    expect(c.status).toBe("available");
    expect(c.alternative.totalGramsPerPassenger).toBe(200);
    expect(c.difference?.gramsCo2).toBe(119);
  });
});
