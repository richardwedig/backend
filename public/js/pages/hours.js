import {
  api, esc, modal, field, formData, toast, showError, getProjects, projectOptions, todayISO, addDays, mondayOf,
  niceDate, hoursText, trashWithUndo, emptyState, clearCaches,
} from '../core.js';
import { page, refresh, go, updateTimerChip } from '../app.js';

const COLORS = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'];
const COLOR_NAMES = ['Blue', 'Orange', 'Teal', 'Gold', 'Pink', 'Green', 'Purple', 'Red'];

export const colorPicker = (selected) => `
  <div class="field"><span style="font-weight:700">Color</span><div class="color-choices" role="radiogroup" aria-label="Project color">
    ${COLORS.map((c, i) => `<label title="${COLOR_NAMES[i]}"><input type="radio" name="color" value="${c}" ${c === selected ? 'checked' : ''} aria-label="${COLOR_NAMES[i]}"><span style="background:${c}"></span></label>`).join('')}
  </div></div>`;

export async function newProjectDialog() {
  const count = (await getProjects()).length;
  const p = await modal({
    title: 'Start a new project',
    body: `${field({ name: 'name', label: 'Project name', required: true, placeholder: 'For example: Smith kitchen remodel' })}
           ${field({ name: 'description', label: 'Short description (optional)', type: 'textarea' })}
           ${field({ name: 'hourly_rate', label: 'Pay per hour (optional)', type: 'number', step: '0.01', min: 0, placeholder: '0.00', hint: 'If you fill this in, reports will show how much your hours are worth.' })}
           ${colorPicker(COLORS[count % COLORS.length])}
           <p class="muted">A folder for this project will be made for you automatically, with Spreadsheets, Documents and Reports folders inside.</p>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Create project', value: 'ok', style: 'primary', submit: true }],
    onSubmit: (form) => api('POST', '/api/projects', formData(form)),
  });
  if (p) {
    clearCaches();
    toast(`Project “${p.name}” was created.`);
    go(`#/projects/${p.id}`);
  }
}

const hourChips = () => `<div class="chips" role="group" aria-label="Quick hour amounts">${[0.25, 0.5, 1, 2, 3, 4, 6, 8].map((h) => `<button type="button" class="chip" data-h="${h}">${h === 0.25 ? '¼' : h === 0.5 ? '½' : h} ${h <= 1 ? 'hour' : 'hours'}</button>`).join('')}</div>`;
const wireChips = (form) => form.querySelectorAll('[data-h]').forEach((b) => {
  b.onclick = () => { form.elements.hours.value = b.dataset.h; form.querySelectorAll('[data-h]').forEach((x) => x.classList.toggle('on', x === b)); };
});

export async function logHoursDialog({ project_id, date } = {}) {
  const opts = await projectOptions();
  if (!opts.length) {
    const yes = await modal({ title: 'First, make a project', body: '<p class="big">Hours are recorded against a project. You don’t have any projects yet. Would you like to make one now?</p>', buttons: [{ label: 'Not now', value: null }, { label: 'Make a project', value: true, style: 'primary' }] });
    if (yes) newProjectDialog();
    return;
  }
  const e = await modal({
    title: 'Add hours I worked',
    body: `${field({ name: 'project_id', label: 'Which project?', type: 'select', options: opts, value: project_id })}
           ${field({ name: 'date', label: 'Which day?', type: 'date', value: date || todayISO(), required: true })}
           ${field({ name: 'hours', label: 'How many hours?', type: 'number', step: '0.25', min: 0, placeholder: 'e.g. 2.5', hint: 'Tip: 1.5 means an hour and a half. Or tap a button:' })}
           ${hourChips()}
           <div style="height:.8rem"></div>
           ${field({ name: 'note', label: 'What did you do? (optional)', type: 'textarea' })}`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save hours', value: 'ok', style: 'primary', submit: true }],
    onOpen: wireChips,
    onSubmit: (form) => api('POST', '/api/entries', formData(form)),
  });
  if (e) { toast(`Saved ${hoursText(e.hours)} for ${niceDate(e.date, { noYear: true })}.`); refresh(); }
}

export async function editEntryDialog(entry) {
  const opts = await projectOptions({ includeDone: true });
  const r = await modal({
    title: 'Change these hours',
    body: `${field({ name: 'project_id', label: 'Project', type: 'select', options: opts, value: entry.project_id })}
           ${field({ name: 'date', label: 'Day', type: 'date', value: entry.date, required: true })}
           ${field({ name: 'hours', label: 'Hours', type: 'number', step: '0.25', min: 0, value: entry.hours })}
           ${hourChips()}<div style="height:.8rem"></div>
           ${field({ name: 'note', label: 'Note', type: 'textarea', value: entry.note })}`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Save changes', value: 'ok', style: 'primary', submit: true }],
    onOpen: wireChips,
    onSubmit: (form) => api('PUT', `/api/entries/${entry.id}`, formData(form)),
  });
  if (r) { toast('Changes saved.'); refresh(); }
}

// A list of entries grouped by day, with Change / Delete buttons.
export function entriesHtml(entries, { showProject = true } = {}) {
  if (!entries.length) return emptyState('⏱️', 'No hours recorded for this time.');
  const byDate = new Map();
  for (const e of entries) { if (!byDate.has(e.date)) byDate.set(e.date, []); byDate.get(e.date).push(e); }
  return [...byDate].map(([date, list]) => `
    <div class="date-head"><span>${niceDate(date, { weekday: true })}</span><strong>${hoursText(list.reduce((s, e) => s + e.hours, 0))}</strong></div>
    <ul class="list">${list.map((e) => `
      <li>
        ${showProject ? `<span class="dot" style="background:${esc(e.project_color)}"></span>` : ''}
        <div class="grow">${showProject ? `<a class="title" href="#/projects/${e.project_id}">${esc(e.project_name)}</a>` : ''}<div class="sub">${e.note ? esc(e.note) : '<span class="muted">No note</span>'}</div></div>
        <span class="amount">${hoursText(e.hours)}</span>
        <button class="btn btn-light" data-edit="${e.id}">✏️ Change</button>
        <button class="btn btn-light" data-del="${e.id}">🗑️ Delete</button>
      </li>`).join('')}</ul>`).join('');
}

export function wireEntries(root, entries) {
  root.querySelectorAll('[data-edit]').forEach((b) => { b.onclick = () => editEntryDialog(entries.find((e) => e.id === Number(b.dataset.edit))); });
  root.querySelectorAll('[data-del]').forEach((b) => {
    b.onclick = () => {
      const e = entries.find((x) => x.id === Number(b.dataset.del));
      trashWithUndo(`/api/entries/${e.id}`, `${hoursText(e.hours)} on ${niceDate(e.date, { noYear: true })}`, refresh).catch(showError);
    };
  });
}

let tick = null;
function stopwatchHtml(timer, opts) {
  if (timer) {
    return `<section class="card stopwatch running" aria-label="Stopwatch">
      <div><div class="big"><span class="pulse" style="display:inline-block"></span> Working on <strong>${esc(timer.project_name)}</strong></div>
      <div class="clock" id="clock" aria-live="off">0:00:00</div><div class="muted">Started at ${new Date(timer.started_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</div></div>
      <div class="btn-row"><button class="btn btn-danger btn-big" id="sw-stop">⏹ Stop and save</button><button class="btn btn-light" id="sw-discard">Cancel without saving</button></div>
    </section>`;
  }
  return `<section class="card stopwatch" aria-label="Stopwatch">
    <div style="flex:1;min-width:240px"><h2>▶️ Stopwatch</h2><p class="muted">Press Start when you begin working and Stop when you finish. Your hours are saved for you.</p>
      ${opts.length ? `<div class="form-grid">${field({ name: 'sw-project', label: 'Project', type: 'select', options: opts })}${field({ name: 'sw-note', label: 'Note (optional)' })}</div>` : '<p>You need a project first.</p>'}
    </div>
    ${opts.length ? '<button class="btn btn-good btn-big" id="sw-start">▶ Start</button>' : '<button class="btn btn-primary btn-big" id="sw-newproj">📁 Make a project</button>'}
  </section>`;
}

export async function render(main) {
  const [timerRes, opts] = await Promise.all([api('GET', '/api/timer'), projectOptions()]);
  const timer = timerRes.timer;
  const ranges = {
    week: ['This week', mondayOf(todayISO()), todayISO()],
    lastweek: ['Last week', addDays(mondayOf(todayISO()), -7), addDays(mondayOf(todayISO()), -1)],
    month: ['This month', `${todayISO().slice(0, 8)}01`, todayISO()],
    last30: ['Last 30 days', addDays(todayISO(), -29), todayISO()],
    all: ['Everything', '', ''],
  };
  const state = render.state || (render.state = { range: 'week', project: '' });
  const [, start, end] = ranges[state.range];
  const qs = new URLSearchParams({ ...(start && { start }), ...(end && { end }), ...(state.project && { project_id: state.project }) });
  const entries = await api('GET', `/api/entries?${qs}`);
  const total = entries.reduce((s, e) => s + e.hours, 0);
  page.context = `the My Hours page, showing ${ranges[state.range][0].toLowerCase()}`;

  main.innerHTML = `
    <div class="page-head"><div><h1>My Hours</h1><p>Use the stopwatch, or type in hours you already worked.</p></div>
      <button class="btn btn-primary btn-big" id="add-hours">➕ Add hours by hand</button></div>
    ${stopwatchHtml(timer, opts)}
    <section class="card">
      <div class="card-head"><h2>Hours I’ve recorded</h2><div class="amount">Total: ${hoursText(total)}</div></div>
      <div class="chips" role="group" aria-label="Which dates to show">${Object.entries(ranges).map(([k, [label]]) => `<button class="chip ${k === state.range ? 'on' : ''}" data-range="${k}" aria-pressed="${k === state.range}">${label}</button>`).join('')}</div>
      <div class="field" style="max-width:420px;margin-top:.8rem">${field({ name: 'filter-project', label: 'Show project', type: 'select', options: await projectOptions({ includeNone: true, noneLabel: 'All projects', includeDone: true }), value: state.project })}</div>
      ${entriesHtml(entries)}
    </section>`;

  main.querySelector('#add-hours').onclick = () => logHoursDialog();
  main.querySelectorAll('[data-range]').forEach((b) => { b.onclick = () => { state.range = b.dataset.range; refresh(); }; });
  main.querySelector('[name=filter-project]').onchange = (e) => { state.project = e.target.value; refresh(); };
  wireEntries(main, entries);

  clearInterval(tick);
  if (timer) {
    const clock = main.querySelector('#clock');
    const draw = () => {
      if (!document.body.contains(clock)) return clearInterval(tick);
      const s = Math.floor((Date.now() - new Date(timer.started_at).getTime()) / 1000);
      clock.textContent = `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
    };
    draw();
    tick = setInterval(draw, 1000);
    main.querySelector('#sw-stop').onclick = async () => {
      try {
        const r = await api('POST', '/api/timer/stop', {});
        toast(`Saved ${hoursText(r.hours)} for ${timer.project_name}.`);
        updateTimerChip(null);
        refresh();
      } catch (e) { showError(e); }
    };
    main.querySelector('#sw-discard').onclick = async () => {
      const yes = await modal({ title: 'Cancel the stopwatch?', body: '<p class="big">The time on the stopwatch will <strong>not</strong> be saved.</p>', buttons: [{ label: 'No, keep it running', value: null }, { label: 'Yes, cancel it', value: true, style: 'danger' }] });
      if (!yes) return;
      await api('POST', '/api/timer/stop', { discard: true });
      updateTimerChip(null);
      refresh();
    };
  } else if (opts.length) {
    main.querySelector('#sw-start').onclick = async () => {
      try {
        const r = await api('POST', '/api/timer/start', { project_id: main.querySelector('[name=sw-project]').value, note: main.querySelector('[name=sw-note]').value });
        toast('The stopwatch has started. You can leave this page; it keeps running.');
        updateTimerChip(r.timer);
        refresh();
      } catch (e) { showError(e); }
    };
  } else {
    main.querySelector('#sw-newproj').onclick = () => newProjectDialog();
  }
}
