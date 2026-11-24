import type { ActivityIntensity } from "@/lib/engine/types";

/**
 * Advisory policy for the outdoor-window engine. CONFIGURABLE ENGINE POLICY, not medical thresholds.
 *
 * ## The scale
 * Windows are compared on the CPCB Indian AQI sub-index scale (0-500), applied to the
 * window-mean hourly model concentration of each pollutant, using the repository's own CPCB
 * breakpoint engine (`calculateSubIndex`). The window indicator is the HIGHEST pollutant
 * sub-index, so a window is never favoured because one pollutant falls while another rises.
 * This is a comparison indicator, NOT an AQI: CPCB's AQI requires 24-hour averages
 * (8-hour for O3 and CO) and station data, and this uses short model windows.
 *
 * ## The levels
 * Category ceilings come from CPCB's AQI categories (technical report Table 3.2, already in
 * `src/lib/aqi/categories.ts`): Good 0-50, Satisfactory 51-100, Moderately Polluted 101-200,
 * Poor 201-300. The mapping from activity effort and sensitivity to a ceiling is the engine's
 * policy: harder breathing and sensitive groups get a stricter ceiling. It is NOT derived from
 * dose-response studies and NO level is described as medically safe.
 */

/** Highest window indicator for which the engine will still call a window "relatively lower-pollution". */
export const WINDOW_INDICATOR_CEILING: Readonly<{
  general: Readonly<Record<ActivityIntensity, number>>;
  sensitive: Readonly<Record<ActivityIntensity, number>>;
}> = {
  general: { light: 200, moderate: 150, vigorous: 100 },
  sensitive: { light: 150, moderate: 100, vigorous: 75 },
};

export const WINDOW_POLICY = {
  /** Candidate start times step by this many minutes. */
  stepMinutes: 30,
  /** Forecast hours from now that are considered. */
  horizonHours: 24,
  /** The best window must be at least this fraction below the median candidate to count as a real difference. */
  minRelativeImprovement: 0.15,
  /** A window this fraction above the median is listed as higher-exposure. */
  higherExposureMargin: 0.15,
  /** Windows listed per category. */
  maxListed: 3,
  /** Trend: compare the mean of the first and last `edgeHours` of the next `trendHours`. */
  trendHours: 12,
  trendEdgeHours: 4,
  trendChangeFraction: 0.1,
  /** Local-clock periods compared for morning / afternoon / evening, [startHour, endHour). */
  periods: {
    morning: [5, 11],
    afternoon: [11, 17],
    evening: [17, 22],
  },
} as const;

/** Pollutants the window engine reads. PM2.5 is required; the rest improve coverage and confidence. */
export const WINDOW_POLLUTANTS = ["pm25", "pm10", "no2", "so2", "o3", "co"] as const;
export const REQUIRED_WINDOW_POLLUTANT = "pm25" as const;

/**
 * Confidence penalties (see `Confidence`): each is the score removed when the condition holds.
 * Engine policy, documented in docs/ENVIRONMENTAL_IMPACT_METHODOLOGY.md.
 */
export const CONFIDENCE_PENALTY = {
  staleData: 0.25,
  pm10Missing: 0.15,
  otherGasMissingEach: 0.04,
  forecastLeadOver12h: 0.1,
  forecastLeadOver24h: 0.2,
  forecastGapsInHorizon: 0.15,
  assumedInput: 0.1,
  noObservedAnchor: 0.1,
  modelOnly: 0.05,
} as const;
