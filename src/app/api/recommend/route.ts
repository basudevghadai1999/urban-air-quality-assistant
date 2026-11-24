import { getAiExplanationService } from "@/lib/ai/defaultAiService";
import { handleRecommendRequest } from "@/lib/api/recommendHandler";
import { getAirRateLimitGate, getAirService } from "@/lib/data/defaultAirService";

// Never prerendered: the response depends on the request body, the client and live air data.
export const dynamic = "force-dynamic";
// The rate limiter hashes client identifiers with node:crypto.
export const runtime = "nodejs";

/** POST /api/recommend  { "cityId": "delhi-ncr", "profileId": "family_toddlers", "preferences": { ... }, "explain": true } */
export function POST(request: Request): Promise<Response> {
  return handleRecommendRequest(request, getAirService, () => Date.now(), { getGate: getAirRateLimitGate, getExplainer: getAiExplanationService });
}
