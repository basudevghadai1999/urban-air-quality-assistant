import { vi } from "vitest";

import { MemoryProviderBudget, RedisProviderBudget, type ProviderBudget } from "@/lib/ai/providerBudget";
import type { ProviderTarget } from "@/lib/ai/provider";
import type { RedisCommandClient } from "@/lib/redis";
import { createAiCache, type AiCache } from "@/lib/ai/cache";
import type { GeminiRawResponse, GeminiRequest, GeminiTransport } from "@/lib/ai/client";
import type { AiConfigResult, AiRuntimeConfig } from "@/lib/ai/config";
import { buildGroundingContext } from "@/lib/ai/context";
import { buildFallbackExplanation, SAFETY_DISCLAIMER } from "@/lib/ai/fallback";
import { createExplanationService, type ExplanationService } from "@/lib/ai/service";
import type { AiExplanation } from "@/lib/ai/types";
import { createAirMetrics, type AirMetrics } from "@/lib/observability/metrics";
import type { RateLimitGate } from "@/lib/ratelimit/gate";
import { generateRecommendations, type RecommendationResult, type ProfileId } from "@/lib/engine";
import type { NormalizedAirData } from "@/types/air";

import { MORNING_DIP, NOW, snapshot } from "./engine";

/** All model output here is SYNTHETIC: written by the tests, never produced by a real model. */

export const FAKE_API_KEY = "FAKE-TEST-KEY-do-not-use-0123456789abcdef";

export function providerTarget(id: "gemini" | "groq", model?: string): ProviderTarget {
  const t = { id, model: model ?? (id === "gemini" ? "test-model" : "test-groq-model") };
  Object.defineProperty(t, "apiKey", { value: id === "gemini" ? FAKE_API_KEY : `${FAKE_API_KEY}-groq`, enumerable: false });
  return t as ProviderTarget;
}

export function readyConfig(
  overrides: Partial<AiRuntimeConfig["settings"]> = {},
  model = "test-model",
  providers: readonly ("gemini" | "groq")[] = ["gemini"],
): AiRuntimeConfig {
  return {
    status: "ready" as const,
    providers: providers.map((id) => providerTarget(id, id === "gemini" ? model : undefined)),
    settings: {
      enabled: true,
      timeoutMs: 5_000,
      maxOutputTokens: 3_000,
      thinkingBudget: null,
      rateLimit: { limit: 5, windowSeconds: 60 },
      dailyBudget: 10,
      providerDailyBudget: { gemini: 10, groq: 10 },
      providerOrder: ["gemini", "groq"],
      cacheTtlSeconds: 1_800,
      ...overrides,
    },
  };
}

export function resultFor(profileId: ProfileId = "senior_respiratory", air: NormalizedAirData = snapshot(MORNING_DIP), preferences?: unknown): { result: RecommendationResult; air: NormalizedAirData } {
  const out = generateRecommendations({ air, profileId, preferences, nowMs: NOW });
  if (!out.ok) throw new Error("fixture must resolve");
  return { result: out.result, air };
}

/** A compliant explanation for a result: the deterministic fallback IS compliant by construction (and tested to be). */
export function compliantExplanation(result: RecommendationResult): AiExplanation {
  return buildFallbackExplanation(result);
}

export function modelText(explanation: unknown): GeminiRawResponse {
  return { text: JSON.stringify(explanation), finishReason: "STOP", blockReason: null };
}

export interface FakeTransport extends GeminiTransport {
  readonly requests: GeminiRequest[];
  respond: (request: GeminiRequest) => Promise<GeminiRawResponse>;
}

export function fakeTransport(respond: (request: GeminiRequest) => Promise<GeminiRawResponse>): FakeTransport {
  const requests: GeminiRequest[] = [];
  const transport: FakeTransport = {
    requests,
    respond,
    generate(request) {
      requests.push(request);
      return transport.respond(request);
    },
  };
  return transport;
}

export const allowGate: RateLimitGate = () =>
  Promise.resolve({ kind: "allow", allowUpstream: true, result: { allowed: true, limit: 5, remaining: 4, resetSeconds: 60 } });
export const limitedGate = (retryAfterSeconds = 42): RateLimitGate => () =>
  Promise.resolve({ kind: "limited", retryAfterSeconds, result: { allowed: false, limit: 5, remaining: 0, resetSeconds: retryAfterSeconds } });
export const degradedGate: RateLimitGate = () => Promise.resolve({ kind: "degraded", allowUpstream: false });

export interface ServiceHarness {
  readonly service: ExplanationService;
  readonly transport: FakeTransport;
  readonly metrics: AirMetrics;
  readonly logs: string[];
  readonly cache: AiCache;
  readonly budget: ProviderBudget;
  readonly groqTransport: FakeTransport;
  readonly config: { value: AiConfigResult };
}

export function buildService(
  options: {
    respond?: (request: GeminiRequest) => Promise<GeminiRawResponse>;
    config?: AiConfigResult;
    gate?: RateLimitGate;
    respondGroq?: (request: GeminiRequest) => Promise<GeminiRawResponse>;
    budget?: ProviderBudget;
    cache?: AiCache;
  } = {},
): ServiceHarness {
  const lines: string[] = [];
  const metrics = createAirMetrics((line) => lines.push(line), () => NOW);
  const transport = fakeTransport(options.respond ?? (() => Promise.reject(new Error("no response configured"))));
  const groqTransport = fakeTransport(options.respondGroq ?? (() => Promise.reject(new Error("no groq response configured"))));
  const config = { value: options.config ?? readyConfig() };
  const cache = options.cache ?? createAiCache({ ttlSeconds: 1_800, now: () => NOW, metrics });
  const budget = options.budget ?? new MemoryProviderBudget({ global: 10, providers: { gemini: 10, groq: 10 } }, () => NOW);
  const service = createExplanationService({
    getConfig: () => config.value,
    getTransport: (provider) => (provider.id === "groq" ? groqTransport : transport),
    cache,
    budget,
    clientGate: options.gate ?? allowGate,
    metrics,
    logger: { warn: (event, fields) => lines.push(JSON.stringify({ event, ...fields })) },
  });
  return { service, transport, groqTransport, metrics, logs: lines, cache, budget, config };
}

export { buildGroundingContext, SAFETY_DISCLAIMER, vi };

const BIG = 100_000;
/** A global-limit budget with generous per-provider caps: behaves like the single-provider budget it replaces. */
export const memoryBudget = (global: number, now: () => number = () => NOW): MemoryProviderBudget =>
  new MemoryProviderBudget({ global, providers: { gemini: BIG, groq: BIG } }, now);
export const redisBudget = (client: RedisCommandClient, global: number, now: () => number): RedisProviderBudget =>
  new RedisProviderBudget({ client, limits: { global, providers: { gemini: BIG, groq: BIG } }, now });
