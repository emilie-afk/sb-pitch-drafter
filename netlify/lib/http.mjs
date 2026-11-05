// Shared response, request-validation and logging helpers.
import { randomBytes } from "node:crypto";

export const CSRF_HEADER = "x-pitch-request";

const BASE_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store, private",
  "Vary": "Cookie",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export function newRef() { return randomBytes(4).toString("hex"); }

export function json(status, payload, extra = {}) {
  const headers = new Headers(BASE_HEADERS);
  for (const [k, v] of Object.entries(extra)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else headers.set(k, v);
  }
  return new Response(JSON.stringify(payload), { status, headers });
}

export const errors = {
  method: () => json(405, { error: "Method not allowed." }, { Allow: "POST" }),
  csrf: () => json(403, { error: "Request rejected." }),
  unauthorized: () => json(401, { error: "Unauthorized." }),
  badRequest: (msg = "Invalid request.") => json(400, { error: msg }),
  tooLarge: () => json(413, { error: "Request too large." }),
  limited: (retryAfter) => json(429, { error: "Too many requests. Try again later.", retryAfter }, { "Retry-After": String(retryAfter) }),
  notConfigured: (ref) => json(503, { error: "The app is not configured correctly. Contact the site owner.", ref }),
  unavailable: (ref) => json(503, { error: "Service temporarily unavailable. Try again shortly.", ref }),
  busy: () => json(409, { error: "A request is already running. Please wait for it to finish." }),
};

// Structured logs: event codes and small enumerated fields only. Never pass
// URLs, bodies, prompts, cookies, passwords or provider messages here.
export function log(event, fields = {}) {
  const safe = {};
  for (const [k, v] of Object.entries(fields)) {
    if (typeof v === "number" || typeof v === "boolean") safe[k] = v;
    else if (typeof v === "string" && /^[A-Za-z0-9_.-]{0,40}$/.test(v)) safe[k] = v;
  }
  console.log(JSON.stringify({ app: "pitch-drafter", event, ...safe }));
}

// CSRF for cookie-authenticated, state-changing or paid operations: require
// a custom header (not sendable cross-site without a CORS preflight, which we
// never grant) and, when the browser sends them, same-origin Origin/Fetch-Site.
export function sameOriginOk(req) {
  if (req.headers.get(CSRF_HEADER) !== "1") return false;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return false;
  const origin = req.headers.get("origin");
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { return false; }
    const reqHost = req.headers.get("host") || new URL(req.url).host;
    if (host !== reqHost) return false;
  }
  return true;
}

// Reads a JSON body with a byte cap. Returns { ok, value } or { ok:false, res }.
export async function readJson(req, maxBytes) {
  const len = Number(req.headers.get("content-length") || "0");
  if (len > maxBytes) return { ok: false, res: errors.tooLarge() };
  let text;
  try {
    const buf = new Uint8Array(await req.arrayBuffer());
    if (buf.byteLength > maxBytes) return { ok: false, res: errors.tooLarge() };
    text = new TextDecoder().decode(buf);
  } catch { return { ok: false, res: errors.badRequest() }; }
  if (!text.trim()) return { ok: true, value: {} };
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, res: errors.badRequest() };
    return { ok: true, value: v };
  } catch { return { ok: false, res: errors.badRequest("Invalid JSON.") }; }
}

export function onlyKeys(obj, allowed) {
  return Object.keys(obj).every((k) => allowed.includes(k));
}

export function clientIp(req, context) {
  return (context && context.ip) || req.headers.get("x-nf-client-connection-ip") || "unknown";
}
