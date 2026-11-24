import type { RecommendationResult } from "@/lib/engine";
import type { ConfidenceLevel, PriorityTier } from "@/lib/engine/types";

import { formatNumber, slotText } from "./format";

/**
 * Turns the engine's ranked list into display cards. It only SELECTS and LABELS what the engine
 * already produced (matching IDs the same way the server does); it never computes a figure.
 */

export type RecommendationKind = "routine" | "trip-chaining" | "indoor" | "transport";

export interface Fact {
  readonly label: string;
  readonly value: string;
}

export interface RecommendationCard {
  readonly id: string;
  readonly kind: RecommendationKind;
  readonly title: string;
  readonly tier: PriorityTier;
  readonly why: string;
  readonly steps: readonly string[];
  readonly facts: readonly Fact[];
  readonly confidence: ConfidenceLevel | null;
  /** Estimated PM2.5 inhaled mass avoided (ug), straight from the ranking, or null. */
  readonly exposureReductionUg: number | null;
}

const EXPOSURE_WORDS = { lower: "Likely lower", higher: "Likely higher", unknown: "Not assessed" } as const;

export function buildRecommendationCards(result: RecommendationResult): RecommendationCard[] {
  const cards: RecommendationCard[] = [];
  const when = (t: Parameters<typeof slotText>[0]): string => slotText(t, result.generatedAt);
  for (const p of result.prioritized) {
    const base = { id: p.id, kind: p.kind, title: p.title, tier: p.tier, exposureReductionUg: p.exposureReductionUg };

    if (p.id === "ROUTINE_TRIP_CHAINING") {
      const c = result.routine.tripChaining;
      cards.push({
        ...base,
        why: c.reason,
        steps: c.instructions,
        facts: [
          ...(c.suggestedTime === null ? [] : [{ label: "Suggested time", value: when(c.suggestedTime) }]),
          ...(c.journeysSaved > 0 ? [{ label: "Journeys saved", value: String(c.journeysSaved) }] : []),
        ],
        confidence: c.explanation?.confidence.level ?? null,
      });
    } else if (p.id.startsWith("ROUTINE_")) {
      const item = result.routine.items.find((i) => `ROUTINE_${i.id}` === p.id);
      if (item === undefined) continue;
      cards.push({
        ...base,
        why: item.reason,
        steps: item.suggestedTime === null && item.indoorAlternative !== null ? [...item.instructions, item.indoorAlternative] : item.instructions,
        facts: [
          { label: "Usual time", value: `${item.usualStartLocal} IST` },
          ...(item.suggestedTime === null
            ? []
            : [{ label: "Suggested time", value: when(item.suggestedTime) }]),
          ...(item.alternativeTime === null ? [] : [{ label: "Alternative", value: when(item.alternativeTime) }]),
        ],
        confidence: item.confidence.level,
      });
    } else if (p.id.startsWith("INDOOR_")) {
      const iv = result.indoor.interventions.find((i) => `INDOOR_${i.id}` === p.id);
      if (iv === undefined) continue;
      cards.push({
        ...base,
        why: iv.whyItHelps,
        steps: [iv.action],
        facts: [
          { label: "Cost", value: iv.costLevel },
          { label: "Ease", value: iv.feasibility },
          ...(iv.conditions.length > 0 ? [{ label: "When", value: iv.conditions.join(" ") }] : []),
        ],
        confidence: iv.explanation.confidence.level,
      });
    } else if (p.id.startsWith("TRANSPORT_")) {
      const o = result.transport.options.find((x) => `TRANSPORT_${x.mode}` === p.id);
      if (o === undefined) continue;
      const diff = o.emissionsVsBaseline?.difference ?? null;
      cards.push({
        ...base,
        why: `${o.suggestionNote} ${o.tradeoff}`.trim(),
        steps: [],
        facts: [
          ...(o.emissions.totalGramsPerPassenger === null ? [] : [{ label: "Tailpipe CO2, one way", value: `${formatNumber(o.emissions.totalGramsPerPassenger)} g per passenger` }]),
          ...(diff === null || diff.direction === "no-change"
            ? []
            : [{ label: diff.direction === "reduction" ? "CO2 vs current mode" : "CO2 vs current mode (higher)", value: `${diff.direction === "reduction" ? "-" : "+"}${formatNumber(diff.gramsCo2)} g per passenger, one way` }]),
          { label: "Your exposure (qualitative)", value: EXPOSURE_WORDS[o.exposure.direction] },
        ],
        confidence: o.explanation.confidence.level,
      });
    }
  }
  return cards;
}
