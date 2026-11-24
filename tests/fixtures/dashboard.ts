import { vi } from "vitest";

import { getCityById, type CityId } from "@/config/cities";
import { buildFallbackExplanation } from "@/lib/ai/fallback";
import { AI_REASON_MESSAGES, type AiReasonCode } from "@/lib/ai/errors";
import type { AiEnvelope } from "@/lib/ai/types";
import { buildUnavailableAirData } from "@/lib/data/airData";
import { generateRecommendations, type ProfileId, type RecommendationResult } from "@/lib/engine";
import type { NormalizedAirData } from "@/types/air";

import { NOW } from "./engine";
import { makeSnapshot } from "./snapshot";

/**
 * Mocked API for the dashboard tests. Every payload is built through the REAL mapper, CPCB engine
 * and recommendation engine from synthetic input values, so the UI is tested against genuine
 * response shapes. AI text is the deterministic fallback text, wrapped in test envelopes: no
 * real model is ever involved.
 */

export const airFor = (cityId: CityId = "delhi-ncr"): NormalizedAirData => makeSnapshot(cityId);

export const staleAir = (cityId: CityId = "delhi-ncr"): NormalizedAirData => ({ ...airFor(cityId), freshnessStatus: "stale", ageSeconds: 7_200 });

export function unavailableAir(cityId: CityId = "delhi-ncr"): NormalizedAirData {
  const city = getCityById(cityId);
  if (city === undefined) throw new Error("unknown city");
  return buildUnavailableAirData(city, 900, undefined, NOW);
}

export function recommendFor(air: NormalizedAirData, profileId: ProfileId = "family_toddlers"): RecommendationResult {
  const out = generateRecommendations({ air, profileId, nowMs: NOW });
  if (!out.ok) throw new Error("fixture must resolve");
  return out.result;
}

export function envelopeFor(
  result: RecommendationResult,
  kind: "generated-groq" | "generated-gemini" | "cached-gemini" | "fallback" | "unavailable",
  reasonCode: AiReasonCode = "AI_NOT_CONFIGURED",
  extra: Partial<AiEnvelope> = {},
): AiEnvelope {
  const base = { promptVersion: "test", numbersFromEngine: true as const };
  const explanation = buildFallbackExplanation(result);
  switch (kind) {
    case "generated-groq":
      return { ...base, status: "generated", reasonCode: null, message: "ok", explanation, provider: "groq", model: "test-groq-model", ...extra };
    case "generated-gemini":
      return { ...base, status: "generated", reasonCode: null, message: "ok", explanation, provider: "gemini", model: "test-gemini-model", ...extra };
    case "cached-gemini":
      return { ...base, status: "cached", reasonCode: null, message: "ok", explanation, provider: "gemini", model: "test-gemini-model", ...extra };
    case "fallback":
      return { ...base, status: "fallback", reasonCode, message: AI_REASON_MESSAGES[reasonCode], explanation, provider: "deterministic", model: null, ...extra };
    case "unavailable":
      return { ...base, status: "unavailable", reasonCode, message: AI_REASON_MESSAGES[reasonCode], explanation: null, provider: "deterministic", model: null, ...extra };
  }
}

export interface ApiReply {
  readonly status: number;
  readonly body: unknown;
}

export interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly body: Record<string, unknown> | null;
}

export interface MockApi {
  readonly calls: RecordedCall[];
  airCalls(): RecordedCall[];
  recommendCalls(explain?: boolean): RecordedCall[];
}

export interface Handlers {
  air?: (cityId: CityId) => ApiReply | Promise<ApiReply> | "network-error";
  recommend?: (cityId: CityId, profileId: ProfileId, explain: boolean) => ApiReply | Promise<ApiReply> | "network-error";
}

export const okAir = (cityId: CityId): ApiReply => ({ status: 200, body: { ok: true, data: airFor(cityId) } });

export function okRecommend(cityId: CityId, profileId: ProfileId, explain: boolean): ApiReply {
  const result = recommendFor(airFor(cityId), profileId);
  return { status: 200, body: { ok: true, data: result, ...(explain ? { ai: envelopeFor(result, "generated-groq") } : {}) } };
}

/** Replace `fetch` with a router over the two endpoints. Unspecified handlers return healthy responses. */
export function installApi(handlers: Handlers = {}): MockApi {
  const calls: RecordedCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      calls.push({ url, method, body });
      let reply: ApiReply | Promise<ApiReply> | "network-error";
      if (url.startsWith("/api/air")) {
        const cityId = new URL(url, "http://localhost").searchParams.get("cityId") as CityId;
        reply = (handlers.air ?? okAir)(cityId);
      } else {
        const b = body as { cityId: CityId; profileId: ProfileId; explain: boolean };
        reply = (handlers.recommend ?? okRecommend)(b.cityId, b.profileId, b.explain);
      }
      const settled = await reply;
      if (settled === "network-error") throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(settled.body), { status: settled.status, headers: { "Content-Type": "application/json" } });
    }),
  );
  return {
    calls,
    airCalls: () => calls.filter((c) => c.url.startsWith("/api/air")),
    recommendCalls: (explain) => calls.filter((c) => c.url.startsWith("/api/recommend") && (explain === undefined || c.body?.explain === explain)),
  };
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
