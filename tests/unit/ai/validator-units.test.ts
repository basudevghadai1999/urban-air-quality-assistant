import { describe, expect, it } from "vitest";

import { groundedQuantities, validateExplanation, type RejectionReason } from "@/lib/ai/validator";
import type { AiExplanation } from "@/lib/ai";

/** Unit-aware numeric grounding. The contexts here are small, hand-written and SYNTHETIC. */

const ID = "TRANSPORT_metro";
const plain = (overview: string): AiExplanation => ({
  overview,
  situationExplanation: "Plain text.",
  personalizedSummary: "Plain text.",
  topActions: [{ recommendationId: ID, explanation: "Plain text.", practicalGuidance: "Plain text." }],
  routineExplanation: "Plain text.",
  outdoorActivityExplanation: "Plain text.",
  indoorAirExplanation: "Plain text.",
  transportExplanation: "Plain text.",
  impactExplanation: "Plain text.",
  dataLimitations: ["Plain text."],
  safetyDisclaimer: "Plain text.",
});

function check(context: unknown, text: string): "accepted" | RejectionReason | string {
  const outcome = validateExplanation(plain(text), { allowedIds: [ID], contextJson: JSON.stringify(context) });
  return outcome.ok ? "accepted" : (outcome.rejection ?? outcome.code);
}

describe("the context is indexed by unit", () => {
  it("takes the unit from the key suffix for numbers and from the written unit for prose", () => {
    const q = groundedQuantities(JSON.stringify({ commuteDistanceKm: 3, travelMin: 25, changePercent: 40, userReportedIndoorPm25UgM3: 35, oneWayGCo2: 114.3, aqi: 170, why: "about 20 ug/m3 for 2 hours, 15% lower" }));
    const has = (unit: string, v: number) => q.get(unit as never)?.has(v) === true;
    expect(has("km", 3)).toBe(true);
    expect(has("minutes", 25)).toBe(true);
    expect(has("percent", 40)).toBe(true);
    expect(has("concentration", 35)).toBe(true);
    expect(has("grams", 114.3)).toBe(true);
    expect(has("aqi", 170)).toBe(true);
    expect(has("concentration", 20)).toBe(true);
    expect(has("hours", 2)).toBe(true);
    expect(has("percent", 15)).toBe(true);
    expect(has("hours", 3)).toBe(false);
  });

  it("does not index digits that are part of timestamps, ids, age bands or clock times", () => {
    const q = groundedQuantities(JSON.stringify({ t: "2026-11-24T09:00:00+05:30", id: "outdoor_play-1", band: "61-<71", slot: "17:30" }));
    const all = [...q.values()].flatMap((s) => [...s]);
    expect(all).toEqual([]);
  });
});

describe("a number keeps its unit", () => {
  const ctx = { commuteDistanceKm: 3, changePercent: 40, userReportedIndoorPm25UgM3: 35, oneWayGCo2: 114.3, aqi: 170, travelMin: 25, slot: { start: "17:00", end: "17:45" } };

  it("accepts each figure with the unit the context gives it", () => {
    for (const text of ["The trip is 3 km.", "About 40% lower.", "A reported 35 µg/m³ indoors.", "A reported 35 ug/m3 indoors.", "That is 114.3 g of CO2.", "Roughly 114.3 gCO2 per trip.", "The AQI is 170.", "The AQI of 170 is high.", "It takes 25 minutes."]) {
      expect(check(ctx, text), text).toBe("accepted");
    }
  });

  it("3 km does not authorise 3 hours or 3 minutes", () => {
    expect(check(ctx, "The trip takes 3 hours.")).toBe("unit-mismatch");
    expect(check(ctx, "The trip takes 3 minutes.")).toBe("unit-mismatch");
    expect(check(ctx, "The trip is 3 km.")).toBe("accepted");
  });

  it("a percentage is not a concentration, and a concentration is not a percentage", () => {
    expect(check(ctx, "PM2.5 is 40 µg/m³ now.")).toBe("unit-mismatch");
    expect(check(ctx, "PM2.5 of 40 is typical.")).toBe("unit-mismatch");
    expect(check(ctx, "A 35% reduction.")).toBe("unit-mismatch");
  });

  it("a measurement keeps its unit: a concentration is not a mass, and vice versa", () => {
    expect(check(ctx, "Indoor air was reported at 35 µg.")).toBe("unit-mismatch");
    expect(check(ctx, "A mass of 35 ug/m3 was inhaled.")).toBe("accepted");
  });

  it("an AQI is not a duration or a distance", () => {
    expect(check(ctx, "The AQI is 171.")).toBe("unsupported-number");
    expect(check(ctx, "It lasts 170 minutes.")).toBe("unit-mismatch");
    expect(check(ctx, "It is 170 km away.")).toBe("unit-mismatch");
  });

  it("an invented figure is rejected whatever its unit", () => {
    for (const text of ["It saves 999 g of CO2.", "A 77% drop.", "PM2.5 reaches 412 µg/m³.", "AQI of 612."]) {
      expect(check(ctx, text), text).toBe("unsupported-number");
    }
  });

  it("a bare number that the context holds only with a unit is rejected", () => {
    expect(check(ctx, "The value is 114.3.")).toBe("unit-mismatch");
    expect(check(ctx, "Take 35 of them.")).toBe("unit-mismatch");
  });

  it("small counting integers without a unit stay allowed; with a wrong unit they do not", () => {
    expect(check(ctx, "Do these 2 things first.")).toBe("accepted");
    expect(check(ctx, "Wait 2 hours.")).not.toBe("accepted");
  });
});

describe("times are not converted", () => {
  const ctx = { slot: { start: "17:00", end: "17:45" } };

  it("accepts the exact time in 24-hour and 12-hour form", () => {
    for (const text of ["Start at 17:00.", "Start at 5 pm.", "Start at 5:00 pm.", "Start at 5 p.m.", "Finish by 5:45 PM."]) expect(check(ctx, text), text).toBe("accepted");
  });

  it("rejects a different time in either form", () => {
    for (const text of ["Start at 18:00.", "Start at 6 pm.", "Start at 5 am.", "Start at 5:30 pm.", "Start at 13 pm."]) expect(check(ctx, text), text).toBe("unsupported-time");
  });
});

describe("CO2 and PM2.5 are not mixed up", () => {
  const ctx = { oneWayGCo2: 114.3, userReportedIndoorPm25UgM3: 35 };

  it("a gram figure must be in a sentence about CO2", () => {
    expect(check(ctx, "Switching saves 114.3 g of CO2 per trip.")).toBe("accepted");
    expect(check(ctx, "Switching saves 114.3 g.")).toBe("unit-mismatch");
    expect(check(ctx, "Switching cuts 114.3 g of PM2.5 exposure.")).toBe("unit-mismatch");
  });

  it("a concentration may not sit in a CO2-only sentence", () => {
    expect(check(ctx, "CO2 fell to 35 µg/m³.")).toBe("unit-mismatch");
    expect(check(ctx, "Reported PM2.5 is 35 µg/m³; CO2 is separate.")).toBe("accepted");
  });
});
