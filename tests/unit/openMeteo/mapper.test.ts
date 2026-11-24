import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { getCityById } from "@/config/cities";
import { OpenMeteoError } from "@/lib/data/openMeteo/errors";
import { mapOpenMeteoResponse } from "@/lib/data/openMeteo/mapper";
import { openMeteoResponseSchema } from "@/lib/data/openMeteo/schema";

import {
  CURRENT_BLOCK_S,
  CURRENT_HOUR_S,
  FETCHED_AT_MS,
  HOUR,
  makeOpenMeteoResponse,
  type FixtureOptions,
} from "../../fixtures/openMeteo";

const city = getCityById("delhi-ncr")!;

const map = (options: FixtureOptions = {}, fetchedAtMs = FETCHED_AT_MS) =>
  mapOpenMeteoResponse(openMeteoResponseSchema.parse(makeOpenMeteoResponse(options)), city, fetchedAtMs);

describe("variable mapping and units", () => {
  it("maps all six provider variables to internal pollutant IDs", () => {
    const mapped = map();
    const last = mapped.historical.at(-1);
    expect(Object.keys(last?.values ?? {}).sort()).toEqual(["co", "no2", "o3", "pm10", "pm25", "so2"]);
    expect(last?.values).toEqual({ pm25: 40, pm10: 120, co: 1500, no2: 30, so2: 20, o3: 50 });
  });

  it("preserves the provider's source units exactly as reported", () => {
    const { sourceUnits } = map();
    expect(Object.keys(sourceUnits).sort()).toEqual(["co", "no2", "o3", "pm10", "pm25", "so2"]);
    for (const unit of Object.values(sourceUnits)) expect(unit).toBe("μg/m³");
  });

  it("marks NH3 and Pb as not provided, and the six others as available", () => {
    const { pollutantAvailability } = map();
    expect(pollutantAvailability).toHaveLength(8);
    const byId = Object.fromEntries(pollutantAvailability.map((a) => [a.pollutant, a]));
    for (const id of ["pm25", "pm10", "no2", "so2", "o3", "co"]) expect(byId[id]?.status).toBe("available");
    expect(byId.nh3).toMatchObject({ status: "unavailable", reason: "not-provided-by-provider" });
    expect(byId.pb).toMatchObject({ status: "unavailable", reason: "not-provided-by-provider" });
  });

  it("never infers or fabricates values for NH3 or Pb", () => {
    const mapped = map();
    for (const record of [...mapped.historical, ...mapped.forecast]) {
      expect(record.values).not.toHaveProperty("nh3");
      expect(record.values).not.toHaveProperty("pb");
    }
    expect(mapped.aqiSeries.map((s) => s.pollutant)).not.toContain("nh3");
    expect(mapped.aqiSeries.map((s) => s.pollutant)).not.toContain("pb");
  });
});

describe("explicit CO conversion", () => {
  it("converts CO from ug/m3 to mg/m3 for the AQI input only", () => {
    const mapped = map();
    const co = mapped.aqiSeries.find((s) => s.pollutant === "co");
    expect(co?.unit).toBe("mg/m3");
    expect(co?.observations.every((o) => o.value === 1.5)).toBe(true);
  });

  it("leaves dataset values in the source unit", () => {
    const mapped = map();
    expect(mapped.historical.every((r) => r.values.co === 1500)).toBe(true);
    expect(mapped.forecast.every((r) => r.values.co === 1500)).toBe(true);
  });

  it("leaves every other pollutant unconverted, in ug/m3", () => {
    const mapped = map();
    for (const id of ["pm25", "pm10", "no2", "so2", "o3"]) {
      const series = mapped.aqiSeries.find((s) => s.pollutant === id);
      expect(series?.unit).toBe("ug/m3");
    }
    expect(mapped.aqiSeries.find((s) => s.pollutant === "pm25")?.observations.every((o) => o.value === 40)).toBe(true);
  });

  it("removes float noise via the AQI engine's converter (1.005 mg/m3 case)", () => {
    // 1005 / 1000 must be exactly 1.005, with no 1.0050000000000001 artefact.
    const mapped = map({ values: { carbon_monoxide: () => 1005 } });
    expect(mapped.aqiSeries.find((s) => s.pollutant === "co")?.observations[0]?.value).toBe(1.005);
  });

  it("records the conversion in the contract, and only when CO is present", () => {
    expect(map().unitConversions).toEqual([
      { pollutant: "co", from: "ug/m3", to: "mg/m3", factor: 0.001, appliedTo: "cpcb-aqi-input" },
    ]);
    expect(map({ omit: ["carbon_monoxide"] }).unitConversions).toEqual([]);
  });

  it("keeps null CO values null rather than converting them to zero", () => {
    const mapped = map({ values: { carbon_monoxide: (i) => (i % 2 === 0 ? null : 1500) } });
    const values = mapped.aqiSeries.find((s) => s.pollutant === "co")?.observations.map((o) => o.value);
    expect(values).toContain(null);
    expect(values).not.toContain(0);
  });
});

describe("unit verification (no guessing)", () => {
  it("excludes a pollutant reported in an unexpected unit, and does not convert it", () => {
    const mapped = map({ units: { carbon_monoxide: "ppm" } });
    const co = mapped.pollutantAvailability.find((a) => a.pollutant === "co");
    expect(co).toMatchObject({ status: "unavailable", reason: "unexpected-unit", sourceUnit: "ppm" });
    expect(mapped.warnings.map((w) => w.code)).toContain("UNEXPECTED_UNIT");
    expect(mapped.aqiSeries.find((s) => s.pollutant === "co")?.observations).toEqual([]);
    expect(mapped.historical.at(-1)?.values).not.toHaveProperty("co");
    expect(mapped.sourceUnits).not.toHaveProperty("co");
    expect(mapped.unitConversions).toEqual([]);
  });

  it("excludes a particulate series reported in mg/m3 rather than rescaling it", () => {
    const mapped = map({ units: { pm2_5: "mg/m³" } });
    expect(mapped.pollutantAvailability.find((a) => a.pollutant === "pm25")?.reason).toBe("unexpected-unit");
    expect(mapped.aqiSeries.find((s) => s.pollutant === "pm25")?.observations).toEqual([]);
  });

  it("accepts Greek mu, micro sign and ASCII spellings of ug/m3", () => {
    for (const unit of ["μg/m³", "µg/m³", "ug/m3"]) {
      const mapped = map({ units: { pm10: unit } });
      expect(mapped.pollutantAvailability.find((a) => a.pollutant === "pm10")?.status).toBe("available");
    }
  });

  it("flags a missing variable and an all-null variable differently", () => {
    const missing = map({ omit: ["ozone"] });
    expect(missing.pollutantAvailability.find((a) => a.pollutant === "o3")?.reason).toBe("variable-missing");
    expect(missing.warnings.map((w) => w.code)).toContain("VARIABLE_MISSING");

    const allNull = map({ values: { ozone: () => null } });
    expect(allNull.pollutantAvailability.find((a) => a.pollutant === "o3")?.reason).toBe("no-valid-data");
    expect(allNull.warnings.map((w) => w.code)).toContain("NO_VALID_DATA");
  });
});

describe("historical vs forecast separation", () => {
  it("splits at the provider's current time: 25 historical points, 48 forecast points", () => {
    const mapped = map();
    expect(mapped.historical).toHaveLength(25); // 24 past hours + the current hour
    expect(mapped.forecast).toHaveLength(48);
    expect(mapped.historical.length + mapped.forecast.length).toBe(73);
  });

  it("puts no future instant in the historical set and no past instant in the forecast set", () => {
    const mapped = map();
    const referenceMs = CURRENT_BLOCK_S * 1000;
    expect(mapped.historical.every((r) => r.epochSeconds * 1000 <= referenceMs)).toBe(true);
    expect(mapped.forecast.every((r) => r.epochSeconds * 1000 > referenceMs)).toBe(true);
  });

  it("ends history at the current completed local hour (13:00 IST) and starts the forecast the hour after", () => {
    const mapped = map();
    expect(mapped.historical.at(-1)?.epochSeconds).toBe(CURRENT_HOUR_S);
    expect(mapped.historical.at(-1)?.time).toBe("2026-11-24T13:00:00+05:30");
    expect(mapped.forecast[0]?.epochSeconds).toBe(CURRENT_HOUR_S + HOUR);
    expect(mapped.forecast[0]?.time).toBe("2026-11-24T14:00:00+05:30");
    expect(mapped.windowEndMs).toBe(CURRENT_HOUR_S * 1000);
  });

  it("is a partition: nothing lost, nothing duplicated, still in order", () => {
    const mapped = map();
    const all = [...mapped.historical, ...mapped.forecast].map((r) => r.epochSeconds);
    expect(new Set(all).size).toBe(all.length);
    expect([...all].sort((a, b) => a - b)).toEqual(all);
  });

  it("feeds ONLY historical hours to the AQI input, even when forecast values are wild", () => {
    const mapped = map({ values: { pm2_5: (offset) => (offset > 0 ? 9_999 : 40) } });
    const pm25 = mapped.aqiSeries.find((s) => s.pollutant === "pm25");
    expect(pm25?.observations).toHaveLength(25);
    expect(pm25?.observations.every((o) => o.value === 40)).toBe(true);
    const newest = Math.max(...(pm25?.observations.map((o) => Number(o.timestamp)) ?? []));
    expect(newest).toBe(CURRENT_HOUR_S * 1000);
    // ...while the forecast dataset still carries them, separately.
    expect(mapped.forecast.every((r) => r.values.pm25 === 9_999)).toBe(true);
  });

  it("never lets the reference time run ahead of our own clock", () => {
    // Our clock says 11:47 IST (two hours before the provider's 13:30 snapshot).
    const skewed = map({}, FETCHED_AT_MS - 2 * HOUR * 1000);
    expect(skewed.windowEndMs).toBe((CURRENT_HOUR_S - 2 * HOUR) * 1000);
    expect(skewed.historical.every((r) => r.epochSeconds * 1000 <= FETCHED_AT_MS - 2 * HOUR * 1000)).toBe(true);
    expect(skewed.forecast[0]?.epochSeconds).toBe(CURRENT_HOUR_S - HOUR); // 12:00 is after 11:47
  });

  it("falls back to our fetch time when the provider sends no current block", () => {
    const mapped = map({ includeCurrent: false });
    expect(mapped.current).toBeNull();
    expect(mapped.warnings.map((w) => w.code)).toContain("CURRENT_CONDITIONS_UNAVAILABLE");
    expect(mapped.windowEndMs).toBe(CURRENT_HOUR_S * 1000);
  });

  it("reports no historical data when every instant is in the future", () => {
    const mapped = map({ pastHours: 0, forecastHours: 3 }, FETCHED_AT_MS - 3 * HOUR * 1000);
    expect(mapped.historical).toHaveLength(0);
    expect(mapped.windowEndMs).toBeNull();
    expect(mapped.warnings.map((w) => w.code)).toContain("NO_HISTORICAL_DATA");
  });
});

describe("timestamps", () => {
  it("renders every record in Asia/Kolkata (+05:30) and preserves the absolute instant", () => {
    const mapped = map();
    for (const record of [...mapped.historical, ...mapped.forecast]) {
      expect(record.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\+05:30$/);
      expect(Date.parse(record.time)).toBe(record.epochSeconds * 1000);
    }
  });

  it("preserves the provider's current-conditions timestamp (13:30 IST on a UTC-hour boundary)", () => {
    const { current } = map();
    expect(current?.timestamp).toBe("2026-11-24T13:30:00+05:30");
    expect(current?.epochSeconds).toBe(CURRENT_BLOCK_S);
    expect(current?.intervalSeconds).toBe(3_600);
    expect(current?.kind).toBe("model-snapshot");
  });

  it("only includes current values whose unit was verified", () => {
    const { current } = map({ units: { ozone: "ppm" } });
    expect(current?.values).not.toHaveProperty("o3");
    expect(current?.values.pm25).toBe(40);
  });

  it("rejects a response whose timezone or offset is not the configured one", () => {
    const wrongZone = () => map({ timezone: "Europe/Berlin" });
    const wrongOffset = () => map({ utcOffsetSeconds: 3_600 });
    for (const attempt of [wrongZone, wrongOffset]) {
      try {
        attempt();
        throw new Error("expected a throw");
      } catch (error) {
        expect(error).toBeInstanceOf(OpenMeteoError);
        expect((error as OpenMeteoError).code).toBe("UPSTREAM_INVALID_RESPONSE");
      }
    }
  });

  it("records the grid cell the provider actually used", () => {
    expect(map().grid).toEqual({ latitude: 28.599998, longitude: 77.20001 });
  });
});

describe("real recorded response", () => {
  it("maps cleanly: 24 historical + 47 forecast hours, all six pollutants, no warnings", () => {
    const path = fileURLToPath(new URL("../../fixtures/open-meteo-delhi-recorded.json", import.meta.url));
    const recorded = openMeteoResponseSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    // The recording was fetched at 2026-11-24T08:17:11Z.
    const mapped = mapOpenMeteoResponse(recorded, city, Date.UTC(2026, 10, 24, 8, 17, 11));
    expect(mapped.historical).toHaveLength(24);
    expect(mapped.forecast).toHaveLength(47);
    expect(mapped.historical.at(-1)?.time).toBe("2026-11-24T13:00:00+05:30");
    expect(mapped.warnings).toEqual([]);
    expect(mapped.pollutantAvailability.filter((a) => a.status === "available")).toHaveLength(6);
    expect(mapped.current?.timestamp).toBe("2026-11-24T13:30:00+05:30");
  });
});
