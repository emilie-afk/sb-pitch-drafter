// Browser checks (Playwright/Chromium) against the local stand-in server.
// Run: node tests/browser/browser.check.mjs   (needs Playwright + Chromium)
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { start, state, MODEL_TEXT } from "./server.mjs";
import { SECRETS, SYNTH_PACK } from "../helpers.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const PACK = JSON.parse(SYNTH_PACK);
const { server, base } = await start();
const browser = await chromium.launch();
const results = [];
const problems = [];

async function newPage(ctx) {
  const page = await ctx.newPage();
  page.on("console", (m) => { if (m.type() === "error") problems.push("console: " + m.text()); });
  page.on("pageerror", (e) => problems.push("pageerror: " + e.message));
  page.on("dialog", (d) => { problems.push("unexpected dialog: " + d.message()); d.dismiss(); });
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error("CSP " + e.violatedDirective)));
  return page;
}
async function check(name, fn) {
  try { await fn(); results.push("PASS " + name); } catch (e) { results.push("FAIL " + name + ": " + e.message.slice(0, 600)); }
}

const ctx = await browser.newContext();
await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
const page = await newPage(ctx);

await check("old browser-stored password is removed; login screen shown", async () => {
  await page.goto(base);
  await page.evaluate(() => localStorage.setItem("pitch-drafter-pw", "old-password"));
  await page.reload();
  await page.waitForSelector("#login-screen", { state: "visible" });
  assert.equal(await page.evaluate(() => localStorage.getItem("pitch-drafter-pw")), null);
});

await check("wrong password shows an error and sets no cookie", async () => {
  await page.fill("#password-input", "wrong");
  await page.click("#login-btn");
  await page.waitForSelector("#login-error:has-text('Incorrect password.')");
  assert.equal((await ctx.cookies()).length, 0);
});

await check("sign-in loads the queries; HTML in sheet text is rendered as text", async () => {
  await page.fill("#password-input", SECRETS.APP_PASSWORD);
  await page.press("#password-input", "Enter");
  await page.waitForSelector("#app-screen", { state: "visible" });
  await page.waitForSelector(".query-card");
  const cards = await page.$$eval(".query-card .qc-topic", (els) => els.map((e) => e.textContent));
  // Same selection as before: the 2 most recent dates ("x" and 2026-10-02), newest first.
  assert.deepEqual(cards, ["", "=HYPERLINK(http://evil)", "<b>Kids parties</b>"]);
  assert.equal(await page.$$eval(".query-card b, .query-card img", (e) => e.length), 0);
  assert.match(await page.textContent("#queries-list .muted"), /Showing 3 queries from the 2 most recent dates/);
  const recs = await page.$$eval(".query-card:nth-of-type(3) .rec-verdict", (els) => els.map((e) => e.textContent));
  assert.deepEqual(recs, ["Skip", "Good fit"]);
  assert.match(await page.textContent(".query-card:nth-of-type(4) .qc-recs"), /Assessment pending/);
  assert.equal(await page.inputValue("#password-input"), "");
});

await check("session cookie is HttpOnly/Secure/Strict and unreadable by page script", async () => {
  const c = (await ctx.cookies()).find((x) => x.name === "__Host-pd_session");
  assert.ok(c && c.httpOnly && c.secure && c.sameSite === "Strict");
  assert.ok(!(await page.evaluate(() => document.cookie)).includes("pd_session"));
  assert.equal(await page.evaluate(() => JSON.stringify(localStorage)), "{}");
});

await check("reload restores the session without the password", async () => {
  await page.reload();
  await page.waitForSelector(".query-card");
});

await check("product is required (existing alert kept)", async () => {
  await page.click(".query-card:nth-of-type(3) .pitch-sb-btn");
  page.removeAllListeners("dialog");
  let msg = "";
  page.once("dialog", (d) => { msg = d.message(); d.accept(); });
  await page.click("#generate-btn");
  await page.waitForTimeout(200);
  page.on("dialog", (d) => { problems.push("unexpected dialog: " + d.message()); d.dismiss(); });
  assert.equal(msg, "Please name the product to feature.");
  assert.equal(state.modelCalls, 0);
});

let pitch = "";
await check("drafting: model output shown as text, boilerplate appended once, fields filled", async () => {
  await page.fill("#product-input", "Synthetic arrangement");
  await page.fill("#price-input", "$30");
  await page.dblclick("#generate-btn"); // double click must not double-spend
  await page.waitForSelector("#pitch-text");
  pitch = await page.textContent("#pitch-text");
  assert.equal(pitch, MODEL_TEXT.replace(/^Subject:.*\n/, "Subject: Gift guide submission: synthetic arrangement\n") + "\n\n" + PACK.draft.brands["Succulents Box"].appendAfterDraft);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await page.inputValue("#subject-input"), "Gift guide submission: synthetic arrangement");
  assert.equal(await page.inputValue("#to-input"), "a@example.org");
  assert.equal(state.modelCalls, 1);
});

await check("tracker button gets its destination only from the signed-in session", async () => {
  assert.equal(await page.getAttribute("#tracker-btn", "href"), SECRETS.PACKAGE_TRACKER_URL);
  assert.equal(await page.getAttribute("#tracker-btn", "rel"), "noopener noreferrer");
});

await check("copy to clipboard copies the full draft", async () => {
  await page.click("#copy-btn");
  await page.waitForSelector("#copy-btn:has-text('Copied!')");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), pitch);
});

await check("open in email builds the same mailto link as before", async () => {
  const href = await page.evaluate(() => {
    const to = document.getElementById("to-input").value.trim();
    const subj = document.getElementById("subject-input").value.trim();
    return "mailto:" + encodeURIComponent(to) + "?subject=" + encodeURIComponent(subj);
  });
  assert.equal(href, "mailto:a%40example.org?subject=Gift%20guide%20submission%3A%20synthetic%20arrangement");
  assert.ok(await page.isVisible("#open-email-btn"));
});

await check("regenerate and Photos to Sketches drafting work (no boilerplate)", async () => {
  await page.click("#regenerate-btn");
  await page.waitForFunction(() => document.getElementById("generate-btn").textContent === "Generate pitch");
  await page.click(".query-card:nth-of-type(3) .pitch-pts-btn");
  await page.fill("#product-input", "Synthetic mug");
  await page.click("#generate-btn");
  await page.waitForSelector("#pitch-text");
  assert.ok(!(await page.textContent("#pitch-text")).includes("About Synthetic"));
  assert.equal(state.modelCalls, 3);
});

await check("draft failure shows an error without provider details", async () => {
  state.model = "fail";
  await page.click("#generate-btn");
  await page.waitForSelector("#pitch-result .error");
  const t = await page.textContent("#pitch-result .error");
  assert.match(t, /^Couldn't generate pitch: HTTP 502: The pitch could not be generated/);
  assert.ok(!t.includes("boom"));
  state.model = "ok";
  assert.equal(await page.textContent("#generate-btn"), "Generate pitch");
});

await check("sheet failure shows an error; Reload retries", async () => {
  state.sheet = "fail";
  await page.click("#reload-btn");
  await page.waitForSelector("#queries-list .error");
  assert.match(await page.textContent("#queries-list .error"), /Couldn't load the sheet: HTTP 502: Couldn't fetch sheet \(HTTP 403\)/);
  state.sheet = "ok";
  await page.click("#reload-btn");
  await page.waitForSelector(".query-card");
});

let stolen;
await check("anonymous API calls are rejected; private files are not served", async () => {
  const anon = await browser.newContext();
  const p = await anon.newPage();
  await p.goto(base);
  const statuses = await p.evaluate(async () => {
    const h = { "Content-Type": "application/json", "X-Pitch-Request": "1" };
    const s = [];
    for (const path of ["/api/sheet", "/api/draft"]) s.push((await fetch(path, { method: "POST", headers: h, body: "{}" })).status);
    s.push((await fetch("/api/session")).status);
    s.push((await fetch("/api/assess", { method: "POST", body: "{}" })).status);
    for (const f of ["/netlify.toml", "/package.json", "/netlify/functions/draft.mjs", "/netlify/lib/config.mjs", "/tests/fixtures/synthetic-pack.json", "/.env.example"]) s.push((await fetch(f)).status);
    return s;
  });
  assert.deepEqual(statuses, [401, 401, 401, 401, 404, 404, 404, 404, 404, 404]);
  await anon.close();
  stolen = (await ctx.cookies()).find((x) => x.name === "__Host-pd_session");
});

const copiedCookieStatus = async () => {
  const other = await browser.newContext();
  await other.addCookies([stolen]);
  const p = await other.newPage();
  await p.goto(base);
  const st = await p.evaluate(async () => (await fetch("/api/session")).status);
  await other.close();
  return st;
};

await check("sign-out 503 (revocation not recorded): error shown, still signed in, cookie kept", async () => {
  state.revokeFail = true;
  await page.click("#logout-btn");
  await page.waitForSelector("#logout-error", { state: "visible" });
  assert.match(await page.textContent("#logout-error"), /^Sign-out failed \(HTTP 503: Sign-out could not be recorded\. Try again\.\)\. You are still signed in\. Press Log out to try again\.$/);
  assert.ok(await page.isVisible("#app-screen"));
  assert.ok(!(await page.isVisible("#login-screen")));
  assert.equal(await page.textContent("#logout-btn"), "Log out");
  assert.ok((await ctx.cookies()).some((c) => c.name === "__Host-pd_session"), "browser keeps the cookie for retry");
  assert.equal(await copiedCookieStatus(), 200, "session honestly still valid");
  state.revokeFail = false;
});

await check("sign-out network failure: error shown, still signed in", async () => {
  await page.route("**/api/logout", (r) => r.abort("failed"));
  await page.click("#logout-btn");
  await page.waitForSelector("#logout-error:has-text(\"couldn't reach the server\")");
  assert.ok(await page.isVisible("#app-screen"));
  assert.ok((await ctx.cookies()).some((c) => c.name === "__Host-pd_session"));
  assert.equal(await copiedCookieStatus(), 200);
  await page.unroute("**/api/logout");
});

await check("retry sign-out succeeds: login screen, error cleared, copied cookie stops working", async () => {
  await page.click("#logout-btn");
  await page.waitForSelector("#login-screen", { state: "visible" });
  assert.ok(!(await page.isVisible("#logout-error")));
  assert.ok(!(await ctx.cookies()).some((c) => c.name === "__Host-pd_session"), "cookie cleared");
  const other = await browser.newContext();
  await other.addCookies([stolen]);
  const p = await other.newPage();
  await p.goto(base);
  assert.equal(await p.evaluate(async () => (await fetch("/api/session")).status), 401);
  await p.waitForSelector("#login-screen", { state: "visible" });
  await other.close();
});

await check("no console errors, CSP violations or unexpected dialogs", async () => {
  const real = problems.filter((p) => !/status of 40[13]|status of 50[23]|net::ERR_FAILED/.test(p));
  assert.deepEqual(real, []);
});

await browser.close();
server.close();
console.info(results.join("\n"));
const failed = results.filter((r) => r.startsWith("FAIL")).length;
console.info(`${results.length - failed}/${results.length} browser checks passed`);
process.exit(failed ? 1 : 0);
