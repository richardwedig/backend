import {
  api, esc, modal, field, formData, toast, showError, pickFolder, getFolders, uploadFiles, fileIcon, fileKindText,
  fileSize, when, trashWithUndo, emptyState, clearCaches, confirmBox,
} from '../core.js';
import { page, refresh, go, setLeaveGuard } from '../app.js';

// ---------- dialogs used from several pages

async function folderPath(id) {
  const { paths } = await getFolders(true);
  return paths.find((p) => p.id === Number(id))?.path || '';
}

export async function uploadDialog({ folder_id } = {}) {
  const { special } = await getFolders(true);
  let target = folder_id || special.inbox;
  let chosen = [];
  const r = await modal({
    title: 'Add files',
    wide: true,
    body: `
      <div class="dropzone" id="dz"><p class="big">Drag files here from your computer</p><p>or</p>
        <button type="button" class="btn btn-primary btn-big" id="choose">📎 Choose files…</button></div>
      <ul class="list" id="chosen"></ul>
      <p class="big" style="margin-top:1rem">They will go in: <strong id="target"></strong></p>
      <button type="button" class="btn btn-light" id="change">📁 Choose a different folder</button>
      <label class="big" style="display:flex;gap:.6rem;align-items:center;margin-top:1rem"><input type="checkbox" name="editable" checked style="width:1.6rem;height:1.6rem;min-height:0">
        Also make Excel / CSV files editable here as spreadsheets</label>
      <p class="muted">Word documents, Excel spreadsheets, PDFs, pictures and other files are all fine (up to 50 MB each).</p>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Upload', value: 'ok', style: 'primary', submit: true }],
    onOpen: async (form) => {
      const show = () => {
        form.querySelector('#chosen').innerHTML = chosen.map((f) => `<li><span class="icon">${fileIcon({ name: f.name })}</span><span class="grow title">${esc(f.name)}</span><span class="muted">${fileSize(f.size)}</span></li>`).join('');
      };
      form.querySelector('#target').textContent = await folderPath(target);
      const input = document.createElement('input');
      input.type = 'file'; input.multiple = true; input.hidden = true;
      form.appendChild(input);
      input.onchange = () => { chosen = [...chosen, ...input.files]; show(); };
      form.querySelector('#choose').onclick = () => input.click();
      const dz = form.querySelector('#dz');
      dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('over'); });
      dz.addEventListener('dragleave', () => dz.classList.remove('over'));
      dz.addEventListener('drop', (e) => { e.preventDefault(); dz.classList.remove('over'); chosen = [...chosen, ...e.dataTransfer.files]; show(); });
      form.querySelector('#change').onclick = async () => {
        const f = await pickFolder({ title: 'Where should the files go?', selected: target });
        if (f) { target = f; form.querySelector('#target').textContent = await folderPath(f); }
      };
    },
    onSubmit: async (form) => {
      if (!chosen.length) throw new Error('Please choose at least one file first.');
      return uploadFiles(chosen, target, { editable: form.elements.editable.checked });
    },
  });
  if (r) {
    clearCaches();
    const n = r.files.filter((f) => f.kind === 'upload').length;
    toast(`${n} file${n === 1 ? '' : 's'} added to “${await folderPath(target)}”.`);
    go(`#/files/${target}`);
  }
}

export async function newSpreadsheetDialog({ folder_id, project_id } = {}) {
  let target = folder_id || null;
  const r = await modal({
    title: 'Make a new spreadsheet',
    body: `${field({ name: 'name', label: 'Name', required: true, placeholder: 'For example: Materials and expenses' })}
      ${field({ name: 'template', label: 'Start with', type: 'select', options: [
        { value: 'expenses', label: 'Expenses (Date, Description, Category, Amount)' },
        { value: 'budget', label: 'Budget / costs (Item, Budgeted, Actual, Notes)' },
        { value: 'mileage', label: 'Mileage log (Date, From, To, Miles, Purpose)' },
        { value: 'blank', label: 'A blank spreadsheet' },
      ] })}
      <p class="big">It will go in: <strong id="target">${target ? '' : '<em>no folder chosen yet</em>'}</strong></p>
      <button type="button" class="btn btn-light" id="change">📁 Choose folder</button>`,
    buttons: [{ label: 'Cancel', value: null }, { label: 'Make spreadsheet', value: 'ok', style: 'primary', submit: true }],
    onOpen: async (form) => {
      if (target) form.querySelector('#target').textContent = await folderPath(target);
      form.querySelector('#change').onclick = async () => {
        const f = await pickFolder({ title: 'Where should the spreadsheet go?', selected: target });
        if (f) { target = f; form.querySelector('#target').textContent = await folderPath(f); }
      };
    },
    onSubmit: async (form) => {
      if (!target) throw new Error('Please choose which folder to put it in.');
      return api('POST', '/api/spreadsheets', { ...formData(form), folder_id: target, project_id });
    },
  });
  if (r) { clearCaches(); toast(`Spreadsheet “${r.name}” was made.`); go(`#/file/${r.id}`); }
}

async function renameDialog(kind, item) {
  const r = await modal({
    title: `Rename ${kind}`,
    body: field({ name: 'name', label: 'New name', value: item.name, required: true }),
    buttons: [{ label: 'Cancel', value: null }, { label: 'Rename', value: 'ok', style: 'primary', submit: true }],
    onSubmit: (form) => api('PUT', `/api/${kind === 'folder' ? 'folders' : 'files'}/${item.id}`, formData(form)),
  });
  if (r) { clearCaches(); toast('Renamed.'); refresh(); }
}

async function moveFile(f) {
  const target = await pickFolder({ title: `Move “${f.name}”`, intro: 'Click the folder you want to move it to.', selected: f.folder_id, okLabel: 'Move it here' });
  if (!target) return;
  try {
    const r = await api('PUT', `/api/files/${f.id}`, { folder_id: target });
    toast(`Moved to “${r.folder_path}”.`);
    refresh();
  } catch (e) { showError(e); }
}

// ---------- a folder

export async function renderFolder(main, id) {
  if (!id) {
    // Top level: show the main folders.
    const tree = (await getFolders(true)).tree;
    page.context = 'the Files & Folders page (top level)';
    main.innerHTML = `
      <div class="page-head"><div><h1>Files &amp; Folders</h1><p>Click a folder to open it.</p></div>
        <div class="btn-row"><button class="btn btn-primary btn-big" id="upload">📎 Add files</button></div></div>
      <div class="folder-grid">${tree.map((f) => `
        <a class="folder-tile" href="#/files/${f.id}"><span class="ico" aria-hidden="true">${f.system === 'inbox' ? '📥' : f.system === 'reports' ? '📊' : f.system === 'projects' ? '🗂️' : '📁'}</span>
          <span>${esc(f.name)}<small>${f.children.length} folder${f.children.length === 1 ? '' : 's'}, ${f.file_count} file${f.file_count === 1 ? '' : 's'}</small></span></a>`).join('')}</div>
      <div class="card"><p class="big">💡 <strong>Tip:</strong> Every project has its own folder inside <strong>Projects</strong>. New uploads go to <strong>Inbox</strong> unless you choose a folder. Deleted things go to the <a href="#/trash">Recycle Bin</a>, where you can bring them back.</p></div>`;
    main.querySelector('#upload').onclick = () => uploadDialog();
    return;
  }

  const f = await api('GET', `/api/folders/${id}`);
  page.context = `the folder "${f.breadcrumbs.map((c) => c.name).join(' / ')}" (folder id ${f.id})`;
  main.innerHTML = `
    <nav class="crumbs" aria-label="You are here"><a href="#/files">🗂️ All folders</a>${f.breadcrumbs.map((c, i) => ` <span aria-hidden="true">›</span> ${i === f.breadcrumbs.length - 1 ? `<strong>${esc(c.name)}</strong>` : `<a href="#/files/${c.id}">${esc(c.name)}</a>`}`).join('')}</nav>
    <div class="page-head"><div><h1>📂 ${esc(f.name)}</h1>${f.project_id ? `<p><a href="#/projects/${f.project_id}">Go to this project’s page</a></p>` : ''}</div>
      <div class="btn-row">
        <button class="btn btn-primary" id="upload">📎 Add files</button>
        <button class="btn btn-light" id="sheet">🧮 New spreadsheet</button>
        <button class="btn btn-light" id="newfolder">➕ New folder</button>
      </div></div>

    ${f.folders.length ? `<div class="folder-grid">${f.folders.map((s) => `<a class="folder-tile" href="#/files/${s.id}"><span class="ico" aria-hidden="true">📁</span><span>${esc(s.name)}<small>${s.file_count} file${s.file_count === 1 ? '' : 's'}</small></span></a>`).join('')}</div>` : ''}

    <section class="card">
      ${f.files.length ? `<ul class="list">${f.files.map((x) => `
        <li><span class="icon" aria-hidden="true">${fileIcon(x)}</span>
          <div class="grow"><a class="title" href="#/file/${x.id}">${esc(x.name)}</a><div class="sub">${fileKindText(x)}${x.size ? ` · ${fileSize(x.size)}` : ''} · ${when(x.updated_at)}</div></div>
          <div class="btn-row">
            <a class="btn btn-light" href="#/file/${x.id}">Open</a>
            <button class="btn btn-light" data-download="${x.id}">⬇ Download</button>
            <button class="btn btn-light" data-move="${x.id}">📦 Move</button>
            <button class="btn btn-light" data-rename="${x.id}">✏️ Rename</button>
            <button class="btn btn-light" data-del="${x.id}">🗑️ Delete</button>
          </div></li>`).join('')}</ul>`
        : emptyState('📭', f.folders.length ? 'No files directly in this folder.' : 'This folder is empty.', '<div class="dropzone" id="dz" style="margin-top:1rem">You can drag files from your computer and drop them here.</div>')}
    </section>

    ${f.system ? '' : `<div class="btn-row"><button class="btn btn-light" id="rename-folder">✏️ Rename this folder</button>
      <button class="btn btn-light" id="move-folder">📦 Move this folder</button>
      <button class="btn btn-light" id="delete-folder">🗑️ Delete this folder</button></div>`}`;

  const byId = (fid) => f.files.find((x) => x.id === Number(fid));
  main.querySelector('#upload').onclick = () => uploadDialog({ folder_id: f.id });
  main.querySelector('#sheet').onclick = () => newSpreadsheetDialog({ folder_id: f.id, project_id: f.project_id });
  main.querySelector('#newfolder').onclick = async () => {
    const r = await modal({
      title: `New folder inside “${f.name}”`,
      body: field({ name: 'name', label: 'Folder name', required: true }),
      buttons: [{ label: 'Cancel', value: null }, { label: 'Make folder', value: 'ok', style: 'primary', submit: true }],
      onSubmit: (form) => api('POST', '/api/folders', { name: formData(form).name, parent_id: f.id }),
    });
    if (r) { clearCaches(); toast(`Folder “${r.name}” was made.`); refresh(); }
  };
  main.querySelectorAll('[data-move]').forEach((b) => { b.onclick = () => moveFile(byId(b.dataset.move)); });
  main.querySelectorAll('[data-rename]').forEach((b) => { b.onclick = () => renameDialog('file', byId(b.dataset.rename)); });
  main.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => { const x = byId(b.dataset.del); trashWithUndo(`/api/files/${x.id}`, x.name, refresh).catch(showError); }; });

  // Drag-and-drop anywhere on the page puts files in this folder.
  main.ondragover = (e) => { e.preventDefault(); main.querySelector('#dz')?.classList.add('over'); };
  main.ondrop = async (e) => {
    e.preventDefault();
    if (!e.dataTransfer.files.length) return;
    try {
      await uploadFiles([...e.dataTransfer.files], f.id);
      toast(`${e.dataTransfer.files.length} file(s) added to “${f.name}”.`);
      refresh();
    } catch (err) { showError(err); }
  };

  if (!f.system) {
    main.querySelector('#rename-folder').onclick = () => renameDialog('folder', f);
    main.querySelector('#move-folder').onclick = async () => {
      const target = await pickFolder({ title: `Move the “${f.name}” folder`, intro: 'Click the folder it should go inside.', selected: f.parent_id, okLabel: 'Move it here' });
      if (!target) return;
      try { await api('PUT', `/api/folders/${f.id}`, { parent_id: target }); clearCaches(); toast('Folder moved.'); refresh(); } catch (e) { showError(e); }
    };
    main.querySelector('#delete-folder').onclick = async () => {
      const yes = await confirmBox(`Delete the “${f.name}” folder?`, 'The folder and everything inside it will go to the <strong>Recycle Bin</strong>. You can bring it back from there at any time.', 'Yes, move to Recycle Bin');
      if (!yes) return;
      try {
        await trashWithUndo(`/api/folders/${f.id}`, f.name);
        go(f.parent_id ? `#/files/${f.parent_id}` : '#/files');
      } catch (e) { showError(e); }
    };
  }
}

// ---------- a single file

export async function renderFile(main, id) {
  const p = await api('GET', `/api/files/${id}/preview`);
  page.context = `the file "${p.name}" (file id ${p.id}) in folder "${p.folder_path}"`;
  const head = `
    <nav class="crumbs" aria-label="You are here"><a href="#/files/${p.folder_id}">← Back to ${esc(p.folder_path)}</a></nav>
    <div class="page-head"><div><h1>${fileIcon(p)} ${esc(p.name)}</h1><p>${fileKindText(p)}${p.size ? ` · ${fileSize(p.size)}` : ''} · in ${esc(p.folder_path)}</p></div>
      <div class="btn-row">
        <button class="btn btn-primary" data-download="${p.id}">⬇ Download${p.kind === 'spreadsheet' ? ' as Excel' : ''}</button>
        ${p.type === 'sheets' ? '<button class="btn btn-light" id="import">🧮 Make it editable here</button>' : ''}
        <button class="btn btn-light" id="move">📦 Move</button>
        <button class="btn btn-light" id="rename">✏️ Rename</button>
        <button class="btn btn-light" id="delete">🗑️ Delete</button>
      </div></div>`;

  let body;
  if (p.type === 'spreadsheet') body = '<div id="sheet-editor"></div>';
  else if (p.type === 'html') body = `<div class="preview">${sanitize(p.html) || '<p class="muted">This document looks empty.</p>'}</div>`;
  else if (p.type === 'sheets') body = p.sheets.map((s) => `<h2>${esc(s.name)}</h2><div class="preview"><table class="data-table"><thead><tr>${s.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${s.rows.slice(0, 1000).map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`).join('');
  else if (p.type === 'image') body = `<div class="preview"><img src="${esc(p.src)}" alt="${esc(p.name)}"></div>`;
  else if (p.type === 'pdf') body = `<div class="preview"><object data="${esc(p.src)}" type="application/pdf" style="width:100%;height:70vh"><p class="big">This PDF can’t be shown here. Use the Download button above to open it.</p></object></div>`;
  else if (p.type === 'text') body = `<div class="preview"><pre style="white-space:pre-wrap">${esc(p.text)}</pre></div>`;
  else body = '<div class="card"><p class="big">This kind of file can’t be shown here, but you can download it with the button above.</p></div>';
  main.innerHTML = head + body;

  const info = { id: p.id, name: p.name, folder_id: p.folder_id };
  main.querySelector('#move').onclick = () => moveFile(info);
  main.querySelector('#rename').onclick = () => renameDialog('file', info);
  main.querySelector('#delete').onclick = async () => {
    try { await trashWithUndo(`/api/files/${p.id}`, p.name); go(`#/files/${p.folder_id}`); } catch (e) { showError(e); }
  };
  const imp = main.querySelector('#import');
  if (imp) {
    imp.onclick = async () => {
      try {
        const r = await api('POST', `/api/files/${p.id}/import`, {});
        toast('An editable copy was made in the same folder. The original file is kept too.');
        go(`#/file/${r.files[0].id}`);
      } catch (e) { showError(e); }
    };
  }
  if (p.type === 'spreadsheet') await sheetEditor(main.querySelector('#sheet-editor'), p.id);
}

// Word documents become HTML; keep only harmless tags.
function sanitize(html) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  tpl.content.querySelectorAll('script, style, iframe, object, embed, link, meta').forEach((n) => n.remove());
  tpl.content.querySelectorAll('*').forEach((n) => {
    for (const a of [...n.attributes]) {
      const v = a.value.trim().toLowerCase();
      if (a.name.startsWith('on') || ((a.name === 'href' || a.name === 'src') && !(v.startsWith('data:image/') || v.startsWith('http') || v.startsWith('#')))) n.removeAttribute(a.name);
    }
  });
  const div = document.createElement('div');
  div.appendChild(tpl.content);
  return div.innerHTML;
}

// ---------- spreadsheet editor

const toNum = (v) => {
  const s = String(v ?? '').trim().replace(/[$,€£\s]/g, '');
  return s && /^-?\d*\.?\d+$/.test(s) ? Number(s) : null;
};

async function sheetEditor(root, id) {
  const data = await api('GET', `/api/spreadsheets/${id}`);
  let sheet = data.sheet;
  const history = [];
  let saveTimer = null;
  let saving = Promise.resolve();
  let dirty = false;

  const totals = () => sheet.columns.map((_, ci) => {
    let sum = 0, nums = 0, filled = 0;
    for (const r of sheet.rows) { if (r[ci] === '' || r[ci] == null) continue; filled++; const n = toNum(r[ci]); if (n !== null) { sum += n; nums++; } }
    return nums && nums >= filled * 0.6 ? Math.round(sum * 100) / 100 : null;
  });

  const setState = (text, ok) => { const s = root.querySelector('.save-state'); if (s) { s.textContent = text; s.classList.toggle('ok', ok); } };
  const save = () => {
    clearTimeout(saveTimer);
    if (!dirty) return saving;
    dirty = false;
    setState('Saving…', false);
    saving = api('PUT', `/api/spreadsheets/${id}`, { sheet })
      .then(() => setState('✓ All changes saved', true))
      .catch((e) => { dirty = true; setState('⚠ Not saved yet', false); showError(e); });
    return saving;
  };
  const changed = () => { dirty = true; setState('Saving soon…', false); clearTimeout(saveTimer); saveTimer = setTimeout(save, 700); };
  const snapshot = () => { history.push(JSON.stringify(sheet)); if (history.length > 50) history.shift(); };
  setLeaveGuard(() => save());

  const updateTotals = () => {
    const t = totals();
    root.querySelectorAll('tfoot td[data-c]').forEach((td) => { const v = t[Number(td.dataset.c)]; td.textContent = v === null ? '' : v.toLocaleString('en-US', { maximumFractionDigits: 2 }); });
  };

  const draw = (focus) => {
    root.innerHTML = `
      <div class="card-head"><div class="btn-row">
        <button class="btn btn-light" data-act="addrow">➕ Add a row</button>
        <button class="btn btn-light" data-act="addcol">➕ Add a column</button>
        <button class="btn btn-light" data-act="undo" ${history.length ? '' : 'disabled'}>↩ Undo</button>
      </div><span class="save-state ok" role="status">✓ All changes saved</span></div>
      <p class="muted">Click any box to type in it. Changes save by themselves. Number columns are added up at the bottom.</p>
      <div class="sheet-wrap"><table class="sheet">
        <thead><tr><th class="rownum">#</th>${sheet.columns.map((c, ci) => `<th><div style="display:flex"><input aria-label="Column ${ci + 1} name" data-h="${ci}" value="${esc(c)}"><button class="coldel" data-delcol="${ci}" title="Delete this column" aria-label="Delete column ${esc(c)}">✕</button></div></th>`).join('')}<th></th></tr></thead>
        <tbody>${sheet.rows.map((r, ri) => `<tr><td class="rownum">${ri + 1}</td>${r.map((v, ci) => `<td><input aria-label="${esc(sheet.columns[ci])}, row ${ri + 1}" data-r="${ri}" data-c="${ci}" value="${esc(v)}"></td>`).join('')}<td><button class="rowdel" data-delrow="${ri}" title="Delete this row" aria-label="Delete row ${ri + 1}">🗑️</button></td></tr>`).join('')}</tbody>
        <tfoot><tr><td class="rownum">Total</td>${sheet.columns.map((_, ci) => `<td data-c="${ci}"></td>`).join('')}<td></td></tr></tfoot>
      </table></div>
      <div class="btn-row" style="margin-top:.8rem"><button class="btn btn-light" data-act="addrow">➕ Add a row</button></div>`;
    updateTotals();
    if (focus) root.querySelector(focus)?.focus();
  };

  root.addEventListener('focusin', (e) => { if (e.target.matches('input')) e.target.dataset.before = e.target.value; });
  root.addEventListener('input', (e) => {
    const t = e.target;
    if (t.dataset.h !== undefined) sheet.columns[Number(t.dataset.h)] = t.value;
    else if (t.dataset.r !== undefined) sheet.rows[Number(t.dataset.r)][Number(t.dataset.c)] = t.value;
    else return;
    updateTotals();
    changed();
  });
  root.addEventListener('change', (e) => {
    // One undo step per edited box.
    const t = e.target;
    if (t.dataset.before !== undefined && t.dataset.before !== t.value) {
      const prev = JSON.parse(JSON.stringify(sheet));
      if (t.dataset.h !== undefined) prev.columns[Number(t.dataset.h)] = t.dataset.before;
      else prev.rows[Number(t.dataset.r)][Number(t.dataset.c)] = t.dataset.before;
      history.push(JSON.stringify(prev));
      root.querySelector('[data-act=undo]').disabled = false;
      t.dataset.before = t.value;
    }
  });
  root.addEventListener('keydown', (e) => {
    // Enter moves down a row (adding one at the bottom), like a spreadsheet.
    const t = e.target;
    if (e.key !== 'Enter' || t.dataset.r === undefined) return;
    e.preventDefault();
    const r = Number(t.dataset.r), c = Number(t.dataset.c);
    if (r === sheet.rows.length - 1) { snapshot(); sheet.rows.push(sheet.columns.map(() => '')); changed(); }
    draw(`[data-r="${r + 1}"][data-c="${c}"]`);
  });
  root.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.act === 'addrow') { snapshot(); sheet.rows.push(sheet.columns.map(() => '')); changed(); draw(`[data-r="${sheet.rows.length - 1}"][data-c="0"]`); }
    else if (b.dataset.act === 'addcol') { snapshot(); sheet.columns.push(`Column ${sheet.columns.length + 1}`); sheet.rows.forEach((r) => r.push('')); changed(); draw(`[data-h="${sheet.columns.length - 1}"]`); }
    else if (b.dataset.act === 'undo') { if (history.length) { sheet = JSON.parse(history.pop()); changed(); draw(); } }
    else if (b.dataset.delrow !== undefined) {
      snapshot();
      const before = history[history.length - 1];
      sheet.rows.splice(Number(b.dataset.delrow), 1);
      if (!sheet.rows.length) sheet.rows.push(sheet.columns.map(() => ''));
      changed(); draw();
      toast('Row deleted.', { undo: async () => { snapshot(); sheet = JSON.parse(before); changed(); draw(); } });
    } else if (b.dataset.delcol !== undefined) {
      if (sheet.columns.length === 1) return toast('A spreadsheet needs at least one column.', { kind: 'error' });
      snapshot();
      const before = history[history.length - 1];
      const ci = Number(b.dataset.delcol);
      const name = sheet.columns[ci];
      sheet.columns.splice(ci, 1);
      sheet.rows.forEach((r) => r.splice(ci, 1));
      changed(); draw();
      toast(`Column “${name}” deleted.`, { undo: async () => { snapshot(); sheet = JSON.parse(before); changed(); draw(); } });
    }
  });
  window.addEventListener('beforeunload', (e) => { if (dirty && document.body.contains(root)) { save(); e.preventDefault(); } });
  draw();
}
