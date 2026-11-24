import { Badge } from "@/components/ui/Badge";
import type { RecommendationResult } from "@/lib/engine";
import type { OutdoorWindowAnalysis, PeriodId, UnavailableReason, WindowCandidate } from "@/lib/engine/outdoorWindows";

import { Section, Skeleton } from "./DataStates";
import { CONFIDENCE_LABEL, dayLabel, formatNumber, slotText } from "./format";

const UNAVAILABLE_TEXT: Readonly<Record<UnavailableReason, string>> = {
  "no-forecast": "No forecast is available for this city right now.",
  "no-future-hours": "The forecast has no hours still ahead.",
  "pm25-incomplete": "The forecast is missing PM2.5 values needed to compare times.",
  "no-complete-window": "The forecast does not cover a full window for this activity.",
};

const PERIOD_WORD: Readonly<Record<PeriodId, string>> = { morning: "morning", afternoon: "afternoon", evening: "evening" };


function relative(a: OutdoorWindowAnalysis): string | null {
  const c = a.comparison;
  if (c === null) return null;
  const pct = Math.abs(c.bestVsMedianPercent);
  if (c.bestVsMedianPercent < 0 && pct >= 1) return `About ${formatNumber(pct, 0)}% lower modelled pollution than the typical (median) time on offer, by the engine's pollution indicator.`;
  return "Not meaningfully different from other times on offer.";
}

function Primary({ result }: { result: RecommendationResult }) {
  const slot = (w: WindowCandidate): string => slotText(w, result.generatedAt);
  const id = result.outdoorWindows.primaryActivityId;
  const analysis = id === null ? null : (result.outdoorWindows.analyses[id] ?? null);
  const item = result.routine.items.find((i) => i.id === id);
  if (analysis === null) return <p className="text-ink-muted">No outdoor activity window could be worked out for this profile.</p>;

  if (analysis.status === "unavailable" || analysis.best === null) {
    return (
      <div className="rounded-xl border border-warn-ink bg-warn-bg p-4 text-warn-ink">
        <p className="font-semibold">No window available</p>
        <p className="mt-1 text-sm">{analysis.unavailableReason === null ? "The forecast could not be used." : UNAVAILABLE_TEXT[analysis.unavailableReason]} No time is suggested.</p>
      </div>
    );
  }

  const aboveCeiling = analysis.status === "no-suitable-window";
  return (
    <div className="space-y-3">
      <p className="text-sm text-ink-muted">
        {item === undefined ? "Main outdoor activity" : item.label}, {analysis.durationMinutes} minutes
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-2xl font-bold" data-testid="best-window">{slot(analysis.best)}</p>
        <Badge tone={aboveCeiling || analysis.status === "no-meaningful-difference" ? "warning" : "info"}>{analysis.label}</Badge>
        <Badge>{CONFIDENCE_LABEL[analysis.confidence.level]}</Badge>
      </div>
      {aboveCeiling ? (
        <p className="text-sm font-semibold text-warn-ink">Every time on offer is above the engine&apos;s advisory level for this activity. This is the least-polluted option, not an acceptable one: consider a lighter or indoor alternative.</p>
      ) : null}
      {relative(analysis) === null ? null : <p className="text-sm">{relative(analysis)}</p>}
      {analysis.alternative === null ? null : (
        <p className="text-sm">
          <span className="font-semibold">Next best:</span> {slot(analysis.alternative)}
        </p>
      )}
      {analysis.higherExposure.length === 0 ? null : (
        <p className="text-sm">
          <span className="font-semibold">Relatively higher pollution:</span> {analysis.higherExposure.slice(0, 3).map(slot).join("; ")}
        </p>
      )}
    </div>
  );
}

function Periods({ result }: { result: RecommendationResult }) {
  const { periods, trend } = result.outdoorWindows;
  if (periods.status !== "available") return null;
  const values = periods.periods.map((p) => p.indicator).filter((v): v is number => v !== null);
  const max = Math.max(...values, 1);
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Parts of the day, compared (next time each comes round)</h3>
      <ul className="space-y-2">
        {periods.periods.map((p) => (
          <li key={p.period} className="text-sm">
            <div className="flex flex-col gap-x-3 sm:flex-row sm:flex-wrap sm:justify-between">
              <span className="font-semibold">
                {p.label}
                {p.forecastHours[0] === undefined ? "" : ` (${dayLabel(p.forecastHours[0], result.generatedAt) ?? ""})`}
              </span>
              <span className="text-ink-muted">
                {p.pm25MeanUgM3 === null ? "Not enough forecast hours" : `PM2.5 about ${formatNumber(p.pm25MeanUgM3, 0)} µg/m³`}
                {p.period === periods.lowestPeriod ? " · relatively lowest" : p.period === periods.highestPeriod ? " · relatively highest" : ""}
              </span>
            </div>
            {p.indicator === null ? null : (
              <div aria-hidden="true" className="mt-1 h-2 overflow-hidden rounded-full bg-surface-muted">
                <div className="h-full rounded-full bg-brand" style={{ width: `${Math.max(6, (p.indicator / max) * 100)}%` }} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {trend === "unknown" ? null : <p className="text-sm text-ink-muted">Modelled pollution trend over the next hours: {trend}.</p>}
      {periods.lowestPeriod === null ? null : <p className="sr-only">The {PERIOD_WORD[periods.lowestPeriod]} looks relatively lowest.</p>}
    </div>
  );
}

/** Forecast-based, relatively lower-pollution windows. Never described as safe. */
export function OutdoorWindows({ result, loading }: { result: RecommendationResult | null; loading: boolean }) {
  return (
    <Section id="windows" title="Outdoor activity windows">
      <p className="rounded-xl border border-info-ink bg-info-bg p-3 text-sm text-info-ink">
        These are <strong>comparatively lower-pollution</strong> times from a model forecast. They are <strong>not medically safe</strong> periods, and forecasts get less certain the further ahead they look.
      </p>
      {loading ? (
        <Skeleton label="Loading outdoor windows" lines={4} />
      ) : result === null || result.status === "air-data-unavailable" ? (
        <p className="text-ink-muted">No forecast is available, so no activity windows are shown.</p>
      ) : (
        <div className="space-y-5">
          <Primary result={result} />
          <Periods result={result} />
        </div>
      )}
    </Section>
  );
}
