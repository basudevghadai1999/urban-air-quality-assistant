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
