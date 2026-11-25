import { RedisError } from "./errors";

/**
 * Checks for what Redis sent back. A reply that is not exactly what the command promises is a PROTOCOL error,
 * never a repaired value: a malformed reply must not become a counter, a cache hit or a granted reservation.
 * These are the checks the callers share; each caller still owns the meaning of its own reply.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A counter Redis could have produced: a whole number from 0 up to 2^53 - 1 (beyond that it is not exact). */
export function isCounter(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** The elements of an array reply of exactly `length`, as untyped values the caller must still check. */
export function expectTuple(reply: unknown, length: number): readonly unknown[] {
  if (!Array.isArray(reply) || reply.length !== length) throw new RedisError("protocol");
  return reply;
}

/** `SET` answers the simple string "OK". Anything else (null, a number, text) did not store the value. */
export function expectOk(reply: unknown): void {
  if (reply !== "OK") throw new RedisError("protocol");
}

/** `DEL` of one key answers the number of keys removed: 0 or 1. */
export function expectDeleted(reply: unknown): void {
  if (reply !== 0 && reply !== 1) throw new RedisError("protocol");
}
