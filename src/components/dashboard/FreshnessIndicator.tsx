import { Badge, type BadgeTone } from "@/components/ui/Badge";
import type { AirOutcome } from "@/lib/client/dashboardApi";
import type { NormalizedAirData } from "@/types/air";

import { formatAge, formatIst } from "./format";

export const airDataOf = (outcome: AirOutcome | null): NormalizedAirData | null => (outcome === null ? null : outcome.data);

/** One badge that says how current the data is, in words (never colour alone), plus the data time. */
export function FreshnessIndicator({ air }: { air: AirOutcome | null }) {
  const data = airDataOf(air);
  let tone: BadgeTone = "neutral";
  let text = "Checking data freshness…";
  let detail: string | null = null;

  if (air !== null) {
    const age = data === null ? null : formatAge(data.ageSeconds);
    if (data === null) {
      tone = "warning";
      text = "Could not load data";
    } else if (data.freshnessStatus === "unavailable") {
      tone = "warning";
      text = "No data available";
    } else if (data.freshnessStatus === "stale") {
      tone = "warning";
      text = `Stale: earlier reading${age === null ? "" : `, fetched ${age}`}`;
    } else {
      tone = "info";
      text = `Fresh${age === null ? "" : `: fetched ${age}`}`;
    }
    const until = data === null ? null : formatIst(data.dataTimestamp);
    detail = until === null ? null : `Modelled data up to ${until}`;
  }

  return (
    <div className="flex flex-col items-start gap-1" data-testid="freshness">
      <Badge tone={tone}>
        <span aria-hidden="true" className="size-2 rounded-full bg-current" />
        <span role="status">{text}</span>
      </Badge>
      {detail === null ? null : <p className="text-xs text-ink-muted">{detail}</p>}
    </div>
  );
}
