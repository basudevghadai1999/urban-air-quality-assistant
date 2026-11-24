import type { RecommendationResult } from "@/lib/engine";

import { clip, buildFallbackExplanation } from "./fallback";
import { CHAT_LIMITS } from "./chatTypes";
import type { AiExplanation } from "./types";

/**
 * Deterministic chat answers: what the user gets whenever the model is unavailable, over budget, rate
 * limited, slow, or its answer is rejected. The question picks WHICH already-written section of the
 * deterministic explanation to show; no text is written here beyond a short lead-in, so the answer
 * contains no number, time or claim the engine did not produce.
 */

type Topic = "health" | "outdoor" | "indoor" | "transport" | "routine" | "impact" | "data" | "air";

/** First match wins, so the order is the priority: health words beat everything else. */
const TOPICS: readonly (readonly [Topic, RegExp])[] = [
  ["health", /\b(doctor|asthma|symptom|cough|medic\w*|sick|ill|breath\w*|wheez\w*|allerg\w*|lung|heart|pregnan\w*|health)\b/i],
  ["data", /\b(data|source|accura\w*|cpcb|station|model\w*|open-?meteo|cams|trust|reliable|stale|fresh|official)\b/i],
  ["impact", /\b(co2|carbon|emission\w*|exposure|inhal\w*|impact|saving|reduc\w*)\b/i],
  ["transport", /\b(commut\w*|travel|transport|bike|bicycle|cycl\w*|bus|car|auto|metro|train|two-?wheeler|scooter|drive|driving|ride)\b/i],
  ["indoor", /\b(indoor|window|windows|ventilat\w*|purifier|cook\w*|incense|dust|home|house|room|kitchen|mop\w*|fan|ac|air ?con\w*)\b/i],
  ["outdoor", /\b(outdoor|outside|walk\w*|run\w*|jog\w*|exercis\w*|play\w*|sport\w*|yoga|workout|gym|park|morning|evening|afternoon)\b/i],
  ["routine", /\b(routine|schedule|errand\w*|shop\w*|school|when|time|today|tomorrow|plan)\b/i],
  ["air", /\b(aqi|air|pollut\w*|pm\s?2\.?5|pm\s?10|ozone|o3|level|quality|good|bad|why)\b/i],
];

export function topicOf(message: string): Topic | null {
  for (const [topic, re] of TOPICS) if (re.test(message)) return topic;
  return null;
}

function pick(topic: Topic | null, e: AiExplanation): string[] {
  const first = e.topActions[0];
  switch (topic) {
    case "health":
      return [e.safetyDisclaimer];
    case "data":
      return [e.overview, ...e.dataLimitations.slice(0, 2)];
    case "impact":
      return [e.impactExplanation];
    case "transport":
      return [e.transportExplanation];
    case "indoor":
      return [e.indoorAirExplanation];
    case "outdoor":
      return [e.outdoorActivityExplanation, e.routineExplanation];
    case "routine":
      return [e.routineExplanation];
    case "air":
      return [e.overview, e.situationExplanation];
    default:
      return [e.overview, ...(first === undefined ? [] : [first.explanation, first.practicalGuidance])];
  }
}

const LEAD_IN = "The AI assistant is not available for this question, so here is the most relevant part of the calculated guidance.";

export function buildChatFallback(result: RecommendationResult, message: string): string {
  const parts = pick(topicOf(message), buildFallbackExplanation(result)).filter((p) => p.trim().length > 0);
  const body = parts.join(" ");
  const room = CHAT_LIMITS.answerMax - LEAD_IN.length - 1;
  return `${LEAD_IN} ${clip(body, room)}`.trim();
}
