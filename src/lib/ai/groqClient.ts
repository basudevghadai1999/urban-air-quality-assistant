import "server-only";

import type { ProviderRawResponse, ProviderRequest, ProviderTransport, TokenUsage } from "./provider";

/**
 * The only module that talks to Groq. Groq exposes an OpenAI-compatible Chat Completions endpoint, so
 * this uses the platform `fetch`: no SDK and no new dependency. (Verified against Groq's docs on
 * 2026-11-24: POST /openai/v1/chat/completions, `response_format: {type: "json_schema", ...}`,
 * `usage.{prompt_tokens, completion_tokens, total_tokens}`.)
 *
 * Server-side only (`server-only`). Deliberate choices:
 *  - ONE request per call: there is no retry loop here or in `fetch`.
 *  - Strict structured output: `json_schema` with `strict: true`, on models Groq documents as
 *    supporting it. The shared Zod schema and validator still run afterwards.
 *  - The key travels only in the Authorization header. No header, URL or body is logged or thrown.
 *  - Errors carry the HTTP status only. The response body is never read on failure, because it can
 *    echo request content; success bodies are size-capped.
 *  - Redirects are refused, so the Authorization header cannot be forwarded to another host.
 */

export const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_RESPONSE_CHARS = 200_000;

/** An HTTP failure from a provider. Carries the status only, never a body or a message from the provider. */
export class ProviderHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Provider returned HTTP ${status}.`);
    this.name = "ProviderHttpError";
    this.status = status;
  }
}

/**
 * Adapt the shared response schema to Groq's strict mode. Strict mode needs every property in
 * `required` and `additionalProperties: false` (the shared schema already satisfies both). Keywords
 * that Groq's docs do not list as supported (`propertyOrdering`, `minItems`, `maxItems`) are removed;
 * the Zod schema enforces them after generation, so nothing is weakened.
 */
export function toGroqStrictSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toGroqStrictSchema);
  if (typeof schema !== "object" || schema === null) return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "propertyOrdering" || key === "minItems" || key === "maxItems") continue;
    out[key] = toGroqStrictSchema(value);
  }
  return out;
}

/** Models documented by Groq as supporting `strict: true`. Others get best-effort schema mode. */
const STRICT_MODELS = /^(?:openai\/gpt-oss-(?:20b|120b)|qwen\/qwen3\.8-27b|meta-models\/muse-spark-open)$/;
/** gpt-oss models spend output tokens on reasoning; keep it low for this paraphrasing task. */
const REASONING_MODELS = /^openai\/gpt-oss-/;

const count = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

export interface GroqTransportOptions {
  readonly fetchImpl?: typeof fetch;
  readonly url?: string;
}

export function createGroqTransport(apiKey: string, options: GroqTransportOptions = {}): ProviderTransport {
  const doFetch = options.fetchImpl ?? fetch;
  const url = options.url ?? GROQ_CHAT_COMPLETIONS_URL;
  return {
    async generate(request: ProviderRequest): Promise<ProviderRawResponse> {
      const body = {
        model: request.model,
        messages: [
          { role: "system", content: request.systemInstruction },
          { role: "user", content: request.userPrompt },
        ],
        temperature: request.temperature,
        max_completion_tokens: request.maxOutputTokens,
        ...(REASONING_MODELS.test(request.model) ? { reasoning_effort: "low" } : {}),
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "air_explanation",
            strict: STRICT_MODELS.test(request.model),
            schema: toGroqStrictSchema(request.responseJsonSchema),
          },
        },
      };
      const response = await doFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(request.timeoutMs),
        redirect: "error",
        cache: "no-store",
      });
      if (!response.ok) throw new ProviderHttpError(response.status);

      const raw = await response.text();
      if (raw.length > MAX_RESPONSE_CHARS) throw new ProviderHttpError(502);
      let payload: {
        choices?: { message?: { content?: unknown }; finish_reason?: unknown }[];
        usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown };
      };
      try {
        payload = JSON.parse(raw) as typeof payload;
      } catch {
        throw new ProviderHttpError(502);
      }
      const first = payload.choices?.[0];
      const usage: TokenUsage = {
        inputTokens: count(payload.usage?.prompt_tokens),
        outputTokens: count(payload.usage?.completion_tokens),
        totalTokens: count(payload.usage?.total_tokens),
      };
      const finish = typeof first?.finish_reason === "string" ? first.finish_reason : null;
      return {
        usage,
        text: typeof first?.message?.content === "string" ? first.message.content : null,
        // "length" is Groq's name for hitting the output limit; "content_filter" is a refusal.
        finishReason: finish === "length" ? "MAX_TOKENS" : finish === "content_filter" ? "SAFETY" : finish,
        blockReason: null,
      };
    },
  };
}
