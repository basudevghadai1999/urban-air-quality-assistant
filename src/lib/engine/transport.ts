import { EMISSION_FACTORS, type EmissionFactor } from "@/config/emissionFactors";

import { buildConfidence } from "./confidence";
import { CONFIDENCE_PENALTY } from "@/config/advisoryThresholds";
import { compareEmissions, computeTripEmissions, type EmissionsComparison, type TripEmissions, type TripSpec } from "./impact";
import {
  TRANSPORT_MODES,
  type Confidence,
  type Explanation,
  type ResolvedPreferences,
  type SeverityLevel,
  type TransportMode,
} from "./types";

/**
 * Transport comparison.
 *
 * Each option is described on THREE separate axes, deliberately not collapsed into one score:
 *   1. environmental impact   tailpipe CO2 per passenger (impact.ts), or unavailable
 *   2. personal exposure      a QUALITATIVE direction only: the engine has no route or in-vehicle
 *                             measurements, so it never quantifies mode-specific exposure
 *   3. convenience            travel time where it is known or reasonably assumed, else not assessed
 * A lower-carbon option is not automatically a lower-exposure one: walking and cycling emit no tailpipe
 * CO2 but raise the breathing rate, so they are held back when air quality is poor.
 *
 * Route-level pollution data does not exist in this system, so nothing is claimed about specific roads.
 */

export const MODE_LABELS: Readonly<Record<TransportMode, string>> = {
  private_car: "Private car",
  two_wheeler: "Two-wheeler",
  metro: "Metro",
  bus: "Bus",
  carpool: "Carpool",
  walking: "Walking",
  cycling: "Cycling",
};

/** Engine policy, not measurements. Documented in docs/ENVIRONMENTAL_IMPACT_METHODOLOGY.md. */
export const TRANSPORT_POLICY = {
  walkingSpeedKmh: 5,
  cyclingSpeedKmh: 15,
  /** Longest one-way trip the engine treats as practical for a daily commute on foot or by bicycle. */
  maxWalkingKm: 3,
  maxCyclingKm: 10,
  /** Convenience: walking/cycling is "high" if it takes at most this multiple of the current commute time. */
  convenienceTimeRatio: 1.25,
  /** Default occupancy assumed for a carpool alternative when the household does not state one. */
  defaultCarpoolOccupancy: 3,
} as const;

type ExposureDirection = "lower" | "higher" | "unknown";
type Enclosure = "open" | "enclosed" | "mixed";

const ENCLOSURE: Readonly<Record<TransportMode, Enclosure>> = {
  two_wheeler: "open",
  walking: "open",
  cycling: "open",
  private_car: "enclosed",
  carpool: "enclosed",
  metro: "enclosed",
  bus: "mixed",
};

const ACTIVE: ReadonlySet<TransportMode> = new Set(["walking", "cycling"]);

export interface ExposureView {
  readonly direction: ExposureDirection;
  readonly quantified: false;
  readonly rationale: string;
}

export interface ConvenienceView {
  readonly rating: "high" | "medium" | "low" | "not-assessed";
  readonly travelMinutes: number | null;
  readonly travelTimeBasis: "user-provided" | "engine-assumption" | "not-provided";
  readonly notes: string;
}

export interface TransportOption {
  readonly mode: TransportMode;
  readonly label: string;
  readonly isBaseline: boolean;
  readonly emissions: TripEmissions;
  /** Versus the baseline mode. Null for the baseline itself. */
  readonly emissionsVsBaseline: EmissionsComparison | null;
  readonly exposure: ExposureView;
  readonly convenience: ConvenienceView;
  readonly practical: { readonly feasible: boolean; readonly note: string };
  /** Whether the engine puts this option forward right now, and why or why not. */
  readonly suggested: boolean;
  readonly suggestionNote: string;
  /** One line contrasting the three axes. */
  readonly tradeoff: string;
  readonly explanation: Explanation;
}

export interface TransportSection {
  readonly status: "available" | "partial";
  readonly baselineMode: TransportMode;
  readonly distanceKm: number;
  readonly distanceIsAssumed: boolean;
  readonly options: readonly TransportOption[];
  readonly routeData: { readonly available: false; readonly note: string };
}

export interface TransportInput {
  readonly preferences: ResolvedPreferences;
  readonly severity: SeverityLevel;
  /** Registry override for tests. */
  readonly registry?: Readonly<Record<TransportMode, EmissionFactor>>;
}

const ROUTE_NOTE =
  "Route-level pollution data is not available: this system has no verified route or roadside provider, so no road-specific exposure is claimed. Exposure directions below are qualitative only.";

function exposureView(baseline: TransportMode, alt: TransportMode): ExposureView {
  if (baseline === alt) {
    return { direction: "unknown", quantified: false, rationale: "This is the current mode; it is the reference for the comparison." };
  }
  const b = ENCLOSURE[baseline];
  const a = ENCLOSURE[alt];
  if (ACTIVE.has(alt) && b === "open") {
    return {
      direction: "unknown",
      quantified: false,
      rationale:
        "Both are open-air. Walking and cycling raise the breathing rate while riding a two-wheeler is in traffic, so the engine cannot say which is lower for this trip.",
    };
  }
  if (ACTIVE.has(alt)) {
    return {
      direction: "higher",
      quantified: false,
      rationale:
        "Walking and cycling are open-air and raise the breathing rate, so more particles are typically inhaled per minute than when seated in an enclosed vehicle. Actual exposure depends on the route, which is not known.",
    };
  }
  if (b === "open" && a === "enclosed") {
    return {
      direction: "lower",
      quantified: false,
      rationale:
        "An enclosed vehicle or train can reduce contact with roadside air compared with an open two-wheeler, but in-vehicle levels vary with ventilation settings, traffic and route. Qualitative only.",
    };
  }
  if (b === "enclosed" && a === "open") {
    return { direction: "higher", quantified: false, rationale: "Open-air travel gives more direct contact with roadside air than an enclosed vehicle. Qualitative only." };
  }
  return {
    direction: "unknown",
    quantified: false,
    rationale:
      a === "mixed"
        ? "Bus windows and ventilation vary, so the engine cannot say whether in-vehicle exposure is lower."
        : "Both are in the same broad class, so the engine cannot say which gives lower exposure.",
  };
}

function convenienceView(mode: TransportMode, prefs: ResolvedPreferences): ConvenienceView {
  if (mode === prefs.preferredTransport) {
    return { rating: "high", travelMinutes: prefs.commuteMinutes, travelTimeBasis: "user-provided", notes: "Your current commute time." };
  }
  if (mode === "walking" || mode === "cycling") {
    const speed = mode === "walking" ? TRANSPORT_POLICY.walkingSpeedKmh : TRANSPORT_POLICY.cyclingSpeedKmh;
    const minutes = Math.round((prefs.commuteDistanceKm / speed) * 60);
    const ok = minutes <= prefs.commuteMinutes * TRANSPORT_POLICY.convenienceTimeRatio;
    return {
      rating: ok ? "high" : "low",
      travelMinutes: minutes,
      travelTimeBasis: "engine-assumption",
      notes: `Estimated at ${speed} km/h over ${prefs.commuteDistanceKm} km; ${ok ? "close to" : "longer than"} your current commute time.`,
    };
  }
  if (mode === "carpool") {
    return { rating: "medium", travelTimeBasis: "not-provided", travelMinutes: null, notes: "Needs coordination with other riders; travel time is not assessed." };
  }
  return {
    rating: "not-assessed",
    travelMinutes: null,
    travelTimeBasis: "not-provided",
    notes: "Service frequency, stops and journey time depend on local routes, which this system does not have.",
  };
}

function practicalView(mode: TransportMode, distanceKm: number): { feasible: boolean; note: string } {
  if (mode === "walking") {
    const ok = distanceKm <= TRANSPORT_POLICY.maxWalkingKm;
    return { feasible: ok, note: ok ? "Within a typical walking distance." : `Over ${TRANSPORT_POLICY.maxWalkingKm} km one way, beyond the engine's practical walking limit.` };
  }
  if (mode === "cycling") {
    const ok = distanceKm <= TRANSPORT_POLICY.maxCyclingKm;
    return { feasible: ok, note: ok ? "Within a typical cycling distance." : `Over ${TRANSPORT_POLICY.maxCyclingKm} km one way, beyond the engine's practical cycling limit.` };
  }
  return { feasible: true, note: "No distance limit applied." };
}

function tripFor(mode: TransportMode, prefs: ResolvedPreferences): TripSpec {
  const occupancy =
    mode === "carpool"
      ? Math.max(prefs.vehicleOccupancy, TRANSPORT_POLICY.defaultCarpoolOccupancy)
      : mode === prefs.preferredTransport
        ? prefs.vehicleOccupancy
        : mode === "private_car" || mode === "two_wheeler"
          ? 1
          : null;
  return { mode, distanceKm: prefs.commuteDistanceKm, occupancy };
}

export function compareTransport(input: TransportInput): TransportSection {
  const { preferences: prefs, severity } = input;
  const registry = input.registry ?? EMISSION_FACTORS;
  const baselineMode = prefs.preferredTransport;
  const baselineTrip: TripSpec = { mode: baselineMode, distanceKm: prefs.commuteDistanceKm, occupancy: prefs.vehicleOccupancy };
  const poor = severity === "high" || severity === "very-high";

  const options: TransportOption[] = TRANSPORT_MODES.map((mode) => {
    const isBaseline = mode === baselineMode;
    const trip = isBaseline ? baselineTrip : tripFor(mode, prefs);
    const emissions = computeTripEmissions(trip, registry);
    const vsBaseline = isBaseline ? null : compareEmissions(baselineTrip, trip, registry);
    const exposure = exposureView(baselineMode, mode);
    const convenience = convenienceView(mode, prefs);
    const practical = practicalView(mode, prefs.commuteDistanceKm);

    const reduces = vsBaseline?.difference?.direction === "reduction";
    const activeAndPoor = ACTIVE.has(mode) && poor;
    const candidate = !isBaseline && practical.feasible && (reduces || exposure.direction === "lower");
    const suggested = candidate && !activeAndPoor;

    let suggestionNote: string;
    if (isBaseline) suggestionNote = "Current mode.";
    else if (!practical.feasible) suggestionNote = practical.note;
    else if (activeAndPoor) {
      suggestionNote =
        "Not put forward while air quality is poor: it emits no tailpipe CO2, but effort raises the breathing rate, and lower carbon is not lower exposure. Reconsider on a day with a relatively lower-pollution window.";
    } else if (suggested) {
      suggestionNote = reduces
        ? "Lower tailpipe CO2 than the current mode for this trip."
        : "Qualitatively lower exposure than the current mode; its CO2 comparison is unavailable.";
    } else suggestionNote = "No clear environmental or exposure advantage over the current mode on the data available.";

    const co2 = emissions.totalGramsPerPassenger === null ? "unavailable" : `${emissions.totalGramsPerPassenger} g CO2 per passenger, one way`;
    const tradeoff =
      `Environment: ${co2}. Exposure: ${exposure.direction === "unknown" ? "cannot be compared" : `qualitatively ${exposure.direction} than ${MODE_LABELS[baselineMode]}`}. ` +
      `Convenience: ${convenience.rating === "not-assessed" ? "not assessed" : `${convenience.rating}${convenience.travelMinutes === null ? "" : `, about ${convenience.travelMinutes} min`}`}.`;

    const factors = [
      ...(prefs.distanceIsAssumed
        ? [{ id: "assumed-distance", penalty: CONFIDENCE_PENALTY.assumedInput, detail: "The trip distance is a preset default, not provided by you." }]
        : []),
      { id: "qualitative-exposure", penalty: 0.15, detail: "Mode exposure is qualitative: there are no route or in-vehicle measurements." },
      ...(emissions.status === "unavailable" ? [{ id: "emissions-unavailable", penalty: 0.3, detail: emissions.detail ?? "Emissions unavailable." }] : []),
    ];
    const confidence: Confidence = buildConfidence(factors);

    const explanation: Explanation = {
      what: isBaseline ? `Reference: your current mode, ${MODE_LABELS[mode]}.` : `Compare ${MODE_LABELS[mode]} with your current ${MODE_LABELS[baselineMode]}.`,
      why: suggestionNote,
      triggeredBy: [
        { kind: "preference", ref: "preferredTransport", detail: baselineMode },
        { kind: "preference", ref: "commuteDistanceKm", detail: `${prefs.commuteDistanceKm}${prefs.distanceIsAssumed ? " (preset default)" : ""}` },
        { kind: "rule", ref: "RULE_TRANSPORT_THREE_AXES" },
        ...(ACTIVE.has(mode) ? [{ kind: "rule" as const, ref: "RULE_ACTIVE_MODE_HELD_BACK_WHEN_POOR" }] : []),
      ],
      assumptionIds: [
        "ASM_EMISSION_FACTORS_TAILPIPE_CO2",
        ...(emissions.factor?.source === null || mode === "walking" || mode === "cycling" ? ["ASM_ACTIVE_MODES_ZERO_TAILPIPE"] : []),
        ...(mode === "walking" || mode === "cycling" ? ["ASM_ACTIVE_TRAVEL_SPEEDS"] : []),
        ...(mode === "carpool" ? ["ASM_CARPOOL_OCCUPANCY"] : []),
        ...(prefs.distanceIsAssumed ? ["ASM_PRESET_DISTANCE"] : []),
        "ASM_MODE_EXPOSURE_QUALITATIVE",
      ],
      ruleIds: ["RULE_TRANSPORT_THREE_AXES", ...(ACTIVE.has(mode) ? ["RULE_ACTIVE_MODE_HELD_BACK_WHEN_POOR"] : [])],
      impact: vsBaseline?.difference
        ? `${vsBaseline.difference.direction === "no-change" ? "No change in" : vsBaseline.difference.direction === "reduction" ? "About" : "About"} ${vsBaseline.difference.gramsCo2} g tailpipe CO2 per passenger one way (${vsBaseline.difference.direction}).`
        : emissions.status === "unavailable"
          ? "CO2 comparison unavailable."
          : null,
      confidence,
    };

    return { mode, label: MODE_LABELS[mode], isBaseline, emissions, emissionsVsBaseline: vsBaseline, exposure, convenience, practical, suggested, suggestionNote, tradeoff, explanation };
  });

  const baselineOk = options.find((o) => o.isBaseline)?.emissions.status === "available";
  return {
    status: baselineOk && options.every((o) => o.emissions.status === "available") ? "available" : "partial",
    baselineMode,
    distanceKm: prefs.commuteDistanceKm,
    distanceIsAssumed: prefs.distanceIsAssumed,
    options,
    routeData: { available: false, note: ROUTE_NOTE },
  };
}
