// Builds report data and renders it to Word (.docx) or Excel (.xlsx).
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType,
} = require('docx');
const { all, get } = require('./db');
const { writeXlsx, normalizeSheet, sheetTotals } = require('./sheets');

const round2 = (n) => Math.round(n * 100) / 100;
const money = (n) => `$${round2(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

function prettyDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// --- Data -------------------------------------------------------------------

function hoursData({ project_id = null, start, end }) {
  const where = ['e.deleted_at IS NULL', 'p.deleted_at IS NULL', 'e.date >= ?', 'e.date <= ?'];
  const params = [start, end];
  if (project_id) { where.push('e.project_id = ?'); params.push(project_id); }
  const entries = all(
    `SELECT e.date, e.hours, e.note, p.name AS project, p.hourly_rate AS rate
       FROM time_entries e JOIN projects p ON p.id = e.project_id
      WHERE ${where.join(' AND ')} ORDER BY e.date, p.name`, ...params);
  const byProject = new Map();
  for (const e of entries) {
    const p = byProject.get(e.project) || { project: e.project, rate: e.rate, hours: 0, days: new Set() };
    p.hours += e.hours; p.days.add(e.date);
    byProject.set(e.project, p);
  }
  const summary = [...byProject.values()].map((p) => ({ ...p, hours: round2(p.hours), days: p.days.size, earned: round2(p.hours * (p.rate || 0)) }));
  const totalHours = round2(summary.reduce((s, p) => s + p.hours, 0));
  const totalEarned = round2(summary.reduce((s, p) => s + p.earned, 0));
  return { entries, summary, totalHours, totalEarned };
}

// Hours report as a document spec (see renderDocx) plus spreadsheet tabs.
function hoursReport({ project_id = null, start, end }) {
  const project = project_id ? get('SELECT name FROM projects WHERE id = ?', project_id) : null;
  const d = hoursData({ project_id, start, end });
  const showMoney = d.summary.some((p) => p.rate > 0);
  const title = `Hours Report${project ? ` - ${project.name}` : ''}`;
  const subtitle = `${prettyDate(start)} to ${prettyDate(end)}`;
  const sumCols = ['Project', 'Days worked', 'Hours', ...(showMoney ? ['Rate', 'Earned'] : [])];
  const sumRows = d.summary.map((p) => [p.project, p.days, p.hours, ...(showMoney ? [p.rate ? money(p.rate) : '', money(p.earned)] : [])]);
  sumRows.push(['Total', '', d.totalHours, ...(showMoney ? ['', money(d.totalEarned)] : [])]);
  const detCols = ['Date', 'Project', 'Hours', 'Note'];
  const detRows = d.entries.map((e) => [prettyDate(e.date), e.project, e.hours, e.note || '']);
  const spec = {
    title,
    subtitle,
    sections: [
      {
        heading: 'Summary',
        paragraphs: [d.entries.length
          ? `You worked ${d.totalHours} hours across ${d.summary.length} project${d.summary.length === 1 ? '' : 's'}${showMoney ? `, worth ${money(d.totalEarned)}` : ''}.`
          : 'No hours were recorded in this period.'],
        table: d.entries.length ? { columns: sumCols, rows: sumRows } : null,
      },
      ...(d.entries.length ? [{ heading: 'Every entry', table: { columns: detCols, rows: detRows } }] : []),
    ],
  };
  const sheets = [
    { name: 'Summary', columns: sumCols, rows: sumRows },
    { name: 'Entries', columns: ['Date', 'Project', 'Hours', 'Note'], rows: d.entries.map((e) => [e.date, e.project, e.hours, e.note || '']), totals: true },
  ];
  return { title, spec, sheets };
}

// Everything about one project: hours, money, spreadsheets, upcoming events.
function projectReport(project_id) {
  const p = get('SELECT * FROM projects WHERE id = ?', project_id);
  if (!p) throw new Error('Project not found');
  const range = get('SELECT MIN(date) AS start, MAX(date) AS end FROM time_entries WHERE project_id = ? AND deleted_at IS NULL', project_id);
  const today = new Date().toISOString().slice(0, 10);
  const hours = hoursData({ project_id, start: range.start || today, end: range.end || today });
  const byMonth = new Map();
  for (const e of hours.entries) byMonth.set(e.date.slice(0, 7), round2((byMonth.get(e.date.slice(0, 7)) || 0) + e.hours));
  const sheets = all("SELECT name, sheet FROM files WHERE project_id = ? AND kind = 'spreadsheet' AND deleted_at IS NULL ORDER BY name", project_id);
  const events = all('SELECT * FROM events WHERE project_id = ? AND deleted_at IS NULL AND date >= ? ORDER BY date LIMIT 20', project_id, today);

  const sections = [{
    heading: 'Overview',
    paragraphs: [
      p.description || '',
      `Status: ${p.status === 'done' ? 'Finished' : 'Active'}.`,
      `Total hours worked: ${hours.totalHours}${p.hourly_rate ? ` at ${money(p.hourly_rate)} per hour = ${money(hours.totalEarned)}` : ''}.`,
      range.start ? `Work recorded from ${prettyDate(range.start)} to ${prettyDate(range.end)}.` : 'No hours recorded yet.',
    ].filter(Boolean),
  }];
  if (byMonth.size) {
    sections.push({ heading: 'Hours by month', table: { columns: ['Month', 'Hours'], rows: [...byMonth].map(([m, h]) => [new Date(`${m}-15`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), h]) } });
  }
  const costLines = [];
  for (const s of sheets) {
    const sheet = normalizeSheet(JSON.parse(s.sheet || '{}'));
    const totals = sheetTotals(sheet);
    const parts = sheet.columns.map((c, i) => (totals[i] !== null ? `${c}: ${totals[i]}` : null)).filter(Boolean);
    costLines.push(`${s.name} - ${sheet.rows.filter((r) => r.some((v) => v !== '')).length} rows${parts.length ? `; totals ${parts.join(', ')}` : ''}`);
  }
  if (costLines.length) sections.push({ heading: 'Spreadsheets (expenses and costs)', bullets: costLines });
  if (events.length) sections.push({ heading: 'Coming up', bullets: events.map((e) => `${prettyDate(e.date)}${e.time ? ` ${e.time}` : ''} - ${e.title}`) });

  const spec = { title: `Project Summary - ${p.name}`, subtitle: `Prepared ${prettyDate(today)}`, sections };
  const xlsx = [
    { name: 'Hours by month', columns: ['Month', 'Hours'], rows: [...byMonth], totals: true },
    { name: 'Entries', columns: ['Date', 'Hours', 'Note'], rows: hours.entries.map((e) => [e.date, e.hours, e.note || '']), totals: true },
  ];
  return { title: spec.title, spec, sheets: xlsx };
}

// --- Rendering --------------------------------------------------------------

function docxTable({ columns, rows }) {
  const cell = (text, header) => new TableCell({
    shading: header ? { type: ShadingType.CLEAR, fill: 'E8EEF7', color: 'auto' } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text: String(text ?? ''), bold: header, size: 22 })] })],
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: columns.map((c) => cell(c, true)) }),
      ...rows.map((r) => new TableRow({ children: columns.map((_, i) => cell(r[i], false)) })),
    ],
  });
}

// spec: {title, subtitle?, sections: [{heading?, paragraphs?: [], bullets?: [], table?: {columns, rows}}]}
async function renderDocx(spec) {
  const children = [new Paragraph({ text: spec.title || 'Report', heading: HeadingLevel.TITLE })];
  if (spec.subtitle) children.push(new Paragraph({ children: [new TextRun({ text: spec.subtitle, italics: true, size: 26 })] }));
  for (const s of spec.sections || []) {
    if (s.heading) children.push(new Paragraph({ text: s.heading, heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }));
    for (const p of s.paragraphs || []) children.push(new Paragraph({ children: [new TextRun({ text: String(p), size: 24 })], spacing: { after: 120 } }));
    for (const b of s.bullets || []) children.push(new Paragraph({ children: [new TextRun({ text: String(b), size: 24 })], bullet: { level: 0 } }));
    if (s.table?.columns?.length) {
      children.push(docxTable(s.table));
      children.push(new Paragraph(''));
    }
  }
  const doc = new Document({ creator: 'Work Tracker', title: spec.title, sections: [{ children }] });
  return Packer.toBuffer(doc);
}

async function renderReport(report, format) {
  if (format === 'xlsx') {
    return { buffer: await writeXlsx(report.sheets), ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  }
  return { buffer: await renderDocx(report.spec), ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
}

module.exports = { hoursData, hoursReport, projectReport, renderDocx, renderReport, prettyDate, money };
