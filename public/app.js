"use strict";
// Daily Pitch Drafter browser code. Holds no password, no credentials, no
// prompts and no sheet locations: the server keeps all of those private and
// the browser only holds an HttpOnly session cookie it cannot read.

// Remove the password that older versions kept in browser storage.
try { localStorage.removeItem("pitch-drafter-pw"); } catch (e) { /* storage unavailable */ }

let selectedQuery = null;
let selectedBrand = null;
let trackerUrl = null;

function escapeHtml(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, function(c) {
    return ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[c];
  });
}

function todayDateISO() {
  const d = new Date();
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}

function tsToLocalDateISO(ts) {
  const seconds = parseFloat(ts);
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  return d.getFullYear() + "-" + String(d.getMonth()+1).padStart(2,"0") + "-" + String(d.getDate()).padStart(2,"0");
}

const CSRF = { "X-Pitch-Request": "1" };

async function errorText(resp) {
  let msg = "";
  try { const j = await resp.json(); msg = (j && j.error) || ""; } catch (e) { /* not JSON */ }
  return "HTTP " + resp.status + (msg ? ": " + msg : "");
}

async function callApi(path, body, timeoutMs) {
  // Hard timeout so a hanging API call never leaves the UI stuck.
  timeoutMs = timeoutMs || 30000;
  const controller = new AbortController();
  const timer = setTimeout(function() { controller.abort(); }, timeoutMs);
  let resp;
  try {
    resp = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: Object.assign({ "Content-Type": "application/json" }, CSRF),
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      throw new Error("Request timed out after " + Math.round(timeoutMs/1000) + "s");
    }
    throw err;
  }
  clearTimeout(timer);
  if (resp.status === 401) {
    showLogin("Session expired. Please log in again.");
    throw new Error("Unauthorized");
  }
  if (!resp.ok) throw new Error(await errorText(resp));
  return resp.json();
}

async function callDraftApi(payload) {
  const data = await callApi("/api/draft", payload);
  return data.text || "";
}

async function callSheetApi() {
  const data = await callApi("/api/sheet", {});
  return data.messages || [];
}

function showLogin(errorMsg) {
  document.getElementById("login-screen").style.display = "block";
  document.getElementById("app-screen").style.display = "none";
  const err = document.getElementById("login-error");
  if (errorMsg) { err.textContent = errorMsg; err.style.display = "block"; }
  else { err.style.display = "none"; }
}

function showApp() {
  document.getElementById("login-screen").style.display = "none";
  document.getElementById("app-screen").style.display = "block";
  loadQueries();
}

// Returns "ok", "bad", or an error message to show.
async function tryLogin(password) {
  try {
    const resp = await fetch("/api/login", {
      method: "POST",
      credentials: "same-origin",
      headers: Object.assign({ "Content-Type": "application/json" }, CSRF),
      body: JSON.stringify({ password: password }),
    });
    if (resp.status === 200) return "ok";
    if (resp.status === 401) return "bad";
    if (resp.status === 429) return "Too many attempts. Please wait a few minutes and try again.";
    if (resp.status === 503) return "The app is not configured correctly. Contact the site owner.";
    return "Login failed (HTTP " + resp.status + "). Try again.";
  } catch (e) { return "Couldn't reach the server. Check your connection and try again."; }
}

async function restoreSession() {
  try {
    const resp = await fetch("/api/session", { credentials: "same-origin", cache: "no-store" });
    if (resp.status !== 200) return false;
    const data = await resp.json();
    trackerUrl = data && typeof data.trackerUrl === "string" ? data.trackerUrl : null;
    return true;
  } catch (e) { return false; }
}

document.getElementById("login-btn").addEventListener("click", async function() {
  const input = document.getElementById("password-input");
  const pw = input.value;
  if (!pw) return;
  const btn = this;
  btn.disabled = true; btn.textContent = "Checking...";
  const result = await tryLogin(pw);
  let restored = false;
  if (result === "ok") restored = await restoreSession();
  btn.disabled = false; btn.textContent = "Unlock";
  if (result === "ok" && restored) { input.value = ""; showApp(); }
  else {
    const err = document.getElementById("login-error");
    err.textContent = result === "bad" ? "Incorrect password." : (result === "ok" ? "Couldn't start a session. Make sure cookies are allowed for this site." : result);
    err.style.display = "block";
  }
});
document.getElementById("password-input").addEventListener("keydown", function(e) {
  if (e.key === "Enter") document.getElementById("login-btn").click();
});
// Sign-out only counts once the server confirms the session was revoked.
// On failure the user stays signed in, sees why, and can press Log out again.
function showLogoutError(msg) {
  const el = document.getElementById("logout-error");
  if (msg) { el.textContent = msg; el.style.display = "block"; }
  else { el.textContent = ""; el.style.display = "none"; }
}
document.getElementById("logout-btn").addEventListener("click", async function() {
  const btn = this;
  btn.disabled = true; btn.textContent = "Signing out...";
  showLogoutError("");
  let failure = "";
  try {
    const resp = await fetch("/api/logout", { method: "POST", credentials: "same-origin", headers: CSRF });
    if (!resp.ok) failure = "Sign-out failed (" + (await errorText(resp)) + "). You are still signed in. Press Log out to try again.";
  } catch (e) {
    failure = "Sign-out failed: couldn't reach the server. You are still signed in. Check your connection and press Log out to try again.";
  }
  btn.disabled = false; btn.textContent = "Log out";
  if (failure) { showLogoutError(failure); return; }
  trackerUrl = null;
  document.getElementById("password-input").value = "";
  showLogin();
});
document.getElementById("reload-btn").addEventListener("click", loadQueries);

async function loadQueries() {
  document.getElementById("today-pill").textContent = todayDateISO();
  const list = document.getElementById("queries-list");
  list.innerHTML = '<div class="loading">Loading queries from the sheet...</div>';
  try {
    const messages = await callSheetApi();
    renderQueries(messages);
  } catch (err) {
    list.innerHTML = '<div class="error">Couldn\'t load the sheet: ' + escapeHtml(err.message) + '</div>';
  }
}

// Catches journalist queries that are gift bag / swag bag / product-donation
// fulfillment requests (where they want free physical products for event
// attendees, not a feature/review). For these, we always say Skip — Succulents
// Box and Photos to Sketches don't participate in event gifting fulfillment.
// We scan the category, summary, AND full query body so phrasing like
// "VIP swag bags," "product donations for our event," or "include in our
// gift bags" all get caught.
function isGiftBag(msg) {
  if (msg.category && /gift bag/i.test(msg.category)) return true;
  const fullText = (msg.summary || "") + " " + (msg.queryText || "");
  const patterns = [
    /gift bag/i,
    /swag bag/i,
    /swag box/i,
    /product donation/i,
    /donation(s)? (of|for) (product|full[- ]size)/i,
    /\bvip swag/i,
    /event swag/i,
    /attendee gift/i,
    /goody bag/i,
  ];
  for (let i = 0; i < patterns.length; i++) {
    if (patterns[i].test(fullText)) return true;
  }
  return false;
}

function renderQueries(messages) {
  const list = document.getElementById("queries-list");
  list.innerHTML = "";

  // Find the 2 most recent unique dates in the sheet, then keep all queries
  // from those dates (capped at 10). The sheet is already sorted newest-
  // first, so iterating in order gives us the latest dates naturally.
  const seenDates = [];
  for (let i = 0; i < messages.length; i++) {
    const d = messages[i].date || "";
    if (d && seenDates.indexOf(d) === -1) {
      seenDates.push(d);
      if (seenDates.length >= 2) break;
    }
  }

  let recent = messages.filter(function(m) {
    return seenDates.indexOf(m.date || "") !== -1;
  }).slice(0, 10);

  // Fallback: if no queries had dates at all (or none matched), just show
  // the 10 most recent from the sheet so the page is never empty when there
  // is actual data.
  let usingFallback = false;
  if (recent.length === 0 && messages.length > 0) {
    recent = messages.slice(0, 10);
    usingFallback = true;
  }

  const note = document.createElement("div");
  note.className = "muted";
  note.style.marginBottom = "10px";
  if (messages.length === 0) {
    note.textContent = "No queries in the sheet yet.";
  } else if (usingFallback) {
    note.textContent = "Showing the " + recent.length + " most recent quer" + (recent.length === 1 ? "y" : "ies") + " from the sheet.";
  } else {
    note.textContent = "Showing " + recent.length + " quer" + (recent.length === 1 ? "y" : "ies") +
      " from the " + (seenDates.length === 1 ? "most recent date" : "2 most recent dates") +
      " (" + seenDates.join(", ") + ").";
  }
  list.appendChild(note);

  const toShow = recent;
  toShow.forEach(function(m) {
    const card = renderCard(m);
    list.appendChild(card);
    // Now that the card is in the DOM, render the stored assessment that the
    // Apps Script automation already wrote to the Sheet. No model call here.
    if (!isGiftBag(m)) {
      const recsId = card.querySelector(".qc-recs").id;
      renderStoredFit(m, recsId);
    }
  });
}

function renderCard(msg) {
  const card = document.createElement("div");
  card.className = "query-card";
  const giftBag = isGiftBag(msg);
  const recsId = "recs-" + (msg.ts || Math.random().toString(36).slice(2));

  const deadlineParts = [];
  if (msg.deadlineDate) deadlineParts.push(msg.deadlineDate);
  if (msg.deadlineTime) deadlineParts.push(msg.deadlineTime);
  if (msg.tz) deadlineParts.push(msg.tz.replace("Eastern Standard Time","ET").replace("Pacific Standard Time","PT"));
  const deadlineStr = deadlineParts.join(" ");

  const metaBits = [];
  if (msg.outlet) metaBits.push('<span class="meta-outlet">' + escapeHtml(msg.outlet) + '</span>');
  if (msg.name) metaBits.push(escapeHtml(msg.name));
  if (msg.email) metaBits.push('<a href="mailto:' + escapeHtml(msg.email) + '">' + escapeHtml(msg.email) + '</a>');

  card.innerHTML =
    '<div class="qc-topic">' + escapeHtml(msg.summary) + '</div>' +
    '<div class="qc-meta-line">' + metaBits.join(' &middot; ') + '</div>' +
    (deadlineStr ? '<div class="qc-deadline-line"><span class="deadline-label">Deadline:</span> ' + escapeHtml(deadlineStr) + '</div>' : '') +
    '<div class="qc-query-body">' + escapeHtml(msg.queryText) + '</div>' +
    '<div class="qc-recs" id="' + recsId + '">' +
      (giftBag
        ? '<div class="rec-row fit-no"><div class="rec-badge fit-no">x</div><div class="rec-content"><span class="rec-brand">Both brands</span><span class="rec-verdict fit-no">Skip</span><div class="rec-reason">Gift bag fulfillment request, neither brand participates.</div></div></div>'
        : '<div class="rec-row loading">Loading assessment...</div>') +
    '</div>' +
    '<div class="qc-actions">' +
      '<button class="btn-sb pitch-sb-btn"' + (giftBag ? ' disabled' : '') + '>Pitch as Succulents Box</button>' +
      '<button class="btn-pts pitch-pts-btn"' + (giftBag ? ' disabled' : '') + '>Pitch as Photos to Sketches</button>' +
    '</div>';

  if (!giftBag) {
    card.querySelector(".pitch-sb-btn").addEventListener("click", function() { selectQuery(msg, card, "Succulents Box"); });
    card.querySelector(".pitch-pts-btn").addEventListener("click", function() { selectQuery(msg, card, "Photos to Sketches"); });
    // Note: renderStoredFit is called from renderQueries AFTER the card
    // is appended to the DOM, so the recs container exists.
  }
  return card;
}

function renderRecsForData(recsId, data) {
  const el = document.getElementById(recsId);
  if (!el) return;
  el.innerHTML = renderRecRow("Succulents Box", data && data.succulents_box) + renderRecRow("Photos to Sketches", data && data.photos_to_sketches);
}

// Brand fit is assessed ONCE by the Apps Script automation and stored in the
// Sheet (columns K-N). The browser only displays it. There is no model call,
// no retry queue, and no localStorage cache: the Sheet is the single source of
// truth, so every device shows the same verdict.
function renderStoredFit(msg, recsId) {
  const el = document.getElementById(recsId);
  if (!el) return;

  // Blank fit columns mean the automation hasn't reached this query yet.
  if (!msg.sbFit && !msg.ptsFit) {
    el.innerHTML = '<div class="rec-row loading">Assessment pending, appears after the next automation run.</div>';
    return;
  }

  renderRecsForData(recsId, {
    succulents_box:     { fit: msg.sbFit  === "Y", reason: msg.sbReason  || "" },
    photos_to_sketches: { fit: msg.ptsFit === "Y", reason: msg.ptsReason || "" }
  });
}

function renderRecRow(brand, info) {
  const fit = info && info.fit;
  const cls = fit ? "fit-yes" : "fit-no";
  return '<div class="rec-row ' + cls + '">' +
    '<div class="rec-badge ' + cls + '">' + (fit ? "&#10003;" : "&mdash;") + '</div>' +
    '<div class="rec-content">' +
      '<span class="rec-brand">' + escapeHtml(brand) + '</span>' +
      '<span class="rec-verdict ' + cls + '">' + (fit ? "Good fit" : "Skip") + '</span>' +
      '<div class="rec-reason">' + escapeHtml((info && info.reason) || "") + '</div>' +
    '</div></div>';
}

function selectQuery(msg, cardEl, brand) {
  selectedQuery = msg;
  selectedBrand = brand;
  const cards = document.querySelectorAll(".query-card");
  for (let i = 0; i < cards.length; i++) cards[i].classList.remove("selected");
  cardEl.classList.add("selected");

  const draftSection = document.getElementById("draft-section");
  draftSection.style.display = "block";

  const brandTag = document.getElementById("brand-tag");
  brandTag.textContent = brand;
  brandTag.className = "brand-indicator " + (brand === "Succulents Box" ? "sb" : "pts");

  // Both brands start with all three fields empty. No product is pre-filled:
  // the product the user types is the single source of truth for the pitch.
  const productInput = document.getElementById("product-input");
  productInput.value = "";
  productInput.placeholder = brand === "Photos to Sketches"
    ? "e.g. Personalized family ornament with family name and year"
    : "e.g. Succulent arrangement for a desk or shelf";
  document.getElementById("product-link-input").value = "";
  document.getElementById("price-input").value = "";
  document.getElementById("selected-query-info").innerHTML =
    "<strong>Drafting for:</strong> " + escapeHtml(msg.summary) + " (" + escapeHtml(msg.outlet) + ", deadline " + escapeHtml(msg.deadlineDate) + ")";
  document.getElementById("pitch-result").innerHTML = "";
  draftSection.scrollIntoView({ behavior: "smooth", block: "start" });
}

function clip(s, max) {
  s = (s == null ? "" : String(s)).trim().replace(/\s+/g, " ");
  return s.length > max ? s.slice(0, max) : s;
}

// Builds the drafting prompt. The three product fields are always passed as
// separate labelled lines so the model can tell "no price given" from "the
// price is X", and never has to guess which part of one blob is what.
document.getElementById("generate-btn").addEventListener("click", async function() {
  if (!selectedQuery || !selectedBrand) return;
  const brand = selectedBrand;
  const fields = {
    product: clip(document.getElementById("product-input").value, 300),
    link:    clip(document.getElementById("product-link-input").value, 400),
    price:   clip(document.getElementById("price-input").value, 60),
  };
  if (!fields.product) { alert("Please name the product to feature."); return; }

  const btn = this;
  btn.disabled = true; btn.textContent = "Drafting...";
  document.getElementById("pitch-result").innerHTML = '<div class="loading">Generating pitch...</div>';

  try {
    // The server builds the prompt from private brand instructions and
    // appends any fixed brand boilerplate exactly once.
    const q = selectedQuery;
    let pitchText = (await callDraftApi({
      brand: brand,
      query: {
        summary: q.summary || "", queryText: q.queryText || "", outlet: q.outlet || "", name: q.name || "",
        deadlineDate: q.deadlineDate || "", deadlineTime: q.deadlineTime || "", tz: q.tz || "",
      },
      fields: fields,
    })).trim();

    let subject = "";
    let body = pitchText;
    const subjectMatch = pitchText.match(/^\s*Subject:\s*(.+?)\r?\n([\s\S]*)$/i);
    if (subjectMatch) {
      subject = subjectMatch[1].trim();
      body = subjectMatch[2].replace(/^\s*\n/, "");
    }

    const resultEl = document.getElementById("pitch-result");
    resultEl.innerHTML =
      '<div class="send-fields">' +
        '<div class="form-row"><label for="to-input">To</label><input id="to-input" type="email" /></div>' +
        '<div class="form-row"><label for="subject-input">Subject</label><input id="subject-input" type="text" /></div>' +
      '</div>' +
      '<div style="margin-bottom: 8px; font-size: 13px; font-weight: 600;">Email draft</div>' +
      '<div class="pitch-output" id="pitch-text"></div>' +
      '<button class="copy-btn primary" id="open-email-btn">Open in email</button>' +
      '<button class="copy-btn" id="copy-btn">Copy to clipboard</button>' +
      '<button class="copy-btn" id="regenerate-btn">Regenerate</button>' +
      '<div class="post-send-reminder">' +
        '<div class="reminder-text"><strong>After you send:</strong> log the package details (product, journalist, date sent, price, post link) in the PR Package tracker.</div>' +
        '<a class="tracker-btn" id="tracker-btn" target="_blank" rel="noopener noreferrer">Open package tracker</a>' +
      '</div>';

    // The tracker link is provided by the server only after sign-in.
    const trackerBtn = document.getElementById("tracker-btn");
    if (trackerUrl && /^https:\/\/docs\.google\.com\//.test(trackerUrl)) trackerBtn.href = trackerUrl;
    else trackerBtn.style.display = "none";

    document.getElementById("pitch-text").textContent = pitchText;
    document.getElementById("to-input").value = (selectedQuery.email || "").trim();
    document.getElementById("subject-input").value = subject;

    document.getElementById("open-email-btn").addEventListener("click", function() {
      const to = document.getElementById("to-input").value.trim();
      const subj = document.getElementById("subject-input").value.trim();
      const url = "mailto:" + encodeURIComponent(to) + "?subject=" + encodeURIComponent(subj) + "&body=" + encodeURIComponent(body.trim());
      window.location.href = url;
    });
    document.getElementById("copy-btn").addEventListener("click", function() {
      navigator.clipboard.writeText(pitchText).then(function() {
        const cb = document.getElementById("copy-btn");
        cb.textContent = "Copied!";
        setTimeout(function() { cb.textContent = "Copy to clipboard"; }, 2000);
      });
    });
    document.getElementById("regenerate-btn").addEventListener("click", function() {
      document.getElementById("generate-btn").click();
    });
  } catch (err) {
    document.getElementById("pitch-result").innerHTML = '<div class="error">Couldn\'t generate pitch: ' + escapeHtml(err.message) + '</div>';
  } finally {
    btn.disabled = false; btn.textContent = "Generate pitch";
  }
});

(async function() {
  if (await restoreSession()) { showApp(); return; }
  showLogin();
})();
