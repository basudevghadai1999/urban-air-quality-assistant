import "server-only";

import { getSharedInfrastructure } from "@/lib/data/defaultAirService";
import { AI_SETTING_LIMITS, DEFAULT_AI_PROVIDER_ORDER, getAiSettings, type AiSettings } from "@/lib/env";
import { consoleSafeLogger } from "@/lib/observability/logger";
import { noopMetrics } from "@/lib/observability/metrics";
import { MemoryRateLimiter, detectIpTrust } from "@/lib/ratelimit";
import { createRateLimitGate, type RateLimitGate } from "@/lib/ratelimit/gate";
import { RedisRateLimiter } from "@/lib/ratelimit/redis";

import { MemoryProviderBudget, RedisProviderBudget, type ProviderBudget } from "./providerBudget";
import { createAiCache } from "./cache";
import { createGeminiTransport } from "./client";
import { createGroqTransport } from "./groqClient";
import type { ProviderTransport } from "./provider";
import { resolveAiConfig } from "./config";
import { createExplanationService, type ExplanationService } from "./service";

/**
 * Process-wide wiring for Gemini explanations, on `globalThis` like the air service so route
 * bundles and hot reloads share one cache, one limiter, one budget and one SDK client.
 *
 * Protection by environment (nothing ever fails open into unlimited Gemini calls):
 *   Redis configured     per-client limit and the daily budget are shared by every instance;
 *                        if Redis then fails, the model is not called (fallback).
 *   no Redis, development  per-process limiter and budget: fine for one local server.
 *   no Redis, production   AI is PAUSED (reason AI_PROTECTION_UNAVAILABLE): per-instance counters
 *                        cannot bound serverless spend, so the model is never called.
 */

const SERVICE_KEY = Symbol.for("urban-air-intelligence.ai-service");
type Store = Record<symbol, unknown>;

const pausedGate: RateLimitGate = () => Promise.resolve({ kind: "degraded", allowUpstream: false });
const pausedBudget: ProviderBudget = {
  reserve: () => Promise.reject(new Error("AI protection is unavailable: Redis is not configured in production")),
};

export function getAiExplanationService(): ExplanationService {
  const store = globalThis as unknown as Store;
  const existing = store[SERVICE_KEY] as ExplanationService | undefined;
  if (existing !== undefined) return existing;

  const infra = getSharedInfrastructure();

  // An invalid setting must not take the API down: `resolveAiConfig` reports it per call (AI_INVALID_CONFIG),
  // and the infrastructure below is built from the documented defaults.
  let settings: AiSettings;
  try {
    settings = getAiSettings();
  } catch {
    const L = AI_SETTING_LIMITS;
    settings = {
      enabled: true,
      timeoutMs: L.timeoutMs.default,
      maxOutputTokens: L.maxOutputTokens.default,
      thinkingBudget: null,
      rateLimit: { limit: L.rateLimitMax.default, windowSeconds: L.rateLimitWindowSeconds.default },
      dailyBudget: L.dailyBudget.default,
      providerDailyBudget: { gemini: L.geminiDailyBudget.default, groq: L.groqDailyBudget.default },
      providerOrder: DEFAULT_AI_PROVIDER_ORDER,
      cacheTtlSeconds: L.cacheTtlSeconds.default,
    };
  }

  const protectionAvailable = infra.client !== null || !infra.production;
  const clientGate: RateLimitGate = !protectionAvailable
    ? pausedGate
    : createRateLimitGate({
        limiter:
          infra.client === null
            ? new MemoryRateLimiter(settings.rateLimit)
            : new RedisRateLimiter({ client: infra.client, policy: settings.rateLimit, keyPrefix: "ai:v1:rl:" }),
        ipTrust: detectIpTrust(process.env),
        hashSecret: infra.setting.status === "configured" ? infra.setting.config.token : infra.ephemeralSecret,
        logger: consoleSafeLogger,
        // The service counts its own AI metrics; the generic limiter counters stay for /api/air.
        metrics: noopMetrics,
      });
  const limits = { global: settings.dailyBudget, providers: settings.providerDailyBudget };
  const budget: ProviderBudget = !protectionAvailable
    ? pausedBudget
    : infra.client === null
      ? new MemoryProviderBudget(limits)
      : new RedisProviderBudget({ client: infra.client, limits });

  // One SDK/HTTP client per provider, rebuilt only if that provider's key changes.
  const transports = new Map<string, { apiKey: string; instance: ProviderTransport }>();
  const service = createExplanationService({
    getConfig: () => resolveAiConfig(),
    getTransport: (provider) => {
      const existing = transports.get(provider.id);
      if (existing !== undefined && existing.apiKey === provider.apiKey) return existing.instance;
      const instance = provider.id === "gemini" ? createGeminiTransport(provider.apiKey) : createGroqTransport(provider.apiKey);
      transports.set(provider.id, { apiKey: provider.apiKey, instance });
      return instance;
    },
    cache: createAiCache({ ttlSeconds: settings.cacheTtlSeconds, client: infra.client, logger: consoleSafeLogger, metrics: infra.metrics }),
    budget,
    clientGate,
    metrics: infra.metrics,
    logger: consoleSafeLogger,
  });
  store[SERVICE_KEY] = service;
  return service;
}
