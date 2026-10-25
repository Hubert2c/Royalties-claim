// =============================================================================
// lib/usage/ReportParsers.js — read usage reports sent in different formats
// -----------------------------------------------------------------------------
// Music users send their plays in different shapes (Table 7 of the document):
//   * a CSV file exported from playout software or a spreadsheet
//   * JSON from a partner system (the Open API, DDEX-style "events")
//
// Each format has its own parser class. All of them inherit from
// UsageReportParser and return the same thing: a list of rows
//     { played_at, title, artist, isrc, duration_sec, fingerprint }
// so the rest of the system never needs to know which format was used.
// =============================================================================

const { ValidationError } = require('../errors');

/** Base class with the shared clean-up rules. */
class UsageReportParser {
  static MAX_ROWS = 5000;

  constructor() {
    if (new.target === UsageReportParser) throw new TypeError('UsageReportParser is abstract; use a subclass.');
  }

  /** Read the input and return clean rows. Subclasses implement readRows(). */
  parse(input) {
    const rows = this.readRows(input).map((row) => UsageReportParser.normaliseRow(row));
    if (!rows.length) throw new ValidationError(this.emptyMessage());
    if (rows.length > UsageReportParser.MAX_ROWS) throw new ValidationError('Please send at most 5,000 rows at a time.');
    return rows;
  }

  readRows() { throw new Error(`${this.constructor.name} must implement readRows().`); }

  emptyMessage() { return 'No usage rows were provided.'; }

  /** Keep only the known fields and trim text. */
  static normaliseRow(row = {}) {
    const text = (value) => (value === undefined || value === null ? '' : String(value).trim());
    return {
      played_at: text(row.played_at) || undefined,
      title: text(row.title) || undefined,
      artist: text(row.artist) || undefined,
      isrc: text(row.isrc) || undefined,
      duration_sec: text(row.duration_sec) || undefined,
      fingerprint: row.fingerprint || undefined
    };
  }
}

/**
 * CSV reader that handles commas inside "quoted fields" and "" as an escaped
 * quote. The first line is the header; keys are lower-cased.
 */
class CsvUsageParser extends UsageReportParser {
  static HEADER = 'played_at,title,artist,isrc,duration_sec';

  readRows(text) {
    const lines = String(text || '')
      .replace(/^\uFEFF/, '') // byte-order mark added by Excel
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
    if (lines.length < 2) return [];
    const headers = CsvUsageParser.parseLine(lines[0]).map((header) => header.toLowerCase());
    return lines.slice(1).map((line) => {
      const cells = CsvUsageParser.parseLine(line);
      const row = {};
      headers.forEach((header, i) => { row[header] = cells[i] !== undefined ? cells[i] : ''; });
      return row;
    });
  }

  emptyMessage() { return `The CSV file has no data rows. The first line must be: ${CsvUsageParser.HEADER}`; }

  /** Split one CSV line into cells (a small state machine: inside / outside quotes). */
  static parseLine(line) {
    const cells = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const char = line[i];
      if (inQuotes) {
        if (char === '"' && line[i + 1] === '"') { current += '"'; i += 1; } else if (char === '"') { inQuotes = false; } else { current += char; }
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
}

/** JSON reports: an array of events, e.g. from the Open API. */
class JsonUsageParser extends UsageReportParser {
  readRows(events) {
    if (!Array.isArray(events)) throw new ValidationError('"events" must be a list of plays.');
    return events.filter((event) => event && typeof event === 'object');
  }
}

module.exports = { UsageReportParser, CsvUsageParser, JsonUsageParser };
