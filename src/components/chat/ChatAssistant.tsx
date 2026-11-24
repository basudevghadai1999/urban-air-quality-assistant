"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

import { Badge } from "@/components/ui/Badge";
import type { CityId } from "@/config/cities";
import { CHAT_LIMITS, type ChatEnvelope } from "@/lib/ai/chatTypes";
import type { ProfileId } from "@/lib/engine/types";

import { useChat, type ChatMessage } from "./useChat";

const SUGGESTIONS: readonly string[] = [
  "Is it a good time to go for a walk?",
  "How can I keep the air at home cleaner today?",
  "What is the best way to travel today?",
  "Why is the air quality like this?",
];

const PROVIDER_LABEL = { gemini: "Gemini", groq: "Groq", deterministic: "Built-in rules" } as const;

function ChatIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-6 shrink-0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />
    </svg>
  );
}

function sourceLine(chat: ChatEnvelope): string {
  return chat.status === "generated" ? `Answer by ${PROVIDER_LABEL[chat.provider]}` : "Standard answer from built-in rules (AI not used)";
}

function Bubble({ message }: { message: ChatMessage }) {
  if (message.role === "user") {
    return (
      <li className="flex justify-end" data-testid="chat-message" data-role="user">
        <p className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand px-4 py-2 text-on-brand">{message.text}</p>
      </li>
    );
  }
  if (message.kind === "error") {
    return (
      <li className="flex justify-start" data-testid="chat-message" data-role="assistant" data-kind="error">
        <p role="alert" className="max-w-[90%] whitespace-pre-wrap break-words rounded-2xl rounded-bl-md border border-warn-ink bg-warn-bg px-4 py-2 text-sm text-warn-ink">
          {message.text}
        </p>
      </li>
    );
  }
  const { envelope } = message;
  return (
    <li className="flex justify-start" data-testid="chat-message" data-role="assistant" data-kind={envelope.status}>
      <div className="max-w-[90%] space-y-1">
        {/* Plain text only: the answer is a React text node, never HTML. */}
        <p className="whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-surface-muted px-4 py-2 text-ink">{message.text}</p>
        <p className="px-1 text-xs text-ink-muted">{sourceLine(envelope)}</p>
        {envelope.status === "fallback" ? <p className="px-1 text-xs text-ink-muted" data-testid="chat-reason">{envelope.message}</p> : null}
      </div>
    </li>
  );
}

interface Props {
  cityId: CityId;
  profileId: ProfileId;
  /** Words describing what answers are based on, for example "Bengaluru · Family with toddlers". */
  contextLabel: string;
  /** False while the recommendations the answers rely on have not loaded. */
  ready: boolean;
}

/**
 * A floating question-and-answer assistant. Answers come from the server, which builds them from the
 * same deterministic results shown on the page; the assistant cannot change any number on the page.
 */
export function ChatAssistant({ cityId, profileId, contextLabel, ready }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const { messages, pending, send } = useChat(cityId, profileId);
  const launcher = useRef<HTMLButtonElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const log = useRef<HTMLOListElement>(null);
  const headingId = useId();
  const hintId = useId();

  useEffect(() => {
    if (open) field.current?.focus();
  }, [open]);

  useEffect(() => {
    const el = log.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [messages, pending, open]);

  const close = () => {
    setOpen(false);
    launcher.current?.focus();
  };

  const submit = (text: string) => {
    if (send(text)) setDraft("");
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    submit(draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit(draft);
    }
  };

  const remaining = CHAT_LIMITS.messageMax - draft.length;

  return (
    <>
      {open ? (
        <section
          role="dialog"
          aria-modal="false"
          aria-labelledby={headingId}
          data-testid="chat-panel"
          onKeyDown={(e) => {
            if (e.key === "Escape") close();
          }}
          className="fixed inset-x-3 bottom-20 z-40 flex max-h-[min(36rem,calc(100dvh-7rem))] flex-col overflow-hidden rounded-2xl border border-line-strong bg-surface shadow-2xl sm:inset-x-auto sm:right-6 sm:w-[26rem]"
        >
          <header className="flex items-start justify-between gap-3 border-b border-line bg-info-bg px-4 py-3">
            <div className="min-w-0">
              <h2 id={headingId} className="text-base font-semibold text-info-ink">Ask about your air</h2>
              <p className="truncate text-xs text-info-ink">Answers use: {contextLabel}</p>
            </div>
            <button type="button" onClick={close} aria-label="Close the assistant" className="grid min-h-11 min-w-11 place-items-center rounded-lg text-info-ink hover:bg-surface">
              <svg aria-hidden="true" viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </header>

          <ol ref={log} role="log" aria-live="polite" aria-label="Conversation" className="min-h-40 flex-1 space-y-3 overflow-y-auto px-4 py-3 text-sm">
            {messages.length === 0 ? (
              <li className="space-y-3" data-testid="chat-empty">
                <p className="text-ink">Hello! Ask me anything about the air quality and the suggestions on this page. For example:</p>
                <div className="flex flex-col items-start gap-2">
                  {SUGGESTIONS.map((q) => (
                    <button
                      key={q}
                      type="button"
                      disabled={!ready || pending}
                      onClick={() => submit(q)}
                      className="min-h-11 rounded-full border border-line-strong bg-surface px-4 text-left text-sm font-semibold text-ink hover:border-brand disabled:opacity-60"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </li>
            ) : (
              messages.map((m) => <Bubble key={m.id} message={m} />)
            )}
            {pending ? (
              <li className="flex justify-start" data-testid="chat-pending">
                <p role="status" className="rounded-2xl rounded-bl-md bg-surface-muted px-4 py-2 text-ink-muted">Thinking…</p>
              </li>
            ) : null}
          </ol>

          <form onSubmit={onSubmit} className="space-y-2 border-t border-line p-3">
            <label htmlFor={`${headingId}-q`} className="sr-only">Your question</label>
            <textarea
              id={`${headingId}-q`}
              ref={field}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              maxLength={CHAT_LIMITS.messageMax}
              rows={2}
              placeholder="Type your question…"
              aria-describedby={hintId}
              className="w-full resize-none rounded-lg border border-line-strong bg-surface px-3 py-2 text-base text-ink"
            />
            <div className="flex items-center justify-between gap-3">
              <p id={hintId} className="text-xs text-ink-muted">
                {remaining <= 100 ? `${remaining} characters left. ` : ""}Enter to send, Shift+Enter for a new line.
              </p>
              <button
                type="submit"
                disabled={!ready || pending || draft.trim().length === 0}
                className="min-h-11 rounded-lg bg-brand px-5 font-semibold text-on-brand disabled:opacity-60"
              >
                Send
              </button>
            </div>
            <p className="text-xs text-ink-muted">
              <Badge tone="neutral" className="mr-1">AI</Badge>
              General information based on modelled data, not medical advice. Please do not share personal details.
            </p>
          </form>
        </section>
      ) : null}

      <button
        ref={launcher}
        type="button"
        onClick={() => (open ? close() : setOpen(true))}
        aria-expanded={open}
        aria-haspopup="dialog"
        data-testid="chat-launcher"
        className="fixed bottom-5 right-4 z-40 flex min-h-11 items-center gap-2 rounded-full bg-brand px-5 py-3 font-semibold text-on-brand shadow-xl sm:right-6"
      >
        <ChatIcon />
        <span>{open ? "Close assistant" : "Ask a question"}</span>
      </button>
    </>
  );
}
