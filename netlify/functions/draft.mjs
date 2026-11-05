// POST /api/draft -> one pitch draft. The browser sends structured fields
// only; the prompt is assembled here from the private prompt pack. The
// browser can no longer send an arbitrary prompt to the model.
import { draftLimits, modelConfig } from "../lib/config.mjs";
import { requireSession } from "../lib/guard.mjs";
import { errors, json, log, newRef, onlyKeys, readJson } from "../lib/http.mjs";
import { acquireLock, hit, releaseLock } from "../lib/limits.mjs";
import { callModel, UNTRUSTED_DATA_GUARD } from "../lib/anthropic.mjs";
import { BRAND_NAMES, loadPack, renderDraftPrompt } from "../lib/prompts.mjs";
import { openStore, SECURITY_STORE } from "../lib/store.mjs";
import { stripControls } from "../lib/text.mjs";

const QUERY_LIMITS = { summary: 1000, queryText: 8000, outlet: 300, name: 200, deadlineDate: 100, deadlineTime: 100, tz: 100 };
const FIELD_LIMITS = { product: 300, link: 400, price: 60 };
const MAX_OUTPUT_CHARS = 12000;

// Same normalisation the page applied before (collapse whitespace, cap).
const clip = (s, max) => {
  const t = stripControls(s == null ? "" : s).trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max) : t;
};
const bound = (s, max) => {
  const t = stripControls(s == null ? "" : s);
  return t.length > max ? t.slice(0, max) : t;
};

function parseInput(v) {
  if (!onlyKeys(v, ["brand", "query", "fields"])) return null;
  if (typeof v.brand !== "string" || !BRAND_NAMES.includes(v.brand)) return null;
  const q = v.query, f = v.fields;
  if (!q || typeof q !== "object" || Array.isArray(q) || !onlyKeys(q, Object.keys(QUERY_LIMITS))) return null;
  if (!f || typeof f !== "object" || Array.isArray(f) || !onlyKeys(f, Object.keys(FIELD_LIMITS))) return null;
  for (const x of [...Object.values(q), ...Object.values(f)]) if (x != null && typeof x !== "string") return null;
  const query = {};
  for (const [k, max] of Object.entries(QUERY_LIMITS)) query[k] = bound(q[k], max);
  const fields = {};
  for (const [k, max] of Object.entries(FIELD_LIMITS)) fields[k] = clip(f[k], max);
  if (!fields.product) return null;
  return { brand: v.brand, query, fields };
}

export default async function draft(req) {
  const g = await requireSession(req, { route: "draft" });
  if (!g.ok) return g.res;
  const body = await readJson(req, 32 * 1024);
  if (!body.ok) return body.res;
  const input = parseInput(body.value);
  if (!input) return errors.badRequest("Invalid draft request.");

  const mcfg = modelConfig("draft");
  if (!mcfg.ok) {
    const ref = newRef();
    log("draft_not_configured", { ref, missing: mcfg.problems.join("_") });
    return errors.notConfigured(ref);
  }
  let pack;
  try { pack = await loadPack(); } catch (err) {
    const ref = newRef();
    log("prompt_pack_unavailable", { ref, code: err.code || "error" });
    return err.code === "store" ? errors.unavailable(ref) : errors.notConfigured(ref);
  }

  const lim = draftLimits();
  const store = openStore(SECURITY_STORE);
  const lockKey = "lock/draft/" + g.session.sid;
  let lockOwner = null;
  try {
    const s = await hit(store, "usage/draft/session/" + g.session.sid, lim.perSession, lim.windowMs);
    if (!s.ok) { log("draft_limited", { scope: "session" }); return errors.limited(s.retryAfter); }
    const gl = await hit(store, "usage/draft/global", lim.global, lim.windowMs);
    if (!gl.ok) { log("draft_limited", { scope: "global" }); return errors.limited(gl.retryAfter); }
    lockOwner = await acquireLock(store, lockKey, mcfg.budgetMs + 5000);
    if (!lockOwner) return errors.busy();
  } catch {
    const ref = newRef();
    log("draft_store_unavailable", { ref });
    return errors.unavailable(ref);
  }

  const ref = newRef();
  try {
    const prompt = renderDraftPrompt(pack, input.brand, input.query, input.fields);
    const out = await callModel({
      cfg: mcfg, system: UNTRUSTED_DATA_GUARD, prompt, maxTokens: 1024, deadline: Date.now() + mcfg.budgetMs,
    });
    let text = stripControls(out.text).trim();
    if (!text) throw Object.assign(new Error("empty"), { code: "model_empty" });
    if (text.length > MAX_OUTPUT_CHARS) text = text.slice(0, MAX_OUTPUT_CHARS);
    const tail = pack.draft.brands[input.brand].appendAfterDraft;
    if (tail) text = text.replace(/\s+$/, "") + "\n\n" + tail;
    log("draft_ok", { ref, pack: pack.version, attempts: out.attempts });
    return json(200, { text });
  } catch (err) {
    log("draft_failed", { ref, code: err && err.code ? err.code : "error", status: err && err.status ? err.status : 0 });
    return json(502, { error: "The pitch could not be generated. Try again.", ref });
  } finally {
    if (lockOwner) await releaseLock(store, lockKey, lockOwner);
  }
}
