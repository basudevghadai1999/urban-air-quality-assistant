import { describe, expect, it } from "vitest";

import { AI_TEXT_LIMITS, SAFETY_DISCLAIMER, buildFallbackExplanation, buildGroundingContext, clip } from "@/lib/ai";
import { validateExplanation } from "@/lib/ai/validator";
import { PROFILE_IDS } from "@/lib/engine/types";

import { CLEAN_FLAT, EVENING_DIP, HIGH_DIP, MORNING_DIP, SEVERE_FLAT, snapshot, stale, unavailable } from "../../fixtures/engine";
import { resultFor } from "../../fixtures/ai";

/** All air data is SYNTHETIC. */

const SCENARIOS = {
  "fresh, moderate": () => snapshot(MORNING_DIP),
  "fresh, clean": () => snapshot(CLEAN_FLAT),
  "fresh, severe": () => snapshot(SEVERE_FLAT),
  "fresh, high with a dip": () => snapshot(HIGH_DIP),
  "evening dip": () => snapshot(EVENING_DIP),
  "pollutants missing": () => snapshot({ ...EVENING_DIP, omit: ["ozone", "sulphur_dioxide", "pm10"] }),
  stale: () => stale(snapshot(MORNING_DIP)),
  unavailable: () => unavailable(),
};

describe.each(Object.entries(SCENARIOS))("fallback explanation: %s", (_name, make) => {
  it.each(PROFILE_IDS)("%s: passes the validator that guards model output", (profileId) => {
    const { result, air } = resultFor(profileId, make());
    const g = buildGroundingContext(result, air);
    const e = buildFallbackExplanation(result);
    const outcome = validateExplanation(e, { allowedIds: g.allowedIds, contextJson: g.json });
    expect(outcome.ok, JSON.stringify(outcome)).toBe(true);
  });

  it("references only existing recommendation IDs and fits every limit", () => {
    const { result, air } = resultFor("senior_respiratory", make());
    const g = buildGroundingContext(result, air);
    const e = buildFallbackExplanation(result);
    expect(e.topActions.length).toBeGreaterThanOrEqual(1);
    for (const a of e.topActions) expect(g.allowedIds).toContain(a.recommendationId);
    expect(e.overview.length).toBeLessThanOrEqual(AI_TEXT_LIMITS.overview);
    expect(e.dataLimitations.length).toBeLessThanOrEqual(AI_TEXT_LIMITS.limitationsMax);
  });
});

describe("fallback content", () => {
  it("states the AQI exactly and that it is modelled, not an official CPCB reading", () => {
    const { result } = resultFor("senior_respiratory", snapshot(MORNING_DIP));
    const e = buildFallbackExplanation(result);
    expect(e.overview).toContain(String(result.aqiContext.aqi));
    expect(e.overview).toContain(result.aqiContext.categoryLabel ?? "?");
    expect(e.overview).toMatch(/not an official CPCB monitoring-station reading/);
  });

  it("says the data is not current when stale", () => {
    const { result } = resultFor("senior_respiratory", stale(snapshot(MORNING_DIP)));
    const e = buildFallbackExplanation(result);
    expect(e.overview).toMatch(/not current/);
    expect(e.situationExplanation).toMatch(/stale/);
  });

  it("says plainly when there is no air data, and invents no AQI", () => {
    const { result } = resultFor("family_toddlers", unavailable());
    const e = buildFallbackExplanation(result);
    expect(e.overview).toMatch(/not available/);
    expect(e.overview).not.toMatch(/\bAQI for\b.*\d/);
    expect(e.situationExplanation).toMatch(/No air quality reading or forecast is available/);
    expect(e.outdoorActivityExplanation).toBe("Forecast-based timing is unavailable.");
  });

  it("uses the required wording for windows and never calls a window safe", () => {
    const { result } = resultFor("senior_respiratory", snapshot(MORNING_DIP));
    const e = buildFallbackExplanation(result);
    expect(e.outdoorActivityExplanation).toMatch(/relatively lower/);
    expect(e.outdoorActivityExplanation).toMatch(/not a statement that the air is safe/);
  });

  it("reports the indoor sensor limitation, and an unavailable metro CO2 comparison honestly", () => {
    const { result } = resultFor("two_wheeler_commuter", snapshot(MORNING_DIP));
    const e = buildFallbackExplanation(result);
    expect(e.indoorAirExplanation).toMatch(/No indoor air quality sensor is connected/);
    expect(e.transportExplanation).toMatch(/Route-level pollution data is not available/);
    expect(e.dataLimitations.join(" ")).toMatch(/not measurements|model estimates/i);
  });

  it("describes impact in words and never restates the engine's figures (the app shows them beside the text)", () => {
    const { result } = resultFor("senior_respiratory", snapshot(MORNING_DIP));
    const shift = result.exposure.items.find((x) => x.id.startsWith("EXP_SHIFT_"));
    const e = buildFallbackExplanation(result);
    expect(e.impactExplanation).toMatch(/estimated (?:reduction|increase) in the PM2\.5 you would inhale/);
    expect(e.impactExplanation).not.toContain(String(shift?.estimate.difference?.magnitudeUg));
    expect(e.impactExplanation).not.toMatch(/\d+(?:\.\d+)?\s*(?:%|ug|µg|g\b)/);
    expect(e.impactExplanation).toMatch(/estimates under stated assumptions, not measurements/);
  });

  it("carries the fixed safety disclaimer", () => {
    expect(buildFallbackExplanation(resultFor().result).safetyDisclaimer).toBe(SAFETY_DISCLAIMER);
    expect(SAFETY_DISCLAIMER).toMatch(/not medical advice/);
    expect(SAFETY_DISCLAIMER).toMatch(/cannot diagnose/);
  });

  it("is deterministic and does not mutate the result", () => {
    const { result } = resultFor("student_athlete", snapshot(MORNING_DIP));
    const before = JSON.stringify(result);
    expect(buildFallbackExplanation(result)).toEqual(buildFallbackExplanation(result));
    expect(JSON.stringify(result)).toBe(before);
  });
});

describe("clip", () => {
  it("keeps whole sentences", () => {
    expect(clip("One. Two. Three.", 10)).toBe("One. Two.");
    expect(clip("Short.", 50)).toBe("Short.");
  });

  it("cuts at a word when a single sentence is too long, and never exceeds the limit", () => {
    const long = `${"word ".repeat(100)}end`;
    const out = clip(long, 60);
    expect(out.length).toBeLessThanOrEqual(60);
    expect(out.endsWith(".")).toBe(true);
    expect(out).not.toMatch(/wor\.$/);
  });

  it("normalises whitespace", () => {
    expect(clip("  a \n\n b  ", 20)).toBe("a b");
  });
});
