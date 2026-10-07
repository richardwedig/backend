import { api, esc, toast, showError, when, emptyState, confirmBox, clearCaches } from '../core.js';
import { page, refresh, updateTimerChip } from '../app.js';

const ICONS = { project: '📁', entry: '⏱️', folder: '📂', file: '📄', event: '📅' };

export async function render(main) {
  const items = await api('GET', '/api/trash');
  page.context = `the Recycle Bin page (${items.length} items)`;
  main.innerHTML = `
    <div class="page-head"><div><h1>♻️ Recycle Bin</h1><p>Anything you delete comes here first. Press <strong>Restore</strong> to put it back exactly where it was.</p></div>
      ${items.length ? '<button class="btn btn-light" id="empty">Empty the Recycle Bin…</button>' : ''}</div>
    <section class="card">
      ${items.length ? `<ul class="list">${items.map((t) => `
        <li><span class="icon" aria-hidden="true">${ICONS[t.item_type] || '📄'}</span>
          <div class="grow"><div class="title">${esc(t.label)}</div>
            <div class="sub">${esc(t.type_word)} · deleted ${when(t.deleted_at)}${t.includes.length ? ` · also includes ${esc(t.includes.join(', '))}` : ''}</div></div>
          <button class="btn btn-good btn-big" data-restore="${esc(t.batch)}">↩ Restore</button>
          <button class="btn btn-quiet" data-purge="${esc(t.batch)}">Delete forever</button>
        </li>`).join('')}</ul>` : emptyState('✨', 'The Recycle Bin is empty.')}
    </section>`;

  main.querySelectorAll('[data-restore]').forEach((b) => {
    b.onclick = async () => {
      try {
        const r = await api('POST', `/api/trash/${b.dataset.restore}/restore`);
        clearCaches();
        toast(`“${r.restored}” is back. ${r.notes.join(' ')}`, { duration: 9000 });
        updateTimerChip();
        refresh();
      } catch (e) { showError(e); }
    };
  });
  main.querySelectorAll('[data-purge]').forEach((b) => {
    b.onclick = async () => {
      const t = items.find((x) => x.batch === b.dataset.purge);
      const yes = await confirmBox('Delete forever?', `“${esc(t.label)}” will be gone for good and <strong>cannot be brought back</strong>.`, 'Yes, delete forever');
      if (!yes) return;
      try { await api('DELETE', `/api/trash/${t.batch}`); toast('Deleted forever.'); refresh(); } catch (e) { showError(e); }
    };
  });
  const empty = main.querySelector('#empty');
  if (empty) {
    empty.onclick = async () => {
      const yes = await confirmBox('Empty the whole Recycle Bin?', `All ${items.length} item${items.length === 1 ? '' : 's'} will be gone for good and <strong>cannot be brought back</strong>.`, 'Yes, empty it');
      if (!yes) return;
      try { await api('DELETE', '/api/trash'); toast('The Recycle Bin is now empty.'); refresh(); } catch (e) { showError(e); }
    };
  }
}
