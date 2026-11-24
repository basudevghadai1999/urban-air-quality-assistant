import { z } from "zod";

import { CITY_IDS } from "@/config/cities";
import { PROFILE_IDS } from "@/lib/engine/types";

import { CHAT_LIMITS } from "./chatTypes";

/**
 * Strict schemas for the chat. The request is the only place free text from a user enters the system,
 * so it is the most tightly bounded: one question of at most `messageMax` characters, whitespace
 * collapsed, control and bidirectional-override characters refused, and at most `historyMax` earlier
 * messages. No other field exists, and unknown keys are refused.
 */

const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩﻿]/;

const bounded = (max: number) =>
  z
    .string()
    .refine((s) => !CONTROL.test(s), "control characters are not allowed")
    .transform((s) => s.replace(/\s+/g, " ").trim())
    .pipe(z.string().min(1, "must not be empty").max(max, `must be at most ${max} characters`));

const turnSchema = z.strictObject({
  role: z.enum(["user", "assistant"]),
  text: bounded(CHAT_LIMITS.historyTextMax),
});

export const chatRequestSchema = z.strictObject({
  cityId: z.enum(CITY_IDS),
  profileId: z.enum(PROFILE_IDS),
  message: bounded(CHAT_LIMITS.messageMax),
  history: z.array(turnSchema).max(CHAT_LIMITS.historyMax).optional(),
});

export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** What the model must return. */
export const chatAnswerSchema = z.strictObject({
  answer: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(CHAT_LIMITS.answerMax)),
});

export function parseChatAnswer(candidate: unknown): { ok: true; answer: string } | { ok: false } {
  const parsed = chatAnswerSchema.safeParse(candidate);
  return parsed.success ? { ok: true, answer: parsed.data.answer } : { ok: false };
}

/** JSON Schema sent to the provider (the same keyword subset the explanation schema uses). */
export function buildChatResponseJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["answer"],
    propertyOrdering: ["answer"],
    properties: {
      answer: {
        type: "string",
        description: `The reply: at most four short plain-text sentences, using only facts from the context (at most ${CHAT_LIMITS.answerMax} characters).`,
      },
    },
  };
}
