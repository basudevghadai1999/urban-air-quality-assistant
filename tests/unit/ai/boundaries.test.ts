import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Static guards for the Gemini boundaries. Reads only src/. */
const SRC = fileURLToPath(new URL("../../../src", import.meta.url));

function list(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return list(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

const files = list(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }));
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const ai = files.filter((f) => f.path.startsWith("lib/ai/"));
const byPath = (p: string) => files.find((f) => f.path === p);

describe("credential boundaries", () => {
  it("never exposes a Gemini variable through a NEXT_PUBLIC_ name", () => {
    expect(files.filter(({ text }) => /NEXT_PUBLIC_\w*(GEMINI|GOOGLE|AI_)/i.test(text)).map((f) => f.path)).toEqual([]);
  });

  it("reads the Gemini key only in env.ts, through the existing utility", () => {
    const readers = files.filter(({ text }) => /process\.env\.GEMINI|GEMINI_API_KEY|GEMINI_KEY/.test(code(text))).map((f) => f.path);
    expect(readers.filter((p) => p.startsWith("lib/ai/"))).toEqual([]);
    expect(byPath("lib/ai/config.ts")?.text).toMatch(/getGeminiConfig/);
  });

  it("imports the Gemini SDK in exactly one module, which is server-only", () => {
    const importers = files.filter(({ text }) => /from ["']@google\/genai["']/.test(text)).map((f) => f.path);
    expect(importers).toEqual(["lib/ai/client.ts"]);
    expect(byPath("lib/ai/client.ts")?.text).toMatch(/^import "server-only";/m);
  });

  it.each(["lib/ai/client.ts", "lib/ai/config.ts", "lib/ai/generator.ts", "lib/ai/providerBudget.ts", "lib/ai/cache.ts", "lib/ai/service.ts", "lib/ai/defaultAiService.ts"])("marks %s server-only", (path) => {
    expect(byPath(path)?.text, path).toMatch(/^import "server-only";/m);
  });

  it("no Client Component imports an AI server module, the SDK or the env utility", () => {
    const offenders = files
      .filter(({ text }) => /^["']use client["']/m.test(text))
      .filter(({ text }) => /from ["'](@\/lib\/ai\/(client|config|generator|providerBudget|cache|service|defaultAiService)|@google\/genai|@\/lib\/env)/.test(text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});

describe("no leakage through logs or errors", () => {
  it("the AI modules never log the key, prompts or responses", () => {
    for (const { path, text } of ai) {
      expect(code(text), path).not.toMatch(/console\.(log|info|debug|error)/);
      for (const m of code(text).matchAll(/(?:logger|consoleSafeLogger)\.warn\([^;]*?\);/gs)) {
        expect(m[0], path).not.toMatch(/apiKey|prompt|userPrompt|systemInstruction|response|text\b|explanation|contextJson|secret|token/i);
      }
    }
  });

  it("only passes allow-listed metric fields from the AI modules", () => {
    for (const { path, text } of ai) {
      for (const m of code(text).matchAll(/metrics\.increment\("[a-z_]+",\s*\{([^}]*)\}/g)) {
        for (const field of (m[1] ?? "").split(",").map((f) => f.split(":")[0]?.trim() ?? "")) {
          expect(["code", "kind", "layer", "cityId", "status", "operation", "provider", ""], `${path}: ${field}`).toContain(field);
        }
      }
    }
  });

  it("never reads a provider error's message", () => {
    for (const { path, text } of ai) expect(code(text), path).not.toMatch(/error\.message|e\.message|err\.message/);
  });
});

describe("rendering safety", () => {
  it("no component renders HTML from a string", () => {
    expect(files.filter(({ text }) => /dangerouslySetInnerHTML|\binnerHTML\b/.test(code(text))).map((f) => f.path)).toEqual([]);
  });

  it("nothing evaluates or executes model output", () => {
    for (const { path, text } of ai) expect(code(text), path).not.toMatch(/\beval\s*\(|new Function\s*\(|child_process|vm\.run/);
  });
});

describe("the deterministic engine and AQI code are untouched by the AI layer", () => {
  it("the AI layer imports no calculation function and never writes to the result", () => {
    for (const { path, text } of ai) {
      expect(code(text), path).not.toMatch(/calculateAqi|calculateSubIndex|compareExposure|compareEmissions|computeTripEmissions|evaluateOutdoorWindows/);
      expect(code(text), path).not.toMatch(/result\.\w+\s*=[^=]/);
    }
  });

  it("the engine and AQI modules do not import the AI layer or the Gemini SDK", () => {
    for (const { path, text } of files.filter((f) => f.path.startsWith("lib/engine/") || f.path.startsWith("lib/aqi/"))) {
      expect(text, path).not.toMatch(/from ["'](@\/lib\/ai|@google\/genai)/);
    }
  });
});

describe("Redis use", () => {
  it("the AI modules use only GET, SET, DEL and EVAL, and never read Redis variables", () => {
    const commands = new Set(ai.flatMap(({ text }) => [...text.matchAll(/command\(\[\s*"([A-Z]+)"/g)].map((m) => m[1] ?? "")));
    for (const c of commands) expect(["GET", "SET", "DEL", "EVAL"]).toContain(c);
    for (const { path, text } of ai) expect(text, path).not.toMatch(/UPSTASH_REDIS_REST/);
  });
});
