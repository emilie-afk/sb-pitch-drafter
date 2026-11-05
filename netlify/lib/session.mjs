// Signed, expiring session cookies (HMAC-SHA256). The password is checked
// once at login; afterwards the browser only holds an HttpOnly cookie.
//
// A token is rejected if: the signature is wrong, it has expired, it was
// issued under a different SESSION_EPOCH, it was issued under a different
// APP_PASSWORD (keyed fingerprint), or its id was revoked by logout.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { openStore, SECURITY_STORE } from "./store.mjs";

export const COOKIE = "__Host-pd_session";

const b64u = (buf) => Buffer.from(buf).toString("base64url");
const hmac = (secret, data) => createHmac("sha256", secret).update(data).digest();

function safeEqual(a, b) {
  const ab = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Constant-time password comparison (compares fixed-length MACs).
export function passwordMatches(cfg, candidate) {
  if (typeof candidate !== "string" || !candidate) return false;
  return safeEqual(hmac(cfg.secret, "pwcheck:" + candidate), hmac(cfg.secret, "pwcheck:" + cfg.password));
}

const fingerprint = (cfg) => b64u(hmac(cfg.secret, "pwfp:" + cfg.password)).slice(0, 22);

export function issue(cfg, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const payload = { sid: b64u(randomBytes(18)), iat, exp: iat + cfg.ttlSeconds, ep: cfg.epoch, pf: fingerprint(cfg) };
  const body = b64u(JSON.stringify(payload));
  const token = body + "." + b64u(hmac(cfg.secret, "session:" + body));
  return { token, payload };
}

export function cookieHeader(token, maxAge) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
export const clearCookieHeader = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export function readCookie(req) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
  }
  return "";
}

// Signature/claims only (no store access).
export function decode(cfg, token, now = Date.now()) {
  if (!token || token.length > 512) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  let sigBuf;
  try { sigBuf = Buffer.from(sig, "base64url"); } catch { return null; }
  if (!safeEqual(sigBuf, hmac(cfg.secret, "session:" + body))) return null;
  let p;
  try { p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return null; }
  if (!p || typeof p.sid !== "string" || typeof p.exp !== "number" || typeof p.iat !== "number") return null;
  const t = Math.floor(now / 1000);
  if (p.exp <= t || p.iat > t + 60 || p.exp - p.iat > cfg.ttlSeconds) return null;
  if (p.ep !== cfg.epoch) return null;
  if (!safeEqual(String(p.pf), fingerprint(cfg))) return null;
  return p;
}

const revokedKey = (sid) => "revoked/" + sid;

// Full verification, once per request. Throws if the store is unavailable
// (callers turn that into 503: fail closed).
export async function verify(cfg, req, now = Date.now()) {
  const p = decode(cfg, readCookie(req), now);
  if (!p) return null;
  const store = openStore(SECURITY_STORE);
  const rev = await store.get(revokedKey(p.sid), { type: "json" });
  if (rev) return null;
  return p;
}

export async function revoke(payload) {
  const store = openStore(SECURITY_STORE);
  await store.setJSON(revokedKey(payload.sid), { exp: payload.exp });
}
