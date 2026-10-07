// All the app's operations live here so the web pages and the AI assistant
// share exactly the same behaviour (including the recycle bin).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mammoth = require('mammoth');
const { all, get, run, tx, setting, logActivity, systemFolder, newBatch, UPLOAD_DIR } = require('./db');
const sheetsLib = require('./sheets');
const reports = require('./reports');

class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T12:00:00`).getTime());
const round2 = (n) => Math.round(n * 100) / 100;
const clean = (s, max = 500) => String(s ?? '').trim().slice(0, max);
const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];

function need(row, what) {
  if (!row) throw new UserError(`That ${what} could not be found. It may have been moved to the Recycle Bin.`, 404);
  return row;
}

// ---------------------------------------------------------------- projects

function listProjects({ includeDone = true } = {}) {
  return all(
    `SELECT p.*, COALESCE((SELECT SUM(hours) FROM time_entries e WHERE e.project_id = p.id AND e.deleted_at IS NULL), 0) AS total_hours,
            (SELECT MAX(date) FROM time_entries e WHERE e.project_id = p.id AND e.deleted_at IS NULL) AS last_worked
       FROM projects p WHERE p.deleted_at IS NULL ${includeDone ? '' : "AND p.status = 'active'"}
      ORDER BY p.status = 'done', p.name COLLATE NOCASE`,
  ).map((p) => ({ ...p, total_hours: round2(p.total_hours) }));
}

function getProject(id) {
  const p = need(get('SELECT * FROM projects WHERE id = ? AND deleted_at IS NULL', id), 'project');
  const t = get(`SELECT COALESCE(SUM(hours),0) AS total,
                        COALESCE(SUM(CASE WHEN date >= ? THEN hours END),0) AS month
                   FROM time_entries WHERE project_id = ? AND deleted_at IS NULL`, today().slice(0, 8) + '01', id);
  return { ...p, total_hours: round2(t.total), month_hours: round2(t.month), earned: round2(t.total * (p.hourly_rate || 0)) };
}

function createProject({ name, description = '', hourly_rate = 0, color }) {
  name = clean(name, 120);
  if (!name) throw new UserError('Please give the project a name.');
  if (get('SELECT id FROM projects WHERE name = ? COLLATE NOCASE AND deleted_at IS NULL', name)) {
    throw new UserError(`You already have a project called "${name}".`);
  }
  return tx(() => {
    const count = get('SELECT COUNT(*) AS n FROM projects').n;
    const folderId = Number(run('INSERT INTO folders(name, parent_id) VALUES (?, ?)', name, systemFolder('projects')).lastInsertRowid);
    for (const sub of ['Spreadsheets', 'Documents', 'Reports']) run('INSERT INTO folders(name, parent_id) VALUES (?, ?)', sub, folderId);
    const id = Number(run('INSERT INTO projects(name, description, hourly_rate, color, folder_id) VALUES (?, ?, ?, ?, ?)',
      name, clean(description, 2000), Number(hourly_rate) || 0, COLORS.includes(color) ? color : COLORS[count % COLORS.length], folderId).lastInsertRowid);
    run('UPDATE folders SET project_id = ? WHERE id = ? OR parent_id = ?', id, folderId, folderId);
    logActivity('📁', `Created project "${name}"`, `#/projects/${id}`);
    return getProject(id);
  });
}

function updateProject(id, fields) {
  const p = getProject(id);
  const name = fields.name !== undefined ? clean(fields.name, 120) : p.name;
  if (!name) throw new UserError('Please give the project a name.');
  run(`UPDATE projects SET name = ?, description = ?, hourly_rate = ?, color = ?, status = ?, updated_at = datetime('now') WHERE id = ?`,
    name,
    fields.description !== undefined ? clean(fields.description, 2000) : p.description,
    fields.hourly_rate !== undefined ? Number(fields.hourly_rate) || 0 : p.hourly_rate,
    COLORS.includes(fields.color) ? fields.color : p.color,
    ['active', 'done'].includes(fields.status) ? fields.status : p.status,
    id);
  if (name !== p.name && p.folder_id) run('UPDATE folders SET name = ? WHERE id = ?', name, p.folder_id);
  if (fields.status && fields.status !== p.status) logActivity(fields.status === 'done' ? '✅' : '🔄', `Marked "${name}" as ${fields.status === 'done' ? 'finished' : 'active'}`, `#/projects/${id}`);
  return getProject(id);
}

// ---------------------------------------------------------------- hours

function listEntries({ project_id, start, end, limit = 500 } = {}) {
  const where = ['e.deleted_at IS NULL', 'p.deleted_at IS NULL'];
  const params = [];
  if (project_id) { where.push('e.project_id = ?'); params.push(project_id); }
  if (start) { where.push('e.date >= ?'); params.push(start); }
  if (end) { where.push('e.date <= ?'); params.push(end); }
  params.push(Math.min(Number(limit) || 500, 5000));
  return all(`SELECT e.*, p.name AS project_name, p.color AS project_color
                FROM time_entries e JOIN projects p ON p.id = e.project_id
               WHERE ${where.join(' AND ')} ORDER BY e.date DESC, e.id DESC LIMIT ?`, ...params);
}

function checkEntry({ project_id, date, hours }) {
  need(get('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL', project_id), 'project');
  if (!isDate(date)) throw new UserError('Please pick a valid date.');
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0 || h > 24) throw new UserError('Hours must be a number between 0 and 24 (for example 1.5 for an hour and a half).');
  return round2(h);
}

function createEntry({ project_id, date = today(), hours, note = '' }) {
  const h = checkEntry({ project_id, date, hours });
  const id = Number(run('INSERT INTO time_entries(project_id, date, hours, note) VALUES (?, ?, ?, ?)', project_id, date, h, clean(note, 1000)).lastInsertRowid);
  const p = get('SELECT name FROM projects WHERE id = ?', project_id);
  logActivity('⏱️', `Logged ${h} hour${h === 1 ? '' : 's'} on "${p.name}"`, `#/projects/${project_id}`);
  return get('SELECT * FROM time_entries WHERE id = ?', id);
}

function updateEntry(id, fields) {
  const e = need(get('SELECT * FROM time_entries WHERE id = ? AND deleted_at IS NULL', id), 'time entry');
  const next = { ...e, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
  const h = checkEntry(next);
  run('UPDATE time_entries SET project_id = ?, date = ?, hours = ?, note = ? WHERE id = ?', next.project_id, next.date, h, clean(next.note, 1000), id);
  return get('SELECT * FROM time_entries WHERE id = ?', id);
}

// The running stopwatch is kept on the server so it survives closing the page.
function getTimer() {
  const t = setting('timer');
  if (!t) return null;
  const p = get('SELECT id, name, color FROM projects WHERE id = ? AND deleted_at IS NULL', t.project_id);
  if (!p) { setting('timer', null); return null; }
  return { ...t, project_name: p.name, project_color: p.color };
}

function startTimer({ project_id, note = '' }) {
  need(get('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL', project_id), 'project');
  if (getTimer()) stopTimer();
  setting('timer', { project_id: Number(project_id), note: clean(note, 1000), started_at: new Date().toISOString() });
  return getTimer();
}

function stopTimer({ discard = false } = {}) {
  const t = getTimer();
  if (!t) throw new UserError('The stopwatch is not running.');
  setting('timer', null);
  if (discard) return { entry: null, hours: 0 };
  const hours = Math.max(0.01, Math.min(24, round2((Date.now() - new Date(t.started_at).getTime()) / 3600000)));
  const d = new Date(t.started_at);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { entry: createEntry({ project_id: t.project_id, date, hours, note: t.note }), hours };
}

// ---------------------------------------------------------------- folders

function folderTree() {
  const rows = all('SELECT id, name, parent_id, project_id, system FROM folders WHERE deleted_at IS NULL ORDER BY system IS NULL, name COLLATE NOCASE');
  const counts = Object.fromEntries(all('SELECT folder_id, COUNT(*) AS n FROM files WHERE deleted_at IS NULL GROUP BY folder_id').map((r) => [r.folder_id, r.n]));
  const byParent = new Map();
  for (const f of rows) {
    f.file_count = counts[f.id] || 0;
    const k = f.parent_id ?? 0;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(f);
  }
  const build = (pid) => (byParent.get(pid) || []).map((f) => ({ ...f, children: build(f.id) }));
  const order = ['projects', 'reports', 'documents', 'inbox'];
  return build(0).sort((a, b) => (order.indexOf(a.system) + 1 || 99) - (order.indexOf(b.system) + 1 || 99));
}

// A flat list with full paths ("Projects / Smith House / Reports"): handy for pickers and the AI.
function folderPaths() {
  const out = [];
  const walk = (nodes, prefix) => nodes.forEach((f) => {
    const p = prefix ? `${prefix} / ${f.name}` : f.name;
    out.push({ id: f.id, path: p, project_id: f.project_id, files: f.file_count });
    walk(f.children, p);
  });
  walk(folderTree(), '');
  return out;
}

function breadcrumbs(folderId) {
  const crumbs = [];
  let f = get('SELECT id, name, parent_id FROM folders WHERE id = ?', folderId);
  while (f && crumbs.length < 50) { crumbs.unshift({ id: f.id, name: f.name }); f = f.parent_id ? get('SELECT id, name, parent_id FROM folders WHERE id = ?', f.parent_id) : null; }
  return crumbs;
}

function getFolder(id) {
  const f = need(get('SELECT * FROM folders WHERE id = ? AND deleted_at IS NULL', id), 'folder');
  return {
    ...f,
    breadcrumbs: breadcrumbs(id),
    folders: all('SELECT id, name, system, (SELECT COUNT(*) FROM files x WHERE x.folder_id = folders.id AND x.deleted_at IS NULL) AS file_count FROM folders WHERE parent_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE', id),
    files: all('SELECT id, name, kind, mime, size, project_id, created_at, updated_at FROM files WHERE folder_id = ? AND deleted_at IS NULL ORDER BY name COLLATE NOCASE', id),
  };
}

function createFolder({ name, parent_id }) {
  name = clean(name, 120);
  if (!name) throw new UserError('Please give the folder a name.');
  const parent = need(get('SELECT * FROM folders WHERE id = ? AND deleted_at IS NULL', parent_id), 'folder');
  if (get('SELECT id FROM folders WHERE parent_id = ? AND name = ? COLLATE NOCASE AND deleted_at IS NULL', parent_id, name)) {
    throw new UserError(`There is already a folder called "${name}" in "${parent.name}".`);
  }
  const id = Number(run('INSERT INTO folders(name, parent_id, project_id) VALUES (?, ?, ?)', name, parent_id, parent.project_id).lastInsertRowid);
  logActivity('📂', `Created folder "${name}" in "${parent.name}"`, `#/files/${id}`);
  return get('SELECT * FROM folders WHERE id = ?', id);
}

function descendants(folderId) {
  const ids = [folderId];
  for (let i = 0; i < ids.length; i++) all('SELECT id FROM folders WHERE parent_id = ? AND deleted_at IS NULL', ids[i]).forEach((r) => ids.push(r.id));
  return ids;
}

function updateFolder(id, { name, parent_id }) {
  const f = need(get('SELECT * FROM folders WHERE id = ? AND deleted_at IS NULL', id), 'folder');
  if (name !== undefined) {
    name = clean(name, 120);
    if (!name) throw new UserError('Please give the folder a name.');
    run('UPDATE folders SET name = ? WHERE id = ?', name, id);
  }
  if (parent_id !== undefined && parent_id !== f.parent_id) {
    if (f.system) throw new UserError('The main folders cannot be moved.');
    need(get('SELECT id FROM folders WHERE id = ? AND deleted_at IS NULL', parent_id), 'folder');
    if (descendants(id).includes(Number(parent_id))) throw new UserError('A folder cannot be moved inside itself.');
    run('UPDATE folders SET parent_id = ? WHERE id = ?', parent_id, id);
  }
  return get('SELECT * FROM folders WHERE id = ?', id);
}

// ---------------------------------------------------------------- files

const MIME_BY_EXT = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', txt: 'text/plain', pdf: 'application/pdf',
};

function uniqueName(folderId, name) {
  const taken = new Set(all('SELECT name FROM files WHERE folder_id = ? AND deleted_at IS NULL', folderId).map((r) => r.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) if (!taken.has(`${base} (${i})${ext}`.toLowerCase())) return `${base} (${i})${ext}`;
}

function folderOrThrow(folder_id) {
  if (folder_id == null || folder_id === '') throw new UserError('Please choose which folder to put this in.');
  return need(get('SELECT * FROM folders WHERE id = ? AND deleted_at IS NULL', folder_id), 'folder');
}

function safeFileName(name, fallback = 'file') {
  return clean(name, 150).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-') || fallback;
}

function saveBuffer({ buffer, name, mime, folder_id, kind = 'upload', project_id }) {
  const folder = folderOrThrow(folder_id);
  const stored = `${crypto.randomUUID()}${path.extname(name).toLowerCase()}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buffer);
  const finalName = uniqueName(folder.id, safeFileName(name));
  const id = Number(run('INSERT INTO files(folder_id, project_id, name, kind, mime, size, stored_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
    folder.id, project_id ?? folder.project_id ?? null, finalName, kind,
    MIME_BY_EXT[path.extname(name).slice(1).toLowerCase()] || (mime && mime !== 'application/octet-stream' ? mime : 'application/octet-stream'), buffer.length, stored).lastInsertRowid);
  logActivity(kind === 'report' ? '📊' : '📄', `${kind === 'report' ? 'Created report' : 'Added file'} "${finalName}" in "${folder.name}"`, `#/file/${id}`);
  return fileInfo(id);
}

function fileInfo(id) {
  const f = need(get('SELECT id, folder_id, project_id, name, kind, mime, size, created_at, updated_at FROM files WHERE id = ? AND deleted_at IS NULL', id), 'file');
  return { ...f, folder_path: breadcrumbs(f.folder_id).map((c) => c.name).join(' / ') };
}

function listFiles({ folder_id, project_id, kind, search, limit = 100 } = {}) {
  const where = ['deleted_at IS NULL'];
  const params = [];
  if (folder_id) { where.push('folder_id = ?'); params.push(folder_id); }
  if (project_id) { where.push('project_id = ?'); params.push(project_id); }
  if (kind) { where.push('kind = ?'); params.push(kind); }
  if (search) { where.push('name LIKE ?'); params.push(`%${search}%`); }
  params.push(Math.min(Number(limit) || 100, 500));
  return all(`SELECT id, folder_id, project_id, name, kind, mime, size, created_at, updated_at FROM files WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT ?`, ...params)
    .map((f) => ({ ...f, folder_path: breadcrumbs(f.folder_id).map((c) => c.name).join(' / ') }));
}

function updateFile(id, { name, folder_id }) {
  const f = need(get('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL', id), 'file');
  let target = f.folder_id;
  if (folder_id !== undefined && Number(folder_id) !== f.folder_id) {
    const folder = folderOrThrow(folder_id);
    target = folder.id;
    run("UPDATE files SET folder_id = ?, project_id = COALESCE(?, project_id), updated_at = datetime('now') WHERE id = ?", folder.id, folder.project_id, id);
    logActivity('📦', `Moved "${f.name}" to "${folder.name}"`, `#/file/${id}`);
  }
  if (name !== undefined) {
    let n = safeFileName(name, f.name);
    const ext = path.extname(f.name);
    if (f.kind !== 'spreadsheet' && ext && !n.toLowerCase().endsWith(ext.toLowerCase())) n += ext;
    if (n !== f.name) run("UPDATE files SET name = ?, updated_at = datetime('now') WHERE id = ?", uniqueName(target, n), id);
  }
  return fileInfo(id);
}

function filePath(id) {
  const f = need(get('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL', id), 'file');
  if (!f.stored_name) throw new UserError('This item has no file to download.');
  return { file: f, path: path.join(UPLOAD_DIR, f.stored_name) };
}

// Spreadsheets made inside the website.
function createSpreadsheet({ name, folder_id, template = 'expenses', columns, rows, project_id }) {
  const folder = folderOrThrow(folder_id);
  const sheet = columns ? sheetsLib.normalizeSheet({ columns, rows: rows || [] })
    : sheetsLib.normalizeSheet(sheetsLib.SHEET_TEMPLATES[template] || sheetsLib.SHEET_TEMPLATES.blank);
  const finalName = uniqueName(folder.id, safeFileName(name, 'New spreadsheet'));
  const id = Number(run("INSERT INTO files(folder_id, project_id, name, kind, mime, sheet) VALUES (?, ?, ?, 'spreadsheet', 'application/x-sheet', ?)",
    folder.id, project_id ?? folder.project_id ?? null, finalName, JSON.stringify(sheet)).lastInsertRowid);
  logActivity('🧮', `Created spreadsheet "${finalName}" in "${folder.name}"`, `#/file/${id}`);
  return getSpreadsheet(id);
}

function getSpreadsheet(id) {
  const f = need(get("SELECT * FROM files WHERE id = ? AND kind = 'spreadsheet' AND deleted_at IS NULL", id), 'spreadsheet');
  const sheet = sheetsLib.normalizeSheet(JSON.parse(f.sheet || '{}'));
  return { ...fileInfo(id), sheet, totals: sheetsLib.sheetTotals(sheet) };
}

function saveSpreadsheet(id, sheet) {
  getSpreadsheet(id);
  const s = sheetsLib.normalizeSheet(sheet);
  if (s.columns.length > 50 || s.rows.length > 5000) throw new UserError('That spreadsheet is too big (up to 50 columns and 5000 rows).');
  run("UPDATE files SET sheet = ?, updated_at = datetime('now') WHERE id = ?", JSON.stringify(s), id);
  return getSpreadsheet(id);
}

async function importSpreadsheet({ buffer, filename, folder_id, project_id }) {
  const sheets = await sheetsLib.sheetsFromUpload(buffer, filename);
  if (!sheets.length) throw new UserError('That file had no sheets in it.');
  const base = filename.replace(/\.(xlsx|csv)$/i, '');
  return sheets.map((s) => createSpreadsheet({ name: sheets.length > 1 ? `${base} - ${s.name}` : base, folder_id, columns: s.columns, rows: s.rows, project_id }));
}

// Plain text of a file, so the assistant can read it.
const MAX_TEXT = 150000;
async function readFileText(id) {
  const f = need(get('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL', id), 'file');
  let text;
  if (f.kind === 'spreadsheet') {
    text = sheetsLib.toCsv(sheetsLib.normalizeSheet(JSON.parse(f.sheet || '{}')));
  } else {
    const p = path.join(UPLOAD_DIR, f.stored_name);
    const ext = path.extname(f.name).toLowerCase();
    if (ext === '.docx') text = (await mammoth.extractRawText({ path: p })).value;
    else if (ext === '.xlsx' || ext === '.csv') {
      const sheets = await sheetsLib.sheetsFromUpload(fs.readFileSync(p), f.name);
      text = sheets.map((s) => `## Sheet: ${s.name}\n${sheetsLib.toCsv(s)}`).join('\n\n');
    } else if (['.txt', '.md', '.json', '.html', '.htm', '.xml'].includes(ext) || (f.mime || '').startsWith('text/')) {
      text = fs.readFileSync(p, 'utf8');
    } else {
      return { file: fileInfo(id), text: null, note: `I can't read the contents of ${ext || 'this kind of'} files yet. I can read Word (.docx), Excel (.xlsx), CSV and text files.` };
    }
  }
  const truncated = text.length > MAX_TEXT;
  return { file: fileInfo(id), text: truncated ? text.slice(0, MAX_TEXT) : text, note: truncated ? `This file is long; only the first ${MAX_TEXT} characters are included.` : undefined };
}

async function previewFile(id) {
  const f = need(get('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL', id), 'file');
  const info = fileInfo(id);
  if (f.kind === 'spreadsheet') return { ...info, type: 'spreadsheet' };
  const ext = path.extname(f.name).toLowerCase();
  const p = path.join(UPLOAD_DIR, f.stored_name);
  if (ext === '.docx') return { ...info, type: 'html', html: (await mammoth.convertToHtml({ path: p }, { styleMap: ["p[style-name='Title'] => h1:fresh"] })).value };
  if (ext === '.xlsx' || ext === '.csv') return { ...info, type: 'sheets', sheets: await sheetsLib.sheetsFromUpload(fs.readFileSync(p), f.name) };
  if ((f.mime || '').startsWith('image/')) return { ...info, type: 'image' };
  if (ext === '.pdf') return { ...info, type: 'pdf' };
  if (['.txt', '.md'].includes(ext)) return { ...info, type: 'text', text: fs.readFileSync(p, 'utf8').slice(0, 200000) };
  return { ...info, type: 'none' };
}

// Reports: kind 'hours' | 'project'
async function createReport({ kind = 'hours', project_id = null, start, end, format = 'docx', folder_id, name }) {
  folderOrThrow(folder_id);
  let report;
  if (kind === 'project') {
    if (!project_id) throw new UserError('Please choose which project the summary is for.');
    report = reports.projectReport(project_id);
  } else {
    if (!isDate(start) || !isDate(end)) throw new UserError('Please choose a start date and an end date for the report.');
    if (start > end) throw new UserError('The start date must be before the end date.');
    report = reports.hoursReport({ project_id, start, end });
  }
  const out = await reports.renderReport(report, format === 'xlsx' ? 'xlsx' : 'docx');
  return saveBuffer({ buffer: out.buffer, name: `${safeFileName(name || report.title)}.${out.ext}`, mime: out.mime, folder_id, kind: 'report', project_id });
}

// A free-form document (written by the assistant).
async function createDocument({ title, sections, folder_id, name, format = 'docx', project_id }) {
  folderOrThrow(folder_id);
  let out;
  if (format === 'xlsx') {
    const sheets = (sections || []).filter((s) => s.table?.columns?.length)
      .map((s, i) => ({ name: s.heading || `Sheet ${i + 1}`, columns: s.table.columns, rows: s.table.rows || [], totals: true }));
    if (!sheets.length) throw new UserError('An Excel file needs at least one table.');
    out = { buffer: await sheetsLib.writeXlsx(sheets), ext: 'xlsx', mime: MIME_BY_EXT.xlsx };
  } else {
    out = { buffer: await reports.renderDocx({ title, sections }), ext: 'docx', mime: MIME_BY_EXT.docx };
  }
  return saveBuffer({ buffer: out.buffer, name: `${safeFileName(name || title, 'Document')}.${out.ext}`, mime: out.mime, folder_id, kind: 'report', project_id });
}

// ---------------------------------------------------------------- calendar

function listEvents({ start, end, project_id } = {}) {
  const where = ['ev.deleted_at IS NULL'];
  const params = [];
  if (start) { where.push('ev.date >= ?'); params.push(start); }
  if (end) { where.push('ev.date <= ?'); params.push(end); }
  if (project_id) { where.push('ev.project_id = ?'); params.push(project_id); }
  return all(`SELECT ev.*, p.name AS project_name, p.color AS project_color FROM events ev
                LEFT JOIN projects p ON p.id = ev.project_id AND p.deleted_at IS NULL
               WHERE ${where.join(' AND ')} ORDER BY ev.date, ev.time`, ...params);
}

function checkEvent({ title, date, time, project_id }) {
  if (!clean(title)) throw new UserError('Please give the event a name.');
  if (!isDate(date)) throw new UserError('Please pick a valid date.');
  if (time && !/^\d{2}:\d{2}$/.test(time)) throw new UserError('Please pick a valid time.');
  if (project_id) need(get('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL', project_id), 'project');
}

function createEvent({ title, date, time = '', notes = '', project_id = null }) {
  checkEvent({ title, date, time, project_id });
  const id = Number(run('INSERT INTO events(title, date, time, notes, project_id) VALUES (?, ?, ?, ?, ?)', clean(title, 200), date, time || '', clean(notes, 2000), project_id || null).lastInsertRowid);
  logActivity('📅', `Added "${clean(title, 200)}" to the calendar on ${reports.prettyDate(date)}`, `#/calendar/${date.slice(0, 7)}`);
  return get('SELECT * FROM events WHERE id = ?', id);
}

function updateEvent(id, fields) {
  const ev = need(get('SELECT * FROM events WHERE id = ? AND deleted_at IS NULL', id), 'event');
  const next = { ...ev, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
  checkEvent(next);
  run('UPDATE events SET title = ?, date = ?, time = ?, notes = ?, project_id = ? WHERE id = ?', clean(next.title, 200), next.date, next.time || '', clean(next.notes, 2000), next.project_id || null, id);
  return get('SELECT * FROM events WHERE id = ?', id);
}

// ---------------------------------------------------------------- recycle bin

const TABLES = { project: 'projects', entry: 'time_entries', folder: 'folders', file: 'files', event: 'events' };
const TYPE_WORD = { project: 'Project', entry: 'Time entry', folder: 'Folder', file: 'File', event: 'Calendar event' };

function stamp(table, ids, batch, now) {
  if (!ids.length) return;
  run(`UPDATE ${table} SET deleted_at = ?, delete_batch = ? WHERE deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, now, batch, ...ids);
}

function trashLabel(type, row) {
  if (type === 'entry') {
    const p = get('SELECT name FROM projects WHERE id = ?', row.project_id);
    return `${row.hours} hours on "${p?.name ?? 'project'}" (${reports.prettyDate(row.date)})`;
  }
  if (type === 'event') return `${row.title} (${reports.prettyDate(row.date)})`;
  return row.name;
}

function moveToTrash(type, id) {
  const table = TABLES[type];
  if (!table) throw new UserError('Unknown item type.');
  const row = need(get(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`, id), TYPE_WORD[type].toLowerCase());
  if (type === 'folder' && row.system) throw new UserError('The main folders cannot be deleted.');
  const batch = newBatch();
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  tx(() => {
    if (type === 'project') {
      stamp('projects', [id], batch, now);
      stamp('time_entries', all('SELECT id FROM time_entries WHERE project_id = ? AND deleted_at IS NULL', id).map((r) => r.id), batch, now);
      stamp('events', all('SELECT id FROM events WHERE project_id = ? AND deleted_at IS NULL', id).map((r) => r.id), batch, now);
      if (row.folder_id && get('SELECT id FROM folders WHERE id = ? AND deleted_at IS NULL', row.folder_id)) {
        const folders = descendants(row.folder_id);
        stamp('files', all(`SELECT id FROM files WHERE deleted_at IS NULL AND folder_id IN (${folders.map(() => '?').join(',')})`, ...folders).map((r) => r.id), batch, now);
        stamp('folders', folders, batch, now);
      }
      if (getTimer()?.project_id === Number(id)) setting('timer', null);
    } else if (type === 'folder') {
      const folders = descendants(Number(id));
      stamp('files', all(`SELECT id FROM files WHERE deleted_at IS NULL AND folder_id IN (${folders.map(() => '?').join(',')})`, ...folders).map((r) => r.id), batch, now);
      stamp('folders', folders, batch, now);
    } else {
      stamp(table, [id], batch, now);
    }
    run('INSERT INTO trash(batch, item_type, item_id, label, deleted_at) VALUES (?, ?, ?, ?, ?)', batch, type, id, trashLabel(type, row), now);
    logActivity('🗑️', `Moved ${TYPE_WORD[type].toLowerCase()} "${trashLabel(type, row)}" to the Recycle Bin`, '#/trash');
  });
  return { batch, label: trashLabel(type, row), type };
}

function listTrash() {
  return all('SELECT * FROM trash ORDER BY deleted_at DESC').map((t) => {
    const extra = [];
    for (const [type, table] of Object.entries(TABLES)) {
      const n = get(`SELECT COUNT(*) AS n FROM ${table} WHERE delete_batch = ?`, t.batch).n - (type === t.item_type ? 1 : 0);
      if (n > 0) extra.push(`${n} ${TYPE_WORD[type].toLowerCase()}${n === 1 ? '' : 's'}`);
    }
    return { ...t, type_word: TYPE_WORD[t.item_type], includes: extra };
  });
}

function restore(batch) {
  const t = need(get('SELECT * FROM trash WHERE batch = ?', batch), 'Recycle Bin item');
  const notes = [];
  tx(() => {
    for (const table of Object.values(TABLES)) run(`UPDATE ${table} SET deleted_at = NULL, delete_batch = NULL WHERE delete_batch = ?`, batch);
    run('DELETE FROM trash WHERE batch = ?', batch);
    // Put things somewhere sensible if what they lived in is still in the bin.
    const inbox = systemFolder('inbox');
    if (t.item_type === 'file') {
      const f = get('SELECT * FROM files WHERE id = ?', t.item_id);
      if (!get('SELECT id FROM folders WHERE id = ? AND deleted_at IS NULL', f.folder_id)) {
        run('UPDATE files SET folder_id = ? WHERE id = ?', inbox, f.id);
        notes.push('Its old folder is in the Recycle Bin, so it was put in "Inbox (new uploads)".');
      }
    }
    if (t.item_type === 'folder') {
      const f = get('SELECT * FROM folders WHERE id = ?', t.item_id);
      if (f.parent_id && !get('SELECT id FROM folders WHERE id = ? AND deleted_at IS NULL', f.parent_id)) {
        run('UPDATE folders SET parent_id = ? WHERE id = ?', systemFolder('documents'), f.id);
        notes.push('Its old parent folder is in the Recycle Bin, so it was put in "My Documents".');
      }
    }
    if (t.item_type === 'entry' || t.item_type === 'event') {
      const row = get(`SELECT project_id FROM ${TABLES[t.item_type]} WHERE id = ?`, t.item_id);
      const p = row.project_id && get('SELECT * FROM projects WHERE id = ?', row.project_id);
      if (p?.deleted_at) {
        const pb = p.delete_batch;
        for (const table of Object.values(TABLES)) run(`UPDATE ${table} SET deleted_at = NULL, delete_batch = NULL WHERE delete_batch = ?`, pb);
        run('DELETE FROM trash WHERE batch = ?', pb);
        notes.push(`Its project "${p.name}" was also brought back.`);
      }
    }
    logActivity('♻️', `Restored "${t.label}" from the Recycle Bin`, null);
  });
  return { restored: t.label, type: t.item_type, id: t.item_id, notes };
}

function purge(batch) {
  need(get('SELECT * FROM trash WHERE batch = ?', batch), 'Recycle Bin item');
  tx(() => {
    for (const f of all('SELECT stored_name FROM files WHERE delete_batch = ? AND stored_name IS NOT NULL', batch)) {
      fs.rmSync(path.join(UPLOAD_DIR, f.stored_name), { force: true });
    }
    for (const table of Object.values(TABLES)) run(`DELETE FROM ${table} WHERE delete_batch = ?`, batch);
    run('DELETE FROM trash WHERE batch = ?', batch);
  });
}

function emptyTrash() {
  const batches = all('SELECT batch FROM trash');
  batches.forEach((b) => purge(b.batch));
  return { removed: batches.length };
}

// ---------------------------------------------------------------- dashboard & search

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function weekStart(iso) {
  const d = new Date(`${iso}T12:00:00`);
  return addDays(iso, -((d.getDay() + 6) % 7)); // Monday
}

function dashboard() {
  const t = today();
  const sum = (start, end) => round2(get(`SELECT COALESCE(SUM(e.hours),0) AS h FROM time_entries e JOIN projects p ON p.id = e.project_id
                                           WHERE e.deleted_at IS NULL AND p.deleted_at IS NULL AND e.date BETWEEN ? AND ?`, start, end).h);
  const start14 = addDays(t, -13);
  const daily = Object.fromEntries(all(`SELECT e.date, SUM(e.hours) AS h FROM time_entries e JOIN projects p ON p.id = e.project_id
                                         WHERE e.deleted_at IS NULL AND p.deleted_at IS NULL AND e.date BETWEEN ? AND ? GROUP BY e.date`, start14, t).map((r) => [r.date, round2(r.h)]));
  const monthStart = t.slice(0, 8) + '01';
  return {
    today: t,
    hours: { today: sum(t, t), week: sum(weekStart(t), t), month: sum(monthStart, t) },
    active_projects: get("SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NULL AND status = 'active'").n,
    last14: Array.from({ length: 14 }, (_, i) => { const d = addDays(start14, i); return { date: d, hours: daily[d] || 0 }; }),
    by_project_month: all(`SELECT p.id, p.name, p.color, ROUND(SUM(e.hours), 2) AS hours FROM time_entries e JOIN projects p ON p.id = e.project_id
                            WHERE e.deleted_at IS NULL AND p.deleted_at IS NULL AND e.date BETWEEN ? AND ? GROUP BY p.id ORDER BY hours DESC`, monthStart, t),
    upcoming: listEvents({ start: t, end: addDays(t, 30) }).slice(0, 6),
    activity: all('SELECT * FROM activity ORDER BY id DESC LIMIT 12'),
    recent_files: listFiles({ limit: 6 }),
    timer: getTimer(),
    trash_count: get('SELECT COUNT(*) AS n FROM trash').n,
  };
}

function search(q) {
  q = clean(q, 100);
  if (!q) return { projects: [], files: [], folders: [], events: [] };
  const like = `%${q}%`;
  return {
    projects: all('SELECT id, name, color FROM projects WHERE deleted_at IS NULL AND (name LIKE ? OR description LIKE ?) LIMIT 20', like, like),
    folders: all('SELECT id, name FROM folders WHERE deleted_at IS NULL AND name LIKE ? LIMIT 20', like).map((f) => ({ ...f, path: breadcrumbs(f.id).map((c) => c.name).join(' / ') })),
    files: listFiles({ search: q, limit: 20 }),
    events: all('SELECT id, title, date FROM events WHERE deleted_at IS NULL AND (title LIKE ? OR notes LIKE ?) ORDER BY date DESC LIMIT 20', like, like),
  };
}

module.exports = {
  UserError, today, addDays, weekStart, isDate, COLORS,
  listProjects, getProject, createProject, updateProject,
  listEntries, createEntry, updateEntry, getTimer, startTimer, stopTimer,
  folderTree, folderPaths, getFolder, createFolder, updateFolder,
  saveBuffer, fileInfo, listFiles, updateFile, filePath, previewFile, readFileText,
  createSpreadsheet, getSpreadsheet, saveSpreadsheet, importSpreadsheet, createReport, createDocument,
  listEvents, createEvent, updateEvent,
  moveToTrash, listTrash, restore, purge, emptyTrash,
  dashboard, search, systemFolder,
};
