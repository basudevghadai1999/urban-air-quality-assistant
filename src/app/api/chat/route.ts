import { getChatService } from "@/lib/ai/defaultAiService";
import { handleChatRequest } from "@/lib/api/chatHandler";
import { getAirRateLimitGate, getAirService } from "@/lib/data/defaultAirService";

// Never prerendered: the response depends on the request body, the client and live air data.
export const dynamic = "force-dynamic";
// The rate limiter hashes client identifiers with node:crypto.
export const runtime = "nodejs";

/** POST /api/chat  { "cityId": "bengaluru", "profileId": "family_toddlers", "message": "Is it a good time for a walk?", "history": [] } */
export function POST(request: Request): Promise<Response> {
  return handleChatRequest(request, getAirService, () => Date.now(), { getGate: getAirRateLimitGate, getChat: getChatService });
}
