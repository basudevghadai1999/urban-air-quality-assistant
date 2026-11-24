import { getAllCities, type CityId } from "@/config/cities";
import { APP_DESCRIPTION, APP_NAME, APP_TAGLINE } from "@/lib/constants";
import type { AirOutcome } from "@/lib/client/dashboardApi";

import { FreshnessIndicator } from "./FreshnessIndicator";

interface Props {
  cityId: CityId;
  onCityChange: (id: CityId) => void;
  air: AirOutcome | null;
  /** When `air` reached the browser (epoch ms), so its age can keep counting. */
  airReceivedAt?: number | null;
}

const CITIES = getAllCities();

/** Product name, purpose, the city selector and the data-freshness indicator. */
export function ControlsHeader({ cityId, onCityChange, air, airReceivedAt = null }: Props) {
  const city = CITIES.find((c) => c.id === cityId);
  return (
    <header className="space-y-6 rounded-3xl border border-line bg-linear-to-br from-info-bg via-surface to-surface p-6 sm:p-10">
      <div className="space-y-3">
        <p className="text-sm font-semibold uppercase tracking-wide text-brand">{APP_NAME}</p>
        <h1 className="text-balance text-4xl font-bold tracking-tight sm:text-5xl">{APP_TAGLINE}</h1>
        <p className="max-w-3xl text-lg text-ink-muted">{APP_DESCRIPTION}</p>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="sm:w-72">
          <label htmlFor="city-select" className="mb-1 block text-sm font-semibold">
            City
          </label>
          <select
            id="city-select"
            value={cityId}
            onChange={(e) => {
              const next = CITIES.find((c) => c.id === e.target.value);
              if (next !== undefined) onCityChange(next.id);
            }}
            aria-describedby="city-note"
            className="min-h-11 w-full rounded-lg border border-line-strong bg-surface px-3 text-base text-ink"
          >
            {CITIES.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </select>
          <p id="city-note" className="mt-1 text-sm text-ink-muted">
            {city === undefined ? "" : city.id === "delhi-ncr" ? "Data is for central Delhi, not the whole NCR." : `${city.state}. Data is for a model grid cell over the city centre.`}
          </p>
        </div>
        <FreshnessIndicator air={air} receivedAt={airReceivedAt} />
      </div>
    </header>
  );
}
