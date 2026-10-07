// Answers the same requests the Node server answered (server/index.js), but
// inside the page, so the website's pages work unchanged.
import * as S from './store.js';
import { UserError } from './platform.js';
import { chat, history, newConversation, enabled } from './assistant.js';

const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));
const routes = [];
const on = (method, pattern, fn) => routes.push([method, new RegExp(`^${pattern}$`), fn]);

on('GET', '/api/me', () => ({ signed_in: true, password_required: false }));
on('GET', '/api/dashboard', () => S.dashboard());
on('GET', '/api/search', (m, b, q) => S.search(q.get('q')));

on('GET', '/api/projects', () => S.listProjects());
on('POST', '/api/projects', (m, b) => S.createProject(b));
on('GET', '/api/projects/(\\d+)', ([id]) => S.getProject(id));
on('PUT', '/api/projects/(\\d+)', ([id], b) => S.updateProject(id, b));
on('DELETE', '/api/projects/(\\d+)', ([id]) => S.moveToTrash('project', id));

on('GET', '/api/entries', (m, b, q) => S.listEntries({ project_id: num(q.get('project_id')), start: q.get('start') || undefined, end: q.get('end') || undefined, limit: num(q.get('limit')) }));
on('POST', '/api/entries', (m, b) => S.createEntry({ ...b, project_id: num(b.project_id) }));
on('PUT', '/api/entries/(\\d+)', ([id], b) => S.updateEntry(id, { ...b, project_id: num(b.project_id) }));
on('DELETE', '/api/entries/(\\d+)', ([id]) => S.moveToTrash('entry', id));
on('GET', '/api/timer', () => ({ timer: S.getTimer() }));
on('POST', '/api/timer/start', (m, b) => S.startTimer({ ...b, project_id: num(b.project_id) }).then((timer) => ({ timer })));
on('POST', '/api/timer/stop', (m, b) => S.stopTimer({ discard: Boolean(b?.discard) }));

on('GET', '/api/folders', () => ({ tree: S.folderTree(), paths: S.folderPaths(), special: Object.fromEntries(['projects', 'reports', 'inbox', 'documents'].map((k) => [k, S.systemFolder(k)])) }));
on('GET', '/api/folders/(\\d+)', ([id]) => S.getFolder(id));
on('POST', '/api/folders', (m, b) => S.createFolder({ name: b.name, parent_id: num(b.parent_id) }));
on('PUT', '/api/folders/(\\d+)', ([id], b) => S.updateFolder(id, { name: b.name, parent_id: num(b.parent_id) }));
on('DELETE', '/api/folders/(\\d+)', ([id]) => S.moveToTrash('folder', id));

on('GET', '/api/files', (m, b, q) => S.listFiles({ folder_id: num(q.get('folder_id')), project_id: num(q.get('project_id')), kind: q.get('kind') || undefined, search: q.get('search') || undefined }));
on('POST', '/api/files/upload', async (m, form) => {
  const folder_id = num(form.get('folder_id')) ?? S.systemFolder('inbox');
  const editable = form.get('editable') === '1';
  const out = [];
  for (const f of form.getAll('files')) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    const saved = await S.saveBytes({ bytes, name: f.name, folder_id, kind: 'upload' });
    out.push(saved);
    if (editable && /\.(xlsx|xls|csv)$/i.test(f.name)) {
      try { out.push(...(await S.importSpreadsheet({ bytes, filename: f.name, folder_id, project_id: saved.project_id }))); } catch { /* the original is still saved */ }
    }
  }
  if (!out.length) throw new UserError('No file was received. Please choose a file and try again.');
  return { files: out };
});
on('GET', '/api/files/(\\d+)', ([id]) => S.fileInfo(id));
on('GET', '/api/files/(\\d+)/preview', ([id]) => S.previewFile(id));
on('PUT', '/api/files/(\\d+)', ([id], b) => S.updateFile(id, { name: b.name, folder_id: num(b.folder_id) }));
on('DELETE', '/api/files/(\\d+)', ([id]) => S.moveToTrash('file', id));
on('POST', '/api/files/(\\d+)/import', async ([id], b) => {
  const info = S.fileInfo(id);
  if (!/\.(xlsx|xls|csv)$/i.test(info.name)) throw new UserError('Only Excel and CSV files can be turned into editable spreadsheets.');
  const { data } = await S.downloadData(id);
  return { files: await S.importSpreadsheet({ bytes: data, filename: info.name, folder_id: num(b?.folder_id) ?? info.folder_id, project_id: info.project_id }) };
});

on('POST', '/api/spreadsheets', (m, b) => S.createSpreadsheet({ ...b, folder_id: num(b.folder_id) }));
on('GET', '/api/spreadsheets/(\\d+)', ([id]) => S.getSpreadsheet(id));
on('PUT', '/api/spreadsheets/(\\d+)', ([id], b) => S.saveSpreadsheet(id, b.sheet));

on('POST', '/api/reports', (m, b) => S.createReport({ ...b, project_id: num(b.project_id), folder_id: num(b.folder_id) }));

on('GET', '/api/events', (m, b, q) => S.listEvents({ start: q.get('start') || undefined, end: q.get('end') || undefined, project_id: num(q.get('project_id')) }));
on('POST', '/api/events', (m, b) => S.createEvent({ ...b, project_id: num(b.project_id) }));
on('PUT', '/api/events/(\\d+)', ([id], b) => S.updateEvent(id, { ...b, project_id: num(b.project_id) ?? null }));
on('DELETE', '/api/events/(\\d+)', ([id]) => S.moveToTrash('event', id));
on('GET', '/api/calendar', (m, b, q) => {
  const month = /^\d{4}-\d{2}$/.test(q.get('month') || '') ? q.get('month') : S.today().slice(0, 7);
  const start = `${month}-01`;
  const end = `${month}-31`;
  const hours = {};
  for (const e of S.listEntries({ start, end, limit: 5000 })) {
    (hours[e.date] ||= []).push({ id: e.id, project_id: e.project_id, project: e.project_name, color: e.project_color, hours: e.hours, note: e.note });
  }
  return { month, events: S.listEvents({ start, end }), hours };
});

on('GET', '/api/trash', () => S.listTrash());
on('POST', '/api/trash/([\\w-]+)/restore', ([batch]) => S.restore(batch));
on('DELETE', '/api/trash/([\\w-]+)', ([batch]) => S.purge(batch));
on('DELETE', '/api/trash', () => S.emptyTrash());

on('GET', '/api/assistant', async () => ({ messages: await history(), enabled: await enabled() }));
on('POST', '/api/assistant', (m, b) => chat({ message: b.message, context: b.context }));
on('POST', '/api/assistant/new', () => newConversation());

export async function handle(method, url, body) {
  await S.ready();
  const u = new URL(url, 'https://local.invalid');
  for (const [m, re, fn] of routes) {
    if (m !== method) continue;
    const match = u.pathname.match(re);
    if (match) {
      try {
        return (await fn(match.slice(1), body, u.searchParams)) ?? { ok: true };
      } catch (e) {
        if (e instanceof UserError) throw e;
        console.error(e);
        throw new UserError('Something went wrong. Please try again.');
      }
    }
  }
  throw new UserError('Not found', 404);
}
