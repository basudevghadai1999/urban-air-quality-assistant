import { describe, expect, it } from "vitest";

import {
  PRIORITY_WEIGHTS,
  TIER_THRESHOLDS,
  compareByPriority,
  prioritize,
  type PriorityInput,
} from "@/lib/engine";
import { EXPOSURE_REDUCTION_FULL_SCORE_UG } from "@/lib/engine/prioritization";
import { buildConfidence, UNAVAILABLE_CONFIDENCE } from "@/lib/engine/confidence";

const HIGH_CONF = buildConfidence([]);
const MED_CONF = buildConfidence([{ id: "x", penalty: 0.35, detail: "x" }]);
const LOW_CONF = buildConfidence([{ id: "x", penalty: 0.7, detail: "x" }]);

const base: PriorityInput = {
  id: "item",
  severity: "high",
  vulnerability: 0.8,
  exposureReductionUg: 20,
  feasibility: "high",
  cost: "none",
  confidence: HIGH_CONF,
};

describe("priority score", () => {
  it("uses documented weights that sum to one", () => {
    const sum = Object.values(PRIORITY_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1, 10);
  });

  it("is the weighted sum of its six factors, shown in the breakdown", () => {
    const r = prioritize(base);
    const b = r.breakdown;
    expect(b.severity).toBeCloseTo(0.3 * 0.75, 3);
    expect(b.vulnerability).toBeCloseTo(0.2 * 0.8, 3);
    expect(b.exposureReduction).toBeCloseTo(0.2 * 0.5, 3);
    expect(b.feasibility).toBeCloseTo(0.1, 3);
    expect(b.cost).toBeCloseTo(0.05, 3);
    expect(b.confidence).toBeCloseTo(0.15, 3);
    expect(r.score).toBeCloseTo(Object.values(b).reduce((x, y) => x + y, 0), 2);
  });

  it("is deterministic", () => {
    expect(prioritize(base)).toEqual(prioritize({ ...base }));
  });

  it("rises with severity, vulnerability, exposure reduction, feasibility, low cost and confidence", () => {
    const score = (over: Partial<PriorityInput>) => prioritize({ ...base, ...over }).score;
    expect(score({ severity: "very-high" })).toBeGreaterThan(score({ severity: "high" }));
    expect(score({ severity: "high" })).toBeGreaterThan(score({ severity: "moderate" }));
    expect(score({ severity: "moderate" })).toBeGreaterThan(score({ severity: "low" }));
    expect(score({ vulnerability: 1 })).toBeGreaterThan(score({ vulnerability: 0.4 }));
    expect(score({ exposureReductionUg: 30 })).toBeGreaterThan(score({ exposureReductionUg: 5 }));
    expect(score({ feasibility: "high" })).toBeGreaterThan(score({ feasibility: "low" }));
    expect(score({ cost: "none" })).toBeGreaterThan(score({ cost: "high" }));
    expect(score({ confidence: HIGH_CONF })).toBeGreaterThan(score({ confidence: MED_CONF }));
  });

  it("saturates the exposure factor and gives unquantified actions a neutral score", () => {
    const at = (ug: number | null) => prioritize({ ...base, exposureReductionUg: ug }).breakdown.exposureReduction;
    expect(at(EXPOSURE_REDUCTION_FULL_SCORE_UG)).toBeCloseTo(0.2, 3);
    expect(at(EXPOSURE_REDUCTION_FULL_SCORE_UG * 10)).toBe(at(EXPOSURE_REDUCTION_FULL_SCORE_UG));
    expect(at(-5)).toBe(0);
    expect(at(null)).toBeCloseTo(0.2 * 0.3, 3);
  });

  it("scores unavailable confidence as zero", () => {
    expect(prioritize({ ...base, confidence: UNAVAILABLE_CONFIDENCE("x") }).breakdown.confidence).toBe(0);
  });
});

describe("tiers", () => {
  it("maps score to high, recommended and optional with documented thresholds", () => {
    expect(TIER_THRESHOLDS).toEqual({ high: 0.7, recommended: 0.45 });
    expect(prioritize({ ...base, severity: "very-high", vulnerability: 1, exposureReductionUg: 40 }).tier).toBe("high");
    expect(prioritize({ ...base, severity: "moderate" }).tier).toBe("recommended");
    expect(prioritize({ ...base, severity: "low", vulnerability: 0.1, exposureReductionUg: 0, feasibility: "low", cost: "high", confidence: LOW_CONF }).tier).toBe("optional");
  });

  it("does not raise alarm in clean air: 'high' needs at least moderate severity", () => {
    const r = prioritize({ ...base, severity: "low", vulnerability: 1, exposureReductionUg: 40, confidence: HIGH_CONF });
    expect(r.tier).not.toBe("high");
    const unknown = prioritize({ ...base, severity: "unknown", vulnerability: 1, exposureReductionUg: 40 });
    expect(unknown.tier).not.toBe("high");
  });

  it("does not rank on thin evidence: 'high' needs at least medium confidence", () => {
    const strong = prioritize({ ...base, severity: "very-high", vulnerability: 1, exposureReductionUg: 40 });
    expect(strong.tier).toBe("high");
    const thin = prioritize({ ...base, severity: "very-high", vulnerability: 1, exposureReductionUg: 40, confidence: LOW_CONF });
    expect(thin.tier).not.toBe("high");
    expect(thin.adjustedBy).toMatch(/medium data confidence/);
  });

  it("honours a minimum tier and lets a maximum tier win", () => {
    const floor = prioritize({ ...base, severity: "low", vulnerability: 0.1, exposureReductionUg: 0, feasibility: "low", cost: "high", confidence: LOW_CONF, minTier: "recommended" });
    expect(floor.tier).toBe("recommended");
    expect(floor.adjustedBy).toMatch(/minimum tier/);
    const cap = prioritize({ ...base, severity: "very-high", vulnerability: 1, exposureReductionUg: 40, maxTier: "optional" });
    expect(cap.tier).toBe("optional");
    expect(cap.adjustedBy).toMatch(/maximum tier/);
    const both = prioritize({ ...base, minTier: "high", maxTier: "recommended" });
    expect(both.tier).toBe("recommended");
  });

  it("reports no adjustment when the score decides", () => {
    expect(prioritize({ ...base, severity: "moderate" }).adjustedBy).toBeNull();
  });
});

describe("ordering", () => {
  it("sorts by tier, then score, then ID, and is stable for ties", () => {
    const items = [
      { id: "b", tier: "recommended" as const, score: 0.5 },
      { id: "a", tier: "recommended" as const, score: 0.5 },
      { id: "c", tier: "high" as const, score: 0.71 },
      { id: "d", tier: "optional" as const, score: 0.44 },
      { id: "e", tier: "recommended" as const, score: 0.6 },
    ];
    expect([...items].sort(compareByPriority).map((i) => i.id)).toEqual(["c", "e", "a", "b", "d"]);
    expect([...items].reverse().sort(compareByPriority).map((i) => i.id)).toEqual(["c", "e", "a", "b", "d"]);
  });
});
