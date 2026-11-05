// Tracker parsing, moved unchanged from the original netlify/functions/sheet.js
// (column mapping, header aliases, skip rules, newest-first ordering).

export function csvToMessages(csv) {
  const rows = parseCSV(csv);
  if (rows.length === 0) {
    return [];
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

  // Column A is ALWAYS Date Posted in the sheet — hardcode rather than
  // hunt by header name so a renamed/missing header never breaks loading.
  // Header lookup is still used for the other (less critical) columns.
  const COL = {
    date: 0,
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

    // Stored brand-fit results (K-R), written by the Apps Script automation.
    fitToPitch: findCol(["fit to pitch"]),
    sbFit: findCol(["succulents box fit"]),
    ptsFit: findCol(["photos to sketches fit"]),
    sbReason: findCol(["succulents box reason"]),
    ptsReason: findCol(["photos to sketches reason"]),
    queryId: findCol(["query id"]),
    source: findCol(["source"]),
    assessedAt: findCol(["fit assessed at"]),
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

      // Stored assessment — blank sbFit/ptsFit means "not assessed yet"
      fitToPitch: getCell(row, COL.fitToPitch).toUpperCase(),
      sbFit: getCell(row, COL.sbFit).toUpperCase(),
      ptsFit: getCell(row, COL.ptsFit).toUpperCase(),
      sbReason: getCell(row, COL.sbReason),
      ptsReason: getCell(row, COL.ptsReason),
      queryId: getCell(row, COL.queryId),
      source: getCell(row, COL.source),
      assessedAt: getCell(row, COL.assessedAt),
    });
  }

  // Newest first (assumes sheet is in chronological order top-to-bottom)
  messages.reverse();
  return messages;
}

export // Minimal RFC-4180 style CSV parser. Handles quoted fields with commas,
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
