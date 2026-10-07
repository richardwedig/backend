const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const multer = require('multer');
const { get, run } = require('./db');
const S = require('./services');
const assistant = require('./assistant');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024, files: 20 } });
const PASSWORD = process.env.APP_PASSWORD || '';

app.use(express.json({ limit: '10mb' }));

// ---- optional password (set APP_PASSWORD to turn it on)
const cookieToken = (req) => (req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).find(([k]) => k === 'wt_session')?.[1];
const signedIn = (req) => !PASSWORD || (cookieToken(req) && get('SELECT token FROM sessions WHERE token = ?', cookieToken(req)));

app.post('/api/login', (req, res) => {
  const given = Buffer.from(String(req.body?.password || ''));
  const want = Buffer.from(PASSWORD);
  if (!PASSWORD || (given.length === want.length && crypto.timingSafeEqual(given, want))) {
    const token = crypto.randomBytes(32).toString('hex');
    run('INSERT INTO sessions(token) VALUES (?)', token);
    res.setHeader('Set-Cookie', `wt_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${60 * 60 * 24 * 365}`);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'That password is not right. Please try again.' });
});
app.post('/api/logout', (req, res) => {
  if (cookieToken(req)) run('DELETE FROM sessions WHERE token = ?', cookieToken(req));
  res.setHeader('Set-Cookie', 'wt_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/api/me', (req, res) => res.json({ signed_in: Boolean(signedIn(req)), password_required: Boolean(PASSWORD) }));
app.use('/api', (req, res, next) => (signedIn(req) ? next() : res.status(401).json({ error: 'Please sign in.' })));

const h = (fn) => async (req, res) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (err) {
    if (err instanceof S.UserError) return res.status(err.status).json({ error: err.message });
    console.error(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
const num = (v) => (v === undefined || v === null || v === '' ? undefined : Number(v));

// ---- dashboard & search
app.get('/api/dashboard', h(() => S.dashboard()));
app.get('/api/search', h((req) => S.search(req.query.q)));

// ---- projects
app.get('/api/projects', h(() => S.listProjects()));
app.post('/api/projects', h((req) => S.createProject(req.body)));
app.get('/api/projects/:id', h((req) => S.getProject(num(req.params.id))));
app.put('/api/projects/:id', h((req) => S.updateProject(num(req.params.id), req.body)));
app.delete('/api/projects/:id', h((req) => S.moveToTrash('project', num(req.params.id))));

// ---- hours
app.get('/api/entries', h((req) => S.listEntries({ project_id: num(req.query.project_id), start: req.query.start, end: req.query.end, limit: num(req.query.limit) })));
app.post('/api/entries', h((req) => S.createEntry({ ...req.body, project_id: num(req.body.project_id) })));
app.put('/api/entries/:id', h((req) => S.updateEntry(num(req.params.id), { ...req.body, project_id: num(req.body.project_id) })));
app.delete('/api/entries/:id', h((req) => S.moveToTrash('entry', num(req.params.id))));
app.get('/api/timer', h(() => ({ timer: S.getTimer() })));
app.post('/api/timer/start', h((req) => ({ timer: S.startTimer({ ...req.body, project_id: num(req.body.project_id) }) })));
app.post('/api/timer/stop', h((req) => S.stopTimer({ discard: Boolean(req.body?.discard) })));

// ---- folders
app.get('/api/folders', h(() => ({ tree: S.folderTree(), paths: S.folderPaths(), special: { projects: S.systemFolder('projects'), reports: S.systemFolder('reports'), inbox: S.systemFolder('inbox'), documents: S.systemFolder('documents') } })));
app.get('/api/folders/:id', h((req) => S.getFolder(num(req.params.id))));
app.post('/api/folders', h((req) => S.createFolder({ name: req.body.name, parent_id: num(req.body.parent_id) })));
app.put('/api/folders/:id', h((req) => S.updateFolder(num(req.params.id), { name: req.body.name, parent_id: num(req.body.parent_id) })));
app.delete('/api/folders/:id', h((req) => S.moveToTrash('folder', num(req.params.id))));

// ---- files
app.get('/api/files', h((req) => S.listFiles({ folder_id: num(req.query.folder_id), project_id: num(req.query.project_id), kind: req.query.kind, search: req.query.search })));
app.post('/api/files/upload', upload.array('files'), h(async (req) => {
  const folder_id = num(req.body.folder_id) ?? S.systemFolder('inbox');
  const editable = req.body.editable === '1';
  const out = [];
  for (const f of req.files || []) {
    // Browsers send file names as latin1; turn them back into proper text.
    const name = Buffer.from(f.originalname, 'latin1').toString('utf8');
    const saved = S.saveBuffer({ buffer: f.buffer, name, mime: f.mimetype, folder_id, kind: 'upload' });
    out.push(saved);
    if (editable && /\.(xlsx|csv)$/i.test(name)) {
      try {
        out.push(...(await S.importSpreadsheet({ buffer: f.buffer, filename: name, folder_id, project_id: saved.project_id })));
      } catch (err) {
        if (!(err instanceof S.UserError)) console.error(err);
      }
    }
  }
  if (!out.length) throw new S.UserError('No file was received. Please choose a file and try again.');
  return { files: out };
}));
app.get('/api/files/:id', h((req) => S.fileInfo(num(req.params.id))));
app.get('/api/files/:id/preview', h((req) => S.previewFile(num(req.params.id))));
app.put('/api/files/:id', h((req) => S.updateFile(num(req.params.id), { name: req.body.name, folder_id: num(req.body.folder_id) })));
app.delete('/api/files/:id', h((req) => S.moveToTrash('file', num(req.params.id))));
app.get('/api/files/:id/download', h(async (req, res) => {
  const id = num(req.params.id);
  const info = S.fileInfo(id);
  const inline = req.query.inline === '1';
  if (info.kind === 'spreadsheet') {
    const sheet = S.getSpreadsheet(id);
    const buf = await require('./sheets').writeXlsx([{ name: sheet.name, ...sheet.sheet, totals: true }]);
    res.attachment(`${sheet.name}.xlsx`);
    res.type('xlsx');
    return res.send(buf);
  }
  const { file, path: p } = S.filePath(id);
  if (!fs.existsSync(p)) throw new S.UserError('The file is missing from storage.', 404);
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Only show safe kinds inside the page; everything else downloads.
  const showInline = inline && (/^image\/(png|jpe?g|gif|webp)$/.test(file.mime) || file.mime === 'application/pdf');
  res.setHeader('Content-Disposition', `${showInline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}`);
  res.sendFile(p);
}));

app.post('/api/files/:id/import', h(async (req) => {
  const { file, path: p } = S.filePath(num(req.params.id));
  if (!/\.(xlsx|csv)$/i.test(file.name)) throw new S.UserError('Only Excel (.xlsx) and CSV files can be turned into editable spreadsheets.');
  return { files: await S.importSpreadsheet({ buffer: fs.readFileSync(p), filename: file.name, folder_id: num(req.body.folder_id) ?? file.folder_id, project_id: file.project_id }) };
}));

// ---- spreadsheets
app.post('/api/spreadsheets', h((req) => S.createSpreadsheet({ ...req.body, folder_id: num(req.body.folder_id) })));
app.get('/api/spreadsheets/:id', h((req) => S.getSpreadsheet(num(req.params.id))));
app.put('/api/spreadsheets/:id', h((req) => S.saveSpreadsheet(num(req.params.id), req.body.sheet)));

// ---- reports
app.post('/api/reports', h((req) => S.createReport({ ...req.body, project_id: num(req.body.project_id), folder_id: num(req.body.folder_id) })));

// ---- calendar
app.get('/api/events', h((req) => S.listEvents({ start: req.query.start, end: req.query.end, project_id: num(req.query.project_id) })));
app.post('/api/events', h((req) => S.createEvent({ ...req.body, project_id: num(req.body.project_id) })));
app.put('/api/events/:id', h((req) => S.updateEvent(num(req.params.id), { ...req.body, project_id: num(req.body.project_id) ?? null })));
app.delete('/api/events/:id', h((req) => S.moveToTrash('event', num(req.params.id))));
app.get('/api/calendar', h((req) => {
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : S.today().slice(0, 7);
  const start = `${month}-01`;
  const end = `${month}-31`;
  const hours = {};
  for (const e of S.listEntries({ start, end, limit: 5000 })) {
    (hours[e.date] ||= []).push({ id: e.id, project_id: e.project_id, project: e.project_name, color: e.project_color, hours: e.hours, note: e.note });
  }
  return { month, events: S.listEvents({ start, end }), hours };
}));

// ---- recycle bin
app.get('/api/trash', h(() => S.listTrash()));
app.post('/api/trash/:batch/restore', h((req) => S.restore(req.params.batch)));
app.delete('/api/trash/:batch', h((req) => S.purge(req.params.batch)));
app.delete('/api/trash', h(() => S.emptyTrash()));

// ---- assistant (one conversation at a time, in order)
let chatQueue = Promise.resolve();
app.get('/api/assistant', h(() => ({ messages: assistant.history(), enabled: Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) })));
app.post('/api/assistant', h((req) => {
  const job = chatQueue.then(() => assistant.chat({ message: req.body.message, context: req.body.context }));
  chatQueue = job.catch(() => {});
  return job;
}));
app.post('/api/assistant/new', h(() => { assistant.newConversation(); return { ok: true }; }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// ---- the website itself
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// Multer errors (e.g. file too big) arrive here.
app.use((err, req, res, _next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'That file is too big. The limit is 50 MB.' : 'The upload did not work. Please try again.' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => console.log(`Work Tracker is running at http://localhost:${port}`));
}

module.exports = app;
