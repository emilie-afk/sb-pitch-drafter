// Durable state lives in Netlify Blobs (built into the site; no new database).
//   security store: login/usage counters, locks, session revocations
//   private store:  the confidential prompt pack (imported by the team)
// If a store is unavailable, callers fail closed (503).
import { getStore } from "@netlify/blobs";

export const SECURITY_STORE = "pitch-drafter-security";
export const PRIVATE_STORE = "pitch-drafter-private";

let factory = (name) => getStore({ name, consistency: "strong" });

// Test hook: replace the store factory with an in-memory implementation.
export function __setStoreFactory(fn) { factory = fn; }

export function openStore(name) { return factory(name); }
