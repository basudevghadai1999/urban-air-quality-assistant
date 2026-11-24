import { afterEach, describe, expect, it, vi } from "vitest";

import { getAirService } from "@/lib/data/defaultAirService";
import { InvalidEnvError } from "@/lib/env";

const KEY = Symbol.for("urban-air-intelligence.air-service");
const store = globalThis as unknown as Record<symbol, unknown>;

afterEach(() => {
  delete store[KEY];
  vi.unstubAllEnvs();
});

describe("getAirService (process-wide instance)", () => {
  it("returns one shared instance, so every caller sees the same cache", () => {
    const first = getAirService();
    expect(getAirService()).toBe(first);
    expect(store[KEY]).toBe(first);
  });

  it("exposes the service interface", () => {
    expect(typeof getAirService().getAirData).toBe("function");
  });

  it("surfaces an invalid environment setting by name only, and does not cache a broken instance", () => {
    vi.stubEnv("AIR_CACHE_TTL_SECONDS", "banana");
    expect(() => getAirService()).toThrow(InvalidEnvError);
    expect(store[KEY]).toBeUndefined();

    vi.stubEnv("AIR_CACHE_TTL_SECONDS", "600");
    expect(() => getAirService()).not.toThrow();
  });
});
