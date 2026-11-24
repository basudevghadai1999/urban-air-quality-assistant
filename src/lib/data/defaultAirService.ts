import "server-only";

import { randomUUID } from "node:crypto";

import { MemoryCache, TieredCache } from "@/lib/cache";
import { UpstashCache } from "@/lib/cache/upstash";
import {
  getAirServiceConfig,
  getRateLimitPolicy,
  getRedisConfig,
  isProductionRuntime,
  type RedisSetting,
} from "@/lib/env";
import { consoleSafeLogger } from "@/lib/observability/logger";
import { createAirMetrics, type AirMetrics } from "@/lib/observability/metrics";
import { MemoryRateLimiter, detectIpTrust } from "@/lib/ratelimit";
import { createRateLimitGate, type RateLimitGate } from "@/lib/ratelimit/gate";
import { RedisRateLimiter } from "@/lib/ratelimit/redis";
import { createUpstashRestClient, type RedisCommandClient } from "@/lib/redis";
import type { NormalizedAirData } from "@/types/air";

import { consoleAirLogger, createAirService, type AirService } from "./airService";
import { fetchOpenMeteoAirQuality } from "./openMeteo";

/**
 * Process-wide wiring for the API route.
 *
 * Instances live on `globalThis` under registered symbols so that every route
 * bundle, and Next.js dev hot reloads, share one cache, one limiter and one set
 * of counters instead of each module copy silently starting empty.
 *
 * Capability matrix (what protects what):
 *   Redis configured and healthy   durable last-known-good across cold starts and instances;
 *                                  rate limiting shared by all instances
 *   Redis configured but failing   memory cache only (still serves a warm instance's snapshot);
 *                                  no upstream refresh without a rate-limit decision (see gate.ts)
 *   Redis not configured           per-instance memory cache and per-instance rate limiting.
 *                                  Fine for local development; in PRODUCTION every response says
 *                                  `cache.degraded: true` and a startup warning is logged.
 */

const SERVICE_KEY = Symbol.for("urban-air-intelligence.air-service");
const GATE_KEY = Symbol.for("urban-air-intelligence.air-rate-limit-gate");
const INFRA_KEY = Symbol.for("urban-air-intelligence.air-infrastructure");

export interface Infrastructure {
  readonly setting: RedisSetting;
  readonly client: RedisCommandClient | null;
  readonly metrics: AirMetrics;
  readonly production: boolean;
  /** Per-process fallback key for hashing client identifiers when no Redis token is available. */
  readonly ephemeralSecret: string;
}

type Store = Record<symbol, unknown>;

/** Shared with the AI layer, so there is one Redis client, one set of counters and one hashing secret. */
export function getSharedInfrastructure(): Infrastructure {
  const store = globalThis as unknown as Store;
  const existing = store[INFRA_KEY] as Infrastructure | undefined;
  if (existing !== undefined) return existing;

  const setting = getRedisConfig();
  const production = isProductionRuntime();
  const client = setting.status === "configured" ? createUpstashRestClient(setting.config) : null;

  // Report the problem by variable NAME only. The value (and the token) are never logged.
  if (setting.status === "invalid") {
    consoleSafeLogger.warn("air.redis_config_invalid", { kind: setting.variable });
  }
  if (production && client === null) {
    consoleSafeLogger.warn("air.durable_cache_not_configured", { kind: "memory-only-in-production" });
  }

  const infrastructure: Infrastructure = {
    setting,
    client,
    metrics: createAirMetrics(),
    production,
    ephemeralSecret: randomUUID(),
  };
  store[INFRA_KEY] = infrastructure;
  return infrastructure;
}

export function getAirService(): AirService {
  const store = globalThis as unknown as Store;
  const existing = store[SERVICE_KEY] as AirService | undefined;
  if (existing !== undefined) return existing;

  // Read configuration first: an invalid setting must throw before anything is stored.
  const config = getAirServiceConfig();
  const { client, metrics, production } = getSharedInfrastructure();

  const durable =
    client === null
      ? null
      : new UpstashCache({
          client,
          // Redis forgets a snapshot once it is older than the maximum stale age.
          retentionSeconds: config.maxStaleSeconds,
          logger: consoleSafeLogger,
          metrics,
        });
  const cache = new TieredCache({
    memory: new MemoryCache<NormalizedAirData>(),
    durable,
    freshWithinMs: config.ttlSeconds * 1000,
    logger: consoleSafeLogger,
    metrics,
  });

  const service = createAirService({
    config,
    cache,
    now: () => Date.now(),
    fetcher: fetchOpenMeteoAirQuality,
    logger: consoleAirLogger,
    metrics,
    capability: () => cache.capability(),
    production,
  });
  store[SERVICE_KEY] = service;
  return service;
}

export function getAirRateLimitGate(): RateLimitGate {
  const store = globalThis as unknown as Store;
  const existing = store[GATE_KEY] as RateLimitGate | undefined;
  if (existing !== undefined) return existing;

  const policy = getRateLimitPolicy();
  const { client, setting, metrics, ephemeralSecret } = getSharedInfrastructure();

  const gate = createRateLimitGate({
    limiter: client === null ? new MemoryRateLimiter(policy) : new RedisRateLimiter({ client, policy }),
    ipTrust: detectIpTrust(process.env),
    // Keyed with the Redis token when there is one (already a secret we hold, and stable across instances,
    // so every instance derives the same key for the same client); otherwise a per-process random key.
    hashSecret: setting.status === "configured" ? setting.config.token : ephemeralSecret,
    logger: consoleSafeLogger,
    metrics,
  });
  store[GATE_KEY] = gate;
  return gate;
}
