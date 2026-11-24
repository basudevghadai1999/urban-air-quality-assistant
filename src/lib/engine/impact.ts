import {
  EMISSION_FACTORS,
  type AvailableEmissionFactor,
  type EmissionBasis,
  type EmissionFactor,
  type EmissionSource,
} from "@/config/emissionFactors";

import type { TransportMode } from "./types";

/**
 * Transport emissions and savings.
 *
 *   emissions per passenger (g CO2) = factor x distance (km) x 1000 / occupancy      [per-vehicle factors]
 *                                   = factor x distance (km) x 1000                  [per-passenger factors]
 *   saving = baseline emissions - alternative emissions
 *
 * The factors are tailpipe CO2 only (see `src/config/emissionFactors.ts`): no methane or nitrous
 * oxide (so the true CO2e is somewhat higher), no fuel production, no vehicle lifecycle. Tailpipe CO2,
 * well-to-wheel CO2e and lifecycle emissions are different quantities and are NEVER mixed: every result
 * names its basis.
 *
 * Nothing is estimated from missing inputs. A missing distance, an unknown occupancy where one is
 * needed, or a mode without a defensible factor makes the result "unavailable". The signed saving is
 * reported as a direction plus a non-negative magnitude, so a "saving" can never be negative.
 */

export type EmissionsUnavailableReason =
  | "distance-missing"
  | "occupancy-missing"
  | "carpool-needs-two-or-more-occupants"
  | "no-defensible-factor"
  | "invalid-input";

export interface TripSpec {
  readonly mode: TransportMode;
  /** One-way distance in km. */
  readonly distanceKm: number | null;
  /** People sharing the vehicle (counted for car, two-wheeler and carpool). */
  readonly occupancy: number | null;
}

export interface FactorCitation {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly unit: AvailableEmissionFactor["unit"];
  readonly basis: EmissionBasis;
  readonly gases: AvailableEmissionFactor["gases"];
  readonly vehicleCategory: string;
  readonly occupancyNote: string;
  readonly geography: string;
  readonly source: EmissionSource | null;
  readonly notes: string;
}

export interface TripEmissions {
  readonly status: "available" | "unavailable";
  readonly reason: EmissionsUnavailableReason | null;
  readonly detail: string | null;
  readonly mode: TransportMode;
  readonly factor: FactorCitation | null;
  readonly distanceKm: number | null;
  readonly occupancy: number | null;
  /** Grams of CO2 per passenger per km, tailpipe basis. */
  readonly gramsPerPassengerKm: number | null;
  readonly totalGramsPerPassenger: number | null;
  readonly formula: string;
}

export interface EmissionsComparison {
  readonly status: "available" | "unavailable";
  readonly reason: EmissionsUnavailableReason | null;
  readonly baseline: TripEmissions;
  readonly alternative: TripEmissions;
  readonly difference: {
    readonly direction: "reduction" | "increase" | "no-change";
    /** Always >= 0 (grams of CO2 per passenger, one-way). */
    readonly gramsCo2: number;
    readonly percentOfBaseline: number | null;
  } | null;
  readonly gas: "CO2";
  readonly basis: EmissionBasis;
  readonly note: string;
}

export const EMISSIONS_NOTE =
  "Tailpipe CO2 only, from India-specific fuel-based factors. It excludes methane and nitrous oxide (so CO2e would be somewhat higher), fuel production and vehicle manufacture. Estimates, not measurements of any real trip.";

const round1 = (v: number): number => Math.round(v * 10) / 10;

const formulaFor = (factor: AvailableEmissionFactor | null): string =>
  factor === null
    ? "no formula: no defensible factor"
    : factor.needsOccupancy
      ? "g CO2 per passenger = factor (kg CO2/vehicle-km) x distance (km) x 1000 / occupancy"
      : "g CO2 per passenger = factor (kg CO2/passenger-km) x distance (km) x 1000";

function blocked(spec: TripSpec, reason: EmissionsUnavailableReason, detail: string, factor: EmissionFactor | null): TripEmissions {
  return {
    status: "unavailable",
    reason,
    detail,
    mode: spec.mode,
    factor: null,
    distanceKm: spec.distanceKm,
    occupancy: spec.occupancy,
    gramsPerPassengerKm: null,
    totalGramsPerPassenger: null,
    formula: formulaFor(factor?.status === "available" ? factor : null),
  };
}

export function computeTripEmissions(
  spec: TripSpec,
  registry: Readonly<Record<TransportMode, EmissionFactor>> = EMISSION_FACTORS,
): TripEmissions {
  const factor = registry[spec.mode];
  if (factor === undefined || factor.status === "unavailable") {
    return blocked(spec, "no-defensible-factor", factor?.status === "unavailable" ? factor.reason : "Unknown mode.", factor ?? null);
  }
  if (spec.distanceKm === null) return blocked(spec, "distance-missing", "No trip distance was provided.", factor);
  if (!Number.isFinite(spec.distanceKm) || spec.distanceKm <= 0) {
    return blocked(spec, "invalid-input", "Distance must be a positive number of kilometres.", factor);
  }

  let occupancy: number | null = spec.occupancy;
  if (factor.needsOccupancy) {
    if (occupancy === null) return blocked(spec, "occupancy-missing", "Vehicle occupancy was not provided.", factor);
    if (!Number.isInteger(occupancy) || occupancy < 1) {
      return blocked(spec, "invalid-input", "Occupancy must be a whole number of people, at least 1.", factor);
    }
    if (spec.mode === "carpool" && occupancy < 2) {
      return blocked(spec, "carpool-needs-two-or-more-occupants", "A carpool has at least two people in the vehicle.", factor);
    }
  } else {
    occupancy = null;
  }

  const perKm = factor.needsOccupancy ? (factor.value * 1000) / (occupancy ?? 1) : factor.value * 1000;
  return {
    status: "available",
    reason: null,
    detail: null,
    mode: spec.mode,
    factor: {
      id: factor.id,
      label: factor.label,
      value: factor.value,
      unit: factor.unit,
      basis: factor.basis,
      gases: factor.gases,
      vehicleCategory: factor.vehicleCategory,
      occupancyNote: factor.occupancyNote,
      geography: factor.geography,
      source: factor.source,
      notes: factor.notes,
    },
    distanceKm: spec.distanceKm,
    occupancy,
    gramsPerPassengerKm: round1(perKm),
    totalGramsPerPassenger: round1(perKm * spec.distanceKm),
    formula: formulaFor(factor),
  };
}

export function compareEmissions(
  baseline: TripSpec,
  alternative: TripSpec,
  registry: Readonly<Record<TransportMode, EmissionFactor>> = EMISSION_FACTORS,
): EmissionsComparison {
  const b = computeTripEmissions(baseline, registry);
  const a = computeTripEmissions(alternative, registry);
  const base = { gas: "CO2" as const, basis: "tailpipe-co2" as const, note: EMISSIONS_NOTE, baseline: b, alternative: a };
  if (b.totalGramsPerPassenger === null || a.totalGramsPerPassenger === null) {
    return { ...base, status: "unavailable", reason: b.reason ?? a.reason, difference: null };
  }
  const delta = b.totalGramsPerPassenger - a.totalGramsPerPassenger;
  const magnitude = round1(Math.abs(delta));
  return {
    ...base,
    status: "available",
    reason: null,
    difference: {
      direction: magnitude === 0 ? "no-change" : delta > 0 ? "reduction" : "increase",
      gramsCo2: magnitude,
      percentOfBaseline: b.totalGramsPerPassenger > 0 ? round1((Math.abs(delta) / b.totalGramsPerPassenger) * 100) : null,
    },
  };
}
