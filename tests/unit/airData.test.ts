import { describe, expect, it } from "vitest";

import { getCityById } from "@/config/cities";
import { AIR_DATA_DISCLAIMER } from "@/lib/constants";
import {
  PROVIDER_LAG_LIMIT_SECONDS,
  buildAirSnapshot,
  buildUnavailableAirData,
  describeAge,
  presentSnapshot,
} from "@/lib/data/airData";
import { mapOpenMeteoResponse } from "@/lib/data/openMeteo/mapper";
import { openMeteoResponseSchema } from "@/lib/data/openMeteo/schema";

import { FETCHED_AT_MS, HOUR, makeOpenMeteoResponse, type FixtureOptions } from "../fixtures/openMeteo";

const city = getCityById("delhi-ncr")!;
const TTL = 900;

const snapshotFrom = (raw: Record<string, unknown>, fetchedAtMs = FETCHED_AT_MS) => {
  const mapped = mapOpenMeteoResponse(openMeteoResponseSchema.parse(raw), city, fetchedAtMs);
  return buildAirSnapshot(mapped, city, fetchedAtMs, TTL);
};
const snapshot = (options: FixtureOptions = {}, fetchedAtMs = FETCHED_AT_MS) =>
  snapshotFrom(makeOpenMeteoResponse(options), fetchedAtMs);

/** Synthetic scenario inputs. Expected sub-indices are hand-computed from CPCB Table 3.11. */
describe("CPCB AQI from the historical window", () => {
  it("computes a valid estimate from six pollutants", () => {
    // pm25 40 -> 66.2; pm10 120 -> 113.6; no2 30 -> 37.5; so2 20 -> 25; o3 50 -> 50; co 1.5 mg/m3 -> 72.8
    const { calculatedAqi } = snapshot();
    expect(calculatedAqi?.status).toBe("valid");
    if (calculatedAqi?.status !== "valid") return;
    expect(calculatedAqi.subIndices.map((s) => [s.pollutant, s.index])).toEqual([
      ["pm25", 66],
      ["pm10", 114],
      ["no2", 38],
      ["so2", 25],
      ["o3", 50],
      ["co", 73],
    ]);
    expect(calculatedAqi.aqi).toBe(114);
    expect(calculatedAqi.dominantPollutant).toBe("pm10");
    expect(calculatedAqi.category.id).toBe("moderately_polluted");
  });

  it("converts CO to mg/m3 before scoring (1500 ug/m3 is 1.5 mg/m3, not 1500)", () => {
    const { calculatedAqi } = snapshot();
    const co = calculatedAqi?.subIndices.find((s) => s.pollutant === "co");
    expect(co?.concentration).toMatchObject({ value: 1.5, unit: "mg/m3" });
    expect(co?.category).toBe("satisfactory");
  });

  it("reports NH3 and Pb as missing, treats nothing as zero, and says coverage is partial", () => {
    const data = snapshot();
    expect(data.missingPollutants).toEqual(["nh3", "pb"]);
    expect(data.dataCompleteness).toMatchObject({ level: "partial", availablePollutantCount: 6, requirementsMet: true });
    expect(data.calculatedAqi?.warnings.map((w) => w.code)).toContain("PARTIAL_POLLUTANT_COVERAGE");
    expect(data.calculatedAqi?.subIndices.map((s) => s.pollutant)).not.toContain("nh3");
  });

  it("labels the result as an estimate from Open-Meteo model data, never official", () => {
    const aqi = snapshot().calculatedAqi;
    expect(aqi?.provenanceLabel).toBe(
      "Estimated Indian AQI — calculated using CPCB methodology and Open-Meteo model data.",
    );
    expect(aqi?.dataSource).toMatchObject({ kind: "model-estimate", name: "Open-Meteo model data" });
    expect(aqi?.provenanceLabel).not.toMatch(/official|government|real-time/i);
    expect(aqi?.warnings.map((w) => w.code)).toContain("MODEL_DATA_NOT_OFFICIAL");
  });

  it("keeps the methodology and the provider source separately identifiable", () => {
    const data = snapshot();
    expect(data.source).toBe("open-meteo");
    expect(data.sourceInfo.kind).toBe("atmospheric-model");
    expect(data.calculatedAqi?.methodology.name).toMatch(/CPCB/);
    expect(JSON.stringify(data.calculatedAqi?.methodology)).not.toMatch(/open-meteo/i);
  });

  it("carries the required UI-ready disclaimer verbatim", () => {
    expect(snapshot().disclaimer).toBe(
      "Estimated Indian AQI calculated using CPCB methodology and Open-Meteo atmospheric model data. This is not an official CPCB monitoring-station reading.",
    );
    expect(AIR_DATA_DISCLAIMER).toBe(snapshot().disclaimer);
  });

  it("carries the attribution Open-Meteo's licence requires", () => {
    const { attribution, licence } = snapshot().sourceInfo;
    expect(attribution).toMatch(/Open-Meteo/);
    expect(attribution).toMatch(/CC BY 4\.0/);
    expect(attribution).toMatch(/Copernicus/);
    expect(licence).toMatch(/CC BY 4\.0/);
  });
});

describe("temporal handling: no future data in the current AQI", () => {
  const baseline = snapshot().calculatedAqi;

  it("is unchanged when every forecast value is extreme", () => {
    const wild = snapshot({
      values: {
        pm2_5: (o) => (o > 0 ? 5_000 : 40),
        pm10: (o) => (o > 0 ? 5_000 : 120),
        ozone: (o) => (o > 0 ? 5_000 : 50),
        carbon_monoxide: (o) => (o > 0 ? 900_000 : 1500),
      },
    });
    expect(wild.calculatedAqi).toEqual(baseline);
    // The forecast is still delivered, in its own dataset.
    expect(wild.forecastHourlyData.hours[0]?.values.pm25).toBe(5_000);
  });

  it("is unchanged when only the very first future hour is extreme", () => {
    const edge = snapshot({ values: { pm2_5: (o) => (o === 1 ? 5_000 : 40) } });
    expect(edge.calculatedAqi).toEqual(baseline);
  });

  it("does not use the single current-conditions snapshot", () => {
    const raw = makeOpenMeteoResponse() as { current: Record<string, number> };
    raw.current.pm2_5 = 900;
    raw.current.pm10 = 900;
    const data = snapshotFrom(raw as unknown as Record<string, unknown>);
    expect(data.calculatedAqi).toEqual(baseline);
    // Reported separately, unmodified:
    expect(data.currentConditions?.values.pm25).toBe(900);
    expect(data.currentConditions?.kind).toBe("model-snapshot");
  });

  it("ends the averaging window at the latest instant at or before 'now'", () => {
    const data = snapshot();
    expect(data.dataTimestamp).toBe("2026-11-24T13:00:00+05:30");
    expect(data.calculatedAqi?.observationTime).toBe("2026-11-24T07:30:00.000Z");
  });

  it("keeps historical and forecast datasets disjoint, correctly labelled, and in order", () => {
    const { historicalHourlyData: past, forecastHourlyData: future } = snapshot();
    expect(past.kind).toBe("historical-model");
    expect(future.kind).toBe("forecast-model");
    expect(past.hours).toHaveLength(25);
    expect(future.hours).toHaveLength(48);
    expect(past.label).toMatch(/not station observations/i);
    expect(future.label).toMatch(/predictions, not observations/i);
    const lastPast = past.hours.at(-1)?.epochSeconds ?? 0;
    const firstFuture = future.hours[0]?.epochSeconds ?? 0;
    expect(firstFuture).toBeGreaterThan(lastPast);
    expect(past.rangeEnd).toBe("2026-11-24T13:00:00+05:30");
    expect(future.rangeStart).toBe("2026-11-24T14:00:00+05:30");
    expect(future.rangeEnd).toBe("2026-11-26T13:00:00+05:30");
  });

  it("never describes forecast data as observed or current", () => {
    const text = JSON.stringify({ label: snapshot().forecastHourlyData.label });
    expect(text).not.toMatch(/observed|measured|current/i);
  });
});

describe("temporal handling: incomplete averaging windows", () => {
  it("excludes a 24-hour pollutant with fewer than CPCB's 16 valid hours and still scores the rest", () => {
    // PM2.5 valid only for the newest 10 of 25 historical hours.
    const data = snapshot({ values: { pm2_5: (o) => (o > -10 ? 40 : null) } });
    expect(data.calculatedAqi?.status).toBe("valid");
    expect(data.calculatedAqi?.availablePollutants).not.toContain("pm25");
    expect(data.missingPollutants).toContain("pm25");
    const window = data.calculatedAqi?.completeness.windows.find((w) => w.pollutant === "pm25");
    expect(window).toMatchObject({ status: "incomplete", requiredSource: "CPCB" });
    expect(window?.stats).toMatchObject({ validHours: 10, requiredValidHours: 16 });
    expect(data.calculatedAqi?.warnings.map((w) => w.code)).toContain("INCOMPLETE_WINDOW_EXCLUDED");
  });

  it("accepts exactly 16 valid hours (the CPCB minimum)", () => {
    const data = snapshot({ values: { pm2_5: (o) => (o > -16 ? 40 : null) } });
    expect(data.calculatedAqi?.availablePollutants).toContain("pm25");
    expect(data.calculatedAqi?.completeness.windows.find((w) => w.pollutant === "pm25")?.stats.validHours).toBe(16);
  });

  it("rejects 15 valid hours", () => {
    const data = snapshot({ values: { pm2_5: (o) => (o > -15 ? 40 : null) } });
    expect(data.calculatedAqi?.availablePollutants).not.toContain("pm25");
  });

  it("applies the 8-hour window to O3 and CO: 5 valid hours is not enough", () => {
    const data = snapshot({ values: { ozone: (o) => (o > -5 ? 50 : null) } });
    expect(data.calculatedAqi?.availablePollutants).not.toContain("o3");
    const window = data.calculatedAqi?.completeness.windows.find((w) => w.pollutant === "o3");
    expect(window).toMatchObject({ status: "incomplete", requiredSource: "engine-default" });
    expect(window?.stats).toMatchObject({ windowHours: 8, validHours: 5, requiredValidHours: 6 });
  });

  it("returns incomplete_window, with no AQI, when both particulate series are incomplete", () => {
    const data = snapshot({
      values: { pm2_5: (o) => (o > -5 ? 40 : null), pm10: (o) => (o > -5 ? 120 : null) },
    });
    const aqi = data.calculatedAqi;
    expect(aqi?.status).toBe("incomplete_window");
    expect(aqi?.aqi).toBeNull();
    expect(aqi?.category).toBeNull();
    if (aqi?.status === "incomplete_window") {
      expect([...aqi.incompleteWindows].sort()).toEqual(["pm10", "pm25"]);
      expect(aqi.reasons).toContain("MISSING_PARTICULATE_MATTER");
    }
  });

  it("returns insufficient_data, not zero, when there is no historical data at all", () => {
    // Values exist only in the future: the history is empty.
    const data = snapshot({
      values: Object.fromEntries(
        ["pm2_5", "pm10", "carbon_monoxide", "nitrogen_dioxide", "sulphur_dioxide", "ozone"].map((v) => [
          v,
          (o: number) => (o > 0 ? 40 : null),
        ]),
      ),
    });
    const aqi = data.calculatedAqi;
    expect(aqi?.status).toBe("insufficient_data");
    expect(aqi?.aqi).toBeNull();
    expect(aqi?.aqi).not.toBe(0);
    expect(data.dataCompleteness?.requirementsMet).toBe(false);
  });

  it("does not substitute future hours for missing past hours", () => {
    // 10 past hours missing; the forecast is full of valid 40s that must NOT fill the gap.
    // (`o > -10` is true for every future hour too, so the forecast is full of valid values.)
    const data = snapshot({ values: { pm2_5: (o) => (o > -10 ? 40 : null) } });
    expect(data.calculatedAqi?.availablePollutants).not.toContain("pm25");
  });
});

describe("temporal handling: Asia/Kolkata timestamps", () => {
  it("renders dataTimestamp in IST while keeping fetchedAt and calculatedAt in UTC", () => {
    const data = snapshot();
    expect(data.dataTimestamp).toBe("2026-11-24T13:00:00+05:30");
    expect(data.fetchedAt).toBe("2026-11-24T08:17:11.000Z");
    expect(data.calculatedAqi?.calculatedAt).toBe("2026-11-24T08:17:11.000Z");
    expect(data.timezone).toBe("Asia/Kolkata");
    expect(Date.parse(data.dataTimestamp ?? "")).toBeLessThan(Date.parse(data.fetchedAt ?? ""));
  });

  it("reports providerGeneratedAt as null: the provider supplies no generation timestamp", () => {
    expect(snapshot().providerGeneratedAt).toBeNull();
  });

  it("records both the configured point and the grid cell the provider used", () => {
    const { coordinates } = snapshot();
    expect(coordinates.requested).toEqual({ latitude: 28.6139, longitude: 77.2089 });
    expect(coordinates.grid).toEqual({ latitude: 28.599998, longitude: 77.20001 });
  });

  it("states what the Delhi data actually represents", () => {
    expect(snapshot().dataLocation).toMatch(/not the whole National Capital Region/i);
  });
});

describe("freshness at build time", () => {
  it("is fresh when the newest model data is recent", () => {
    const data = snapshot();
    expect(data.freshnessStatus).toBe("fresh");
    expect(data.ageSeconds).toBe(0);
    expect(data.cache).toEqual({ status: "miss", ttlSeconds: TTL, expiresAt: "2026-11-24T08:32:11.000Z" });
  });

  it("is stale, with a warning, when the provider's data lags our clock by more than 3 hours", () => {
    const data = snapshot({}, FETCHED_AT_MS + 4 * HOUR * 1000);
    expect(PROVIDER_LAG_LIMIT_SECONDS).toBe(10_800);
    expect(data.freshnessStatus).toBe("stale");
    expect(data.warnings.map((w) => w.code)).toContain("PROVIDER_DATA_LAGGING");
  });
});

describe("presentSnapshot: serving stored data without making it look newer", () => {
  const stored = snapshot();
  const later = FETCHED_AT_MS + 40 * 60 * 1000; // 40 minutes after the fetch

  it("a stale fallback keeps the ORIGINAL fetchedAt, timestamps, datasets and AQI", () => {
    const stale = presentSnapshot(stored, { nowMs: later, ttlSeconds: TTL, mode: "stale-fallback" });
    expect(stale.fetchedAt).toBe(stored.fetchedAt);
    expect(stale.fetchedAt).toBe("2026-11-24T08:17:11.000Z");
    expect(stale.dataTimestamp).toBe(stored.dataTimestamp);
    expect(stale.historicalHourlyData).toBe(stored.historicalHourlyData);
    expect(stale.forecastHourlyData).toBe(stored.forecastHourlyData);
    expect(stale.calculatedAqi).toBe(stored.calculatedAqi);
    expect(stale.calculatedAqi?.calculatedAt).toBe("2026-11-24T08:17:11.000Z");
  });

  it("marks it stale, computes its age, and adds a clear warning", () => {
    const stale = presentSnapshot(stored, { nowMs: later, ttlSeconds: TTL, mode: "stale-fallback" });
    expect(stale.freshnessStatus).toBe("stale");
    expect(stale.ageSeconds).toBe(2_400);
    expect(stale.cache.status).toBe("stale-fallback");
    const stalWarning = stale.warnings.find((w) => w.code === "STALE_DATA");
    expect(stalWarning?.message).toContain("40 minutes");
    expect(stalWarning?.message).toContain("2026-11-24T08:17:11.000Z");
    expect(stale.warnings.map((w) => w.code)).toContain("UPSTREAM_UNAVAILABLE");
  });

  it("does not mutate the stored snapshot", () => {
    const before = JSON.stringify(stored);
    presentSnapshot(stored, { nowMs: later, ttlSeconds: TTL, mode: "stale-fallback" });
    expect(JSON.stringify(stored)).toBe(before);
    expect(stored.warnings.map((w) => w.code)).not.toContain("STALE_DATA");
  });

  it("a cache hit keeps the status fresh and reports the growing age", () => {
    const hit = presentSnapshot(stored, { nowMs: FETCHED_AT_MS + 5 * 60 * 1000, ttlSeconds: TTL, mode: "hit" });
    expect(hit.freshnessStatus).toBe("fresh");
    expect(hit.ageSeconds).toBe(300);
    expect(hit.cache.status).toBe("hit");
    expect(hit.fetchedAt).toBe(stored.fetchedAt);
    expect(hit.warnings).toEqual(stored.warnings);
  });

  it("a hit on data that was already lagging stays stale", () => {
    const lagging = snapshot({}, FETCHED_AT_MS + 4 * HOUR * 1000);
    const hit = presentSnapshot(lagging, { nowMs: FETCHED_AT_MS + 4 * HOUR * 1000 + 1_000, ttlSeconds: TTL, mode: "hit" });
    expect(hit.freshnessStatus).toBe("stale");
  });

  it("refuses to present something that was never fetched", () => {
    const unavailable = buildUnavailableAirData(city, TTL);
    expect(() => presentSnapshot(unavailable, { nowMs: later, ttlSeconds: TTL, mode: "hit" })).toThrow();
  });
});

describe("buildUnavailableAirData: the explicit no-data state", () => {
  const data = buildUnavailableAirData(city, TTL);

  it("contains no readings, no timestamps, no AQI and no invented numbers", () => {
    expect(data.freshnessStatus).toBe("unavailable");
    expect(data.fetchedAt).toBeNull();
    expect(data.dataTimestamp).toBeNull();
    expect(data.ageSeconds).toBeNull();
    expect(data.currentConditions).toBeNull();
    expect(data.calculatedAqi).toBeNull();
    expect(data.dataCompleteness).toBeNull();
    expect(data.historicalHourlyData.hours).toEqual([]);
    expect(data.forecastHourlyData.hours).toEqual([]);
    expect(data.historicalHourlyData.rangeStart).toBeNull();
    expect(data.sourceUnits).toEqual({});
    expect(data.coordinates.grid).toBeNull();
  });

  it("lists all eight pollutants as missing, with honest reasons", () => {
    expect(data.missingPollutants).toHaveLength(8);
    const byId = Object.fromEntries(data.pollutantAvailability.map((a) => [a.pollutant, a.reason]));
    expect(byId.pm25).toBe("upstream-unavailable");
    expect(byId.nh3).toBe("not-provided-by-provider");
    expect(byId.pb).toBe("not-provided-by-provider");
  });

  it("explains itself and still carries the disclaimer and attribution", () => {
    expect(data.warnings.map((w) => w.code)).toEqual(["UPSTREAM_UNAVAILABLE", "NO_CACHED_DATA"]);
    expect(data.disclaimer).toBe(AIR_DATA_DISCLAIMER);
    expect(data.sourceInfo.attribution).toMatch(/Open-Meteo/);
    expect(data.cache).toEqual({ status: "none", ttlSeconds: TTL, expiresAt: null });
  });

  it("never serialises a numeric zero where data is absent", () => {
    expect(JSON.stringify(data)).not.toMatch(/"(aqi|value|ageSeconds)":0\b/);
  });
});

describe("describeAge", () => {
  it.each([
    [0, "less than a minute"],
    [59, "less than a minute"],
    [60, "1 minute"],
    [2_400, "40 minutes"],
    [3_600, "1 hour"],
    [3_660, "1 hour 1 minute"],
    [11_100, "3 hours 5 minutes"],
  ])("%i s -> %s", (seconds, text) => {
    expect(describeAge(seconds)).toBe(text);
  });
});
