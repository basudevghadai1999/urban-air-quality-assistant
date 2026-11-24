/**
 * Gemini explanation layer: client-safe exports (types, reason codes, schema, fallback, validator,
 * prompt text). The server-only modules (`client`, `config`, `generator`, `budget`, `cache`,
 * `service`, `defaultAiService`) are imported by path and cannot be bundled into the browser.
 */

export * from "./types";
export type { ProviderRawResponse, ProviderRequest, ProviderTransport, TokenUsage } from "./provider";
export { AI_REASON_CODES, AI_REASON_MESSAGES, AiError, classifyGeminiError, classifyProviderError, isAiError, isFailoverEligible, type AiReasonCode } from "./errors";
export { LIMITS as AI_TEXT_LIMITS, aiExplanationSchema, buildResponseJsonSchema, parseExplanation } from "./schema";
export { PROMPT_VERSION, SYSTEM_INSTRUCTION, buildUserPrompt } from "./prompt";
export { SAFETY_DISCLAIMER, buildFallbackExplanation, clip } from "./fallback";
export { buildGroundingContext, MAX_CONTEXT_BYTES, type GroundingContext, type GroundingResult } from "./context";
export { validateExplanation, validateModelText, type RejectionReason, type ValidationOptions, type ValidationOutcome } from "./validator";
