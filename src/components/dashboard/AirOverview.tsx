import { Badge } from "@/components/ui/Badge";
import { AQI_CATEGORIES, MAX_AQI, POLLUTANT_INFO, POLLUTANT_IDS, type PollutantId } from "@/lib/aqi";
import type { NormalizedAirData, PollutantUnavailableReason } from "@/types/air";

import { AQI_STYLES, UNIT_LABEL, formatNumber, isCategoryId, pollutantLabel } from "./format";
import { Section, Skeleton } from "./DataStates";

const REASON_TEXT: Readonly<Record<PollutantUnavailableReason, string>> = {
  "not-provided-by-provider": "Not provided by the data source",
  "variable-missing": "Missing from the latest response",
  "unexpected-unit": "Reported in an unexpected unit, so not used",
  "no-valid-data": "No valid values",
  "upstream-unavailable": "Data source unavailable",
};

/** Scale meter: six CPCB bands sized by their AQI range, with a marker at the calculated AQI. */
function AqiScale({ aqi, label }: { aqi: number; label: string }) {
  const position = Math.min(100, Math.max(0, (aqi / MAX_AQI) * 100));
  return (
    <div className="space-y-1">
      <div role="meter" aria-label="Calculated Indian AQI on the 0 to 500 scale" aria-valuemin={0} aria-valuemax={MAX_AQI} aria-valuenow={aqi} aria-valuetext={`AQI ${aqi}, ${label}`} className="relative pt-2">
        <div className="flex h-3 overflow-hidden rounded-full border border-line-strong">
          {AQI_CATEGORIES.map((c) => (
            <div key={c.id} className={AQI_STYLES[c.id].bar} style={{ width: `${((c.max - (c.min === 0 ? 0 : c.min - 1)) / MAX_AQI) * 100}%` }} />
          ))}
        </div>
        <div aria-hidden="true" className="absolute top-0 -translate-x-1/2" style={{ left: `${position}%` }}>
          <div className="mx-auto h-0 w-0 border-x-[6px] border-t-[8px] border-x-transparent border-t-ink" />
        </div>
      </div>
      <div aria-hidden="true" className="flex justify-between text-xs text-ink-muted">
        <span>0</span>
        <span>100</span>
        <span>200</span>
        <span>300</span>
        <span>400</span>
        <span>500</span>
      </div>
    </div>
  );
}

function PollutantTable({ air }: { air: NormalizedAirData }) {
  const availability = new Map(air.pollutantAvailability.map((a) => [a.pollutant, a]));
  const sub = new Map((air.calculatedAqi?.subIndices ?? []).map((s) => [s.pollutant, s]));
  const rows = POLLUTANT_IDS.map((id: PollutantId) => {
    const live = id in (air.currentConditions?.values ?? {}) ? (air.currentConditions?.values as Record<string, number | null | undefined>)[id] : undefined;
    return { id, avail: availability.get(id), latest: typeof live === "number" ? live : null, sub: sub.get(id) };
  });
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">Pollutant concentrations from the air quality model, with the averages used for the calculated AQI</caption>
        <thead>
          <tr className="border-b border-line text-ink-muted">
            <th scope="col" className="py-2 pr-3 font-semibold">Pollutant</th>
            <th scope="col" className="py-2 pr-3 font-semibold">Latest modelled value</th>
            <th scope="col" className="py-2 font-semibold">Average used in AQI (sub-index)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const unit = r.avail?.sourceUnit ?? air.sourceUnits[r.id as keyof typeof air.sourceUnits];
            return (
              <tr key={r.id} className="border-b border-line align-top last:border-0">
                <th scope="row" className="py-2 pr-3 font-semibold">{pollutantLabel(r.id)}</th>
                <td className="py-2 pr-3">
                  {r.latest !== null && unit !== undefined ? (
                    `${formatNumber(r.latest)} ${unit}`
                  ) : (
                    <span className="text-ink-muted">{r.avail?.status === "unavailable" && r.avail.reason !== undefined ? REASON_TEXT[r.avail.reason] : "Unavailable"}</span>
                  )}
                </td>
                <td className="py-2">
                  {r.sub === undefined ? (
                    <span className="text-ink-muted">Not used</span>
                  ) : (
                    `${formatNumber(r.sub.concentration.value)} ${UNIT_LABEL[r.sub.concentration.unit]}, ${r.sub.concentration.averagingHours} h average (${r.sub.index})`
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Current calculated AQI, its CPCB category, pollutant readings with units, and where the data comes from. */
export function AirOverview({ air, loading }: { air: NormalizedAirData | null; loading: boolean }) {
  return (
    <Section id="overview" title="Air quality overview">
      {loading ? (
        <Skeleton label="Loading air quality data" lines={4} />
      ) : air === null ? (
        <p className="text-ink-muted">No air quality reading is available, so none is shown.</p>
      ) : (
        <Overview air={air} />
      )}
    </Section>
  );
}

function Overview({ air }: { air: NormalizedAirData }) {
  const aqi = air.calculatedAqi;
  const valid = aqi !== null && aqi.status === "valid" ? aqi : null;
  const categoryId = valid !== null && isCategoryId(valid.category.id) ? valid.category.id : null;
  const style = categoryId === null ? null : AQI_STYLES[categoryId];
  const dominant = valid === null ? null : POLLUTANT_INFO[valid.dominantPollutant].label;

  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-muted">
        {air.cityName}, {air.state}. <span>{air.dataLocation}</span>
      </p>

      {valid !== null && style !== null ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <p className="text-6xl font-bold leading-none tracking-tight" aria-label={`Calculated AQI ${valid.aqi}`}>
              {valid.aqi}
            </p>
            <Badge className={`${style.badge} text-sm`}>{valid.category.label}</Badge>
            <span className="text-sm text-ink-muted">Estimated Indian AQI (0 to 500)</span>
          </div>
          <AqiScale aqi={valid.aqi} label={valid.category.label} />
          {dominant === null ? null : (
            <p className="text-sm">
              <span className="font-semibold">Main pollutant:</span> {dominant}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-1 rounded-xl border border-warn-ink bg-warn-bg p-4 text-warn-ink">
          <p className="font-semibold">AQI unavailable</p>
          <p className="text-sm">There is not enough valid pollutant data to calculate an AQI for this city right now, so no value is shown.</p>
        </div>
      )}

      <div className="rounded-xl border border-info-ink bg-info-bg p-4 text-info-ink">
        <p className="font-semibold">Modelled estimate, not an official CPCB reading</p>
        <p className="mt-1 text-sm">{air.disclaimer}</p>
      </div>

      {air.currentConditions === null && (aqi?.subIndices.length ?? 0) === 0 ? (
        <p className="text-sm text-ink-muted">No pollutant readings are available right now.</p>
      ) : (
        <PollutantTable air={air} />
      )}
      {air.missingPollutants.length === 0 ? null : (
        <p className="text-sm text-ink-muted">
          Without data, and never counted as zero: {air.missingPollutants.map((p) => pollutantLabel(p)).join(", ")}.
        </p>
      )}
    </div>
  );
}
