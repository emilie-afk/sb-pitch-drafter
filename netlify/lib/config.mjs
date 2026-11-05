// Reads and validates server-only configuration. Values never leave the
// server: callers receive either a config object or a list of *variable
// names* that are missing/invalid (names only go to logs, never to clients).

const env = (name) => {
  const v = process.env[name];
  return typeof v === "string" ? v : "";
};

const intEnv = (name, def, min, max) => {
  const raw = env(name).trim();
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || Math.floor(n) !== n || n < min || n > max) return def;
  return n;
};

// Session / login configuration. Anything missing or weak => deny everything.
export function authConfig() {
  const password = env("APP_PASSWORD");
  const secret = env("SESSION_SECRET");
  const problems = [];
  if (!password) problems.push("APP_PASSWORD");
  if (secret.length < 32 || secret === password) problems.push("SESSION_SECRET");
  if (problems.length) return { ok: false, problems };
  return {
    ok: true,
    password,
    secret,
    epoch: env("SESSION_EPOCH").trim() || "1",
    ttlSeconds: intEnv("SESSION_TTL_HOURS", 12, 1, 168) * 3600,
    login: {
      perIp: intEnv("LOGIN_MAX_ATTEMPTS_PER_IP", 10, 1, 1000),
      global: intEnv("LOGIN_MAX_ATTEMPTS_GLOBAL", 100, 1, 100000),
      windowMs: intEnv("LOGIN_WINDOW_MINUTES", 15, 1, 1440) * 60000,
    },
  };
}

const SHEET_HOST = "docs.google.com";
function isGoogleSheetUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname === SHEET_HOST &&
      /^\/spreadsheets\/d\/[A-Za-z0-9_-]{20,}\//.test(u.pathname) && !u.username && !u.password;
  } catch { return false; }
}

export function sheetConfig() {
  const url = env("SHEET_CSV_URL").trim();
  if (!isGoogleSheetUrl(url)) return { ok: false, problems: ["SHEET_CSV_URL"] };
  return { ok: true, url, budgetMs: intEnv("SHEET_BUDGET_MS", 9000, 1000, 60000), maxBytes: 5 * 1024 * 1024 };
}

// Optional: the "Open package tracker" destination. Invalid/missing => button hidden.
export function trackerUrl() {
  const url = env("PACKAGE_TRACKER_URL").trim();
  return isGoogleSheetUrl(url) ? url : null;
}

export function modelConfig(kind) {
  const apiKey = env("ANTHROPIC_API_KEY").trim();
  if (!apiKey) return { ok: false, problems: ["ANTHROPIC_API_KEY"] };
  const budgetName = kind === "assess" ? "ASSESS_BUDGET_MS" : "DRAFT_BUDGET_MS";
  return {
    ok: true,
    apiKey,
    model: env("ANTHROPIC_MODEL").trim() || "claude-haiku-4-5-20251001",
    budgetMs: intEnv(budgetName, 24000, 2000, 120000),
  };
}

export function draftLimits() {
  return {
    perSession: intEnv("DRAFT_MAX_PER_SESSION", 40, 1, 10000),
    global: intEnv("DRAFT_MAX_GLOBAL", 200, 1, 100000),
    windowMs: intEnv("DRAFT_WINDOW_MINUTES", 60, 1, 1440) * 60000,
  };
}

// Machine credential for the Apps Script brand-fit integration. Only valid
// for /api/assess. ASSESSMENT_SECRET_NEXT allows rotation without downtime.
export function assessConfig() {
  const current = env("ASSESSMENT_SECRET");
  const next = env("ASSESSMENT_SECRET_NEXT");
  const secrets = [current, next].filter((s) => s.length >= 16);
  if (current.length < 16) return { ok: false, problems: ["ASSESSMENT_SECRET"] };
  return {
    ok: true,
    secrets,
    max: intEnv("ASSESS_MAX_CALLS", 60, 1, 100000),
    windowMs: intEnv("ASSESS_WINDOW_MINUTES", 60, 1, 1440) * 60000,
  };
}

export function promptPackKey() {
  const k = env("PROMPT_PACK_KEY").trim();
  return /^[A-Za-z0-9/_.-]{1,200}$/.test(k) ? k : "prompt-pack/active";
}
