import { z } from "zod";

import type { AiExplanation } from "./types";

/**
 * Strict schema for the model's output, in two forms that must agree:
 *
 *  - `aiExplanationSchema` (Zod): the authority. Strict objects reject unknown fields; every string
 *    is non-empty after trimming and length-bounded; list sizes are bounded.
 *  - `buildResponseJsonSchema` (JSON Schema): what Gemini is asked to produce, via the SDK's
 *    `responseJsonSchema`. It uses only keywords the Gemini API documents as supported
 *    (type, properties, required, items, enum, minItems, maxItems, additionalProperties,
 *    description). Length limits are NOT in it (`maxLength` is not documented as supported), so
 *    they are enforced only by Zod, after the fact.
 *
 * The recommendation-ID enum is built per request from the IDs that actually exist, so the model
 * is structurally unable to name an ID that does not. The validator re-checks it regardless.
 */

export const LIMITS = {
  overview: 240,
  paragraph: 420,
  actionExplanation: 260,
  actionGuidance: 240,
  limitation: 200,
  disclaimer: 240,
  topActionsMin: 1,
  topActionsMax: 3,
  limitationsMin: 1,
  limitationsMax: 4,
} as const;

const text = (max: number) =>
  z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1).max(max));

const topActionSchema = z.strictObject({
  recommendationId: z.string().min(1).max(80),
  explanation: text(LIMITS.actionExplanation),
  practicalGuidance: text(LIMITS.actionGuidance),
});

export const aiExplanationSchema = z.strictObject({
  overview: text(LIMITS.overview),
  situationExplanation: text(LIMITS.paragraph),
  personalizedSummary: text(LIMITS.paragraph),
  topActions: z.array(topActionSchema).min(LIMITS.topActionsMin).max(LIMITS.topActionsMax),
  routineExplanation: text(LIMITS.paragraph),
  outdoorActivityExplanation: text(LIMITS.paragraph),
  indoorAirExplanation: text(LIMITS.paragraph),
  transportExplanation: text(LIMITS.paragraph),
  impactExplanation: text(LIMITS.paragraph),
  dataLimitations: z.array(text(LIMITS.limitation)).min(LIMITS.limitationsMin).max(LIMITS.limitationsMax),
  safetyDisclaimer: text(LIMITS.disclaimer),
});

/** Field names in the order the model is asked to produce them. */
export const EXPLANATION_FIELDS = [
  "overview",
  "situationExplanation",
  "personalizedSummary",
  "topActions",
  "routineExplanation",
  "outdoorActivityExplanation",
  "indoorAirExplanation",
  "transportExplanation",
  "impactExplanation",
  "dataLimitations",
  "safetyDisclaimer",
] as const;

export type ParseOutcome =
  | { readonly ok: true; readonly value: AiExplanation }
  | { readonly ok: false };

export function parseExplanation(candidate: unknown): ParseOutcome {
  const parsed = aiExplanationSchema.safeParse(candidate);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false };
}

const str = (description: string) => ({ type: "string", description });

/** JSON Schema for Gemini's `responseJsonSchema`. `allowedIds` become the enum for `recommendationId`. */
export function buildResponseJsonSchema(allowedIds: readonly string[]): Record<string, unknown> {
  const idSchema = allowedIds.length > 0
    ? { type: "string", enum: [...allowedIds], description: "One of the recommendation IDs from the context. Never invent one." }
    : str("A recommendation ID from the context.");
  return {
    type: "object",
    additionalProperties: false,
    required: [...EXPLANATION_FIELDS],
    propertyOrdering: [...EXPLANATION_FIELDS],
    properties: {
      overview: str(`One short sentence on the current situation (at most ${LIMITS.overview} characters).`),
      situationExplanation: str(`Why today's air matters, current versus forecast, without repeating readings (at most ${LIMITS.paragraph} characters).`),
      personalizedSummary: str(`Why these recommendations suit the selected profile (at most ${LIMITS.paragraph} characters).`),
      topActions: {
        type: "array",
        minItems: LIMITS.topActionsMin,
        maxItems: LIMITS.topActionsMax,
        description: `Between ${LIMITS.topActionsMin} and ${LIMITS.topActionsMax} actions (never more than ${LIMITS.topActionsMax}), chosen from the context recommendation IDs, most important first.`,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["recommendationId", "explanation", "practicalGuidance"],
          properties: {
            recommendationId: idSchema,
            explanation: str(`Why this action matters for this household (at most ${LIMITS.actionExplanation} characters).`),
            practicalGuidance: str(`How to carry it out (at most ${LIMITS.actionGuidance} characters).`),
          },
        },
      },
      routineExplanation: str(`Explain the suggested daily routine using only the supplied times (at most ${LIMITS.paragraph} characters).`),
      outdoorActivityExplanation: str(`Explain the forecast-based timing of outdoor activity, using the phrase 'relatively lower-pollution window' and never calling any time safe (at most ${LIMITS.paragraph} characters).`),
      indoorAirExplanation: str(`Explain the indoor air interventions; the app has no indoor sensor unless a reading is supplied (at most ${LIMITS.paragraph} characters).`),
      transportExplanation: str(`Explain the transport comparison using only supplied figures; unavailable figures stay unavailable (at most ${LIMITS.paragraph} characters).`),
      impactExplanation: str(`Explain the exposure and CO2 estimates qualitatively, as estimates, without repeating figures (at most ${LIMITS.paragraph} characters).`),
      dataLimitations: {
        type: "array",
        minItems: LIMITS.limitationsMin,
        maxItems: LIMITS.limitationsMax,
        description: `Between ${LIMITS.limitationsMin} and ${LIMITS.limitationsMax} short items (never more than ${LIMITS.limitationsMax}): honest limits of the data and estimates, from the context.`,
        items: str(`One limitation (at most ${LIMITS.limitation} characters).`),
      },
      safetyDisclaimer: str(`A short note that this is general information, not medical advice (at most ${LIMITS.disclaimer} characters).`),
    },
  };
}
