import { describe, expect, it, vi } from "vitest";

import { MemoryCache } from "@/lib/cache";
import { handleAirRequest } from "@/lib/api/airHandler";
import { createAirService, type AirFetcher, type AirService } from "@/lib/data/airService";
import { DEFAULT_AIR_SERVICE_CONFIG } from "@/lib/data/config";
import { OpenMeteoError } from "@/lib/data/openMeteo/errors";
import { openMeteoResponseSchema } from "@/lib/data/openMeteo/schema";
import type { AirApiError, AirApiSuccess, NormalizedAirData } from "@/types/air";

import { FETCHED_AT_MS, makeOpenMeteoResponse } from "../fixtures/openMeteo";

const get = (query: string) => new Request(`http://localhost:3000/api/air${query}`);

function liveService(fetcher?: AirFetcher, clock = { now: FETCHED_AT_MS }) {
  const calls: string[] = [];
  const service = createAirService({
    config: DEFAULT_AIR_SERVICE_CONFIG,
    cache: new MemoryCache<NormalizedAirData>(),
    now: () => clock.now,
    fetcher:
      fetcher ??
      ((cityId) => {
        calls.push(cityId);
        return Promise.resolve(openMeteoResponseSchema.parse(makeOpenMeteoResponse()));
      }),
    logger: { warn: vi.fn() },
  });
  return { service, calls, clock };
}

const run = (query: string, service: AirService, now = FETCHED_AT_MS) =>
  handleAirRequest(get(query), () => service, () => now);

describe("GET /api/air: valid city", () => {
  it("returns normalized JSON with HTTP 200", async () => {
    const { service } = liveService();
    const response = await run("?cityId=bengaluru", service);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/application\/json/);

    const body = (await response.json()) as AirApiSuccess;
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      cityId: "bengaluru",
      cityName: "Bengaluru",
      state: "Karnataka",
      timezone: "Asia/Kolkata",
      source: "open-meteo",
      freshnessStatus: "fresh",
      providerGeneratedAt: null,
    });
    expect(body.data.calculatedAqi?.status).toBe("valid");
    expect(body.data.historicalHourlyData.kind).toBe("historical-model");
    expect(body.data.forecastHourlyData.kind).toBe("forecast-model");
    expect(body.data.disclaimer).toMatch(/not an official CPCB monitoring-station reading/);
  });

  it("returns every field the contract promises", async () => {
    const { service } = liveService();
    const body = (await (await run("?cityId=mumbai", service)).json()) as AirApiSuccess;
    for (const key of [
      "cityId", "cityName", "coordinates", "timezone", "source", "sourceDescription", "fetchedAt",
      "providerGeneratedAt", "dataTimestamp", "currentConditions", "historicalHourlyData",
      "forecastHourlyData", "calculatedAqi", "dataCompleteness", "missingPollutants", "warnings",
      "freshnessStatus",
    ]) {
      expect(body.data).toHaveProperty(key);
    }
  });

  it("accepts every configured city", async () => {
    const { service } = liveService();
    for (const id of ["delhi-ncr", "mumbai", "kolkata", "bengaluru", "lucknow", "patna"]) {
      expect((await run(`?cityId=${id}`, service)).status).toBe(200);
    }
  });

  it("lets a CDN share a FRESH response only for the time left in its freshness window", async () => {
    const { service } = liveService();
    const response = await run("?cityId=patna", service, FETCHED_AT_MS + 5 * 60_000);
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=600");
    expect(response.headers.get("x-air-freshness")).toBe("fresh");
  });

  it("reuses the cached snapshot instead of calling the provider again", async () => {
    const { service, calls } = liveService();
    await run("?cityId=patna", service);
    await run("?cityId=patna", service);
    expect(calls).toEqual(["patna"]);
  });
});

describe("GET /api/air: invalid input", () => {
  const expectError = async (response: Response, status: number, code: AirApiError["error"]["code"]) => {
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as AirApiError;
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe(code);
    return body;
  };

  it("rejects an unsupported city with the list of valid IDs", async () => {
    const { service, calls } = liveService();
    const body = await expectError(await run("?cityId=atlantis", service), 400, "INVALID_CITY_ID");
    expect(body.error.validCityIds).toEqual(["delhi-ncr", "mumbai", "kolkata", "bengaluru", "lucknow", "patna"]);
    expect(calls).toEqual([]);
  });

  it("rejects a missing cityId", async () => {
    const { service } = liveService();
    await expectError(await run("", service), 400, "MISSING_CITY_ID");
    await expectError(await run("?cityId=", service), 400, "INVALID_CITY_ID");
  });

  it("is case-sensitive about city IDs", async () => {
    const { service } = liveService();
    await expectError(await run("?cityId=Mumbai", service), 400, "INVALID_CITY_ID");
  });

  it.each([
    "?cityId=mumbai&latitude=28.6&longitude=77.2",
    "?cityId=mumbai&latitude=28.6", // each coordinate is rejected on its own, not only as a pair
    "?cityId=mumbai&longitude=77.2",
    "?cityId=mumbai&lat=1",
    "?cityId=mumbai&lon=1",
    "?cityId=mumbai&q=delhi",
    "?cityId=mumbai&CITYID=patna",
    "?cityId=mumbai&hourly=pm10",
    "?cityId=mumbai&url=https://evil.example",
    "?cityId=mumbai&apikey=abc",
    "?latitude=28.6&longitude=77.2",
  ])("rejects unsupported query parameters: %s", async (query) => {
    const { service, calls } = liveService();
    await expectError(await run(query, service), 400, "UNSUPPORTED_PARAMETER");
    expect(calls).toEqual([]);
  });

  it("ignores a trailing ampersand, which adds no parameter", async () => {
    const { service } = liveService();
    expect((await run("?cityId=mumbai&", service)).status).toBe(200);
  });

  it("never accepts arbitrary coordinates, and does not echo them back", async () => {
    const { service, calls } = liveService();
    const response = await run("?cityId=mumbai&latitude=51.5&longitude=-0.12", service);
    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).not.toContain("51.5");
    expect(calls).toEqual([]);
  });

  it("rejects a repeated cityId", async () => {
    const { service } = liveService();
    await expectError(await run("?cityId=mumbai&cityId=patna", service), 400, "DUPLICATE_PARAMETER");
  });

  it.each(["__proto__", "constructor", "../etc/passwd", "mumbai%00", "%27%3B%20DROP", "28.6,77.2"])(
    "rejects hostile city values: %s",
    async (value) => {
      const { service, calls } = liveService();
      await expectError(await run(`?cityId=${value}`, service), 400, "INVALID_CITY_ID");
      expect(calls).toEqual([]);
    },
  );

  it("bounds the request URL length", async () => {
    const { service } = liveService();
    const response = await run(`?cityId=mumbai&x=${"a".repeat(2_000)}`, service);
    await expectError(response, 414, "REQUEST_TOO_LARGE");
  });

  it("does not echo user input in any error message", async () => {
    const { service } = liveService();
    const response = await run("?cityId=%3Cscript%3Ealert(1)%3C/script%3E", service);
    expect(JSON.stringify(await response.json())).not.toMatch(/script|alert/);
  });
});

describe("GET /api/air: upstream failure", () => {
  it("returns 503 with the explicit unavailable state when nothing is cached", async () => {
    const { service } = liveService(() => Promise.reject(new OpenMeteoError("UPSTREAM_SERVER_ERROR", { status: 503 })));
    const response = await run("?cityId=kolkata", service);
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-air-freshness")).toBe("unavailable");

    const body = (await response.json()) as AirApiError;
    expect(body.error.code).toBe("AIR_DATA_UNAVAILABLE");
    expect(body.data?.freshnessStatus).toBe("unavailable");
    expect(body.data?.calculatedAqi).toBeNull();
    expect(body.data?.fetchedAt).toBeNull();
  });

  it("never leaks upstream details, stack traces or provider text", async () => {
    const leaky = new OpenMeteoError("UPSTREAM_REJECTED", {
      status: 400,
      detail: "SurfacePressureAndHeightVariable internal /srv/app/secret.ts",
    });
    const { service } = liveService(() => Promise.reject(leaky));
    const text = await (await run("?cityId=kolkata", service)).text();
    expect(text).not.toMatch(/SurfacePressure|\/srv\/|secret|stack|at .*\.ts|Error:|open-meteo\.com\/v1/i);
  });

  it("answers 500 INTERNAL_ERROR with fixed text if the service itself throws", async () => {
    const throwing: AirService = { getAirData: () => Promise.reject(new Error("boom: /Users/me/.env")) };
    const response = await handleAirRequest(get("?cityId=mumbai"), () => throwing);
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).toContain("INTERNAL_ERROR");
    expect(text).not.toMatch(/boom|\.env|\/Users/);
  });

  it("answers 500 if building the service fails (e.g. a bad environment setting)", async () => {
    const response = await handleAirRequest(get("?cityId=mumbai"), () => {
      throw new Error("AIR_CACHE_TTL_SECONDS is invalid");
    });
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("AIR_CACHE_TTL_SECONDS");
  });
});

describe("GET /api/air: stale result", () => {
  async function staleResponse() {
    let healthy = true;
    const clock = { now: FETCHED_AT_MS };
    const { service } = liveService(
      () => (healthy ? Promise.resolve(openMeteoResponseSchema.parse(makeOpenMeteoResponse())) : Promise.reject(new OpenMeteoError("UPSTREAM_NETWORK"))),
      clock,
    );
    await run("?cityId=lucknow", service, clock.now);
    healthy = false;
    clock.now += 25 * 60_000;
    return run("?cityId=lucknow", service, clock.now);
  }

  it("returns 200 with data marked stale, the original timestamp and a warning", async () => {
    const response = await staleResponse();
    expect(response.status).toBe(200);
    const body = (await response.json()) as AirApiSuccess;
    expect(body.data.freshnessStatus).toBe("stale");
    expect(body.data.fetchedAt).toBe("2026-11-24T08:17:11.000Z");
    expect(body.data.ageSeconds).toBe(1_500);
    expect(body.data.cache.status).toBe("stale-fallback");
    expect(body.data.warnings.map((w) => w.code)).toContain("STALE_DATA");
    expect(body.data.calculatedAqi?.status).toBe("valid");
  });

  it("is never shared by a CDN", async () => {
    const response = await staleResponse();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-air-freshness")).toBe("stale");
  });
});

describe("the route module", () => {
  it("exports a force-dynamic GET handler that wires the default service", async () => {
    const route = await import("@/app/api/air/route");
    expect(route.dynamic).toBe("force-dynamic");
    expect(typeof route.GET).toBe("function");
    // An invalid request is answered without ever building the default service or touching the network.
    const response = await route.GET(get("?cityId=atlantis"));
    expect(response.status).toBe(400);
  });
});
