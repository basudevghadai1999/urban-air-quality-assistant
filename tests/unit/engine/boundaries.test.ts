import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Structural guarantees of the engine, enforced against its source:
 * pure (no network, clock, randomness, environment), no LLM, no Next.js, no `any`,
 * and no duplicate AQI arithmetic.
 */

const ROOT = join(__dirname, "..", "..", "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const engineFiles = readdirSync(join(ROOT, "src/lib/engine")).filter((f) => f.endsWith(".ts"));
const configFiles = ["src/config/profiles.ts", "src/config/emissionFactors.ts", "src/config/advisoryThresholds.ts", "src/config/breathingRates.ts"];
const all = [...engineFiles.map((f) => `src/lib/engine/${f}`), ...configFiles];

/** Source with comments removed, so documentation can mention what the code must not do. */
const code = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("engine purity", () => {
  it.each(all)("%s has no network, clock, randomness or environment access", (path) => {
    const src = code(path);
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/XMLHttpRequest|WebSocket|node:http|node:https|node:net/);
    expect(src).not.toMatch(/Date\.now\s*\(|new Date\(\s*\)/);
    expect(src).not.toMatch(/Math\.random|randomUUID|crypto\./);
    expect(src).not.toMatch(/process\.env|import\.meta\.env/);
    expect(src).not.toMatch(/node:fs|node:child_process/);
  });

  it.each(all)("%s imports no Gemini/LLM SDK, Next.js, React or server-only module", (path) => {
    const imports = [...code(path).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1] ?? "");
    for (const spec of imports) {
      expect(spec).not.toMatch(/genai|gemini|openai|anthropic|langchain|^next($|\/)|^react|server-only/i);
      expect(spec).not.toMatch(/\/env$|defaultAirService|redis|ratelimit|cache\/|observability/);
    }
  });

  it.each(all)("%s uses no `any`", (path) => {
    expect(code(path)).not.toMatch(/:\s*any\b|\bas any\b|<any>|any\[\]/);
  });

  it("the route handler and route are thin: no engine logic, no Gemini", () => {
    for (const path of ["src/app/api/recommend/route.ts", "src/lib/api/recommendHandler.ts"]) {
      const src = code(path);
      expect(src).not.toMatch(/genai|gemini/i);
      expect(src).not.toMatch(/process\.env/);
    }
    expect(read("src/app/api/recommend/route.ts").split("\n").length).toBeLessThan(25);
  });
});

describe("no duplicated AQI logic", () => {
  it("the window engine reuses the CPCB breakpoint code instead of re-implementing it", () => {
    const src = code("src/lib/engine/outdoorWindows.ts");
    expect(src).toMatch(/calculateSubIndex/);
    // No hard-coded CPCB breakpoint numbers (for example the PM2.5 band edges).
    expect(src).not.toMatch(/\b(121|251|351|431|749)\b/);
    expect(src).not.toMatch(/BREAKPOINTS|TABLE_3_11/);
  });

  it("only the AQI module defines CPCB breakpoints", () => {
    for (const path of all) expect(code(path)).not.toMatch(/concentrationLow|indexHigh|TABLE_3_11/);
  });
});

describe("the CPCB engine is untouched by this phase", () => {
  it("the engine exports no AQI calculation of its own", () => {
    for (const path of all) expect(code(path)).not.toMatch(/export function calculate(Aqi|SubIndex)/);
  });
});

describe("environment safety", () => {
  it("the engine reads no secrets and the config files hold none", () => {
    for (const path of all) expect(read(path)).not.toMatch(/AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9]{20,}|GEMINI_API_KEY|UPSTASH_REDIS_REST_TOKEN/);
  });
});
