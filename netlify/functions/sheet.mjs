// POST /api/sheet -> tracker rows for the signed-in team. The source location
// comes only from server-only SHEET_CSV_URL; callers can't supply one.
import { sheetConfig } from "../lib/config.mjs";
import { requireSession } from "../lib/guard.mjs";
import { errors, json, log, newRef, readJson } from "../lib/http.mjs";
import { csvToMessages } from "../lib/tracker.mjs";
import { fetchText } from "../lib/upstream.mjs";

const SHEET_HOSTS = ["docs.google.com", "*.googleusercontent.com"];

export default async function sheet(req) {
  const g = await requireSession(req, { route: "sheet" });
  if (!g.ok) return g.res;
  const body = await readJson(req, 256);
  if (!body.ok) return body.res;
  if (Object.keys(body.value).length) return errors.badRequest();

  const cfg = sheetConfig();
  if (!cfg.ok) {
    const ref = newRef();
    log("sheet_not_configured", { ref, missing: cfg.problems.join("_") });
    return errors.notConfigured(ref);
  }
  const ref = newRef();
  try {
    const res = await fetchText(cfg.url, { allow: SHEET_HOSTS, maxBytes: cfg.maxBytes, deadline: Date.now() + cfg.budgetMs });
    if (!res.ok) {
      log("sheet_upstream_status", { ref, status: res.status });
      return json(502, { error: "Couldn't fetch sheet (HTTP " + res.status + "). Check that the sheet is shared as Anyone with the link can view, and that SHEET_CSV_URL is correct.", ref });
    }
    return json(200, { messages: csvToMessages(res.text) });
  } catch (err) {
    log("sheet_failed", { ref, code: err && err.code ? err.code : "error" });
    return json(502, { error: "Couldn't fetch sheet. Try Reload.", ref });
  }
}
