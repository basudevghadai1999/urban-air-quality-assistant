import { describe, expect, it } from "vitest";

import { DEFAULT_AIR_SERVICE_CONFIG } from "@/lib/data/config";
import { InvalidEnvError, getAirServiceConfig } from "@/lib/env";

describe("getAirServiceConfig", () => {
  it("defaults to a 15-minute TTL, 24-hour max stale age, 60 s back-off, 8 s timeout", () => {
    expect(getAirServiceConfig({})).toEqual(DEFAULT_AIR_SERVICE_CONFIG);
    expect(DEFAULT_AIR_SERVICE_CONFIG).toEqual({
      ttlSeconds: 900,
      maxStaleSeconds: 86_400,
      failureBackoffSeconds: 60,
      upstreamTimeoutMs: 8_000,
    });
  });

  it("reads each override", () => {
    expect(
      getAirServiceConfig({
        AIR_CACHE_TTL_SECONDS: "600",
        AIR_MAX_STALE_SECONDS: "7200",
        AIR_FAILURE_BACKOFF_SECONDS: "30",
        AIR_UPSTREAM_TIMEOUT_MS: "5000",
      }),
    ).toEqual({ ttlSeconds: 600, maxStaleSeconds: 7_200, failureBackoffSeconds: 30, upstreamTimeoutMs: 5_000 });
  });

  it("treats blank values as unset", () => {
    expect(getAirServiceConfig({ AIR_CACHE_TTL_SECONDS: "  " }).ttlSeconds).toBe(900);
  });

  it.each([
    ["AIR_CACHE_TTL_SECONDS", "59"],
    ["AIR_CACHE_TTL_SECONDS", "3601"],
    ["AIR_CACHE_TTL_SECONDS", "abc"],
    ["AIR_CACHE_TTL_SECONDS", "12.5"],
    ["AIR_CACHE_TTL_SECONDS", "-5"],
    ["AIR_UPSTREAM_TIMEOUT_MS", "999"],
    ["AIR_UPSTREAM_TIMEOUT_MS", "999999"],
    ["AIR_FAILURE_BACKOFF_SECONDS", "1"],
    ["AIR_MAX_STALE_SECONDS", "10"],
  ])("rejects %s=%s, naming the variable", (name, value) => {
    expect(() => getAirServiceConfig({ [name]: value })).toThrow(InvalidEnvError);
    try {
      getAirServiceConfig({ [name]: value });
    } catch (error) {
      expect((error as Error).message).toContain(name);
    }
  });

  it("rejects a maximum stale age shorter than the TTL", () => {
    expect(() => getAirServiceConfig({ AIR_CACHE_TTL_SECONDS: "3000", AIR_MAX_STALE_SECONDS: "600" })).toThrow(
      InvalidEnvError,
    );
  });

  it("never echoes the offending value in the error", () => {
    try {
      getAirServiceConfig({ AIR_CACHE_TTL_SECONDS: "not-a-number-12345" });
    } catch (error) {
      expect((error as Error).message).not.toContain("not-a-number-12345");
    }
  });
});
