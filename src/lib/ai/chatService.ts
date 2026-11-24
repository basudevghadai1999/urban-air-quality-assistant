import "server-only";

import type { RecommendationResult } from "@/lib/engine";
import { noopMetrics, type AirMetrics } from "@/lib/observability/metrics";
import { silentLogger, type SafeLogger } from "@/lib/observability/logger";
import type { RateLimitGate } from "@/lib/ratelimit/gate";
import type { NormalizedAirData } from "@/types/air";

import type { AiConfigResult, AiRuntimeConfig } from "./config";
import { buildChatFallback } from "./chatFallback";
import { buildChatUserPrompt, CHAT_PROMPT_VERSION, CHAT_SYSTEM_INSTRUCTION, type ChatPromptTurn } from "./chatPrompt";
import { buildChatResponseJsonSchema, parseChatAnswer } from "./chatSchema";
import type { ChatEnvelope } from "./chatTypes";
import { buildGroundingContext, MAX_CONTEXT_BYTES } from "./context";
import { AiError, classifyGeminiError, isAiError, isFailoverEligible, type AiReasonCode } from "./errors";
import { defaultThinkingBudget, GENERATION_TEMPERATURE, interpretResponse } from "./generator";
import type { ProviderBudget } from "./providerBudget";
import type { ProviderTarget, ProviderTransport } from "./provider";
import { validateAnswerText } from "./validator";

/**
 * One chat answer, produced the same cautious way as an explanation, minus the cache (every question
 * is different):
 *
 *   config -> air data present? -> bounded context -> per-client limit
 *          -> for each configured provider, in order:
 *               atomic daily budget (global + this provider) -> ONE call -> same text validator
 *          -> deterministic answer
 *
 * The next provider is tried only after a failure that `isFailoverEligible` allows, never more than
 * once each, with no retries. The service never throws, never calls a provider that is not configured,
 * and never changes the recommendation result. It shares the explanation layer's rate limiter and
 * budgets, so chat cannot spend more than the explanations it sits beside.
 *
 * Fail-closed: if the limiter or the budget cannot decide (Redis down), no provider is called.
 */

export interface ChatInput {
  readonly request: Request;
  readonly result: RecommendationResult;
  readonly air: NormalizedAirData;
  /** Already validated, trimmed and marker-free (see `chatSchema.ts`). */
  readonly message: string;
  readonly history: readonly ChatPromptTurn[];
}

export interface ChatService {
  answer(input: ChatInput): Promise<ChatEnvelope>;
}

export interface ChatServiceDeps {
  readonly getConfig: () => AiConfigResult;
  readonly getTransport: (provider: ProviderTarget) => ProviderTransport;
  readonly budget: ProviderBudget;
  readonly clientGate: RateLimitGate;
  readonly metrics?: AirMetrics;
  readonly logger?: SafeLogger;
}

/** Fixed, user-readable. Never derived from a provider message. */
const GENERIC = "The assistant could not use AI for this question, so a standard answer from the built-in rules is shown.";
const CHAT_REASON_MESSAGES: Partial<Readonly<Record<AiReasonCode, string>>> = {
  AI_DISABLED: "AI answers are switched off, so a standard answer from the built-in rules is shown.",
  AI_NOT_CONFIGURED: "AI answers are not set up on this server, so a standard answer from the built-in rules is shown.",
  AI_RATE_LIMITED: "You are asking too quickly, so a standard answer is shown. Please try again shortly.",
  AI_PROTECTION_UNAVAILABLE: "AI answers are paused because usage limits cannot be checked right now, so a standard answer is shown.",
  AI_BUDGET_EXHAUSTED: "Today's AI allowance has been used, so a standard answer is shown. AI answers resume tomorrow (UTC).",
  AI_TIMEOUT: "The AI took too long, so a standard answer is shown.",
  AI_QUOTA: "The AI service is busy, so a standard answer is shown.",
  AI_VALIDATION_REJECTED: "The AI's answer failed safety checks and was discarded, so a standard answer is shown.",
};
const messageFor = (code: AiReasonCode): string => CHAT_REASON_MESSAGES[code] ?? GENERIC;

const PROVIDER_LABEL: Readonly<Record<"gemini" | "groq", string>> = { gemini: "Gemini", groq: "Groq" };

async function generateChatText(
  transport: ProviderTransport,
  target: ProviderTarget,
  config: AiRuntimeConfig,
  contextJson: string,
  history: readonly ChatPromptTurn[],
  message: string,
): Promise<string> {
  let response;
  try {
    response = await transport.generate({
      model: target.model,
      systemInstruction: CHAT_SYSTEM_INSTRUCTION,
      userPrompt: buildChatUserPrompt(contextJson, history, message),
      responseJsonSchema: buildChatResponseJsonSchema(),
      maxOutputTokens: config.settings.maxOutputTokens,
      temperature: GENERATION_TEMPERATURE,
      thinkingBudget: target.id === "gemini" ? defaultThinkingBudget(target.model, config.settings.thinkingBudget) : null,
      timeoutMs: config.settings.timeoutMs,
    });
  } catch (error) {
    // The message is never read: it can contain the provider's response text.
    throw new AiError(classifyGeminiError(error));
  }
  return interpretResponse(response);
}

type Checked = { readonly ok: true; readonly answer: string } | { readonly ok: false; readonly code: AiReasonCode };

function checkAnswer(rawText: string, validation: { allowedIds: readonly string[]; contextJson: string; secrets: readonly string[] }): Checked {
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    return { ok: false, code: "AI_INVALID_JSON" };
  }
  const parsed = parseChatAnswer(json);
  if (!parsed.ok) return { ok: false, code: "AI_SCHEMA_INVALID" };
  return validateAnswerText(parsed.answer, validation) === null ? { ok: true, answer: parsed.answer } : { ok: false, code: "AI_VALIDATION_REJECTED" };
}

export function createChatService(deps: ChatServiceDeps): ChatService {
  const metrics = deps.metrics ?? noopMetrics;
  const logger = deps.logger ?? silentLogger;

  function envelope(f: Omit<ChatEnvelope, "promptVersion">): ChatEnvelope {
    return { ...f, promptVersion: CHAT_PROMPT_VERSION };
  }

  function fallback(input: ChatInput, code: AiReasonCode, retryAfterSeconds?: number): ChatEnvelope {
    metrics.increment("ai_fallback", { code, kind: "chat" });
    let answer: string;
    try {
      answer = buildChatFallback(input.result, input.message);
    } catch {
      logger.warn("chat.fallback_build_failed", { code });
      return envelope({ status: "unavailable", answer: null, reasonCode: code, message: messageFor(code), provider: "deterministic", model: null });
    }
    return envelope({
      status: "fallback",
      answer,
      reasonCode: code,
      message: messageFor(code),
      provider: "deterministic",
      model: null,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }

  async function run(input: ChatInput): Promise<ChatEnvelope> {
    const { result, air, request } = input;

    const config = deps.getConfig();
    if (config.status === "unavailable") return fallback(input, config.reason);
    if (result.status !== "ok") return fallback(input, "AI_AIR_DATA_UNAVAILABLE");

    const grounding = buildGroundingContext(result, air);
    if (new TextEncoder().encode(grounding.json).length > MAX_CONTEXT_BYTES) return fallback(input, "AI_INPUT_TOO_LARGE");
    const validation = { allowedIds: grounding.allowedIds, contextJson: grounding.json, secrets: config.providers.map((p) => p.apiKey) };

    // Per-client limit, once per question.
    const decision = await deps.clientGate(request);
    if (decision.kind === "limited") {
      metrics.increment("ai_rate_limit_rejection");
      return fallback(input, "AI_RATE_LIMITED", decision.retryAfterSeconds);
    }
    if (decision.kind === "degraded") {
      metrics.increment("ai_protection_unavailable", { layer: "client-limit" });
      return fallback(input, "AI_PROTECTION_UNAVAILABLE");
    }

    let lastCode: AiReasonCode = "AI_NOT_CONFIGURED";
    let lastRetryAfter: number | undefined;

    for (const [index, provider] of config.providers.entries()) {
      const hasNext = index < config.providers.length - 1;
      const failed = (code: AiReasonCode): boolean => {
        lastCode = code;
        metrics.increment("ai_provider_failure", { provider: provider.id, code, kind: "chat" });
        if (hasNext && isFailoverEligible(code)) {
          metrics.increment("ai_provider_fallback", { provider: provider.id, code });
          return true;
        }
        return false;
      };

      // Atomic budget: charges the global AND this provider's counter. A failure to decide is a refusal.
      let reservation;
      try {
        reservation = await deps.budget.reserve(provider.id);
      } catch {
        metrics.increment("ai_protection_unavailable", { layer: "budget" });
        return fallback(input, "AI_PROTECTION_UNAVAILABLE");
      }
      if (!reservation.allowed) {
        metrics.increment("ai_budget_rejection", { provider: provider.id, kind: reservation.deniedBy ?? "unknown" });
        lastRetryAfter = reservation.resetsInSeconds;
        if (reservation.deniedBy === "global") return fallback(input, "AI_BUDGET_EXHAUSTED", reservation.resetsInSeconds);
        lastCode = "AI_BUDGET_EXHAUSTED";
        continue;
      }

      metrics.increment("ai_provider_request", { provider: provider.id, kind: "chat" });
      let text: string;
      try {
        text = await generateChatText(deps.getTransport(provider), provider, config, grounding.json, input.history, input.message);
      } catch (error) {
        const code: AiReasonCode = isAiError(error) ? error.code : "AI_INTERNAL";
        if (failed(code)) continue;
        return fallback(input, code);
      }

      const checked = checkAnswer(text, validation);
      if (!checked.ok) {
        if (failed(checked.code)) continue;
        return fallback(input, checked.code);
      }

      metrics.increment("ai_provider_success", { provider: provider.id, kind: "chat" });
      return envelope({
        status: "generated",
        answer: checked.answer,
        reasonCode: null,
        message: `Answer written by ${PROVIDER_LABEL[provider.id]} from the calculated results.`,
        provider: provider.id,
        model: provider.model,
      });
    }

    return fallback(input, lastCode, lastCode === "AI_BUDGET_EXHAUSTED" ? lastRetryAfter : undefined);
  }

  return {
    async answer(input) {
      try {
        return await run(input);
      } catch (error) {
        logger.warn("chat.unexpected_error", { kind: error instanceof Error ? error.name : "unknown" });
        return fallback(input, "AI_INTERNAL");
      }
    },
  };
}
