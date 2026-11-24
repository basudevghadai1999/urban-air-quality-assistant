/** Small, dependency-free helpers shared by server and client code. */

type ClassValue = string | false | null | undefined;

/** Join class names, skipping falsy values. */
export function cn(...inputs: ClassValue[]): string {
  return inputs.filter((value): value is string => Boolean(value)).join(" ");
}

/** Constrain `value` to the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  if (min > max) {
    throw new RangeError("clamp: min must not be greater than max");
  }
  return Math.min(Math.max(value, min), max);
}

/**
 * Absorbs binary floating-point error at exact .5 ties: a value that is
 * mathematically 100.5 but computes as 100.49999999999999 must still round up.
 */
const ROUNDING_EPSILON = 1e-9;

/** Round to the nearest integer, with .5 rounding up (toward +Infinity). */
export function roundHalfUp(value: number): number {
  return Math.floor(value + 0.5 + ROUNDING_EPSILON);
}

/** Round to a fixed number of decimal places (removes float noise like 0.09999999999999998). */
export function roundToDecimals(value: number, decimals: number): number {
  return Number(value.toFixed(decimals));
}

/** True for null, undefined, empty, or whitespace-only strings. */
export function isBlank(value: string | null | undefined): boolean {
  return value === null || value === undefined || value.trim().length === 0;
}
