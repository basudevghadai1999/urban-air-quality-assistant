import { describe, expect, it } from "vitest";

import { buildRecommendationCards } from "@/components/dashboard/recommendationView";
import { PROFILE_IDS } from "@/lib/engine";

import { airFor, recommendFor } from "../../fixtures/dashboard";

describe("recommendation cards", () => {
  it.each(PROFILE_IDS)("keeps the engine's order and invents nothing for %s", (profileId) => {
    const result = recommendFor(airFor(), profileId);
    const cards = buildRecommendationCards(result);
    const ranked = result.prioritized.map((p) => p.id);
    expect(cards.length).toBeGreaterThan(0);
    // Every card is one of the engine's ranked IDs, in the engine's relative order.
    const positions = cards.map((c) => ranked.indexOf(c.id));
    expect(positions.every((i) => i >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    for (const c of cards) {
      expect(c.title).toBe(result.prioritized[ranked.indexOf(c.id)]?.title);
      expect(c.tier).toBe(result.prioritized[ranked.indexOf(c.id)]?.tier);
      expect(c.why.length).toBeGreaterThan(0);
    }
  });

  it("covers routine, indoor and transport recommendations", () => {
    const kinds = new Set(buildRecommendationCards(recommendFor(airFor(), "two_wheeler_commuter")).map((c) => c.kind === "trip-chaining" ? "routine" : c.kind));
    expect(kinds.has("routine")).toBe(true);
    expect(kinds.has("indoor")).toBe(true);
    expect(kinds.has("transport")).toBe(true);
  });

  it("copies engine figures with units and never computes new ones", () => {
    const result = recommendFor(airFor(), "two_wheeler_commuter");
    for (const c of buildRecommendationCards(result)) {
      for (const f of c.facts) {
        const grams = /^(-|\+)?[\d.]+ g per passenger/.exec(f.value);
        if (grams !== null) {
          const numbers = result.transport.options.flatMap((o) => [o.emissions.totalGramsPerPassenger, o.emissionsVsBaseline?.difference?.gramsCo2 ?? null]).filter((n): n is number => n !== null);
          expect(numbers.some((n) => Math.abs(n - Math.abs(Number(f.value.split(" ")[0]))) < 0.06)).toBe(true);
        }
      }
    }
  });

  it("returns no cards when the engine ranked nothing", () => {
    const result = { ...recommendFor(airFor()), prioritized: [] };
    expect(buildRecommendationCards(result)).toEqual([]);
  });

  it("skips ranked IDs that match no engine item instead of inventing content", () => {
    const result = recommendFor(airFor());
    const orphan = { ...(result.prioritized[0] as (typeof result.prioritized)[number]), id: "ROUTINE_does-not-exist" };
    const cards = buildRecommendationCards({ ...result, prioritized: [orphan, { ...orphan, id: "INDOOR_nope" }, { ...orphan, id: "TRANSPORT_nope" }] });
    expect(cards).toEqual([]);
  });
});
