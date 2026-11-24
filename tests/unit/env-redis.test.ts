import { describe, expect, it } from "vitest";

import { InvalidEnvError, getRateLimitPolicy, getRedisConfig, isProductionRuntime } from "@/lib/env";
import { detectIpTrust } from "@/lib/ratelimit";
import { DEFAULT_RATE_LIMIT_POLICY } from "@/lib/ratelimit/types";

const URL = "https://fake-host.upstash.io";
const TOKEN = "FAKE-token-123";

describe("getRedisConfig", () => {
  it("is not-configured when neither variable is set (blank counts as unset)", () => {
    expect(getRedisConfig({})).toEqual({ status: "not-configured" });
    expect(getRedisConfig({ UPSTASH_REDIS_REST_URL: " ", UPSTASH_REDIS_REST_TOKEN: "" })).toEqual({
      status: "not-configured",
    });
  });

  it("is configured when both are valid", () => {
    expect(getRedisConfig({ UPSTASH_REDIS_REST_URL: URL, UPSTASH_REDIS_REST_TOKEN: TOKEN })).toEqual({
      status: "configured",
      config: { url: URL, token: TOKEN },
    });
  });

  it("is invalid, naming the missing half, when only one is set", () => {
    expect(getRedisConfig({ UPSTASH_REDIS_REST_URL: URL })).toEqual({ status: "invalid", variable: "UPSTASH_REDIS_REST_TOKEN" });
    expect(getRedisConfig({ UPSTASH_REDIS_REST_TOKEN: TOKEN })).toEqual({ status: "invalid", variable: "UPSTASH_REDIS_REST_URL" });
  });

  it("is invalid for a bad URL or token, reporting only the variable NAME", () => {
    const badUrl = getRedisConfig({ UPSTASH_REDIS_REST_URL: "http://evil.example", UPSTASH_REDIS_REST_TOKEN: TOKEN });
    expect(badUrl).toEqual({ status: "invalid", variable: "UPSTASH_REDIS_REST_URL" });

    const badToken = getRedisConfig({ UPSTASH_REDIS_REST_URL: URL, UPSTASH_REDIS_REST_TOKEN: "has space" });
    expect(badToken).toEqual({ status: "invalid", variable: "UPSTASH_REDIS_REST_TOKEN" });
    expect(JSON.stringify([badUrl, badToken])).not.toMatch(/evil|has space|FAKE-token/);
  });

  it("never throws, so a bad setting degrades the app instead of crashing it", () => {
    expect(() => getRedisConfig({ UPSTASH_REDIS_REST_URL: "\u0000", UPSTASH_REDIS_REST_TOKEN: "\u0000" })).not.toThrow();
  });

  it("reads only the two server variable names, never a NEXT_PUBLIC_ one", () => {
    expect(getRedisConfig({ NEXT_PUBLIC_UPSTASH_REDIS_REST_URL: URL, NEXT_PUBLIC_UPSTASH_REDIS_REST_TOKEN: TOKEN })).toEqual({
      status: "not-configured",
    });
  });
});

describe("getRateLimitPolicy", () => {
  it("defaults to 30 requests per 60 seconds", () => {
    expect(getRateLimitPolicy({})).toEqual({ limit: 30, windowSeconds: 60 });
    expect(DEFAULT_RATE_LIMIT_POLICY).toEqual({ limit: 30, windowSeconds: 60 });
  });

  it("reads overrides", () => {
    expect(getRateLimitPolicy({ AIR_RATE_LIMIT_MAX: "100", AIR_RATE_LIMIT_WINDOW_SECONDS: "10" })).toEqual({
      limit: 100,
      windowSeconds: 10,
    });
  });

  it.each([
    ["AIR_RATE_LIMIT_MAX", "0"],
    ["AIR_RATE_LIMIT_MAX", "10001"],
    ["AIR_RATE_LIMIT_MAX", "ten"],
    ["AIR_RATE_LIMIT_MAX", "1.5"],
    ["AIR_RATE_LIMIT_WINDOW_SECONDS", "0"],
    ["AIR_RATE_LIMIT_WINDOW_SECONDS", "3601"],
    ["AIR_RATE_LIMIT_WINDOW_SECONDS", "-1"],
  ])("rejects %s=%s by name, without echoing the value", (name, value) => {
    expect(() => getRateLimitPolicy({ [name]: value })).toThrow(InvalidEnvError);
    try {
      getRateLimitPolicy({ [name]: value });
    } catch (error) {
      expect((error as Error).message).toContain(name);
      expect((error as Error).message).not.toContain(value);
    }
  });
});

describe("isProductionRuntime", () => {
  it("is true only for NODE_ENV=production, and ignores platform-specific variables", () => {
    expect(isProductionRuntime({ NODE_ENV: "production" })).toBe(true);
    expect(isProductionRuntime({ VERCEL_ENV: "production" })).toBe(false);
    expect(isProductionRuntime({ NODE_ENV: "development" })).toBe(false);
    expect(isProductionRuntime({})).toBe(false);
  });
});

describe("detectIpTrust", () => {
  it("trusts CF-Connecting-IP only when TRUST_RENDER_CF_CONNECTING_IP is explicitly \"true\"", () => {
    expect(detectIpTrust({ TRUST_RENDER_CF_CONNECTING_IP: "true" })).toBe("render");
    expect(detectIpTrust({ TRUST_RENDER_CF_CONNECTING_IP: " TRUE " })).toBe("render");
    expect(detectIpTrust({})).toBe("none");
    expect(detectIpTrust({ TRUST_RENDER_CF_CONNECTING_IP: "" })).toBe("none");
    expect(detectIpTrust({ TRUST_RENDER_CF_CONNECTING_IP: "false" })).toBe("none");
    expect(detectIpTrust({ TRUST_RENDER_CF_CONNECTING_IP: "1" })).toBe("none");
    expect(detectIpTrust({ TRUST_RENDER_CF_CONNECTING_IP: "yes" })).toBe("none");
    // Platform variables never enable trust: only the explicit flag does.
    expect(detectIpTrust({ RENDER: "true" })).toBe("none");
    expect(detectIpTrust({ VERCEL: "1" })).toBe("none");
  });
});
