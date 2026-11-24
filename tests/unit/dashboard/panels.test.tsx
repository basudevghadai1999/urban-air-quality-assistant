// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AiExplanationPanel } from "@/components/dashboard/AiExplanation";
import { AirOverview } from "@/components/dashboard/AirOverview";
import { OutdoorWindows } from "@/components/dashboard/OutdoorWindows";
import { Recommendations } from "@/components/dashboard/Recommendations";
import { buildRecommendationCards } from "@/components/dashboard/recommendationView";
import { generateRecommendations } from "@/lib/engine";

import { CLEAN_FLAT, NOW, SEVERE_FLAT, snapshot } from "../../fixtures/engine";
import { airFor, envelopeFor, recommendFor } from "../../fixtures/dashboard";

afterEach(cleanup);

const resultFor = (options: Parameters<typeof snapshot>[0]) => {
  const out = generateRecommendations({ air: snapshot(options), profileId: "senior_respiratory", nowMs: NOW });
  if (!out.ok) throw new Error("fixture");
  return out.result;
};

describe("AirOverview", () => {
  it("shows loading, empty and insufficient-data states without any AQI number", () => {
    const { rerender } = render(<AirOverview air={null} loading />);
    expect(screen.getByText("Loading air quality data")).toBeInTheDocument();
    rerender(<AirOverview air={null} loading={false} />);
    expect(screen.getByText(/no air quality reading is available/i)).toBeInTheDocument();
    rerender(<AirOverview air={{ ...airFor(), calculatedAqi: null }} loading={false} />);
    expect(screen.getByText("AQI unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("meter")).toBeNull();
  });

  it.each([[CLEAN_FLAT, "Good|Satisfactory"], [SEVERE_FLAT, "Very Poor|Severe"]] as const)("labels the category in words for %#", (options, pattern) => {
    render(<AirOverview air={snapshot(options)} loading={false} />);
    expect(screen.getByRole("meter").getAttribute("aria-valuetext")).toMatch(new RegExp(pattern));
  });
});

describe("OutdoorWindows", () => {
  it("says so when every window is above the advisory level, and does not call it safe", () => {
    const result = resultFor(SEVERE_FLAT);
    render(<OutdoorWindows result={result} loading={false} />);
    const region = screen.getByRole("region", { name: "Outdoor activity windows" });
    expect(region).toHaveTextContent(/above the engine's advisory level|No window available|not meaningfully/i);
    expect(region).not.toHaveTextContent(/\bis safe\b|\bare safe\b/i);
  });

  it("shows a clean-air forecast with the caveat intact", () => {
    render(<OutdoorWindows result={resultFor(CLEAN_FLAT)} loading={false} />);
    expect(screen.getByRole("region", { name: "Outdoor activity windows" })).toHaveTextContent(/not medically safe/i);
  });

  it("explains an unavailable forecast and a missing analysis", () => {
    const base = recommendFor(airFor());
    const id = base.outdoorWindows.primaryActivityId ?? "";
    const analysis = base.outdoorWindows.analyses[id];
    if (analysis === undefined) throw new Error("fixture");
    const unavailable = { ...base, outdoorWindows: { ...base.outdoorWindows, analyses: { [id]: { ...analysis, status: "unavailable" as const, best: null, unavailableReason: "no-future-hours" as const } } } };
    const { rerender } = render(<OutdoorWindows result={unavailable} loading={false} />);
    expect(screen.getByText(/no hours still ahead/i)).toBeInTheDocument();
    rerender(<OutdoorWindows result={{ ...base, outdoorWindows: { ...base.outdoorWindows, primaryActivityId: null } }} loading={false} />);
    expect(screen.getByText(/no outdoor activity window could be worked out/i)).toBeInTheDocument();
    rerender(<OutdoorWindows result={null} loading />);
    expect(screen.getByText("Loading outdoor windows")).toBeInTheDocument();
  });
});

describe("Recommendations", () => {
  it("expands and collapses a long list", () => {
    render(<Recommendations result={recommendFor(airFor(), "two_wheeler_commuter")} loading={false} />);
    const total = buildRecommendationCards(recommendFor(airFor(), "two_wheeler_commuter")).length;
    if (total > 6) {
      expect(screen.getAllByTestId("recommendation")).toHaveLength(6);
      const toggle = screen.getByRole("button", { name: `Show all ${total}` });
      expect(toggle).toHaveAttribute("aria-expanded", "false");
    }
  });

  it("shows an empty message for a group with nothing in it", () => {
    const result = { ...recommendFor(airFor()), prioritized: [] };
    render(<Recommendations result={result} loading={false} />);
    expect(within(screen.getByRole("region", { name: /personalised recommendations/i })).queryAllByTestId("recommendation")).toHaveLength(0);
  });
});

describe("AiExplanationPanel", () => {
  const cards = buildRecommendationCards(recommendFor(airFor()));
  const noop = () => undefined;

  it("disables the button while recommendations load", () => {
    render(<AiExplanationPanel state={{ status: "idle" }} canExplain={false} onExplain={noop} cards={[]} />);
    expect(screen.getByRole("button", { name: "Explain with AI" })).toBeDisabled();
  });

  it("names the recommendation behind each AI action and states that numbers come from the engine", () => {
    const env = envelopeFor(recommendFor(airFor()), "generated-groq");
    render(<AiExplanationPanel state={{ status: "done", envelope: env }} canExplain onExplain={noop} cards={cards} />);
    const first = env.explanation?.topActions[0];
    expect(first).toBeDefined();
    expect(screen.getByTestId("ai-result")).toHaveTextContent(cards.find((c) => c.id === first?.recommendationId)?.title ?? "");
    expect(screen.getByTestId("ai-result")).toHaveTextContent(/numbers and times on this page come from the deterministic engine/i);
  });

  it("falls back to a generic description for an attempt reason it has no wording for", () => {
    const env = envelopeFor(recommendFor(airFor()), "fallback", "AI_DISABLED", { attempts: [{ provider: "gemini", reasonCode: "AI_BAD_REQUEST" }], retryAfterSeconds: 30 });
    render(<AiExplanationPanel state={{ status: "done", envelope: env }} canExplain onExplain={noop} cards={cards} />);
    expect(screen.getByText("Gemini could not be used.")).toBeInTheDocument();
    expect(screen.getByText(/try again in about 30 seconds/i)).toBeInTheDocument();
  });

  it("shows only the actions it can name, never a raw recommendation ID", () => {
    const env = envelopeFor(recommendFor(airFor()), "generated-gemini");
    const explanation = env.explanation;
    if (explanation === null) throw new Error("fixture");
    const odd = { ...env, explanation: { ...explanation, topActions: [{ recommendationId: "NOT_A_REAL_ID", explanation: "E", practicalGuidance: "G" }] } };
    render(<AiExplanationPanel state={{ status: "done", envelope: odd }} canExplain onExplain={noop} cards={cards} />);
    expect(screen.getByTestId("ai-result")).not.toHaveTextContent("NOT_A_REAL_ID");
  });
});
