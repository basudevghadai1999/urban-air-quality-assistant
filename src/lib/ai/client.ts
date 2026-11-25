import "server-only";

import { GoogleGenAI } from "@google/genai";

/**
 * The only module that touches the Gemini SDK (`@google/genai` 3.6.1, `ai.models.generateContent`).
 *
 * Server-side only: `server-only` makes the build fail if a Client Component imports it, so the
 * API key cannot reach the browser. The key is passed explicitly and never logged or returned.
 *
 * SDK behaviours handled deliberately (verified in the installed package):
 *  - Retries: the SDK can retry with exponential backoff, and its default attempt count is 5 when
 *    retry options are supplied. We pin `attempts: 1`, so exactly one request is ever made per
 *    call; whether to try again is the cost policy's decision, and the answer is no.
 *  - Timeouts and cancellation: `httpOptions.timeout` bounds each attempt, and the SDK also aborts the request
 *    and its body read when `abortSignal` fires (verified in the installed package). That signal carries the
 *    timeout (a second guard) and, for a caller that can leave, the caller's own signal. The SDK aborts with a
 *    plain AbortError either way, so a caller tells "I cancelled" from "it timed out" by its own signal.
 *  - Errors: the SDK's `ApiError` message can embed the provider's response text. Callers classify
 *    by status only (`classifyGeminiError`) and discard the message.
 *  - Structured output: `responseMimeType: "application/json"` with `responseJsonSchema`.
 */

import { callSignal, type ProviderRawResponse, type ProviderRequest, type ProviderTransport, type TokenUsage } from "./provider";

/** Kept for existing imports: the Gemini request and response are the provider-neutral ones. */
export type GeminiRequest = ProviderRequest;
export type GeminiRawResponse = ProviderRawResponse;
export type GeminiTransport = ProviderTransport;

export function createGeminiTransport(apiKey: string): ProviderTransport {
  const ai = new GoogleGenAI({ apiKey });
  return {
    async generate(request) {
      const response = await ai.models.generateContent({
        model: request.model,
        contents: request.userPrompt,
        config: {
          systemInstruction: request.systemInstruction,
          responseMimeType: "application/json",
          responseJsonSchema: request.responseJsonSchema,
          maxOutputTokens: request.maxOutputTokens,
          temperature: request.temperature,
          candidateCount: 1,
          ...(request.thinkingBudget === null ? {} : { thinkingConfig: { thinkingBudget: request.thinkingBudget } }),
          abortSignal: callSignal(request.timeoutMs, request.signal, 2_000),
          httpOptions: { timeout: request.timeoutMs, retryOptions: { attempts: 1 } },
        },
      });
      const candidate = response.candidates?.[0];
      const u = response.usageMetadata;
      const usage: TokenUsage = {
        inputTokens: typeof u?.promptTokenCount === "number" ? u.promptTokenCount : null,
        outputTokens: typeof u?.candidatesTokenCount === "number" ? u.candidatesTokenCount : null,
        totalTokens: typeof u?.totalTokenCount === "number" ? u.totalTokenCount : null,
      };
      return {
        usage,
        text: response.text ?? null,
        finishReason: candidate?.finishReason === undefined ? null : String(candidate.finishReason),
        blockReason: response.promptFeedback?.blockReason === undefined ? null : String(response.promptFeedback.blockReason),
      };
    },
  };
}
