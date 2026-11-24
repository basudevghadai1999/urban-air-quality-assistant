import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** Static guards over the dashboard source: what must never appear in code that ships to the browser. */

const dirs = ["src/components/dashboard", "src/lib/client"];
const files = dirs.flatMap((d) => readdirSync(d).map((f) => ({ path: join(d, f), text: readFileSync(join(d, f), "utf8") })));
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("dashboard source safety", () => {
  it("finds the dashboard files", () => expect(files.length).toBeGreaterThan(10));

  it("never injects HTML", () => {
    for (const f of files) expect(code(f.text), f.path).not.toMatch(/dangerouslySetInnerHTML|innerHTML|insertAdjacentHTML|document\.write|eval\(/);
  });

  it("never touches secrets, environment variables or server-only modules", () => {
    for (const f of files) {
      const c = code(f.text);
      expect(c, f.path).not.toMatch(/process\.env|GEMINI_|GROQ_|API_KEY|Authorization/);
      expect(c, f.path).not.toMatch(/from "server-only"|@google\/genai|@\/lib\/env"|@\/lib\/redis|@\/lib\/ratelimit|@\/lib\/data\/(airService|defaultAirService)/);
    }
  });

  it("imports server handlers and AI modules as types only", () => {
    for (const f of files) {
      for (const m of f.text.matchAll(/^import\s+(?!type\b)[^;]*from "(@\/lib\/(?:api|ai\/(?:service|client|generator|defaultAiService|groqClient)))[^"]*";/gm)) {
        throw new Error(`${f.path} value-imports ${m[1]}`);
      }
    }
  });

  it("does not compute an AQI, an exposure or an emission", () => {
    for (const f of files) expect(code(f.text), f.path).not.toMatch(/calculateAqi|computeTripEmissions|compareExposure|inhaledMassUg|generateRecommendations|buildGroundingContext/);
  });

  it("does not store anything in the browser", () => {
    for (const f of files) expect(code(f.text), f.path).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
  });

  it("uses design tokens, not hard-coded colours", () => {
    for (const f of files) expect(code(f.text), f.path).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  });
});
