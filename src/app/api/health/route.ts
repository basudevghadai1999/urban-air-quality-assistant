import { NextResponse } from "next/server";

import { APP_NAME, DEVELOPMENT_PHASE } from "@/lib/constants";

/**
 * Liveness probe. Deliberately reports nothing about configuration: whether a
 * Gemini key is set is not information a public endpoint should reveal.
 */
export function GET(): NextResponse {
  return NextResponse.json(
    { status: "ok", app: APP_NAME, phase: DEVELOPMENT_PHASE },
    { headers: { "Cache-Control": "no-store" } },
  );
}
