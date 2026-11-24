import type { TransportMode } from "@/lib/engine/types";

/**
 * Transport emission factors. Every number here was read from the cited primary
 * document (verified 2026-11-24); none is invented, rounded or interpolated.
 * A mode without a defensible factor is listed as `unavailable` with the reason, and
 * the engine then reports that comparison as unavailable instead of guessing.
 *
 * ## What the numbers are
 * India GHG Program, "India Specific Road Transport Emission Factors", Version 1.0, 2015
 * (WRI India / CII / TERI; "For Stakeholder Consultation": a draft, not a final standard).
 *   Method: fuel consumed per km (published fuel efficiency, raised by an "uplift" for
 *   real-world driving) multiplied by a fuel CO2 factor. So the numbers are:
 *     - CO2 ONLY (no methane or nitrous oxide), hence a lower bound of CO2e;
 *     - TAILPIPE / fuel-combustion emissions only: no fuel production (well-to-tank),
 *       no vehicle manufacture or road building (lifecycle).
 *   Uplift included in the figures below: 10% for two-wheelers, 8% for cars (paper sections 4 and 5.3).
 *   Two-wheeler and car factors are PER VEHICLE-km: the paper gives no occupancy for them, so
 *   the engine divides by an explicit occupancy supplied by the caller. The bus factor is per
 *   PASSENGER-km, derived from State Road Transport Undertaking averages (so it embeds their
 *   typical loading, and the paper says it does not apply to BRT or intercity services).
 *
 * ## What is NOT used, and why
 * Metro/rail: electricity-based emissions need an energy-per-passenger-km figure from a
 * primary source (for example the operator's traction energy and passenger-km). We could not
 * retrieve one from a primary document, so metro is `unavailable`. The grid factor needed once
 * that figure exists is recorded in `GRID_EMISSION_FACTOR`.
 * Walking and cycling: no fuel is burned, so tailpipe CO2 is zero by definition. Food-related
 * and equipment lifecycle emissions are NOT counted, and the engine says so.
 */

export type EmissionBasis = "tailpipe-co2";

export interface EmissionSource {
  readonly title: string;
  readonly publisher: string;
  readonly year: number;
  readonly url: string;
  readonly locator: string;
}

export type FactorUnit = "kgCO2/vehicle-km" | "kgCO2/passenger-km";

export interface AvailableEmissionFactor {
  readonly id: string;
  readonly status: "available";
  readonly mode: TransportMode;
  readonly label: string;
  readonly unit: FactorUnit;
  readonly value: number;
  readonly basis: EmissionBasis;
  /** Gases included. */
  readonly gases: "CO2 only";
  readonly vehicleCategory: string;
  /** Whether the engine must divide by an occupancy supplied by the caller. */
  readonly needsOccupancy: boolean;
  readonly occupancyNote: string;
  readonly geography: string;
  readonly source: EmissionSource | null;
  readonly notes: string;
}

export interface UnavailableEmissionFactor {
  readonly id: string;
  readonly status: "unavailable";
  readonly mode: TransportMode;
  readonly label: string;
  readonly reason: string;
}

export type EmissionFactor = AvailableEmissionFactor | UnavailableEmissionFactor;

export const INDIA_GHG_ROAD_TRANSPORT_2015: EmissionSource = {
  title: "India Specific Road Transport Emission Factors, Version 1.0 (for stakeholder consultation)",
  publisher: "India GHG Program (WRI India, CII, TERI)",
  year: 2015,
  url: "https://indiaghgp.org/sites/default/files/Road%20Transport%20Technical%20Paper.pdf",
  locator: "Executive summary, 'Summary of Emission Factors' tables; section 5.4 for buses",
};

const GEOGRAPHY = "India (national averages; not city-specific)";

export const EMISSION_FACTORS: Readonly<Record<TransportMode, EmissionFactor>> = {
  two_wheeler: {
    id: "in-ghgp-2015-motorcycle-lt125cc",
    status: "available",
    mode: "two_wheeler",
    label: "Motorcycle, under 125 cc (petrol)",
    unit: "kgCO2/vehicle-km",
    value: 0.0319,
    basis: "tailpipe-co2",
    gases: "CO2 only",
    vehicleCategory: "Motorcycle <125 CC",
    needsOccupancy: true,
    occupancyNote: "Per vehicle-km; divided by the occupancy the caller supplies (1 = rider only).",
    geography: GEOGRAPHY,
    source: INDIA_GHG_ROAD_TRANSPORT_2015,
    notes:
      "Value with the paper's 10% real-world uplift (0.0290 without). The paper lists other classes (scooters, larger motorcycles); this one is the engine's representative commuter class, an engine choice.",
  },
  private_car: {
    id: "in-ghgp-2015-hatchback-lt1400cc-petrol",
    status: "available",
    mode: "private_car",
    label: "Hatchback, under 1400 cc (petrol)",
    unit: "kgCO2/vehicle-km",
    value: 0.14,
    basis: "tailpipe-co2",
    gases: "CO2 only",
    vehicleCategory: "Hatchback <1400 CC, Gasoline",
    needsOccupancy: true,
    occupancyNote: "Per vehicle-km; divided by the occupancy the caller supplies.",
    geography: GEOGRAPHY,
    source: INDIA_GHG_ROAD_TRANSPORT_2015,
    notes:
      "Value with the paper's 8% real-world uplift (0.130 without). The paper lists 40 car classes; this one is the engine's representative class, an engine choice. Diesel, SUV and larger classes are higher.",
  },
  carpool: {
    id: "in-ghgp-2015-hatchback-lt1400cc-petrol-carpool",
    status: "available",
    mode: "carpool",
    label: "Hatchback, under 1400 cc (petrol), shared",
    unit: "kgCO2/vehicle-km",
    value: 0.14,
    basis: "tailpipe-co2",
    gases: "CO2 only",
    vehicleCategory: "Hatchback <1400 CC, Gasoline",
    needsOccupancy: true,
    occupancyNote: "Same vehicle factor as the private car; the saving comes only from sharing it among more people.",
    geography: GEOGRAPHY,
    source: INDIA_GHG_ROAD_TRANSPORT_2015,
    notes: "Carpooling does not change vehicle emissions; it divides them among occupants.",
  },
  bus: {
    id: "in-ghgp-2015-intracity-bus",
    status: "available",
    mode: "bus",
    label: "Intra-city bus (State Road Transport Undertaking average)",
    unit: "kgCO2/passenger-km",
    value: 0.015161,
    basis: "tailpipe-co2",
    gases: "CO2 only",
    vehicleCategory: "Intra-city bus (diesel)",
    needsOccupancy: false,
    occupancyNote: "Per passenger-km; already reflects the loading of State Road Transport Undertaking buses.",
    geography: GEOGRAPHY,
    source: INDIA_GHG_ROAD_TRANSPORT_2015,
    notes:
      "Paper: not applicable to BRT or intercity services. Derived from undertaking-wide averages, so a specific city's buses may differ.",
  },
  walking: {
    id: "zero-tailpipe-walking",
    status: "available",
    mode: "walking",
    label: "Walking",
    unit: "kgCO2/passenger-km",
    value: 0,
    basis: "tailpipe-co2",
    gases: "CO2 only",
    vehicleCategory: "Human-powered",
    needsOccupancy: false,
    occupancyNote: "Not applicable.",
    geography: "Not applicable",
    source: null,
    notes:
      "Zero because no fuel is burned: a definition, not a measurement. Food and footwear lifecycle emissions are not counted.",
  },
  cycling: {
    id: "zero-tailpipe-cycling",
    status: "available",
    mode: "cycling",
    label: "Cycling",
    unit: "kgCO2/passenger-km",
    value: 0,
    basis: "tailpipe-co2",
    gases: "CO2 only",
    vehicleCategory: "Human-powered",
    needsOccupancy: false,
    occupancyNote: "Not applicable.",
    geography: "Not applicable",
    source: null,
    notes:
      "Zero because no fuel is burned: a definition, not a measurement. Food and bicycle lifecycle emissions are not counted.",
  },
  metro: {
    id: "unavailable-metro",
    status: "unavailable",
    mode: "metro",
    label: "Metro / urban rail",
    reason:
      "No primary-source energy-per-passenger-km figure could be retrieved, and the engine does not estimate one. Metro CO2 comparisons are therefore unavailable until a sourced figure is added.",
  },
};

/**
 * Indian grid emission factor, recorded for the metro comparison once a sourced traction-energy
 * figure is available. NOT used in any current calculation.
 * Source: CEA, "CO2 Baseline Database for the Indian Power Sector", User Guide Version 19.0 (December 2023),
 * Table S-1 and S-2, financial year 2022-23, adjusted for cross-border transfers. A newer version may exist:
 * versions after 19.0 could not be retrieved. CO2 only; generation-side (no transmission/distribution losses).
 */
export const GRID_EMISSION_FACTOR = {
  fiscalYear: "2022-23",
  /** t CO2/MWh, weighted average excluding renewables (Table S-1). */
  weightedAverageExcludingRes: 0.823,
  /** t CO2/MWh, weighted average including renewables and captive injection (Table S-2). */
  weightedAverageIncludingRes: 0.716,
  source: {
    title: "CO2 Baseline Database for the Indian Power Sector, User Guide Version 19.0",
    publisher: "Central Electricity Authority, Ministry of Power, Government of India",
    year: 2023,
    url: "https://cea.nic.in/api/cdm-report-version/view-pdf/en/74",
    locator: "Table S-1 and Table S-2",
  },
} as const;
