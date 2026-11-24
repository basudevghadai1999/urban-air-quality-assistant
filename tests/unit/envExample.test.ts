import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Reads ONLY the committed template and .gitignore: never `.env` or `.env.local`.
 */
const read = (relative: string) => readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), "utf8");
const example = read(".env.example");
const lines = example.split("\n");

/** `NAME=value` assignments, active or commented out. */
const assignments = lines
  .map((line) => /^#?\s*([A-Z][A-Z0-9_]*)=(.*)$/.exec(line))
  .filter((m): m is RegExpExecArray => m !== null)
  .map((m) => ({ name: m[1] ?? "", value: (m[2] ?? "").split("#")[0]?.trim() ?? "" }));

const REQUIRED = [
  "GEMINI_API_KEY",
  "GEMINI_MODEL",
  "AIR_CACHE_TTL_SECONDS",
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
  "AIR_RATE_LIMIT_MAX",
  "AIR_RATE_LIMIT_WINDOW_SECONDS",
  "GROQ_API_KEY",
  "TRUST_RENDER_CF_CONNECTING_IP",
];

describe(".env.example", () => {
  it.each(REQUIRED)("documents %s", (name) => {
    expect(assignments.map((a) => a.name)).toContain(name);
  });

  it("holds placeholders only: every value is blank, so no credential can be committed through it", () => {
    for (const { name, value } of assignments) {
      // Commented tuning examples may show a default (e.g. AIR_MAX_STALE_SECONDS=86400); secrets never may.
      if (/KEY|TOKEN|URL|SECRET/.test(name)) expect(value, name).toBe("");
    }
  });

  it("contains no real-looking secret or endpoint", () => {
    expect(example).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/); // Google API key shape
    expect(example).not.toMatch(/[A-Za-z0-9]{30,}==?/); // long base64-ish token
    expect(example).not.toMatch(/\.upstash\.io/); // no concrete database host
    expect(example).not.toMatch(/Bearer\s+\S+/);
  });

  it("never suggests a NEXT_PUBLIC_ prefix for a secret", () => {
    const publicNames = assignments.filter((a) => a.name.startsWith("NEXT_PUBLIC_"));
    expect(publicNames).toEqual([]);
    expect(example).toMatch(/never give any of them a NEXT_PUBLIC_ prefix/i);
  });

  it("explains the degraded behaviour without Redis", () => {
    expect(example).toMatch(/degraded in production/i);
    expect(example).toMatch(/per instance/i);
  });
});

describe(".gitignore protects environment files", () => {
  const rules = read(".gitignore")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));

  it("ignores .env and .env.local via the .env* rule", () => {
    expect(rules).toContain(".env*");
  });

  it("re-includes only the template, and the re-include comes after the ignore", () => {
    expect(rules).toContain("!.env.example");
    expect(rules.indexOf("!.env.example")).toBeGreaterThan(rules.indexOf(".env*"));
    expect(rules.filter((r) => r.startsWith("!.env"))).toEqual(["!.env.example"]);
  });
});
