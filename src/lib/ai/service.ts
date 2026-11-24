import "server-only";

import type { RecommendationResult } from "@/lib/engine";
import { noopMetrics, type AirMetrics } from "@/lib/observability/metrics";
import { silentLogger, type SafeLogger } from "@/lib/observability/logger";
import type { RateLimitGate } from "@/lib/ratelimit/gate";
import type { NormalizedAirData } from "@/types/air";

import { aiCacheKey, type AiCache } from "./cache";
import type { AiConfigResult, AiRuntimeConfig } from "./config";
import { buildGroundingContext, MAX_CONTEXT_BYTES } from "./context";
import { AI_REASON_MESSAGES, AiError, isAiError, isFailoverEligible, type AiReasonCode } from "./errors";
import { buildFallbackExplanation } from "./fallback";
import { generateExplanationText } from "./generator";
import { PROMPT_VERSION } from "./prompt";
import type { ProviderBudget } from "./providerBudget";
import type { ProviderTarget, ProviderTransport } from "./provider";
import type { AiAttempt, AiEnvelope, AiExplanation, AiProviderName, AiTokenUsage } from "./types";
import { validateExplanation, validateModelText } from "./validator";

/**
 * Orchestrates one explanation across providers. The order is the cost policy:
 *
 *   config -> air data present? -> bounded context -> CACHE for each provider, in order (free)
 *          -> single-flight join (free) -> per-client limit (once per request)
 *          -> for each configured provider, in order:
 *               atomic daily budget (global + this provider) -> ONE call -> same validator -> cache
 *          -> deterministic fallback
 *
 * The next provider is tried only after a failure that `isFailoverEligible` allows, and never more
 * than once each: no retries, no loops. Every exit that is not a validated provider answer is the
 * deterministic fallback, which never costs budget. The service never throws, never switches model,
 * never calls a provider that is not configured, and never changes the recommendation result: it
 * receives it read-only and returns prose in a separate envelope.
 *
 * Fail-closed: if the rate limiter or the budget cannot decide (Redis down), NO provider is called.
 * Switching providers cannot bypass the global budget: every reservation charges it atomically.
 */

export interface ExplainInput {
  readonly request: Request;
  readonly result: RecommendationResult;
  readonly air: NormalizedAirData;
}

export interface ExplanationService {
  explain(input: ExplainInput): Promise<AiEnvelope>;
}

export interface ExplanationServiceDeps {
  /** Resolved per call so a missing or invalid setting degrades to fallback instead of failing at boot. */
  readonly getConfig: () => AiConfigResult;
  readonly getTransport: (provider: ProviderTarget) => ProviderTransport;
  readonly cache: AiCache;
  readonly budget: ProviderBudget;
  /** Per-client limit on generation REQUESTS (one decision per request, however many providers it uses). Consulted only on a cache miss. */
  readonly clientGate: RateLimitGate;
  readonly metrics?: AirMetrics;
  readonly logger?: SafeLogger;
  /** Milliseconds clock for latency; injectable for tests. */
  readonly clock?: () => number;
}

const PROVIDER_LABEL: Readonly<Record<"gemini" | "groq", string>> = { gemini: "Gemini", groq: "Groq" };

export function createExplanationService(deps: ExplanationServiceDeps): ExplanationService {
  const metrics = deps.metrics ?? noopMetrics;
  const logger = deps.logger ?? silentLogger;
  const clock = deps.clock ?? (() => Date.now());
  const inflight = new Map<string, Promise<AiEnvelope>>();

  interface EnvelopeFields {
    readonly status: AiEnvelope["status"];
    readonly reasonCode: AiReasonCode | null;
    readonly message: string;
    readonly explanation: AiExplanation | null;
    readonly provider: AiProviderName;
    readonly model: string | null;
    readonly retryAfterSeconds?: number;
    readonly attempts?: readonly AiAttempt[];
    readonly tokenUsage?: AiTokenUsage;
  }

  function envelope(f: EnvelopeFields): AiEnvelope {
    return {
      status: f.status,
      reasonCode: f.reasonCode,
      message: f.message,
      explanation: f.explanation,
      provider: f.provider,
      model: f.model,
      promptVersion: PROMPT_VERSION,
      ...(f.attempts === undefined || f.attempts.length === 0 ? {} : { attempts: f.attempts }),
      ...(f.tokenUsage === undefined ? {} : { tokenUsage: f.tokenUsage }),
      ...(f.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: f.retryAfterSeconds }),
      numbersFromEngine: true,
    };
  }

  function fallback(result: RecommendationResult, code: AiReasonCode, attempts: readonly AiAttempt[] = [], retryAfterSeconds?: number): AiEnvelope {
    metrics.increment("ai_fallback", { code });
    let explanation: AiExplanation;
    try {
      explanation = buildFallbackExplanation(result);
    } catch {
      logger.warn("ai.fallback_build_failed", { code });
      return envelope({ status: "unavailable", reasonCode: code, message: AI_REASON_MESSAGES[code], explanation: null, provider: "deterministic", model: null, attempts });
    }
    return envelope({
      status: "fallback",
      reasonCode: code,
      message: AI_REASON_MESSAGES[code],
      explanation,
      provider: "deterministic",
      model: null,
      attempts,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }

  /** Counters for one provider call that did not produce a validated explanation. */
  function recordFailure(provider: ProviderTarget, code: AiReasonCode, rejection?: string | null): void {
    metrics.increment("ai_provider_failure", { provider: provider.id, code });
    if (provider.id === "gemini") {
      if (code === "AI_TIMEOUT") metrics.increment("gemini_timeout");
      else if (code === "AI_QUOTA") metrics.increment("gemini_quota_failure");
      else if (code === "AI_VALIDATION_REJECTED") metrics.increment("gemini_validation_rejection", { kind: rejection ?? "unknown" });
      else if (code === "AI_EMPTY_RESPONSE" || code === "AI_TRUNCATED" || code === "AI_INVALID_JSON" || code === "AI_SCHEMA_INVALID") {
        metrics.increment("gemini_invalid_output", { code });
      }
    } else if (code === "AI_VALIDATION_REJECTED") {
      metrics.increment("gemini_validation_rejection", { kind: rejection ?? "unknown", provider: provider.id });
    }
  }

  function recordUsage(provider: ProviderTarget, latencyMs: number, usage: AiTokenUsage): void {
    metrics.increment("ai_latency_ms_total", { provider: provider.id }, Math.max(0, Math.round(latencyMs)));
    if (usage.inputTokens === null && usage.outputTokens === null && usage.totalTokens === null) {
      metrics.increment("ai_tokens_unreported", { provider: provider.id });
      return;
    }
    if (usage.inputTokens !== null) metrics.increment("ai_tokens_input", { provider: provider.id }, usage.inputTokens);
    if (usage.outputTokens !== null) metrics.increment("ai_tokens_output", { provider: provider.id }, usage.outputTokens);
    if (usage.totalTokens !== null) metrics.increment("ai_tokens_total", { provider: provider.id }, usage.totalTokens);
  }

  async function generate(
    input: ExplainInput,
    config: AiRuntimeConfig,
    grounding: ReturnType<typeof buildGroundingContext>,
    keys: ReadonlyMap<string, string>,
    validation: { allowedIds: readonly string[]; contextJson: string; secrets: readonly string[] },
  ): Promise<AiEnvelope> {
    const { result, request } = input;

    // Per-client limit on generation requests (cache hits never get here).
    const decision = await deps.clientGate(request);
    if (decision.kind === "limited") {
      metrics.increment("ai_rate_limit_rejection");
      return fallback(result, "AI_RATE_LIMITED", [], decision.retryAfterSeconds);
    }
    if (decision.kind === "degraded") {
      metrics.increment("ai_protection_unavailable", { layer: "client-limit" });
      return fallback(result, "AI_PROTECTION_UNAVAILABLE");
    }

    const attempts: AiAttempt[] = [];
    let lastCode: AiReasonCode = "AI_NOT_CONFIGURED";
    let lastRetryAfter: number | undefined;

    for (const [index, provider] of config.providers.entries()) {
      const hasNext = index < config.providers.length - 1;
      const next = (code: AiReasonCode): boolean => {
        attempts.push({ provider: provider.id, reasonCode: code });
        lastCode = code;
        if (hasNext && isFailoverEligible(code)) {
          metrics.increment("ai_provider_fallback", { provider: provider.id, code });
          return true;
        }
        return false;
      };

      // Atomic budget: charges the global AND this provider's counter together. A failure to decide is a refusal.
      let reservation;
      try {
        reservation = await deps.budget.reserve(provider.id);
      } catch {
        metrics.increment("ai_protection_unavailable", { layer: "budget" });
        return fallback(result, "AI_PROTECTION_UNAVAILABLE", attempts);
      }
      if (!reservation.allowed) {
        metrics.increment("ai_budget_rejection", { provider: provider.id, kind: reservation.deniedBy ?? "unknown" });
        lastRetryAfter = reservation.resetsInSeconds;
        // The global cap ends the chain: another provider would draw on the same cap. A provider cap only skips that provider.
        if (reservation.deniedBy === "global") return fallback(result, "AI_BUDGET_EXHAUSTED", attempts, reservation.resetsInSeconds);
        attempts.push({ provider: provider.id, reasonCode: "AI_BUDGET_EXHAUSTED" });
        lastCode = "AI_BUDGET_EXHAUSTED";
        continue;
      }

      metrics.increment("ai_provider_request", { provider: provider.id });
      if (provider.id === "gemini") metrics.increment("gemini_request");
      const started = clock();

      let text: string;
      let usage: AiTokenUsage;
      try {
        const out = await generateExplanationText(deps.getTransport(provider), provider, config.settings, grounding);
        text = out.text;
        usage = out.usage;
      } catch (error) {
        const code: AiReasonCode = isAiError(error) ? error.code : "AI_INTERNAL";
        recordFailure(provider, code);
        if (next(code)) continue;
        return fallback(result, code, attempts);
      }
      const latency = clock() - started;

      const checked = validateModelText(text, validation);
      if (!checked.ok) {
        recordFailure(provider, checked.code, checked.rejection);
        if (next(checked.code)) continue;
        return fallback(result, checked.code, attempts);
      }

      recordUsage(provider, latency, usage);
      metrics.increment("ai_provider_success", { provider: provider.id });
      if (provider.id === "gemini") metrics.increment("gemini_success");
      try {
        const key = keys.get(provider.id);
        if (key !== undefined) await deps.cache.set(key, checked.value);
      } catch {
        // A cache failure costs only a future miss.
      }
      return envelope({
        status: "generated",
        reasonCode: null,
        message: `Explanation written by ${PROVIDER_LABEL[provider.id]} from the calculated results.`,
        explanation: checked.value,
        provider: provider.id,
        model: provider.model,
        attempts,
        tokenUsage: usage,
      });
    }

    return fallback(result, lastCode, attempts, lastCode === "AI_BUDGET_EXHAUSTED" ? lastRetryAfter : undefined);
  }

  async function run(input: ExplainInput): Promise<AiEnvelope> {
    const { result, air } = input;

    const config = deps.getConfig();
    if (config.status === "unavailable") return fallback(result, config.reason);
    if (result.status !== "ok") return fallback(result, "AI_AIR_DATA_UNAVAILABLE");

    const grounding = buildGroundingContext(result, air);
    if (new TextEncoder().encode(grounding.json).length > MAX_CONTEXT_BYTES) return fallback(result, "AI_INPUT_TOO_LARGE");

    // Every provider's key is a secret the output must not contain.
    const validation = { allowedIds: grounding.allowedIds, contextJson: grounding.json, secrets: config.providers.map((p) => p.apiKey) };
    const keys = new Map(
      config.providers.map((p) => [p.id, aiCacheKey({ promptVersion: PROMPT_VERSION, provider: p.id, model: p.model, contextJson: grounding.json })] as const),
    );

    // A cached explanation (from any configured provider, in order) is re-validated against THIS request before it is served.
    for (const provider of config.providers) {
      const key = keys.get(provider.id);
      if (key === undefined) continue;
      const cached = await deps.cache.get(key, (candidate) => {
        const checked = validateExplanation(candidate, validation);
        return checked.ok ? checked.value : null;
      });
      if (cached !== null) {
        metrics.increment("ai_cache_hit", { provider: provider.id });
        return envelope({
          status: "cached",
          reasonCode: null,
          message: "Explanation reused from an earlier identical request.",
          explanation: cached,
          provider: provider.id,
          model: provider.model,
        });
      }
    }
    metrics.increment("ai_cache_miss");

    // Identical concurrent requests share one generation chain (and its budget units).
    const flightKey = [...keys.values()].join("|");
    const existing = inflight.get(flightKey);
    if (existing !== undefined) return existing;
    const pending = generate(input, config, grounding, keys, validation).finally(() => {
      inflight.delete(flightKey);
    });
    inflight.set(flightKey, pending);
    return pending;
  }

  return {
    async explain(input) {
      try {
        return await run(input);
      } catch (error) {
        logger.warn("ai.unexpected_error", { kind: error instanceof AiError ? error.code : error instanceof Error ? error.name : "unknown" });
        return fallback(input.result, "AI_INTERNAL");
      }
    },
  };
}
