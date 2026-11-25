import type { AiProviderId } from "@/lib/env";

/**
 * Provider-neutral request/response types. Each provider's SDK or HTTP details live in its own
 * module (`client.ts` for Gemini, `groqClient.ts` for Groq); nothing else in the layer knows which
 * wire format is in use. Types only: no secrets and no I/O here.
 */

export type { AiProviderId };

/** Token counts as REPORTED by the provider. A field the provider did not return is null, never estimated. */
export interface TokenUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export const NO_USAGE: TokenUsage = Object.freeze({ inputTokens: null, outputTokens: null, totalTokens: null });

export interface ProviderRequest {
  readonly model: string;
  readonly systemInstruction: string;
  readonly userPrompt: string;
  readonly responseJsonSchema: Record<string, unknown>;
  readonly maxOutputTokens: number;
  readonly temperature: number;
  /** Gemini only. Null: do not send a thinking configuration. */
  readonly thinkingBudget: number | null;
  readonly timeoutMs: number;
  /** Aborts the call when the caller no longer needs the answer. Never aborts shared work. */
  readonly signal?: AbortSignal;
}

/**
 * The signal one provider call runs under: its own timeout (plus `slackMs` for a transport's second guard),
 * and the caller's signal when there is one. Whichever fires first aborts the request and its body read.
 */
export function callSignal(timeoutMs: number, caller?: AbortSignal, slackMs = 0): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs + slackMs);
  return caller === undefined ? timeout : AbortSignal.any([timeout, caller]);
}

export interface ProviderRawResponse {
  readonly text: string | null;
  readonly finishReason: string | null;
  readonly blockReason: string | null;
  readonly usage?: TokenUsage;
}

/** The seam the generator depends on; tests substitute a fake, so no test touches the network. */
export interface ProviderTransport {
  generate(request: ProviderRequest): Promise<ProviderRawResponse>;
}

/** A provider that is configured and may be called. `apiKey` is non-enumerable on real configs. */
export interface ProviderTarget {
  readonly id: AiProviderId;
  readonly model: string;
  readonly apiKey: string;
}
