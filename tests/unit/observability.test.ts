import { describe, expect, it } from "vitest";

import {
  AIR_METRIC_NAMES,
  METRIC_LOG_INTERVAL_MS,
  createAirMetrics,
  noopMetrics,
  sanitizeFields,
} from "@/lib/observability/metrics";

describe("sanitizeFields", () => {
  it("keeps only allow-listed scalar fields", () => {
    expect(sanitizeFields({ cityId: "mumbai", code: "UPSTREAM_TIMEOUT", status: 503, kind: "timeout", layer: "cache", operation: "get" })).toEqual({
      cityId: "mumbai",
      code: "UPSTREAM_TIMEOUT",
      status: 503,
      kind: "timeout",
      layer: "cache",
      operation: "get",
    });
  });

  it("drops anything that could carry sensitive data, even if a caller passes it", () => {
    const safe = sanitizeFields({
      cityId: "mumbai",
      ip: "198.51.100.7",
      clientIp: "198.51.100.7",
      token: "secret-token",
      authorization: "Bearer abc",
      headers: "x-forwarded-for: 1.2.3.4",
      url: "https://x.upstash.io",
      email: "a@b.c",
      payload: "{...}",
    });
    expect(safe).toEqual({ cityId: "mumbai" });
    expect(JSON.stringify(safe)).not.toMatch(/198\.51|secret|Bearer|upstash|a@b/);
  });

  it("omits undefined values and handles no fields", () => {
    expect(sanitizeFields({ cityId: undefined, status: 1 })).toEqual({ status: 1 });
    expect(sanitizeFields(undefined)).toEqual({});
  });
});

describe("createAirMetrics", () => {
  it("counts every named event, starting at zero", () => {
    const metrics = createAirMetrics(() => undefined);
    expect(Object.keys(metrics.snapshot()).sort()).toEqual([...AIR_METRIC_NAMES].sort());
    expect(Object.values(metrics.snapshot()).every((n) => n === 0)).toBe(true);
    metrics.increment("stale_fallback");
    metrics.increment("stale_fallback");
    metrics.increment("redis_failure");
    expect(metrics.snapshot()).toMatchObject({ stale_fallback: 2, redis_failure: 1, cache_hit: 0 });
  });

  it("counts cache hits and misses without logging them (too frequent to log)", () => {
    const lines: string[] = [];
    const metrics = createAirMetrics((line) => lines.push(line));
    for (let i = 0; i < 100; i += 1) metrics.increment("cache_hit", { cityId: "mumbai" });
    metrics.increment("cache_miss", { cityId: "mumbai" });
    expect(metrics.snapshot()).toMatchObject({ cache_hit: 100, cache_miss: 1 });
    expect(lines).toEqual([]);
  });

  it.each(["stale_fallback", "refresh_paused", "provider_timeout", "provider_failure", "redis_failure", "cache_entry_corrupt", "rate_limit_rejection", "rate_limit_degraded", "client_identifier_unavailable"] as const)(
    "emits one structured JSON line for %s",
    (name) => {
      const lines: string[] = [];
      createAirMetrics((line) => lines.push(line)).increment(name, { cityId: "patna", kind: "timeout" });
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0] ?? "")).toEqual({ level: "warn", event: "air.metric", metric: name, cityId: "patna", kind: "timeout", count: 1 });
    },
  );

  describe("bounded log volume", () => {
    it("writes at most one line per metric per minute, while counting every event exactly", () => {
      const nowMs = 1_000_000;
      const lines: string[] = [];
      const metrics = createAirMetrics((line) => lines.push(line), () => nowMs);
      for (let i = 0; i < 500; i += 1) metrics.increment("rate_limit_rejection");
      expect(lines).toHaveLength(1);
      expect(metrics.snapshot().rate_limit_rejection).toBe(500);
    });

    it("logs again after the interval, carrying the running total", () => {
      let nowMs = 1_000_000;
      const lines: string[] = [];
      const metrics = createAirMetrics((line) => lines.push(line), () => nowMs);
      for (let i = 0; i < 10; i += 1) metrics.increment("redis_failure");
      nowMs += METRIC_LOG_INTERVAL_MS;
      metrics.increment("redis_failure");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1] ?? "")).toMatchObject({ metric: "redis_failure", count: 11 });
    });

    it("throttles each metric independently", () => {
      const lines: string[] = [];
      const metrics = createAirMetrics((line) => lines.push(line), () => 1_000_000);
      metrics.increment("redis_failure");
      metrics.increment("rate_limit_degraded");
      metrics.increment("redis_failure");
      expect(lines).toHaveLength(2);
    });

    it("the run-time total can never be reduced by throttling", () => {
      const metrics = createAirMetrics(() => undefined, () => 5);
      for (let i = 0; i < 1_000; i += 1) metrics.increment("provider_failure");
      expect(metrics.snapshot().provider_failure).toBe(1_000);
    });
  });

  it("never emits a field outside the allow-list", () => {
    const lines: string[] = [];
    const metrics = createAirMetrics((line) => lines.push(line));
    metrics.increment("rate_limit_rejection", { cityId: "mumbai", ip: "198.51.100.7", token: "t0ken" } as never);
    expect(lines[0]).not.toMatch(/198\.51|t0ken|"ip"|"token"/);
  });

  it("keeps independent counters per instance", () => {
    const a = createAirMetrics(() => undefined);
    const b = createAirMetrics(() => undefined);
    a.increment("redis_failure");
    expect(b.snapshot().redis_failure).toBe(0);
  });

  it("noopMetrics does nothing", () => {
    noopMetrics.increment("redis_failure");
    expect(noopMetrics.snapshot().redis_failure).toBe(0);
  });
});
