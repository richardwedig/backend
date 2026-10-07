// Report contents (browser version of server/reports.js). A report is kept as a
// "spec" ({title, subtitle, sections}) plus spreadsheet tabs, and turned into a
// Word or Excel file only when it is downloaded.
import { lib } from './platform.js';
import { writeXlsx, normalizeSheet, sheetTotals } from './sheets.js';

const round2 = (n) => Math.round(n * 100) / 100;
export const money = (n) => `$${round2(n).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
export function prettyDate(iso) {
  if (!iso) return '';
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function hoursData(data, { project_id = null, start, end }) {
  const names = new Map(data.projects.map((p) => [p.id, p]));
  const entries = data.entries
    .filter((e) => e.date >= start && e.date <= end && (!project_id || e.project_id === project_id))
    .map((e) => ({ date: e.date, hours: e.hours, note: e.note, project: names.get(e.project_id)?.name ?? 'Project', rate: names.get(e.project_id)?.hourly_rate || 0 }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.project.localeCompare(b.project));
  const byProject = new Map();
  for (const e of entries) {
    const p = byProject.get(e.project) || { project: e.project, rate: e.rate, hours: 0, days: new Set() };
    p.hours += e.hours; p.days.add(e.date);
    byProject.set(e.project, p);
  }
  const summary = [...byProject.values()].map((p) => ({ ...p, hours: round2(p.hours), days: p.days.size, earned: round2(p.hours * (p.rate || 0)) }));
  return { entries, summary, totalHours: round2(summary.reduce((s, p) => s + p.hours, 0)), totalEarned: round2(summary.reduce((s, p) => s + p.earned, 0)) };
}

export function hoursReport(data, { project_id = null, start, end }) {
  const project = project_id ? data.projects.find((p) => p.id === project_id) : null;
  const d = hoursData(data, { project_id, start, end });
  const showMoney = d.summary.some((p) => p.rate > 0);
  const title = `Hours Report${project ? ` - ${project.name}` : ''}`;
  const sumCols = ['Project', 'Days worked', 'Hours', ...(showMoney ? ['Rate', 'Earned'] : [])];
  const sumRows = d.summary.map((p) => [p.project, p.days, p.hours, ...(showMoney ? [p.rate ? money(p.rate) : '', money(p.earned)] : [])]);
  sumRows.push(['Total', '', d.totalHours, ...(showMoney ? ['', money(d.totalEarned)] : [])]);
  const spec = {
    title,
    subtitle: `${prettyDate(start)} to ${prettyDate(end)}`,
    sections: [
      {
        heading: 'Summary',
        paragraphs: [d.entries.length
          ? `You worked ${d.totalHours} hours across ${d.summary.length} project${d.summary.length === 1 ? '' : 's'}${showMoney ? `, worth ${money(d.totalEarned)}` : ''}.`
          : 'No hours were recorded in this period.'],
        table: d.entries.length ? { columns: sumCols, rows: sumRows } : null,
      },
      ...(d.entries.length ? [{ heading: 'Every entry', table: { columns: ['Date', 'Project', 'Hours', 'Note'], rows: d.entries.map((e) => [prettyDate(e.date), e.project, e.hours, e.note || '']) } }] : []),
    ],
  };
  const sheets = [
    { name: 'Summary', columns: sumCols, rows: sumRows },
    { name: 'Entries', columns: ['Date', 'Project', 'Hours', 'Note'], rows: d.entries.map((e) => [e.date, e.project, e.hours, e.note || '']), totals: true },
  ];
  return { title, spec, sheets };
}

export function projectReport(data, project_id) {
  const p = data.projects.find((x) => x.id === project_id);
  if (!p) throw new Error('Project not found');
  const mine = data.entries.filter((e) => e.project_id === project_id).map((e) => e.date).sort();
  const start = mine[0] || data.today;
  const end = mine[mine.length - 1] || data.today;
  const hours = hoursData(data, { project_id, start, end });
  const byMonth = new Map();
  for (const e of hours.entries) byMonth.set(e.date.slice(0, 7), round2((byMonth.get(e.date.slice(0, 7)) || 0) + e.hours));
  const events = data.events.filter((e) => e.project_id === project_id && e.date >= data.today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 20);
  const sections = [{
    heading: 'Overview',
    paragraphs: [
      p.description || '',
      `Status: ${p.status === 'done' ? 'Finished' : 'Active'}.`,
      `Total hours worked: ${hours.totalHours}${p.hourly_rate ? ` at ${money(p.hourly_rate)} per hour = ${money(hours.totalEarned)}` : ''}.`,
      mine.length ? `Work recorded from ${prettyDate(start)} to ${prettyDate(end)}.` : 'No hours recorded yet.',
    ].filter(Boolean),
  }];
  if (byMonth.size) {
    sections.push({ heading: 'Hours by month', table: { columns: ['Month', 'Hours'], rows: [...byMonth].map(([m, h]) => [new Date(`${m}-15T12:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), h]) } });
  }
  const costLines = data.sheets.filter((s) => s.project_id === project_id).map((s) => {
    const sheet = normalizeSheet(s.sheet);
    const totals = sheetTotals(sheet);
    const parts = sheet.columns.map((c, i) => (totals[i] !== null ? `${c}: ${totals[i]}` : null)).filter(Boolean);
    return `${s.name} - ${sheet.rows.filter((r) => r.some((v) => v !== '')).length} rows${parts.length ? `; totals ${parts.join(', ')}` : ''}`;
  });
  if (costLines.length) sections.push({ heading: 'Spreadsheets (expenses and costs)', bullets: costLines });
  if (events.length) sections.push({ heading: 'Coming up', bullets: events.map((e) => `${prettyDate(e.date)}${e.time ? ` ${e.time}` : ''} - ${e.title}`) });
  const spec = { title: `Project Summary - ${p.name}`, subtitle: `Prepared ${prettyDate(data.today)}`, sections };
  const sheets = [
    { name: 'Hours by month', columns: ['Month', 'Hours'], rows: [...byMonth], totals: true },
    { name: 'Entries', columns: ['Date', 'Hours', 'Note'], rows: hours.entries.map((e) => [e.date, e.hours, e.note || '']), totals: true },
  ];
  return { title: spec.title, spec, sheets };
}

// ---------- showing and exporting

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function specToHtml(spec) {
  const parts = [`<h1>${esc(spec.title)}</h1>`];
  if (spec.subtitle) parts.push(`<p><em>${esc(spec.subtitle)}</em></p>`);
  for (const s of spec.sections || []) {
    if (s.heading) parts.push(`<h2>${esc(s.heading)}</h2>`);
    for (const p of s.paragraphs || []) parts.push(`<p>${esc(p)}</p>`);
    if (s.bullets?.length) parts.push(`<ul>${s.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`);
    if (s.table?.columns?.length) parts.push(`<table><thead><tr>${s.table.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${(s.table.rows || []).map((r) => `<tr>${s.table.columns.map((_, i) => `<td>${esc(r[i])}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
  }
  return parts.join('');
}

export function specToText(spec) {
  const lines = [spec.title, spec.subtitle || ''];
  for (const s of spec.sections || []) {
    if (s.heading) lines.push('', `## ${s.heading}`);
    lines.push(...(s.paragraphs || []), ...(s.bullets || []).map((b) => `- ${b}`));
    if (s.table?.columns?.length) lines.push([s.table.columns, ...(s.table.rows || [])].map((r) => r.join(' | ')).join('\n'));
  }
  return lines.join('\n');
}

async function renderDocx(spec) {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType } = await lib('docx');
  const cell = (text, header) => new TableCell({
    shading: header ? { type: ShadingType.CLEAR, fill: 'E8EEF7', color: 'auto' } : undefined,
    children: [new Paragraph({ children: [new TextRun({ text: String(text ?? ''), bold: header, size: 22 })] })],
  });
  const children = [new Paragraph({ text: spec.title || 'Report', heading: HeadingLevel.TITLE })];
  if (spec.subtitle) children.push(new Paragraph({ children: [new TextRun({ text: spec.subtitle, italics: true, size: 26 })] }));
  for (const s of spec.sections || []) {
    if (s.heading) children.push(new Paragraph({ text: s.heading, heading: HeadingLevel.HEADING_1, spacing: { before: 300 } }));
    for (const p of s.paragraphs || []) children.push(new Paragraph({ children: [new TextRun({ text: String(p), size: 24 })], spacing: { after: 120 } }));
    for (const b of s.bullets || []) children.push(new Paragraph({ children: [new TextRun({ text: String(b), size: 24 })], bullet: { level: 0 } }));
    if (s.table?.columns?.length) {
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        rows: [
          new TableRow({ tableHeader: true, children: s.table.columns.map((c) => cell(c, true)) }),
          ...(s.table.rows || []).map((r) => new TableRow({ children: s.table.columns.map((_, i) => cell(r[i], false)) })),
        ],
      }));
      children.push(new Paragraph(''));
    }
  }
  const doc = new Document({ creator: 'Work Tracker', title: spec.title, sections: [{ children }] });
  return Packer.toBlob(doc);
}

// stored: {format, spec, sheets}
export async function render(stored) {
  if (stored.format === 'xlsx') {
    const sheets = stored.sheets?.length ? stored.sheets : [{ name: 'Sheet1', columns: ['Text'], rows: specToText(stored.spec).split('\n').map((l) => [l]) }];
    return writeXlsx(sheets.map((s) => ({ ...s, rows: s.rows || [] })));
  }
  return renderDocx(stored.spec);
}
