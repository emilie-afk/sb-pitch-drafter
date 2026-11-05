import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  setup, restoreLogs, setEnv, req, ctx, fn, cookieFrom, loginCookie, SECRETS, stores, upstreamCalls, logs,
} from "./helpers.mjs";

beforeEach(setup);
afterEach(restoreLogs);

const session = async (cookie) => (await fn("session"))(req("/api/session", { method: "GET", cookie, csrf: false }));

test("missing or weak security config denies every browser endpoint (503), no upstream calls", async () => {
  for (const env of [{ APP_PASSWORD: undefined }, { SESSION_SECRET: undefined }, { SESSION_SECRET: "short" },
    { SESSION_SECRET: SECRETS.APP_PASSWORD.padEnd(40, "x"), APP_PASSWORD: SECRETS.APP_PASSWORD.padEnd(40, "x") }]) {
    setEnv(env);
    const l = await (await fn("login"))(req("/api/login", { body: { password: SECRETS.APP_PASSWORD } }), ctx());
    assert.equal(l.status, 503);
    assert.equal(l.headers.get("set-cookie"), null);
    for (const name of ["sheet", "draft"]) {
      const r = await (await fn(name))(req("/api/" + name, { body: {}, cookie: "__Host-pd_session=x.y" }));
      assert.equal(r.status, 503, name);
    }
    assert.equal((await session("__Host-pd_session=x.y")).status, 503);
  }
  assert.equal(upstreamCalls().length, 0);
  assert.ok(logs.some((l) => l.includes("auth_not_configured")));
});

test("login: wrong password 401 without cookie; right password sets a hardened cookie", async () => {
  const login = await fn("login");
  const bad = await login(req("/api/login", { body: { password: "nope" } }), ctx());
  assert.equal(bad.status, 401);
  assert.equal(bad.headers.get("set-cookie"), null);
  const ok = await login(req("/api/login", { body: { password: SECRETS.APP_PASSWORD } }), ctx());
  assert.equal(ok.status, 200);
  const sc = ok.headers.get("set-cookie");
  assert.match(sc, /^__Host-pd_session=[^;]+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/);
  assert.ok(!sc.includes(SECRETS.APP_PASSWORD));
  assert.equal(ok.headers.get("cache-control"), "no-store, private");
  assert.equal(ok.headers.get("access-control-allow-origin"), null);
  const body = await ok.text();
  assert.ok(!body.includes(SECRETS.APP_PASSWORD) && !body.includes(SECRETS.SESSION_SECRET));
});

test("login validates method, CSRF, body shape and size", async () => {
  const login = await fn("login");
  assert.equal((await login(req("/api/login", { method: "GET", csrf: false }), ctx())).status, 405);
  assert.equal((await login(req("/api/login", { body: { password: SECRETS.APP_PASSWORD }, csrf: false }), ctx())).status, 403);
  assert.equal((await login(req("/api/login", { body: { password: SECRETS.APP_PASSWORD }, headers: { origin: "https://evil.test" } }), ctx())).status, 403);
  assert.equal((await login(req("/api/login", { body: { password: SECRETS.APP_PASSWORD }, headers: { "sec-fetch-site": "cross-site" } }), ctx())).status, 403);
  assert.equal((await login(req("/api/login", { body: { password: SECRETS.APP_PASSWORD, admin: true } }), ctx())).status, 400);
  assert.equal((await login(req("/api/login", { body: { password: 123 } }), ctx())).status, 400);
  assert.equal((await login(req("/api/login", { raw: "{" + "x".repeat(2000) }), ctx())).status, 413);
  assert.equal((await login(req("/api/login", { raw: "not json" }), ctx())).status, 400);
});

test("session restore, logout revocation, copied cookie rejected afterwards", async () => {
  const cookie = await loginCookie();
  const s = await session(cookie);
  assert.equal(s.status, 200);
  const j = await s.json();
  assert.equal(j.authenticated, true);
  assert.equal(j.trackerUrl, SECRETS.PACKAGE_TRACKER_URL);
  const out = await (await fn("logout"))(req("/api/logout", { cookie }));
  assert.equal(out.status, 200);
  assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await session(cookie)).status, 401, "revoked cookie must be rejected");
  assert.equal((await (await fn("logout"))(req("/api/logout", { cookie, csrf: false }))).status, 403);
});

test("tracker URL is only given to signed-in users and hidden when misconfigured", async () => {
  assert.equal((await session()).status, 401);
  const anon = await (await session()).text();
  assert.ok(!anon.includes("docs.google.com"));
  setEnv({ PACKAGE_TRACKER_URL: "javascript:alert(1)" });
  const cookie = await loginCookie();
  assert.equal((await (await session(cookie)).json()).trackerUrl, null);
});

test("forged, tampered, expired, wrong-epoch and old-password sessions are rejected", async () => {
  const cookie = await loginCookie();
  const token = cookie.split("=")[1];
  const [body, sig] = token.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url"));
  const sign = (p, secret = SECRETS.SESSION_SECRET) => {
    const b = Buffer.from(JSON.stringify(p)).toString("base64url");
    return "__Host-pd_session=" + b + "." + createHmac("sha256", secret).update("session:" + b).digest("base64url");
  };
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    garbage: "__Host-pd_session=abc",
    noSig: "__Host-pd_session=" + body,
    tamperedPayload: "__Host-pd_session=" + Buffer.from(JSON.stringify({ ...payload, exp: payload.exp + 999 })).toString("base64url") + "." + sig,
    wrongSecret: sign(payload, "another-secret-another-secret-another-secret"),
    expired: sign({ ...payload, iat: now - 1000, exp: now - 10 }),
    overLong: sign({ ...payload, exp: payload.iat + 999999 }),
    wrongEpoch: sign({ ...payload, ep: "0" }),
    wrongFingerprint: sign({ ...payload, pf: "x".repeat(22) }),
  };
  for (const [name, c] of Object.entries(cases)) assert.equal((await session(c)).status, 401, name);
  assert.equal((await session(cookie)).status, 200);
  // Password change revokes all existing sessions.
  setEnv({ APP_PASSWORD: "a brand new password" });
  assert.equal((await session(cookie)).status, 401, "old-password session");
  // Epoch change revokes all sessions.
  setEnv({ SESSION_EPOCH: "2" });
  const c2 = await loginCookie();
  setEnv({ SESSION_EPOCH: "3" });
  assert.equal((await session(c2)).status, 401, "epoch bump");
  // Secret rotation revokes all sessions.
  setEnv();
  const c3 = await loginCookie();
  setEnv({ SESSION_SECRET: "rotated-secret-rotated-secret-rotated-secret!" });
  assert.equal((await session(c3)).status, 401, "secret rotation");
});

test("browser flags, old password header and identities don't grant access", async () => {
  const s = await fn("session");
  const variants = [
    req("/api/session", { method: "GET", csrf: false, headers: { "x-app-password": SECRETS.APP_PASSWORD } }),
    req("/api/session", { method: "GET", csrf: false, cookie: "authenticated=true; user=owner; __Host-pd_session=" }),
    req("/api/session", { method: "GET", csrf: false, headers: { authorization: "Bearer " + SECRETS.SESSION_SECRET } }),
    req("/api/session", { method: "GET", csrf: false, headers: { "x-assessment-secret": SECRETS.ASSESSMENT_SECRET } }),
  ];
  for (const r of variants) assert.equal((await s(r)).status, 401);
});

test("session store outage fails closed (503)", async () => {
  const cookie = await loginCookie();
  stores["pitch-drafter-security"].fail = true;
  assert.equal((await session(cookie)).status, 503);
  const l = await (await fn("login"))(req("/api/login", { body: { password: SECRETS.APP_PASSWORD } }), ctx());
  assert.equal(l.status, 503);
  assert.equal(l.headers.get("set-cookie"), null);
});

test("durable login limits hold across parallel separate instances", async () => {
  setEnv({ LOGIN_MAX_ATTEMPTS_PER_IP: "5" });
  const instances = await Promise.all([1, 2, 3, 4].map(() => fn("login")));
  const results = await Promise.all(Array.from({ length: 16 }, (_, i) =>
    instances[i % 4](req("/api/login", { body: { password: "wrong-" + i } }), ctx("198.51.100.9"))));
  const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
  assert.deepEqual(counts, { 401: 5, 429: 11 });
  // Even the right password is refused while limited; another IP still works.
  const blocked = await instances[0](req("/api/login", { body: { password: SECRETS.APP_PASSWORD } }), ctx("198.51.100.9"));
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers.get("retry-after"));
  assert.equal((await instances[1](req("/api/login", { body: { password: SECRETS.APP_PASSWORD } }), ctx("198.51.100.10"))).status, 200);
  // IPs are stored only as keyed hashes.
  const keys = [...stores["pitch-drafter-security"].m.keys()].join(" ");
  assert.ok(!keys.includes("198.51.100"));
});

test("global login limit and window expiry", async () => {
  setEnv({ LOGIN_MAX_ATTEMPTS_GLOBAL: "3", LOGIN_MAX_ATTEMPTS_PER_IP: "100" });
  const login = await fn("login");
  const st = [];
  for (let i = 0; i < 5; i++) st.push((await login(req("/api/login", { body: { password: "x" } }), ctx("192.0.2." + i))).status);
  assert.deepEqual(st, [401, 401, 401, 429, 429]);
  // Expire the window.
  const store = stores["pitch-drafter-security"];
  const e = store.m.get("login/global");
  store.m.set("login/global", { ...e, v: JSON.stringify({ count: 3, reset: Date.now() - 1 }) });
  assert.equal((await login(req("/api/login", { body: { password: SECRETS.APP_PASSWORD } }), ctx("192.0.2.50"))).status, 200);
});

test("logout: failed revocation returns 503 and keeps the cookie; retry revokes it", async () => {
  const cookie = await loginCookie();
  const logout = await fn("logout");
  stores["pitch-drafter-security"].fail = true;
  const failed = await logout(req("/api/logout", { cookie }));
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get("set-cookie"), null, "cookie must not be cleared when revocation failed");
  stores["pitch-drafter-security"].fail = false;
  assert.equal((await session(cookie)).status, 200, "session is honestly still valid");
  const retry = await logout(req("/api/logout", { cookie }));
  assert.equal(retry.status, 200);
  assert.match(retry.headers.get("set-cookie"), /Max-Age=0/);
  assert.equal((await session(cookie)).status, 401, "copied cookie invalid after successful retry");
});

test("logout: misconfigured server returns 503 without clearing the cookie", async () => {
  const cookie = await loginCookie();
  setEnv({ SESSION_SECRET: undefined });
  const r = await (await fn("logout"))(req("/api/logout", { cookie }));
  assert.equal(r.status, 503);
  assert.equal(r.headers.get("set-cookie"), null);
});
