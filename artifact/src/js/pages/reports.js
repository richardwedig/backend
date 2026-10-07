import {
  api, download, esc, modal, field, pickFolder, getFolders, projectOptions, todayISO, addDays, mondayOf, fileIcon, when, emptyState, clearCaches,
} from '../core.js';
import { page, go } from '../app.js';

function presets() {
  const t = todayISO();
  const y = t.slice(0, 4);
  const m = t.slice(0, 7);
  const lastMonthEnd = addDays(`${m}-01`, -1);
  return {
    thisweek: ['This week', mondayOf(t), t],
    lastweek: ['Last week', addDays(mondayOf(t), -7), addDays(mondayOf(t), -1)],
    thismonth: ['This month', `${m}-01`, t],
    lastmonth: ['Last month', `${lastMonthEnd.slice(0, 7)}-01`, lastMonthEnd],
    thisyear: ['This year', `${y}-01-01`, t],
  };
}

async function formHtml(d) {
  const pre = presets();
  return `
    <div class="field"><span style="font-weight:700">What kind of report?</span>
      <div class="chips" role="radiogroup">
        <label class="chip ${d.kind !== 'project' ? 'on' : ''}"><input type="radio" name="kind" value="hours" ${d.kind !== 'project' ? 'checked' : ''} class="sr-only"> ⏱️ Hours worked between two dates</label>
        <label class="chip ${d.kind === 'project' ? 'on' : ''}"><input type="radio" name="kind" value="project" ${d.kind === 'project' ? 'checked' : ''} class="sr-only"> 📁 Everything about one project</label>
      </div></div>
    ${field({ name: 'project_id', label: 'Which project?', type: 'select', options: await projectOptions({ includeNone: true, noneLabel: 'All projects', includeDone: true }), value: d.project_id || '' })}
    <div class="dates">
      <div class="field"><span style="font-weight:700">Which dates?</span><div class="chips">${Object.entries(pre).map(([k, [label]]) => `<button type="button" class="chip" data-preset="${k}">${label}</button>`).join('')}</div></div>
      <div class="form-grid">${field({ name: 'start', label: 'From', type: 'date', value: d.start || pre.thismonth[1] })}${field({ name: 'end', label: 'To', type: 'date', value: d.end || pre.thismonth[2] })}</div>
    </div>
    <div class="field"><span style="font-weight:700">Make it as</span>
      <div class="chips" role="radiogroup">
        <label class="chip on"><input type="radio" name="format" value="docx" checked class="sr-only"> 📝 Word document</label>
        <label class="chip"><input type="radio" name="format" value="xlsx" class="sr-only"> 📗 Excel spreadsheet</label>
      </div></div>
    <p class="big">Save it in: <strong class="target">${d.folder_id ? '' : '<em>no folder chosen yet</em>'}</strong></p>
    <button type="button" class="btn btn-light choose-folder">📁 Choose folder</button>`;
}

function wireForm(form, state) {
  const sync = () => {
    form.querySelectorAll('.chip input[type=radio]').forEach((i) => i.closest('.chip').classList.toggle('on', i.checked));
    const kind = form.querySelector('[name=kind]:checked').value;
    form.querySelector('.dates').hidden = kind === 'project';
    const sel = form.querySelector('[name=project_id]');
    sel.options[0].textContent = kind === 'project' ? '— Choose a project —' : 'All projects';
  };
  form.addEventListener('change', sync);
  sync();
  const pre = presets();
  form.querySelectorAll('[data-preset]').forEach((b) => {
    b.onclick = () => { const [, s, e] = pre[b.dataset.preset]; form.elements.start.value = s; form.elements.end.value = e; };
  });
  const showTarget = async () => {
    if (!state.folder_id) return;
    const { paths } = await getFolders(true);
    form.querySelector('.target').textContent = paths.find((p) => p.id === state.folder_id)?.path || '';
  };
  showTarget();
  form.querySelector('.choose-folder').onclick = async () => {
    const f = await pickFolder({ title: 'Where should the report be saved?', selected: state.folder_id });
    if (f) { state.folder_id = f; showTarget(); }
  };
}

async function submit(form, state) {
  const kind = form.querySelector('[name=kind]:checked').value;
  const body = {
    kind,
    project_id: form.elements.project_id.value || null,
    start: form.elements.start.value,
    end: form.elements.end.value,
    format: form.querySelector('[name=format]:checked').value,
    folder_id: state.folder_id,
  };
  if (kind === 'project' && !body.project_id) throw new Error('Please choose which project the report is about.');
  if (!state.folder_id) throw new Error('Please choose which folder to save the report in.');
  return api('POST', '/api/reports', body);
}

async function done(file) {
  clearCaches();
  const open = await modal({
    title: 'Your report is ready ✓',
    body: `<p class="big">“${esc(file.name)}” was saved in <strong>${esc(file.folder_path)}</strong>.</p>`,
    buttons: [{ label: 'Close', value: null }, { label: '⬇ Download it', value: 'dl' }, { label: 'Open it', value: 'open', style: 'primary' }],
  });
  if (open === 'open') go(`#/file/${file.id}`);
  if (open === 'dl') download(file.id);
}

export async function reportDialog(defaults = {}) {
  const state = { folder_id: defaults.folder_id || null };
  const file = await modal({
    title: 'Make a report',
    wide: true,
    body: await formHtml(defaults),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Make the report', value: 'ok', style: 'primary', submit: true }],
    onOpen: (form) => wireForm(form, state),
    onSubmit: (form) => submit(form, state),
  });
  if (file) done(file);
}

export async function render(main) {
  page.context = 'the Reports page';
  const recent = await api('GET', '/api/files?kind=report');
  const state = { folder_id: null };
  main.innerHTML = `
    <div class="page-head"><div><h1>Reports</h1><p>Make a Word or Excel report of your hours or a project. You can also ask the Helper to write a custom report for you.</p></div></div>
    <form class="card" id="report-form" novalidate>${await formHtml({})}
      <div class="modal-error" role="alert" hidden style="margin:1rem 0 0"></div>
      <div class="btn-row" style="margin-top:1.2rem"><button class="btn btn-primary btn-big" type="submit">📊 Make the report</button></div>
    </form>
    <section class="card"><div class="card-head"><h2>Reports you’ve made</h2></div>
      ${recent.length ? `<ul class="list">${recent.map((f) => `<li><span class="icon" aria-hidden="true">${fileIcon(f)}</span><div class="grow"><a class="title" href="#/file/${f.id}">${esc(f.name)}</a><div class="sub">In ${esc(f.folder_path)} · ${when(f.created_at)}</div></div>
        <button class="btn btn-light" data-download="${f.id}">⬇ Download</button></li>`).join('')}</ul>` : emptyState('📊', 'No reports yet.')}
    </section>`;
  const form = main.querySelector('#report-form');
  wireForm(form, state);
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = form.querySelector('.modal-error');
    err.hidden = true;
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try { done(await submit(form, state)); } catch (ex) { err.textContent = ex.message; err.hidden = false; } finally { btn.disabled = false; }
  };
}
