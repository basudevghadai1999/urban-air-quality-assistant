import { useState } from "react";

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import type { RecommendationResult } from "@/lib/engine";
import type { PriorityTier } from "@/lib/engine/types";

import { Section, Skeleton } from "./DataStates";
import { CONFIDENCE_LABEL, formatNumber } from "./format";
import { buildRecommendationCards, type RecommendationKind } from "./recommendationView";

const TIER: Readonly<Record<PriorityTier, { label: string; tone: BadgeTone }>> = {
  high: { label: "High priority", tone: "warning" },
  recommended: { label: "Recommended", tone: "info" },
  optional: { label: "Optional", tone: "neutral" },
};

const FILTERS: readonly { id: "all" | "routine" | "indoor" | "transport"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "routine", label: "Daily routine" },
  { id: "indoor", label: "Indoor air" },
  { id: "transport", label: "Cleaner transport" },
];

const KIND_LABEL: Readonly<Record<RecommendationKind, string>> = { routine: "Daily routine", "trip-chaining": "Daily routine", indoor: "Indoor air", transport: "Transport" };
const INITIAL_COUNT = 6;

/** Prioritised recommendations, with why each is suggested, from the deterministic engine. */
export function Recommendations({ result, loading }: { result: RecommendationResult | null; loading: boolean }) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [expanded, setExpanded] = useState(false);

  return (
    <Section id="recommendations" title="Personalised recommendations">
      {loading ? (
        <Skeleton label="Loading recommendations" lines={5} />
      ) : result === null ? (
        <p className="text-ink-muted">Recommendations are not available right now.</p>
      ) : result.status === "air-data-unavailable" ? (
        <div className="space-y-2 rounded-xl border border-warn-ink bg-warn-bg p-4 text-warn-ink">
          <p className="font-semibold">Recommendations that depend on air quality are unavailable</p>
          <p className="text-sm">There is no air quality data for this city, so no times, estimates or pollution-based advice are given.</p>
        </div>
      ) : (
        <List result={result} filter={filter} onFilter={setFilter} expanded={expanded} onExpand={() => setExpanded((e) => !e)} />
      )}
    </Section>
  );
}

function List({ result, filter, onFilter, expanded, onExpand }: { result: RecommendationResult; filter: (typeof FILTERS)[number]["id"]; onFilter: (f: (typeof FILTERS)[number]["id"]) => void; expanded: boolean; onExpand: () => void }) {
  const all = buildRecommendationCards(result);
  const matches = all.filter((c) => filter === "all" || (filter === "routine" ? c.kind === "routine" || c.kind === "trip-chaining" : c.kind === filter));
  const shown = expanded ? matches : matches.slice(0, INITIAL_COUNT);

  return (
    <div className="space-y-4">
      <p className="text-sm text-ink-muted">{result.profile.label}. {result.profile.focus}</p>
      <p className="text-sm text-ink-muted">All times are Indian Standard Time (IST). Where a time has already passed today, the suggestion is for tomorrow.</p>
      <div role="group" aria-label="Filter recommendations" className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => onFilter(f.id)}
            className={`min-h-11 rounded-full border px-4 text-sm font-semibold ${filter === f.id ? "border-brand bg-brand text-on-brand" : "border-line-strong bg-surface text-ink"}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {matches.length === 0 ? (
        <p className="text-ink-muted">Nothing in this group for the current data.</p>
      ) : (
        <ol className="space-y-3" aria-label="Recommendations, most important first">
          {shown.map((c) => (
            <li key={c.id} className="rounded-xl border border-line p-4" data-testid="recommendation">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={TIER[c.tier].tone}>{TIER[c.tier].label}</Badge>
                <span className="text-xs font-semibold uppercase tracking-wide text-ink-muted">{KIND_LABEL[c.kind]}</span>
              </div>
              <h3 className="mt-2 text-base font-semibold">{c.title}</h3>
              <p className="mt-1 text-sm"><span className="font-semibold">Why: </span>{c.why}</p>
              {c.steps.length === 0 ? null : (
                <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                  {c.steps.map((s, i) => <li key={i}>{s}</li>)}
                </ul>
              )}
              {c.facts.length === 0 && c.exposureReductionUg === null ? null : (
                <dl className="mt-3 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                  {c.facts.map((f) => (
                    <div key={f.label} className="flex flex-wrap gap-x-2">
                      <dt className="text-ink-muted">{f.label}:</dt>
                      <dd className={f.value.length > 40 ? "" : "font-semibold"}>{f.value}</dd>
                    </div>
                  ))}
                  {c.exposureReductionUg === null ? null : (
                    <div className="flex flex-wrap gap-x-2">
                      <dt className="text-ink-muted">Estimated PM2.5 inhaled avoided:</dt>
                      <dd className="font-semibold">about {formatNumber(c.exposureReductionUg)} µg</dd>
                    </div>
                  )}
                </dl>
              )}
              {c.confidence === null ? null : <p className="mt-2 text-xs text-ink-muted">{CONFIDENCE_LABEL[c.confidence]} in the data behind this</p>}
            </li>
          ))}
        </ol>
      )}

      {matches.length > INITIAL_COUNT ? (
        <button type="button" onClick={onExpand} aria-expanded={expanded} className="min-h-11 rounded-lg border border-line-strong bg-surface px-4 font-semibold">
          {expanded ? "Show fewer" : `Show all ${matches.length}`}
        </button>
      ) : null}
    </div>
  );
}
