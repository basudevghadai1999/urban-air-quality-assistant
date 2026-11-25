"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { CityId } from "@/config/cities";
import { CHAT_LIMITS, type ChatEnvelope, type ChatTurn } from "@/lib/ai/chatTypes";
import type { ProfileId } from "@/lib/engine/types";
import { fetchChat, type ApiFailure } from "@/lib/client/dashboardApi";

/**
 * Conversation state for the chat assistant.
 *
 *  - The conversation belongs to one city and profile: changing either starts a new one, because every
 *    answer is grounded in that selection. A request still in flight for the old selection is aborted
 *    and its answer is never shown.
 *  - Only the last few turns are sent back with a question, each clipped, and never an error message.
 *  - Nothing is stored: a page reload starts empty, and no conversation leaves the browser except as
 *    the request that is being answered.
 */

export type ChatMessage =
  | { readonly id: number; readonly role: "user"; readonly text: string }
  | { readonly id: number; readonly role: "assistant"; readonly kind: "answer"; readonly text: string; readonly envelope: ChatEnvelope }
  | { readonly id: number; readonly role: "assistant"; readonly kind: "error"; readonly text: string; readonly failure: ApiFailure };

interface Keyed {
  readonly key: string;
  readonly messages: readonly ChatMessage[];
  readonly pending: boolean;
}

export interface ChatState {
  readonly messages: readonly ChatMessage[];
  readonly pending: boolean;
  /** Returns false (and sends nothing) for an empty or over-long question, or while an answer is pending. */
  readonly send: (question: string) => boolean;
}

const clip = (text: string): string => (text.length > CHAT_LIMITS.historyTextMax ? text.slice(0, CHAT_LIMITS.historyTextMax) : text);

function historyFrom(messages: readonly ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const m of messages) {
    if (m.role === "user") turns.push({ role: "user", text: clip(m.text) });
    else if (m.kind === "answer") turns.push({ role: "assistant", text: clip(m.text) });
  }
  return turns.slice(-CHAT_LIMITS.historyMax);
}

const errorText = (failure: ApiFailure): string =>
  failure.kind === "rate-limited"
    ? `You are asking too quickly.${failure.retryAfterSeconds === null ? "" : ` Please wait about ${failure.retryAfterSeconds} seconds.`}`
    : failure.message;

export function useChat(cityId: CityId, profileId: ProfileId): ChatState {
  const selectionKey = `${cityId}|${profileId}`;
  const [state, setState] = useState<Keyed>({ key: selectionKey, messages: [], pending: false });
  const controller = useRef<AbortController | null>(null);
  const nextId = useRef(1);
  const current = state.key === selectionKey ? state : { key: selectionKey, messages: [], pending: false };
  const currentRef = useRef(current);
  useEffect(() => {
    currentRef.current = current;
  });

  // A new selection (or leaving the page) abandons any answer still being fetched for the old one.
  useEffect(() => () => controller.current?.abort(), [selectionKey]);

  const send = useCallback(
    (raw: string): boolean => {
      const question = raw.replace(/\s+/g, " ").trim();
      const before = currentRef.current;
      if (question.length === 0 || question.length > CHAT_LIMITS.messageMax || before.pending) return false;

      const history = historyFrom(before.messages);
      const asked: ChatMessage = { id: nextId.current++, role: "user", text: question };
      const key = selectionKey;
      setState({ key, messages: [...before.messages, asked], pending: true });

      controller.current?.abort();
      const own = new AbortController();
      controller.current = own;
      fetchChat(cityId, profileId, question, history, own.signal)
        .then((outcome) => {
          if (own.signal.aborted) return;
          const reply: ChatMessage = outcome.ok && outcome.chat.answer !== null
            ? { id: nextId.current++, role: "assistant", kind: "answer", text: outcome.chat.answer, envelope: outcome.chat }
            : {
                id: nextId.current++,
                role: "assistant",
                kind: "error",
                failure: outcome.ok ? { kind: "server", message: outcome.chat.message, retryAfterSeconds: outcome.chat.retryAfterSeconds ?? null } : outcome.failure,
                text: outcome.ok ? outcome.chat.message : errorText(outcome.failure),
              };
          setState((s) => (s.key === key ? { key, messages: [...s.messages, reply], pending: false } : s));
        })
        .catch(() => undefined); // aborted by a newer selection: nothing to show
      return true;
    },
    [cityId, profileId, selectionKey],
  );

  return { messages: current.messages, pending: current.pending, send };
}
