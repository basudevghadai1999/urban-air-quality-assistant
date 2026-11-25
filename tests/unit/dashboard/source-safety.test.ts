import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/** Static guards over the dashboard source: what must never appear in code that ships to the browser. */

const dirs = ["src/components/dashboard", "src/lib/client"];
const files = dirs.flatMap((d) => readdirSync(d).map((f) => ({ path: join(d, f), text: readFileSync(join(d, f), "utf8") })));

/**
 * What the browser code must never do: compute. Any mention of a calculation function is a violation.
 * The `inhaledMassUg` result field may only appear as a schema declaration (`inhaledMassUg: z.…`); any other
 * use (arithmetic, an assignment, a read) is a violation.
 */
const FORBIDDEN_CALCULATIONS = /calculateAqi|computeTripEmissions|compareExposure|generateRecommendations|buildGroundingContext/g;
const INHALED_MASS_OUTSIDE_SCHEMA = /inhaledMassUg(?!\s*:\s*z\.)/g;
const calculationViolations = (text: string): string[] => [...(text.match(FORBIDDEN_CALCULATIONS) ?? []), ...(text.match(INHALED_MASS_OUTSIDE_SCHEMA) ?? [])];

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
    for (const f of files) expect(calculationViolations(code(f.text)), f.path).toEqual([]);
  });

  describe("the calculation guard", () => {
    it("allows a schema to declare a result field, in every file alike", () => {
      expect(calculationViolations("const s = z.looseObject({ inhaledMassUg: z.number(), n: 1 });")).toEqual([]);
      expect(calculationViolations("inhaledMassUg:z.number().nullable()")).toEqual([]);
    });

    it.each([
      ["a call to the AQI calculator", "const aqi = calculateAqi(input);"],
      ["an import of the AQI calculator", 'import { calculateAqi } from "@/lib/aqi";'],
      ["an emission calculation", "const t = computeTripEmissions(trip);"],
      ["an exposure comparison", "compareExposure(a, b)"],
      ["the recommendation engine", "const r = generateRecommendations(air, profile);"],
      ["the grounding builder", "buildGroundingContext(result, air)"],
      ["arithmetic on an inhaled mass", "const m = inhaledMassUg * 2;"],
      ["a field filled by a calculation", "const out = { inhaledMassUg: concentration * rate * hours };"],
      ["a field that merely starts like a schema", "const out = { inhaledMassUg: zeta(3) };"],
      ["a read of an inhaled mass", "show(result.inhaledMassUg)"],
    ])("still catches %s", (_name, snippet) => {
      expect(calculationViolations(snippet)).not.toEqual([]);
    });

    it("cannot be dodged with a comment-only change: code inside comments is ignored, code outside is not", () => {
      expect(calculationViolations(code("// calculateAqi(x)\n/* inhaledMassUg * 2 */"))).toEqual([]);
      expect(calculationViolations(code("// note\nconst a = calculateAqi(x);"))).not.toEqual([]);
    });
  });

  it("does not store anything in the browser", () => {
    for (const f of files) expect(code(f.text), f.path).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
  });

  it("uses design tokens, not hard-coded colours", () => {
    for (const f of files) expect(code(f.text), f.path).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(/);
  });
});
