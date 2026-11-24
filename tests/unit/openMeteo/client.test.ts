import { describe, expect, it, vi } from "vitest";

import { CITY_IDS, getAllCities, getCityById } from "@/config/cities";
import { buildRequestUrl, fetchOpenMeteoAirQuality } from "@/lib/data/openMeteo/client";
import { OpenMeteoError } from "@/lib/data/openMeteo/errors";

import { jsonResponse, makeOpenMeteoResponse } from "../../fixtures/openMeteo";

const ok = () => jsonResponse(makeOpenMeteoResponse());

const catchError = async (promise: Promise<unknown>): Promise<OpenMeteoError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof OpenMeteoError) return error;
    throw error;
  }
  throw new Error("expected the promise to reject");
};

describe("buildRequestUrl", () => {
  const url = buildRequestUrl(getCityById("bengaluru")!);

  it("targets only the fixed Open-Meteo air quality endpoint", () => {
    expect(url.origin + url.pathname).toBe("https://air-quality-api.open-meteo.com/v1/air-quality");
    expect(url.protocol).toBe("https:");
  });

  it("takes coordinates from the registry", () => {
    expect(url.searchParams.get("latitude")).toBe("12.9791");
    expect(url.searchParams.get("longitude")).toBe("77.5913");
  });

  it("requests exactly the six supported variables, hourly and current", () => {
    const expected = ["pm2_5", "pm10", "nitrogen_dioxide", "sulphur_dioxide", "ozone", "carbon_monoxide"].sort();
    expect(url.searchParams.get("hourly")?.split(",").sort()).toEqual(expected);
    expect(url.searchParams.get("current")?.split(",").sort()).toEqual(expected);
  });

  it("does not request NH3 or lead (not available for India)", () => {
    const text = url.toString().toLowerCase();
    expect(text).not.toContain("ammonia");
    expect(text).not.toContain("nh3");
    expect(text).not.toContain("lead");
    expect(text).not.toContain("pb");
  });

  it("asks for unambiguous timestamps in Asia/Kolkata, the global domain, and a minimal window", () => {
    expect(url.searchParams.get("timeformat")).toBe("unixtime");
    expect(url.searchParams.get("timezone")).toBe("Asia/Kolkata");
    expect(url.searchParams.get("domains")).toBe("cams_global");
    expect(url.searchParams.get("past_hours")).toBe("24");
    expect(url.searchParams.get("forecast_hours")).toBe("49");
  });

  it("sends no API key or other credential", () => {
    expect([...url.searchParams.keys()].sort()).toEqual(
      ["current", "domains", "forecast_hours", "hourly", "latitude", "longitude", "past_hours", "timeformat", "timezone"].sort(),
    );
    expect(url.searchParams.has("apikey")).toBe(false);
  });

  it("always stays on the fixed host for every configured city", () => {
    for (const city of getAllCities()) {
      expect(buildRequestUrl(city).hostname).toBe("air-quality-api.open-meteo.com");
    }
  });
});

describe("fetchOpenMeteoAirQuality: success", () => {
  it("returns validated data", async () => {
    const data = await fetchOpenMeteoAirQuality("mumbai", { fetchImpl: () => Promise.resolve(ok()) });
    expect(data.hourly.time.length).toBe(73);
    expect(data.timezone).toBe("Asia/Kolkata");
  });

  it("makes exactly one safe GET request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok());
    await fetchOpenMeteoAirQuality("kolkata", { fetchImpl, timeoutMs: 5_000 });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(buildRequestUrl(getCityById("kolkata")!).toString());
    expect(init.method).toBe("GET");
    expect(init.cache).toBe("no-store"); // never rely on Next.js fetch-cache defaults
    expect(init.redirect).toBe("error"); // never follow a redirect to another host
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.headers).toEqual({ Accept: "application/json" });
  });

  it("only ever contacts the Open-Meteo host", async () => {
    for (const id of CITY_IDS) {
      const fetchImpl = vi.fn().mockResolvedValue(ok());
      await fetchOpenMeteoAirQuality(id, { fetchImpl });
      expect(new URL(fetchImpl.mock.calls[0]?.[0] as string).hostname).toBe("air-quality-api.open-meteo.com");
    }
  });
});

describe("fetchOpenMeteoAirQuality: HTTP errors", () => {
  it("HTTP 400 -> UPSTREAM_REJECTED, never exposing the provider's reason", async () => {
    const leaky = JSON.stringify({ error: true, reason: "Cannot initialize SurfacePressureAndHeightVariable INTERNAL-DETAIL" });
    const error = await catchError(
      fetchOpenMeteoAirQuality("mumbai", { fetchImpl: () => Promise.resolve(jsonResponse(leaky, { status: 400 })) }),
    );
    expect(error.code).toBe("UPSTREAM_REJECTED");
    expect(error.status).toBe(400);
    const everything = `${error.message} ${error.publicMessage} ${error.detail ?? ""} ${String(error.stack ?? "").slice(0, 0)}`;
    expect(everything).not.toContain("INTERNAL-DETAIL");
    expect(everything).not.toContain("SurfacePressure");
  });

  it("HTTP 429 -> UPSTREAM_RATE_LIMITED, honouring a numeric Retry-After", async () => {
    const error = await catchError(
      fetchOpenMeteoAirQuality("mumbai", {
        fetchImpl: () => Promise.resolve(jsonResponse("{}", { status: 429, headers: { "Retry-After": "120" } })),
      }),
    );
    expect(error.code).toBe("UPSTREAM_RATE_LIMITED");
    expect(error.status).toBe(429);
    expect(error.retryAfterSeconds).toBe(120);
  });

  it("caps an excessive Retry-After and ignores a non-numeric one", async () => {
    const huge = await catchError(
      fetchOpenMeteoAirQuality("mumbai", {
        fetchImpl: () => Promise.resolve(jsonResponse("{}", { status: 429, headers: { "Retry-After": "999999" } })),
      }),
    );
    expect(huge.retryAfterSeconds).toBe(3_600);

    const junk = await catchError(
      fetchOpenMeteoAirQuality("mumbai", {
        fetchImpl: () =>
          Promise.resolve(jsonResponse("{}", { status: 429, headers: { "Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT" } })),
      }),
    );
    expect(junk.retryAfterSeconds).toBeUndefined();
  });

  it.each([500, 502, 503, 504])("HTTP %i -> UPSTREAM_SERVER_ERROR", async (status) => {
    const error = await catchError(
      fetchOpenMeteoAirQuality("patna", { fetchImpl: () => Promise.resolve(jsonResponse("oops", { status })) }),
    );
    expect(error.code).toBe("UPSTREAM_SERVER_ERROR");
    expect(error.status).toBe(status);
  });

  it("other 4xx -> UPSTREAM_REJECTED; unexpected non-error status -> UPSTREAM_HTTP", async () => {
    const forbidden = await catchError(
      fetchOpenMeteoAirQuality("patna", { fetchImpl: () => Promise.resolve(jsonResponse("", { status: 403 })) }),
    );
    expect(forbidden.code).toBe("UPSTREAM_REJECTED");

    const notModified = await catchError(
      fetchOpenMeteoAirQuality("patna", { fetchImpl: () => Promise.resolve(new Response(null, { status: 304 })) }),
    );
    expect(notModified.code).toBe("UPSTREAM_HTTP");
  });
});

describe("fetchOpenMeteoAirQuality: network failures", () => {
  it("times out when the provider does not answer", async () => {
    const hangs = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const started = Date.now();
    const error = await catchError(fetchOpenMeteoAirQuality("lucknow", { fetchImpl: hangs, timeoutMs: 30 }));
    expect(error.code).toBe("UPSTREAM_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("maps a network failure to UPSTREAM_NETWORK without leaking the cause", async () => {
    const boom = () => Promise.reject(new TypeError("fetch failed: connect ECONNREFUSED 10.0.0.5:443 internal-host"));
    const error = await catchError(fetchOpenMeteoAirQuality("lucknow", { fetchImpl: boom }));
    expect(error.code).toBe("UPSTREAM_NETWORK");
    expect(`${error.message} ${error.detail}`).not.toContain("10.0.0.5");
    expect(`${error.message} ${error.detail}`).not.toContain("ECONNREFUSED");
  });

  it("treats a refused redirect as a network failure", async () => {
    const redirected = () => Promise.reject(new TypeError("fetch failed: redirect mode is set to error"));
    const error = await catchError(fetchOpenMeteoAirQuality("lucknow", { fetchImpl: redirected }));
    expect(error.code).toBe("UPSTREAM_NETWORK");
  });
});

describe("fetchOpenMeteoAirQuality: bad bodies", () => {
  it("rejects malformed JSON", async () => {
    const error = await catchError(
      fetchOpenMeteoAirQuality("kolkata", { fetchImpl: () => Promise.resolve(jsonResponse("{not json")) }),
    );
    expect(error.code).toBe("UPSTREAM_INVALID_RESPONSE");
  });

  it("rejects an empty body and an HTML error page", async () => {
    for (const body of ["", "<html><body>Bad gateway</body></html>"]) {
      const error = await catchError(
        fetchOpenMeteoAirQuality("kolkata", { fetchImpl: () => Promise.resolve(jsonResponse(body)) }),
      );
      expect(error.code).toBe("UPSTREAM_INVALID_RESPONSE");
    }
  });

  it("rejects a provider error envelope even when sent with HTTP 200", async () => {
    const error = await catchError(
      fetchOpenMeteoAirQuality("kolkata", {
        fetchImpl: () => Promise.resolve(jsonResponse({ error: true, reason: "secret internal reason" })),
      }),
    );
    expect(error.code).toBe("UPSTREAM_REJECTED");
    expect(`${error.message} ${error.detail}`).not.toContain("secret internal reason");
  });

  it("rejects JSON that fails schema validation, reporting paths but not values", async () => {
    const bad = makeOpenMeteoResponse() as { hourly: { pm2_5: unknown[] } };
    bad.hourly.pm2_5[0] = "LEAK-ME";
    const error = await catchError(
      fetchOpenMeteoAirQuality("kolkata", { fetchImpl: () => Promise.resolve(jsonResponse(bad)) }),
    );
    expect(error.code).toBe("UPSTREAM_INVALID_RESPONSE");
    expect(error.detail).toMatch(/hourly\.pm2_5/);
    expect(error.detail).not.toContain("LEAK-ME");
  });

  it("rejects a response whose declared size is over the limit, without reading it", async () => {
    const response = jsonResponse(makeOpenMeteoResponse(), { headers: { "Content-Length": "999999999" } });
    const error = await catchError(
      fetchOpenMeteoAirQuality("kolkata", { fetchImpl: () => Promise.resolve(response), maxBytes: 1_000 }),
    );
    expect(error.code).toBe("UPSTREAM_TOO_LARGE");
  });

  it("stops reading a body that grows past the limit when no size is declared", async () => {
    const chunk = new TextEncoder().encode("x".repeat(400));
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
        if (pulls > 1_000) controller.close();
      },
    });
    const error = await catchError(
      fetchOpenMeteoAirQuality("kolkata", {
        fetchImpl: () => Promise.resolve(new Response(stream, { status: 200 })),
        maxBytes: 1_000,
      }),
    );
    expect(error.code).toBe("UPSTREAM_TOO_LARGE");
    expect(pulls).toBeLessThan(20); // aborted early, not read to the end
  });
});

describe("fetchOpenMeteoAirQuality: input safety", () => {
  it.each(["atlantis", "", "28.6,77.2", "https://evil.example/x", "constructor", "../../etc/passwd", "mumbai&latitude=0"])(
    "refuses %j without making any request",
    async (id) => {
      const fetchImpl = vi.fn();
      const error = await catchError(fetchOpenMeteoAirQuality(id, { fetchImpl }));
      expect(error.code).toBe("UNKNOWN_CITY");
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});
