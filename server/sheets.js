// Helpers for reading and writing spreadsheet-like data.
const ExcelJS = require('exceljs');

const SHEET_TEMPLATES = {
  blank: { columns: ['A', 'B', 'C', 'D'], rows: [['', '', '', ''], ['', '', '', ''], ['', '', '', '']] },
  expenses: { columns: ['Date', 'Description', 'Category', 'Amount'], rows: [['', '', '', ''], ['', '', '', ''], ['', '', '', '']] },
  budget: { columns: ['Item', 'Budgeted', 'Actual', 'Notes'], rows: [['', '', '', ''], ['', '', '', ''], ['', '', '', '']] },
  mileage: { columns: ['Date', 'From', 'To', 'Miles', 'Purpose'], rows: [['', '', '', '', ''], ['', '', '', '', '']] },
};

// Accepts "1,234.50", "$99", "-5" -> number; anything else -> null.
function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  const s = String(v).trim().replace(/[$,€£\s]/g, '');
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
  return Number(s);
}

function normalizeSheet(sheet) {
  const columns = (Array.isArray(sheet?.columns) ? sheet.columns : []).map((c) => String(c ?? ''));
  if (!columns.length) columns.push('A');
  const rows = (Array.isArray(sheet?.rows) ? sheet.rows : []).map((r) => {
    const row = Array.isArray(r) ? r.slice(0, columns.length) : [];
    while (row.length < columns.length) row.push('');
    return row.map((v) => (v == null ? '' : typeof v === 'number' ? v : String(v)));
  });
  return { columns, rows };
}

// Column totals for every column that is mostly numbers.
function sheetTotals(sheet) {
  return sheet.columns.map((_, ci) => {
    let sum = 0, nums = 0, filled = 0;
    for (const r of sheet.rows) {
      const v = r[ci];
      if (v === '' || v == null) continue;
      filled++;
      const n = toNumber(v);
      if (n !== null) { sum += n; nums++; }
    }
    return nums > 0 && nums >= filled * 0.6 ? Math.round(sum * 100) / 100 : null;
  });
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (sheet) => [sheet.columns, ...sheet.rows].map((r) => r.map(csvCell).join(',')).join('\n');

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return cellText(v.result);
    if (v.text) return String(v.text);
    if (v.hyperlink) return String(v.hyperlink);
    return '';
  }
  return v;
}

// Returns [{name, columns, rows}] for each worksheet in an .xlsx buffer.
async function readXlsx(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const out = [];
  wb.eachSheet((ws) => {
    const grid = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const vals = [];
      for (let c = 1; c <= ws.columnCount; c++) vals.push(cellText(r.getCell(c).value));
      grid.push(vals);
    });
    const [header = [], ...rows] = grid;
    out.push({ name: ws.name, ...normalizeSheet({ columns: header.map((h, i) => h || `Column ${i + 1}`), rows }) });
  });
  return out;
}

async function sheetsFromUpload(buffer, filename) {
  if (/\.csv$/i.test(filename)) {
    const [header = [], ...rows] = parseCsv(buffer.toString('utf8'));
    return [{ name: 'Sheet1', ...normalizeSheet({ columns: header, rows }) }];
  }
  return readXlsx(buffer);
}

// sheets: [{name, columns, rows, totals?: boolean}]
async function writeXlsx(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet((s.name || 'Sheet').slice(0, 31).replace(/[\\/?*[\]:]/g, ' '));
    const header = ws.addRow(s.columns);
    header.font = { bold: true };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8EEF7' } };
    for (const r of s.rows) ws.addRow(r.map((v) => (toNumber(v) !== null && !/^0\d/.test(String(v)) ? toNumber(v) : v)));
    if (s.totals) {
      const t = sheetTotals(normalizeSheet(s));
      if (t.some((x) => x !== null)) {
        const row = ws.addRow(t.map((x, i) => (x !== null ? x : i === 0 ? 'Total' : '')));
        row.font = { bold: true };
      }
    }
    ws.columns.forEach((col, i) => {
      const longest = Math.max(String(s.columns[i] ?? '').length, ...s.rows.map((r) => String(r[i] ?? '').length));
      col.width = Math.min(60, Math.max(10, longest + 2));
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

module.exports = { SHEET_TEMPLATES, toNumber, normalizeSheet, sheetTotals, parseCsv, toCsv, readXlsx, sheetsFromUpload, writeXlsx };
