/**
 * tests/unit/session-stickiness-responses-input-7270.test.ts
 *
 * Regression guard for #7270 — combo session stickiness was a silent no-op for
 * the entire OpenAI Responses API (`/v1/responses`) surface.
 *
 * Root cause: the stickiness key was derived exclusively from `body.messages`,
 * but Responses-API requests carry the turn in `.input` (string or item array)
 * and never populate `.messages`. The key resolved to `null`, stickiness failed
 * open, and every request was re-ordered as if stickiness were disabled.
 *
 * Fix: `extractStickinessMessages(body)` normalizes both wire shapes into the
 * `messages`-shaped array `deriveMessageHash` consumes, and the two combo call
 * sites pass it instead of `body.messages`.
 *
 * Design: fully deterministic — saturation / connection-health are injected via
 * the existing test seams; no network, no DB.
 */

import test from "node:test";
import assert from "node:assert/strict";
import type { HeadroomSaturation } from "../../open-sse/services/combo/headroomRanking.ts";

const mod = await import("../../open-sse/services/combo/sessionStickiness.ts");
const {
  deriveMessageHash,
  extractStickinessMessages,
  applySessionStickiness,
  recordStickyBinding,
  clearAllStickyBindings,
  __setStickinessHeadroomFetcherForTests,
  __setStickinessConnectionFetcherForTests,
  __setStickinessQuotaCheckerForTests,
} = mod;

function makeTarget(
  connectionId: string
): import("../../open-sse/services/combo/types.ts").ResolvedComboTarget {
  return {
    kind: "model",
    stepId: `step-${connectionId}`,
    executionKey: `key-${connectionId}`,
    modelStr: `gpt-4/${connectionId}`,
    provider: "openai",
    providerId: null,
    connectionId,
    weight: 1,
    label: null,
  };
}

function injectSat(sat: HeadroomSaturation | undefined): void {
  __setStickinessHeadroomFetcherForTests(async (_id: string) => sat);
}

test.beforeEach(() => {
  clearAllStickyBindings();
  // Healthy connection: headroom = 1.0, no terminal status, quota not exhausted.
  injectSat({ util5h: 0, util7d: 0 });
  __setStickinessConnectionFetcherForTests(async () => ({
    testStatus: "active",
    rateLimitedUntil: null,
  }));
  __setStickinessQuotaCheckerForTests(() => false);
});

test.after(() => {
  __setStickinessHeadroomFetcherForTests(null);
  __setStickinessConnectionFetcherForTests(null);
  __setStickinessQuotaCheckerForTests(null);
});

// ─── extractStickinessMessages — normalization ───────────────────────────────

test("extractStickinessMessages: Responses API string `.input` → single user turn", () => {
  const normalized = extractStickinessMessages({ input: "Hello from responses" });
  assert.deepEqual(normalized, [{ role: "user", content: "Hello from responses" }]);
  assert.ok(deriveMessageHash(normalized) !== null, "hash derivable from string input");
});

test("extractStickinessMessages: Responses API item-array `.input` → hashable", () => {
  const body = {
    input: [
      { role: "user", content: [{ type: "input_text", text: "First responses turn" }] },
    ],
  };
  const normalized = extractStickinessMessages(body);
  assert.ok(Array.isArray(normalized) && normalized.length === 1);
  const hash = deriveMessageHash(normalized);
  assert.ok(hash !== null, "hash derivable from item-array input");
  assert.match(hash!, /^[a-f0-9]{16}$/);
});

test("extractStickinessMessages: Chat Completions `.messages` still passes through", () => {
  const messages = [{ role: "user", content: "Chat completions turn" }];
  assert.strictEqual(extractStickinessMessages({ messages }), messages);
});

test("extractStickinessMessages: `.messages` wins over `.input` when both present", () => {
  const messages = [{ role: "user", content: "prefer messages" }];
  assert.strictEqual(extractStickinessMessages({ messages, input: "ignored" }), messages);
});

test("extractStickinessMessages: empty / missing shapes → null (fail-open)", () => {
  assert.equal(extractStickinessMessages({}), null);
  assert.equal(extractStickinessMessages({ messages: [], input: "" }), null);
  assert.equal(extractStickinessMessages({ input: [] }), null);
  assert.equal(extractStickinessMessages(null), null);
  assert.equal(extractStickinessMessages(undefined), null);
});

// ─── The bug: Responses-API body must not silently disable stickiness ─────────

test("BUG #7270: raw `body.messages` yields no key for a Responses-API body", () => {
  // This is exactly what the old call sites passed: body.messages === undefined.
  const responsesBody = { input: "Same conversation" };
  assert.equal(
    deriveMessageHash(
      (responsesBody as { messages?: Array<{ role?: string; content?: unknown }> }).messages
    ),
    null,
    "old path resolves to null → stickiness no-ops"
  );
  // The fix path derives a stable key instead.
  assert.ok(
    deriveMessageHash(extractStickinessMessages(responsesBody)) !== null,
    "normalized path resolves to a real key"
  );
});

test("Responses API `.input` conversation pins to one connection across requests", async () => {
  const targets = [makeTarget("conn-A"), makeTarget("conn-B"), makeTarget("conn-C")];
  const responsesBody = { input: "Pin this whole conversation" };

  const hash = deriveMessageHash(extractStickinessMessages(responsesBody))!;
  assert.ok(hash, "hash must be derivable from the Responses-API body");

  // First successful request bound the conversation to conn-B.
  recordStickyBinding(hash, "conn-B");

  // Second request of the same conversation (same `.input`) must stick to conn-B.
  const r1 = await applySessionStickiness(targets, extractStickinessMessages(responsesBody));
  assert.ok(r1.stuck, "should be stuck for the Responses-API conversation");
  assert.equal(r1.targets[0].connectionId, "conn-B");

  // Repeat — still pinned.
  const r2 = await applySessionStickiness(targets, extractStickinessMessages(responsesBody));
  assert.ok(r2.stuck);
  assert.equal(r2.targets[0].connectionId, "conn-B");
});

test("Different Responses API conversations spread across connections", async () => {
  const targets = [makeTarget("conn-A"), makeTarget("conn-B")];

  const convo1 = { input: "conversation one" };
  const convo2 = { input: "conversation two" };

  const h1 = deriveMessageHash(extractStickinessMessages(convo1))!;
  const h2 = deriveMessageHash(extractStickinessMessages(convo2))!;
  assert.notEqual(h1, h2, "distinct conversations must produce distinct keys");

  recordStickyBinding(h1, "conn-A");
  recordStickyBinding(h2, "conn-B");

  const r1 = await applySessionStickiness(targets, extractStickinessMessages(convo1));
  const r2 = await applySessionStickiness(targets, extractStickinessMessages(convo2));

  assert.equal(r1.targets[0].connectionId, "conn-A");
  assert.equal(r2.targets[0].connectionId, "conn-B");
});
