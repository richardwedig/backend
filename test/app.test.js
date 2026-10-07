// Run with: npm test  (uses a throwaway data folder)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-test-'));
const S = require('../server/services');
const assistant = require('../server/assistant');

test('projects get their own folders', () => {
  const p = S.createProject({ name: 'Test House', hourly_rate: 50 });
  const folder = S.getFolder(p.folder_id);
  assert.deepStrictEqual(folder.folders.map((f) => f.name).sort(), ['Documents', 'Reports', 'Spreadsheets']);
  assert.throws(() => S.createProject({ name: 'test house' }), /already have/);
});

test('hours are validated and totalled', () => {
  const p = S.listProjects()[0];
  S.createEntry({ project_id: p.id, date: '2026-10-01', hours: 2.5 });
  S.createEntry({ project_id: p.id, date: '2026-10-02', hours: 1 });
  assert.throws(() => S.createEntry({ project_id: p.id, date: '2026-10-02', hours: 30 }), /between 0 and 24/);
  assert.throws(() => S.createEntry({ project_id: p.id, date: 'yesterday', hours: 1 }), /valid date/);
  assert.strictEqual(S.getProject(p.id).total_hours, 3.5);
  assert.strictEqual(S.getProject(p.id).earned, 175);
});

test('deleting a project goes to the recycle bin and restores everything', () => {
  const p = S.createProject({ name: 'Doomed' });
  S.createEntry({ project_id: p.id, date: '2026-10-03', hours: 4 });
  const sheetFolder = S.getFolder(p.folder_id).folders.find((f) => f.name === 'Spreadsheets');
  const sheet = S.createSpreadsheet({ name: 'Costs', folder_id: sheetFolder.id, template: 'expenses' });
  const { batch } = S.moveToTrash('project', p.id);
  assert.ok(!S.listProjects().some((x) => x.id === p.id));
  assert.throws(() => S.getSpreadsheet(sheet.id), /Recycle Bin/);
  const t = S.listTrash().find((x) => x.batch === batch);
  assert.ok(t.includes.some((s) => s.includes('time entry')));
  S.restore(batch);
  assert.strictEqual(S.getProject(p.id).total_hours, 4);
  assert.strictEqual(S.getSpreadsheet(sheet.id).name, 'Costs');
});

test('restoring a file whose folder is still deleted puts it in the inbox', () => {
  const docs = S.systemFolder('documents');
  const folder = S.createFolder({ name: 'Temp', parent_id: docs });
  const file = S.saveBuffer({ buffer: Buffer.from('hello'), name: 'note.txt', folder_id: folder.id });
  const fileTrash = S.moveToTrash('file', file.id);
  S.moveToTrash('folder', folder.id);
  const r = S.restore(fileTrash.batch);
  assert.strictEqual(S.fileInfo(file.id).folder_id, S.systemFolder('inbox'));
  assert.ok(r.notes.length);
});

test('system folders cannot be deleted', () => {
  assert.throws(() => S.moveToTrash('folder', S.systemFolder('reports')), /cannot be deleted/);
});

test('spreadsheets total numeric columns and import CSV', async () => {
  const [s] = await S.importSpreadsheet({ buffer: Buffer.from('Item,Amount\nNails,"$1,200.50"\nWood,30\n'), filename: 'costs.csv', folder_id: S.systemFolder('documents') });
  assert.deepStrictEqual(s.sheet.columns, ['Item', 'Amount']);
  assert.deepStrictEqual(s.totals, [null, 1230.5]);
  const text = await S.readFileText(s.id);
  assert.match(text.text, /Nails/);
});

test('reports need a folder and produce Word and Excel files', async () => {
  await assert.rejects(S.createReport({ kind: 'hours', start: '2026-10-01', end: '2026-10-31', format: 'docx' }), /which folder/);
  const doc = await S.createReport({ kind: 'hours', start: '2026-10-01', end: '2026-10-31', format: 'docx', folder_id: S.systemFolder('reports') });
  assert.ok(doc.name.endsWith('.docx') && doc.size > 1000);
  const text = await S.readFileText(doc.id);
  assert.match(text.text, /Test House/);
  const p = S.listProjects()[0];
  const xl = await S.createReport({ kind: 'project', project_id: p.id, format: 'xlsx', folder_id: S.systemFolder('reports') });
  assert.ok(xl.name.endsWith('.xlsx'));
  const xtext = await S.readFileText(xl.id);
  assert.match(xtext.text, /Hours by month/);
});

test('assistant tools work and navigate', async () => {
  const actions = [];
  const folders = await assistant.runTool('list_folders', {}, actions);
  assert.ok(folders.some((f) => f.path === 'Reports'));
  const doc = await assistant.runTool('create_document', {
    title: 'Notes', format: 'docx', folder_id: S.systemFolder('reports'),
    sections: [{ heading: 'Hi', paragraphs: ['Hello'], table: { columns: ['A'], rows: [['1']] } }],
  }, actions);
  assert.match(doc.link, /^#\/file\/\d+$/);
  await assistant.runTool('navigate_to', { page: 'file', item_id: doc.id }, actions);
  assert.deepStrictEqual(actions.at(-1), { type: 'navigate', link: `#/file/${doc.id}` });
  assert.strictEqual(assistant.TOOLS.length, new Set(assistant.TOOLS.map((t) => t.name)).size);
});

test('assistant chat loop runs tools and keeps history valid', async () => {
  const calls = [];
  const replies = [
    { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me look.' }, { type: 'tool_use', id: 'tu1', name: 'list_projects', input: {} }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'You have projects.' }] },
  ];
  assistant.setClient({ beta: { messages: { create: async (req) => { calls.push(JSON.parse(JSON.stringify(req))); return replies.shift(); } } } });
  const r = await assistant.chat({ message: 'What projects do I have?', context: { page: 'Home' } });
  assert.match(r.reply, /You have projects/);
  assert.strictEqual(calls.length, 2);
  assert.strictEqual(calls[0].model, 'claude-opus-5-5');
  const last = calls[1].messages.at(-1);
  assert.strictEqual(last.role, 'user');
  assert.strictEqual(last.content[0].type, 'tool_result');
  assert.match(last.content[0].content, /Test House/);
  assert.deepStrictEqual(assistant.history().map((m) => m.role), ['user', 'assistant', 'assistant']);

  // A failure mid-turn is rolled back so the next turn still starts cleanly.
  assistant.setClient({ beta: { messages: { create: async () => { throw new Error('boom'); } } } });
  const bad = await assistant.chat({ message: 'again' });
  assert.ok(bad.error);
  assert.strictEqual(assistant.history().length, 3);
});
