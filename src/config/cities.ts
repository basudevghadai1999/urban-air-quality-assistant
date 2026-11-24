import { INDIA_TIMEZONE } from "@/lib/constants";

/**
 * Target-city registry. This is the ONLY source of coordinates that can reach
 * the upstream air quality API: requests carry a city ID, never a latitude or
 * longitude, so arbitrary user-supplied locations cannot be queried.
 *
 * ## Coordinate methodology
 * Each city's coordinate is its Wikidata `P625` (coordinate location) value,
 * rounded to 4 decimal places (about 11 m, far finer than the model grid).
 * It is cross-checked against the GeoNames record for the same place; the two
 * references agree to within 2.6 km for every city (asserted in the tests). The
 * air quality model grid is far coarser than either coordinate, so the
 * point only selects a grid cell. It is NOT a monitoring station.
 *
 * Verified 2026-11-24:
 *   Delhi (New Delhi)  Wikidata Q987      28.61389 N 77.20889 E   GeoNames 1261481
 *   Mumbai             Wikidata Q1156     19.07583 N 72.87750 E   GeoNames 1275339
 *   Kolkata            Wikidata Q1348     22.56750 N 88.37000 E   GeoNames 1275004
 *   Bengaluru          Wikidata Q1355     12.97912 N 77.59130 E   GeoNames 1277333
 *   Lucknow            Wikidata Q47916    26.84700 N 80.94700 E   GeoNames 1264733
 *   Patna              Wikidata Q80484    25.61000 N 85.14139 E   GeoNames 1260086
 *
 * ## Delhi NCR
 * NCR is a multi-city region, not a point. The data for "delhi-ncr" is the
 * model grid cell over central Delhi (New Delhi); it does NOT represent
 * Gurugram, Noida, Ghaziabad, Faridabad or the rest of the region.
 */

export const CITY_IDS = [
  "delhi-ncr",
  "mumbai",
  "kolkata",
  "bengaluru",
  "lucknow",
  "patna",
] as const;

export type CityId = (typeof CITY_IDS)[number];

export interface CoordinateReference {
  readonly source: "Wikidata" | "GeoNames";
  readonly id: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly url: string;
}

export interface City {
  /** Stable, URL-safe identifier. Never changes once published. */
  readonly id: CityId;
  readonly displayName: string;
  readonly state: string;
  readonly country: string;
  readonly countryCode: "IN";
  /** WGS84 decimal degrees. */
  readonly latitude: number;
  readonly longitude: number;
  readonly timezone: typeof INDIA_TIMEZONE;
  /** What the data actually represents, to be shown wherever the data is. */
  readonly dataLocation: string;
  readonly coordinateReferences: readonly CoordinateReference[];
}

const wikidata = (id: string, latitude: number, longitude: number): CoordinateReference => ({
  source: "Wikidata",
  id,
  latitude,
  longitude,
  url: `https://www.wikidata.org/wiki/${id}`,
});

const geonames = (id: string, latitude: number, longitude: number): CoordinateReference => ({
  source: "GeoNames",
  id,
  latitude,
  longitude,
  url: `https://www.geonames.org/${id}`,
});

const CITY_LIST: readonly City[] = [
  {
    id: "delhi-ncr",
    displayName: "Delhi NCR",
    state: "Delhi",
    country: "India",
    countryCode: "IN",
    latitude: 28.6139,
    longitude: 77.2089,
    timezone: INDIA_TIMEZONE,
    dataLocation:
      "Central Delhi (New Delhi) model grid cell. Not the whole National Capital Region: Gurugram, Noida, Ghaziabad and Faridabad are not represented.",
    coordinateReferences: [wikidata("Q987", 28.6139, 77.2089), geonames("1261481", 28.62137, 77.2148)],
  },
  {
    id: "mumbai",
    displayName: "Mumbai",
    state: "Maharashtra",
    country: "India",
    countryCode: "IN",
    latitude: 19.0758,
    longitude: 72.8775,
    timezone: INDIA_TIMEZONE,
    dataLocation: "Mumbai city-centre model grid cell.",
    coordinateReferences: [wikidata("Q1156", 19.0758, 72.8775), geonames("1275339", 19.07283, 72.88261)],
  },
  {
    id: "kolkata",
    displayName: "Kolkata",
    state: "West Bengal",
    country: "India",
    countryCode: "IN",
    latitude: 22.5675,
    longitude: 88.37,
    timezone: INDIA_TIMEZONE,
    dataLocation: "Kolkata city-centre model grid cell.",
    coordinateReferences: [wikidata("Q1348", 22.5675, 88.37), geonames("1275004", 22.56263, 88.36304)],
  },
  {
    id: "bengaluru",
    displayName: "Bengaluru",
    state: "Karnataka",
    country: "India",
    countryCode: "IN",
    latitude: 12.9791,
    longitude: 77.5913,
    timezone: INDIA_TIMEZONE,
    dataLocation: "Bengaluru city-centre model grid cell.",
    coordinateReferences: [wikidata("Q1355", 12.9791, 77.5913), geonames("1277333", 12.97194, 77.59369)],
  },
  {
    id: "lucknow",
    displayName: "Lucknow",
    state: "Uttar Pradesh",
    country: "India",
    countryCode: "IN",
    latitude: 26.847,
    longitude: 80.947,
    timezone: INDIA_TIMEZONE,
    dataLocation: "Lucknow city-centre model grid cell.",
    coordinateReferences: [wikidata("Q47916", 26.847, 80.947), geonames("1264733", 26.83928, 80.92313)],
  },
  {
    id: "patna",
    displayName: "Patna",
    state: "Bihar",
    country: "India",
    countryCode: "IN",
    latitude: 25.61,
    longitude: 85.1414,
    timezone: INDIA_TIMEZONE,
    dataLocation: "Patna city-centre model grid cell.",
    coordinateReferences: [wikidata("Q80484", 25.61, 85.1414), geonames("1260086", 25.59408, 85.13563)],
  },
];

const CITIES: Readonly<Record<CityId, City>> = Object.freeze(
  Object.fromEntries(CITY_LIST.map((city) => [city.id, Object.freeze(city)])) as Record<CityId, City>,
);

/** Type guard. Uses an explicit allow-list, so "constructor" or "__proto__" never match. */
export function isCityId(value: unknown): value is CityId {
  return typeof value === "string" && (CITY_IDS as readonly string[]).includes(value);
}

/** The configured city for `id`, or undefined for anything not in the registry. */
export function getCityById(id: string): City | undefined {
  return isCityId(id) ? CITIES[id] : undefined;
}

/** All configured cities, in CITY_IDS order. */
export function getAllCities(): readonly City[] {
  return CITY_IDS.map((id) => CITIES[id]);
}
