import type { CacheAdapter, CacheEntry } from "./types";

/**
 * In-process cache adapter.
 *
 * LIMITS (read before relying on it):
 * - It lives in one server process. On serverless platforms every instance has
 *   its own copy, and a cold start begins empty, so last-known-good data is only
 *   available within a warm instance.
 * - It is lost on restart or redeploy.
 * - It is bounded (`maxEntries`); the oldest entry is evicted first.
 * For shared or durable last-known-good storage, implement `CacheAdapter` over a
 * persistent store and pass it to `createAirService`.
 */
export class MemoryCache<T> implements CacheAdapter<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(private readonly maxEntries = 64) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError("maxEntries must be a positive integer");
    }
  }

  get(key: string): Promise<CacheEntry<T> | null> {
    return Promise.resolve(this.entries.get(key) ?? null);
  }

  set(key: string, entry: CacheEntry<T>): Promise<void> {
    // Re-insert so the Map's insertion order tracks recency of writes.
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.entries.delete(key);
    return Promise.resolve();
  }

  get size(): number {
    return this.entries.size;
  }
}
