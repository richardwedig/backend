// The Helper, running on the viewer's own Claude account through the page's
// `sample` capability. Its tools call the same functions the pages use.
import { cap, UserError } from './platform.js';
import * as S from './store.js';

const RULES = `You are the friendly helper built into "Work Tracker", a website where one person tracks the hours they work on projects, keeps spreadsheets of expenses and costs, organizes files in folders, and keeps a calendar.

The person you help is older and not very technical. Write in plain, warm, everyday language. Keep replies short: a few sentences, or a short numbered list when giving steps. Never use technical words like "database", "ID", "API", "JSON" or "tool". Don't use markdown tables or headings; simple **bold** and numbered or bulleted lists are fine.

How the website is laid out (the big buttons on the left side of the screen):
- Home: hours this week and month, charts, upcoming calendar items and recent activity.
- My Hours: a big Start/Stop stopwatch, a form to type in hours by hand, and a list of past hours that can be changed or deleted.
- Projects: every project. Clicking one shows its hours, spreadsheets, files and calendar items. Each project automatically has its own folder (Projects / <name>) with Spreadsheets, Documents and Reports folders inside.
- Calendar: a month view showing hours worked each day plus events and reminders.
- Files & Folders: all folders and files. Top folders are Projects, Reports, My Documents and "Inbox (new uploads)".
- Reports: make an hours report or a project summary as a Word or Excel file.
- Recycle Bin: anything deleted goes here first and can be brought back with the green "Restore" button.
- The "Ask the Helper" button opens this chat. Its paperclip button attaches Word documents, spreadsheets and other files for you.

When they ask how to do something, tell them which button to press, step by step, and offer to take them there (navigate_to) or to do it for them.

Rules you must follow:
1. Filing: whenever you are about to create or save something (a report, document, spreadsheet, or folder) or move an attached file, and the person has NOT said where it should go, ASK them first which folder to put it in. Suggest two or three likely folders by name (for example the project's Reports folder) and wait for their answer. Do not pick a folder yourself. Only skip asking when they clearly told you the place.
2. Attached files arrive in "Inbox (new uploads)". If they attach a file without saying where it belongs, ask where to file it (and offer to read it). If it is a spreadsheet, offer to turn it into an editable spreadsheet.
3. Deleting: before moving anything to the Recycle Bin, confirm with them in plain words what will be removed. Remind them it can be brought back from the Recycle Bin.
4. Only state numbers you got from the website's records; look them up rather than guessing. For dates like "last week" or "this month", work them out from today's date (weeks start on Monday).
5. After you create something, say where you put it, and offer to open it.
6. If something fails, explain simply what went wrong and what they can do.
7. Be efficient: the current projects and folders are listed below each message, so use them directly instead of looking them up again.`;

const obj = (properties = {}, required = []) => ({ type: 'object', properties, required });
const id = (d) => ({ type: 'integer', description: d });
const str = (d) => ({ type: 'string', description: d });
const date = (d) => ({ type: 'string', description: `${d} (YYYY-MM-DD)` });
const rowsSchema = { type: 'array', items: { type: 'array', items: { type: ['string', 'number'] } } };
const tableSchema = { type: 'object', properties: { columns: { type: 'array', items: { type: 'string' } }, rows: rowsSchema }, required: ['columns', 'rows'] };

const PAGE_LINKS = {
  home: () => '#/', hours: () => '#/hours', projects: () => '#/projects', project: (i) => `#/projects/${i.item_id}`,
  calendar: (i) => `#/calendar${i.month ? `/${i.month}` : ''}`, files: () => '#/files', folder: (i) => `#/files/${i.item_id}`,
  file: (i) => `#/file/${i.item_id}`, reports: () => '#/reports', trash: () => '#/trash', help: () => '#/help',
};
const withLink = (f) => ({ id: f.id, name: f.name, folder_path: f.folder_path, link: `#/file/${f.id}` });
const small = (list, n) => (list.length > n ? { first: list.slice(0, n), more: list.length - n } : list);

function tools(actions) {
  const changed = () => actions.push({ type: 'refresh' });
  const t = (name, description, inputSchema, run, writes = false) => ({
    name, description, inputSchema,
    async execute(input) {
      try {
        const out = await run(input || {});
        if (writes) changed();
        return out ?? { ok: true };
      } catch (e) {
        throw new Error(e instanceof UserError ? e.message : 'That did not work because of an unexpected problem.');
      }
    },
  });
  return [
    t('get_overview', 'Hours today/this week/this month, upcoming events, recent activity, whether the stopwatch is running, and how many items are in the Recycle Bin.', obj(),
      () => { const d = S.dashboard(); delete d.last14; return d; }),
    t('create_project', 'Create a new project (also creates its folder with Spreadsheets, Documents and Reports inside).',
      obj({ name: str('Project name'), description: str('Optional description'), hourly_rate: { type: 'number', description: 'Optional pay per hour' } }, ['name']), (i) => S.createProject(i), true),
    t('update_project', 'Rename a project, change its description or hourly rate, or mark it finished ("done") or active.',
      obj({ project_id: id('Project id'), name: str('New name'), description: str('New description'), hourly_rate: { type: 'number' }, status: { type: 'string', enum: ['active', 'done'] } }, ['project_id']), (i) => S.updateProject(i.project_id, i), true),
    t('list_hours', 'Hours entries (newest first), with ids. Filter by project and/or date range.',
      obj({ project_id: id('Optional project id'), start: date('Optional first day'), end: date('Optional last day') }),
      (i) => small(S.listEntries(i).map(({ id: eid, date: d, hours, note, project_name }) => ({ id: eid, date: d, hours, note, project: project_name })), 200)),
    t('log_hours', 'Record hours worked on a project.',
      obj({ project_id: id('Project id'), date: date('Day worked; defaults to today'), hours: { type: 'number', description: 'Hours, e.g. 1.5' }, note: str('Optional note') }, ['project_id', 'hours']),
      (i) => S.createEntry({ ...i, date: i.date || S.today() }), true),
    t('update_hours', 'Change an existing hours entry.',
      obj({ entry_id: id('Entry id'), project_id: id('Project id'), date: date('Day'), hours: { type: 'number' }, note: str('Note') }, ['entry_id']), (i) => S.updateEntry(i.entry_id, i), true),
    t('stopwatch', 'Start or stop the stopwatch. Starting needs a project. Stopping saves the time as an hours entry.',
      obj({ action: { type: 'string', enum: ['start', 'stop', 'status'] }, project_id: id('Project id (for start)'), note: str('Optional note') }, ['action']),
      (i) => (i.action === 'start' ? S.startTimer(i) : i.action === 'stop' ? S.stopTimer() : S.getTimer() || { running: false }), true),
    t('list_files', 'Find files (with ids). Filter by folder, project, kind (upload, report, spreadsheet) or part of the name.',
      obj({ folder_id: id('Folder id'), project_id: id('Project id'), kind: { type: 'string', enum: ['upload', 'report', 'spreadsheet'] }, search: str('Part of the file name') }),
      (i) => S.listFiles(i).map((f) => ({ id: f.id, name: f.name, kind: f.kind, folder: f.folder_path, updated: f.updated_at }))),
    t('read_file', 'Read the text of a file: Word, Excel, CSV, text, a report, or a spreadsheet made in the website.', obj({ file_id: id('File id') }, ['file_id']),
      async (i) => {
        const r = await S.readFileText(i.file_id);
        if (r.text && r.text.length > 25000) return { file: r.file.name, text: r.text.slice(0, 25000), note: 'Only the first part of this long file is included.' };
        return { file: r.file.name, text: r.text, note: r.note };
      }),
    t('create_folder', 'Create a folder inside another folder.', obj({ name: str('Folder name'), parent_id: id('Folder to create it in') }, ['name', 'parent_id']), (i) => S.createFolder(i), true),
    t('move_or_rename_file', 'Move a file to another folder and/or rename it.', obj({ file_id: id('File id'), folder_id: id('Destination folder id'), name: str('New name') }, ['file_id']),
      (i) => S.updateFile(i.file_id, { name: i.name, folder_id: i.folder_id }), true),
    t('create_spreadsheet', 'Create an editable spreadsheet, from a template (expenses, budget, mileage, blank) or with given columns and rows.',
      obj({ name: str('Spreadsheet name'), folder_id: id('Folder to save in'), template: { type: 'string', enum: ['expenses', 'budget', 'mileage', 'blank'] }, columns: { type: 'array', items: { type: 'string' } }, rows: rowsSchema }, ['name', 'folder_id']),
      async (i) => withLink(await S.createSpreadsheet(i)), true),
    t('update_spreadsheet', 'Replace all columns and rows of a spreadsheet made in the website (read it first so nothing is lost).',
      obj({ file_id: id('Spreadsheet file id'), columns: { type: 'array', items: { type: 'string' } }, rows: rowsSchema }, ['file_id', 'columns', 'rows']),
      async (i) => withLink(await S.saveSpreadsheet(i.file_id, i)), true),
    t('import_spreadsheet', 'Turn an uploaded Excel or CSV file into an editable spreadsheet. The original is kept.',
      obj({ file_id: id('Uploaded file id'), folder_id: id('Folder for the editable copy') }, ['file_id', 'folder_id']),
      async (i) => {
        const info = S.fileInfo(i.file_id);
        const { data } = await S.downloadData(i.file_id);
        return (await S.importSpreadsheet({ bytes: data, filename: info.name, folder_id: i.folder_id, project_id: info.project_id })).map(withLink);
      }, true),
    t('create_report', 'Make a ready-made report file. kind "hours" = hours in a date range (all projects or one); kind "project" = full summary of one project. format docx = Word, xlsx = Excel.',
      obj({ kind: { type: 'string', enum: ['hours', 'project'] }, project_id: id('Project id (needed for kind project)'), start: date('First day (hours)'), end: date('Last day (hours)'), format: { type: 'string', enum: ['docx', 'xlsx'] }, folder_id: id('Folder to save in'), name: str('Optional file name without extension') }, ['kind', 'format', 'folder_id']),
      async (i) => withLink(await S.createReport(i)), true),
    t('create_document', 'Write a custom document or report as Word (docx) or Excel (xlsx), made of sections with paragraphs, bullets and tables. For Excel, each table becomes a sheet.',
      obj({ title: str('Title'), format: { type: 'string', enum: ['docx', 'xlsx'] }, folder_id: id('Folder to save in'), name: str('Optional file name'), project_id: id('Optional related project'),
        sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } }, bullets: { type: 'array', items: { type: 'string' } }, table: tableSchema } } } }, ['title', 'format', 'folder_id', 'sections']),
      async (i) => withLink(await S.createDocument(i)), true),
    t('list_calendar', 'Calendar events between two dates.', obj({ start: date('First day'), end: date('Last day'), project_id: id('Optional project') }, ['start', 'end']),
      (i) => S.listEvents(i).map(({ id: eid, title, date: d, time, notes, project_name }) => ({ id: eid, title, date: d, time, notes, project: project_name }))),
    t('add_calendar_event', 'Add an event or reminder to the calendar.',
      obj({ title: str('What it is'), date: date('Day'), time: str('Optional time, 24-hour HH:MM'), notes: str('Optional notes'), project_id: id('Optional project') }, ['title', 'date']), (i) => S.createEvent(i), true),
    t('search', 'Search projects, folders, files and calendar events by words.', obj({ query: str('Words to look for') }, ['query']), (i) => S.search(i.query)),
    t('move_to_recycle_bin', 'Delete something by moving it to the Recycle Bin (it can be restored). Confirm with the person first.',
      obj({ type: { type: 'string', enum: ['project', 'entry', 'folder', 'file', 'event'] }, item_id: id('Id of the item') }, ['type', 'item_id']), (i) => S.moveToTrash(i.type, i.item_id), true),
    t('list_recycle_bin', 'Everything in the Recycle Bin, with the "batch" value needed to restore each.', obj(), () => S.listTrash()),
    t('restore_from_recycle_bin', 'Bring something back from the Recycle Bin.', obj({ batch: str('The batch value from list_recycle_bin') }, ['batch']), (i) => S.restore(i.batch), true),
    t('navigate_to', 'Open a page of the website on the person\'s screen.',
      obj({ page: { type: 'string', enum: Object.keys(PAGE_LINKS) }, item_id: id('Project, folder or file id'), month: str('YYYY-MM for the calendar') }, ['page']),
      (i) => { const link = (PAGE_LINKS[i.page] || PAGE_LINKS.home)(i); actions.push({ type: 'navigate', link }); return { opened: link }; }),
  ];
}

// What the helper is told alongside each message, so it rarely needs to look things up.
function snapshot(context) {
  const t = S.today();
  const weekday = new Date(`${t}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
  const projects = S.listProjects().map((p) => `- ${p.name} (project id ${p.id}, folder id ${p.folder_id}, ${p.status === 'done' ? 'finished' : 'active'}${p.hourly_rate ? `, $${p.hourly_rate}/hr` : ''}, ${p.total_hours} hours total)`).join('\n') || '- (no projects yet)';
  const folders = S.folderPaths().map((f) => `- ${f.path} (folder id ${f.id}, ${f.files} files)`).join('\n');
  const timer = S.getTimer();
  const attached = (context.attachments || []).map((a) => `- "${a.name}" (file id ${a.id}), saved in ${a.folder_path}`).join('\n');
  return [
    `[Today is ${weekday}, ${t}.${context.page ? ` The person is looking at ${String(context.page).slice(0, 300)}.` : ''}${timer ? ` The stopwatch is running for ${timer.project_name}.` : ''}]`,
    `[Projects:\n${projects}]`,
    `[Folders:\n${folders}]`,
    attached ? `[They attached these files just now:\n${attached}]` : '',
  ].filter(Boolean).join('\n');
}

let turns = null; // [{role, content, display}]
async function load() { if (!turns) turns = await S.loadChat(); return turns; }

export async function enabled() { return Boolean(await cap('sample')); }
export async function history() {
  return (await load()).filter((m) => m.display).map((m) => ({ role: m.role, display: m.display }));
}
export async function newConversation() { turns = []; await S.saveChat(turns); return { ok: true }; }

function friendly(e) {
  switch (e?.code) {
    case 'not_granted': return 'The helper needs your permission to use Claude. Reload the page and choose Allow when asked.';
    case 'rate_limited': return 'The helper is busy right now. Please wait a minute and try again.';
    case 'prompt_too_large': return 'That was too much for me to read at once. Please start a New chat or ask about a smaller part.';
    case 'cancelled': return 'Stopped.';
    default: return 'Sorry, the helper ran into a problem. Please try again in a moment.';
  }
}

export async function chat({ message, context = {} }) {
  const sample = await cap('sample');
  const actions = [];
  if (!sample) return { reply: 'The helper is not available on this screen. Everything else works, and the Help page explains each part.', actions, error: true };
  await load();
  const text = String(message || '').slice(0, 20000);
  const display = text + (context.attachments?.length ? `\n📎 ${context.attachments.map((a) => a.name).join(', ')}` : '');
  const userTurn = { role: 'user', content: `${snapshot(context)}\n\n${text || '(no message, just the attachment)'}`, display };
  // Older turns keep only what was said; the bulky snapshot rides on the newest message only.
  const past = turns.slice(-30).map((m) => ({ role: m.role, content: m.role === 'user' ? (m.display || '(attachment)') : m.content }));
  const input = [{ role: 'user', content: RULES }, ...past, { role: 'user', content: userTurn.content }];
  try {
    const r = await sample(input, { tools: tools(actions) });
    const reply = (r.text || 'Done.').trim() + (r.truncated ? '\n\n(My answer was cut short. Ask me to continue if you need the rest.)' : '');
    turns.push(userTurn, { role: 'assistant', content: reply, display: reply });
    await S.saveChat(turns);
    return { reply, actions };
  } catch (e) {
    return { reply: friendly(e), actions, error: true };
  }
}
