import type { Confidence, CostLevel, Feasibility, PriorityTier, SeverityLevel } from "./types";

/**
 * Deterministic prioritisation. Every recommendation gets a score in 0..1 from six documented
 * factors, then a tier. The same inputs always give the same score and tier; ties are broken by ID.
 *
 *   score = 0.30 severity + 0.20 vulnerability + 0.20 exposure reduction
 *         + 0.10 feasibility + 0.05 low cost + 0.15 data confidence
 *
 *   high         score >= 0.70
 *   recommended  score >= 0.45
 *   optional     otherwise
 *
 * Guards against exaggeration (the engine must not alarm on thin evidence):
 *   - "high" needs severity of at least moderate, and data confidence of at least medium;
 *   - an item may carry a floor (`minTier`) or ceiling (`maxTier`); the ceiling wins over the score.
 * The weights and thresholds are engine policy, not clinical values.
 */

export const PRIORITY_WEIGHTS = {
  severity: 0.3,
  vulnerability: 0.2,
  exposureReduction: 0.2,
  feasibility: 0.1,
  cost: 0.05,
  confidence: 0.15,
} as const;

export const TIER_THRESHOLDS = { high: 0.7, recommended: 0.45 } as const;

/** An inhaled-mass reduction of this many micrograms scores 1.0 on the exposure factor. */
export const EXPOSURE_REDUCTION_FULL_SCORE_UG = 40;

/** Neutral exposure score for actions whose exposure benefit is real but not quantified. */
export const UNQUANTIFIED_EXPOSURE_SCORE = 0.3;

const SEVERITY_SCORE: Readonly<Record<SeverityLevel, number>> = {
  unknown: 0.3,
  low: 0.1,
  moderate: 0.45,
  high: 0.75,
  "very-high": 1,
};
const FEASIBILITY_SCORE: Readonly<Record<Feasibility, number>> = { high: 1, medium: 0.6, low: 0.3 };
const COST_SCORE: Readonly<Record<CostLevel, number>> = { none: 1, low: 0.8, medium: 0.5, high: 0.2 };
const TIER_RANK: Readonly<Record<PriorityTier, number>> = { optional: 0, recommended: 1, high: 2 };
const TIERS: readonly PriorityTier[] = ["optional", "recommended", "high"];

export interface PriorityInput {
  readonly id: string;
  readonly severity: SeverityLevel;
  /** 0..1, from the profile. */
  readonly vulnerability: number;
  /** Estimated PM2.5 inhaled-mass reduction (ug), or null when not quantified. */
  readonly exposureReductionUg: number | null;
  readonly feasibility: Feasibility;
  readonly cost: CostLevel;
  readonly confidence: Confidence;
  readonly minTier?: PriorityTier;
  readonly maxTier?: PriorityTier;
}

export interface PriorityResult {
  readonly id: string;
  readonly tier: PriorityTier;
  readonly score: number;
  /** Weighted contribution of each factor to the score. */
  readonly breakdown: {
    readonly severity: number;
    readonly vulnerability: number;
    readonly exposureReduction: number;
    readonly feasibility: number;
    readonly cost: number;
    readonly confidence: number;
  };
  /** Why the tier differs from the raw score's tier, if it does. */
  readonly adjustedBy: string | null;
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

function tierFromScore(score: number): PriorityTier {
  if (score >= TIER_THRESHOLDS.high) return "high";
  if (score >= TIER_THRESHOLDS.recommended) return "recommended";
  return "optional";
}

export function prioritize(input: PriorityInput): PriorityResult {
  const exposureFactor =
    input.exposureReductionUg === null
      ? UNQUANTIFIED_EXPOSURE_SCORE
      : clamp01(Math.max(0, input.exposureReductionUg) / EXPOSURE_REDUCTION_FULL_SCORE_UG);
  const parts = {
    severity: PRIORITY_WEIGHTS.severity * SEVERITY_SCORE[input.severity],
    vulnerability: PRIORITY_WEIGHTS.vulnerability * clamp01(input.vulnerability),
    exposureReduction: PRIORITY_WEIGHTS.exposureReduction * exposureFactor,
    feasibility: PRIORITY_WEIGHTS.feasibility * FEASIBILITY_SCORE[input.feasibility],
    cost: PRIORITY_WEIGHTS.cost * COST_SCORE[input.cost],
    confidence: PRIORITY_WEIGHTS.confidence * clamp01(input.confidence.score),
  };
  const score = r3(Object.values(parts).reduce((a, b) => a + b, 0));

  let tier = tierFromScore(score);
  let adjustedBy: string | null = null;
  const raise = (to: PriorityTier, why: string) => {
    if (TIER_RANK[to] > TIER_RANK[tier]) {
      tier = to;
      adjustedBy = why;
    }
  };
  const lower = (to: PriorityTier, why: string) => {
    if (TIER_RANK[to] < TIER_RANK[tier]) {
      tier = to;
      adjustedBy = why;
    }
  };

  if (tier === "high" && (input.severity === "low" || input.severity === "unknown")) {
    lower("recommended", "capped: high priority needs at least moderate pollution severity");
  }
  if (tier === "high" && (input.confidence.level === "low" || input.confidence.level === "unavailable")) {
    lower("recommended", "capped: high priority needs at least medium data confidence");
  }
  if (input.minTier !== undefined) raise(input.minTier, `raised to the item's minimum tier (${input.minTier})`);
  if (input.maxTier !== undefined) lower(input.maxTier, `capped at the item's maximum tier (${input.maxTier})`);

  return {
    id: input.id,
    tier,
    score,
    breakdown: {
      severity: r3(parts.severity),
      vulnerability: r3(parts.vulnerability),
      exposureReduction: r3(parts.exposureReduction),
      feasibility: r3(parts.feasibility),
      cost: r3(parts.cost),
      confidence: r3(parts.confidence),
    },
    adjustedBy,
  };
}

/** Stable ordering: tier, then score (high first), then ID. */
export function compareByPriority(a: { tier: PriorityTier; score: number; id: string }, b: { tier: PriorityTier; score: number; id: string }): number {
  return TIER_RANK[b.tier] - TIER_RANK[a.tier] || b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export { TIERS as PRIORITY_TIERS };
