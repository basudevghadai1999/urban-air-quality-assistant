import { noopMetrics, type AirMetrics } from "@/lib/observability/metrics";
import { silentLogger, type SafeLogger } from "@/lib/observability/logger";
import { isRedisError } from "@/lib/redis/errors";
import type { CacheCapability, NormalizedAirData } from "@/types/air";

import type { CacheAdapter, CacheEntry } from "./types";

/**
 * Two-tier cache: in-process memory in front of an optional durable store.
 *
 *   read   memory fresh enough -> serve it (no durable call, saves Redis requests)
 *          otherwise durable -> keep the NEWER of {durable, memory}; remember it in memory
 *          durable failure   -> fall back to memory (a valid in-memory snapshot still counts)
 *   write  memory always; durable best-effort. A durable failure never fails the request.
 *
 * It never throws for a durable-store problem: it records it (counter, throttled
 * log without payloads) and degrades. It also reports honestly whether
 * persistence is actually working, so nothing claims durability it does not have.
 */

export interface TieredCacheOptions {
  readonly memory: CacheAdapter<NormalizedAirData>;
  /** Null when no durable store is configured (memory-only). */
  readonly durable: CacheAdapter<NormalizedAirData> | null;
  /** A memory entry younger than this is served without consulting the durable store. */
  readonly freshWithinMs: number;
  readonly now?: () => number;
  readonly logger?: SafeLogger;
  readonly metrics?: AirMetrics;
}

/** At most one failure log line per this interval, however many requests fail. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

export class TieredCache implements CacheAdapter<NormalizedAirData> {
  private readonly memory: CacheAdapter<NormalizedAirData>;
  private readonly durable: CacheAdapter<NormalizedAirData> | null;
  private readonly freshWithinMs: number;
  private readonly now: () => number;
  private readonly logger: SafeLogger;
  private readonly metrics: AirMetrics;

  private durableHealthy = true;
  private lastFailureLogMs = Number.NEGATIVE_INFINITY;

  constructor(options: TieredCacheOptions) {
    this.memory = options.memory;
    this.durable = options.durable;
    this.freshWithinMs = options.freshWithinMs;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? silentLogger;
    this.metrics = options.metrics ?? noopMetrics;
  }

  /** What survives a restart right now. */
  capability(): CacheCapability {
    if (this.durable === null) return "memory-only";
    return this.durableHealthy ? "persistent" : "persistent-unavailable";
  }

  async get(key: string): Promise<CacheEntry<NormalizedAirData> | null> {
    const local = await this.memory.get(key);
    if (local !== null && this.now() - local.storedAtMs <= this.freshWithinMs) return local;
    if (this.durable === null) return local;

    try {
      const remote = await this.durable.get(key);
      this.durableHealthy = true;
      if (remote !== null && (local === null || remote.storedAtMs > local.storedAtMs)) {
        await this.memory.set(key, remote);
        return remote;
      }
      return local;
    } catch (error) {
      this.recordFailure("get", error);
      return local;
    }
  }

  async set(key: string, entry: CacheEntry<NormalizedAirData>): Promise<void> {
    await this.memory.set(key, entry);
    if (this.durable === null) return;
    try {
      await this.durable.set(key, entry);
      this.durableHealthy = true;
    } catch (error) {
      this.recordFailure("set", error);
    }
  }

  async delete(key: string): Promise<void> {
    await this.memory.delete(key);
    if (this.durable === null) return;
    try {
      await this.durable.delete(key);
      this.durableHealthy = true;
    } catch (error) {
      this.recordFailure("delete", error);
    }
  }

  private recordFailure(operation: string, error: unknown): void {
    this.durableHealthy = false;
    const kind = isRedisError(error) ? error.kind : "unexpected";
    this.metrics.increment("redis_failure", { layer: "cache", operation, kind });
    const nowMs = this.now();
    if (nowMs - this.lastFailureLogMs >= FAILURE_LOG_INTERVAL_MS) {
      this.lastFailureLogMs = nowMs;
      this.logger.warn("air.durable_cache_failed", { operation, kind });
    }
  }
}
