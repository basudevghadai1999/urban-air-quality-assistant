import "server-only";

import { RedisError } from "@/lib/redis/errors";
import { expectTuple, isCounter, type RedisCommandClient } from "@/lib/redis";

import type { RateLimitPolicy, RateLimiter, RateLimitResult } from "./types";

/**
 * Distributed fixed-window limiter on Redis, shared by every serverless instance.
 *
 * One atomic Lua script does the whole step (Upstash documents that pipelines are
 * NOT atomic, so INCR + EXPIRE as two commands could leave a counter with no expiry):
 *   - INCR the client's counter;
 *   - on the first hit of a window, set its expiry (the window length);
 *   - heal a counter that somehow has no expiry;
 *   - return [count, milliseconds until reset].
 * The window starts at a client's first request and the counter is never extended,
 * so a client cannot keep itself blocked by retrying. Worst case is a burst of
 * up to twice the limit straddling a window boundary (a property of fixed windows).
 *
 * NOTE: this exact script (SHA-256 prefix 6900fd94840edb76) ran against a real Upstash Redis on
 * 2026-11-24 at commit e2bcac5: sequential limiting, 40 concurrent requests allowing exactly the limit,
 * expiry and per-client buckets. The reply validation added since then (expectTuple/isCounter) was
 * checked against real Upstash replies on 2026-11-25 (allow and refusal accepted, tampered replies
 * rejected). Production keys and the PTTL-repair branch were never exercised. See README "Verify the deployment".
 */
export const RATE_LIMIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`.trim();

export const DEFAULT_RATE_LIMIT_KEY_PREFIX = "air:v1:rl:";

/** Keys are hashes or fixed labels: lowercase letters, digits and colons only. */
const KEY_PATTERN = /^[a-z0-9:]{1,80}$/;

export interface RedisRateLimiterOptions {
  readonly client: RedisCommandClient;
  readonly policy: RateLimitPolicy;
  readonly keyPrefix?: string;
}

export class RedisRateLimiter implements RateLimiter {
  private readonly client: RedisCommandClient;
  private readonly policy: RateLimitPolicy;
  private readonly keyPrefix: string;

  constructor(options: RedisRateLimiterOptions) {
    this.client = options.client;
    this.policy = options.policy;
    this.keyPrefix = options.keyPrefix ?? DEFAULT_RATE_LIMIT_KEY_PREFIX;
  }

  async check(key: string): Promise<RateLimitResult> {
    if (!KEY_PATTERN.test(key)) throw new RangeError("invalid rate-limit key");
    const windowMs = this.policy.windowSeconds * 1000;

    const reply = await this.client.command(["EVAL", RATE_LIMIT_SCRIPT, 1, `${this.keyPrefix}${key}`, windowMs]);
    const [count, ttlMs] = expectTuple(reply, 2);
    // The script has just INCRed the key, so a count below 1 (or one that is not an exact integer) is not its reply.
    if (!isCounter(count) || count < 1) throw new RedisError("protocol");
    if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs)) throw new RedisError("protocol");

    return {
      allowed: count <= this.policy.limit,
      limit: this.policy.limit,
      remaining: Math.max(0, this.policy.limit - count),
      resetSeconds: Math.max(1, Math.ceil(Math.min(Math.max(ttlMs, 0), windowMs) / 1000)),
    };
  }
}
