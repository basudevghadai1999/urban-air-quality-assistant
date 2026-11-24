import type { RateLimitPolicy, RateLimiter, RateLimitResult } from "./types";

/**
 * In-process fixed-window limiter, for local development, tests and deployments
 * without Redis. LIMITS: counts live in one server instance, so on serverless each
 * instance enforces its own window and a cold start resets them. It bounds abuse
 * per instance; it is not a distributed limit. Use `RedisRateLimiter` for that.
 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAtMs: number }>();

  constructor(
    private readonly policy: RateLimitPolicy,
    private readonly now: () => number = () => Date.now(),
    private readonly maxKeys = 10_000,
  ) {}

  check(key: string): Promise<RateLimitResult> {
    const nowMs = this.now();
    const windowMs = this.policy.windowSeconds * 1000;

    let entry = this.windows.get(key);
    if (entry === undefined || entry.resetAtMs <= nowMs) {
      entry = { count: 0, resetAtMs: nowMs + windowMs };
      this.windows.set(key, entry);
      this.prune(nowMs);
    }
    entry.count += 1;

    return Promise.resolve({
      allowed: entry.count <= this.policy.limit,
      limit: this.policy.limit,
      remaining: Math.max(0, this.policy.limit - entry.count),
      resetSeconds: Math.max(1, Math.ceil((entry.resetAtMs - nowMs) / 1000)),
    });
  }

  /** Bound memory: drop expired windows, then the oldest, once past `maxKeys`. */
  private prune(nowMs: number): void {
    if (this.windows.size <= this.maxKeys) return;
    for (const [key, entry] of this.windows) {
      if (entry.resetAtMs <= nowMs) this.windows.delete(key);
    }
    while (this.windows.size > this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) break;
      this.windows.delete(oldest.value);
    }
  }

  get size(): number {
    return this.windows.size;
  }
}
