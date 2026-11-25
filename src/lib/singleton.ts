import "server-only";

/**
 * One instance per PROCESS, shared by every module copy in it.
 *
 * Instances live on `globalThis` under registered symbols (`Symbol.for`), so each route bundle and each Next.js
 * dev hot reload sees the same object instead of silently building its own empty cache, limiter or counter set.
 *
 * What this does and does not guarantee:
 *   - one instance per Node process. It does NOT make anything global: every serverless or Render instance
 *     has its own copy, which is why shared state (rate limits, budgets, the durable cache) lives in Redis;
 *   - no initialization race: `create` is synchronous and JavaScript is single-threaded, so concurrent first
 *     requests cannot interleave inside it, and all of them receive the same instance;
 *   - failure recovery: if `create` throws, nothing is stored, so the next call tries again (a fixed
 *     configuration takes effect without a restart of the module, and a broken instance is never kept).
 */

const PREFIX = "urban-air-intelligence.";

/** The one place that reads or writes the shared store. Keys are only ever written by `processSingleton`. */
const store = globalThis as unknown as Record<symbol, unknown>;

export function processSingleton<T>(name: string, create: () => T): T {
  const key = Symbol.for(`${PREFIX}${name}`);
  const existing = store[key];
  // Stored only below, under this name, by a caller that supplied `T`.
  if (existing !== undefined) return existing as T;
  const created = create();
  // If `create` itself caused the same singleton to be built (re-entrancy), keep the first one.
  const winner = store[key];
  if (winner !== undefined) return winner as T;
  store[key] = created;
  return created;
}

/** For tests: forget every process singleton, so the next call builds a fresh one. */
export function resetProcessSingletons(): void {
  for (const key of Object.getOwnPropertySymbols(globalThis)) {
    if (key.description?.startsWith(PREFIX) === true) Reflect.deleteProperty(globalThis, key);
  }
}
