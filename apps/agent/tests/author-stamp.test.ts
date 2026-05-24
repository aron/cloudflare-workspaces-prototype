/**
 * Pure-function tests for stampAuthor — the bit of glue that turns an
 * unauthenticated `cf_agent_use_chat_request` payload into messages that
 * carry the correct human author metadata before they hit `persistMessages`.
 *
 * Multiple humans can share an Agent thread (each on their own WebSocket
 * connection). The connection knows who's on the other end; the chat
 * payload arriving over that connection doesn't. We stamp the gap.
 */
import { describe, it, expect } from "vitest";
import {
  stampAuthor,
  extractAuthorFromUpgradeRequest,
  stampChatFrame,
  type ChatAuthor,
} from "../src/author-stamp.js";
import { asUser, ARON as ARON_USER, BEA as BEA_USER } from "./identity.js";
import { readIdentity } from "../src/identity.js";

const ARON: ChatAuthor = { kind: "user", id: ARON_USER.userId, email: ARON_USER.email, name: ARON_USER.name };
const BEA:  ChatAuthor = { kind: "user", id: BEA_USER.userId,  email: BEA_USER.email,  name: BEA_USER.name  };

describe("stampAuthor", () => {
  it("stamps user messages that have no author with the connection's author", () => {
    const messages = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "hello" }] },
    ];
    const stamped = stampAuthor(messages, ARON);
    expect(stamped[0]?.metadata).toEqual({
      author:    ARON,
      createdAt: expect.any(Number),
    });
  });

  it("preserves an existing author (idempotent on re-stamps)", () => {
    const messages = [
      { id: "m1", role: "user",
        parts: [{ type: "text", text: "hi" }],
        metadata: { author: BEA, createdAt: 12345 } },
    ];
    const stamped = stampAuthor(messages, ARON);
    expect(stamped[0]?.metadata?.author).toEqual(BEA);
    expect(stamped[0]?.metadata?.createdAt).toBe(12345);
  });

  it("does not stamp assistant messages", () => {
    const messages = [
      { id: "m1", role: "assistant", parts: [{ type: "text", text: "..." }] },
    ];
    const stamped = stampAuthor(messages, ARON);
    expect(stamped[0]?.metadata).toBeUndefined();
  });

  it("returns a new array — never mutates the input", () => {
    const messages = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "x" }] },
    ];
    const stamped = stampAuthor(messages, ARON);
    expect(stamped).not.toBe(messages);
    expect(stamped[0]).not.toBe(messages[0]);
    expect(messages[0]).not.toHaveProperty("metadata");
  });

  it("preserves other metadata fields when stamping", () => {
    const messages = [
      { id: "m1", role: "user",
        parts: [{ type: "text", text: "x" }],
        metadata: { threadId: "t-1" } },
    ];
    const stamped = stampAuthor(messages, ARON);
    expect(stamped[0]?.metadata).toEqual({
      author:    ARON,
      createdAt: expect.any(Number),
      threadId:  "t-1",
    });
  });

  it("handles an empty list", () => {
    expect(stampAuthor([], ARON)).toEqual([]);
  });
});

// ---- extractAuthorFromUpgradeRequest ----



describe("extractAuthorFromUpgradeRequest", () => {
  it("reads worker-attached identity headers into a ChatAuthor", () => {
    const req = asUser("https://agent/ws", ARON_USER, { headers: { upgrade: "websocket" } });
    expect(extractAuthorFromUpgradeRequest(req, readIdentity)).toEqual({
      kind:  "user",
      id:    ARON.id,
      email: ARON.email,
      name:  ARON.name,
    });
  });

  it("returns null when identity headers are missing", () => {
    const req = new Request("https://agent/ws", { headers: { upgrade: "websocket" } });
    expect(extractAuthorFromUpgradeRequest(req, readIdentity)).toBeNull();
  });
});

// ---- stampChatFrame ----

function chatFrame(messages: Array<{ id?: string; role: string; parts: unknown[]; metadata?: Record<string, unknown> }>) {
  return JSON.stringify({
    type: "cf_agent_use_chat_request",
    id:   "req-1",
    init: { method: "POST", body: JSON.stringify({ messages }) },
  });
}

describe("stampChatFrame", () => {
  it("stamps every user message inside a cf_agent_use_chat_request", () => {
    const raw  = chatFrame([{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }]);
    const out  = stampChatFrame(raw, { kind: "user", id: ARON.id, email: ARON.email, name: ARON.name });
    const data = JSON.parse(out) as { init: { body: string } };
    const body = JSON.parse(data.init.body) as { messages: Array<{ metadata: { author: { name: string } } }> };
    expect(body.messages[0]?.metadata.author.name).toBe(ARON.name);
  });

  it("is a no-op when author is null", () => {
    const raw = chatFrame([{ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }]);
    expect(stampChatFrame(raw, null)).toBe(raw);
  });

  it("passes non-chat frames through unchanged", () => {
    const raw = JSON.stringify({ type: "cf_agent_state", state: {} });
    expect(stampChatFrame(raw, { kind: "user", id: "x", email: "x", name: "x" })).toBe(raw);
  });

  it("passes malformed JSON through unchanged", () => {
    const raw = "not-json{";
    expect(stampChatFrame(raw, { kind: "user", id: "x", email: "x", name: "x" })).toBe(raw);
  });

  it("preserves existing author metadata on a message (idempotent)", () => {
    const existing = { kind: "user" as const, id: BEA.id, email: BEA.email, name: BEA.name };
    const raw  = chatFrame([{ id: "m1", role: "user",
      parts: [{ type: "text", text: "x" }],
      metadata: { author: existing } }]);
    const out  = stampChatFrame(raw, { kind: "user", id: ARON.id, email: ARON.email, name: ARON.name });
    const body = JSON.parse(JSON.parse(out).init.body) as { messages: Array<{ metadata: { author: { name: string } } }> };
    expect(body.messages[0]?.metadata.author.name).toBe(BEA.name);
  });
});
