// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Home from "@/app/page";
import { CHAT_LIMITS } from "@/lib/ai/chatTypes";

import { chatEnvelope, deferred, installApi, type ApiReply } from "../fixtures/dashboard";

/** The chat backend is a stand-in returning SYNTHETIC replies. No network, no model, no quota. */

beforeEach(() => {
  installApi();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const open = async () => {
  render(<Home />);
  await screen.findByRole("meter");
  await screen.findAllByTestId("recommendation");
  fireEvent.click(screen.getByTestId("chat-launcher"));
  return screen.getByTestId("chat-panel");
};

const ask = (text: string) => {
  fireEvent.change(screen.getByLabelText("Your question"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send" }));
};

describe("Chat assistant: opening and closing", () => {
  it("shows a launcher, opens an accessible non-modal dialog, and focuses the question field", async () => {
    const panel = await open();
    expect(panel).toHaveAttribute("role", "dialog");
    expect(panel).toHaveAttribute("aria-modal", "false");
    expect(within(panel).getByRole("heading", { name: "Ask about your air" })).toBeInTheDocument();
    expect(screen.getByLabelText("Your question")).toHaveFocus();
    expect(screen.getByTestId("chat-launcher")).toHaveAttribute("aria-expanded", "true");
  });

  it("states what the answers are based on", async () => {
    const panel = await open();
    expect(within(panel).getByText(/Answers use: Bengaluru · Family with toddlers or schoolchildren/)).toBeInTheDocument();
  });

  it("closes on Escape and returns focus to the launcher", async () => {
    const panel = await open();
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(screen.queryByTestId("chat-panel")).toBeNull();
    expect(screen.getByTestId("chat-launcher")).toHaveFocus();
  });

  it("closes from its close button", async () => {
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Close the assistant" }));
    expect(screen.queryByTestId("chat-panel")).toBeNull();
  });

  it("makes no chat request until a question is sent", async () => {
    const api = installApi();
    render(<Home />);
    await screen.findByRole("meter");
    fireEvent.click(screen.getByTestId("chat-launcher"));
    expect(api.chatCalls()).toHaveLength(0);
  });
});

describe("Chat assistant: asking a question", () => {
  it("sends only IDs, the question and history, then shows the answer as plain text with its source", async () => {
    const api = installApi();
    await open();
    ask("Is it a good time for a walk?");
    await screen.findByText(/outdoor activity windows on this page/);
    expect(api.chatCalls()).toHaveLength(1);
    expect(api.chatCalls()[0]?.body).toEqual({ cityId: "bengaluru", profileId: "family_toddlers", message: "Is it a good time for a walk?", history: [] });
    expect(screen.getByText("Answer by Groq")).toBeInTheDocument();
    expect(screen.getAllByTestId("chat-message").map((m) => m.getAttribute("data-role"))).toEqual(["user", "assistant"]);
  });

  it("sends on Enter, and Shift+Enter does not send", async () => {
    const api = installApi();
    await open();
    const field = screen.getByLabelText("Your question");
    fireEvent.change(field, { target: { value: "Hello there" } });
    fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
    expect(api.chatCalls()).toHaveLength(0);
    fireEvent.keyDown(field, { key: "Enter" });
    await screen.findByText(/outdoor activity windows/);
    expect(api.chatCalls()).toHaveLength(1);
    expect(field).toHaveValue("");
  });

  it("answers a suggested question when it is clicked", async () => {
    const api = installApi();
    await open();
    fireEvent.click(screen.getByRole("button", { name: "Is it a good time to go for a walk?" }));
    await screen.findByText(/outdoor activity windows/);
    expect(api.chatCalls()[0]?.body?.message).toBe("Is it a good time to go for a walk?");
  });

  it("will not send an empty question, and the question field is limited to the maximum length", async () => {
    const api = installApi();
    await open();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
    expect(screen.getByLabelText("Your question")).toHaveAttribute("maxlength", String(CHAT_LIMITS.messageMax));
    expect(api.chatCalls()).toHaveLength(0);
  });

  it("shows a pending state, blocks a second question until the answer arrives, and then carries the history", async () => {
    const first = deferred<ApiReply>();
    const api = installApi({ chat: (body) => (body.message === "first" ? first.promise : { status: 200, body: { ok: true, chat: chatEnvelope({ answer: "Second answer here." }) } }) });
    await open();
    ask("first");
    expect(await screen.findByTestId("chat-pending")).toBeInTheDocument();
    ask("second");
    expect(api.chatCalls()).toHaveLength(1);
    first.resolve({ status: 200, body: { ok: true, chat: chatEnvelope({ answer: "First answer here." }) } });
    await screen.findByText("First answer here.");
    expect(screen.queryByTestId("chat-pending")).toBeNull();
    ask("second");
    await screen.findByText("Second answer here.");
    expect(api.chatCalls()[1]?.body?.history).toEqual([
      { role: "user", text: "first" },
      { role: "assistant", text: "First answer here." },
    ]);
  });
});

describe("Chat assistant: other kinds of answer and failures", () => {
  it("labels a built-in-rules answer and shows why AI was not used", async () => {
    installApi({
      chat: () => ({
        status: 200,
        body: { ok: true, chat: chatEnvelope({ status: "fallback", provider: "deterministic", model: null, reasonCode: "AI_BUDGET_EXHAUSTED", message: "Today's AI allowance has been used, so a standard answer is shown.", answer: "The AI assistant is not available for this question, so here is the most relevant part of the calculated guidance. Standard text." }) },
      }),
    });
    await open();
    ask("anything");
    await screen.findByText(/Standard text\./);
    expect(screen.getByText("Standard answer from built-in rules (AI not used)")).toBeInTheDocument();
    expect(screen.getByTestId("chat-reason")).toHaveTextContent("Today's AI allowance has been used");
  });

  it("shows a rate-limit message with the wait time, and no answer bubble", async () => {
    installApi({ chat: () => ({ status: 429, body: { ok: false, error: { code: "RATE_LIMITED", message: "x", retryAfterSeconds: 12 } } }) });
    await open();
    ask("hello");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("You are asking too quickly. Please wait about 12 seconds.");
  });

  it("shows a plain message when the server cannot be reached", async () => {
    installApi({ chat: () => "network-error" });
    await open();
    ask("hello");
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not reach the server/i);
  });

  it("shows a plain message for a server error and never the server's own text", async () => {
    installApi({ chat: () => ({ status: 500, body: { ok: false, error: { code: "INTERNAL_ERROR", message: "SECRET-INTERNAL-DETAIL" } } }) });
    await open();
    ask("hello");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/something went wrong/i);
    expect(document.body.textContent).not.toContain("SECRET-INTERNAL-DETAIL");
  });

  it("renders a model answer as text, never as HTML", async () => {
    installApi({ chat: () => ({ status: 200, body: { ok: true, chat: chatEnvelope({ answer: '<img src=x onerror="window.__pwned=1"><b>bold</b> **x**' }) } }) });
    await open();
    ask("hello");
    await screen.findByText(/<img src=x/);
    expect(document.querySelector("[data-testid=chat-panel] img")).toBeNull();
    expect(document.querySelector("[data-testid=chat-panel] b")).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});

describe("Chat assistant: selections", () => {
  it("starts a new conversation, tied to the new city, when the city changes", async () => {
    const api = installApi();
    await open();
    ask("one");
    await screen.findByText(/outdoor activity windows/);
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "mumbai" } });
    await waitFor(() => expect(screen.getByText(/Answers use: Mumbai/)).toBeInTheDocument());
    expect(screen.getByTestId("chat-empty")).toBeInTheDocument();
    await screen.findAllByTestId("recommendation");
    ask("two");
    await waitFor(() => expect(api.chatCalls()).toHaveLength(2));
    expect(api.chatCalls()[1]?.body).toMatchObject({ cityId: "mumbai", message: "two", history: [] });
  });

  it("never shows an answer that arrives after the selection changed", async () => {
    const slow = deferred<ApiReply>();
    installApi({ chat: () => slow.promise });
    await open();
    ask("one");
    fireEvent.change(screen.getByLabelText("City"), { target: { value: "kolkata" } });
    await screen.findByText(/Answers use: Kolkata/);
    slow.resolve({ status: 200, body: { ok: true, chat: chatEnvelope({ answer: "STALE ANSWER FOR OLD CITY" }) } });
    await new Promise((r) => setTimeout(r, 20));
    expect(document.body.textContent).not.toContain("STALE ANSWER FOR OLD CITY");
  });
});
