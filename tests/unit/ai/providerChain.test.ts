import { describe, expect, it } from "vitest";

import { createAiCache } from "@/lib/ai/cache";
import { AI_REASON_CODES } from "@/lib/ai/errors";
import { createChatService } from "@/lib/ai/chatService";
import { MIN_ATTEMPT_MS, chainDeadlineMs, runProviderChain, type ProviderTry } from "@/lib/ai/providerChain";
import { MemoryProviderBudget, type ProviderBudget } from "@/lib/ai/providerBudget";
import { createExplanationService } from "@/lib/ai/service";
import type { RejectionReason } from "@/lib/ai/validator";
import { createAirMetrics } from "@/lib/observability/metrics";

import { FAKE_API_KEY, allowGate, compliantExplanation, fakeTransport, modelText, providerTarget, readyConfig, resultFor } from "../../fixtures/ai";
import { NOW } from "../../fixtures/engine";

/** The provider order and budget rules shared by explanations and chat. Fakes only: no network, no Redis. */

const metrics = () => createAirMetrics(() => undefined, () => NOW);
const PROVIDERS = [providerTarget("gemini"), providerTarget("groq")] as const;
const transport = fakeTransport(() => Promise.reject(new Error("unused")));

/** A budget that records who was charged, in order. */
function spyBudget(limits = { global: 10, providers: { gemini: 10, groq: 10 } }) {
  const inner = new MemoryProviderBudget(limits, () => NOW);
  const charged: string[] = [];
  const budget: ProviderBudget = {
    reserve: async (p) => {
      const r = await inner.reserve(p);
      if (r.allowed) charged.push(p);
      return r;
    },
  };
  return { budget, charged };
}

function chain(options: {
  budget: ProviderBudget;
  attempt?: (id: string) => ProviderTry<string>;
  getTransport?: Parameters<typeof runProviderChain>[0]["getTransport"];
  isCancelled?: () => boolean;
  timeoutMs?: number;
  now?: () => number;
}) {
  const called: string[] = [];
  const timeouts: number[] = [];
  const m = metrics();
  const failures: string[] = [];
  const run = runProviderChain<string>({
    providers: PROVIDERS,
    timeoutMs: options.timeoutMs ?? 20_000,
    ...(options.now === undefined ? {} : { now: options.now }),
    budget: options.budget,
    metrics: m,
    getTransport: options.getTransport ?? (() => transport),
    onRequest: () => undefined,
    // The services count `ai_provider_failure` here (service.ts recordFailure, chatService.ts); mirrored so the chain is checked end to end.
    onFailure: (p, code) => {
      failures.push(`${p.id}:${code}`);
      m.increment("ai_provider_failure", { provider: p.id, code });
    },
    isCancelled: options.isCancelled,
    attempt: async (p, _transport, call) => {
      called.push(p.id);
      timeouts.push(call.timeoutMs);
      return (options.attempt ?? (() => ({ ok: true, value: "answer" })))(p.id);
    },
  });
  return { run, called, failures, timeouts, m };
}

describe("the provider chain", () => {
  it("calls each provider at most once, in order, and stops at the first answer", async () => {
    const { budget, charged } = spyBudget();
    const c = chain({ budget, attempt: (id) => (id === "gemini" ? { ok: false, code: "AI_UPSTREAM_ERROR" } : { ok: true, value: "from groq" }) });
    expect(await c.run).toMatchObject({ kind: "answered", value: "from groq", provider: { id: "groq" }, attempts: [{ provider: "gemini", reasonCode: "AI_UPSTREAM_ERROR" }] });
    expect(c.called).toEqual(["gemini", "groq"]);
    expect(charged).toEqual(["gemini", "groq"]);
  });

  it("both providers failing ends in a fallback code, with one attempt each and no retry", async () => {
    const { budget, charged } = spyBudget();
    const c = chain({ budget, attempt: () => ({ ok: false, code: "AI_TIMEOUT" }) });
    expect(await c.run).toMatchObject({ kind: "fallback", code: "AI_TIMEOUT", attempts: [{ provider: "gemini" }, { provider: "groq" }] });
    expect(c.called).toEqual(["gemini", "groq"]);
    expect(charged).toEqual(["gemini", "groq"]);
  });

  it("a failure that is not failover-eligible (a safety refusal) never reaches the second provider", async () => {
    const { budget } = spyBudget();
    const c = chain({ budget, attempt: () => ({ ok: false, code: "AI_SAFETY_BLOCKED" }) });
    expect(await c.run).toMatchObject({ kind: "fallback", code: "AI_SAFETY_BLOCKED" });
    expect(c.called).toEqual(["gemini"]);
  });

  it("a transport that cannot be built is charged nothing and does not stop the next provider", async () => {
    const { budget, charged } = spyBudget();
    const c = chain({
      budget,
      getTransport: (p) => {
        if (p.id === "gemini") throw new Error(`constructor failed for ${FAKE_API_KEY}`);
        return transport;
      },
    });
    const out = await c.run;
    expect(out).toMatchObject({ kind: "answered", provider: { id: "groq" }, attempts: [{ provider: "gemini", reasonCode: "AI_INTERNAL" }] });
    expect(c.called).toEqual(["groq"]);
    expect(charged).toEqual(["groq"]);
    // No call was made, so it is not a provider failure and cannot make failures exceed requests.
    expect(c.failures).toEqual([]);
    expect(c.m.snapshot()).toMatchObject({ ai_transport_failure: 1, ai_provider_failure: 0, ai_provider_fallback: 1 });
    expect(JSON.stringify(out)).not.toContain(FAKE_API_KEY);
  });

  it("when no transport can be built the result is a fallback and nothing was charged", async () => {
    const { budget, charged } = spyBudget();
    const c = chain({
      budget,
      getTransport: () => {
        throw new Error("boom");
      },
    });
    expect(await c.run).toMatchObject({ kind: "fallback", code: "AI_INTERNAL", attempts: [{ provider: "gemini" }, { provider: "groq" }] });
    expect(charged).toEqual([]);
    expect(c.called).toEqual([]);
  });

  it("the global cap ends the chain; a provider cap only skips that provider", async () => {
    const globalFull = spyBudget({ global: 1, providers: { gemini: 5, groq: 5 } });
    await globalFull.budget.reserve("gemini");
    const g = chain({ budget: globalFull.budget });
    expect(await g.run).toMatchObject({ kind: "fallback", code: "AI_BUDGET_EXHAUSTED", retryAfterSeconds: expect.any(Number) });
    expect(g.called).toEqual([]);

    const providerFull = spyBudget({ global: 5, providers: { gemini: 0, groq: 5 } });
    const p = chain({ budget: providerFull.budget });
    expect(await p.run).toMatchObject({ kind: "answered", provider: { id: "groq" }, attempts: [{ provider: "gemini", reasonCode: "AI_BUDGET_EXHAUSTED" }] });
    expect(p.called).toEqual(["groq"]);
  });

  it("a budget that cannot decide ends the chain without calling anyone", async () => {
    const c = chain({ budget: { reserve: () => Promise.reject(new Error("redis down")) } });
    expect(await c.run).toMatchObject({ kind: "fallback", code: "AI_PROTECTION_UNAVAILABLE" });
    expect(c.called).toEqual([]);
  });

  it("stops before a LATER provider when nobody is waiting, and charges nothing more", async () => {
    const { budget, charged } = spyBudget();
    let gone = false;
    const c = chain({
      budget,
      isCancelled: () => gone,
      attempt: () => {
        gone = true;
        return { ok: false, code: "AI_UPSTREAM_ERROR" };
      },
    });
    expect(await c.run).toMatchObject({ kind: "fallback", code: "AI_UPSTREAM_ERROR", attempts: [{ provider: "gemini" }] });
    expect(c.called).toEqual(["gemini"]);
    expect(charged).toEqual(["gemini"]);
  });
});

describe("through the services", () => {
  const brokenGemini = (id: string) => {
    if (id === "gemini") throw new Error(`cannot build the client with ${FAKE_API_KEY}`);
  };

  it("explanations: a Gemini client that cannot be built is skipped, Groq answers, and only Groq is charged", async () => {
    const i = resultFor();
    const groq = fakeTransport(() => Promise.resolve(modelText(compliantExplanation(i.result))));
    const { budget, charged } = spyBudget();
    const logs: string[] = [];
    const service = createExplanationService({
      getConfig: () => readyConfig({}, "gem-model", ["gemini", "groq"]),
      getTransport: (p) => {
        brokenGemini(p.id);
        return groq;
      },
      cache: createAiCache({ ttlSeconds: 60, now: () => NOW }),
      budget,
      clientGate: allowGate,
      logger: { warn: (e, f) => logs.push(JSON.stringify({ e, ...f })) },
    });
    const env = await service.explain({ request: new Request("http://localhost/x", { method: "POST" }), ...i });
    expect(env).toMatchObject({ status: "generated", provider: "groq", attempts: [{ provider: "gemini", reasonCode: "AI_INTERNAL" }] });
    expect(charged).toEqual(["groq"]);
    expect(groq.requests).toHaveLength(1);
    expect(JSON.stringify([env, logs])).not.toContain(FAKE_API_KEY);
  });

  it("chat: the same, and the deterministic answer remains when no client can be built", async () => {
    const i = resultFor("family_toddlers");
    const answer = "These suggestions come from modelled Open-Meteo and CAMS data, so use the outdoor activity windows as a guide and not as a guarantee of anything.";
    const groq = fakeTransport(() => Promise.resolve({ text: JSON.stringify({ answer }), finishReason: "STOP", blockReason: null }));
    const { budget, charged } = spyBudget();
    const make = (getTransport: Parameters<typeof createChatService>[0]["getTransport"]) =>
      createChatService({ getConfig: () => readyConfig({}, "m", ["gemini", "groq"]), getTransport, budget, clientGate: allowGate });
    const input = { request: new Request("http://localhost/x", { method: "POST" }), ...i, message: "What does the outdoor window mean?", history: [] };

    expect(await make((p) => (brokenGemini(p.id), groq)).answer(input)).toMatchObject({ status: "generated", provider: "groq", answer });
    expect(charged).toEqual(["groq"]);

    const none = await make(() => {
      throw new Error("no client");
    }).answer(input);
    expect(none).toMatchObject({ status: "fallback", provider: "deterministic", reasonCode: "AI_INTERNAL" });
    expect(none.answer).not.toBeNull();
    expect(charged).toEqual(["groq"]);
  });

  it("chat: a visitor who disconnects after Gemini fails does not cause Groq to be called or charged", async () => {
    const i = resultFor("family_toddlers");
    const controller = new AbortController();
    const gemini = fakeTransport(() => {
      controller.abort();
      return Promise.reject(Object.assign(new Error("RAW"), { status: 503 }));
    });
    const groq = fakeTransport(() => Promise.reject(new Error("must not be called")));
    const { budget, charged } = spyBudget();
    const service = createChatService({
      getConfig: () => readyConfig({}, "m", ["gemini", "groq"]),
      getTransport: (p) => (p.id === "groq" ? groq : gemini),
      budget,
      clientGate: allowGate,
    });
    const env = await service.answer({ request: new Request("http://localhost/x", { method: "POST", signal: controller.signal }), ...i, message: "What does the outdoor window mean?", history: [] });
    expect(env).toMatchObject({ status: "fallback", provider: "deterministic", reasonCode: "AI_UPSTREAM_ERROR" });
    expect(groq.requests).toHaveLength(0);
    expect(charged).toEqual(["gemini"]);
  });

  it("a connected visitor still gets the failover (control for the test above)", async () => {
    const i = resultFor("family_toddlers");
    const answer = "Check the outdoor activity windows on this page: they compare times of the day using the modelled forecast.";
    const gemini = fakeTransport(() => Promise.reject(Object.assign(new Error("RAW"), { status: 503 })));
    const groq = fakeTransport(() => Promise.resolve({ text: JSON.stringify({ answer }), finishReason: "STOP", blockReason: null }));
    const service = createChatService({
      getConfig: () => readyConfig({}, "m", ["gemini", "groq"]),
      getTransport: (p) => (p.id === "groq" ? groq : gemini),
      budget: spyBudget().budget,
      clientGate: allowGate,
    });
    const env = await service.answer({ request: new Request("http://localhost/x", { method: "POST" }), ...i, message: "What does the outdoor window mean?", history: [] });
    expect(env).toMatchObject({ status: "generated", provider: "groq" });
  });
});

describe("the chain deadline", () => {
  it("is two provider timeouts capped at 45 s, and never below one timeout", () => {
    expect(chainDeadlineMs(2_000)).toBe(4_000);
    expect(chainDeadlineMs(20_000)).toBe(40_000); // the default: unchanged from two full attempts
    expect(chainDeadlineMs(22_500)).toBe(45_000);
    expect(chainDeadlineMs(30_000)).toBe(45_000);
    expect(chainDeadlineMs(60_000)).toBe(60_000); // the maximum: was up to 120 s
  });

  it("gives the second provider only the time left, never more than the configured timeout", async () => {
    let t = 0;
    const slow = chain({ budget: spyBudget().budget, timeoutMs: 30_000, now: () => t, attempt: () => ((t += 20_000), { ok: false, code: "AI_UPSTREAM_ERROR" }) });
    await slow.run;
    expect(slow.timeouts).toEqual([30_000, 25_000]); // 45 s deadline - 20 s used

    t = 0;
    const quick = chain({ budget: spyBudget().budget, timeoutMs: 20_000, now: () => t, attempt: () => ((t += 1_000), { ok: false, code: "AI_UPSTREAM_ERROR" }) });
    await quick.run;
    expect(quick.timeouts).toEqual([20_000, 20_000]); // plenty left: the configured timeout, not more
  });

  it("does not start (or charge) the second provider once the deadline has passed, and the answer is the fallback code", async () => {
    let t = 0;
    const { budget, charged } = spyBudget();
    const m = metrics();
    const called: string[] = [];
    const out = await runProviderChain<string>({
      providers: PROVIDERS,
      timeoutMs: 60_000,
      now: () => t,
      budget,
      metrics: m,
      getTransport: () => transport,
      onRequest: () => undefined,
      onFailure: () => undefined,
      attempt: async (p) => {
        called.push(p.id);
        t += 59_000; // Gemini used almost the whole 60 s
        return { ok: false, code: "AI_TIMEOUT" };
      },
    });
    expect(out).toMatchObject({ kind: "fallback", code: "AI_TIMEOUT", attempts: [{ provider: "gemini", reasonCode: "AI_TIMEOUT" }] });
    expect(called).toEqual(["gemini"]);
    expect(charged).toEqual(["gemini"]);
    expect(m.snapshot()).toMatchObject({ ai_deadline_exceeded: 1 });
  });

  it("the threshold is the smallest configurable timeout", async () => {
    let t = 0;
    const just = chain({ budget: spyBudget().budget, timeoutMs: 20_000, now: () => t, attempt: () => ((t += 40_000 - MIN_ATTEMPT_MS), { ok: false, code: "AI_UPSTREAM_ERROR" }) });
    await just.run;
    expect(just.called).toEqual(["gemini", "groq"]);
    expect(just.timeouts[1]).toBe(MIN_ATTEMPT_MS);
    t = 0;
    const over = chain({ budget: spyBudget().budget, timeoutMs: 20_000, now: () => t, attempt: () => ((t += 40_000 - MIN_ATTEMPT_MS + 1), { ok: false, code: "AI_UPSTREAM_ERROR" }) });
    await over.run;
    expect(over.called).toEqual(["gemini"]);
  });

  it("a failure after the caller left is counted as cancelled, not as a provider failure, and goes no further", async () => {
    let gone = false;
    const m = metrics();
    const failures: string[] = [];
    const out = await runProviderChain<string>({
      providers: PROVIDERS,
      timeoutMs: 20_000,
      budget: spyBudget().budget,
      metrics: m,
      getTransport: () => transport,
      isCancelled: () => gone,
      onRequest: () => undefined,
      onFailure: (p, code) => failures.push(`${p.id}:${code}`),
      attempt: async () => {
        gone = true;
        return { ok: false, code: "AI_TIMEOUT" }; // what an aborted request is classified as
      },
    });
    expect(out).toMatchObject({ kind: "fallback", attempts: [{ provider: "gemini" }] });
    expect(failures).toEqual([]);
    expect(m.snapshot()).toMatchObject({ ai_cancelled: 1 });
    expect(m.snapshot()).toMatchObject({ ai_provider_failure: 0 });
  });
});

describe("cancellation reaches the call in flight (chat) but never shared work (explanations)", () => {
  const ask = (signal?: AbortSignal) => ({
    request: new Request("http://localhost/x", { method: "POST", ...(signal === undefined ? {} : { signal }) }),
    ...resultFor("family_toddlers"),
    message: "What does the outdoor window mean?",
    history: [],
  });

  it("chat: the visitor's signal is handed to the active provider call, and leaving aborts it", async () => {
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const slow = fakeTransport((r) => {
      received = r.signal;
      return new Promise((_resolve, reject) => r.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    });
    const other = fakeTransport(() => Promise.reject(new Error("must not be called")));
    const { budget, charged } = spyBudget();
    const m = metrics();
    const service = createChatService({ getConfig: () => readyConfig({}, "m", ["gemini", "groq"]), getTransport: (p) => (p.id === "gemini" ? slow : other), budget, clientGate: allowGate, metrics: m });

    const pending = service.answer(ask(controller.signal));
    await new Promise((r) => setTimeout(r, 5));
    expect(received).toBeInstanceOf(AbortSignal);
    expect(received?.aborted).toBe(false);
    controller.abort();
    const env = await pending;
    expect(received?.aborted).toBe(true);
    expect(env).toMatchObject({ status: "fallback", provider: "deterministic" }); // the deterministic answer is still produced
    expect(env.answer).not.toBeNull();
    expect(other.requests).toHaveLength(0);
    expect(charged).toEqual(["gemini"]);
    expect(m.snapshot()).toMatchObject({ ai_cancelled: 1, ai_provider_failure: 0 });
  });

  it("chat: a real timeout is still a provider failure and still fails over (the caller is connected)", async () => {
    const answer = "Check the outdoor activity windows on this page: they compare times of the day using the modelled forecast.";
    const gemini = fakeTransport(() => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" })));
    const groq = fakeTransport(() => Promise.resolve({ text: JSON.stringify({ answer }), finishReason: "STOP", blockReason: null }));
    const m = metrics();
    const service = createChatService({ getConfig: () => readyConfig({}, "m", ["gemini", "groq"]), getTransport: (p) => (p.id === "groq" ? groq : gemini), budget: spyBudget().budget, clientGate: allowGate, metrics: m });
    expect(await service.answer(ask(new AbortController().signal))).toMatchObject({ status: "generated", provider: "groq" });
    expect(m.snapshot()).toMatchObject({ ai_provider_failure: 1, ai_cancelled: 0 });
  });

  it("explanations: one caller disconnecting does not abort the generation another caller is waiting on", async () => {
    const i = resultFor();
    const leaving = new AbortController();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const gemini = fakeTransport(async () => {
      await gate;
      return modelText(compliantExplanation(i.result));
    });
    const service = createExplanationService({
      getConfig: () => readyConfig({}, "gem-model", ["gemini", "groq"]),
      getTransport: () => gemini,
      cache: createAiCache({ ttlSeconds: 60, now: () => NOW }),
      budget: spyBudget().budget,
      clientGate: allowGate,
    });
    const req = (signal?: AbortSignal) => ({ request: new Request("http://localhost/x", { method: "POST", ...(signal === undefined ? {} : { signal }) }), ...i });
    const first = service.explain(req(leaving.signal));
    await new Promise((r) => setTimeout(r, 5));
    const second = service.explain(req());
    await new Promise((r) => setTimeout(r, 5));
    leaving.abort(); // the first caller goes away mid-flight
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toMatchObject({ status: "generated", provider: "gemini" });
    expect(b).toEqual(a); // the remaining caller gets the same answer
    expect(gemini.requests).toHaveLength(1);
    expect(gemini.requests[0]?.signal).toBeUndefined(); // shared work is never tied to one caller's signal
  });

  it("explanations: when the chain deadline passes before the second provider, the deterministic explanation is returned", async () => {
    const i = resultFor();
    let t = 0;
    const gemini = fakeTransport(() => ((t += 59_000), Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" }))));
    const groq = fakeTransport(() => Promise.reject(new Error("must not be called")));
    const { budget, charged } = spyBudget();
    const service = createExplanationService({
      getConfig: () => readyConfig({ timeoutMs: 60_000 }, "gem-model", ["gemini", "groq"]),
      getTransport: (p) => (p.id === "groq" ? groq : gemini),
      cache: createAiCache({ ttlSeconds: 60, now: () => NOW }),
      budget,
      clientGate: allowGate,
      clock: () => t,
    });
    const env = await service.explain({ request: new Request("http://localhost/x", { method: "POST" }), ...i });
    expect(env).toMatchObject({ status: "fallback", provider: "deterministic", reasonCode: "AI_TIMEOUT", attempts: [{ provider: "gemini", reasonCode: "AI_TIMEOUT" }] });
    expect(env.explanation).not.toBeNull();
    expect(groq.requests).toHaveLength(0);
    expect(charged).toEqual(["gemini"]);
    expect(gemini.requests[0]?.timeoutMs).toBe(60_000);
  });

  it("the second provider is given the time that remains as its timeout", async () => {
    const i = resultFor();
    let t = 0;
    const gemini = fakeTransport(() => ((t += 20_000), Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" }))));
    const groq = fakeTransport(() => Promise.resolve(modelText(compliantExplanation(i.result))));
    const service = createExplanationService({
      getConfig: () => readyConfig({ timeoutMs: 30_000 }, "gem-model", ["gemini", "groq"]),
      getTransport: (p) => (p.id === "groq" ? groq : gemini),
      cache: createAiCache({ ttlSeconds: 60, now: () => NOW }),
      budget: spyBudget().budget,
      clientGate: allowGate,
      clock: () => t,
    });
    await service.explain({ request: new Request("http://localhost/x", { method: "POST" }), ...i });
    expect(gemini.requests[0]?.timeoutMs).toBe(30_000);
    expect(groq.requests[0]?.timeoutMs).toBe(25_000); // 45 s deadline - 20 s used
  });
});

describe("exactly one outcome per provider call", () => {
  it("a budget check that takes time is subtracted from the next provider's timeout", async () => {
    let t = 0;
    const inner = new MemoryProviderBudget({ global: 10, providers: { gemini: 10, groq: 10 } }, () => NOW);
    const slowBudget: ProviderBudget = { reserve: async (p) => ((t += 1_500), inner.reserve(p)) }; // Redis answered after 1.5 s
    const c = chain({ budget: slowBudget, timeoutMs: 30_000, now: () => t, attempt: () => ((t += 20_000), { ok: false, code: "AI_UPSTREAM_ERROR" }) });
    await c.run;
    // 45 s deadline - (1.5 + 20 used by Gemini) - 1.5 for the second reservation = 22 s, not the 23.5 s a stale reading gives.
    expect(c.timeouts).toEqual([30_000, 22_000]);
  });

  it("the first provider keeps its full configured timeout whatever the budget check cost", async () => {
    let t = 0;
    const inner = new MemoryProviderBudget({ global: 10, providers: { gemini: 10, groq: 10 } }, () => NOW);
    const c = chain({ budget: { reserve: async (p) => ((t += 1_500), inner.reserve(p)) }, timeoutMs: 60_000, now: () => t });
    await c.run;
    expect(c.timeouts).toEqual([60_000]);
  });

  it("a later provider that was admitted is never given less than the threshold", async () => {
    let t = 0;
    const inner = new MemoryProviderBudget({ global: 10, providers: { gemini: 10, groq: 10 } }, () => NOW);
    let reserves = 0;
    const budget: ProviderBudget = { reserve: async (p) => ((t += ++reserves === 2 ? 1_900 : 0), inner.reserve(p)) };
    const c = chain({ budget, timeoutMs: 20_000, now: () => t, attempt: () => ((t += 40_000 - 2_500), { ok: false, code: "AI_UPSTREAM_ERROR" }) });
    await c.run;
    expect(c.timeouts[1]).toBe(MIN_ATTEMPT_MS); // 40 s - 37.5 s - 1.9 s = 0.6 s left, floored: bounded overshoot, not a zero-length call
  });

  it("a timeout and a disconnect together are one cancellation, never a timeout as well", async () => {
    const c = chain({ budget: spyBudget().budget, isCancelled: () => true, attempt: () => ({ ok: false, code: "AI_TIMEOUT" }) });
    await c.run;
    expect(c.m.snapshot()).toMatchObject({ ai_cancelled: 1, ai_provider_failure: 0, ai_provider_fallback: 0 });
  });

  it("a failure that has nothing to do with the abort is counted for what it is, even if the caller has left", async () => {
    const c = chain({ budget: spyBudget().budget, isCancelled: () => true, attempt: () => ({ ok: false, code: "AI_VALIDATION_REJECTED", rejection: "unknown_id" }) });
    await c.run;
    expect(c.m.snapshot()).toMatchObject({ ai_cancelled: 0, ai_provider_failure: 1 });
    expect(c.failures).toEqual(["gemini:AI_VALIDATION_REJECTED"]);
    expect(c.called).toEqual(["gemini"]); // and it still goes no further
  });

  const scenarios: [string, (id: string) => ProviderTry<string>, { cancelled?: boolean; budget?: "global" | "provider" | "transport" }][] = [
    ["success", () => ({ ok: true, value: "x" }), {}],
    ["failover to success", (id) => (id === "gemini" ? { ok: false, code: "AI_UPSTREAM_ERROR" } : { ok: true, value: "x" }), {}],
    ["both fail", () => ({ ok: false, code: "AI_QUOTA" }), {}],
    ["safety refusal", () => ({ ok: false, code: "AI_SAFETY_BLOCKED" }), {}],
    ["caller leaves during the call", () => ({ ok: false, code: "AI_TIMEOUT" }), { cancelled: true }],
    ["global cap", () => ({ ok: true, value: "x" }), { budget: "global" }],
    ["provider cap", () => ({ ok: true, value: "x" }), { budget: "provider" }],
    ["transport cannot be built", () => ({ ok: true, value: "x" }), { budget: "transport" }],
  ];
  it.each(scenarios)("%s: requests = successes + failures + cancellations, and refusals or unbuilt clients make no request", async (_name, attempt, o) => {
    const limits = o.budget === "global" ? { global: 0, providers: { gemini: 5, groq: 5 } } : o.budget === "provider" ? { global: 5, providers: { gemini: 0, groq: 5 } } : undefined;
    const c = chain({
      budget: spyBudget(limits).budget,
      isCancelled: o.cancelled === true ? () => true : undefined,
      attempt,
      getTransport: o.budget === "transport" ? () => ((): never => { throw new Error("x"); })() : undefined,
    });
    const out = await c.run;
    const s = c.m.snapshot();
    let successes = 0;
    if (out.kind === "answered") successes = 1;
    const requests = c.called.length;
    expect(requests).toBe(successes + s.ai_provider_failure + s.ai_cancelled);
    if (o.budget === "global" || o.budget === "provider") expect(s.ai_budget_rejection).toBe(1);
    if (o.budget === "transport") expect(requests).toBe(0);
  });
});

/** `RejectionReason` in validator.ts: a closed union, so a rejection kind can never be free text. */
const REJECTION_KINDS: readonly RejectionReason[] = [
  "unknown-recommendation-id", "duplicate-recommendation-id", "invented-id-in-text", "markup-or-link", "control-characters", "unsupported-number", "unit-mismatch",
  "unsupported-time", "medical-claim", "health-outcome-claim", "guarantee", "safety-claim", "indoor-measurement-claim", "official-reading-claim", "missing-pollutant-claim", "credential-leak",
];

describe("metrics through the services: counts reflect real provider calls, labels stay bounded, nothing sensitive", () => {
  const http = (status: number) => () => Promise.reject(Object.assign(new Error("RAW provider text with a prompt"), { status }));
  const timeout = () => Promise.reject(Object.assign(new Error("t"), { name: "TimeoutError" }));
  const ok = (r: ReturnType<typeof resultFor>) => () => Promise.resolve(modelText(compliantExplanation(r.result)));
  const post = () => new Request("http://localhost/x", { method: "POST" });

  function explainer(opts: { gemini: () => Promise<never | ReturnType<typeof modelText>>; groq?: () => Promise<never | ReturnType<typeof modelText>>; budget?: ProviderBudget; config?: ReturnType<typeof readyConfig> }) {
    const lines: string[] = [];
    let clock = 0;
    // Each call is a minute later than the last, so no log line is throttled away and every label is seen.
    const m = createAirMetrics((l) => lines.push(l), () => (clock += 61_000));
    const gemini = fakeTransport(opts.gemini as never);
    const groq = fakeTransport((opts.groq ?? (() => Promise.reject(new Error("unused")))) as never);
    const service = createExplanationService({
      getConfig: () => opts.config ?? readyConfig({}, "gem-model", ["gemini", "groq"]),
      getTransport: (p) => (p.id === "groq" ? groq : gemini),
      cache: createAiCache({ ttlSeconds: 60, now: () => NOW }),
      budget: opts.budget ?? spyBudget().budget,
      clientGate: allowGate,
      metrics: m,
      logger: { warn: (e, f) => lines.push(JSON.stringify({ e, ...f })) },
    });
    return { service, m, lines, gemini, groq };
  }

  it("a cache hit and a joined request make no provider call; only the leader's call is counted", async () => {
    const i = resultFor();
    const h = explainer({ gemini: ok(i) });
    const [a, b] = await Promise.all([h.service.explain({ request: post(), ...i }), h.service.explain({ request: post(), ...i })]);
    expect(b).toEqual(a);
    expect(h.m.snapshot()).toMatchObject({ ai_cache_miss: 2, ai_provider_request: 1, ai_provider_success: 1, gemini_request: 1, ai_cache_hit: 0 });
    await h.service.explain({ request: post(), ...i });
    expect(h.m.snapshot()).toMatchObject({ ai_cache_hit: 1, ai_provider_request: 1, gemini_request: 1 });
    expect(h.gemini.requests).toHaveLength(1);
  });

  it("a budget refusal is counted as a refusal and never as a provider request", async () => {
    const i = resultFor();
    const h = explainer({ gemini: ok(i), budget: spyBudget({ global: 0, providers: { gemini: 5, groq: 5 } }).budget });
    expect(await h.service.explain({ request: post(), ...i })).toMatchObject({ status: "fallback", reasonCode: "AI_BUDGET_EXHAUSTED" });
    expect(h.m.snapshot()).toMatchObject({ ai_budget_rejection: 1, ai_provider_request: 0, ai_provider_failure: 0, ai_fallback: 1 });
    expect(h.gemini.requests).toHaveLength(0);
  });

  it("one fallback per request, and every emitted label comes from a fixed set", async () => {
    const i = resultFor();
    const h = explainer({ gemini: http(503), groq: timeout });
    const env = await h.service.explain({ request: post(), ...i });
    expect(env).toMatchObject({ status: "fallback", reasonCode: "AI_TIMEOUT" });
    expect(h.m.snapshot()).toMatchObject({ ai_provider_request: 2, ai_provider_failure: 2, ai_provider_fallback: 1, ai_fallback: 1, ai_provider_success: 0 });

    // More outcomes, so the label check sees budget refusals, cancellations and bad output as well.
    for (const gemini of [http(429), http(401), http(404), http(400), () => Promise.resolve({ text: "{oops", finishReason: "STOP", blockReason: null }), () => Promise.resolve({ text: "", finishReason: "STOP", blockReason: null })]) {
      const j = resultFor("family_toddlers");
      const x = explainer({ gemini: gemini as never, groq: http(500) });
      await x.service.explain({ request: post(), ...j });
      h.lines.push(...x.lines);
    }
    const invented = explainer({ gemini: () => Promise.resolve(modelText({ ...compliantExplanation(i.result), overview: "The AQI is 612 today." })), groq: http(500) });
    await invented.service.explain({ request: post(), ...i });
    expect(invented.m.snapshot()).toMatchObject({ ai_provider_failure: 2, gemini_validation_rejection: 1 });
    h.lines.push(...invented.lines);
    const refused = explainer({ gemini: ok(i), budget: spyBudget({ global: 5, providers: { gemini: 0, groq: 0 } }).budget });
    await refused.service.explain({ request: post(), ...i });
    h.lines.push(...refused.lines);

    const FIELD_VALUES: Record<string, ReadonlySet<string>> = {
      provider: new Set(["gemini", "groq"]),
      code: new Set(AI_REASON_CODES),
      kind: new Set(["global", "provider", "unknown", "chat", ...REJECTION_KINDS]),
      layer: new Set(["budget", "client-limit"]),
    };
    let checked = 0;
    for (const line of h.lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed.event !== "air.metric") continue;
      for (const [key, value] of Object.entries(parsed)) {
        if (["level", "event", "metric", "count"].includes(key)) continue;
        const allowed = FIELD_VALUES[key];
        expect(allowed, `unexpected label ${key}`).toBeDefined();
        expect(allowed?.has(String(value)), `${key}=${String(value)}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
    const text = h.lines.join("\n");
    expect(text).not.toContain(FAKE_API_KEY);
    expect(text).not.toContain("RAW provider text");
    expect(text).not.toContain("prompt");
  });
});
