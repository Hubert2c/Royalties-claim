// =============================================================================
// lib/csv.js — a small CSV reader for usage reports (play logs, set lists...)
// -----------------------------------------------------------------------------
// Handles commas inside "quoted fields" and "" as an escaped quote.
// The first line must be a header row; each following line becomes an object
// whose keys are the (lower-cased, trimmed) header names.
// =============================================================================

function parseLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"' && line[i + 1] === '"') { current += '"'; i += 1; }
      else if (char === '"') { inQuotes = false; }
      else { current += char; }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ',') {
      cells.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function parseCsv(text) {
  const lines = String(text || '')
    .replace(/^﻿/, '')          // remove a byte-order mark added by Excel
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');
  if (lines.length < 2) return [];
  const headers = parseLine(lines[0]).map((h) => h.toLowerCase());
  return lines.slice(1).map((line) => {
    const cells = parseLine(line);
    const row = {};
    headers.forEach((header, i) => { row[header] = cells[i] !== undefined ? cells[i] : ''; });
    return row;
  });
}

module.exports = { parseCsv };
