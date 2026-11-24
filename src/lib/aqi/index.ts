/**
 * Indian AQI (CPCB) calculation engine: public API.
 *
 * Pure and deterministic: no network, no LLM, no Next.js. Safe on server and client.
 */

export * from "./types";
export {
  BREAKPOINTS,
  OZONE_ONE_HOUR_THRESHOLD_UG_M3,
  POLLUTANT_INFO,
  type PollutantBreakpoints,
  type PollutantInfo,
  type PublishedBand,
  type Segment,
} from "./breakpoints";
export { AQI_CATEGORIES, MAX_AQI, categorizeAqi, getCategory } from "./categories";
export { UG_PER_MG, canonicalUnit, convertConcentration, parseUnit } from "./units";
export {
  MINIMUM_POLLUTANT_COUNT,
  PARTICULATE_POLLUTANTS,
  checkSufficiency,
  isPollutantId,
  validateConcentrationValue,
  validateReadings,
  validateUnit,
  type NormalizedReading,
  type NormalizedReadings,
  type Sufficiency,
} from "./validation";
export {
  CPCB_MIN_VALID_HOURS_24H,
  defaultWindowRequirement,
  parseTimestamp,
  rollingAverageSeries,
  windowAverage,
  type RollingSeriesOptions,
  type WindowAverageOptions,
  type WindowRequirement,
} from "./averaging";
export {
  CPCB_METHODOLOGY,
  ENGINE_VERSION,
  NOT_OFFICIAL_DISCLAIMER,
  OPEN_METEO_MODEL_SOURCE,
  UNSPECIFIED_SOURCE,
  buildProvenanceLabel,
} from "./provenance";
export {
  calculateAqi,
  calculateAqiFromTimeSeries,
  calculateSubIndex,
  type SubIndexOptions,
} from "./calculate";
