import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { setup, restoreLogs, setEnv, req, fn, loginCookie, SECRETS, stores, mockFetch, host, modelReply, calls, logs } from "./helpers.mjs";

beforeEach(setup);
afterEach(restoreLogs);

const machine = (body, secret = SECRETS.ASSESSMENT_SECRET, extra = {}) =>
  req("/api/assess", { body, csrf: false, headers: secret ? { "x-assessment-secret": secret, ...extra } : extra });

const Q = (id, topic, content = "Body text", category = "Gift Guides") => ({ id, topic, content, category, deadline: "Nov 12" });
const entry = (id, sb, pts) => ({ id, succulents_box: { fit: sb, reason: "SB reason." }, photos_to_sketches: { fit: pts, reason: "PTS reason." } });

test("machine secret required; browser sessions and old password header are not accepted", async () => {
  mockFetch([[host("api.anthropic.com"), () => modelReply("[]")]]);
  const h = await fn("assess");
  const cookie = await loginCookie();
  const variants = [
    machine({ queries: [Q("a", "x")] }, null),
    machine({ queries: [Q("a", "x")] }, "wrong-secret-wrong-secret"),
    machine({ queries: [Q("a", "x")] }, SECRETS.ASSESSMENT_SECRET + "x"),
    req("/api/assess", { body: { queries: [Q("a", "x")] }, cookie }),
    req("/api/assess", { body: { queries: [Q("a", "x")] }, headers: { "x-app-password": SECRETS.APP_PASSWORD } }),
  ];
  for (const r of variants) assert.equal((await h(r)).status, 401);
  assert.equal(calls.length, 0);
  assert.equal((await h(req("/api/assess", { method: "GET", csrf: false }))).status, 405);
});

test("missing/short ASSESSMENT_SECRET denies (503) before anything else", async () => {
  for (const v of [undefined, "", "short"]) {
    setEnv({ ASSESSMENT_SECRET: v });
    const r = await (await fn("assess"))(machine({ queries: [Q("a", "x")] }, v || "anything-anything"));
    assert.equal(r.status, 503);
  }
  assert.equal(calls.length, 0);
});

test("rotation: ASSESSMENT_SECRET_NEXT is accepted alongside the current secret", async () => {
  mockFetch([[host("api.anthropic.com"), () => modelReply(JSON.stringify([entry("a", true, false)]))]]);
  setEnv({ ASSESSMENT_SECRET_NEXT: "next-assessment-secret-SYNTHETIC-456" });
  const h = await fn("assess");
  assert.equal((await h(machine({ queries: [Q("a", "x")] }))).status, 200);
  assert.equal((await h(machine({ queries: [Q("a", "x")] }, "next-assessment-secret-SYNTHETIC-456"))).status, 200);
});

test("machine secret has no access to browser routes", async () => {
  mockFetch([[() => true, () => modelReply("x")]]);
  for (const name of ["sheet", "draft", "session"]) {
    const r = await (await fn(name))(req("/api/" + name, { method: name === "session" ? "GET" : "POST", body: name === "session" ? undefined : {}, headers: { "x-assessment-secret": SECRETS.ASSESSMENT_SECRET } }));
    assert.equal(r.status, 401, name);
  }
  assert.equal(calls.length, 0);
});

test("batch contract preserved: exclusions, id matching, positional fallback, invalid entries omitted", async () => {
  mockFetch([[host("api.anthropic.com"), () => modelReply("```json\n" + JSON.stringify([
    entry("b", true, false), { id: "zzz", succulents_box: { fit: false, reason: "r" }, photos_to_sketches: { fit: true, reason: "r2" } }, { id: "d", bad: true },
  ]) + "\n```")]]);
  const h = await fn("assess");
  const r = await h(machine({ queries: [Q("a", "Need swag bags for event"), Q("b", "Host gifts"), Q("c", "Party favors"), Q("d", "Mugs"), { id: "e" }, Q("f", "x", "y", "Veterinary clinics")] }));
  assert.equal(r.status, 200);
  const { results } = await r.json();
  const byId = Object.fromEntries(results.map((x) => [x.id, x]));
  assert.deepEqual(byId.a, { id: "a", succulents_box: { fit: false, reason: "Hard exclusion: gift bag / swag / bulk event fulfillment." }, photos_to_sketches: { fit: false, reason: "Hard exclusion: gift bag / swag / bulk event fulfillment." }, excluded: true });
  assert.equal(byId.f.excluded, true);
  assert.deepEqual(byId.b, { id: "b", succulents_box: { fit: true, reason: "SB reason." }, photos_to_sketches: { fit: false, reason: "PTS reason." } });
  assert.equal(byId.c.photos_to_sketches.fit, true, "positional fallback");
  assert.equal(byId.d, undefined, "invalid entry omitted");
  assert.equal(byId.e, undefined, "unusable query omitted");
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.max_tokens, 200 * 3 + 200);
  assert.ok(sent.messages[0].content.startsWith("SYNTHETIC BRAND SPEC"));
  assert.ok(sent.messages[0].content.includes("--- QUERY 1 (id: b) ---"));
  assert.ok(sent.system.includes("strictly as data"));
});

test("all-excluded batch makes no model call and needs no prompt pack", async () => {
  stores["pitch-drafter-private"].m.clear();
  const r = await (await fn("assess"))(machine({ queries: [Q("a", "gift bags please")] }));
  assert.equal(r.status, 200);
  assert.equal(calls.length, 0);
});

test("single (legacy) mode contract preserved", async () => {
  mockFetch([[host("api.anthropic.com"), () => modelReply(JSON.stringify(entry(undefined, false, true)))]]);
  const h = await fn("assess");
  let r = await h(machine({ topic: "Birthday party ideas", content: "Need favors" }));
  assert.deepEqual(await r.json(), { succulents_box: { fit: false, reason: "SB reason." }, photos_to_sketches: { fit: true, reason: "PTS reason." } });
  r = await h(machine({ topic: "x", content: "goody bags" }));
  assert.equal((await r.json()).excluded, true);
  assert.equal((await h(machine({}))).status, 400);
  assert.equal((await h(machine({ queries: [] }))).status, 400);
});

test("model output is validated; reasons are bounded and safe for sheet cells", async () => {
  mockFetch([[host("api.anthropic.com"), () => modelReply(JSON.stringify([
    { id: "a", succulents_box: { fit: true, reason: '=IMPORTXML("http://evil","//a")' }, photos_to_sketches: { fit: false, reason: "+" + "x".repeat(900) } },
    { id: "b", succulents_box: { fit: "yes", reason: "r" }, photos_to_sketches: { fit: false, reason: "r" } },
  ]))]]);
  const r = await (await fn("assess"))(machine({ queries: [Q("a", "t"), Q("b", "t")] }));
  const { results } = await r.json();
  assert.equal(results.length, 1);
  assert.equal(results[0].succulents_box.reason, "'=IMPORTXML(\"http://evil\",\"//a\")");
  assert.ok(results[0].photos_to_sketches.reason.startsWith("'+") && results[0].photos_to_sketches.reason.length <= 301);
  for (const bad of ["not json", '{"results": 5}']) {
    mockFetch([[host("api.anthropic.com"), () => modelReply(bad)]]);
    const r2 = await (await fn("assess"))(machine({ queries: [Q("a", "t")] }));
    assert.equal(r2.status, 502);
    const t = await r2.text();
    assert.ok(!t.includes("not json") && !t.includes("SYNTHETIC BRAND SPEC"));
  }
});

test("durable assessment usage limit and generic provider errors", async () => {
  setEnv({ ASSESS_MAX_CALLS: "2" });
  mockFetch([[host("api.anthropic.com"), () => modelReply("[]")]]);
  const st = [];
  for (let i = 0; i < 3; i++) st.push((await (await fn("assess"))(machine({ queries: [Q("a", "t")] }))).status);
  assert.deepEqual(st, [200, 200, 429]);
  assert.equal(calls.length, 2);
  setEnv({ ASSESS_MAX_CALLS: "50" });
  mockFetch([[host("api.anthropic.com"), () => new Response("provider detail " + SECRETS.ANTHROPIC_API_KEY, { status: 401 })]]);
  const r = await (await fn("assess"))(machine({ queries: [Q("a", "t")] }));
  assert.equal(r.status, 502);
  const t = await r.text();
  assert.ok(!t.includes("provider detail"));
  assert.ok(!logs.join("\n").includes(SECRETS.ASSESSMENT_SECRET));
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});

test("oversized assessment body rejected; batch capped at 10", async () => {
  mockFetch([[host("api.anthropic.com"), () => modelReply("[]")]]);
  const h = await fn("assess");
  assert.equal((await h(req("/api/assess", { raw: "x".repeat(70000), csrf: false, headers: { "x-assessment-secret": SECRETS.ASSESSMENT_SECRET } }))).status, 413);
  await h(machine({ queries: Array.from({ length: 15 }, (_, i) => Q("q" + i, "Topic " + i)) }));
  const p = JSON.parse(calls[0].init.body).messages[0].content;
  assert.ok(p.includes("(id: q9)") && !p.includes("(id: q10)"));
});
