import { BUDGET_SCRIPT } from "@/lib/ai/budget";
import { PROVIDER_BUDGET_SCRIPT } from "@/lib/ai/providerBudget";
import { RATE_LIMIT_SCRIPT } from "@/lib/ratelimit/redis";
import type { RedisArg, RedisCommandClient } from "@/lib/redis";
import { RedisError, type RedisErrorKind } from "@/lib/redis/errors";

/**
 * In-memory stand-in for an Upstash Redis database, implementing exactly the
 * commands this app uses: GET, SET ... EX, DEL, and EVAL of the rate-limit script
 * (emulated with the same INCR / PEXPIRE / PTTL semantics as the Lua source).
 *
 * Features for tests: a controllable clock (so TTLs really expire), failure
 * injection (`down`, `failNext`), and a log of every command (so tests can prove
 * what was and was not sent). A single instance can back several caches/limiters,
 * which models many serverless instances sharing one Redis.
 */
export class FakeRedis implements RedisCommandClient {
  readonly commands: (readonly RedisArg[])[] = [];
  /** When set, every command fails with this kind. */
  down: RedisErrorKind | null = null;
  /** Fail the next N commands, in order. */
  failNext: RedisErrorKind[] = [];
  /** Fail every command whose name is listed (e.g. "GET", "SET", "EVAL"), leaving the others working. */
  failing = new Map<string, RedisErrorKind>();

  private readonly entries = new Map<string, { value: string; expiresAtMs: number | null }>();

  constructor(public now: () => number) {}

  /** Raw access for assertions and for planting corrupt data. */
  peek(key: string): string | null {
    return this.live(key)?.value ?? null;
  }

  plant(key: string, value: string, ttlSeconds?: number): void {
    this.entries.set(key, { value, expiresAtMs: ttlSeconds === undefined ? null : this.now() + ttlSeconds * 1000 });
  }

  ttlSeconds(key: string): number | null {
    const entry = this.live(key);
    return entry?.expiresAtMs == null ? null : Math.ceil((entry.expiresAtMs - this.now()) / 1000);
  }

  keys(): string[] {
    return [...this.entries.keys()].filter((key) => this.live(key) !== undefined);
  }

  count(commandName: string): number {
    return this.commands.filter((c) => String(c[0]).toUpperCase() === commandName.toUpperCase()).length;
  }

  command(args: readonly RedisArg[]): Promise<unknown> {
    this.commands.push(args);
    if (this.down !== null) return Promise.reject(new RedisError(this.down));
    const selective = this.failing.get(String(args[0]).toUpperCase());
    if (selective !== undefined) return Promise.reject(new RedisError(selective));
    const injected = this.failNext.shift();
    if (injected !== undefined) return Promise.reject(new RedisError(injected));

    try {
      return Promise.resolve(this.execute(args));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  private live(key: string) {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAtMs !== null && entry.expiresAtMs <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  private execute(args: readonly RedisArg[]): unknown {
    const [name, ...rest] = args;
    switch (String(name).toUpperCase()) {
      case "GET":
        return this.live(String(rest[0]))?.value ?? null;
      case "SET": {
        const [key, value, option, seconds] = rest;
        const ttl = String(option).toUpperCase() === "EX" ? Number(seconds) : null;
        this.entries.set(String(key), { value: String(value), expiresAtMs: ttl === null ? null : this.now() + ttl * 1000 });
        return "OK";
      }
      case "DEL":
        return this.entries.delete(String(rest[0])) ? 1 : 0;
      case "EVAL": {
        const [script, , key, windowMs] = rest;
        if (script === PROVIDER_BUDGET_SCRIPT) {
          // Same semantics as the Lua source: read both counters, refuse if either is full, else INCR both.
          const [globalKey, providerKey, globalLimit, providerLimit, ttl] = [rest[2], rest[3], Number(rest[4]), Number(rest[5]), Number(rest[6])];
          const read = (k: string) => Number(this.live(k)?.value ?? 0);
          const g0 = read(String(globalKey));
          const p0 = read(String(providerKey));
          if (g0 >= globalLimit) return [0, 1, g0, p0];
          if (p0 >= providerLimit) return [0, 2, g0, p0];
          for (const k of [String(globalKey), String(providerKey)]) {
            const entry = this.live(k);
            if (entry === undefined) this.entries.set(k, { value: "1", expiresAtMs: this.now() + ttl });
            else {
              entry.value = String(Number(entry.value) + 1);
              if (entry.expiresAtMs === null) entry.expiresAtMs = this.now() + ttl;
            }
          }
          return [1, 0, g0 + 1, p0 + 1];
        }
        if (script === BUDGET_SCRIPT) {
          // Same semantics as the Lua source: INCR, PEXPIRE on first use (and to heal), DECR when over the limit.
          const limit = Number(rest[3]);
          const ttlMs = Number(rest[4]);
          const budgetKey = String(key);
          const entry = this.live(budgetKey);
          const used = Number(entry?.value ?? 0) + 1;
          if (entry === undefined) this.entries.set(budgetKey, { value: String(used), expiresAtMs: this.now() + ttlMs });
          else {
            entry.value = String(used);
            if (entry.expiresAtMs === null) entry.expiresAtMs = this.now() + ttlMs;
          }
          if (used > limit) {
            const current = this.live(budgetKey);
            if (current !== undefined) current.value = String(used - 1);
            return [0, limit];
          }
          return [1, used];
        }
        if (script !== RATE_LIMIT_SCRIPT) throw new RedisError("command");
        const redisKey = String(key);
        const existing = this.live(redisKey);
        const count = Number(existing?.value ?? 0) + 1;
        if (existing === undefined) {
          // count == 1: PEXPIRE sets the window once and it is never extended.
          this.entries.set(redisKey, { value: String(count), expiresAtMs: this.now() + Number(windowMs) });
        } else {
          existing.value = String(count);
          if (existing.expiresAtMs === null) existing.expiresAtMs = this.now() + Number(windowMs); // heal
        }
        const ttl = (this.live(redisKey)?.expiresAtMs ?? 0) - this.now();
        return [count, ttl];
      }
      default:
        throw new RedisError("command");
    }
  }
}

/** A controllable clock. */
export function makeClock(start: number) {
  let now = start;
  return { now: () => now, advance: (ms: number) => void (now += ms), set: (ms: number) => void (now = ms) };
}
