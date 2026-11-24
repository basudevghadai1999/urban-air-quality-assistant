import type { Confidence, ConfidenceFactor, ConfidenceLevel } from "./types";

/** Score thresholds. Documented in docs/ENVIRONMENTAL_IMPACT_METHODOLOGY.md. */
export const CONFIDENCE_THRESHOLDS = { high: 0.75, medium: 0.5 } as const;

export function confidenceLevel(score: number): ConfidenceLevel {
  if (score >= CONFIDENCE_THRESHOLDS.high) return "high";
  if (score >= CONFIDENCE_THRESHOLDS.medium) return "medium";
  return "low";
}

/**
 * score = max(0, 1 - sum(penalties)), rounded to 2 decimals. Factors with a zero penalty are kept
 * as information. Deterministic: the same factors always give the same confidence.
 */
export function buildConfidence(factors: readonly ConfidenceFactor[]): Confidence {
  const total = factors.reduce((sum, f) => sum + f.penalty, 0);
  const score = Math.round(Math.max(0, 1 - total) * 100) / 100;
  return { level: confidenceLevel(score), score, factors };
}

export const UNAVAILABLE_CONFIDENCE = (reason: string): Confidence => ({
  level: "unavailable",
  score: 0,
  factors: [{ id: "unavailable", penalty: 1, detail: reason }],
});

/** The weakest of several confidences (used for results that combine several inputs). */
export function weakest(items: readonly Confidence[]): Confidence {
  const usable = items.filter((c) => c.level !== "unavailable");
  if (items.length === 0 || usable.length === 0) return UNAVAILABLE_CONFIDENCE("no usable inputs");
  return usable.reduce((min, c) => (c.score < min.score ? c : min));
}
