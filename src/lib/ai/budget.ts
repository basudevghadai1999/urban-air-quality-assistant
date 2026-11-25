import "server-only";

import { RedisError } from "@/lib/redis/errors";
import type { RedisCommandClient } from "@/lib/redis";

/**
 * Global daily budget for Gemini GENERATIONS, counted in calls (not money: no price is assumed).
 *
 * A reservation is made immediately before a model call and covers it whether it then succeeds or
 * fails, because a request that reached Gemini may still count against quota. Cache hits, fallbacks
 * and rejected requests never reserve.
 *
 * Redis: one atomic Lua script. It INCRs a counter whose key carries the UTC date, so the budget
 * resets at 00:00 UTC by construction (a new day is a new key), gives the key a TTL that outlives
 * the day, and DECRs again when the limit would be exceeded so the counter never drifts above the
 * limit. Being one script, concurrent reservations from many serverless instances cannot oversell it.
 * If Redis fails the reservation throws, and the caller must NOT call Gemini (fail closed).
 */

export interface BudgetReservation {
  readonly allowed: boolean;
  /** Reservations made today, including this one when allowed. */
  readonly used: number;
  readonly limit: number;
  /** Seconds until the budget resets (next 00:00 UTC). */
  readonly resetsInSeconds: number;
}

export interface DailyBudget {
  reserve(): Promise<BudgetReservation>;
}

export const BUDGET_SCRIPT = `
local used = redis.call('INCR', KEYS[1])
if used == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
if used > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return {0, tonumber(ARGV[1])}
end
return {1, used}
`.trim();

export const DEFAULT_BUDGET_KEY_PREFIX = "ai:v1:budget:";
const DAY_MS = 86_400_000;
/** The key outlives its day so a late request never recreates yesterday's counter. */
const TTL_GRACE_MS = 3_600_000;

/** `YYYYMMDD` for the UTC day containing `ms`. */
export function utcDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

export function msUntilNextUtcMidnight(ms: number): number {
  return DAY_MS - (((ms % DAY_MS) + DAY_MS) % DAY_MS);
}

const secondsUntilReset = (ms: number): number => Math.max(1, Math.ceil(msUntilNextUtcMidnight(ms) / 1000));

export interface RedisBudgetOptions {
  readonly client: RedisCommandClient;
  readonly limit: number;
  readonly now?: () => number;
  readonly keyPrefix?: string;
}

export class RedisDailyBudget implements DailyBudget {
  private readonly client: RedisCommandClient;
  private readonly limit: number;
  private readonly now: () => number;
  private readonly keyPrefix: string;

  constructor(options: RedisBudgetOptions) {
    this.client = options.client;
    this.limit = options.limit;
    this.now = options.now ?? (() => Date.now());
    this.keyPrefix = options.keyPrefix ?? DEFAULT_BUDGET_KEY_PREFIX;
  }

  async reserve(): Promise<BudgetReservation> {
    const nowMs = this.now();
    const key = `${this.keyPrefix}${utcDayKey(nowMs)}`;
    const ttlMs = msUntilNextUtcMidnight(nowMs) + TTL_GRACE_MS;
    const reply = await this.client.command(["EVAL", BUDGET_SCRIPT, 1, key, this.limit, ttlMs]);
    if (!Array.isArray(reply) || reply.length !== 2) throw new RedisError("protocol");
    const [allowed, used] = reply as unknown[];
    if ((allowed !== 0 && allowed !== 1) || typeof used !== "number" || !Number.isInteger(used) || used < 0) {
      throw new RedisError("protocol");
    }
    return { allowed: allowed === 1, used, limit: this.limit, resetsInSeconds: secondsUntilReset(nowMs) };
  }
}

/** Per-process budget, for local development without Redis. Not shared between instances. */
export class MemoryDailyBudget implements DailyBudget {
  private day = "";
  private used = 0;

  constructor(
    private readonly limit: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  reserve(): Promise<BudgetReservation> {
    const nowMs = this.now();
    const day = utcDayKey(nowMs);
    if (day !== this.day) {
      this.day = day;
      this.used = 0;
    }
    const allowed = this.used < this.limit;
    if (allowed) this.used += 1;
    return Promise.resolve({ allowed, used: this.used, limit: this.limit, resetsInSeconds: secondsUntilReset(nowMs) });
  }
}
