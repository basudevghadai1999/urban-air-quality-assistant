// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Home from "@/app/page";
import { AI_REASON_MESSAGES } from "@/lib/ai/errors";

import {
  airFor,
  deferred,
  envelopeFor,
  installApi,
  okAir,
  okRecommend,
  recommendFor,
  staleAir,
  unavailableAir,
  type ApiReply,
} from "../fixtures/dashboard";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const loaded = async () => {
  render(<Home />);
  await screen.findByRole("meter");
};

describe("Dashboard: first load", () => {
  it("makes exactly one air request and one recommendation request, sending only IDs", async () => {
    const api = installApi();
    await loaded();
    await screen.findAllByTestId("recommendation");
    expect(api.airCalls()).toHaveLength(1);
    expect(api.airCalls()[0]?.url).toBe("/api/air?cityId=bengaluru");
    expect(api.recommendCalls()).toHaveLength(1);
    expect(api.recommendCalls()[0]?.body).toEqual({ cityId: "bengaluru", profileId: "family_toddlers", explain: false });
  });

  it("shows loading placeholders (aria-busy) before data arrives, and no numbers", () => {
    const air = deferred<ApiReply>();
    installApi({ air: () => air.promise });
    const { container } = render(<Home />);
    expect(container.querySelectorAll('[aria-busy="true"]').length).toBeGreaterThan(0);
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByTestId("freshness")).toHaveTextContent(/checking/i);
  });

  it("has one page heading, the product name and a purpose line", async () => {
    installApi();
    await loaded();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Breathe Smarter. Live Safer.");
    expect(screen.getAllByText("Urban Air Intelligence").length).toBeGreaterThan(0);
  });
});

describe("Dashboard: layout order", () => {
  it("puts the plain-language explanation above the air quality overview, and the overview above the recommendations", async () => {
    installApi();
    await loaded();
    const explanation = screen.getByRole("heading", { name: "Plain-language explanation" });
    const overview = screen.getByRole("heading", { name: "Air quality overview" });
    const recommendations = screen.getByRole("heading", { name: "Personalised recommendations" });
    expect(explanation.compareDocumentPosition(overview) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(overview.compareDocumentPosition(recommendations) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("offers the assistant from a launcher on the page", async () => {
    installApi();
    await loaded();
    expect(screen.getByRole("button", { name: /ask a question/i })).toBeInTheDocument();
  });
});

describe("Dashboard: city selection", () => {
  it("offers the seven cities in order", async () => {
    installApi();
    await loaded();
    const select = screen.getByLabelText("City");
    const names = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(names).toEqual(["Delhi NCR", "Mumbai", "Kolkata", "Bengaluru", "Lucknow", "Patna", "Bhubaneswar"]);
  });

  it("selects Bengaluru by default", async () => {
    installApi();
    await loaded();
    expect(screen.getByLabelText("City")).toHaveValue("bengaluru");
  });

  it("loads the new city's air and recommendations once each when changed", async () => {
    const api = installApi();
    await loaded();
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "mumbai" } });
    await waitFor(() => expect(screen.getByText(/Mumbai, Maharashtra/)).toBeInTheDocument());
    expect(api.airCalls().map((c) => c.url)).toEqual(["/api/air?cityId=bengaluru", "/api/air?cityId=mumbai"]);
    expect(api.recommendCalls().map((c) => c.body?.cityId)).toEqual(["bengaluru", "mumbai"]);
  });

  it("never shows one city's data under another when responses arrive out of order", async () => {
    const first = deferred<ApiReply>();
    let n = 0;
    installApi({ air: (cityId) => (cityId === "bengaluru" && n++ === 0 ? first.promise : okAir(cityId)) });
    render(<Home />);
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "kolkata" } });
    await screen.findByText(/Kolkata, West Bengal/);
    first.resolve(okAir("bengaluru"));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText(/Kolkata, West Bengal/)).toBeInTheDocument();
    expect(screen.queryByText(/Bengaluru, Karnataka/)).toBeNull();
  });

  it("states that Delhi NCR data covers central Delhi only", async () => {
    installApi();
    await loaded();
    expect(screen.queryByText(/central Delhi, not the whole NCR/i)).toBeNull();
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "delhi-ncr" } });
    expect(await screen.findByText(/central Delhi, not the whole NCR/i)).toBeInTheDocument();
  });
});

describe("Dashboard: profile selection", () => {
  it("offers the four presets as one radio group with Family selected", async () => {
    installApi();
    await loaded();
    const group = screen.getByRole("group", { name: /who is this for/i });
    const radios = within(group).getAllByRole("radio");
    expect(radios).toHaveLength(4);
    expect(radios.map((r) => (r as HTMLInputElement).value)).toEqual(["family_toddlers", "senior_respiratory", "two_wheeler_commuter", "student_athlete"]);
    expect(radios[0]).toBeChecked();
    expect(new Set(radios.map((r) => (r as HTMLInputElement).name)).size).toBe(1);
  });

  it("re-requests recommendations only (not air data) when the profile changes", async () => {
    const api = installApi();
    await loaded();
    await screen.findAllByTestId("recommendation");
    fireEvent.click(screen.getByRole("radio", { name: /senior citizen/i }));
    await waitFor(() => expect(api.recommendCalls()).toHaveLength(2));
    expect(api.recommendCalls()[1]?.body).toEqual({ cityId: "bengaluru", profileId: "senior_respiratory", explain: false });
    expect(api.airCalls()).toHaveLength(1);
    expect(screen.getByRole("radio", { name: /senior citizen/i })).toBeChecked();
  });
});

describe("Dashboard: air quality display", () => {
  it("shows the server's AQI, CPCB category, dominant pollutant and a scale", async () => {
    installApi();
    await loaded();
    const air = airFor();
    const aqi = air.calculatedAqi;
    if (aqi === null || aqi.status !== "valid") throw new Error("fixture must have a valid AQI");
    expect(screen.getByLabelText(`Calculated AQI ${aqi.aqi}`)).toHaveTextContent(String(aqi.aqi));
    expect(screen.getAllByText(aqi.category.label).length).toBeGreaterThan(0);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", String(aqi.aqi));
    expect(meter).toHaveAttribute("aria-valuetext", `AQI ${aqi.aqi}, ${aqi.category.label}`);
    expect(screen.getByText(/main pollutant/i).parentElement).toHaveTextContent(/PM2\.5|PM10|NO2|SO2|O3|CO/);
  });

  it("distinguishes modelled data from official CPCB readings", async () => {
    installApi();
    await loaded();
    expect(screen.getByText(/modelled estimate, not an official CPCB reading/i)).toBeInTheDocument();
    expect(screen.getAllByText(/not an official CPCB monitoring-station reading/i).length).toBeGreaterThan(0);
    // One statement of provenance in the notice, not the same sentence twice.
    expect(screen.getByText(/modelled estimate, not an official CPCB reading/i).parentElement?.querySelectorAll("p")).toHaveLength(2);
  });

  it("lists pollutant readings with the provider's units and marks missing ones", async () => {
    installApi();
    await loaded();
    const table = screen.getByRole("table", { name: /pollutant concentrations/i });
    expect(within(table).getByRole("row", { name: /PM2\.5/ })).toHaveTextContent(/\d.*(μg|µg)\/m³/);
    expect(within(table).getByRole("row", { name: /NH3/ })).toHaveTextContent(/not provided by the data source/i);
    expect(within(table).getByRole("row", { name: /^CO / })).toHaveTextContent(/\d/);
  });
});

describe("Dashboard: recommendations and outdoor windows", () => {
  it("renders the engine's priority order with tiers, reasons and units", async () => {
    installApi();
    await loaded();
    const cards = await screen.findAllByTestId("recommendation");
    const result = recommendFor(airFor());
    expect(cards.length).toBeGreaterThan(0);
    expect(within(cards[0] as HTMLElement).getByRole("heading", { level: 3 })).toHaveTextContent(result.prioritized[0]?.title ?? "never");
    for (const card of cards) {
      expect(card).toHaveTextContent(/Why:/);
      expect(card).toHaveTextContent(/High priority|Recommended|Optional/);
    }
  });

  it("filters to indoor air and transport groups", async () => {
    installApi();
    await loaded();
    await screen.findAllByTestId("recommendation");
    const filter = screen.getByRole("group", { name: /filter recommendations/i });
    fireEvent.click(within(filter).getByRole("button", { name: "Indoor air" }));
    expect(within(filter).getByRole("button", { name: "Indoor air" })).toHaveAttribute("aria-pressed", "true");
    for (const card of screen.getAllByTestId("recommendation")) expect(card).toHaveTextContent(/Indoor air/);
    fireEvent.click(within(filter).getByRole("button", { name: "Cleaner transport" }));
    for (const card of screen.queryAllByTestId("recommendation")) expect(card).toHaveTextContent(/Transport/);
  });

  it("shows the engine's best window as a relatively lower-pollution window, never as safe", async () => {
    installApi();
    await loaded();
    const result = recommendFor(airFor());
    const id = result.outdoorWindows.primaryActivityId;
    const best = id === null ? null : result.outdoorWindows.analyses[id]?.best;
    if (best === null || best === undefined) throw new Error("fixture must have a window");
    const shown = await screen.findByTestId("best-window");
    expect(shown).toHaveTextContent(`${best.startLocal} to ${best.endLocal} IST`);
    // The forecast covers future hours only, so the day must be stated (a bare "16:00" reads as already past).
    expect(shown.textContent).toMatch(/^(Today|Tomorrow|\d{1,2} \w{3}), \d\d:\d\d to \d\d:\d\d IST/);
    const region = screen.getByRole("region", { name: "Outdoor activity windows" });
    expect(region).toHaveTextContent(/comparatively lower-pollution/i);
    expect(region).toHaveTextContent(/not medically safe/i);
    expect(within(region).getByText(/confidence/i)).toBeInTheDocument();
  });

  it("shows exposure and CO2 estimates with units and the estimates-not-measurements note", async () => {
    installApi();
    await loaded();
    const region = await screen.findByRole("region", { name: "Estimated impact" });
    expect(region).toHaveTextContent(/not measurements/i);
    expect(region).toHaveTextContent(/µg PM2\.5 inhaled|µg/);
    expect(within(region).getByRole("table", { name: /tailpipe CO2/i })).toBeInTheDocument();
  });
});

describe("Dashboard: AI explanation", () => {
  const explainButton = () => screen.getByRole("button", { name: "Explain with AI" });

  it("is not requested until clicked, then asks for explain=true for the same selection", async () => {
    const api = installApi();
    await loaded();
    await screen.findAllByTestId("recommendation");
    expect(api.recommendCalls(true)).toHaveLength(0);
    fireEvent.click(explainButton());
    const result = await screen.findByTestId("ai-result");
    expect(api.recommendCalls(true)).toHaveLength(1);
    expect(api.recommendCalls(true)[0]?.body).toEqual({ cityId: "bengaluru", profileId: "family_toddlers", explain: true });
    expect(result).toHaveTextContent("Written by Groq (test-groq-model)");
  });

  it.each([
    ["generated-gemini", /Written by Gemini \(test-gemini-model\)/],
    ["cached-gemini", /Reused from an earlier Gemini explanation/],
  ] as const)("labels a %s explanation with its provider", async (kind, text) => {
    installApi({ recommend: (c, p, e) => (e ? { status: 200, body: { ok: true, data: recommendFor(airFor(c), p), ai: envelopeFor(recommendFor(airFor(c), p), kind) } } : okRecommend(c, p, e)) });
    await loaded();
    await screen.findAllByTestId("recommendation");
    fireEvent.click(explainButton());
    expect(await screen.findByTestId("ai-result")).toHaveTextContent(text);
  });

  it("explains a fallback in plain words, with the reason and the providers tried first", async () => {
    installApi({
      recommend: (c, p, e) => {
        const result = recommendFor(airFor(c), p);
        return e
          ? { status: 200, body: { ok: true, data: result, ai: envelopeFor(result, "fallback", "AI_RATE_LIMITED", { attempts: [{ provider: "gemini", reasonCode: "AI_TIMEOUT" }, { provider: "groq", reasonCode: "AI_QUOTA" }] }) } }
          : okRecommend(c, p, e);
      },
    });
    await loaded();
    await screen.findAllByTestId("recommendation");
    fireEvent.click(explainButton());
    const result = await screen.findByTestId("ai-result");
    expect(result).toHaveTextContent("Standard explanation from built-in rules (AI not used)");
    expect(screen.getByTestId("ai-reason")).toHaveTextContent(AI_REASON_MESSAGES.AI_RATE_LIMITED);
    expect(result).toHaveTextContent("Gemini took too long.");
    expect(result).toHaveTextContent("Groq was busy or over its quota.");
    expect(result).not.toHaveTextContent("AI_TIMEOUT");
  });

  it("shows a clear message when no explanation exists at all", async () => {
    installApi({
      recommend: (c, p, e) => {
        const result = recommendFor(airFor(c), p);
        return e ? { status: 200, body: { ok: true, data: result, ai: envelopeFor(result, "unavailable", "AI_INTERNAL") } } : okRecommend(c, p, e);
      },
    });
    await loaded();
    await screen.findAllByTestId("recommendation");
    fireEvent.click(explainButton());
    expect(await screen.findByTestId("ai-result")).toHaveTextContent("No explanation available");
    expect(screen.getByTestId("ai-reason")).toHaveTextContent(AI_REASON_MESSAGES.AI_INTERNAL);
  });

  it("renders model text as plain text, never as HTML", async () => {
    const hostile = '<img src=x onerror="alert(1)"> <script>window.__pwned=1</script> <b>bold</b>';
    installApi({
      recommend: (c, p, e) => {
        const result = recommendFor(airFor(c), p);
        const env = envelopeFor(result, "generated-groq");
        const explanation = env.explanation;
        if (explanation === null) throw new Error("fixture");
        return e
          ? { status: 200, body: { ok: true, data: result, ai: { ...env, explanation: { ...explanation, overview: hostile, topActions: explanation.topActions.map((a) => ({ ...a, explanation: hostile })) } } } }
          : okRecommend(c, p, e);
      },
    });
    await loaded();
    await screen.findAllByTestId("recommendation");
    fireEvent.click(explainButton());
    const result = await screen.findByTestId("ai-result");
    expect(result.textContent).toContain("<script>window.__pwned=1</script>");
    expect(result.querySelector("script, img, b")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("lists top actions without a doubled full stop after the title", async () => {
    installApi();
    await loaded();
    await screen.findAllByTestId("recommendation");
    fireEvent.click(screen.getByRole("button", { name: "Explain with AI" }));
    const result = await screen.findByTestId("ai-result");
    expect(result.textContent).not.toMatch(/\.\./);
  });

  it("resets when the selection changes, so an old explanation is never shown for a new profile", async () => {
    installApi();
    await loaded();
    await screen.findAllByTestId("recommendation");
    fireEvent.click(explainButton());
    await screen.findByTestId("ai-result");
    fireEvent.click(screen.getByRole("radio", { name: /two-wheeler/i }));
    await waitFor(() => expect(screen.queryByTestId("ai-result")).toBeNull());
    expect(explainButton()).toBeInTheDocument();
  });

  it("shows an error with a retry when the explanation request itself fails", async () => {
    installApi({ recommend: (c, p, e) => (e ? "network-error" : okRecommend(c, p, e)) });
    await loaded();
    await screen.findAllByTestId("recommendation");
    fireEvent.click(explainButton());
    const alert = await screen.findByText("The explanation could not be loaded");
    expect(alert.closest('[role="alert"]')).toHaveTextContent(/could not reach the server/i);
    expect(within(alert.closest('[role="alert"]') as HTMLElement).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("Dashboard: stale, unavailable and error states", () => {
  it("flags stale data in the indicator and a banner, while still showing the earlier reading", async () => {
    installApi({ air: () => ({ status: 200, body: { ok: true, data: staleAir() } }) });
    await loaded();
    expect(screen.getByTestId("freshness")).toHaveTextContent(/stale: earlier reading, fetched 2 hours ago/i);
    expect(screen.getByText("Showing an earlier reading").closest('[role="status"]')).toHaveTextContent(/last reading received/i);
    expect(screen.getByRole("meter")).toBeInTheDocument();
  });

  it("shows fresh data as fresh", async () => {
    installApi();
    await loaded();
    expect(screen.getByTestId("freshness")).toHaveTextContent(/^Fresh/);
    expect(screen.queryByText("Showing an earlier reading")).toBeNull();
  });

  it("never fabricates a reading when no air data exists", async () => {
    const air = unavailableAir();
    const result = recommendFor(air);
    installApi({
      air: () => ({ status: 503, body: { ok: false, error: { code: "AIR_DATA_UNAVAILABLE", message: "x", retryAfterSeconds: 60 }, data: air } }),
      recommend: () => ({ status: 503, body: { ok: false, error: { code: "AIR_DATA_UNAVAILABLE", message: "x", retryAfterSeconds: 60 }, data: result } }),
    });
    render(<Home />);
    expect(await screen.findByText("AQI unavailable")).toBeInTheDocument();
    expect(screen.getByText("Air quality data is unavailable")).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: /pollutant concentrations/i })).toBeNull();
    expect(screen.queryByRole("meter")).toBeNull();
    expect(screen.getByTestId("freshness")).toHaveTextContent(/no data available/i);
    expect(await screen.findByText(/recommendations that depend on air quality are unavailable/i)).toBeInTheDocument();
    expect(screen.queryAllByTestId("recommendation")).toHaveLength(0);
    expect(screen.getByRole("region", { name: "Outdoor activity windows" })).toHaveTextContent(/no forecast is available/i);
    expect(screen.getByRole("region", { name: "Estimated impact" })).toHaveTextContent(/no impact estimates/i);
  });

  it("shows a network failure with a retry that recovers", async () => {
    let fail = true;
    const api = installApi({ air: (c) => (fail ? "network-error" : okAir(c)), recommend: (c, p, e) => (fail ? "network-error" : okRecommend(c, p, e)) });
    render(<Home />);
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]).toHaveTextContent(/could not reach the server/i);
    // A failed request is not "no data": the indicator must not claim the city has none.
    expect(screen.getByTestId("freshness")).toHaveTextContent(/could not load data/i);
    expect(screen.getByTestId("freshness")).not.toHaveTextContent(/no data available/i);
    expect(screen.queryByRole("meter")).toBeNull();
    fail = false;
    fireEvent.click(within(alerts[0] as HTMLElement).getByRole("button", { name: "Try again" }));
    await screen.findByRole("meter");
    expect(api.airCalls()).toHaveLength(2);
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("explains a rate limit with the wait time, without raw server text", async () => {
    installApi({ air: () => ({ status: 429, body: { ok: false, error: { code: "RATE_LIMITED", message: "SECRET-INTERNAL-TEXT", retryAfterSeconds: 42 } } }) });
    render(<Home />);
    const alert = await screen.findByText("Air quality data could not be loaded");
    expect(alert.closest('[role="alert"]')).toHaveTextContent(/too many requests/i);
    expect(alert.closest('[role="alert"]')).toHaveTextContent(/about 42 seconds/i);
    expect(document.body).not.toHaveTextContent("SECRET-INTERNAL-TEXT");
  });

  it("treats a malformed response as a generic server failure", async () => {
    installApi({ air: () => ({ status: 200, body: "not an api response" }) });
    render(<Home />);
    expect(await screen.findByText("Air quality data could not be loaded")).toBeInTheDocument();
  });
});

describe("Dashboard: attribution and safety", () => {
  it("credits Open-Meteo, Copernicus and CPCB and carries both disclaimers", async () => {
    installApi();
    await loaded();
    const region = screen.getByRole("region", { name: /data sources, methods and safety/i });
    expect(region).toHaveTextContent(/Open-Meteo/);
    expect(region).toHaveTextContent(/Copernicus/);
    expect(region).toHaveTextContent(/Central Pollution Control Board/);
    expect(region).toHaveTextContent(/not readings from an official CPCB monitoring station/i);
    expect(region).toHaveTextContent(/not medical advice/i);
    for (const link of within(region).getAllByRole("link")) {
      expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
      expect(link.getAttribute("href")).toMatch(/^https:\/\//);
    }
  });

  it("shows attribution even when there is no data", async () => {
    installApi({ air: () => "network-error", recommend: () => "network-error" });
    render(<Home />);
    await screen.findAllByRole("alert");
    expect(screen.getByRole("region", { name: /data sources, methods and safety/i })).toHaveTextContent(/Open-Meteo/);
  });
});

describe("Dashboard: responsive structure and accessibility basics", () => {
  beforeEach(() => {
    installApi();
  });

  it("uses mobile-first single-column layouts that widen at breakpoints", async () => {
    const { container } = render(<Home />);
    await screen.findByRole("meter");
    const grids = Array.from(container.querySelectorAll("div")).filter((d) => /\bgrid\b/.test(d.className));
    expect(grids.some((g) => /\bgap-6\b/.test(g.className) && /\blg:grid-cols-2\b/.test(g.className))).toBe(true);
    expect(grids.some((g) => /\bsm:grid-cols-2\b/.test(g.className) && /\blg:grid-cols-4\b/.test(g.className))).toBe(true);
    for (const g of grids) expect(g.className).not.toMatch(/(^|\s)grid-cols-[2-9]/); // no unconditional multi-column grid
  });

  it("wraps wide tables so they scroll instead of overflowing the viewport", async () => {
    render(<Home />);
    await screen.findByRole("meter");
    for (const table of screen.getAllByRole("table")) expect(table.parentElement?.className).toMatch(/overflow-x-auto/);
  });

  it("gives every panel a named region and every control an accessible name", async () => {
    render(<Home />);
    await screen.findByRole("meter");
    await screen.findAllByTestId("recommendation");
    const names = screen.getAllByRole("region").map((r) => r.getAttribute("aria-labelledby"));
    expect(names.every((n) => n !== null && document.getElementById(n) !== null)).toBe(true);
    for (const el of [...screen.getAllByRole("button"), ...screen.getAllByRole("radio"), screen.getByRole("combobox")]) {
      expect(el).toHaveAccessibleName();
    }
    expect(screen.getByLabelText("City")).toBe(screen.getByRole("combobox"));
  });

  it("keeps touch targets at least 44px tall and never hides focus", async () => {
    render(<Home />);
    await screen.findByRole("meter");
    await screen.findAllByTestId("recommendation");
    for (const b of screen.getAllByRole("button")) expect(b.className).toMatch(/min-h-11/);
    expect(screen.getByRole("combobox").className).toMatch(/min-h-11/);
    for (const el of document.querySelectorAll("button, select, input")) expect(el.className).not.toMatch(/outline-none|focus:outline-none/);
  });

  it("moves between profiles with native radio semantics (focusable, grouped)", async () => {
    render(<Home />);
    await screen.findByRole("meter");
    const radios = screen.getAllByRole("radio");
    for (const r of radios) expect(r).not.toHaveAttribute("tabindex", "-1");
    expect(screen.getByRole("group", { name: /who is this for/i }).tagName).toBe("FIELDSET");
  });

  it("announces the data state to assistive technology", async () => {
    render(<Home />);
    await screen.findByRole("meter");
    expect(within(screen.getByTestId("freshness")).getByRole("status")).toBeInTheDocument();
  });
});
