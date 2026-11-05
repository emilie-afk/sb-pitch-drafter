import { test } from "node:test";
import assert from "node:assert/strict";
import { MemStore } from "./helpers.mjs";
import { acquireLock, releaseLock } from "../netlify/lib/limits.mjs";

test("an expired holder cannot release a lock that another request now owns", async () => {
  const store = new MemStore();
  const key = "lock/draft/s1";
  const t0 = 1_000_000;
  const a = await acquireLock(store, key, 1000, t0);           // A acquires
  assert.ok(a);
  assert.equal(await acquireLock(store, key, 1000, t0 + 500), null, "held");
  const b = await acquireLock(store, key, 1000, t0 + 1500);    // A expired; B acquires
  assert.ok(b && b !== a);
  assert.equal(await releaseLock(store, key, a), false);       // A finishes late
  assert.equal(await acquireLock(store, key, 1000, t0 + 1600), null, "C must not acquire while B runs");
  assert.equal(await releaseLock(store, key, b), true);        // B releases its own lock
  assert.ok(await acquireLock(store, key, 1000, t0 + 1700), "free after owner release");
});

test("release without a token or after takeover is a no-op; tokens are unique", async () => {
  const store = new MemStore();
  assert.equal(await releaseLock(store, "k", null), false);
  assert.equal(await releaseLock(store, "missing", "x"), false);
  const tokens = new Set();
  for (let i = 0; i < 20; i++) {
    const t = await acquireLock(store, "k" + i, 1000);
    assert.ok(typeof t === "string" && t.length >= 16);
    tokens.add(t);
  }
  assert.equal(tokens.size, 20);
});
