"use client";

import { useMemo, useState } from "react";

import { ChatAssistant } from "@/components/chat/ChatAssistant";
import { StatusBanner } from "@/components/ui/StatusBanner";
import { getCityById, type CityId } from "@/config/cities";
import { listProfileOptions } from "@/config/profiles";
import type { ProfileId } from "@/lib/engine/types";
import type { RecommendationResult } from "@/lib/engine";

import { AiExplanationPanel } from "./AiExplanation";
import { AirOverview } from "./AirOverview";
import { Attribution } from "./Attribution";
import { ControlsHeader } from "./ControlsHeader";
import { ErrorPanel } from "./DataStates";
import { airDataOf } from "./FreshnessIndicator";
import { ImpactEstimates } from "./ImpactEstimates";
import { OutdoorWindows } from "./OutdoorWindows";
import { ProfileSelector } from "./ProfileSelector";
import { Recommendations } from "./Recommendations";
import { buildRecommendationCards } from "./recommendationView";
import { formatAge } from "./format";
import { useDashboardData } from "./useDashboardData";

export const DEFAULT_CITY: CityId = "bengaluru";
export const DEFAULT_PROFILE: ProfileId = "family_toddlers";

/** The dashboard: selectors on top, then the plain-language explanation, air quality, outdoor windows, recommendations and impact, with a floating question-and-answer assistant. */
export function Dashboard() {
  const [cityId, setCityId] = useState<CityId>(DEFAULT_CITY);
  const [profileId, setProfileId] = useState<ProfileId>(DEFAULT_PROFILE);
  const { air, airReceivedAt, recommendations, ai, refresh, explain } = useDashboardData(cityId, profileId);

  const airData = airDataOf(air);
  const result: RecommendationResult | null = recommendations === null ? null : (recommendations.data?.result ?? null);
  const cards = useMemo(() => (result === null || result.status !== "ok" ? [] : buildRecommendationCards(result)), [result]);

  const contextLabel = `${getCityById(cityId)?.displayName ?? cityId} · ${listProfileOptions().find((o) => o.id === profileId)?.label ?? profileId}`;

  const airLoading = air === null;
  const recLoading = recommendations === null;
  const stale = airData?.freshnessStatus === "stale";
  const age = airData === null ? null : formatAge(airData.ageSeconds);

  return (
    <div className="space-y-8">
      <ControlsHeader cityId={cityId} onCityChange={setCityId} air={air} airReceivedAt={airReceivedAt} />
      <ProfileSelector profileId={profileId} onProfileChange={setProfileId} />

      {stale ? (
        <StatusBanner title="Showing an earlier reading">
          The air quality service could not be refreshed, so this is the last reading received{age === null ? "" : ` (${age})`}. It may no longer match current conditions, and only forecast hours still ahead are used.
        </StatusBanner>
      ) : null}
      {air !== null && !air.ok ? <ErrorPanel title={air.failure.kind === "unavailable" ? "Air quality data is unavailable" : "Air quality data could not be loaded"} failure={air.failure} onRetry={refresh} /> : null}
      {recommendations !== null && !recommendations.ok && recommendations.failure.kind !== "unavailable" ? (
        <ErrorPanel title="Recommendations could not be loaded" failure={recommendations.failure} onRetry={refresh} />
      ) : null}

      <AiExplanationPanel state={ai} canExplain={!recLoading} onExplain={explain} cards={cards} />

      <div className="grid items-start gap-6 lg:grid-cols-2">
        <AirOverview air={airData} loading={airLoading} />
        <OutdoorWindows result={result} loading={recLoading} />
      </div>

      <Recommendations key={`${cityId}|${profileId}`} result={result} loading={recLoading} />

      <ImpactEstimates result={result} loading={recLoading} />

      <Attribution air={airData} />

      <ChatAssistant cityId={cityId} profileId={profileId} contextLabel={contextLabel} ready={!recLoading} />
    </div>
  );
}
