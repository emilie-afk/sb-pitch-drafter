// GET /api/session -> restores the session on page load. Authorized users
// also receive the package-tracker link (intentional disclosure to them).
import { trackerUrl } from "../lib/config.mjs";
import { requireSession } from "../lib/guard.mjs";
import { json } from "../lib/http.mjs";

export default async function session(req) {
  const g = await requireSession(req, { methods: ["GET"], csrf: false, route: "session" });
  if (!g.ok) return g.res;
  return json(200, { authenticated: true, expiresAt: g.session.exp, trackerUrl: trackerUrl() });
}
