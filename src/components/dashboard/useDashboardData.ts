"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { CityId } from "@/config/cities";
import type { AiEnvelope } from "@/lib/ai/types";
import type { ProfileId } from "@/lib/engine/types";
import { fetchAir, fetchRecommendations, type AirOutcome, type ApiFailure, type RecommendOutcome } from "@/lib/client/dashboardApi";

/**
 * Loads dashboard data from the existing endpoints.
 *
 *  - Air data depends on the city only. Recommendations depend on city and profile, so switching
 *    profile re-requests recommendations but not air data.
 *  - Every request is tied to the selection that started it: a newer selection aborts the old
 *    request, and a response for an older selection is never shown (state carries its key, and
 *    only a matching key is read). This also removes duplicate requests in React's dev double-run.
 *  - The AI explanation is requested only on an explicit click, once per selection, so browsing
 *    cities and profiles never spends model budget. It resets whenever the selection changes.
 *  - Nothing is cached or invented here: no data means `null`, which the UI shows as loading.
 */

export type AiState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "done"; readonly envelope: AiEnvelope }
  | { readonly status: "error"; readonly failure: ApiFailure };

interface Keyed<T> {
  readonly key: string;
  readonly value: T;
}

export interface DashboardData {
  /** `null` while loading. */
  readonly air: AirOutcome | null;
  /** `null` while loading. */
  readonly recommendations: RecommendOutcome | null;
  readonly ai: AiState;
  readonly refresh: () => void;
  readonly explain: () => void;
}

export function useDashboardData(cityId: CityId, profileId: ProfileId): DashboardData {
  const [airNonce, setAirNonce] = useState(0);
  const [recNonce, setRecNonce] = useState(0);
  const airKey = `${cityId}#${airNonce}`;
  const recKey = `${cityId}|${profileId}#${recNonce}`;
  const selectionKey = `${cityId}|${profileId}`;

  const [airResult, setAirResult] = useState<Keyed<AirOutcome> | null>(null);
  const [recResult, setRecResult] = useState<Keyed<RecommendOutcome> | null>(null);
  const [aiResult, setAiResult] = useState<Keyed<AiState> | null>(null);
  const aiController = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetchAir(cityId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setAirResult({ key: airKey, value });
      })
      .catch(() => undefined); // aborted by a newer selection: nothing to show
    return () => controller.abort();
  }, [cityId, airKey]);

  useEffect(() => {
    const controller = new AbortController();
    fetchRecommendations(cityId, profileId, false, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setRecResult({ key: recKey, value });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [cityId, profileId, recKey]);

  // A new selection abandons any explanation still being fetched for the old one.
  useEffect(() => () => aiController.current?.abort(), [selectionKey]);

  const explain = useCallback(() => {
    aiController.current?.abort();
    const controller = new AbortController();
    aiController.current = controller;
    const key = selectionKey;
    setAiResult({ key, value: { status: "loading" } });
    fetchRecommendations(cityId, profileId, true, controller.signal)
      .then((outcome) => {
        if (controller.signal.aborted) return;
        const envelope = outcome.ok ? outcome.data.ai : (outcome.data?.ai ?? null);
        setAiResult({
          key,
          value:
            envelope !== null
              ? { status: "done", envelope }
              : { status: "error", failure: outcome.ok ? { kind: "server", message: "The explanation could not be loaded.", retryAfterSeconds: null } : outcome.failure },
        });
      })
      .catch(() => undefined);
  }, [cityId, profileId, selectionKey]);

  const refresh = useCallback(() => {
    setAirNonce((n) => n + 1);
    setRecNonce((n) => n + 1);
  }, []);

  return {
    air: airResult !== null && airResult.key === airKey ? airResult.value : null,
    recommendations: recResult !== null && recResult.key === recKey ? recResult.value : null,
    ai: aiResult !== null && aiResult.key === selectionKey ? aiResult.value : { status: "idle" },
    refresh,
    explain,
  };
}
