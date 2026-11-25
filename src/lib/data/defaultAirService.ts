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
import { processSingleton } from "@/lib/singleton";
import type { NormalizedAirData } from "@/types/air";

import { createAirService, type AirService } from "./airService";
import { fetchOpenMeteoAirQuality } from "./openMeteo";

/**
 * Process-wide wiring for the API route.
 *
 * Each instance is built once per PROCESS (see `processSingleton`), so every route bundle, and Next.js
 * dev hot reloads, share one cache, one limiter and one set of counters instead of each module copy
 * silently starting empty. Other instances (Render, serverless) each have their own; Redis is what they share.
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


export interface Infrastructure {
  readonly setting: RedisSetting;
  readonly client: RedisCommandClient | null;
  readonly metrics: AirMetrics;
  readonly production: boolean;
  /** Per-process fallback key for hashing client identifiers when no Redis token is available. */
  readonly ephemeralSecret: string;
}

/** Shared with the AI layer, so there is one Redis client, one set of counters and one hashing secret. */
export function getSharedInfrastructure(): Infrastructure {
  return processSingleton("air-infrastructure", createInfrastructure);
}

function createInfrastructure(): Infrastructure {
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

  return {
    setting,
    client,
    metrics: createAirMetrics(),
    production,
    ephemeralSecret: randomUUID(),
  };
}

export function getAirService(): AirService {
  return processSingleton("air-service", createDefaultAirService);
}

function createDefaultAirService(): AirService {
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

  return createAirService({
    config,
    cache,
    now: () => Date.now(),
    fetcher: fetchOpenMeteoAirQuality,
    logger: consoleSafeLogger,
    metrics,
    capability: () => cache.capability(),
    production,
  });
}

export function getAirRateLimitGate(): RateLimitGate {
  return processSingleton("air-rate-limit-gate", createAirRateLimitGate);
}

function createAirRateLimitGate(): RateLimitGate {
  const policy = getRateLimitPolicy();
  const { client, setting, metrics, ephemeralSecret } = getSharedInfrastructure();

  return createRateLimitGate({
    limiter: client === null ? new MemoryRateLimiter(policy) : new RedisRateLimiter({ client, policy }),
    ipTrust: detectIpTrust(process.env),
    // Keyed with the Redis token when there is one (already a secret we hold, and stable across instances,
    // so every instance derives the same key for the same client); otherwise a per-process random key.
    hashSecret: setting.status === "configured" ? setting.config.token : ephemeralSecret,
    logger: consoleSafeLogger,
    metrics,
  });
}
