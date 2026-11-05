// Reusable session verification for browser endpoints. Order:
// method -> CSRF -> security config -> verified session. Nothing external
// (sheet, model, prompt store) is touched before this returns ok.
import { authConfig } from "./config.mjs";
import { errors, log, newRef, sameOriginOk } from "./http.mjs";
import { verify } from "./session.mjs";

export async function requireSession(req, { methods = ["POST"], csrf = true, route = "unknown" } = {}) {
  if (!methods.includes(req.method)) return { ok: false, res: errors.method() };
  if (csrf && !sameOriginOk(req)) {
    log("csrf_rejected", { route });
    return { ok: false, res: errors.csrf() };
  }
  const cfg = authConfig();
  if (!cfg.ok) {
    const ref = newRef();
    log("auth_not_configured", { route, ref, missing: cfg.problems.join("_") });
    return { ok: false, res: errors.notConfigured(ref) };
  }
  let session;
  try {
    session = await verify(cfg, req);
  } catch {
    const ref = newRef();
    log("session_store_unavailable", { route, ref });
    return { ok: false, res: errors.unavailable(ref) };
  }
  if (!session) return { ok: false, res: errors.unauthorized() };
  return { ok: true, cfg, session };
}
