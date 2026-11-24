// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchAir, fetchRecommendations } from "@/lib/client/dashboardApi";

import { installApi, recommendFor, unavailableAir } from "../../fixtures/dashboard";

afterEach(() => vi.unstubAllGlobals());
const signal = () => new AbortController().signal;

describe("dashboard API client", () => {
  it("sends only IDs and the explain flag, never a number or a key", async () => {
    const api = installApi();
    await fetchRecommendations("mumbai", "student_athlete", true, signal());
    const call = api.recommendCalls()[0];
    expect(call?.body).toEqual({ cityId: "mumbai", profileId: "student_athlete", explain: true });
    expect(call?.method).toBe("POST");
    const init = (fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]?.[1];
    expect(Object.keys(init?.headers ?? {})).toEqual(["Content-Type"]);
    expect(init?.cache).toBe("no-store");
  });

  it("encodes the city in the URL and sends no other parameter", async () => {
    const api = installApi();
    await fetchAir("delhi-ncr", signal());
    expect(api.airCalls()[0]?.url).toBe("/api/air?cityId=delhi-ncr");
  });

  it("returns data on success", async () => {
    installApi();
    const air = await fetchAir("patna", signal());
    expect(air.ok && air.data.cityId).toBe("patna");
    const rec = await fetchRecommendations("patna", "family_toddlers", false, signal());
    expect(rec.ok && rec.data.ai).toBeNull();
  });

  it.each([
    [429, { error: { code: "RATE_LIMITED", retryAfterSeconds: 30 } }, "rate-limited", 30],
    [503, { error: { code: "AIR_DATA_UNAVAILABLE", retryAfterSeconds: 60 } }, "unavailable", 60],
    [503, { error: { code: "RATE_LIMITING_UNAVAILABLE" } }, "unavailable", null],
    [500, { error: { code: "INTERNAL_ERROR" } }, "server", null],
    [400, { error: { code: "INVALID_REQUEST" } }, "server", null],
    [200, { ok: false }, "server", null],
  ] as const)("classifies HTTP %i as %s", async (status, body, kind, retry) => {
    installApi({ air: () => ({ status, body }), recommend: () => ({ status, body }) });
    for (const out of [await fetchAir("patna", signal()), await fetchRecommendations("patna", "family_toddlers", false, signal())]) {
      expect(out.ok).toBe(false);
      if (out.ok) continue;
      expect(out.failure.kind).toBe(kind);
      expect(out.failure.retryAfterSeconds).toBe(retry);
    }
  });

  it("never passes a server message through to the user", async () => {
    installApi({ air: () => ({ status: 500, body: { ok: false, error: { code: "INTERNAL_ERROR", message: "stack trace /srv/app.js" } } }) });
    const out = await fetchAir("patna", signal());
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).not.toContain("stack trace");
  });

  it("keeps the explicit unavailable state that the server sends with a 503", async () => {
    const air = unavailableAir();
    installApi({ air: () => ({ status: 503, body: { ok: false, error: { code: "AIR_DATA_UNAVAILABLE" }, data: air } }) });
    const out = await fetchAir("delhi-ncr", signal());
    expect(!out.ok && out.data?.freshnessStatus).toBe("unavailable");
  });

  it("keeps the AI envelope that travels with a failed recommendation response", async () => {
    const result = recommendFor(unavailableAir());
    installApi({ recommend: () => ({ status: 503, body: { ok: false, error: { code: "AIR_DATA_UNAVAILABLE" }, data: result, ai: { status: "unavailable" } } }) });
    const out = await fetchRecommendations("delhi-ncr", "family_toddlers", true, signal());
    expect(!out.ok && out.data?.ai).toEqual({ status: "unavailable" });
  });

  it("reports a network failure, and a non-JSON body as a server failure", async () => {
    installApi({ air: () => "network-error" });
    expect(await fetchAir("patna", signal())).toMatchObject({ ok: false, failure: { kind: "network" }, data: null });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("<html>", { status: 502 }))));
    expect(await fetchAir("patna", signal())).toMatchObject({ ok: false, failure: { kind: "server" } });
  });

  it("re-throws a caller abort so a replaced request is never shown as an error", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))));
    const pending = fetchAir("patna", controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });

  it("times out as a network failure rather than hanging, with a bounded wait", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => {
      const c = new AbortController();
      c.abort(new DOMException("timeout", "TimeoutError"));
      return c.signal;
    });
    try {
      vi.stubGlobal("fetch", vi.fn((_u: string, init: RequestInit) => (init.signal?.aborted ? Promise.reject(new DOMException("timeout", "TimeoutError")) : new Promise(() => undefined))));
      expect(await fetchAir("patna", signal())).toMatchObject({ ok: false, failure: { kind: "network" } });
      expect(await fetchRecommendations("patna", "family_toddlers", true, signal())).toMatchObject({ ok: false, failure: { kind: "network" } });
      expect(timeout.mock.calls.map((c) => c[0])).toEqual([20_000, 50_000]);
    } finally {
      timeout.mockRestore();
    }
  });
});
