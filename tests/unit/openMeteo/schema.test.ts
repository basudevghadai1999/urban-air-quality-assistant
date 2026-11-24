import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { openMeteoResponseSchema, summarizeIssues } from "@/lib/data/openMeteo/schema";

import { makeOpenMeteoResponse } from "../../fixtures/openMeteo";

const parse = (value: unknown) => openMeteoResponseSchema.safeParse(value);

interface MutableResponse {
  latitude: number;
  longitude: number;
  utc_offset_seconds: number;
  hourly: Record<string, unknown>;
  hourly_units: Record<string, unknown>;
  current: Record<string, unknown>;
  [key: string]: unknown;
}

/** Mutate a fresh fixture. */
const mutate = (change: (r: MutableResponse) => void) => {
  const response = makeOpenMeteoResponse() as MutableResponse;
  change(response);
  return parse(response);
};

describe("openMeteoResponseSchema", () => {
  it("accepts the REAL recorded Open-Meteo response (Delhi, 2026-11-24)", () => {
    const path = fileURLToPath(new URL("../../fixtures/open-meteo-delhi-recorded.json", import.meta.url));
    const recorded: unknown = JSON.parse(readFileSync(path, "utf8"));
    const result = parse(recorded);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.hourly.time).toHaveLength(71);
      expect(result.data.utc_offset_seconds).toBe(19_800);
      expect(result.data.hourly_units.pm2_5).toBe("μg/m³");
    }
  });

  it("accepts a well-formed synthetic response", () => {
    expect(parse(makeOpenMeteoResponse()).success).toBe(true);
  });

  it("tolerates unknown extra fields (the provider adds fields over time)", () => {
    const response = { ...makeOpenMeteoResponse(), brand_new_field: { anything: [1, 2, 3] } };
    expect(parse(response).success).toBe(true);
  });

  it("accepts a response with no current block", () => {
    expect(parse(makeOpenMeteoResponse({ includeCurrent: false })).success).toBe(true);
  });

  it("accepts a response where an optional pollutant is entirely absent", () => {
    expect(parse(makeOpenMeteoResponse({ omit: ["ozone"] })).success).toBe(true);
  });

  describe("null pollutant values", () => {
    it("accepts nulls anywhere in a series", () => {
      const result = parse(makeOpenMeteoResponse({ values: { pm2_5: (i) => (i % 2 === 0 ? null : 12.5) } }));
      expect(result.success).toBe(true);
    });

    it("accepts a series that is entirely null", () => {
      expect(parse(makeOpenMeteoResponse({ values: { pm2_5: () => null } })).success).toBe(true);
    });

    it("rejects a non-numeric, non-null value", () => {
      const result = mutate((r) => {
        (r.hourly.pm2_5 as unknown[])[3] = "12.5";
      });
      expect(result.success).toBe(false);
    });
  });

  describe("missing required fields", () => {
    it.each(["latitude", "longitude", "utc_offset_seconds", "timezone", "hourly", "hourly_units"])("rejects a response without %s", (field) => {
      const response = makeOpenMeteoResponse() as Record<string, unknown>;
      delete response[field];
      expect(parse(response).success).toBe(false);
    });

    it("rejects a response without hourly.time", () => {
      expect(mutate((r) => delete r.hourly.time).success).toBe(false);
    });

    it("rejects an empty time axis", () => {
      const response = makeOpenMeteoResponse({ pastHours: 0, forecastHours: 0 });
      expect(parse(response).success).toBe(false);
    });

    it.each([null, "not an object", 42, [], undefined])("rejects a non-object body (%j)", (body) => {
      expect(parse(body).success).toBe(false);
    });
  });

  describe("array lengths", () => {
    it("rejects a pollutant series shorter than the time axis", () => {
      const result = mutate((r) => {
        (r.hourly.pm10 as unknown[]).pop();
      });
      expect(result.success).toBe(false);
      if (!result.success) expect(summarizeIssues(result.error)).toMatch(/hourly\.pm10/);
    });

    it("rejects a pollutant series longer than the time axis", () => {
      expect(mutate((r) => (r.hourly.ozone as unknown[]).push(1)).success).toBe(false);
    });

    it("rejects an implausibly large time axis", () => {
      const response = makeOpenMeteoResponse({ pastHours: 150, forecastHours: 100 });
      expect(parse(response).success).toBe(false);
    });
  });

  describe("timestamps", () => {
    it("rejects non-integer timestamps", () => {
      expect(mutate((r) => ((r.hourly.time as unknown[])[2] = 1_795_500_000.5)).success).toBe(false);
    });

    it("rejects timestamps given as strings", () => {
      expect(mutate((r) => ((r.hourly.time as unknown[])[0] = "2026-11-24T13:00")).success).toBe(false);
    });

    it("rejects timestamps outside a plausible range", () => {
      expect(mutate((r) => ((r.hourly.time as unknown[])[0] = 5)).success).toBe(false);
      expect(mutate((r) => ((r.hourly.time as unknown[])[0] = 9_999_999_999)).success).toBe(false);
    });

    it("rejects a time axis that is not strictly hourly (gap)", () => {
      const result = mutate((r) => {
        const time = r.hourly.time as number[];
        time[10] = (time[10] ?? 0) + 3_600; // creates a gap and then a duplicate
      });
      expect(result.success).toBe(false);
    });

    it("rejects duplicate timestamps", () => {
      const result = mutate((r) => {
        const time = r.hourly.time as number[];
        time[5] = time[4] ?? 0;
      });
      expect(result.success).toBe(false);
    });

    it("rejects out-of-order timestamps", () => {
      const result = mutate((r) => {
        const time = r.hourly.time as number[];
        [time[3], time[4]] = [time[4] ?? 0, time[3] ?? 0];
      });
      expect(result.success).toBe(false);
    });

    it("rejects a time unit other than unixtime (iso8601 offset-less strings cannot be trusted)", () => {
      expect(mutate((r) => (r.hourly_units.time = "iso8601")).success).toBe(false);
    });

    it("rejects an out-of-range UTC offset", () => {
      expect(mutate((r) => (r.utc_offset_seconds = 999_999)).success).toBe(false);
      expect(mutate((r) => (r.utc_offset_seconds = 1800.5)).success).toBe(false);
    });

    it("rejects a current block with an invalid time or interval", () => {
      expect(mutate((r) => (r.current.time = "now")).success).toBe(false);
      expect(mutate((r) => (r.current.interval = 0)).success).toBe(false);
    });
  });

  describe("units", () => {
    it("rejects a returned pollutant series with no unit", () => {
      const result = mutate((r) => delete r.hourly_units.pm2_5);
      expect(result.success).toBe(false);
      if (!result.success) expect(summarizeIssues(result.error)).toMatch(/hourly_units\.pm2_5/);
    });

    it("rejects an empty unit string", () => {
      expect(mutate((r) => (r.hourly_units.pm10 = "")).success).toBe(false);
    });

    it("passes through an unexpected unit string for the mapper to judge", () => {
      // Structure is valid; deciding whether "ppm" is acceptable is the mapper's job.
      const result = parse(makeOpenMeteoResponse({ units: { carbon_monoxide: "ppm" } }));
      expect(result.success).toBe(true);
    });
  });

  it("rejects out-of-range coordinates", () => {
    expect(mutate((r) => (r.latitude = 91)).success).toBe(false);
    expect(mutate((r) => (r.longitude = -181)).success).toBe(false);
  });
});

describe("summarizeIssues", () => {
  it("lists paths and issue codes without echoing any values", () => {
    const result = mutate((r) => {
      (r.hourly.pm2_5 as unknown[])[0] = "SECRET-LOOKING-VALUE";
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const summary = summarizeIssues(result.error);
      expect(summary).not.toContain("SECRET-LOOKING-VALUE");
      expect(summary.length).toBeGreaterThan(0);
    }
  });
});
