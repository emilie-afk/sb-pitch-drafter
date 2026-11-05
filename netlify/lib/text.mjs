// Small text helpers shared by endpoints.

// Strips control characters (keeps tab, newline, carriage return).
export const stripControls = (s) => String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");

// Spreadsheet formula-injection guard for text that a caller writes into a
// sheet cell: a leading = + - @ (or tab/CR) gets an apostrophe prefix.
export const sheetSafe = (s) => (/^[=+\-@\t\r]/.test(s) ? "'" + s : s);
