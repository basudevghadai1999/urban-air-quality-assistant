import { describe, expect, it } from "vitest";

import { GET } from "@/app/api/health/route";

describe("GET /api/health", () => {
  it("reports liveness without exposing configuration", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body: unknown = await response.json();
    expect(body).toEqual({
      status: "ok",
      app: "Urban Air Intelligence",
      phase: "Phase 2A",
    });
  });

  it("does not mention keys or secrets", async () => {
    const text = JSON.stringify(await GET().json()).toLowerCase();
    expect(text).not.toContain("gemini");
    expect(text).not.toContain("key");
  });
});
