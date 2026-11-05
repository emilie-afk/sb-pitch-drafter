// Outbound HTTP with one overall deadline that also covers body reads,
// byte caps, host allowlists and validated redirects.

export class UpstreamError extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}

function hostAllowed(url, allow) {
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const h = url.hostname.toLowerCase();
  return allow.some((rule) => (rule.startsWith("*.") ? h.endsWith(rule.slice(1)) && h.length > rule.length - 1 : h === rule));
}

async function readCapped(res, maxBytes, signal) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  const onAbort = () => reader.cancel().catch(() => {});
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new UpstreamError("deadline");
      const { done, value } = await reader.read();
      if (signal.aborted) throw new UpstreamError("deadline");
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { reader.cancel().catch(() => {}); throw new UpstreamError("too_large"); }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
}

// deadline: absolute ms timestamp shared by every attempt and body read.
export async function fetchText(url, { method = "GET", headers, body, allow, maxBytes, deadline, maxRedirects = 3 }) {
  let current = new URL(url);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    if (!hostAllowed(current, allow)) throw new UpstreamError("host_blocked");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new UpstreamError("deadline");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), remaining);
    try {
      let res;
      try {
        res = await fetch(current, { method, headers, body, redirect: "manual", signal: ctrl.signal });
      } catch {
        throw new UpstreamError(ctrl.signal.aborted ? "deadline" : "network");
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get("location");
        try { await res.body?.cancel(); } catch { /* ignore */ }
        if (!loc) throw new UpstreamError("bad_redirect", res.status);
        current = new URL(loc, current);
        if (res.status === 303) { method = "GET"; body = undefined; }
        continue;
      }
      const text = await readCapped(res, maxBytes, ctrl.signal);
      return { status: res.status, ok: res.ok, text };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new UpstreamError("too_many_redirects");
}
