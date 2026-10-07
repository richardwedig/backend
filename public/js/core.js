// Shared helpers: talking to the server, building HTML safely, pop-up boxes,
// messages at the bottom of the screen, and the folder chooser.

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body !== undefined) { opts.body = JSON.stringify(body); opts.headers['Content-Type'] = 'application/json'; }
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch { /* no body */ }
  if (res.status === 401 && url !== '/api/login') { window.dispatchEvent(new Event('needs-login')); }
  if (!res.ok) throw new Error(data?.error || 'Something went wrong. Please try again.');
  return data;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- dates & numbers

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const toISO = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const parseISO = (s) => new Date(`${s}T12:00:00`);
export const addDays = (iso, n) => { const d = parseISO(iso); d.setDate(d.getDate() + n); return toISO(d); };
export const mondayOf = (iso) => addDays(iso, -((parseISO(iso).getDay() + 6) % 7));
export const niceDate = (iso, opts = {}) => (iso ? parseISO(iso).toLocaleDateString('en-US', { weekday: opts.weekday ? 'long' : undefined, month: 'long', day: 'numeric', year: opts.noYear ? undefined : 'numeric' }) : '');
export const shortDate = (iso) => (iso ? parseISO(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
export const niceTime = (t) => {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
export const hoursText = (h) => {
  const n = Math.round((Number(h) || 0) * 100) / 100;
  return `${n} ${n === 1 ? 'hour' : 'hours'}`;
};
export const money = (n) => `$${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
export const when = (sqlTime) => {
  const d = new Date(`${String(sqlTime).replace(' ', 'T')}Z`);
  if (Number.isNaN(d.getTime())) return '';
  const days = Math.floor((Date.now() - d.getTime()) / 86400000);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  if (toISO(d) === todayISO()) return `Today at ${time}`;
  if (days < 2 && toISO(d) === addDays(todayISO(), -1)) return `Yesterday at ${time}`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
};
export const fileSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b > 1024 ? `${Math.round(b / 1024)} KB` : b ? `${b} bytes` : '');

export function fileIcon(f) {
  if (f.kind === 'spreadsheet') return '🧮';
  const n = (f.name || '').toLowerCase();
  if (n.endsWith('.docx') || n.endsWith('.doc')) return '📝';
  if (n.endsWith('.xlsx') || n.endsWith('.xls') || n.endsWith('.csv')) return '📗';
  if (n.endsWith('.pdf')) return '📕';
  if (/\.(png|jpe?g|gif|webp|heic)$/.test(n)) return '🖼️';
  return '📄';
}
export function fileKindText(f) {
  if (f.kind === 'spreadsheet') return 'Spreadsheet (editable here)';
  if (f.kind === 'report') return 'Report';
  const n = (f.name || '').toLowerCase();
  if (n.endsWith('.docx') || n.endsWith('.doc')) return 'Word document';
  if (n.endsWith('.xlsx') || n.endsWith('.xls')) return 'Excel file';
  if (n.endsWith('.csv')) return 'CSV spreadsheet file';
  if (n.endsWith('.pdf')) return 'PDF';
  if (/\.(png|jpe?g|gif|webp|heic)$/.test(n)) return 'Picture';
  return 'File';
}

// ---------- messages at the bottom of the screen

export function toast(message, { undo, kind = 'ok', duration } = {}) {
  const box = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  t.innerHTML = `<span>${esc(message)}</span>${undo ? '<button class="btn btn-light toast-undo">↩ Undo</button>' : ''}<button class="toast-close" aria-label="Close message">✕</button>`;
  const close = () => t.remove();
  t.querySelector('.toast-close').onclick = close;
  if (undo) {
    t.querySelector('.toast-undo').onclick = async () => {
      close();
      try { await undo(); toast('Brought back. ✓'); } catch (e) { toast(e.message, { kind: 'error' }); }
    };
  }
  box.appendChild(t);
  setTimeout(close, duration ?? (undo ? 15000 : kind === 'error' ? 9000 : 5000));
}
export const showError = (e) => toast(e?.message || String(e), { kind: 'error' });

// ---------- pop-up boxes

// Opens a pop-up. `body` is HTML. buttons: [{label, value, style}]. Resolves with the
// clicked button's value (or null when closed). onSubmit(form) can validate & return a value.
export function modal({ title, body = '', buttons = [{ label: 'OK', value: true, style: 'primary' }], onOpen, onSubmit, wide = false }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `
      <form class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title" novalidate>
        <div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button type="button" class="modal-x" aria-label="Close">✕</button></div>
        <div class="modal-body">${body}</div>
        <div class="modal-error" role="alert" hidden></div>
        <div class="modal-buttons">${buttons.map((b, i) => `<button type="${b.submit ? 'submit' : 'button'}" class="btn btn-${b.style || 'light'}" data-i="${i}">${esc(b.label)}</button>`).join('')}</div>
      </form>`;
    const form = back.querySelector('form');
    const prevFocus = document.activeElement;
    const done = (v) => { back.remove(); document.removeEventListener('keydown', onKey); prevFocus?.focus?.(); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') done(null); };
    document.addEventListener('keydown', onKey);
    back.querySelector('.modal-x').onclick = () => done(null);
    back.addEventListener('mousedown', (e) => { if (e.target === back) done(null); });
    const errBox = back.querySelector('.modal-error');
    const submit = async (btn) => {
      if (btn.value === null || !onSubmit) return done(btn.value);
      try {
        errBox.hidden = true;
        const v = await onSubmit(form, btn.value);
        if (v !== undefined) done(v);
      } catch (e) {
        errBox.textContent = e.message;
        errBox.hidden = false;
      }
    };
    buttons.forEach((b, i) => {
      const el = back.querySelector(`[data-i="${i}"]`);
      if (!b.submit) el.onclick = () => submit(b);
    });
    form.onsubmit = (e) => { e.preventDefault(); const b = buttons.find((x) => x.submit); if (b) submit(b); };
    document.body.appendChild(back);
    onOpen?.(form, done);
    (form.querySelector('input:not([type=hidden]), select, textarea') || form.querySelector('.btn-primary') || form.querySelector('.btn'))?.focus();
  });
}

export const confirmBox = (title, text, yes = 'Yes', style = 'danger') => modal({
  title,
  body: `<p class="big">${text}</p>`,
  buttons: [{ label: 'No, go back', value: null }, { label: yes, value: true, style }],
});

// Common pattern: a form inside a pop-up. fields render as labelled inputs.
export function field({ name, label, type = 'text', value = '', options, required, placeholder = '', hint = '', step, min, attrs = '' }) {
  const id = `f-${name}-${Math.random().toString(36).slice(2, 7)}`;
  let input;
  if (type === 'select') {
    input = `<select id="${id}" name="${name}" ${required ? 'required' : ''} ${attrs}>${options.map((o) => `<option value="${esc(o.value)}" ${String(o.value) === String(value) ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>`;
  } else if (type === 'textarea') {
    input = `<textarea id="${id}" name="${name}" rows="3" placeholder="${esc(placeholder)}" ${attrs}>${esc(value)}</textarea>`;
  } else {
    input = `<input id="${id}" name="${name}" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" ${required ? 'required' : ''} ${step ? `step="${step}"` : ''} ${min !== undefined ? `min="${min}"` : ''} ${attrs}>`;
  }
  return `<div class="field"><label for="${id}">${esc(label)}</label>${input}${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
}
export const formData = (form) => Object.fromEntries(new FormData(form).entries());

// ---------- shared data (cached briefly)

let projectsCache = null;
export async function getProjects(force = false) {
  if (!projectsCache || force) projectsCache = await api('GET', '/api/projects');
  return projectsCache;
}
export const clearCaches = () => { projectsCache = null; foldersCache = null; };
let foldersCache = null;
export async function getFolders(force = false) {
  if (!foldersCache || force) foldersCache = await api('GET', '/api/folders');
  return foldersCache;
}

export async function projectOptions({ includeNone = false, noneLabel = '— No project —', includeDone = false } = {}) {
  const ps = (await getProjects()).filter((p) => includeDone || p.status === 'active');
  return [...(includeNone ? [{ value: '', label: noneLabel }] : []), ...ps.map((p) => ({ value: p.id, label: p.name }))];
}

// ---------- folder chooser

function treeHtml(nodes, selected, depth = 0) {
  return nodes.map((f) => `
    <li>
      <button type="button" class="tree-item ${f.id === selected ? 'selected' : ''}" data-id="${f.id}" style="padding-left:${0.6 + depth * 1.4}rem" aria-pressed="${f.id === selected}">
        <span aria-hidden="true">${f.id === selected ? '📂' : '📁'}</span> ${esc(f.name)}
      </button>
      ${f.children?.length ? `<ul>${treeHtml(f.children, selected, depth + 1)}</ul>` : ''}
    </li>`).join('');
}

// Asks where something should go. Resolves with a folder id, or null if cancelled.
export async function pickFolder({ title = 'Where should this go?', intro = 'Click a folder to choose it.', selected = null, okLabel = 'Put it here' } = {}) {
  let current = selected;
  let { tree } = await getFolders(true);
  const render = (form) => {
    form.querySelector('.tree').innerHTML = treeHtml(tree, current);
    form.querySelector('.chosen').innerHTML = current
      ? `Chosen: <strong>${esc(pathOf(current))}</strong>`
      : '<em>No folder chosen yet.</em>';
  };
  const pathOf = (id) => {
    const walk = (nodes, prefix) => {
      for (const n of nodes) {
        const p = prefix ? `${prefix} / ${n.name}` : n.name;
        if (n.id === id) return p;
        const r = walk(n.children || [], p);
        if (r) return r;
      }
      return null;
    };
    return walk(tree, '') || '';
  };
  return modal({
    title,
    wide: true,
    body: `<p>${esc(intro)}</p><ul class="tree" role="list"></ul><p class="chosen big"></p>
           <div class="new-folder-row"><label for="nf-name">Or make a new folder inside the chosen one:</label>
             <div class="inline-row"><input id="nf-name" class="nf-name" placeholder="New folder name"><button type="button" class="btn btn-light new-folder">➕ Make folder</button></div></div>`,
    buttons: [{ label: 'Cancel', value: null }, { label: okLabel, value: 'ok', style: 'primary', submit: true }],
    onOpen: (form) => {
      render(form);
      form.querySelector('.tree').addEventListener('click', (e) => {
        const b = e.target.closest('.tree-item');
        if (b) { current = Number(b.dataset.id); render(form); }
      });
      form.querySelector('.nf-name').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); form.querySelector('.new-folder').click(); }
      });
      form.querySelector('.new-folder').onclick = async () => {
        if (!current) return toast('First click the folder you want the new folder to go inside.', { kind: 'error' });
        const input = form.querySelector('.nf-name');
        const name = input.value;
        if (!name.trim()) { input.focus(); return toast('Type a name for the new folder first.', { kind: 'error' }); }
        try {
          const f = await api('POST', '/api/folders', { name: name.trim(), parent_id: current });
          tree = (await getFolders(true)).tree;
          current = f.id;
          input.value = '';
          render(form);
        } catch (e) { showError(e); }
      };
    },
    onSubmit: () => {
      if (!current) throw new Error('Please click a folder first.');
      return current;
    },
  });
}

// ---------- uploading

export async function uploadFiles(fileList, folderId, { editable = true } = {}) {
  const fd = new FormData();
  for (const f of fileList) fd.append('files', f);
  if (folderId) fd.append('folder_id', folderId);
  fd.append('editable', editable ? '1' : '0');
  return api('POST', '/api/files/upload', fd);
}

// Asks the user to choose files from their computer.
export function chooseFiles({ multiple = true, accept = '' } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = multiple;
    if (accept) input.accept = accept;
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}

// Deletes (moves to the Recycle Bin) and offers an Undo button.
export async function trashWithUndo(url, label, after) {
  const r = await api('DELETE', url);
  clearCaches();
  toast(`"${label}" was moved to the Recycle Bin.`, {
    undo: async () => { await api('POST', `/api/trash/${r.batch}/restore`); clearCaches(); after?.(); },
  });
  after?.();
  return r;
}

export const emptyState = (icon, text, extra = '') => `<div class="empty"><div class="empty-icon" aria-hidden="true">${icon}</div><p>${text}</p>${extra}</div>`;
