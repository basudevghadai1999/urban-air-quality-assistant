import { roundToDecimals } from "@/lib/utils";

import type {
  AqiCategoryId,
  AveragingPeriodHours,
  ConcentrationUnit,
  PollutantId,
} from "./types";
import { POLLUTANT_IDS } from "./types";

/**
 * CPCB Indian AQI breakpoints.
 *
 * ## Sources (read in full for this implementation)
 *
 * 1. CPCB, "National Air Quality Index", Control of Urban Pollution Series
 *    CUPS/82/2014-15 (58 pp.), Table 3.11 "Breakpoints for AQI Scale 0-500".
 *    https://airquality.cpcb.gov.in/ccr_docs/FINAL-REPORT_AQI_.pdf
 * 2. CPCB, "About National Air Quality Index" (1 p.).
 *    https://airquality.cpcb.gov.in/ccr_docs/About_AQI.pdf
 * 3. CPCB, "How is AQI calculated?" (1 p.).
 *    https://airquality.cpcb.gov.in/ccr_docs/How_AQI_Calculated.pdf
 *
 * The values below are Table 3.11. They are NOT US EPA breakpoints.
 *
 * ## Published-table ambiguities, and the decision taken for each
 *
 * A. **Endpoint spelling differs between CPCB documents.** About_AQI.pdf prints
 *    Pb Satisfactory as "0.5-1.0", CO Poor/Very Poor as "10-17"/"17-34", and
 *    NH3 Very Poor as "1200-1800". Table 3.11 (and How_AQI_Calculated.pdf) print
 *    "0.6-1.0", "10.1-17", "17.1-34" and "1201-1800". Those printed in About_AQI
 *    would make adjacent bands share an endpoint. DECISION: use Table 3.11, whose
 *    bands do not overlap.
 *
 * B. **Gaps between bands.** On each pollutant's own reporting resolution the
 *    published bands leave gaps (PM2.5 "0-30" then "31-60": nothing covers 30.5).
 *    CPCB defines BHI as the breakpoint concentration >= Cp and BLO as the one
 *    <= Cp, with IHI/ILO the AQI values at those breakpoints. DECISION: treat
 *    every published endpoint as a (concentration, AQI) breakpoint and
 *    interpolate linearly between consecutive ones. Inside a band this is
 *    exactly CPCB's formula; across a gap (30 -> 31 maps AQI 50 -> 51) it is the
 *    same formula applied to the breakpoints either side of Cp. The scale is
 *    therefore continuous and monotone, and no truncation is needed.
 *    (The word "truncated" appears only in a third-party reproduction of the
 *    CPCB leaflet, not in CPCB's own documents, so no truncation is applied.)
 *
 * C. **Severe ("250+") has no upper concentration bound** and no stated lower
 *    bound beyond "greater than the Very Poor upper bound". DECISION:
 *    - Severe begins one reporting step above the Very Poor upper bound, where
 *      the step is the gap CPCB itself uses between every pair of adjacent bands
 *      for that pollutant (1 ug/m3, or 0.1 for CO and Pb). The 400 -> 401 link
 *      is interpolated like any other gap.
 *    - Default policy "extrapolate-capped": above that, assume the Severe band
 *      spans the same concentration width as the Very Poor band, scale linearly
 *      from 401 to 500, and hold at 500. This is an ENGINE ASSUMPTION, not a CPCB
 *      rule. The AQI category (Severe) is unaffected; only the number inside it.
 *      Every such sub-index is flagged (segment.kind) and warned about.
 *    - Alternative policy "published-floor": report Severe as 401 and nothing
 *      higher, with no invented slope.
 *
 * D. **Ozone Very Poor / Severe use 1-hour values.** Table 3.8 labels the O3
 *    748 / 748+ breakpoints "1-hr monitoring values", and Table 3.11 footnotes
 *    them "One hourly monitoring (for mathematical calculation only)". See
 *    calculate.ts for how this is applied.
 *
 * Averaging periods (Table 3.11 header): 24-hour for PM10, PM2.5, NO2, SO2, NH3
 * and Pb; 8-hour for O3 and CO.
 */

/** AQI value ranges per category (CPCB Table 3.2). */
const INDEX_RANGE: Record<AqiCategoryId, readonly [number, number]> = {
  good: [0, 50],
  satisfactory: [51, 100],
  moderately_polluted: [101, 200],
  poor: [201, 300],
  very_poor: [301, 400],
  severe: [401, 500],
};

const CATEGORY_ORDER: readonly AqiCategoryId[] = [
  "good",
  "satisfactory",
  "moderately_polluted",
  "poor",
  "very_poor",
  "severe",
];

export interface PollutantInfo {
  readonly id: PollutantId;
  readonly label: string;
  /** The unit CPCB's breakpoints are expressed in. No implicit conversion is ever applied. */
  readonly unit: ConcentrationUnit;
  readonly averagingHours: AveragingPeriodHours;
}

export const POLLUTANT_INFO: Readonly<Record<PollutantId, PollutantInfo>> = {
  pm25: { id: "pm25", label: "PM2.5", unit: "ug/m3", averagingHours: 24 },
  pm10: { id: "pm10", label: "PM10", unit: "ug/m3", averagingHours: 24 },
  no2: { id: "no2", label: "NO2", unit: "ug/m3", averagingHours: 24 },
  so2: { id: "so2", label: "SO2", unit: "ug/m3", averagingHours: 24 },
  o3: { id: "o3", label: "O3", unit: "ug/m3", averagingHours: 8 },
  co: { id: "co", label: "CO", unit: "mg/m3", averagingHours: 8 },
  nh3: { id: "nh3", label: "NH3", unit: "ug/m3", averagingHours: 24 },
  pb: { id: "pb", label: "Pb", unit: "ug/m3", averagingHours: 24 },
};

/** [low, high] concentration per category, as printed in Table 3.11. `null` high = open-ended "X+". */
type PublishedRow = readonly [
  good: readonly [number, number],
  satisfactory: readonly [number, number],
  moderate: readonly [number, number],
  poor: readonly [number, number],
  veryPoor: readonly [number, number],
  severe: readonly [number, null],
];

/**
 * CPCB Table 3.11, transcribed. For Severe, the number is the published "X+"
 * threshold: concentrations ABOVE it are Severe (it equals the Very Poor upper bound).
 */
const TABLE_3_11: Readonly<Record<PollutantId, PublishedRow>> = {
  pm10: [[0, 50], [51, 100], [101, 250], [251, 350], [351, 430], [430, null]],
  pm25: [[0, 30], [31, 60], [61, 90], [91, 120], [121, 250], [250, null]],
  no2: [[0, 40], [41, 80], [81, 180], [181, 280], [281, 400], [400, null]],
  o3: [[0, 50], [51, 100], [101, 168], [169, 208], [209, 748], [748, null]],
  co: [[0, 1.0], [1.1, 2.0], [2.1, 10], [10.1, 17], [17.1, 34], [34, null]],
  so2: [[0, 40], [41, 80], [81, 380], [381, 800], [801, 1600], [1600, null]],
  nh3: [[0, 200], [201, 400], [401, 800], [801, 1200], [1201, 1800], [1800, null]],
  pb: [[0, 0.5], [0.6, 1.0], [1.1, 2.0], [2.1, 3.0], [3.1, 3.5], [3.5, null]],
};

export interface PublishedBand {
  readonly category: AqiCategoryId;
  readonly concentrationLow: number;
  /** `null` for Severe: no published upper bound. */
  readonly concentrationHigh: number | null;
  readonly indexLow: number;
  readonly indexHigh: number;
}

/** One linear piece of the continuous concentration -> sub-index scale. */
export interface Segment {
  readonly kind: "band" | "inter-band" | "severe";
  readonly concentrationLow: number;
  readonly concentrationHigh: number;
  readonly indexLow: number;
  readonly indexHigh: number;
}

export interface PollutantBreakpoints {
  readonly pollutant: PollutantId;
  readonly bands: readonly PublishedBand[];
  /** Gap CPCB leaves between adjacent bands for this pollutant (derived from the table). */
  readonly reportingStep: number;
  readonly segments: readonly Segment[];
}

function bandsFor(pollutant: PollutantId): PublishedBand[] {
  const row = TABLE_3_11[pollutant];
  return row.map(([low, high], position) => {
    const category = CATEGORY_ORDER[position];
    if (category === undefined) throw new Error("breakpoint row has too many bands");
    const [indexLow, indexHigh] = INDEX_RANGE[category];
    return { category, concentrationLow: low, concentrationHigh: high, indexLow, indexHigh };
  });
}

function build(pollutant: PollutantId): PollutantBreakpoints {
  const bands = bandsFor(pollutant);
  const [good, satisfactory, , , veryPoor] = bands;
  if (!good || !satisfactory || !veryPoor || good.concentrationHigh === null) {
    throw new Error(`incomplete breakpoint table for ${pollutant}`);
  }
  const reportingStep = roundToDecimals(
    satisfactory.concentrationLow - good.concentrationHigh,
    6,
  );

  const segments: Segment[] = [];
  // Bands 0-4 are bounded; each is followed by the link to the next band.
  for (let i = 0; i < 5; i += 1) {
    const band = bands[i];
    const next = bands[i + 1];
    if (!band || !next || band.concentrationHigh === null) {
      throw new Error(`incomplete breakpoint table for ${pollutant}`);
    }
    segments.push({
      kind: "band",
      concentrationLow: band.concentrationLow,
      concentrationHigh: band.concentrationHigh,
      indexLow: band.indexLow,
      indexHigh: band.indexHigh,
    });

    // Severe begins one reporting step above the Very Poor upper bound.
    const nextLow =
      i === 4 ? roundToDecimals(band.concentrationHigh + reportingStep, 6) : next.concentrationLow;
    segments.push({
      kind: "inter-band",
      concentrationLow: band.concentrationHigh,
      concentrationHigh: nextLow,
      indexLow: band.indexHigh,
      indexHigh: next.indexLow,
    });
  }

  const severe = bands[5];
  if (!severe || veryPoor.concentrationHigh === null) {
    throw new Error(`incomplete breakpoint table for ${pollutant}`);
  }
  const severeLow = roundToDecimals(veryPoor.concentrationHigh + reportingStep, 6);
  const veryPoorWidth = roundToDecimals(
    veryPoor.concentrationHigh - veryPoor.concentrationLow,
    6,
  );
  segments.push({
    kind: "severe",
    concentrationLow: severeLow,
    concentrationHigh: roundToDecimals(severeLow + veryPoorWidth, 6),
    indexLow: severe.indexLow,
    indexHigh: severe.indexHigh,
  });

  return Object.freeze({
    pollutant,
    bands: Object.freeze(bands),
    reportingStep,
    segments: Object.freeze(segments),
  });
}

export const BREAKPOINTS: Readonly<Record<PollutantId, PollutantBreakpoints>> =
  Object.freeze(
    Object.fromEntries(POLLUTANT_IDS.map((id) => [id, build(id)])) as Record<
      PollutantId,
      PollutantBreakpoints
    >,
  );

/** O3 8-hour averages above this (the Poor upper bound) trigger the 1-hour-value rule. */
export const OZONE_ONE_HOUR_THRESHOLD_UG_M3 = 208;
