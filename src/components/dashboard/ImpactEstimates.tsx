import type { RecommendationResult } from "@/lib/engine";

import { Section, Skeleton } from "./DataStates";
import { formatNumber } from "./format";

const WORD = { reduction: "Reduction", increase: "Increase", "no-change": "No change" } as const;

/** Deterministic exposure and CO2 estimates, always with their units and a reminder that they are estimates. */
export function ImpactEstimates({ result, loading }: { result: RecommendationResult | null; loading: boolean }) {
  return (
    <Section id="impact" title="Estimated impact">
      {loading ? (
        <Skeleton label="Loading impact estimates" lines={3} />
      ) : result === null || result.status === "air-data-unavailable" ? (
        <p className="text-ink-muted">No impact estimates are available without air quality data.</p>
      ) : (
        <Estimates result={result} />
      )}
    </Section>
  );
}

function Estimates({ result }: { result: RecommendationResult }) {
  const exposure = result.exposure.items.filter((i) => i.estimate.status === "available" && i.estimate.difference !== null);
  const co2 = result.emissions.rows.filter((r) => r.status === "available" && r.oneWayGramsCo2 !== null);
  return (
    <div className="space-y-5">
      <p className="rounded-xl border border-info-ink bg-info-bg p-3 text-sm text-info-ink">Model estimates under stated assumptions, not measurements.</p>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">PM2.5 you would inhale (µg)</h3>
        {exposure.length === 0 ? (
          <p className="text-sm text-ink-muted">No PM2.5 exposure estimate is available for this result.</p>
        ) : (
          <ul className="space-y-3">
            {exposure.map((item) => {
              const d = item.estimate.difference;
              if (d === null) return null;
              return (
                <li key={item.id} className="text-sm" data-testid="exposure-item">
                  <p className="font-semibold">{item.title}</p>
                  <p>
                    {WORD[d.direction]} of about {formatNumber(d.magnitudeUg)} µg PM2.5 inhaled
                    {d.percentOfBaseline === null ? "" : ` (${formatNumber(d.percentOfBaseline, 0)}% of the baseline)`}.
                    {item.estimate.bestCase ? " This is a best-case ceiling, not an expected value." : ""}
                  </p>
                  <p className="text-ink-muted">{item.estimate.uncertainty}</p>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Tailpipe CO2 per passenger (g)</h3>
        {co2.length === 0 ? (
          <p className="text-sm text-ink-muted">No CO2 comparison is available.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Tailpipe CO2 by transport mode, grams per passenger, over {result.emissions.distanceKm} km one way</caption>
              <thead>
                <tr className="border-b border-line text-ink-muted">
                  <th scope="col" className="py-2 pr-3 font-semibold">Mode</th>
                  <th scope="col" className="py-2 pr-3 font-semibold">One way (g)</th>
                  <th scope="col" className="py-2 font-semibold">Per week (g)</th>
                </tr>
              </thead>
              <tbody>
                {co2.map((r) => (
                  <tr key={r.mode} className="border-b border-line last:border-0">
                    <th scope="row" className="py-2 pr-3 font-semibold">{r.label}{r.mode === result.emissions.baselineMode ? " (current)" : ""}</th>
                    <td className="py-2 pr-3">{formatNumber(r.oneWayGramsCo2 ?? 0)}</td>
                    <td className="py-2">{r.weeklyGramsCo2 === null ? "n/a" : formatNumber(r.weeklyGramsCo2, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-sm text-ink-muted">
          Distance {formatNumber(result.emissions.distanceKm)} km one way{result.emissions.distanceIsAssumed ? " (an assumed preset value)" : ""}. {result.emissions.note}
        </p>
      </div>
    </div>
  );
}
