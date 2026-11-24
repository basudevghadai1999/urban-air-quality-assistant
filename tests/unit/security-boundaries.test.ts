import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * Static guards for the secret-handling rules. They read only files under
 * src/ and never touch .env or any environment value.
 */

const SRC = fileURLToPath(new URL("../../src", import.meta.url));

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return listSourceFiles(full);
    return /\.(ts|tsx|css|mjs)$/.test(name) ? [full] : [];
  });
}

const files = listSourceFiles(SRC).map((path) => ({
  path: relative(SRC, path),
  text: readFileSync(path, "utf8"),
}));

describe("secret boundaries", () => {
  it("scans a non-trivial number of source files", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("never exposes a Gemini variable through a NEXT_PUBLIC_ name", () => {
    const offenders = files
      .filter(({ text }) => /NEXT_PUBLIC_\w*(GEMINI|API_KEY)/i.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it('marks the env module server-only', () => {
    const env = files.find(({ path }) => path === join("lib", "env.ts"));
    expect(env?.text).toMatch(/^import "server-only";/m);
  });

  it("never imports server-only modules from a Client Component", () => {
    const offenders = files
      .filter(({ text }) => /^["']use client["']/m.test(text))
      .filter(({ text }) =>
        /from ["'](@\/lib\/env|@google\/genai|server-only)["']/.test(text),
      )
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });

  it("contains no literal Google API key", () => {
    const offenders = files
      .filter(({ text }) => /AIza[0-9A-Za-z_-]{30,}/.test(text))
      .map(({ path }) => path);
    expect(offenders).toEqual([]);
  });
});
