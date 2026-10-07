// Everything the website stores, kept in the artifact's `db` (shared, durable
// documents) and `assets` (uploaded files). This is the browser version of
// server/services.js: the same behaviour, including the Recycle Bin.
//
// Layout of the store:
//   projects/<id>, folders/<id>, files/<id>   one document each
//   hours/<YYYY-MM>, events/<YYYY-MM>         {items: [...]} one document per month
//   trash/<batch>                             what was deleted together, for restoring
//   meta/timer, meta/activity                 the stopwatch and the recent-activity list
// Deleting only marks things with `deleted_at` + `delete_batch`; restoring clears it.
import { cap, lib, UserError } from './platform.js';
import * as sheetsLib from './sheets.js';
import * as reports from './reports.js';

const COLS = ['projects', 'folders', 'files', 'hours', 'events', 'trash', 'meta'];
const S = Object.fromEntries(COLS.map((c) => [c, new Map()]));
let db = null;
let writable = true;
const listeners = new Set();
export const onChange = (fn) => listeners.add(fn);
let notifyTimer = null;
const notify = () => { clearTimeout(notifyTimer); notifyTimer = setTimeout(() => listeners.forEach((fn) => fn()), 60); };

// ---------------------------------------------------------------- start-up

let readyPromise = null;
export function ready() {
  readyPromise ||= (async () => {
    db = await cap('db');
    if (!db) { writable = false; return { stored: false }; }
    await Promise.all(COLS.map((name) => new Promise((resolve) => {
      let first = true;
      db.collection(name).onSnapshot((snap) => {
        S[name] = new Map(snap.docs.map((d) => [d.id, { ...d.data() }]));
        if (first) { first = false; resolve(); } else notify();
      }, () => { if (first) { first = false; resolve(); } });
    })));
    await ensureSystemFolders().catch(() => { writable = false; });
    return { stored: true };
  })();
  return readyPromise;
}
export const canSave = () => Boolean(db) && writable;

// ---------------------------------------------------------------- low-level writes

const queues = new Map();
function enqueue(path, fn) {
  const prev = queues.get(path) || Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(path, next);
  return next;
}
function writeError(e) {
  if (e?.code === 'quota_exceeded') return new UserError('Your storage is full. Empty the Recycle Bin or delete some old files, then try again.');
  if (e?.code === 'invalid_argument') return new UserError('This could not be saved. You may only have permission to look, not to change things.');
  if (e instanceof UserError) return e;
  return new UserError('This could not be saved just now. Please check your connection and try again.');
}
async function setDoc(col, id, data) {
  if (JSON.stringify(data).length > 240000) throw new UserError('That is too much to save in one place. Try splitting it into two.');
  S[col].set(String(id), data);
  notify();
  if (!db) return;
  await enqueue(`${col}/${id}`, () => db.doc(`${col}/${id}`).set(data)).catch((e) => { throw writeError(e); });
}
async function delDoc(col, id) {
  S[col].delete(String(id));
  notify();
  if (!db) return;
  await enqueue(`${col}/${id}`, () => db.doc(`${col}/${id}`).delete()).catch((e) => { throw writeError(e); });
}

// ---------------------------------------------------------------- helpers

let lastId = 0;
const newId = () => { lastId = Math.max(lastId + 1, Date.now() * 1000 + Math.floor(Math.random() * 1000)); return lastId; };
const newBatch = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
export const nowSql = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
export const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(`${s}T12:00:00`).getTime());
const round2 = (n) => Math.round(n * 100) / 100;
const clean = (s, max = 500) => String(s ?? '').trim().slice(0, max);
export const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
export const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const weekStart = (iso) => addDays(iso, -((new Date(`${iso}T12:00:00`).getDay() + 6) % 7));
const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

function need(row, what) {
  if (!row) throw new UserError(`That ${what} could not be found. It may have been moved to the Recycle Bin.`, 404);
  return row;
}
const live = (col) => [...S[col].values()].filter((x) => !x.deleted_at);
const getLive = (col, id) => { const x = S[col].get(String(id)); return x && !x.deleted_at ? x : null; };

// Month documents (hours, events) hold many items each.
const monthItems = (col) => [...S[col].values()].flatMap((d) => d.items || []);
const liveItems = (col) => monthItems(col).filter((x) => !x.deleted_at);
function findItem(col, id) {
  for (const [month, d] of S[col]) {
    const it = (d.items || []).find((x) => x.id === Number(id));
    if (it) return { month, item: it };
  }
  return null;
}
async function saveItems(col, month, items) {
  if (items.length) await setDoc(col, month, { items });
  else await delDoc(col, month);
}
async function putItem(col, item, oldMonth = null) {
  const month = item.date.slice(0, 7);
  if (oldMonth && oldMonth !== month) {
    await saveItems(col, oldMonth, (S[col].get(oldMonth)?.items || []).filter((x) => x.id !== item.id));
  }
  const items = (S[col].get(month)?.items || []).filter((x) => x.id !== item.id);
  items.push(item);
  items.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  await saveItems(col, month, items);
}

async function logActivity(icon, message, link = null) {
  const items = [{ at: nowSql(), icon, message, link }, ...(S.meta.get('activity')?.items || [])].slice(0, 50);
  await setDoc('meta', 'activity', { items }).catch(() => {});
}

// ---------------------------------------------------------------- folders

const SYSTEM_FOLDERS = [['projects', 'Projects'], ['reports', 'Reports'], ['inbox', 'Inbox (new uploads)'], ['documents', 'My Documents']];
async function ensureSystemFolders() {
  for (const [key, name] of SYSTEM_FOLDERS) {
    if (!live('folders').some((f) => f.system === key)) {
      const id = newId();
      await setDoc('folders', id, { id, name, parent_id: null, project_id: null, system: key, created_at: nowSql() });
    }
  }
}
export function systemFolder(key) {
  return live('folders').find((f) => f.system === key)?.id ?? null;
}

const filesIn = (folderId) => live('files').filter((f) => f.folder_id === folderId);

export function folderTree() {
  const rows = live('folders');
  const byParent = new Map();
  for (const f of rows) {
    const k = f.parent_id ?? 0;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push({ ...f, file_count: filesIn(f.id).length });
  }
  const build = (pid) => (byParent.get(pid) || [])
    .sort((a, b) => (a.system ? 0 : 1) - (b.system ? 0 : 1) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
    .map((f) => ({ ...f, children: build(f.id) }));
  const order = ['projects', 'reports', 'documents', 'inbox'];
  return build(0).sort((a, b) => (order.indexOf(a.system) + 1 || 99) - (order.indexOf(b.system) + 1 || 99));
}

export function folderPaths() {
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
  let f = S.folders.get(String(folderId));
  while (f && crumbs.length < 50) { crumbs.unshift({ id: f.id, name: f.name }); f = f.parent_id ? S.folders.get(String(f.parent_id)) : null; }
  return crumbs;
}
const pathText = (folderId) => breadcrumbs(folderId).map((c) => c.name).join(' / ');
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });

export function getFolder(id) {
  const f = need(getLive('folders', id), 'folder');
  return {
    ...f,
    breadcrumbs: breadcrumbs(f.id),
    folders: live('folders').filter((x) => x.parent_id === f.id).map((x) => ({ id: x.id, name: x.name, system: x.system, file_count: filesIn(x.id).length })).sort(byName),
    files: filesIn(f.id).map(fileSummary).sort(byName),
  };
}

export async function createFolder({ name, parent_id }) {
  name = clean(name, 120);
  if (!name) throw new UserError('Please give the folder a name.');
  const parent = need(getLive('folders', parent_id), 'folder');
  if (live('folders').some((f) => f.parent_id === parent.id && f.name.toLowerCase() === name.toLowerCase())) {
    throw new UserError(`There is already a folder called "${name}" in "${parent.name}".`);
  }
  const id = newId();
  const row = { id, name, parent_id: parent.id, project_id: parent.project_id ?? null, system: null, created_at: nowSql() };
  await setDoc('folders', id, row);
  await logActivity('📂', `Created folder "${name}" in "${parent.name}"`, `#/files/${id}`);
  return row;
}

function descendants(folderId) {
  const ids = [Number(folderId)];
  for (let i = 0; i < ids.length; i++) live('folders').filter((f) => f.parent_id === ids[i]).forEach((f) => ids.push(f.id));
  return ids;
}

export async function updateFolder(id, { name, parent_id }) {
  const f = need(getLive('folders', id), 'folder');
  const next = { ...f };
  if (name !== undefined) {
    next.name = clean(name, 120);
    if (!next.name) throw new UserError('Please give the folder a name.');
  }
  if (parent_id !== undefined && Number(parent_id) !== f.parent_id) {
    if (f.system) throw new UserError('The main folders cannot be moved.');
    need(getLive('folders', parent_id), 'folder');
    if (descendants(f.id).includes(Number(parent_id))) throw new UserError('A folder cannot be moved inside itself.');
    next.parent_id = Number(parent_id);
  }
  await setDoc('folders', f.id, next);
  return next;
}

// ---------------------------------------------------------------- projects

function projectTotals(id) {
  const items = liveItems('hours').filter((e) => e.project_id === id);
  const monthStart = today().slice(0, 8) + '01';
  return {
    total: round2(items.reduce((s, e) => s + e.hours, 0)),
    month: round2(items.filter((e) => e.date >= monthStart).reduce((s, e) => s + e.hours, 0)),
    last: items.reduce((m, e) => (e.date > (m || '') ? e.date : m), null),
  };
}

export function listProjects() {
  return live('projects').map((p) => {
    const t = projectTotals(p.id);
    return { ...p, total_hours: t.total, last_worked: t.last };
  }).sort((a, b) => (a.status === 'done') - (b.status === 'done') || byName(a, b));
}

export function getProject(id) {
  const p = need(getLive('projects', id), 'project');
  const t = projectTotals(p.id);
  return { ...p, total_hours: t.total, month_hours: t.month, earned: round2(t.total * (p.hourly_rate || 0)) };
}

export async function createProject({ name, description = '', hourly_rate = 0, color }) {
  name = clean(name, 120);
  if (!name) throw new UserError('Please give the project a name.');
  if (live('projects').some((p) => p.name.toLowerCase() === name.toLowerCase())) throw new UserError(`You already have a project called "${name}".`);
  const id = newId();
  const folderId = newId();
  const now = nowSql();
  await setDoc('folders', folderId, { id: folderId, name, parent_id: systemFolder('projects'), project_id: id, system: null, created_at: now });
  for (const sub of ['Spreadsheets', 'Documents', 'Reports']) {
    const sid = newId();
    await setDoc('folders', sid, { id: sid, name: sub, parent_id: folderId, project_id: id, system: null, created_at: now });
  }
  const count = S.projects.size;
  const row = { id, name, description: clean(description, 2000), hourly_rate: Number(hourly_rate) || 0, color: COLORS.includes(color) ? color : COLORS[count % COLORS.length], status: 'active', folder_id: folderId, created_at: now, updated_at: now };
  await setDoc('projects', id, row);
  await logActivity('📁', `Created project "${name}"`, `#/projects/${id}`);
  return getProject(id);
}

export async function updateProject(id, fields) {
  const p = need(getLive('projects', id), 'project');
  const name = fields.name !== undefined ? clean(fields.name, 120) : p.name;
  if (!name) throw new UserError('Please give the project a name.');
  const next = {
    ...p,
    name,
    description: fields.description !== undefined ? clean(fields.description, 2000) : p.description,
    hourly_rate: fields.hourly_rate !== undefined ? Number(fields.hourly_rate) || 0 : p.hourly_rate,
    color: COLORS.includes(fields.color) ? fields.color : p.color,
    status: ['active', 'done'].includes(fields.status) ? fields.status : p.status,
    updated_at: nowSql(),
  };
  await setDoc('projects', p.id, next);
  const folder = p.folder_id && getLive('folders', p.folder_id);
  if (folder && name !== p.name) await setDoc('folders', folder.id, { ...folder, name });
  if (fields.status && fields.status !== p.status) await logActivity(fields.status === 'done' ? '✅' : '🔄', `Marked "${name}" as ${fields.status === 'done' ? 'finished' : 'active'}`, `#/projects/${p.id}`);
  return getProject(p.id);
}

// ---------------------------------------------------------------- hours

function withProject(e) {
  const p = S.projects.get(String(e.project_id));
  return { ...e, project_name: p?.name ?? 'Project', project_color: p?.color ?? '#888' };
}
const projectLive = (id) => Boolean(getLive('projects', id));

export function listEntries({ project_id, start, end, limit = 500 } = {}) {
  return liveItems('hours')
    .filter((e) => projectLive(e.project_id) && (!project_id || e.project_id === Number(project_id)) && (!start || e.date >= start) && (!end || e.date <= end))
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
    .slice(0, Math.min(Number(limit) || 500, 5000))
    .map(withProject);
}

function checkEntry({ project_id, date, hours }) {
  need(getLive('projects', project_id), 'project');
  if (!isDate(date)) throw new UserError('Please pick a valid date.');
  const h = Number(hours);
  if (!Number.isFinite(h) || h <= 0 || h > 24) throw new UserError('Hours must be a number between 0 and 24 (for example 1.5 for an hour and a half).');
  return round2(h);
}

export async function createEntry({ project_id, date = today(), hours, note = '' }) {
  project_id = Number(project_id);
  const h = checkEntry({ project_id, date, hours });
  const item = { id: newId(), project_id, date, hours: h, note: clean(note, 1000), created_at: nowSql() };
  await putItem('hours', item);
  await logActivity('⏱️', `Logged ${h} hour${h === 1 ? '' : 's'} on "${S.projects.get(String(project_id)).name}"`, `#/projects/${project_id}`);
  return item;
}

export async function updateEntry(id, fields) {
  const found = findItem('hours', id);
  if (!found || found.item.deleted_at) need(null, 'time entry');
  const next = { ...found.item, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
  next.project_id = Number(next.project_id);
  next.hours = checkEntry(next);
  next.note = clean(next.note, 1000);
  await putItem('hours', next, found.month);
  return next;
}

export function getTimer() {
  const t = S.meta.get('timer');
  if (!t?.project_id) return null;
  const p = getLive('projects', t.project_id);
  if (!p) return null;
  return { ...t, project_name: p.name, project_color: p.color };
}

export async function startTimer({ project_id, note = '' }) {
  need(getLive('projects', project_id), 'project');
  if (getTimer()) await stopTimer();
  await setDoc('meta', 'timer', { project_id: Number(project_id), note: clean(note, 1000), started_at: new Date().toISOString() });
  return getTimer();
}

export async function stopTimer({ discard = false } = {}) {
  const t = getTimer();
  if (!t) throw new UserError('The stopwatch is not running.');
  await setDoc('meta', 'timer', {});
  if (discard) return { entry: null, hours: 0 };
  const hours = Math.max(0.01, Math.min(24, round2((Date.now() - new Date(t.started_at).getTime()) / 3600000)));
  const d = new Date(t.started_at);
  const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { entry: await createEntry({ project_id: t.project_id, date, hours, note: t.note }), hours };
}

// ---------------------------------------------------------------- files

const RAW_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
};
const MIME_BY_EXT = {
  ...RAW_TYPES,
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  doc: 'application/msword', xls: 'application/vnd.ms-excel',
};
const extOf = (name) => (name.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();

function fileSummary(f) {
  return { id: f.id, folder_id: f.folder_id, project_id: f.project_id, name: f.name, kind: f.kind, mime: f.mime, size: f.size || 0, created_at: f.created_at, updated_at: f.updated_at };
}

export function fileInfo(id) {
  const f = need(getLive('files', id), 'file');
  return { ...fileSummary(f), folder_path: pathText(f.folder_id) };
}

export function listFiles({ folder_id, project_id, kind, search, limit = 100 } = {}) {
  const q = search ? String(search).toLowerCase() : '';
  return live('files')
    .filter((f) => (!folder_id || f.folder_id === Number(folder_id)) && (!project_id || f.project_id === Number(project_id)) && (!kind || f.kind === kind) && (!q || f.name.toLowerCase().includes(q)))
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
    .slice(0, Math.min(Number(limit) || 100, 500))
    .map((f) => ({ ...fileSummary(f), folder_path: pathText(f.folder_id) }));
}

function uniqueName(folderId, name) {
  const taken = new Set(filesIn(folderId).map((f) => f.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  const m = name.match(/(\.[a-z0-9]+)$/i);
  const ext = m ? m[1] : '';
  const base = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) if (!taken.has(`${base} (${i})${ext}`.toLowerCase())) return `${base} (${i})${ext}`;
}

function folderOrThrow(folder_id) {
  if (folder_id == null || folder_id === '') throw new UserError('Please choose which folder to put this in.');
  return need(getLive('folders', folder_id), 'folder');
}

const safeFileName = (name, fallback = 'file') => clean(name, 150).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-') || fallback;

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(text) {
  const bin = atob(text.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function storeAsset(bytes, name) {
  const assets = await cap('assets');
  if (!assets) throw new UserError('Adding files is not available here. Only the owner of this page can add files.');
  const ext = extOf(name);
  // Word, Excel and other types aren't accepted as-is, so they are kept as base64 text.
  const rawType = RAW_TYPES[ext];
  let blob, encoding;
  if (rawType && !(rawType.startsWith('text/') || rawType === 'application/json') ) { blob = new Blob([bytes], { type: rawType }); encoding = 'raw'; }
  else { blob = new Blob([toBase64(bytes)], { type: 'text/plain' }); encoding = 'base64'; }
  try {
    const r = await assets.upload(blob, { type: blob.type });
    return { asset_id: r.id, encoding };
  } catch (e) {
    if (e?.code === 'too_large') throw new UserError(`"${name}" is too big. Files can be up to about 15 MB.`);
    if (e?.code === 'quota_or_state') throw new UserError('Your file storage is full. Empty the Recycle Bin, then try again.');
    if (e?.code === 'rate_limited') throw new UserError('Too many files at once. Please wait a moment and try again.');
    throw new UserError(`"${name}" could not be uploaded. Please try again.`);
  }
}

export async function fileBytes(f) {
  if (!f.asset_id) throw new UserError('This item has no file to download.');
  const res = await fetch(`/_blob/${f.asset_id}`);
  if (!res.ok) throw new UserError('The file could not be opened. Please try again.');
  return f.encoding === 'base64' ? fromBase64(await res.text()) : new Uint8Array(await res.arrayBuffer());
}

export async function saveBytes({ bytes, name, folder_id, kind = 'upload', project_id }) {
  const folder = folderOrThrow(folder_id);
  const { asset_id, encoding } = await storeAsset(bytes, name);
  const finalName = uniqueName(folder.id, safeFileName(name));
  const id = newId();
  const now = nowSql();
  await setDoc('files', id, { id, folder_id: folder.id, project_id: project_id ?? folder.project_id ?? null, name: finalName, kind, mime: MIME_BY_EXT[extOf(name)] || 'application/octet-stream', size: bytes.length, asset_id, encoding, created_at: now, updated_at: now });
  await logActivity('📄', `Added file "${finalName}" in "${folder.name}"`, `#/file/${id}`);
  return fileInfo(id);
}

export async function updateFile(id, { name, folder_id }) {
  const f = need(getLive('files', id), 'file');
  const next = { ...f };
  if (folder_id !== undefined && Number(folder_id) !== f.folder_id) {
    const folder = folderOrThrow(folder_id);
    next.folder_id = folder.id;
    next.project_id = folder.project_id ?? f.project_id;
    await logActivity('📦', `Moved "${f.name}" to "${folder.name}"`, `#/file/${f.id}`);
  }
  if (name !== undefined) {
    let n = safeFileName(name, f.name);
    const ext = f.name.match(/(\.[a-z0-9]+)$/i)?.[1];
    if (f.kind !== 'spreadsheet' && ext && !n.toLowerCase().endsWith(ext.toLowerCase())) n += ext;
    if (n !== f.name) next.name = uniqueName(next.folder_id, n);
  }
  next.updated_at = nowSql();
  await setDoc('files', f.id, next);
  return fileInfo(f.id);
}

export async function createSpreadsheet({ name, folder_id, template = 'expenses', columns, rows, project_id }) {
  const folder = folderOrThrow(folder_id);
  const sheet = columns ? sheetsLib.normalizeSheet({ columns, rows: rows || [] })
    : sheetsLib.normalizeSheet(sheetsLib.SHEET_TEMPLATES[template] || sheetsLib.SHEET_TEMPLATES.blank);
  const finalName = uniqueName(folder.id, safeFileName(name, 'New spreadsheet'));
  const id = newId();
  const now = nowSql();
  await setDoc('files', id, { id, folder_id: folder.id, project_id: num(project_id) ?? folder.project_id ?? null, name: finalName, kind: 'spreadsheet', mime: 'application/x-sheet', size: 0, sheet, created_at: now, updated_at: now });
  await logActivity('🧮', `Created spreadsheet "${finalName}" in "${folder.name}"`, `#/file/${id}`);
  return getSpreadsheet(id);
}

export function getSpreadsheet(id) {
  const f = need(getLive('files', id), 'spreadsheet');
  if (f.kind !== 'spreadsheet') need(null, 'spreadsheet');
  const sheet = sheetsLib.normalizeSheet(f.sheet);
  return { ...fileInfo(id), sheet, totals: sheetsLib.sheetTotals(sheet) };
}

export async function saveSpreadsheet(id, sheet) {
  const f = need(getLive('files', id), 'spreadsheet');
  const s = sheetsLib.normalizeSheet(sheet);
  if (s.columns.length > 50 || s.rows.length > 3000) throw new UserError('That spreadsheet is too big (up to 50 columns and 3000 rows).');
  await setDoc('files', f.id, { ...f, sheet: s, updated_at: nowSql() });
  return getSpreadsheet(id);
}

export async function importSpreadsheet({ bytes, filename, folder_id, project_id }) {
  const sheets = await sheetsLib.sheetsFromBytes(bytes, filename);
  if (!sheets.length) throw new UserError('That file had no sheets in it.');
  const base = filename.replace(/\.(xlsx|xls|csv)$/i, '');
  const out = [];
  for (const s of sheets) out.push(await createSpreadsheet({ name: sheets.length > 1 ? `${base} - ${s.name}` : base, folder_id, columns: s.columns, rows: s.rows.slice(0, 3000), project_id }));
  return out;
}

const MAX_TEXT = 150000;
export async function readFileText(id) {
  const f = need(getLive('files', id), 'file');
  let text;
  if (f.kind === 'spreadsheet') text = sheetsLib.toCsv(sheetsLib.normalizeSheet(f.sheet));
  else if (f.kind === 'report') text = reports.specToText(f.report.spec);
  else {
    const ext = extOf(f.name);
    if (ext === 'docx') {
      const mammoth = await lib('mammoth');
      text = (await mammoth.extractRawText({ arrayBuffer: (await fileBytes(f)).buffer })).value;
    } else if (['xlsx', 'xls', 'csv'].includes(ext)) {
      const sheets = await sheetsLib.sheetsFromBytes(await fileBytes(f), f.name);
      text = sheets.map((s) => `## Sheet: ${s.name}\n${sheetsLib.toCsv(s)}`).join('\n\n');
    } else if (['txt', 'md', 'json'].includes(ext)) {
      text = new TextDecoder().decode(await fileBytes(f));
    } else {
      return { file: fileInfo(id), text: null, note: `I can't read the contents of .${ext || '?'} files. I can read Word (.docx), Excel (.xlsx), CSV and text files.` };
    }
  }
  const truncated = text.length > MAX_TEXT;
  return { file: fileInfo(id), text: truncated ? text.slice(0, MAX_TEXT) : text, note: truncated ? `This file is long; only the first ${MAX_TEXT} characters are included.` : undefined };
}

export async function previewFile(id) {
  const f = need(getLive('files', id), 'file');
  const info = fileInfo(id);
  if (f.kind === 'spreadsheet') return { ...info, type: 'spreadsheet' };
  if (f.kind === 'report') return { ...info, type: 'html', html: reports.specToHtml(f.report.spec) };
  const ext = extOf(f.name);
  if (ext === 'docx') {
    const mammoth = await lib('mammoth');
    const r = await mammoth.convertToHtml({ arrayBuffer: (await fileBytes(f)).buffer }, { styleMap: ["p[style-name='Title'] => h1:fresh"] });
    return { ...info, type: 'html', html: r.value };
  }
  if (['xlsx', 'xls', 'csv'].includes(ext)) return { ...info, type: 'sheets', sheets: await sheetsLib.sheetsFromBytes(await fileBytes(f), f.name) };
  if ((f.mime || '').startsWith('image/') && f.encoding === 'raw') return { ...info, type: 'image', src: `/_blob/${f.asset_id}` };
  if (ext === 'pdf' && f.encoding === 'raw') return { ...info, type: 'pdf', src: `/_blob/${f.asset_id}` };
  if (['txt', 'md', 'json'].includes(ext)) return { ...info, type: 'text', text: new TextDecoder().decode(await fileBytes(f)).slice(0, 200000) };
  return { ...info, type: 'none' };
}

// What a download hands over: {filename, data}
export async function downloadData(id) {
  const f = need(getLive('files', id), 'file');
  if (f.kind === 'spreadsheet') {
    const s = sheetsLib.normalizeSheet(f.sheet);
    return { filename: `${f.name}.xlsx`, data: await sheetsLib.writeXlsx([{ name: f.name, ...s, totals: true }]) };
  }
  if (f.kind === 'report') {
    const out = await reports.render(f.report);
    return { filename: f.name, data: out };
  }
  return { filename: f.name, data: await fileBytes(f) };
}

async function saveReport({ report, format, name, folder_id, project_id }) {
  const folder = folderOrThrow(folder_id);
  const ext = format === 'xlsx' ? 'xlsx' : 'docx';
  const finalName = uniqueName(folder.id, `${safeFileName(name || report.title)}.${ext}`);
  const id = newId();
  const now = nowSql();
  const stored = { format: ext, spec: report.spec, sheets: report.sheets };
  await setDoc('files', id, { id, folder_id: folder.id, project_id: num(project_id) ?? folder.project_id ?? null, name: finalName, kind: 'report', mime: MIME_BY_EXT[ext], size: JSON.stringify(stored).length, report: stored, created_at: now, updated_at: now });
  await logActivity('📊', `Created report "${finalName}" in "${folder.name}"`, `#/file/${id}`);
  return fileInfo(id);
}

export async function createReport({ kind = 'hours', project_id = null, start, end, format = 'docx', folder_id, name }) {
  folderOrThrow(folder_id);
  let report;
  if (kind === 'project') {
    if (!project_id) throw new UserError('Please choose which project the summary is for.');
    report = reports.projectReport(reportData(), Number(project_id));
  } else {
    if (!isDate(start) || !isDate(end)) throw new UserError('Please choose a start date and an end date for the report.');
    if (start > end) throw new UserError('The start date must be before the end date.');
    report = reports.hoursReport(reportData(), { project_id: num(project_id) ?? null, start, end });
  }
  return saveReport({ report, format, name, folder_id, project_id });
}

export async function createDocument({ title, sections, folder_id, name, format = 'docx', project_id }) {
  folderOrThrow(folder_id);
  const secs = Array.isArray(sections) ? sections : [];
  const sheets = secs.filter((s) => s.table?.columns?.length).map((s, i) => ({ name: s.heading || `Sheet ${i + 1}`, columns: s.table.columns.map(String), rows: s.table.rows || [], totals: true }));
  if (format === 'xlsx' && !sheets.length) throw new UserError('An Excel file needs at least one table.');
  return saveReport({ report: { title: clean(title, 200) || 'Document', spec: { title: clean(title, 200) || 'Document', sections: secs }, sheets }, format, name, folder_id, project_id });
}

// Everything the report builders need, without deleted things.
function reportData() {
  return {
    projects: live('projects'),
    entries: liveItems('hours').filter((e) => projectLive(e.project_id)),
    events: liveItems('events'),
    sheets: live('files').filter((f) => f.kind === 'spreadsheet'),
    today: today(),
  };
}

// ---------------------------------------------------------------- calendar

export function listEvents({ start, end, project_id } = {}) {
  return liveItems('events')
    .filter((e) => (!start || e.date >= start) && (!end || e.date <= end) && (!project_id || e.project_id === Number(project_id)))
    .sort((a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || ''))
    .map((e) => {
      const p = e.project_id && getLive('projects', e.project_id);
      return { ...e, project_name: p?.name ?? null, project_color: p?.color ?? null };
    });
}

function checkEvent({ title, date, time, project_id }) {
  if (!clean(title)) throw new UserError('Please give the event a name.');
  if (!isDate(date)) throw new UserError('Please pick a valid date.');
  if (time && !/^\d{2}:\d{2}$/.test(time)) throw new UserError('Please pick a valid time.');
  if (project_id) need(getLive('projects', project_id), 'project');
}

export async function createEvent({ title, date, time = '', notes = '', project_id = null }) {
  checkEvent({ title, date, time, project_id });
  const item = { id: newId(), title: clean(title, 200), date, time: time || '', notes: clean(notes, 2000), project_id: num(project_id) ?? null, created_at: nowSql() };
  await putItem('events', item);
  await logActivity('📅', `Added "${item.title}" to the calendar on ${reports.prettyDate(date)}`, `#/calendar/${date.slice(0, 7)}/${date}`);
  return item;
}

export async function updateEvent(id, fields) {
  const found = findItem('events', id);
  if (!found || found.item.deleted_at) need(null, 'event');
  const next = { ...found.item, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) };
  next.project_id = num(next.project_id) ?? null;
  checkEvent(next);
  next.title = clean(next.title, 200);
  next.notes = clean(next.notes, 2000);
  await putItem('events', next, found.month);
  return next;
}

// ---------------------------------------------------------------- recycle bin

const TYPE_WORD = { project: 'Project', entry: 'Time entry', folder: 'Folder', file: 'File', event: 'Calendar event' };
const WORD_PLURAL = { project: 'projects', entry: 'time entries', folder: 'folders', file: 'files', event: 'calendar events' };

function trashLabel(type, row) {
  if (type === 'entry') return `${row.hours} hours on "${S.projects.get(String(row.project_id))?.name ?? 'project'}" (${reports.prettyDate(row.date)})`;
  if (type === 'event') return `${row.title} (${reports.prettyDate(row.date)})`;
  return row.name;
}

// Marks rows deleted. refs: [{t: 'doc', col, id, type} | {t: 'item', col, month, id, type}]
async function stampAll(refs, batch, when) {
  const byMonth = new Map();
  for (const r of refs) {
    if (r.t === 'doc') {
      const row = S[r.col].get(String(r.id));
      if (row && !row.deleted_at) await setDoc(r.col, r.id, { ...row, deleted_at: when, delete_batch: batch });
    } else {
      const key = `${r.col}/${r.month}`;
      if (!byMonth.has(key)) byMonth.set(key, { col: r.col, month: r.month, ids: new Set() });
      byMonth.get(key).ids.add(r.id);
    }
  }
  for (const { col, month, ids } of byMonth.values()) {
    const items = (S[col].get(month)?.items || []).map((x) => (ids.has(x.id) && !x.deleted_at ? { ...x, deleted_at: when, delete_batch: batch } : x));
    await saveItems(col, month, items);
  }
}

function itemRefs(col, type, pred) {
  const out = [];
  for (const [month, d] of S[col]) for (const it of d.items || []) if (!it.deleted_at && pred(it)) out.push({ t: 'item', col, month, id: it.id, type });
  return out;
}
function folderRefs(folderId) {
  const ids = descendants(folderId);
  return [
    ...ids.map((id) => ({ t: 'doc', col: 'folders', id, type: 'folder' })),
    ...live('files').filter((f) => ids.includes(f.folder_id)).map((f) => ({ t: 'doc', col: 'files', id: f.id, type: 'file' })),
  ];
}

export async function moveToTrash(type, id) {
  id = Number(id);
  let row;
  let refs;
  if (type === 'entry' || type === 'event') {
    const found = findItem(type === 'entry' ? 'hours' : 'events', id);
    row = found && !found.item.deleted_at ? found.item : null;
    need(row, TYPE_WORD[type].toLowerCase());
    refs = [{ t: 'item', col: type === 'entry' ? 'hours' : 'events', month: found.month, id, type }];
  } else {
    const col = { project: 'projects', folder: 'folders', file: 'files' }[type];
    if (!col) throw new UserError('Unknown item type.');
    row = need(getLive(col, id), TYPE_WORD[type].toLowerCase());
    if (type === 'folder' && row.system) throw new UserError('The main folders cannot be deleted.');
    if (type === 'project') {
      refs = [
        { t: 'doc', col: 'projects', id, type: 'project' },
        ...itemRefs('hours', 'entry', (e) => e.project_id === id),
        ...itemRefs('events', 'event', (e) => e.project_id === id),
        ...(row.folder_id && getLive('folders', row.folder_id) ? folderRefs(row.folder_id) : []),
      ];
    } else if (type === 'folder') refs = folderRefs(id);
    else refs = [{ t: 'doc', col: 'files', id, type: 'file' }];
  }
  const batch = newBatch();
  const when = nowSql();
  const label = trashLabel(type, row);
  // Record what to restore first, so nothing can go missing half-way.
  await setDoc('trash', batch, { batch, item_type: type, item_id: id, label, deleted_at: when, refs: refs.map(({ t, col, month, id: rid, type: rt }) => ({ t, col, month: month ?? null, id: rid, type: rt })) });
  await stampAll(refs, batch, when);
  if (type === 'project' && getTimer()?.project_id === id) await setDoc('meta', 'timer', {});
  await logActivity('🗑️', `Moved ${TYPE_WORD[type].toLowerCase()} "${label}" to the Recycle Bin`, '#/trash');
  return { batch, label, type };
}

export function listTrash() {
  return [...S.trash.values()].map((t) => {
    const counts = {};
    for (const r of t.refs || []) if (!(r.type === t.item_type && r.id === t.item_id)) counts[r.type] = (counts[r.type] || 0) + 1;
    const includes = Object.entries(counts).map(([ty, n]) => `${n} ${n === 1 ? TYPE_WORD[ty].toLowerCase() : WORD_PLURAL[ty]}`);
    return { batch: t.batch, item_type: t.item_type, item_id: t.item_id, label: t.label, deleted_at: t.deleted_at, type_word: TYPE_WORD[t.item_type], includes };
  }).sort((a, b) => b.deleted_at.localeCompare(a.deleted_at));
}

async function unstamp(batch) {
  for (const col of ['projects', 'folders', 'files']) {
    for (const row of [...S[col].values()]) {
      if (row.delete_batch === batch) { const { deleted_at, delete_batch, ...rest } = row; await setDoc(col, rest.id, rest); }
    }
  }
  for (const col of ['hours', 'events']) {
    for (const [month, d] of [...S[col]]) {
      if ((d.items || []).some((x) => x.delete_batch === batch)) {
        await saveItems(col, month, d.items.map((x) => { if (x.delete_batch !== batch) return x; const { deleted_at, delete_batch, ...rest } = x; return rest; }));
      }
    }
  }
  await delDoc('trash', batch);
}

export async function restore(batch) {
  const t = need(S.trash.get(String(batch)), 'Recycle Bin item');
  const notes = [];
  await unstamp(batch);
  const inbox = systemFolder('inbox');
  if (t.item_type === 'file') {
    const f = S.files.get(String(t.item_id));
    if (f && !getLive('folders', f.folder_id)) {
      await setDoc('files', f.id, { ...f, folder_id: inbox });
      notes.push('Its old folder is in the Recycle Bin, so it was put in "Inbox (new uploads)".');
    }
  }
  if (t.item_type === 'folder') {
    const f = S.folders.get(String(t.item_id));
    if (f?.parent_id && !getLive('folders', f.parent_id)) {
      await setDoc('folders', f.id, { ...f, parent_id: systemFolder('documents') });
      notes.push('Its old parent folder is in the Recycle Bin, so it was put in "My Documents".');
    }
  }
  if (t.item_type === 'entry' || t.item_type === 'event') {
    const it = findItem(t.item_type === 'entry' ? 'hours' : 'events', t.item_id)?.item;
    const p = it?.project_id && S.projects.get(String(it.project_id));
    if (p?.deleted_at) {
      await unstamp(p.delete_batch);
      notes.push(`Its project "${p.name}" was also brought back.`);
    }
  }
  await logActivity('♻️', `Restored "${t.label}" from the Recycle Bin`, null);
  return { restored: t.label, type: t.item_type, id: t.item_id, notes };
}

export async function purge(batch) {
  need(S.trash.get(String(batch)), 'Recycle Bin item');
  const assets = await cap('assets');
  for (const col of ['projects', 'folders', 'files']) {
    for (const row of [...S[col].values()]) {
      if (row.delete_batch !== batch) continue;
      if (col === 'files' && row.asset_id && assets) await assets.delete(row.asset_id).catch(() => {});
      await delDoc(col, row.id);
    }
  }
  for (const col of ['hours', 'events']) {
    for (const [month, d] of [...S[col]]) {
      if ((d.items || []).some((x) => x.delete_batch === batch)) await saveItems(col, month, d.items.filter((x) => x.delete_batch !== batch));
    }
  }
  await delDoc('trash', batch);
}

export async function emptyTrash() {
  const batches = [...S.trash.keys()];
  for (const b of batches) await purge(b);
  return { removed: batches.length };
}

// ---------------------------------------------------------------- dashboard & search

export function dashboard() {
  const t = today();
  const entries = liveItems('hours').filter((e) => projectLive(e.project_id));
  const sum = (start, end) => round2(entries.filter((e) => e.date >= start && e.date <= end).reduce((s, e) => s + e.hours, 0));
  const start14 = addDays(t, -13);
  const monthStart = t.slice(0, 8) + '01';
  const byProject = new Map();
  for (const e of entries) {
    if (e.date < monthStart || e.date > t) continue;
    byProject.set(e.project_id, (byProject.get(e.project_id) || 0) + e.hours);
  }
  return {
    today: t,
    hours: { today: sum(t, t), week: sum(weekStart(t), t), month: sum(monthStart, t) },
    active_projects: live('projects').filter((p) => p.status === 'active').length,
    last14: Array.from({ length: 14 }, (_, i) => { const d = addDays(start14, i); return { date: d, hours: sum(d, d) }; }),
    by_project_month: [...byProject].map(([id, h]) => { const p = S.projects.get(String(id)); return { id, name: p.name, color: p.color, hours: round2(h) }; }).sort((a, b) => b.hours - a.hours),
    upcoming: listEvents({ start: t, end: addDays(t, 30) }).slice(0, 6),
    activity: (S.meta.get('activity')?.items || []).slice(0, 12),
    recent_files: listFiles({ limit: 6 }),
    timer: getTimer(),
    trash_count: S.trash.size,
  };
}

export function search(q) {
  q = clean(q, 100).toLowerCase();
  if (!q) return { projects: [], files: [], folders: [], events: [] };
  const has = (s) => String(s || '').toLowerCase().includes(q);
  return {
    projects: live('projects').filter((p) => has(p.name) || has(p.description)).slice(0, 20).map((p) => ({ id: p.id, name: p.name, color: p.color })),
    folders: live('folders').filter((f) => has(f.name)).slice(0, 20).map((f) => ({ id: f.id, name: f.name, path: pathText(f.id) })),
    files: listFiles({ search: q, limit: 20 }),
    events: liveItems('events').filter((e) => has(e.title) || has(e.notes)).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20).map((e) => ({ id: e.id, title: e.title, date: e.date })),
  };
}

// ---------------------------------------------------------------- helper chat history (private to each person)

let userId;
async function chatDoc() {
  if (userId === undefined) {
    const user = await cap('user');
    userId = user ? await user.id().catch(() => null) : null;
  }
  return db && userId ? db.doc(`data/users/${userId}/chat`) : null;
}
export async function loadChat() {
  const ref = await chatDoc();
  if (!ref) return [];
  try { const snap = await ref.get(); return snap.exists ? snap.data().turns || [] : []; } catch { return []; }
}
let chatSave = Promise.resolve();
export async function saveChat(turns) {
  const ref = await chatDoc();
  if (!ref) return;
  // Keep the conversation small: the newest 40 messages.
  const keep = turns.slice(-40);
  chatSave = chatSave.catch(() => {}).then(() => ref.set({ turns: keep }));
  return chatSave.catch(() => {});
}

export { UserError };
