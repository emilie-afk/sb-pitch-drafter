// Netlify serverless function. Fetches the journalist queries from a Google Sheet
// (published as CSV) and returns them as JSON for the frontend.
//
// Required environment variables:
//   APP_PASSWORD    -- password the app requires to unlock
//   SHEET_CSV_URL   -- the Google Sheet CSV export URL, e.g.
//                      https://docs.google.com/spreadsheets/d/{ID}/export?format=csv&gid={GID}
//                      (the sheet must be shared as "Anyone with the link can view")
//
// The sheet's first row must be headers. The function maps header names
// (case-insensitive) to fields it returns:
//   Query date / Date / Date posted    -> date  (YYYY-MM-DD)
//   Deadline / Deadline date           -> deadlineDate
//   Deadline time                      -> deadlineTime
//   Time zone / TZ                     -> tz
//   Publication / Outlet / Media outlet -> outlet
//   Publication link / Website / Media website -> website
//   Contact email / Email              -> email
//   Topic / Summary                    -> summary
//   Content / Query / Query body       -> queryText
//   Journalist name / Name / Journalist -> name
//   Category                           -> category

exports.handler = async function(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: corsHeaders(), body: "" };
  }
  if (event.httpMethod !== "POST" && event.httpMethod !== "GET") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const appPassword = process.env.APP_PASSWORD;
  const sheetUrl = process.env.SHEET_CSV_URL;
  if (!appPassword || !sheetUrl) {
    return {
      statusCode: 500,
      body: "Server is missing APP_PASSWORD or SHEET_CSV_URL environment variables.",
    };
  }

  const incomingPassword = event.headers["x-app-password"] || event.headers["X-App-Password"];
  if (incomingPassword !== appPassword) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  try {
    const resp = await fetch(sheetUrl, { redirect: "follow" });
    if (!resp.ok) {
      return { statusCode: 502, body: "Couldn't fetch sheet (HTTP " + resp.status + "). Check that the sheet is shared as Anyone with the link can view, and that SHEET_CSV_URL is correct." };
    }
    const csv = await resp.text();
    const rows = parseCSV(csv);
    if (rows.length === 0) {
      return ok({ messages: [] });
    }

    const headerRow = rows[0].map(function(h) { return h.toLowerCase().trim(); });
    const headerIndex = {};
    headerRow.forEach(function(h, i) { headerIndex[h] = i; });

    const findCol = function(names) {
      for (var k = 0; k < names.length; k++) {
        var idx = headerIndex[names[k]];
        if (idx !== undefined) return idx;
      }
      return -1;
    };

    const COL = {
      date: findCol(["query date", "date", "date posted"]),
      deadlineDate: findCol(["deadline", "deadline date"]),
      deadlineTime: findCol(["deadline time"]),
      tz: findCol(["time zone", "timezone", "tz"]),
      outlet: findCol(["publication", "outlet", "media outlet"]),
      website: findCol(["publication link", "website", "media website"]),
      email: findCol(["contact email", "email"]),
      summary: findCol(["topic", "summary"]),
      queryText: findCol(["content", "query", "query body"]),
      name: findCol(["journalist name", "name", "journalist"]),
      category: findCol(["category"]),
    };

    const getCell = function(row, idx) {
      if (idx < 0 || idx >= row.length) return "";
      var v = row[idx];
      return v == null ? "" : String(v).trim();
    };

    const messages = [];
    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      if (!row || row.length === 0) continue;
      var summary = getCell(row, COL.summary);
      var date = getCell(row, COL.date);
      if (!summary && !date) continue;
      messages.push({
        ts: String(i),
        date: date,
        deadlineDate: getCell(row, COL.deadlineDate),
        deadlineTime: getCell(row, COL.deadlineTime),
        tz: getCell(row, COL.tz),
        outlet: getCell(row, COL.outlet),
        website: getCell(row, COL.website),
        email: getCell(row, COL.email),
        summary: summary,
        queryText: getCell(row, COL.queryText),
        name: getCell(row, COL.name),
        category: getCell(row, COL.category),
      });
    }

    // Newest first (assumes sheet is in chronological order top-to-bottom)
    messages.reverse();

    return ok({ messages: messages });
  } catch (err) {
    return {
      statusCode: 500,
      body: "Request failed: " + (err && err.message ? err.message : String(err)),
    };
  }
};

function ok(payload) {
  return {
    statusCode: 200,
    headers: Object.assign({ "Content-Type": "application/json" }, corsHeaders()),
    body: JSON.stringify(payload),
  };
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, x-app-password",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  };
}

// Minimal RFC-4180 style CSV parser. Handles quoted fields with commas,
// embedded newlines, and escaped quotes (""). Returns array of arrays.
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i += 2; continue; }
      if (c === '"') { inQuotes = false; i++; continue; }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ""; i++; continue; }
    if (c === '\r') {
      if (text[i + 1] === '\n') i++;
      row.push(field); field = "";
      if (!(row.length === 1 && row[0] === "")) rows.push(row);
      row = [];
      i++; continue;
    }
    if (c === '\n') {
      row.push(field); field = "";
      if (!(row.length === 1 && row[0] === "")) rows.push(row);
      row = [];
      i++; continue;
    }
    field += c; i++;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
  }
  return rows;
}
