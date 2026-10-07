// The built-in AI helper. It uses Claude with a set of tools that call the same
// functions the web pages use, so anything it creates shows up immediately.
const Anthropic = require('@anthropic-ai/sdk');
const { all, get, run, setting } = require('./db');
const S = require('./services');

const MODEL = process.env.ASSISTANT_MODEL || 'claude-opus-5-5';
const MAX_STEPS = 20;

let client = null;
const getClient = () => (client ??= new Anthropic());

const SYSTEM = `You are the friendly helper built into "Work Tracker", a website where one person tracks the hours they work on projects, keeps spreadsheets of expenses and costs, organizes files in folders, and keeps a calendar.

The person you help is older and not very technical. Write in plain, warm, everyday language. Keep replies short: a few sentences, or a short numbered list when giving steps. Never use technical words like "database", "ID", "API", "JSON" or "tool". Don't use markdown tables or headings; simple **bold** and numbered/bulleted lists are fine.

How the website is laid out (the big buttons on the left side of the screen):
- Home: a summary of hours this week and month, charts, upcoming calendar items and recent activity.
- Hours: a big Start/Stop stopwatch, plus a form to type in hours worked by hand, and a list of past hours that can be changed or deleted.
- Projects: every project. Clicking one shows its hours, its spreadsheets and files, and its calendar items. Each project automatically gets its own folder (Projects / <name>) with Spreadsheets, Documents and Reports folders inside.
- Calendar: a month view showing hours worked each day and events/reminders.
- Files & Folders: all folders and files. Top folders are Projects, Reports, My Documents and "Inbox (new uploads)".
- Reports: make an hours report or a project summary as a Word or Excel file.
- Recycle Bin: anything deleted goes here first and can be brought back with the green "Restore" button.
- The "Ask the Helper" button opens this chat. The paperclip button in the chat lets them attach Word documents, spreadsheets and other files for you.

When they ask how to do something, tell them which button to press, step by step, and offer to take them there (use navigate_to) or to do it for them.

Rules you must follow:
1. Filing: whenever you are about to create or save something (a report, document, spreadsheet, or folder) or move an attached file, and the person has NOT said where it should go, ASK them first which folder to put it in. Suggest two or three likely folders by name (for example the project's Reports folder) and wait for their answer. Do not pick a folder yourself. Only skip asking when they have clearly told you the place.
2. Attached files arrive in "Inbox (new uploads)". If they attach a file without saying where it belongs, ask where to file it (and offer to read it). If it is a spreadsheet, offer to turn it into an editable spreadsheet.
3. Deleting: before moving anything to the Recycle Bin, confirm with them in plain words what will be removed. Remind them it can be brought back from the Recycle Bin.
4. Only state numbers you got from the website's records; look them up rather than guessing. For dates like "last week" or "this month", work them out from today's date given with each message (weeks start on Monday).
5. After you create something, say where you put it, and offer to open it.
6. If something fails, explain simply what went wrong and what they can do.`;

const T = (name, description, properties = {}, required = []) => ({
  name, description, input_schema: { type: 'object', properties, required },
});
const id = (d) => ({ type: 'integer', description: d });
const str = (d) => ({ type: 'string', description: d });
const date = (d) => ({ type: 'string', description: `${d} (YYYY-MM-DD)` });
const tableSchema = {
  type: 'object',
  properties: { columns: { type: 'array', items: { type: 'string' } }, rows: { type: 'array', items: { type: 'array', items: { type: ['string', 'number'] } } } },
  required: ['columns', 'rows'],
};

const TOOLS = [
  T('get_overview', 'Hours today/this week/this month, active project count, upcoming events, recent activity, whether the stopwatch is running, and how many items are in the Recycle Bin.'),
  T('list_projects', 'All projects with their ids, hourly rate, status, total hours and last date worked.'),
  T('get_project', 'Details of one project.', { project_id: id('Project id') }, ['project_id']),
  T('create_project', 'Create a new project (also creates its folder with Spreadsheets, Documents and Reports subfolders).',
    { name: str('Project name'), description: str('Optional description'), hourly_rate: { type: 'number', description: 'Optional pay rate per hour' } }, ['name']),
  T('update_project', 'Rename a project, change its description or hourly rate, or mark it finished ("done") or active.',
    { project_id: id('Project id'), name: str('New name'), description: str('New description'), hourly_rate: { type: 'number' }, status: { type: 'string', enum: ['active', 'done'] } }, ['project_id']),
  T('list_hours', 'Hours entries, newest first. Filter by project and/or date range.',
    { project_id: id('Optional project id'), start: date('Optional first day'), end: date('Optional last day'), limit: { type: 'integer' } }),
  T('log_hours', 'Record hours worked on a project.',
    { project_id: id('Project id'), date: date('Day worked; defaults to today'), hours: { type: 'number', description: 'Hours, e.g. 1.5' }, note: str('Optional note about the work') }, ['project_id', 'hours']),
  T('update_hours', 'Change an existing hours entry.',
    { entry_id: id('Entry id'), project_id: id('Project id'), date: date('Day'), hours: { type: 'number' }, note: str('Note') }, ['entry_id']),
  T('stopwatch', 'Start or stop the stopwatch. Starting needs a project. Stopping saves the time as an hours entry.',
    { action: { type: 'string', enum: ['start', 'stop', 'status'] }, project_id: id('Project id (for start)'), note: str('Optional note (for start)') }, ['action']),
  T('list_folders', 'Every folder with its full path and id, and how many files are in it.'),
  T('list_files', 'Find files. Filter by folder, project, kind (upload, report, spreadsheet) or part of the name.',
    { folder_id: id('Folder id'), project_id: id('Project id'), kind: { type: 'string', enum: ['upload', 'report', 'spreadsheet'] }, search: str('Part of the file name') }),
  T('read_file', 'Read the contents of a file (Word, Excel, CSV, text, or a spreadsheet made in the website).', { file_id: id('File id') }, ['file_id']),
  T('create_folder', 'Create a folder inside another folder. Ask the person where it should go first if they did not say.',
    { name: str('Folder name'), parent_id: id('Id of the folder to create it in') }, ['name', 'parent_id']),
  T('move_or_rename_file', 'Move a file to another folder and/or rename it.',
    { file_id: id('File id'), folder_id: id('Destination folder id'), name: str('New name') }, ['file_id']),
  T('create_spreadsheet', 'Create an editable spreadsheet in the website, either from a template (expenses, budget, mileage, blank) or with given columns and rows. Ask the person where to put it first if they did not say.',
    { name: str('Spreadsheet name'), folder_id: id('Folder id to save in'), template: { type: 'string', enum: ['expenses', 'budget', 'mileage', 'blank'] }, columns: { type: 'array', items: { type: 'string' } }, rows: tableSchema.properties.rows }, ['name', 'folder_id']),
  T('update_spreadsheet', 'Replace the columns and rows of a spreadsheet made in the website (read it first so nothing is lost).',
    { file_id: id('Spreadsheet file id'), columns: { type: 'array', items: { type: 'string' } }, rows: tableSchema.properties.rows }, ['file_id', 'columns', 'rows']),
  T('import_spreadsheet', 'Turn an uploaded Excel (.xlsx) or CSV file into an editable spreadsheet in the website. The original file is kept.',
    { file_id: id('Uploaded file id'), folder_id: id('Folder to put the editable copy in') }, ['file_id', 'folder_id']),
  T('create_hours_report', 'Make a ready-made report file. kind "hours" = hours worked in a date range (all projects or one); kind "project" = full summary of one project (hours, money, spreadsheet totals, upcoming events). Ask where to file it first if the person did not say.',
    { kind: { type: 'string', enum: ['hours', 'project'] }, project_id: id('Project id (required for kind project, optional for hours)'), start: date('First day (hours reports)'), end: date('Last day (hours reports)'),
      format: { type: 'string', enum: ['docx', 'xlsx'], description: 'docx = Word, xlsx = Excel' }, folder_id: id('Folder id to save in'), name: str('Optional file name without extension') }, ['kind', 'format', 'folder_id']),
  T('create_document', 'Write a custom document or report as a Word (.docx) or Excel (.xlsx) file, with sections of paragraphs, bullet points and tables. For Excel, each section with a table becomes a sheet. Ask where to file it first if the person did not say.',
    { title: str('Document title'), format: { type: 'string', enum: ['docx', 'xlsx'] }, folder_id: id('Folder id to save in'), name: str('Optional file name without extension'), project_id: id('Optional related project'),
      sections: { type: 'array', items: { type: 'object', properties: { heading: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } }, bullets: { type: 'array', items: { type: 'string' } }, table: tableSchema } } } },
    ['title', 'format', 'folder_id', 'sections']),
  T('list_calendar', 'Calendar events between two dates.', { start: date('First day'), end: date('Last day'), project_id: id('Optional project id') }, ['start', 'end']),
  T('add_calendar_event', 'Add an event or reminder to the calendar.',
    { title: str('What it is'), date: date('Day'), time: str('Optional time, 24-hour HH:MM'), notes: str('Optional notes'), project_id: id('Optional project id') }, ['title', 'date']),
  T('search', 'Search projects, folders, files and calendar events by words.', { query: str('Words to look for') }, ['query']),
  T('move_to_recycle_bin', 'Delete something by moving it to the Recycle Bin (it can be restored). Confirm with the person first.',
    { type: { type: 'string', enum: ['project', 'entry', 'folder', 'file', 'event'] }, item_id: id('Id of the item') }, ['type', 'item_id']),
  T('list_recycle_bin', 'Everything currently in the Recycle Bin.'),
  T('restore_from_recycle_bin', 'Bring something back from the Recycle Bin.', { batch: str('The "batch" value from list_recycle_bin') }, ['batch']),
  T('navigate_to', 'Open a page of the website on the person\'s screen.',
    { page: { type: 'string', enum: ['home', 'hours', 'projects', 'project', 'calendar', 'files', 'folder', 'file', 'reports', 'trash', 'help'] },
      item_id: id('Project, folder or file id when page is project, folder or file'), month: str('YYYY-MM for the calendar') }, ['page']),
];

const PAGE_LINKS = {
  home: () => '#/', hours: () => '#/hours', projects: () => '#/projects', project: (i) => `#/projects/${i.item_id}`,
  calendar: (i) => `#/calendar${i.month ? `/${i.month}` : ''}`, files: () => '#/files', folder: (i) => `#/files/${i.item_id}`,
  file: (i) => `#/file/${i.item_id}`, reports: () => '#/reports', trash: () => '#/trash', help: () => '#/help',
};

const withLink = (file) => ({ ...file, link: `#/file/${file.id}` });

async function runTool(name, input, actions) {
  const i = input || {};
  switch (name) {
    case 'get_overview': { const d = S.dashboard(); delete d.last14; return d; }
    case 'list_projects': return S.listProjects();
    case 'get_project': return S.getProject(i.project_id);
    case 'create_project': return S.createProject(i);
    case 'update_project': return S.updateProject(i.project_id, i);
    case 'list_hours': return S.listEntries(i);
    case 'log_hours': return S.createEntry({ ...i, date: i.date || S.today() });
    case 'update_hours': return S.updateEntry(i.entry_id, i);
    case 'stopwatch':
      if (i.action === 'start') return S.startTimer(i);
      if (i.action === 'stop') return S.stopTimer();
      return S.getTimer() || { running: false };
    case 'list_folders': return S.folderPaths();
    case 'list_files': return S.listFiles(i);
    case 'read_file': return S.readFileText(i.file_id);
    case 'create_folder': return S.createFolder(i);
    case 'move_or_rename_file': return S.updateFile(i.file_id, { name: i.name, folder_id: i.folder_id });
    case 'create_spreadsheet': return withLink(S.createSpreadsheet(i));
    case 'update_spreadsheet': return withLink(S.saveSpreadsheet(i.file_id, i));
    case 'import_spreadsheet': {
      const { file, path: p } = S.filePath(i.file_id);
      const fs = require('node:fs');
      return (await S.importSpreadsheet({ buffer: fs.readFileSync(p), filename: file.name, folder_id: i.folder_id, project_id: file.project_id }))
        .map((s) => withLink({ id: s.id, name: s.name, folder_path: s.folder_path }));
    }
    case 'create_hours_report': return withLink(await S.createReport(i));
    case 'create_document': return withLink(await S.createDocument(i));
    case 'list_calendar': return S.listEvents(i);
    case 'add_calendar_event': return S.createEvent(i);
    case 'search': return S.search(i.query);
    case 'move_to_recycle_bin': return S.moveToTrash(i.type, i.item_id);
    case 'list_recycle_bin': return S.listTrash();
    case 'restore_from_recycle_bin': return S.restore(i.batch);
    case 'navigate_to': {
      const link = (PAGE_LINKS[i.page] || PAGE_LINKS.home)(i);
      actions.push({ type: 'navigate', link });
      return { opened: link };
    }
    default: throw new S.UserError(`Unknown action ${name}`);
  }
}

// ---- conversation storage (append-only, content stored exactly as returned)

function currentConversation() {
  return setting('conversation') || setting('conversation', 1);
}

function newConversation() {
  return setting('conversation', currentConversation() + 1);
}

function history(conversation = currentConversation()) {
  return all('SELECT id, role, display, created_at FROM chat_messages WHERE conversation = ? AND display IS NOT NULL ORDER BY id', conversation);
}

function save(conversation, role, content, display = null) {
  return Number(run('INSERT INTO chat_messages(conversation, role, content, display) VALUES (?, ?, ?, ?)', conversation, role, JSON.stringify(content), display).lastInsertRowid);
}

const textOf = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n').trim();

function friendlyError(err) {
  if (err instanceof Anthropic.AuthenticationError || /api key|apiKey|authentication/i.test(err?.message || '')) {
    return 'The helper is not switched on yet. Whoever set up this website needs to add an Anthropic API key (ANTHROPIC_API_KEY). Everything else on the website still works.';
  }
  if (err instanceof Anthropic.RateLimitError) return 'The helper is very busy right now. Please wait a minute and try again.';
  if (err instanceof Anthropic.APIConnectionError) return 'The helper could not be reached. Please check the internet connection and try again.';
  if (err instanceof Anthropic.APIError) return 'Sorry, the helper ran into a problem. Please try again in a moment.';
  return 'Sorry, something went wrong. Please try again.';
}

// message: what the person typed. context: {page, today, attachments:[{id,name,folder_path}]}
async function chat({ message, context = {} }) {
  const conversation = currentConversation();
  const firstId = Number(get('SELECT COALESCE(MAX(id), 0) AS m FROM chat_messages').m);
  const actions = [];
  const t = S.today();
  const weekday = new Date(`${t}T12:00:00`).toLocaleDateString('en-US', { weekday: 'long' });
  const attached = (context.attachments || []).map((a) => `- "${a.name}" (file id ${a.id}), saved in ${a.folder_path}`).join('\n');
  const contextText = [
    `[Today is ${weekday}, ${t}.${context.page ? ` The person is looking at: ${String(context.page).slice(0, 300)}.` : ''}]`,
    attached ? `[They attached these files just now:\n${attached}]` : '',
  ].filter(Boolean).join('\n');

  const userText = String(message || '').slice(0, 20000);
  const display = userText + (context.attachments?.length ? `\n📎 ${context.attachments.map((a) => a.name).join(', ')}` : '');
  save(conversation, 'user', [{ type: 'text', text: `${contextText}\n\n${userText || '(no message, just the attachment)'}` }], display);

  try {
    const messages = all('SELECT role, content FROM chat_messages WHERE conversation = ? ORDER BY id', conversation)
      .map((m) => ({ role: m.role, content: JSON.parse(m.content) }));
    const replies = [];
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await getClient().beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        output_config: { effort: 'medium' },
        cache_control: { type: 'ephemeral' },
        system: SYSTEM,
        tools: TOOLS,
        messages,
      });
      if (response.stop_reason === 'refusal') {
        const text = 'Sorry, I can\'t help with that request. Is there something else I can do?';
        // Don't keep the declined turn; drop it so the conversation can carry on.
        run('DELETE FROM chat_messages WHERE id > ?', firstId);
        save(conversation, 'user', [{ type: 'text', text: `${contextText}\n\n${userText}` }], display);
        save(conversation, 'assistant', [{ type: 'text', text }], text);
        return { reply: text, actions };
      }
      const text = textOf(response.content);
      save(conversation, 'assistant', response.content, text || null);
      messages.push({ role: 'assistant', content: response.content });
      if (text) replies.push(text);

      const toolUses = response.content.filter((b) => b.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || !toolUses.length) {
        if (response.stop_reason === 'max_tokens') replies.push('(My answer was cut short. Ask me to continue if you need the rest.)');
        return { reply: replies.join('\n\n'), actions };
      }

      const results = [];
      for (const tu of toolUses) {
        try {
          const out = await runTool(tu.name, tu.input, actions);
          results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out ?? { ok: true }) });
          if (!['navigate_to'].includes(tu.name) && /^(create|log|update|move|restore|import|stopwatch|add)/.test(tu.name)) actions.push({ type: 'refresh' });
        } catch (err) {
          if (!(err instanceof S.UserError)) console.error(`Assistant tool ${tu.name} failed:`, err);
          results.push({ type: 'tool_result', tool_use_id: tu.id, is_error: true, content: err instanceof S.UserError ? err.message : 'That did not work because of an unexpected error.' });
        }
      }
      save(conversation, 'user', results);
      messages.push({ role: 'user', content: results });
    }
    const text = 'That took more steps than I expected, so I stopped. Could you tell me a bit more about what you need?';
    save(conversation, 'assistant', [{ type: 'text', text }], text);
    replies.push(text);
    return { reply: replies.join('\n\n'), actions };
  } catch (err) {
    console.error('Assistant error:', err?.message || err);
    // Remove this half-finished turn so the saved conversation stays valid.
    run('DELETE FROM chat_messages WHERE id > ?', firstId);
    return { reply: friendlyError(err), actions, error: true };
  }
}

// Tests swap in a fake client.
const setClient = (c) => { client = c; };

module.exports = { chat, history, newConversation, TOOLS, runTool, SYSTEM, setClient };
