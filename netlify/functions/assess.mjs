// POST /api/assess -> brand-fit assessment for the Apps Script automation
// (machine-to-machine). Auth: x-assessment-secret only. Browser sessions are
// NOT accepted here, and this secret is NOT accepted by any other route.
//
// Request/response contract is unchanged:
//   { queries: [ { id, topic, content, category, deadline }, ... ] }  -> { results: [...] }
//   { topic, content, category, deadline }                            -> single result (legacy)
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { assessConfig, modelConfig } from "../lib/config.mjs";
import { errors, json, log, newRef, readJson } from "../lib/http.mjs";
import { hit } from "../lib/limits.mjs";
import { callModel, UNTRUSTED_DATA_GUARD } from "../lib/anthropic.mjs";
import { loadPack, renderAssessBatchPrompt, renderAssessSinglePrompt } from "../lib/prompts.mjs";
import { openStore, SECURITY_STORE } from "../lib/store.mjs";
import { sheetSafe, stripControls } from "../lib/text.mjs";

const MAX_TOPIC_LEN    = 300;
const MAX_CONTENT_LEN  = 2000;
const MAX_CATEGORY_LEN = 100;
const MAX_BATCH        = 10;

// Deterministic safeguard (public). Apps Script already excludes these.
const EXCLUSION_PHRASES = [
  "gift bag", "gift bags", "swag bag", "swag bags", "swag box", "swag boxes",
  "goody bag", "goody bags", "event bag", "event bags", "travel kit", "travel kits",
  "attendee gift", "attendee gifts", "product donation", "product donations",
  "bulk fulfillment", "bulk event", "event fulfillment",
  "conference bag", "trade show bag", "sponsor bag",
];

const EXCLUSION_CATEGORIES = [
  "technology only", "tech only", "alcohol only",
  "veterinary", "pet swag", "pet product swag",
];

function isHardExcluded(topic, content, category) {
  // Topic + content only — never category (HARO has a "Gift Bags and Gift Guides" category)
  const haystack = [topic, content].map((s) => (s || "").toLowerCase()).join(" ");
  for (const phrase of EXCLUSION_PHRASES) {
    if (haystack.indexOf(phrase) !== -1) return "gift bag / swag / bulk event fulfillment";
  }
  const cat = (category || "").toLowerCase();
  for (const c of EXCLUSION_CATEGORIES) {
    if (cat.indexOf(c) !== -1) return "excluded category: " + category;
  }
  return null;
}

function truncate(s, max) {
  if (!s) return "";
  s = stripControls(String(s));
  return s.length > max ? s.slice(0, max) + "…" : s;
}

const cleanReason = (r) => sheetSafe(stripControls(String(r)).slice(0, 300));

function validEntry(e) {
  return (
    e &&
    e.succulents_box && typeof e.succulents_box.fit === "boolean" && typeof e.succulents_box.reason === "string" &&
    e.photos_to_sketches && typeof e.photos_to_sketches.fit === "boolean" && typeof e.photos_to_sketches.reason === "string"
  );
}

function shape(id, sbFit, sbReason, ptsFit, ptsReason, excluded) {
  const out = {
    id,
    succulents_box: { fit: sbFit, reason: cleanReason(sbReason) },
    photos_to_sketches: { fit: ptsFit, reason: cleanReason(ptsReason) },
  };
  if (excluded) out.excluded = true;
  return out;
}

function secretOk(candidate, secrets) {
  if (typeof candidate !== "string" || !candidate || candidate.length > 512) return false;
  const key = randomBytes(32);
  const mac = (s) => createHmac("sha256", key).update(s).digest();
  const c = mac(candidate);
  let ok = false;
  for (const s of secrets) ok = timingSafeEqual(c, mac(s)) || ok;
  return ok;
}

function parseModelJson(raw) {
  const cleaned = String(raw).trim().replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
  try { return JSON.parse(cleaned); } catch { throw Object.assign(new Error("non_json"), { code: "model_non_json" }); }
}

// Loads config + prompt pack, reserves usage, calls the model once.
async function runModel(buildPrompt, maxTokens) {
  const mcfg = modelConfig("assess");
  if (!mcfg.ok) return { res: errors.notConfigured(logRef("assess_not_configured")) };
  let pack;
  try { pack = await loadPack(); } catch (err) {
    const ref = logRef("prompt_pack_unavailable", { code: err.code || "error" });
    return { res: err.code === "store" ? errors.unavailable(ref) : errors.notConfigured(ref) };
  }
  const acfg = assessConfig();
  try {
    const u = await hit(openStore(SECURITY_STORE), "usage/assess/global", acfg.max, acfg.windowMs);
    if (!u.ok) { log("assess_limited"); return { res: errors.limited(u.retryAfter) }; }
  } catch {
    return { res: errors.unavailable(logRef("assess_store_unavailable")) };
  }
  const out = await callModel({
    cfg: mcfg, system: UNTRUSTED_DATA_GUARD, prompt: buildPrompt(pack), maxTokens, deadline: Date.now() + mcfg.budgetMs,
  });
  log("assess_model_ok", { pack: pack.version, attempts: out.attempts });
  return { parsed: parseModelJson(out.text) };
}

function logRef(event, fields = {}) { const ref = newRef(); log(event, { ref, ...fields }); return ref; }

const failed = (err) => {
  const ref = logRef("assess_failed", { code: err && err.code ? err.code : "error", status: err && err.status ? err.status : 0 });
  return json(502, { error: "Assessment failed. Leave these queries pending and retry later.", ref });
};

export default async function assess(req) {
  if (req.method !== "POST") return errors.method();
  const acfg = assessConfig();
  if (!acfg.ok) return errors.notConfigured(logRef("assess_auth_not_configured"));
  if (!secretOk(req.headers.get("x-assessment-secret"), acfg.secrets)) {
    log("assess_unauthorized");
    return errors.unauthorized();
  }

  const read = await readJson(req, 64 * 1024);
  if (!read.ok) return read.res;
  const body = read.value;

  // ---------- BATCH MODE ----------
  if (Array.isArray(body.queries)) {
    const incoming = body.queries.slice(0, MAX_BATCH);
    if (incoming.length === 0) return json(400, { error: "queries array is empty." });

    const results = [];
    const needModel = [];
    incoming.forEach((raw, i) => {
      raw = raw && typeof raw === "object" ? raw : {};
      const q = {
        id:       stripControls(String(raw.id || "q" + i)).slice(0, 100),
        topic:    truncate(raw.topic, MAX_TOPIC_LEN),
        content:  truncate(raw.content, MAX_CONTENT_LEN),
        category: truncate(raw.category, MAX_CATEGORY_LEN),
        deadline: raw.deadline ? stripControls(String(raw.deadline)).slice(0, 50) : "",
      };
      if (!q.topic && !q.content) return; // unusable — omit, caller retries

      const reason = isHardExcluded(q.topic, q.content, q.category);
      if (reason) {
        const r = "Hard exclusion: " + reason + ".";
        results.push(shape(q.id, false, r, false, r, true));
      } else {
        needModel.push(q);
      }
    });

    if (needModel.length === 0) return json(200, { results });

    try {
      const run = await runModel((pack) => renderAssessBatchPrompt(pack, needModel), 200 * needModel.length + 200);
      if (run.res) return run.res;
      const arr = Array.isArray(run.parsed) ? run.parsed : run.parsed && run.parsed.results;
      if (!Array.isArray(arr)) {
        log("assess_bad_shape");
        return json(502, { error: "Model returned unexpected shape." });
      }
      // Match by id; fall back to positional. Invalid entries are omitted
      // so Apps Script leaves those queries pending for the next run.
      arr.slice(0, needModel.length).forEach((entry, i) => {
        if (!validEntry(entry)) return;
        const id = entry.id && needModel.some((q) => q.id === entry.id)
          ? entry.id
          : (needModel[i] ? needModel[i].id : null);
        if (!id) return;
        results.push(shape(
          id,
          entry.succulents_box.fit, entry.succulents_box.reason,
          entry.photos_to_sketches.fit, entry.photos_to_sketches.reason,
          false
        ));
      });
      return json(200, { results });
    } catch (err) {
      return failed(err);
    }
  }

  // ---------- SINGLE MODE (legacy) ----------
  const q = {
    topic:    truncate(body.topic, MAX_TOPIC_LEN),
    content:  truncate(body.content, MAX_CONTENT_LEN),
    category: truncate(body.category, MAX_CATEGORY_LEN),
    deadline: body.deadline ? stripControls(String(body.deadline)).slice(0, 50) : "",
  };
  if (!q.topic && !q.content) return json(400, { error: "topic or content is required." });

  const exclusionReason = isHardExcluded(q.topic, q.content, q.category);
  if (exclusionReason) {
    const r = cleanReason("Hard exclusion: " + exclusionReason + ".");
    return json(200, {
      succulents_box: { fit: false, reason: r },
      photos_to_sketches: { fit: false, reason: r },
      excluded: true,
    });
  }

  try {
    const run = await runModel((pack) => renderAssessSinglePrompt(pack, q), 256);
    if (run.res) return run.res;
    if (!validEntry(run.parsed)) {
      log("assess_bad_shape");
      return json(502, { error: "Model returned unexpected shape." });
    }
    return json(200, {
      succulents_box: { fit: run.parsed.succulents_box.fit, reason: cleanReason(run.parsed.succulents_box.reason) },
      photos_to_sketches: { fit: run.parsed.photos_to_sketches.fit, reason: cleanReason(run.parsed.photos_to_sketches.reason) },
    });
  } catch (err) {
    return failed(err);
  }
}
