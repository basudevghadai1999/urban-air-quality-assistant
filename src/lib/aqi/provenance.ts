import { CPCB_MIN_VALID_HOURS_24H } from "./averaging";
import { MINIMUM_POLLUTANT_COUNT } from "./validation";
import type { DataSource, MethodologyInfo } from "./types";

/**
 * Provenance: the METHOD (CPCB's AQI recipe) and the DATA SOURCE are described
 * separately, and the label never claims an official CPCB reading.
 */

export const ENGINE_VERSION = "1.0.0";

export const NOT_OFFICIAL_DISCLAIMER =
  "A calculated estimate. It is not an official CPCB station AQI, a government measurement, or a real-time CPCB reading.";

/** Open-Meteo Air Quality API serves atmospheric MODEL output, not station measurements. */
export const OPEN_METEO_MODEL_SOURCE: DataSource = Object.freeze({
  kind: "model-estimate",
  name: "Open-Meteo model data",
  url: "https://open-meteo.com/en/docs/air-quality-api",
});

export const UNSPECIFIED_SOURCE: DataSource = Object.freeze({
  kind: "unspecified",
  name: "unspecified data",
});

const EM_DASH = "—";

/**
 * Human-readable provenance statement. Model estimates are always prefixed
 * "Estimated". For the Open-Meteo source this yields exactly:
 * "Estimated Indian AQI — calculated using CPCB methodology and Open-Meteo model data."
 */
export function buildProvenanceLabel(source: DataSource): string {
  switch (source.kind) {
    case "model-estimate":
      return `Estimated Indian AQI ${EM_DASH} calculated using CPCB methodology and ${source.name}.`;
    case "station-observation":
      return `Indian AQI ${EM_DASH} calculated using CPCB methodology and ${source.name}.`;
    case "unspecified":
      return `Indian AQI ${EM_DASH} calculated using CPCB methodology; data source not specified.`;
  }
}

export const CPCB_METHODOLOGY: MethodologyInfo = Object.freeze({
  name: "CPCB National Air Quality Index (Indian AQI)",
  engineVersion: ENGINE_VERSION,
  breakpointTable:
    "CPCB technical report CUPS/82/2014-15, Table 3.11 (AQI scale 0-500)",
  formula: "Ip = [(IHI - ILO) / (BHI - BLO)] x (Cp - BLO) + ILO",
  aggregation:
    "Overall AQI is the maximum pollutant sub-index; that pollutant is the dominant pollutant.",
  rounding:
    "Sub-indices and the overall AQI are rounded half-up to whole numbers. CPCB's own example (PM2.5 45 ug/m3 -> 75) is only reproducible by rounding to nearest (74.66 -> 75).",
  references: Object.freeze([
    "https://airquality.cpcb.gov.in/ccr_docs/FINAL-REPORT_AQI_.pdf",
    "https://airquality.cpcb.gov.in/ccr_docs/About_AQI.pdf",
    "https://airquality.cpcb.gov.in/ccr_docs/How_AQI_Calculated.pdf",
  ]),
  minimumPollutants: MINIMUM_POLLUTANT_COUNT,
  requiresParticulateMatter: true,
  minimumValidHoursFor24HourAverage: CPCB_MIN_VALID_HOURS_24H,
  engineAssumptions: Object.freeze([
    "Published endpoints are treated as (concentration, AQI) breakpoints and interpolated linearly, including across the small gaps between bands (e.g. PM2.5 30 -> 31 maps 50 -> 51). No truncation is applied; CPCB's own documents do not prescribe one.",
    "Where CPCB documents print different endpoints, Table 3.11 is used (Pb Satisfactory starts at 0.6, CO Poor at 10.1 and Very Poor at 17.1, NH3 Very Poor at 1201).",
    "CPCB publishes no upper concentration bound for Severe. By default the Severe band is assumed to span the same concentration width as Very Poor, scaled 401-500 and capped at 500. The category is unaffected; the number inside Severe is an estimate.",
    "CPCB gives no minimum-data rule for 8-hour averages. The default scales its 16-of-24-hour rule to 6 of 8 hours.",
    "Ozone Very Poor and Severe breakpoints are CPCB 1-hour values. When the 8-hour ozone average exceeds 208 ug/m3, a supplied 1-hour value is used for the sub-index; without one, the 8-hour value is used and a warning is raised.",
  ]),
});
