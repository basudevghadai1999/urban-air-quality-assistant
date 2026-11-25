import "server-only";

import type { AiSettings } from "@/lib/env";
import { AiError, classifyGeminiError } from "./errors";
import { buildUserPrompt, SYSTEM_INSTRUCTION } from "./prompt";
import type { ProviderRawResponse, ProviderTransport, TokenUsage } from "./provider";
import { NO_USAGE } from "./provider";
import { buildResponseJsonSchema } from "./schema";

/**
 * One model call, with strict outcome handling. Returns the raw text of a COMPLETE, non-blocked
 * response, or throws an `AiError` carrying a sanitized reason code. It validates nothing about the
 * content: that is `validator.ts`'s job, and nothing from here is shown before it has run.
 */

/** Low temperature: the task is faithful paraphrase, not creativity. */
export const GENERATION_TEMPERATURE = 0.2;

const BLOCKING_FINISH_REASONS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION", "IMAGE_SAFETY", "LANGUAGE", "MALFORMED_FUNCTION_CALL"]);

/**
 * Thinking tokens count against `maxOutputTokens` on Gemini 2.5 models, and this task needs none.
 * For the 2.5 Flash family we turn thinking off by default (a budget of 0, which those models accept).
 * Every other model, including Gemini 3.x (verified to work on its own defaults), is left alone, and
 * `AI_THINKING_BUDGET` overrides either.
 */
export function defaultThinkingBudget(model: string, configured: number | null): number | null {
  if (configured !== null) return configured;
  return /^gemini-2\.5-flash/i.test(model) ? 0 : null;
}

export function interpretResponse(response: ProviderRawResponse): string {
  if (response.blockReason !== null) throw new AiError("AI_SAFETY_BLOCKED");
  if (response.finishReason !== null && BLOCKING_FINISH_REASONS.has(response.finishReason)) throw new AiError("AI_SAFETY_BLOCKED");
  if (response.finishReason === "MAX_TOKENS") throw new AiError("AI_TRUNCATED");
  if (response.text === null || response.text.trim().length === 0) throw new AiError("AI_EMPTY_RESPONSE");
  return response.text;
}

export interface GenerationOutput {
  readonly text: string;
  /** As reported by the provider; null fields mean the provider did not report them. */
  readonly usage: TokenUsage;
}

/** What differs between one kind of request and another; everything else about a model call is shared. */
export interface PromptParts {
  readonly systemInstruction: string;
  readonly userPrompt: string;
  readonly responseJsonSchema: Record<string, unknown>;
}

/** Per-call limits that may be tighter than the configured ones: the time left in the chain, a caller that can leave. */
export interface CallLimits {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** One provider call for any prompt: the shared request limits, error classification and response checks. */
export async function generateText(
  transport: ProviderTransport,
  target: { readonly id: "gemini" | "groq"; readonly model: string },
  settings: AiSettings,
  prompt: PromptParts,
  call: CallLimits = {},
): Promise<GenerationOutput> {
  let response: ProviderRawResponse;
  try {
    response = await transport.generate({
      model: target.model,
      ...prompt,
      maxOutputTokens: settings.maxOutputTokens,
      temperature: GENERATION_TEMPERATURE,
      thinkingBudget: target.id === "gemini" ? defaultThinkingBudget(target.model, settings.thinkingBudget) : null,
      timeoutMs: call.timeoutMs ?? settings.timeoutMs,
      ...(call.signal === undefined ? {} : { signal: call.signal }),
    });
  } catch (error) {
    // The message is never read: it can contain the provider's response text.
    throw new AiError(classifyGeminiError(error));
  }
  return { text: interpretResponse(response), usage: response.usage ?? NO_USAGE };
}

export function generateExplanationText(
  transport: ProviderTransport,
  target: { readonly id: "gemini" | "groq"; readonly model: string },
  settings: AiSettings,
  grounding: { readonly json: string; readonly allowedIds: readonly string[] },
  call: CallLimits = {},
): Promise<GenerationOutput> {
  return generateText(
    transport,
    target,
    settings,
    {
      systemInstruction: SYSTEM_INSTRUCTION,
      userPrompt: buildUserPrompt(grounding.json),
      responseJsonSchema: buildResponseJsonSchema(grounding.allowedIds),
    },
    call,
  );
}
