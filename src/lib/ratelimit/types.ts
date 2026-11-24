export interface RateLimitPolicy {
  /** Requests allowed per window, per client. */
  readonly limit: number;
  readonly windowSeconds: number;
}

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly limit: number;
  /** Requests left in the current window (0 once the limit is reached). */
  readonly remaining: number;
  /** Whole seconds until the current window ends and the counter resets (at least 1). */
  readonly resetSeconds: number;
}

/**
 * A rate limiter counts one request against an opaque, already-hashed key and
 * says whether it is allowed. Implementations throw if they cannot decide; the
 * caller must never treat a failure as "allowed".
 */
export interface RateLimiter {
  check(key: string): Promise<RateLimitResult>;
}

/** Initial policy: 30 requests per client per minute. Overridable via AIR_RATE_LIMIT_MAX / AIR_RATE_LIMIT_WINDOW_SECONDS. */
export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = Object.freeze({ limit: 30, windowSeconds: 60 });

export const RATE_LIMIT_BOUNDS = Object.freeze({
  limit: { min: 1, max: 10_000 },
  windowSeconds: { min: 1, max: 3_600 },
});
