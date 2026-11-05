// Test helpers: in-memory Blobs store with ETag compare-and-set, a recording
// fetch mock, request builders and log capture. Synthetic data only.
import fs from "node:fs";
import { __setStoreFactory } from "../netlify/lib/store.mjs";

const tick = () => new Promise((r) => setImmediate(r));

export class MemStore {
  constructor() { this.m = new Map(); this.n = 0; this.fail = false; }
  _chk() { if (this.fail) throw new Error("store down"); }
  async get(k, o = {}) { this._chk(); await tick(); const e = this.m.get(k); if (!e) return null; return o.type === "json" ? JSON.parse(e.v) : e.v; }
  async getWithMetadata(k, o = {}) { this._chk(); await tick(); const e = this.m.get(k); if (!e) return null; return { data: o.type === "json" ? JSON.parse(e.v) : e.v, etag: e.etag, metadata: {} }; }
  async set(k, v, o = {}) { return this._put(k, String(v), o); }
  async setJSON(k, v, o = {}) { return this._put(k, JSON.stringify(v), o); }
  async _put(k, v, o) {
    this._chk(); await tick();
    const e = this.m.get(k);
    if (o.onlyIfNew && e) return { modified: false };
    if (o.onlyIfMatch && (!e || e.etag !== o.onlyIfMatch)) return { modified: false };
    const etag = '"' + ++this.n + '"';
    this.m.set(k, { v, etag });
    return { modified: true, etag };
  }
  async delete(k) { this._chk(); this.m.delete(k); }
}

export const stores = {};
export function resetStores() {
  for (const k of Object.keys(stores)) delete stores[k];
  __setStoreFactory((name) => (stores[name] ||= new MemStore()));
}

export const SYNTH_PACK = fs.readFileSync(new URL("./fixtures/synthetic-pack.json", import.meta.url), "utf8");
export function installPack(text = SYNTH_PACK, key = "prompt-pack/active") {
  stores["pitch-drafter-private"] ||= new MemStore();
  stores["pitch-drafter-private"].m.set(key, { v: text, etag: '"p"' });
}

export const SECRETS = {
  APP_PASSWORD: "correct horse battery staple 42",
  SESSION_SECRET: "test-session-secret-0123456789-abcdefghijklmnop",
  ANTHROPIC_API_KEY: "test-anthropic-key-SYNTHETIC-zzz",
  SHEET_CSV_URL: "https://docs.google.com/spreadsheets/d/SYNTHETICsheetID000000000000000000000000000/export?format=csv&gid=0",
  PACKAGE_TRACKER_URL: "https://docs.google.com/spreadsheets/d/SYNTHETICtrackerID00000000000000000000000000/edit#gid=1",
  ASSESSMENT_SECRET: "test-assessment-secret-SYNTHETIC-123",
};
const ALL_ENV = [...Object.keys(SECRETS), "ASSESSMENT_SECRET_NEXT", "SESSION_EPOCH", "SESSION_TTL_HOURS", "PROMPT_PACK_KEY",
  "DRAFT_BUDGET_MS", "ASSESS_BUDGET_MS", "SHEET_BUDGET_MS", "LOGIN_MAX_ATTEMPTS_PER_IP", "LOGIN_MAX_ATTEMPTS_GLOBAL",
  "LOGIN_WINDOW_MINUTES", "DRAFT_MAX_PER_SESSION", "DRAFT_MAX_GLOBAL", "DRAFT_WINDOW_MINUTES", "ASSESS_MAX_CALLS", "ASSESS_WINDOW_MINUTES", "ANTHROPIC_MODEL"];
export function setEnv(overrides = {}) {
  for (const k of ALL_ENV) delete process.env[k];
  Object.assign(process.env, SECRETS, overrides);
  for (const [k, v] of Object.entries(overrides)) if (v === undefined) delete process.env[k];
}

// ---- fetch mock ----
export const calls = [];
let routes = [];
export function mockFetch(handlers) {
  calls.length = 0;
  routes = handlers;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push({ url: url.href, host: url.hostname, init });
    for (const [match, fn] of routes) if (match(url)) return fn(url, init);
    throw new TypeError("network: unexpected host " + url.hostname);
  };
}
export const host = (h) => (u) => u.hostname === h || (h.startsWith("*.") && u.hostname.endsWith(h.slice(1)));
export function modelReply(text, status = 200) {
  return new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status, headers: { "content-type": "application/json" } });
}
export const upstreamCalls = () => calls.filter((c) => c.host !== "localhost");

// ---- requests ----
export const ORIGIN = "https://pitch.example.test";
export function req(path, { method = "POST", body, headers = {}, cookie, csrf = true, raw } = {}) {
  const h = new Headers({ host: "pitch.example.test", ...headers });
  if (csrf) {
    if (!h.has("x-pitch-request")) h.set("x-pitch-request", "1");
    if (!h.has("origin")) h.set("origin", ORIGIN);
    if (!h.has("sec-fetch-site")) h.set("sec-fetch-site", "same-origin");
  }
  if (cookie) h.set("cookie", cookie);
  let b;
  if (raw !== undefined) b = raw;
  else if (body !== undefined) { b = JSON.stringify(body); h.set("content-type", "application/json"); }
  return new Request(ORIGIN + path, { method, headers: h, body: method === "GET" ? undefined : b });
}
export const ctx = (ip = "203.0.113.7") => ({ ip });

let gen = 0;
// Fresh module instance per call, like a new function invocation/instance.
export async function fn(name) {
  return (await import(`../netlify/functions/${name}.mjs?i=${++gen}`)).default;
}
export function cookieFrom(res) {
  const sc = res.headers.get("set-cookie") || "";
  const m = sc.match(/(__Host-pd_session=[^;]*)/);
  return m ? m[1] : null;
}
export async function loginCookie(ip) {
  const login = await fn("login");
  const res = await login(req("/api/login", { body: { password: SECRETS.APP_PASSWORD } }), ctx(ip));
  if (res.status !== 200) throw new Error("login failed " + res.status);
  return cookieFrom(res);
}

// ---- log capture ----
export const logs = [];
const origLog = console.log, origErr = console.error, origWarn = console.warn;
export function captureLogs() {
  logs.length = 0;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => logs.push(a.join(" "));
  console.warn = (...a) => logs.push(a.join(" "));
}
export function restoreLogs() { console.log = origLog; console.error = origErr; console.warn = origWarn; }

export function setup() {
  setEnv();
  resetStores();
  installPack();
  mockFetch([]);
  captureLogs();
}
