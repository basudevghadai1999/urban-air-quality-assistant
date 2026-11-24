import { handleAirRequest } from "@/lib/api/airHandler";
import { getAirRateLimitGate, getAirService } from "@/lib/data/defaultAirService";

// Never prerendered: the response depends on the query, the client and live provider data.
export const dynamic = "force-dynamic";
// The rate limiter hashes client identifiers with node:crypto.
export const runtime = "nodejs";

/** GET /api/air?cityId=bengaluru */
export function GET(request: Request): Promise<Response> {
  return handleAirRequest(request, getAirService, () => Date.now(), { getGate: getAirRateLimitGate });
}
