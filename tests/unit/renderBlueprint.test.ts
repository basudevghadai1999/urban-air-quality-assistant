import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Reads ONLY the committed render.yaml, package.json and .env.example. Never `.env`. */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8");
const yaml = read("render.yaml");
const active = yaml
  .split("\n")
  .filter((l) => !l.trim().startsWith("#"))
  .join("\n");

/** `- key: NAME` entries followed by their `value:` or `sync: false` line. */
const envVars = [...active.matchAll(/- key: ([A-Z0-9_]+)\n\s+(value|sync): ("?)([^\n"]*)\3/g)].map((m) => ({
  key: m[1] ?? "",
  kind: m[2] ?? "",
  value: m[4] ?? "",
}));
const byKey = (key: string) => envVars.find((v) => v.key === key);

describe("render.yaml", () => {
  it("is a free Node web service with the health check and the lockfile's package manager", () => {
    expect(active).toMatch(/type: web/);
    expect(active).toMatch(/runtime: node/);
    expect(active).toMatch(/plan: free/);
    expect(active).toMatch(/healthCheckPath: \/api\/health/);
    expect(active).toMatch(/buildCommand: npm ci --include=dev && NODE_OPTIONS=--max-old-space-size=\d+ npx next build --webpack/);
    expect(active).toMatch(/startCommand: npm start/);
    expect(yaml).not.toMatch(/yarn|pnpm/);
  });

  it("pins a Node 22 version that satisfies package.json engines", () => {
    const version = byKey("NODE_VERSION")?.value ?? "";
    expect(version).toMatch(/^22\.\d+\.\d+$/);
    const engines = (JSON.parse(read("package.json")) as { engines: { node: string } }).engines.node;
    expect(engines).toBe(">=22.22.2 <23");
    const [, minor, patch] = version.split(".").map(Number) as [number, number, number];
    expect(minor > 22 || (minor === 22 && patch >= 2)).toBe(true);
  });

  it("declares every secret as dashboard-supplied (sync: false), with no value in the file", () => {
    for (const name of ["GEMINI_API_KEY", "GROQ_API_KEY", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) {
      expect(byKey(name), name).toEqual({ key: name, kind: "sync", value: "false" });
    }
    // Nothing secret-shaped anywhere, and no NEXT_PUBLIC_ variable at all.
    expect(yaml).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
    expect(yaml).not.toMatch(/gsk_[0-9A-Za-z]{10,}/);
    expect(yaml).not.toMatch(/\.upstash\.io/);
    expect(yaml).not.toMatch(/NEXT_PUBLIC_/);
    const withValues = envVars.filter((v) => v.kind === "value").map((v) => v.key);
    expect(withValues.filter((k) => /KEY|TOKEN|SECRET|PASSWORD|URL/.test(k))).toEqual([]);
  });

  it("enables Render IP trust explicitly and keeps AI budgets conservative", () => {
    expect(byKey("TRUST_RENDER_CF_CONNECTING_IP")).toMatchObject({ kind: "value", value: "true" });
    expect(Number(byKey("AI_DAILY_BUDGET")?.value)).toBeLessThanOrEqual(100);
    expect(Number(byKey("AI_GEMINI_DAILY_BUDGET")?.value)).toBeLessThanOrEqual(Number(byKey("AI_DAILY_BUDGET")?.value));
    expect(Number(byKey("AI_GROQ_DAILY_BUDGET")?.value)).toBeLessThanOrEqual(Number(byKey("AI_DAILY_BUDGET")?.value));
  });

  it("makes no Vercel assumption and every variable it sets is documented in .env.example", () => {
    expect(yaml).not.toMatch(/vercel/i);
    const example = read(".env.example");
    for (const { key } of envVars) {
      if (key === "NODE_VERSION" || key === "NODE_ENV") continue;
      expect(example, key).toContain(key);
    }
  });
});
