import { Badge, type BadgeTone } from "@/components/ui/Badge";
import type { AiReasonCode } from "@/lib/ai/errors";
import type { AiEnvelope, AiProviderName } from "@/lib/ai/types";
import type { RecommendationCard } from "./recommendationView";

import { ErrorPanel, Section, Skeleton } from "./DataStates";
import type { AiState } from "./useDashboardData";

const PROVIDER_LABEL: Readonly<Record<AiProviderName, string>> = { gemini: "Gemini", groq: "Groq", deterministic: "Built-in rules" };

const ATTEMPT_TEXT: Partial<Readonly<Record<AiReasonCode, string>>> = {
  AI_TIMEOUT: "took too long",
  AI_QUOTA: "was busy or over its quota",
  AI_AUTH_FAILED: "rejected this server's credentials",
  AI_MODEL_UNAVAILABLE: "model not available",
  AI_UPSTREAM_ERROR: "had a problem",
  AI_NETWORK: "could not be reached",
  AI_EMPTY_RESPONSE: "returned nothing",
  AI_TRUNCATED: "was cut short",
  AI_INVALID_JSON: "returned malformed output",
  AI_SCHEMA_INVALID: "returned the wrong structure",
  AI_VALIDATION_REJECTED: "output failed safety checks",
  AI_BUDGET_EXHAUSTED: "daily allowance used",
};

/** What kind of explanation this is, in words. Rendering below treats every string as plain text. */
export function describeEnvelope(env: AiEnvelope): { title: string; tone: BadgeTone } {
  const who = PROVIDER_LABEL[env.provider];
  switch (env.status) {
    case "generated":
      return { title: `Written by ${who}${env.model === null ? "" : ` (${env.model})`}`, tone: "info" };
    case "cached":
      return { title: `Reused from an earlier ${who} explanation`, tone: "info" };
    case "fallback":
      return { title: "Standard explanation from built-in rules (AI not used)", tone: "warning" };
    case "unavailable":
      return { title: "No explanation available", tone: "warning" };
  }
}

function Prose({ title, text }: { title: string; text: string }) {
  return (
    <div>
      <h4 className="text-sm font-semibold">{title}</h4>
      <p className="mt-1 whitespace-pre-line text-sm">{text}</p>
    </div>
  );
}

function Explanation({ env, cards }: { env: AiEnvelope; cards: readonly RecommendationCard[] }) {
  const e = env.explanation;
  const { title, tone } = describeEnvelope(env);
  const titles = new Map(cards.map((c) => [c.id, c.title]));
  const showReason = env.status === "fallback" || env.status === "unavailable";
  return (
    <div className="space-y-4" data-testid="ai-result">
      <div className="space-y-2">
        <Badge tone={tone}>{title}</Badge>
        {showReason ? <p className="text-sm" data-testid="ai-reason">{env.message}</p> : null}
        {env.retryAfterSeconds === undefined ? null : <p className="text-sm text-ink-muted">You can try again in about {env.retryAfterSeconds} seconds.</p>}
        {(env.attempts ?? []).length === 0 ? null : (
          <ul className="text-sm text-ink-muted" aria-label="Providers tried first">
            {(env.attempts ?? []).map((a) => (
              <li key={`${a.provider}-${a.reasonCode}`}>{PROVIDER_LABEL[a.provider]} {ATTEMPT_TEXT[a.reasonCode] ?? "could not be used"}.</li>
            ))}
          </ul>
        )}
        <p className="text-xs text-ink-muted">All numbers and times on this page come from the deterministic engine, never from the AI.</p>
      </div>

      {e === null ? null : (
        <div className="space-y-4">
          <p className="whitespace-pre-line text-base font-semibold">{e.overview}</p>
          <div className="grid gap-4 md:grid-cols-2">
            <Prose title="Today's situation" text={e.situationExplanation} />
            <Prose title="For this profile" text={e.personalizedSummary} />
          </div>
          <div>
            <h4 className="text-sm font-semibold">Top actions</h4>
            <ol className="mt-1 list-decimal space-y-2 pl-5 text-sm">
              {e.topActions.map((a) => (
                <li key={a.recommendationId}>
                  {titles.has(a.recommendationId) ? <span className="block font-semibold">{titles.get(a.recommendationId)}</span> : null}
                  <span className="whitespace-pre-line">{a.explanation} {a.practicalGuidance}</span>
                </li>
              ))}
            </ol>
          </div>
          <details className="rounded-xl border border-line p-3">
            <summary className="cursor-pointer font-semibold">More detail</summary>
            <div className="mt-3 space-y-3">
              <Prose title="Daily routine" text={e.routineExplanation} />
              <Prose title="Outdoor activity" text={e.outdoorActivityExplanation} />
              <Prose title="Indoor air" text={e.indoorAirExplanation} />
              <Prose title="Transport" text={e.transportExplanation} />
              <Prose title="Estimated impact" text={e.impactExplanation} />
              <div>
                <h4 className="text-sm font-semibold">Data limitations</h4>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                  {e.dataLimitations.map((l, i) => <li key={i}>{l}</li>)}
                </ul>
              </div>
            </div>
          </details>
          <p className="text-sm text-ink-muted">{e.safetyDisclaimer}</p>
        </div>
      )}
    </div>
  );
}

/** Plain-text AI explanation with its source. Requested on click so browsing never spends model quota. */
export function AiExplanationPanel({ state, canExplain, onExplain, cards }: { state: AiState; canExplain: boolean; onExplain: () => void; cards: readonly RecommendationCard[] }) {
  return (
    <Section id="ai" title="Plain-language explanation" highlight>
      {state.status === "idle" ? (
        <div className="space-y-3">
          <p className="max-w-3xl text-ink-muted">Ask for a short written explanation of the recommendations on this page. It is written by an AI model from the engine&apos;s results and checked before it is shown. If no model is available, a standard explanation from built-in rules is shown instead.</p>
          <button type="button" onClick={onExplain} disabled={!canExplain} className="min-h-11 rounded-lg bg-brand px-5 font-semibold text-on-brand disabled:opacity-60">
            Explain with AI
          </button>
        </div>
      ) : state.status === "loading" ? (
        <Skeleton label="Generating the explanation" lines={5} />
      ) : state.status === "error" ? (
        <ErrorPanel title="The explanation could not be loaded" failure={state.failure} onRetry={onExplain} />
      ) : (
        <Explanation env={state.envelope} cards={cards} />
      )}
    </Section>
  );
}
