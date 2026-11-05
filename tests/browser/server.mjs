// Local stand-in for Netlify: serves public/ with the netlify.toml headers and
// routes /api/* to the real function handlers. Upstreams (sheet, Anthropic)
// are mocked with synthetic data; nothing leaves this machine.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { MemStore, SECRETS, SYNTH_PACK } from "../helpers.mjs";
import { __setStoreFactory } from "../../netlify/lib/store.mjs";

const root = new URL("../../", import.meta.url).pathname;
const toml = fs.readFileSync(root + "netlify.toml", "utf8");
const header = (name) => toml.match(new RegExp(name + ' = "([^"]+)"'))[1];
const STATIC_HEADERS = {
  "Content-Security-Policy": header("Content-Security-Policy"),
  "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
};

export const state = { sheet: "ok", model: "ok", modelCalls: 0, sheetCalls: 0, revokeFail: false };
const CSV = fs.readFileSync(root + "tests/fixtures/tracker.csv", "utf8");
export const MODEL_TEXT = "Subject: Gift guide submission: synthetic arrangement\n\nHi Pat,\n\nI'd love to submit <b>this</b> <script>window.__xss=1</script> for your guide.\n\nWarm regards,\n[Your Name]\nSucculents Box";

export async function start() {
  Object.assign(process.env, SECRETS);
  const stores = {};
  __setStoreFactory((n) => (stores[n] ||= new MemStore()));
  // Simulated Blobs outage for session revocation writes only.
  const sec = (stores["pitch-drafter-security"] = new MemStore());
  const setJSON = sec.setJSON.bind(sec);
  sec.setJSON = async (k, v, o) => {
    if (state.revokeFail && k.startsWith("revoked/")) throw new Error("store down");
    return setJSON(k, v, o);
  };
  (stores["pitch-drafter-private"] ||= new MemStore()).m.set("prompt-pack/active", { v: SYNTH_PACK, etag: '"1"' });
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    if (u.hostname === "docs.google.com") {
      state.sheetCalls++;
      return state.sheet === "ok" ? new Response(CSV) : new Response("no", { status: 403 });
    }
    if (u.hostname === "api.anthropic.com") {
      state.modelCalls++;
      await new Promise((r) => setTimeout(r, 150));
      return state.model === "ok"
        ? new Response(JSON.stringify({ content: [{ type: "text", text: MODEL_TEXT }] }))
        : new Response("boom", { status: 500 });
    }
    throw new TypeError("blocked " + u.hostname);
  };
  const fns = {};
  for (const n of ["login", "logout", "session", "sheet", "draft", "assess"]) fns[n] = (await import(`../../netlify/functions/${n}.mjs`)).default;
  console.log = () => {};

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://" + req.headers.host);
    const m = url.pathname.match(/^\/(?:api|\.netlify\/functions)\/([a-z]+)$/);
    if (m) {
      const h = fns[m[1]];
      if (!h) { res.writeHead(404); return res.end(); }
      const chunks = []; for await (const c of req) chunks.push(c);
      const r = await h(new Request(url, { method: req.method, headers: req.headers, body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) }), { ip: "127.0.0.1" });
      const hdrs = {}; r.headers.forEach((v, k) => { hdrs[k] = v; });
      const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
      if (sc.length) hdrs["set-cookie"] = sc;
      res.writeHead(r.status, hdrs);
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = path.join(root, "public", path.normalize(rel));
    if (!file.startsWith(path.join(root, "public")) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("not found"); }
    const type = file.endsWith(".js") ? "text/javascript" : file.endsWith(".html") ? "text/html; charset=utf-8" : "text/plain";
    res.writeHead(200, { ...STATIC_HEADERS, "Content-Type": type, "Cache-Control": "no-cache" });
    res.end(fs.readFileSync(file));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: "http://localhost:" + server.address().port };
}
