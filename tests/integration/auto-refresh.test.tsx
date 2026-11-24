// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Home from "@/app/page";
import { FreshnessIndicator, currentAgeSeconds } from "@/components/dashboard/FreshnessIndicator";
import { AUTO_REFRESH_CHECK_MS, AUTO_REFRESH_MIN_GAP_MS } from "@/components/dashboard/useDashboardData";
import { airFor, installApi, type ApiReply } from "../fixtures/dashboard";

/**
 * The page keeps its data current without a reload: the displayed age keeps counting, and once the data
 * has outlived its cache window it is fetched again quietly. Time is driven by hand (a fake `Date.now`
 * and the captured interval callbacks), so nothing waits for real minutes.
 */

const START = Date.UTC(2026, 10, 24, 15, 40, 0);
let clock = START;
let intervals: { fn: () => void; ms: number }[] = [];

beforeEach(() => {
  clock = START;
  intervals = [];
  vi.spyOn(Date, "now").mockImplementation(() => clock);
  vi.spyOn(globalThis, "setInterval").mockImplementation(((fn: () => void, ms?: number) => {
    intervals.push({ fn, ms: ms ?? 0 });
    return intervals.length as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  vi.spyOn(globalThis, "clearInterval").mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});

const withAge = (cityId: Parameters<typeof airFor>[0], ageSeconds: number): ApiReply => ({
  status: 200,
  body: { ok: true, data: { ...airFor(cityId), ageSeconds } },
});

/** Move the clock forward and run every 30-second interval callback the page registered. */
async function advance(ms: number) {
  clock += ms;
  await act(async () => {
    for (const { fn } of intervals.filter((i) => i.ms === AUTO_REFRESH_CHECK_MS)) fn();
  });
}

describe("the displayed age keeps counting", () => {
  it("adds the time the page has held the data to the age the server reported", () => {
    const data = { ...airFor("bengaluru"), ageSeconds: 480 };
    expect(currentAgeSeconds(data, START, START)).toBe(480);
    expect(currentAgeSeconds(data, START, START + 600_000)).toBe(1080);
    expect(currentAgeSeconds(data, null, START + 600_000)).toBe(480);
    expect(currentAgeSeconds({ ...data, ageSeconds: null }, START, START + 600_000)).toBeNull();
    // A clock that moved backwards never makes the data look younger than the server said.
    expect(currentAgeSeconds(data, START, START - 5_000)).toBe(480);
  });

  it("shows 'just now' first, then updates the text as time passes", async () => {
    render(<FreshnessIndicator air={{ ok: true, data: { ...airFor("bengaluru"), ageSeconds: 20 } }} receivedAt={START} />);
    expect(screen.getByTestId("freshness")).toHaveTextContent("Fresh: fetched just now");
    clock += 9 * 60_000;
    await act(async () => {
      for (const i of intervals) i.fn();
    });
    expect(screen.getByTestId("freshness")).toHaveTextContent("Fresh: fetched 9 minutes ago");
  });

  it("explains that the model can run behind the clock", () => {
    render(<FreshnessIndicator air={{ ok: true, data: airFor("bengaluru") }} receivedAt={START} />);
    expect(screen.getByTestId("freshness")).toHaveTextContent(/can run up to about an hour behind the clock/i);
  });
});

describe("the page refreshes itself, quietly, when the data is older than its cache window", () => {
  it("does nothing while the data is still inside its window", async () => {
    const api = installApi({ air: (c) => withAge(c, 60) });
    render(<Home />);
    await screen.findByRole("meter");
    await advance(10 * 60_000);
    expect(api.airCalls()).toHaveLength(1);
    expect(api.recommendCalls()).toHaveLength(1);
  });

  it("fetches air data and recommendations again once the window has passed, without blanking the page", async () => {
    let calls = 0;
    const api = installApi({ air: (c) => (++calls === 1 ? withAge(c, 60) : withAge(c, 5)) });
    render(<Home />);
    await screen.findByRole("meter");
    await screen.findAllByTestId("recommendation");

    await advance(16 * 60_000);
    // The old data stays on screen the whole time: no loading state replaces it.
    expect(screen.getByRole("meter")).toBeInTheDocument();
    await waitFor(() => expect(api.airCalls()).toHaveLength(2));
    await waitFor(() => expect(api.recommendCalls()).toHaveLength(2));
    expect(screen.getByRole("meter")).toBeInTheDocument();
    expect(screen.queryByText(/Checking data freshness/)).toBeNull();
    // The new data's age replaces the old one.
    await waitFor(() => expect(screen.getByTestId("freshness")).toHaveTextContent("Fresh: fetched just now"));
  });

  it("cannot repeat sooner than the minimum gap, even if the server keeps returning old data", async () => {
    const api = installApi({ air: (c) => withAge(c, 5_000) }); // always older than the 900 s window
    render(<Home />);
    await screen.findByRole("meter");
    await advance(1_000);
    await waitFor(() => expect(api.airCalls()).toHaveLength(2));
    await advance(AUTO_REFRESH_CHECK_MS);
    await advance(AUTO_REFRESH_CHECK_MS);
    expect(api.airCalls()).toHaveLength(2);
    await advance(AUTO_REFRESH_MIN_GAP_MS);
    await waitFor(() => expect(api.airCalls()).toHaveLength(3));
  });

  it("keeps the old data when the refresh fails", async () => {
    let calls = 0;
    const api = installApi({ air: (c) => (++calls === 1 ? withAge(c, 60) : "network-error") });
    render(<Home />);
    await screen.findByRole("meter");
    await advance(16 * 60_000);
    await waitFor(() => expect(api.airCalls()).toHaveLength(2));
    expect(screen.getByRole("meter")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not refresh while the tab is hidden", async () => {
    const api = installApi({ air: (c) => withAge(c, 60) });
    render(<Home />);
    await screen.findByRole("meter");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    await advance(30 * 60_000);
    expect(api.airCalls()).toHaveLength(1);
  });

  it("never refreshes data that failed to load (the retry button is for that)", async () => {
    const api = installApi({ air: () => ({ status: 500, body: { ok: false, error: { code: "INTERNAL_ERROR", message: "x" } } }) });
    render(<Home />);
    await waitFor(() => expect(api.airCalls()).toHaveLength(1));
    await advance(60 * 60_000);
    expect(api.airCalls()).toHaveLength(1);
  });
});
