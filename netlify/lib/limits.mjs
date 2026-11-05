// Durable fixed-window counters and short locks, using ETag compare-and-set on
// Netlify Blobs so separate function instances can't race past a limit.
import { randomBytes } from "node:crypto";

const MAX_TRIES = 25;
const backoff = (i) => new Promise((r) => setTimeout(r, Math.floor(Math.random() * (10 + i * 15))));

async function cas(store, key, update) {
  for (let i = 0; i < MAX_TRIES; i++) {
    const cur = await store.getWithMetadata(key, { type: "json" });
    const decision = update(cur ? cur.data : null);
    if (!decision.write) return decision.result;
    const res = cur
      ? await store.setJSON(key, decision.value, { onlyIfMatch: cur.etag })
      : await store.setJSON(key, decision.value, { onlyIfNew: true });
    if (res && res.modified) return decision.result;
    await backoff(i);
  }
  throw new Error("store_contention");
}

// Reserves one unit. Returns { ok: true } or { ok: false, retryAfter }.
export function hit(store, key, limit, windowMs, now = Date.now()) {
  return cas(store, key, (rec) => {
    let r = rec && typeof rec.count === "number" && rec.reset > now ? rec : { count: 0, reset: now + windowMs };
    if (r.count >= limit) {
      return { write: false, result: { ok: false, retryAfter: Math.max(1, Math.ceil((r.reset - now) / 1000)) } };
    }
    return { write: true, value: { count: r.count + 1, reset: r.reset }, result: { ok: true } };
  });
}

// Returns an ownership token when acquired, or null when another holder's
// lock has not expired yet.
export function acquireLock(store, key, ttlMs, now = Date.now()) {
  const owner = randomBytes(16).toString("base64url");
  return cas(store, key, (rec) => {
    if (rec && rec.until > now) return { write: false, result: null };
    return { write: true, value: { until: now + ttlMs, owner }, result: owner };
  });
}

// Releases only if this caller still owns the lock. Blobs has no conditional
// delete, so the release is a compare-and-set to an already-expired record;
// a lock that expired and was taken over by someone else is left untouched.
export async function releaseLock(store, key, owner) {
  if (!owner) return false;
  try {
    return await cas(store, key, (rec) => {
      if (!rec || rec.owner !== owner) return { write: false, result: false };
      return { write: true, value: { until: 0, owner: null }, result: true };
    });
  } catch { return false; /* expires on its own */ }
}
