// POST /api/logout -> revokes this session id server-side, then clears the cookie.
// If revocation can't be recorded, the cookie is KEPT and 503 is returned, so
// the browser can retry; clearing it locally would hide a still-valid session.
import { authConfig } from "../lib/config.mjs";
import { errors, json, log, newRef, sameOriginOk } from "../lib/http.mjs";
import { clearCookieHeader, decode, readCookie, revoke } from "../lib/session.mjs";

export default async function logout(req) {
  if (req.method !== "POST") return errors.method();
  if (!sameOriginOk(req)) return errors.csrf();
  const cfg = authConfig();
  if (!cfg.ok) {
    const ref = newRef();
    log("auth_not_configured", { route: "logout", ref, missing: cfg.problems.join("_") });
    return errors.notConfigured(ref);
  }
  const p = decode(cfg, readCookie(req));
  if (p) {
    try { await revoke(p); } catch {
      const ref = newRef();
      log("logout_store_unavailable", { ref });
      return json(503, { error: "Sign-out could not be recorded. Try again.", ref });
    }
  }
  // No valid session (absent, expired or invalid): nothing to revoke.
  log("logout");
  return json(200, { ok: true }, { "Set-Cookie": clearCookieHeader() });
}
