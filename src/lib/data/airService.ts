import { getCityById, type City, type CityId } from "@/config/cities";
import type { CacheAdapter, CacheEntry } from "@/lib/cache";
import { noopMetrics, type AirMetrics } from "@/lib/observability/metrics";
import { ageSeconds } from "@/lib/time";
import type { CacheCapability, NormalizedAirData } from "@/types/air";

import { buildAirSnapshot, buildUnavailableAirData, presentSnapshot } from "./airData";
import type { AirServiceConfig } from "./config";
import { mapOpenMeteoResponse, type FetchOptions, type OpenMeteoResponse } from "./openMeteo";
import { isOpenMeteoError } from "./openMeteo/errors";

/**
 * Air data service: cache -> provider -> last-known-good fallback.
 *
 *   1. Fresh cache hit (age <= TTL)            -> serve it.
 *   2. Otherwise refresh from Open-Meteo        -> cache and serve (cache "miss").
 *   3. Refresh failed, a cached snapshot exists -> serve it, marked STALE, with its
 *      ORIGINAL fetchedAt and a computed age (never refreshed to look new).
 *   4. Refresh failed, nothing cached           -> explicit "unavailable" state.
 *
 * With `allowUpstream: false` (used when request limiting is unavailable) the
 * provider is never called: step 1 still applies, an older snapshot is served as
 * stale ("refresh paused"), and otherwise the result is "unavailable".
 *
 * Reliability measures:
 *   - single-flight: concurrent requests for a city share one provider call;
 *   - failure back-off: after a failure the provider is not called again for a
 *     short period, so an outage or a 429 does not burn the free quota;
 *   - nothing here throws to the caller for provider or cache problems.
 *
 * All collaborators are injected, so tests need no network, clock or globals.
 */

export interface AirLogger {
  warn(event: string, fields: Readonly<Record<string, string | number | undefined>>): void;
}

export type AirFetcher = (cityId: string, options: FetchOptions) => Promise<OpenMeteoResponse>;

export interface AirServiceDeps {
  readonly config: AirServiceConfig;
  readonly cache: CacheAdapter<NormalizedAirData>;
  /** Epoch milliseconds. */
  readonly now: () => number;
  readonly fetcher: AirFetcher;
  readonly logger: AirLogger;
  /** Counters for cache and provider events. Optional; defaults to none. */
  readonly metrics?: AirMetrics;
  /** Reports what the cache backend can really do. Omitted: the response carries no capability claim. */
  readonly capability?: () => CacheCapability;
  /** In production, anything other than a working persistent cache is flagged `degraded`. */
  readonly production?: boolean;
}

export interface AirRequestOptions {
  /** Default true. False: never call the provider for this request (serve cache only). */
  readonly allowUpstream?: boolean;
}

export interface AirService {
  getAirData(cityId: CityId, options?: AirRequestOptions): Promise<NormalizedAirData>;
}

/** Writes one JSON line per event. Fields are restricted to non-sensitive scalars by the type. */
export const consoleAirLogger: AirLogger = {
  warn(event, fields) {
    console.warn(JSON.stringify({ level: "warn", event, ...fields }));
  },
};

export function createAirService(deps: AirServiceDeps): AirService {
  const { config, cache, now, fetcher, logger } = deps;
  const metrics = deps.metrics ?? noopMetrics;
  const ttlMs = config.ttlSeconds * 1000;
  const maxStaleMs = config.maxStaleSeconds * 1000;
  const backoffMs = config.failureBackoffSeconds * 1000;

  const inflight = new Map<CityId, Promise<NormalizedAirData>>();
  const lastFailureAtMs = new Map<CityId, number>();

  /** Attach the cache capability, so a response never implies durability that is not there. */
  function finalize(data: NormalizedAirData): NormalizedAirData {
    if (deps.capability === undefined) return data;
    const capability = deps.capability();
    return {
      ...data,
      cache: { ...data.cache, capability, degraded: (deps.production ?? false) && capability !== "persistent" },
    };
  }

  async function readCache(cityId: CityId): Promise<CacheEntry<NormalizedAirData> | null> {
    try {
      return await cache.get(cityId);
    } catch {
      // A broken cache must degrade to "no cache", never to a failed request.
      logger.warn("air.cache_read_failed", { cityId });
      return null;
    }
  }

  function servable(entry: CacheEntry<NormalizedAirData> | null): entry is CacheEntry<NormalizedAirData> {
    return entry !== null && now() - entry.storedAtMs <= maxStaleMs;
  }

  function fallback(city: City, entry: CacheEntry<NormalizedAirData> | null): NormalizedAirData {
    if (servable(entry)) {
      metrics.increment("stale_fallback", { cityId: city.id });
      return finalize(presentSnapshot(entry.value, { nowMs: now(), ttlSeconds: config.ttlSeconds, mode: "stale-fallback" }));
    }
    return finalize(buildUnavailableAirData(city, config.ttlSeconds, undefined, now()));
  }

  /** The provider is deliberately not called: serve what the cache has, or say there is nothing. */
  function paused(city: City, entry: CacheEntry<NormalizedAirData> | null): NormalizedAirData {
    metrics.increment("refresh_paused", { cityId: city.id });
    if (servable(entry)) {
      return finalize(presentSnapshot(entry.value, { nowMs: now(), ttlSeconds: config.ttlSeconds, mode: "stale-paused" }));
    }
    return finalize(
      buildUnavailableAirData(
        city,
        config.ttlSeconds,
        "Live data is paused because request limiting is temporarily unavailable.",
        now(),
      ),
    );
  }

  async function refresh(city: City, entry: CacheEntry<NormalizedAirData> | null): Promise<NormalizedAirData> {
    try {
      const response = await fetcher(city.id, { timeoutMs: config.upstreamTimeoutMs });
      // `fetchedAt` is the moment the provider answered. It travels with the data from here on.
      const fetchedAtMs = now();
      const mapped = mapOpenMeteoResponse(response, city, fetchedAtMs);
      const snapshot = buildAirSnapshot(mapped, city, fetchedAtMs, config.ttlSeconds);

      try {
        await cache.set(city.id, { value: snapshot, storedAtMs: fetchedAtMs });
      } catch {
        logger.warn("air.cache_write_failed", { cityId: city.id });
      }
      lastFailureAtMs.delete(city.id);
      metrics.increment("cache_miss", { cityId: city.id });
      return finalize(presentSnapshot(snapshot, { nowMs: now(), ttlSeconds: config.ttlSeconds, mode: "miss" }));
    } catch (error) {
      lastFailureAtMs.set(city.id, now());
      const code = isOpenMeteoError(error) ? error.code : "UNEXPECTED";
      metrics.increment(code === "UPSTREAM_TIMEOUT" ? "provider_timeout" : "provider_failure", { cityId: city.id, code });
      // Log the failure class only: never response bodies, provider reasons or URLs.
      logger.warn("air.refresh_failed", {
        cityId: city.id,
        code,
        status: isOpenMeteoError(error) ? error.status : undefined,
        detail: isOpenMeteoError(error) ? error.detail : undefined,
        servedStale: entry === null ? 0 : 1,
      });
      return fallback(city, entry);
    }
  }

  return {
    async getAirData(cityId, options = {}) {
      const city = getCityById(cityId);
      if (city === undefined) throw new RangeError("unknown city id");
      const allowUpstream = options.allowUpstream ?? true;

      const entry = await readCache(cityId);
      const nowMs = now();

      if (entry !== null && nowMs - entry.storedAtMs <= ttlMs) {
        metrics.increment("cache_hit", { cityId });
        return finalize(presentSnapshot(entry.value, { nowMs, ttlSeconds: config.ttlSeconds, mode: "hit" }));
      }

      // Joining a refresh that is already running makes no extra provider call, so it is always safe.
      const existing = inflight.get(cityId);
      if (existing !== undefined) return existing;

      if (!allowUpstream) return paused(city, entry);

      const failedAt = lastFailureAtMs.get(cityId);
      if (failedAt !== undefined && nowMs - failedAt < backoffMs) {
        return fallback(city, entry);
      }

      const pending = refresh(city, entry).finally(() => {
        inflight.delete(cityId);
      });
      inflight.set(cityId, pending);
      return pending;
    },
  };
}

/** Seconds a response may be shared by a CDN: the remaining freshness window, never more. */
export function remainingFreshSeconds(data: NormalizedAirData, nowMs: number): number {
  if (data.freshnessStatus !== "fresh" || data.fetchedAt === null) return 0;
  const age = ageSeconds(Date.parse(data.fetchedAt), nowMs);
  return Math.max(0, data.cache.ttlSeconds - age);
}
