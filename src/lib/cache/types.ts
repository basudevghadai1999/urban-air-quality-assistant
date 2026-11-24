/**
 * Cache adapter contract.
 *
 * The air data service depends only on this interface, so a persistent shared
 * store (Redis, Vercel KV, a database) can replace the in-memory default
 * without touching the Open-Meteo client or the service logic.
 *
 * Adapters store entries and return them untouched. They do NOT decide
 * freshness: the service compares `storedAtMs` with its own TTL. That keeps
 * the original timestamp of last-known-good data intact, however old it is.
 *
 * Implementations must resolve (to `null`) rather than throw for a miss. A
 * thrown error is treated by the service as a miss and logged.
 */

export interface CacheEntry<T> {
  readonly value: T;
  /** When the value was obtained from its source (epoch ms). Never updated on read. */
  readonly storedAtMs: number;
}

export interface CacheAdapter<T> {
  get(key: string): Promise<CacheEntry<T> | null>;
  set(key: string, entry: CacheEntry<T>): Promise<void>;
  delete(key: string): Promise<void>;
}
