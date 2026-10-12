// Minimal CSV parser for the phone sheet upload path — deliberately not a full RFC-4180 parser
// (no new dependency for a small, self-controlled template: header names and cell content are
// simple text, never multi-line quoted fields). Handles quoted cells and escaped quotes ("") since
// spreadsheet exports commonly quote every cell regardless of whether it needs it.
function parseCsvLine(line) {
  const cells = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"'
        i++
      } else if (ch === '"') {
        inQuotes = false
      } else {
        cur += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      cells.push(cur)
      cur = ''
    } else {
      cur += ch
    }
  }
  cells.push(cur)
  return cells.map((c) => c.trim())
}

function normalizeHeader(h) {
  return (h || '').toString().trim().toLowerCase().replace(/\s+/g, ' ')
}

// Maps an array of raw table rows (each row itself an array of cell values, row[0] being the
// header row) through `headerMap` (a case/whitespace-insensitive lookup from expected column name
// to the object key to use) into plain row objects. Shared by the CSV and XLSX phone-sheet
// parsers so both produce identically-shaped output from the same header-name rules, regardless
// of which file format the rows originally came from. Columns not present in headerMap are
// ignored; a header expected by headerMap but missing from the file just means that key is absent
// on every row (not an error) — tolerant of someone re-ordering or dropping a column they don't need.
function mapTableRows(rows, headerMap) {
  if (rows.length === 0) return []
  const lookup = new Map(Object.entries(headerMap).map(([label, key]) => [normalizeHeader(label), key]))
  const keys = rows[0].map((h) => lookup.get(normalizeHeader(h)) || null)

  const out = []
  for (let i = 1; i < rows.length; i++) {
    const cells = rows[i]
    const row = {}
    keys.forEach((key, idx) => {
      if (key) row[key] = (cells[idx] ?? '').toString().trim()
    })
    if (Object.values(row).some((v) => v !== '')) out.push(row)
  }
  return out
}

// Parses CSV text into an array of plain objects, one per data row — see mapTableRows for the
// header-mapping rules.
function parseCsv(text, headerMap) {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '')
  return mapTableRows(lines.map(parseCsvLine), headerMap)
}

// Common truthy spellings a person might type into a "Yes/No" style column — anything else
// (including blank) is false.
function parseCsvBoolean(value) {
  return ['yes', 'true', 'y', '1'].includes((value || '').trim().toLowerCase())
}

// Splits raw CSV text into blocks separated by one or more blank lines — for a template that
// stacks two independent tables (Devices, then Agents) in one file, each with its own header row,
// rather than interleaving both sets of columns into a single row. Each returned block still has
// its own header line at the top, ready for parseCsv.
function splitCsvSections(text) {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split(/\n\s*\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

module.exports = { parseCsv, parseCsvBoolean, splitCsvSections, mapTableRows }
