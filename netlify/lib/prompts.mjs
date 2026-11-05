// Loads the confidential prompt pack (brand voice, pitch rules, curated
// examples, assessment guidance) from private Netlify Blobs storage and
// renders prompts from it. The pack is never committed, never sent to the
// browser and never logged. This file holds only generic assembly code.
import { openStore, PRIVATE_STORE } from "./store.mjs";
import { promptPackKey } from "./config.mjs";

export const BRAND_NAMES = ["Succulents Box", "Photos to Sketches"];
const MISSING = "not provided";
const MAX_PACK_BYTES = 256 * 1024;
const REQUIRED_PLACEHOLDERS = ["brand", "product", "link", "price", "greeting", "query_text", "voice", "examples", "body_length"];

export class PackError extends Error { constructor(code) { super(code); this.code = code; } }

const isStr = (v) => typeof v === "string" && v.length > 0;
const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

export function validatePack(p) {
  if (!p || typeof p !== "object") return "not_object";
  if (!/^[A-Za-z0-9_.-]{1,40}$/.test(String(p.version || ""))) return "version";
  const d = p.draft;
  if (!d || !isStr(d.template)) return "draft.template";
  for (const ph of REQUIRED_PLACEHOLDERS) if (!d.template.includes("{{" + ph + "}}")) return "draft.template." + ph;
  if (!isStr(d.defaultBodyLength) || !isStrArr(d.defaultExampleGuidance) || !isStr(d.noExampleText) ||
      !isStr(d.examplesHeader) || !isStr(d.examplesFooterLabel)) return "draft.defaults";
  if (!d.brands || typeof d.brands !== "object") return "draft.brands";
  for (const name of BRAND_NAMES) {
    const b = d.brands[name];
    if (!b || !isStr(b.intro) || !isStrArr(b.catalog) || !isStrArr(b.voice) || !isStr(b.linkRule)) return "draft.brands." + name;
    if (b.examples !== undefined && !isStrArr(b.examples)) return "draft.brands.examples";
    if (b.exampleGuidance !== undefined && !isStrArr(b.exampleGuidance)) return "draft.brands.exampleGuidance";
    if (b.bodyLength !== undefined && typeof b.bodyLength !== "string") return "draft.brands.bodyLength";
    if (b.appendAfterDraft !== undefined && typeof b.appendAfterDraft !== "string") return "draft.brands.appendAfterDraft";
    if (b.extraSections !== undefined && !(Array.isArray(b.extraSections) &&
        b.extraSections.every((s) => s && isStr(s.title) && isStrArr(s.lines)))) return "draft.brands.extraSections";
  }
  if (!p.assess || !isStr(p.assess.brandSpec)) return "assess.brandSpec";
  return null;
}

// One store read per request. Throws PackError("missing"|"invalid"|"store").
export async function loadPack() {
  let raw;
  try {
    raw = await openStore(PRIVATE_STORE).get(promptPackKey(), { type: "text" });
  } catch { throw new PackError("store"); }
  if (raw == null || raw === "") throw new PackError("missing");
  if (raw.length > MAX_PACK_BYTES) throw new PackError("invalid");
  let pack;
  try { pack = JSON.parse(raw); } catch { throw new PackError("invalid"); }
  if (validatePack(pack)) throw new PackError("invalid");
  return pack;
}

// Single pass: values inserted from untrusted input are never re-expanded.
export function fill(template, vars) {
  return template.replace(/\{\{([a-z_]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : m));
}

export function renderDraftPrompt(pack, brand, query, fields) {
  const d = pack.draft;
  const spec = d.brands[brand];
  const firstName = (query.name || "").trim().split(/\s+/)[0] || "";
  const greeting = firstName ? "Hi " + firstName + "," : "Hi there,";
  const examples = (spec.examples || []).filter((e) => e && String(e).trim());
  const deadlineBits = [query.deadlineDate, query.deadlineTime, query.tz]
    .map((x) => (x || "").trim()).filter(Boolean).join(" ");

  let examplesBlock = d.noExampleText;
  if (examples.length > 0) {
    const plural = examples.length > 1;
    examplesBlock =
      fill(d.examplesHeader, { brand_upper: brand.toUpperCase(), plural: plural ? "S" : "" }) + "\n" +
      examples.map((ex, i) => (plural ? "EXAMPLE " + (i + 1) + "\n" : "") + "---\n" + ex + "\n---").join("\n\n") + "\n" +
      d.examplesFooterLabel + "\n" +
      (spec.exampleGuidance || d.defaultExampleGuidance).map((g) => "- " + g).join("\n");
  }

  return fill(d.template, {
    brand,
    brand_intro: spec.intro,
    catalog: spec.catalog.join(", "),
    product: fields.product,
    link: fields.link || MISSING,
    price: fields.price || MISSING,
    outlet: query.outlet || MISSING,
    journalist: query.name || MISSING,
    greeting,
    deadline: deadlineBits || MISSING,
    topic: query.summary || "",
    query_text: query.queryText || "",
    link_rule: spec.linkRule,
    deadline_date: query.deadlineDate || "",
    voice: spec.voice.map((v) => "- " + v).join("\n"),
    extra_sections: (spec.extraSections || [])
      .map((sec) => "\n" + sec.title + "\n" + sec.lines.map((l) => "- " + l).join("\n")).join("\n"),
    body_length: spec.bodyLength || d.defaultBodyLength,
    examples: examplesBlock,
  });
}

// Assessment prompts: private brand spec + public formatting/JSON contract.
export function formatAssessQuery(q, n) {
  return `--- QUERY ${n} (id: ${q.id}) ---
Topic: ${q.topic}
Category: ${q.category || "not specified"}
Deadline: ${q.deadline || "not specified"}
Content:
${q.content}`;
}

export function renderAssessBatchPrompt(pack, queries) {
  return `${pack.assess.brandSpec}

${queries.map((q, i) => formatAssessQuery(q, i + 1)).join("\n\n")}

Respond with ONLY a valid JSON array — one object per query, in the same order, no markdown, no explanation:
[
  { "id": "<the id of query 1>", "succulents_box": { "fit": true|false, "reason": "One short sentence." }, "photos_to_sketches": { "fit": true|false, "reason": "One short sentence." } }
]`;
}

export function renderAssessSinglePrompt(pack, q) {
  return `${pack.assess.brandSpec}

QUERY
Topic: ${q.topic}
Category: ${q.category || "not specified"}
Deadline: ${q.deadline || "not specified"}
Content:
${q.content}

Respond with ONLY a valid JSON object in exactly this shape, no markdown, no explanation:
{
  "succulents_box": { "fit": true|false, "reason": "One short sentence." },
  "photos_to_sketches": { "fit": true|false, "reason": "One short sentence." }
}`;
}
