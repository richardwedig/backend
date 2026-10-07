// Spreadsheet helpers (browser version of server/sheets.js, using SheetJS).
import { lib } from './platform.js';

export const SHEET_TEMPLATES = {
  blank: { columns: ['A', 'B', 'C', 'D'], rows: [['', '', '', ''], ['', '', '', ''], ['', '', '', '']] },
  expenses: { columns: ['Date', 'Description', 'Category', 'Amount'], rows: [['', '', '', ''], ['', '', '', ''], ['', '', '', '']] },
  budget: { columns: ['Item', 'Budgeted', 'Actual', 'Notes'], rows: [['', '', '', ''], ['', '', '', ''], ['', '', '', '']] },
  mileage: { columns: ['Date', 'From', 'To', 'Miles', 'Purpose'], rows: [['', '', '', '', ''], ['', '', '', '', '']] },
};

export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  const s = String(v).trim().replace(/[$,€£\s]/g, '');
  if (!s || !/^-?\d*\.?\d+$/.test(s)) return null;
  return Number(s);
}

export function normalizeSheet(sheet) {
  const columns = (Array.isArray(sheet?.columns) ? sheet.columns : []).map((c) => String(c ?? ''));
  if (!columns.length) columns.push('A');
  const rows = (Array.isArray(sheet?.rows) ? sheet.rows : []).map((r) => {
    const row = Array.isArray(r) ? r.slice(0, columns.length) : [];
    while (row.length < columns.length) row.push('');
    return row.map((v) => (v == null ? '' : typeof v === 'number' ? v : String(v)));
  });
  return { columns, rows };
}

export function sheetTotals(sheet) {
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

export function parseCsv(text) {
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
export const toCsv = (sheet) => [sheet.columns, ...sheet.rows].map((r) => r.map(csvCell).join(',')).join('\n');

// [{name, columns, rows}] from an uploaded .xlsx/.xls/.csv file's bytes.
export async function sheetsFromBytes(bytes, filename) {
  if (/\.csv$/i.test(filename)) {
    const [header = [], ...rows] = parseCsv(new TextDecoder().decode(bytes));
    return [{ name: 'Sheet1', ...normalizeSheet({ columns: header, rows }) }];
  }
  const XLSX = await lib('XLSX');
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true });
  return wb.SheetNames.map((name) => {
    const grid = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '', blankrows: false });
    const [header = [], ...rows] = grid;
    return { name, ...normalizeSheet({ columns: header.map((h, i) => h || `Column ${i + 1}`), rows }) };
  });
}

// sheets: [{name, columns, rows, totals?}] -> .xlsx bytes
export async function writeXlsx(sheets) {
  const XLSX = await lib('XLSX');
  const wb = XLSX.utils.book_new();
  const used = new Set();
  for (const s of sheets) {
    const rows = s.rows.map((r) => r.map((v) => (toNumber(v) !== null && !/^0\d/.test(String(v)) ? toNumber(v) : v)));
    if (s.totals) {
      const t = sheetTotals(normalizeSheet(s));
      if (t.some((x) => x !== null)) rows.push(t.map((x, i) => (x !== null ? x : i === 0 ? 'Total' : '')));
    }
    const ws = XLSX.utils.aoa_to_sheet([s.columns, ...rows]);
    ws['!cols'] = s.columns.map((c, i) => ({ wch: Math.min(60, Math.max(10, String(c).length + 2, ...s.rows.map((r) => String(r[i] ?? '').length + 2))) }));
    let name = (s.name || 'Sheet').slice(0, 31).replace(/[\\/?*[\]:]/g, ' ');
    while (used.has(name)) name = `${name.slice(0, 28)} ${used.size}`;
    used.add(name);
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}
