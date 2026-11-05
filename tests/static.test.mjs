// Deployment-exposure checks: what is published, and what tracked files contain.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { renderDraftPrompt } from "../netlify/lib/prompts.mjs";

const root = new URL("../", import.meta.url).pathname;
const read = (p) => fs.readFileSync(root + p, "utf8");

test("publish directory is public/ and contains only browser assets", () => {
  assert.match(read("netlify.toml"), /publish = "public"/);
  assert.deepEqual(fs.readdirSync(root + "public").sort(), ["app.js", "index.html", "robots.txt"]);
});

test("browser code holds no password storage, credentials, prompts or sheet locations", () => {
  const pub = read("public/index.html") + read("public/app.js");
  assert.ok(!/<script>[\s\S]*?<\/script>/.test(read("public/index.html")), "no inline script (CSP script-src 'self')");
  assert.ok(!/localStorage\.(setItem|getItem)|sessionStorage/.test(pub));
  assert.ok(!/x-app-password|x-assessment-secret|ASSESSMENT_SECRET|APP_PASSWORD|ANTHROPIC/i.test(pub));
  assert.ok(!/spreadsheets\/d\/|sk-ant-/.test(pub));
  for (const marker of ["BRAND VOICE", "PRODUCT ACCURACY RULES", "HOW TO BUILD THIS PITCH", "BRAND_EXAMPLES", "About Succulents Box", "FIT TEST", "HARD RULES"]) {
    assert.ok(!pub.includes(marker), "browser contains " + marker);
  }
  assert.ok(read("public/app.js").includes('localStorage.removeItem("pitch-drafter-pw")'), "clears old stored password");
});

test("tracked files contain no real sheet IDs, keys or prompt pack", () => {
  const files = execSync("git ls-files -co --exclude-standard", { cwd: root }).toString().split("\n").filter(Boolean)
    .filter((f) => !f.startsWith("node_modules/") && f !== "package-lock.json");
  for (const f of files) {
    const t = fs.readFileSync(root + f, "utf8");
    const ids = [...t.matchAll(/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/g)].map((m) => m[1]);
    for (const id of ids) assert.ok(id.startsWith("SYNTHETIC"), `${f} has a real-looking sheet id`);
    assert.ok(!/sk-ant-[A-Za-z0-9]/.test(t), f + " has an API key");
    assert.ok(!/PRODUCT ACCURACY RULES|BRAND_SPEC = `/.test(t) || f.startsWith("tests/"), f + " has private prompt text");
  }
  assert.ok(!files.some((f) => /prompt-pack|private\//.test(f)));
});

test("security headers: CSP without inline script, framing denied", () => {
  const toml = read("netlify.toml");
  assert.match(toml, /script-src 'self'/);
  assert.ok(!/script-src[^;"]*unsafe-inline/.test(toml));
  assert.match(toml, /frame-ancestors 'none'/);
});

test("synthetic pack renders deterministically (renderer contract)", () => {
  const pack = JSON.parse(read("tests/fixtures/synthetic-pack.json"));
  const out = renderDraftPrompt(pack, "Photos to Sketches",
    { name: "Ana Lee", outlet: "", deadlineDate: "Nov 12", deadlineTime: "", tz: "PT", summary: "S", queryText: "Q" },
    { product: "Mug", link: "", price: "" });
  assert.equal(out, [
    "SYNTHETIC TEMPLATE for Photos to Sketches", "INTRO Synthetic gift shop.", "CATALOG Gamma", "PRODUCT Mug", "LINK not provided",
    "PRICE not provided", "OUTLET not provided", "JOURNALIST Ana Lee", "GREETING Hi Ana,", "DEADLINE Nov 12 PT", "TOPIC S", "QUERY Q",
    "RULE Synthetic link rule B.", "SAMPLE before your Nov 12 deadline", "VOICE", "- Synthetic voice two.", "\nSYNTHETIC SECTION\n- line x",
    "LENGTH Synthetic short length.", "", "SYNTHETIC PHOTOS TO SKETCHES EXAMPLES:\nEXAMPLE 1\n---\nSynthetic example B1\n---\n\nEXAMPLE 2\n---\nSynthetic example B2\n---\nSynthetic usage:\n- Synthetic guidance B.", "END",
  ].join("\n"));
});
