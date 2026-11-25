import "server-only";

import type { AiProviderId } from "@/lib/env";
import { expectTuple, isCounter, type RedisCommandClient } from "@/lib/redis";
import { RedisError } from "@/lib/redis/errors";

import { msUntilNextUtcMidnight, secondsUntilUtcReset, utcDayKey } from "@/lib/time";

/**
 * Daily budgets across providers: a GLOBAL cap on provider calls plus a cap PER provider.
 *
 * What is counted: provider CALL ATTEMPTS. A reservation is made immediately before a call and is
 * kept whether the call then succeeds or fails (a request that reached a provider may still use its
 * quota, and counting failures is what stops a failing primary from silently doubling spend through
 * the secondary). Cache hits, deterministic fallbacks, rejected requests and calls that were never
 * made do not reserve.
 *
 * Why one atomic script: a reservation must charge the global counter AND the provider counter
 * together, and must charge neither when either is full. Two separate counters would let a provider
 * switch (or a crash between two calls) leak budget or exceed the global cap. The Lua script reads
 * both, decides, and increments both, so concurrent instances cannot oversell either. The global key
 * is the same key the single-provider budget used, so switching versions does not reset the day.
 *
 * Reset: both keys carry the UTC date, so 00:00 UTC starts new counters; the TTL outlives the day.
 * Failure: if Redis cannot decide, `reserve` throws and the caller must NOT call a provider.
 */

export const PROVIDER_BUDGET_SCRIPT = `
local g = tonumber(redis.call('GET', KEYS[1]) or '0')
local p = tonumber(redis.call('GET', KEYS[2]) or '0')
if g >= tonumber(ARGV[1]) then return {0, 1, g, p} end
if p >= tonumber(ARGV[2]) then return {0, 2, g, p} end
g = redis.call('INCR', KEYS[1])
p = redis.call('INCR', KEYS[2])
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], ARGV[3]) end
if redis.call('PTTL', KEYS[2]) < 0 then redis.call('PEXPIRE', KEYS[2], ARGV[3]) end
return {1, 0, g, p}
`.trim();

/** Global counter key prefix. Unchanged from the single-provider budget, so a version switch does not reset the day. */
export const DEFAULT_BUDGET_KEY_PREFIX = "ai:v1:budget:";
/** The key outlives its day so a late request never recreates yesterday's counter. */
const TTL_GRACE_MS = 3_600_000;

export interface ProviderBudgetLimits {
  readonly global: number;
  readonly providers: Readonly<Record<AiProviderId, number>>;
}

export interface ProviderReservation {
  readonly allowed: boolean;
  /** Which cap refused the reservation. Null when allowed. */
  readonly deniedBy: "global" | "provider" | null;
  readonly usedGlobal: number;
  readonly usedProvider: number;
  readonly resetsInSeconds: number;
}

export interface ProviderBudget {
  reserve(provider: AiProviderId): Promise<ProviderReservation>;
}

export interface RedisProviderBudgetOptions {
  readonly client: RedisCommandClient;
  readonly limits: ProviderBudgetLimits;
  readonly now?: () => number;
  readonly keyPrefix?: string;
}

export class RedisProviderBudget implements ProviderBudget {
  private readonly now: () => number;
  private readonly prefix: string;

  constructor(private readonly options: RedisProviderBudgetOptions) {
    this.now = options.now ?? (() => Date.now());
    this.prefix = options.keyPrefix ?? DEFAULT_BUDGET_KEY_PREFIX;
  }

  async reserve(provider: AiProviderId): Promise<ProviderReservation> {
    const nowMs = this.now();
    const day = utcDayKey(nowMs);
    const ttlMs = msUntilNextUtcMidnight(nowMs) + TTL_GRACE_MS;
    const { limits } = this.options;
    const reply = await this.options.client.command([
      "EVAL",
      PROVIDER_BUDGET_SCRIPT,
      2,
      `${this.prefix}${day}`,
      `${this.prefix}${provider}:${day}`,
      limits.global,
      limits.providers[provider],
      ttlMs,
    ]);
    const [allowed, denied, usedGlobal, usedProvider] = expectTuple(reply, 4);
    if (!isCounter(usedGlobal) || !isCounter(usedProvider)) throw new RedisError("protocol");
    // Only the script's two shapes are accepted: {1, 0, g, p} (charged) and {0, 1|2, g, p} (refused). Anything
    // else (such as {0, 0, ...}) is not guessed at: a refusal with no reason, or a grant that names one, is invalid.
    const granted = allowed === 1 && denied === 0 && usedGlobal >= 1 && usedProvider >= 1 && usedGlobal <= limits.global && usedProvider <= limits.providers[provider];
    const refused = allowed === 0 && (denied === 1 || denied === 2);
    if (!granted && !refused) throw new RedisError("protocol");
    return {
      allowed: allowed === 1,
      deniedBy: allowed === 1 ? null : denied === 1 ? "global" : "provider",
      usedGlobal,
      usedProvider,
      resetsInSeconds: secondsUntilUtcReset(nowMs),
    };
  }
}

/** Per-process budget for local development without Redis. Not shared between instances. */
export class MemoryProviderBudget implements ProviderBudget {
  private day = "";
  private global = 0;
  private readonly perProvider = new Map<AiProviderId, number>();

  constructor(
    private readonly limits: ProviderBudgetLimits,
    private readonly now: () => number = () => Date.now(),
  ) {}

  reserve(provider: AiProviderId): Promise<ProviderReservation> {
    const nowMs = this.now();
    const day = utcDayKey(nowMs);
    if (day !== this.day) {
      this.day = day;
      this.global = 0;
      this.perProvider.clear();
    }
    const used = this.perProvider.get(provider) ?? 0;
    const resetsInSeconds = secondsUntilUtcReset(nowMs);
    if (this.global >= this.limits.global) {
      return Promise.resolve({ allowed: false, deniedBy: "global", usedGlobal: this.global, usedProvider: used, resetsInSeconds });
    }
    if (used >= this.limits.providers[provider]) {
      return Promise.resolve({ allowed: false, deniedBy: "provider", usedGlobal: this.global, usedProvider: used, resetsInSeconds });
    }
    this.global += 1;
    this.perProvider.set(provider, used + 1);
    return Promise.resolve({ allowed: true, deniedBy: null, usedGlobal: this.global, usedProvider: used + 1, resetsInSeconds });
  }
}
