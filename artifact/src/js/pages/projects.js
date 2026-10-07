import {
  api, esc, modal, field, formData, toast, showError, getProjects, niceDate, niceTime, hoursText, money, todayISO,
  fileIcon, fileKindText, when, trashWithUndo, emptyState, clearCaches, confirmBox,
} from '../core.js';
import { page, refresh, go, updateTimerChip } from '../app.js';
import { newProjectDialog, logHoursDialog, entriesHtml, wireEntries, colorPicker } from './hours.js';
import { uploadDialog, newSpreadsheetDialog } from './files.js';
import { eventDialog } from './calendar.js';
import { reportDialog } from './reports.js';

export async function renderList(main) {
  const projects = await getProjects(true);
  const showDone = renderList.showDone ?? false;
  const active = projects.filter((p) => p.status === 'active');
  const done = projects.filter((p) => p.status === 'done');
  const card = (p) => `
    <a class="project-card" href="#/projects/${p.id}" style="--c:${esc(p.color)}">
      <h3>${esc(p.name)} ${p.status === 'done' ? '<span class="done-tag">✓ Finished</span>' : ''}</h3>
      ${p.description ? `<p class="muted">${esc(p.description.slice(0, 120))}${p.description.length > 120 ? '…' : ''}</p>` : ''}
      <div class="amount">${hoursText(p.total_hours)}</div>
      <div class="muted">${p.last_worked ? `Last worked ${niceDate(p.last_worked, { noYear: true })}` : 'No hours yet'}</div>
    </a>`;
  main.innerHTML = `
    <div class="page-head"><div><h1>Projects</h1><p>Click a project to see its hours, spreadsheets, files and calendar.</p></div>
      <button class="btn btn-primary btn-big" id="new-project">➕ New project</button></div>
    ${active.length ? `<div class="project-grid">${active.map(card).join('')}</div>`
      : `<div class="card">${emptyState('📁', 'You have no active projects. Press “New project” to start one.')}</div>`}
    ${done.length ? `<div style="margin-top:1.5rem"><button class="btn btn-light" id="toggle-done" aria-expanded="${showDone}">${showDone ? 'Hide' : 'Show'} finished projects (${done.length})</button></div>
      ${showDone ? `<div class="project-grid" style="margin-top:1rem">${done.map(card).join('')}</div>` : ''}` : ''}`;
  main.querySelector('#new-project').onclick = () => newProjectDialog();
  const t = main.querySelector('#toggle-done');
  if (t) t.onclick = () => { renderList.showDone = !showDone; refresh(); };
}

async function editProjectDialog(p) {
  const r = await modal({
    title: 'Change project details',
    body: `${field({ name: 'name', label: 'Project name', value: p.name, required: true })}
           ${field({ name: 'description', label: 'Description', type: 'textarea', value: p.description })}
           ${field({ name: 'hourly_rate', label: 'Pay per hour', type: 'number', step: '0.01', min: 0, value: p.hourly_rate || '' })}
           ${colorPicker(p.color)}`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save changes', value: 'ok', style: 'primary', submit: true }],
    onSubmit: (form) => api('PUT', `/api/projects/${p.id}`, formData(form)),
  });
  if (r) { clearCaches(); toast('Project updated.'); refresh(); }
}

export async function renderOne(main, id) {
  const p = await api('GET', `/api/projects/${id}`);
  const [entries, files, events, timerRes] = await Promise.all([
    api('GET', `/api/entries?project_id=${id}&limit=40`),
    api('GET', `/api/files?project_id=${id}`),
    api('GET', `/api/events?project_id=${id}&start=${todayISO()}`),
    api('GET', '/api/timer'),
  ]);
  page.context = `the page for project "${p.name}" (project id ${p.id}, folder id ${p.folder_id})`;
  const running = timerRes.timer?.project_id === p.id;
  const sheets = files.filter((f) => f.kind === 'spreadsheet');
  const others = files.filter((f) => f.kind !== 'spreadsheet');
  const fileList = (list) => `<ul class="list">${list.map((f) => `
    <li><span class="icon" aria-hidden="true">${fileIcon(f)}</span><div class="grow"><a class="title" href="#/file/${f.id}">${esc(f.name)}</a>
      <div class="sub">${fileKindText(f)} · in ${esc(f.folder_path)} · ${when(f.updated_at)}</div></div>
      <a class="btn btn-light" href="#/file/${f.id}">Open</a></li>`).join('')}</ul>`;

  main.innerHTML = `
    <div class="crumbs"><a href="#/projects">← All projects</a></div>
    <div class="page-head">
      <div><h1><span class="dot" style="background:${esc(p.color)};width:1.2rem;height:1.2rem"></span> ${esc(p.name)} ${p.status === 'done' ? '<span class="tag">✓ Finished</span>' : ''}</h1>
        ${p.description ? `<p>${esc(p.description)}</p>` : ''}</div>
      <div class="btn-row">
        <button class="btn btn-light" id="edit">✏️ Change details</button>
        <button class="btn btn-light" id="status">${p.status === 'done' ? '🔄 Mark as active again' : '✅ Mark as finished'}</button>
        <button class="btn btn-light" id="delete">🗑️ Delete project</button>
      </div>
    </div>

    <div class="stats">
      <div class="stat"><div class="label">Total hours</div><div class="value">${p.total_hours}</div></div>
      <div class="stat"><div class="label">This month</div><div class="value">${p.month_hours}</div></div>
      ${p.hourly_rate ? `<div class="stat"><div class="label">Earned (at ${money(p.hourly_rate)}/hr)</div><div class="value">${money(p.earned)}</div></div>` : ''}
      <div class="stat"><div class="label">Files</div><div class="value">${files.length}</div></div>
    </div>

    <div class="quick">
      <button class="btn" id="log"><span aria-hidden="true">⏱️</span> Add hours</button>
      <button class="btn" id="sw">${running ? '<span aria-hidden="true">⏹</span> Stop stopwatch' : '<span aria-hidden="true">▶️</span> Start stopwatch'}</button>
      <button class="btn" id="sheet"><span aria-hidden="true">🧮</span> New spreadsheet</button>
      <button class="btn" id="upload"><span aria-hidden="true">📎</span> Add a file</button>
      <button class="btn" id="event"><span aria-hidden="true">📅</span> Add to calendar</button>
      <button class="btn" id="report"><span aria-hidden="true">📊</span> Make a report</button>
      ${p.folder_id ? `<a class="btn" href="#/files/${p.folder_id}"><span aria-hidden="true">📂</span> Open project folder</a>` : ''}
    </div>

    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h2>🧮 Spreadsheets</h2></div>
        <p class="muted">Keep track of expenses, costs, mileage and more.</p>
        ${sheets.length ? fileList(sheets) : emptyState('🧮', 'No spreadsheets yet. Press “New spreadsheet” to make one, or add an Excel file.')}
      </section>
      <section class="card">
        <div class="card-head"><h2>📅 Coming up</h2></div>
        ${events.length ? `<ul class="list">${events.map((e) => `<li><div class="grow"><a class="title" href="#/calendar/${e.date.slice(0, 7)}/${e.date}">${esc(e.title)}</a><div class="sub">${niceDate(e.date, { weekday: true })}${e.time ? ` at ${niceTime(e.time)}` : ''}</div></div></li>`).join('')}</ul>`
          : emptyState('🗓️', 'Nothing on the calendar for this project.')}
      </section>
    </div>

    <section class="card">
      <div class="card-head"><h2>📄 Documents &amp; reports</h2></div>
      ${others.length ? fileList(others) : emptyState('📄', 'No documents yet.')}
    </section>

    <section class="card">
      <div class="card-head"><h2>⏱️ Recent hours</h2><a class="btn btn-light" href="#/hours">All hours</a></div>
      ${entriesHtml(entries, { showProject: false })}
    </section>`;

  wireEntries(main, entries);
  main.querySelector('#edit').onclick = () => editProjectDialog(p);
  main.querySelector('#status').onclick = async () => {
    await api('PUT', `/api/projects/${p.id}`, { status: p.status === 'done' ? 'active' : 'done' });
    clearCaches();
    toast(p.status === 'done' ? 'The project is active again.' : 'Marked as finished. Well done!');
    refresh();
  };
  main.querySelector('#delete').onclick = async () => {
    const yes = await confirmBox(`Delete “${p.name}”?`,
      `This moves the project, its hours, its calendar items and its folder (with ${files.length} file${files.length === 1 ? '' : 's'}) to the <strong>Recycle Bin</strong>.<br><br>You can bring it all back from the Recycle Bin at any time.`,
      'Yes, move to Recycle Bin');
    if (!yes) return;
    try {
      await trashWithUndo(`/api/projects/${p.id}`, p.name);
      updateTimerChip();
      go('#/projects');
    } catch (e) { showError(e); }
  };
  main.querySelector('#log').onclick = () => logHoursDialog({ project_id: p.id });
  main.querySelector('#sw').onclick = async () => {
    try {
      if (running) {
        const r = await api('POST', '/api/timer/stop', {});
        toast(`Saved ${hoursText(r.hours)}.`);
        updateTimerChip(null);
      } else {
        const r = await api('POST', '/api/timer/start', { project_id: p.id });
        toast('The stopwatch has started.');
        updateTimerChip(r.timer);
      }
      refresh();
    } catch (e) { showError(e); }
  };
  const sub = async (name) => (await api('GET', `/api/folders/${p.folder_id}`)).folders.find((f) => f.name === name)?.id || p.folder_id;
  main.querySelector('#sheet').onclick = async () => newSpreadsheetDialog({ folder_id: await sub('Spreadsheets'), project_id: p.id });
  main.querySelector('#upload').onclick = async () => uploadDialog({ folder_id: await sub('Documents') });
  main.querySelector('#event').onclick = () => eventDialog({ project_id: p.id });
  main.querySelector('#report').onclick = async () => reportDialog({ kind: 'project', project_id: p.id, folder_id: await sub('Reports') });
}
