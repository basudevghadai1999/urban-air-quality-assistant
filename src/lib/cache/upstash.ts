import "server-only";

import { noopMetrics, type AirMetrics } from "@/lib/observability/metrics";
import { silentLogger, type SafeLogger } from "@/lib/observability/logger";
import type { RedisCommandClient } from "@/lib/redis";
import type { NormalizedAirData } from "@/types/air";

import { SNAPSHOT_FORMAT_VERSION, parseStoredSnapshot } from "./snapshotSchema";
import type { CacheAdapter, CacheEntry } from "./types";

/**
 * Persistent cache adapter over Redis (Upstash REST).
 *
 * - One key per city: `<prefix><cityId>`, holding `{ v, storedAtMs, value }`.
 * - The Redis TTL is the MAXIMUM STALE AGE, so a snapshot disappears on its own
 *   once it is too old to serve. Freshness (15 min) is decided by the service,
 *   not by Redis, so an expired-but-retained snapshot stays available as the
 *   last-known-good fallback.
 * - `storedAtMs` and `fetchedAt` are written once and never rewritten on read.
 * - Reads are validated (see snapshotSchema.ts). A corrupt or invalid entry is a
 *   miss: it is counted, logged without its content, deleted, and never served.
 * - Only genuine readings are written. A snapshot that is "unavailable" or that
 *   was never fetched is refused, so a non-reading can never become cached data.
 *
 * Redis failures (timeout, network, auth) THROW a `RedisError`: the caller must
 * be able to tell a failure from a miss. `TieredCache` handles them.
 */

/** Tolerance for a stored timestamp ahead of our clock (clock skew between instances). */
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const MAX_ENTRY_CHARS = 512 * 1024;
const KEY_PATTERN = /^[a-z][a-z0-9-]{0,40}$/;

export interface UpstashCacheOptions {
  readonly client: RedisCommandClient;
  /** Redis TTL for written entries: the maximum stale age. */
  readonly retentionSeconds: number;
  readonly keyPrefix?: string;
  readonly now?: () => number;
  readonly logger?: SafeLogger;
  readonly metrics?: AirMetrics;
}

export const DEFAULT_CACHE_KEY_PREFIX = "air:v1:snapshot:";

export class UpstashCache implements CacheAdapter<NormalizedAirData> {
  private readonly client: RedisCommandClient;
  private readonly retentionSeconds: number;
  private readonly keyPrefix: string;
  private readonly now: () => number;
  private readonly logger: SafeLogger;
  private readonly metrics: AirMetrics;

  constructor(options: UpstashCacheOptions) {
    if (!Number.isInteger(options.retentionSeconds) || options.retentionSeconds < 1) {
      throw new RangeError("retentionSeconds must be a positive integer");
    }
    this.client = options.client;
    this.retentionSeconds = options.retentionSeconds;
    this.keyPrefix = options.keyPrefix ?? DEFAULT_CACHE_KEY_PREFIX;
    this.now = options.now ?? (() => Date.now());
    this.logger = options.logger ?? silentLogger;
    this.metrics = options.metrics ?? noopMetrics;
  }

  /** Only short lowercase IDs are allowed in a key, so a key can never be injected. */
  private redisKey(key: string): string {
    if (!KEY_PATTERN.test(key)) throw new RangeError("invalid cache key");
    return `${this.keyPrefix}${key}`;
  }

  async get(key: string): Promise<CacheEntry<NormalizedAirData> | null> {
    const redisKey = this.redisKey(key);
    const raw = await this.client.command(["GET", redisKey]);
    if (raw === null) return null;
    if (typeof raw !== "string") return this.discard(key, redisKey, "invalid-schema");

    const parsed = parseStoredSnapshot(raw);
    if (!parsed.ok) return this.discard(key, redisKey, parsed.reason);

    const { value, storedAtMs } = parsed;
    const fetchedAtMs = value.fetchedAt === null ? Number.NaN : Date.parse(value.fetchedAt);
    const consistent =
      value.cityId === key && // an entry under the wrong key is never served
      storedAtMs === fetchedAtMs && // the stored timestamp must be the original fetch time
      storedAtMs <= this.now() + FUTURE_SKEW_MS; // a future timestamp would look fresh forever
    if (!consistent) return this.discard(key, redisKey, "invalid-schema");

    return { value, storedAtMs };
  }

  async set(key: string, entry: CacheEntry<NormalizedAirData>): Promise<void> {
    const redisKey = this.redisKey(key);
    const { value } = entry;
    if (value.freshnessStatus === "unavailable" || value.fetchedAt === null || value.calculatedAqi === null) {
      throw new RangeError("refusing to cache something that is not a reading");
    }
    const payload = JSON.stringify({ v: SNAPSHOT_FORMAT_VERSION, storedAtMs: entry.storedAtMs, value });
    if (payload.length > MAX_ENTRY_CHARS) throw new RangeError("snapshot too large to cache");
    await this.client.command(["SET", redisKey, payload, "EX", this.retentionSeconds]);
  }

  async delete(key: string): Promise<void> {
    await this.client.command(["DEL", this.redisKey(key)]);
  }

  private async discard(key: string, redisKey: string, reason: "corrupt-json" | "invalid-schema"): Promise<null> {
    this.metrics.increment("cache_entry_corrupt", { cityId: key, kind: reason });
    this.logger.warn("air.cache_entry_discarded", { cityId: key, kind: reason });
    try {
      await this.client.command(["DEL", redisKey]);
    } catch {
      // Best effort: the entry is already being treated as a miss.
    }
    return null;
  }
}
