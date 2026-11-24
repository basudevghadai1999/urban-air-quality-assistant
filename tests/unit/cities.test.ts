import { describe, expect, it } from "vitest";

import { CITY_IDS, getAllCities, getCityById, isCityId } from "@/config/cities";

const haversineKm = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number => {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371.0088 * Math.asin(Math.sqrt(h));
};

describe("city registry", () => {
  it("contains exactly the seven target cities in a stable order", () => {
    expect([...CITY_IDS]).toEqual(["delhi-ncr", "mumbai", "kolkata", "bengaluru", "lucknow", "patna", "bhubaneswar"]);
    expect(getAllCities().map((c) => c.id)).toEqual([...CITY_IDS]);
  });

  it("defines every required field for every city", () => {
    for (const city of getAllCities()) {
      expect(city.id).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(city.displayName.length).toBeGreaterThan(0);
      expect(city.state.length).toBeGreaterThan(0);
      expect(city.country).toBe("India");
      expect(city.countryCode).toBe("IN");
      expect(city.dataLocation.length).toBeGreaterThan(10);
    }
  });

  it("has coordinates inside India's bounding box", () => {
    for (const city of getAllCities()) {
      expect(city.latitude).toBeGreaterThan(6);
      expect(city.latitude).toBeLessThan(37.5);
      expect(city.longitude).toBeGreaterThan(68);
      expect(city.longitude).toBeLessThan(98);
    }
  });

  it("uses a valid IANA timezone, Asia/Kolkata, for every city", () => {
    for (const city of getAllCities()) {
      expect(city.timezone).toBe("Asia/Kolkata");
      expect(() => new Intl.DateTimeFormat("en", { timeZone: city.timezone })).not.toThrow();
    }
  });

  it("places each city near its known location (sanity check against well-known pairs)", () => {
    const near = (id: string, latitude: number, longitude: number, km: number) => {
      const city = getCityById(id);
      expect(city).toBeDefined();
      if (city) expect(haversineKm(city, { latitude, longitude })).toBeLessThan(km);
    };
    // Loose, independent landmarks: city-centre points known to within a few km.
    near("delhi-ncr", 28.6139, 77.209, 5); // Connaught Place / India Gate area
    near("mumbai", 18.94, 72.835, 20); // CSMT / Gateway of India; Mumbai is ~60 km long, so allow 20 km
    near("kolkata", 22.5726, 88.3639, 5); // Esplanade
    near("bengaluru", 12.9716, 77.5946, 5); // Vidhana Soudha area
    near("lucknow", 26.8467, 80.9462, 5);
    near("patna", 25.5941, 85.1376, 8);
    near("bhubaneswar", 20.2667, 85.8333, 8); // city centre, about 20 deg 16 min N 85 deg 50 min E
  });

  it("agrees with both coordinate references to within 3 km", () => {
    for (const city of getAllCities()) {
      expect(city.coordinateReferences.map((r) => r.source).sort()).toEqual(["GeoNames", "Wikidata"]);
      for (const reference of city.coordinateReferences) {
        expect(haversineKm(city, reference)).toBeLessThan(3);
        expect(reference.url).toMatch(/^https:\/\/www\.(wikidata|geonames)\.org\//);
      }
    }
  });

  it("includes Bhubaneswar in Odisha with both coordinate references", () => {
    const city = getCityById("bhubaneswar");
    expect(city?.displayName).toBe("Bhubaneswar");
    expect(city?.state).toBe("Odisha");
    expect(city?.coordinateReferences.map((r) => r.id).sort()).toEqual(["1275817", "Q171771"]);
  });

  it("labels Delhi's data as central Delhi, not the whole NCR", () => {
    const delhi = getCityById("delhi-ncr");
    expect(delhi?.dataLocation).toMatch(/central Delhi/i);
    expect(delhi?.dataLocation).toMatch(/not the whole/i);
  });

  it("has no duplicate coordinates", () => {
    const keys = getAllCities().map((c) => `${c.latitude},${c.longitude}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("city lookup", () => {
  it("returns the city for a configured ID", () => {
    expect(getCityById("bengaluru")).toMatchObject({ displayName: "Bengaluru", state: "Karnataka" });
  });

  it.each([
    "atlantis",
    "",
    "Mumbai", // IDs are case-sensitive
    "delhi",
    " mumbai",
    "constructor",
    "__proto__",
    "toString",
    "hasOwnProperty",
    "28.6,77.2",
  ])("rejects %j", (id) => {
    expect(getCityById(id)).toBeUndefined();
    expect(isCityId(id)).toBe(false);
  });

  it("isCityId rejects non-strings", () => {
    for (const value of [null, undefined, 1, {}, [], ["mumbai"]]) {
      expect(isCityId(value)).toBe(false);
    }
  });

  it("returns frozen city objects", () => {
    expect(Object.isFrozen(getCityById("patna"))).toBe(true);
  });
});
