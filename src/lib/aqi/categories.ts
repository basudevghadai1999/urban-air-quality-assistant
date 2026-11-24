import type { AqiCategory, AqiCategoryId } from "./types";

/**
 * Indian AQI categories and ranges: CPCB technical report, Table 3.2.
 * (Labels follow the CPCB leaflet: "Moderately polluted", "Very poor".)
 */
export const AQI_CATEGORIES: readonly AqiCategory[] = Object.freeze([
  { id: "good", label: "Good", min: 0, max: 50, rank: 0 },
  { id: "satisfactory", label: "Satisfactory", min: 51, max: 100, rank: 1 },
  { id: "moderately_polluted", label: "Moderately Polluted", min: 101, max: 200, rank: 2 },
  { id: "poor", label: "Poor", min: 201, max: 300, rank: 3 },
  { id: "very_poor", label: "Very Poor", min: 301, max: 400, rank: 4 },
  { id: "severe", label: "Severe", min: 401, max: 500, rank: 5 },
]);

export const MAX_AQI = 500;

/** Category for a whole-number AQI between 0 and 500. */
export function categorizeAqi(index: number): AqiCategory {
  if (!Number.isInteger(index) || index < 0 || index > MAX_AQI) {
    throw new RangeError(`AQI must be a whole number from 0 to ${MAX_AQI}`);
  }
  const category = AQI_CATEGORIES.find((c) => index >= c.min && index <= c.max);
  if (!category) throw new RangeError("AQI category table has a gap");
  return category;
}

export function getCategory(id: AqiCategoryId): AqiCategory {
  const category = AQI_CATEGORIES.find((c) => c.id === id);
  if (!category) throw new RangeError(`Unknown AQI category: ${id}`);
  return category;
}
