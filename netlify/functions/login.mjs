// POST /api/login  { password }  -> sets the signed session cookie.
// Durable attempt limits (per hashed IP and global) are reserved BEFORE the
// password is compared, so parallel guesses can't race past the limit.
import { createHmac } from "node:crypto";
import { authConfig } from "../lib/config.mjs";
import { clientIp, errors, json, log, newRef, onlyKeys, readJson, sameOriginOk } from "../lib/http.mjs";
import { hit } from "../lib/limits.mjs";
import { cookieHeader, issue, passwordMatches } from "../lib/session.mjs";
import { openStore, SECURITY_STORE } from "../lib/store.mjs";

export default async function login(req, context) {
  if (req.method !== "POST") return errors.method();
  if (!sameOriginOk(req)) { log("csrf_rejected", { route: "login" }); return errors.csrf(); }
  const cfg = authConfig();
  if (!cfg.ok) {
    const ref = newRef();
    log("auth_not_configured", { route: "login", ref, missing: cfg.problems.join("_") });
    return errors.notConfigured(ref);
  }
  const body = await readJson(req, 1024);
  if (!body.ok) return body.res;
  if (!onlyKeys(body.value, ["password"]) || typeof body.value.password !== "string" ||
      !body.value.password || body.value.password.length > 256) return errors.badRequest();

  const ipKey = createHmac("sha256", cfg.secret).update("ip:" + clientIp(req, context)).digest("base64url").slice(0, 32);
  try {
    const store = openStore(SECURITY_STORE);
    const g = await hit(store, "login/global", cfg.login.global, cfg.login.windowMs);
    if (!g.ok) { log("login_limited", { scope: "global" }); return errors.limited(g.retryAfter); }
    const i = await hit(store, "login/ip/" + ipKey, cfg.login.perIp, cfg.login.windowMs);
    if (!i.ok) { log("login_limited", { scope: "ip" }); return errors.limited(i.retryAfter); }
  } catch {
    const ref = newRef();
    log("login_store_unavailable", { ref });
    return errors.unavailable(ref);
  }

  if (!passwordMatches(cfg, body.value.password)) {
    log("login_failed");
    return errors.unauthorized();
  }
  const { token } = issue(cfg);
  log("login_ok");
  return json(200, { ok: true }, { "Set-Cookie": cookieHeader(token, cfg.ttlSeconds) });
}
