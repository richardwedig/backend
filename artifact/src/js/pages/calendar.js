import {
  api, esc, modal, field, formData, toast, showError, projectOptions, todayISO, toISO, parseISO, niceDate, niceTime,
  hoursText, trashWithUndo, emptyState,
} from '../core.js';
import { page, refresh, go } from '../app.js';
import { logHoursDialog, editEntryDialog } from './hours.js';

export async function eventDialog(ev = {}) {
  const editing = Boolean(ev.id);
  const r = await modal({
    title: editing ? 'Change calendar item' : 'Add to the calendar',
    body: `${field({ name: 'title', label: 'What is it?', value: ev.title, required: true, placeholder: 'For example: Meet with the client' })}
           <div class="form-grid">${field({ name: 'date', label: 'Day', type: 'date', value: ev.date || todayISO(), required: true })}
           ${field({ name: 'time', label: 'Time (optional)', type: 'time', value: ev.time })}</div>
           ${field({ name: 'project_id', label: 'Project (optional)', type: 'select', options: await projectOptions({ includeNone: true, includeDone: true }), value: ev.project_id || '' })}
           ${field({ name: 'notes', label: 'Notes (optional)', type: 'textarea', value: ev.notes })}`,
    buttons: [{ label: 'Cancel', value: null }, { label: editing ? 'Save changes' : 'Add it', value: 'ok', style: 'primary', submit: true }],
    onSubmit: (form) => api(editing ? 'PUT' : 'POST', editing ? `/api/events/${ev.id}` : '/api/events', formData(form)),
  });
  if (r) { toast(editing ? 'Changes saved.' : `Added to the calendar on ${niceDate(r.date, { noYear: true })}.`); refresh(); }
}

export async function render(main, month, day) {
  const today = todayISO();
  month = month || today.slice(0, 7);
  const data = await api('GET', `/api/calendar?month=${month}`);
  const first = parseISO(`${month}-01`);
  const monthLabel = first.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  const selected = day && day.startsWith(month) ? day : (today.startsWith(month) ? today : `${month}-01`);
  page.context = `the Calendar page showing ${monthLabel}, with ${niceDate(selected)} selected`;

  // Weeks start on Monday.
  const startOffset = (first.getDay() + 6) % 7;
  const gridStart = new Date(first); gridStart.setDate(1 - startOffset);
  const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < Math.ceil((startOffset + daysInMonth) / 7) * 7; i++) {
    const d = new Date(gridStart); d.setDate(gridStart.getDate() + i);
    cells.push(toISO(d));
  }
  const evByDay = {};
  for (const e of data.events) (evByDay[e.date] ||= []).push(e);

  const prev = new Date(first); prev.setMonth(prev.getMonth() - 1);
  const next = new Date(first); next.setMonth(next.getMonth() + 1);
  const dayCell = (iso) => {
    const hrs = data.hours[iso] || [];
    const evs = evByDay[iso] || [];
    const total = Math.round(hrs.reduce((s, h) => s + h.hours, 0) * 100) / 100;
    const label = `${niceDate(iso, { weekday: true })}${total ? `, ${hoursText(total)} worked` : ''}${evs.length ? `, ${evs.length} calendar item${evs.length > 1 ? 's' : ''}` : ''}`;
    return `<button class="day ${iso.slice(0, 7) !== month ? 'other' : ''} ${iso === today ? 'today' : ''} ${iso === selected ? 'selected' : ''}" data-day="${iso}" aria-label="${esc(label)}" aria-pressed="${iso === selected}">
      <span class="num">${parseISO(iso).getDate()}</span>
      ${total ? `<span class="hrs">${[...new Set(hrs.map((h) => h.color))].slice(0, 3).map((c) => `<span class="dot" style="background:${esc(c)}"></span>`).join('')} ${total} h</span>` : ''}
      ${evs.slice(0, 2).map((e) => `<span class="ev">${e.time ? `${niceTime(e.time)} ` : ''}${esc(e.title)}</span>`).join('')}
      ${evs.length > 2 ? `<span class="more">+${evs.length - 2} more</span>` : ''}
    </button>`;
  };

  const selHours = data.hours[selected] || [];
  const selEvents = evByDay[selected] || [];

  main.innerHTML = `
    <div class="page-head"><div><h1>Calendar</h1><p>Click a day to see what happened, or to add hours and reminders.</p></div>
      <button class="btn btn-primary btn-big" id="add-event">➕ Add to calendar</button></div>
    <section class="card">
      <div class="cal-head">
        <a class="btn btn-light" href="#/calendar/${toISO(prev).slice(0, 7)}" aria-label="Previous month">◀ ${prev.toLocaleDateString('en-US', { month: 'short' })}</a>
        <h2>${monthLabel}</h2>
        <a class="btn btn-light" href="#/calendar/${toISO(next).slice(0, 7)}" aria-label="Next month">${next.toLocaleDateString('en-US', { month: 'short' })} ▶</a>
        <a class="btn btn-light" href="#/calendar/${today.slice(0, 7)}/${today}">Today</a>
      </div>
      <div class="cal" role="grid">
        ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => `<div class="dow">${d}</div>`).join('')}
        ${cells.map(dayCell).join('')}
      </div>
    </section>

    <section class="card" id="day-panel">
      <div class="card-head"><h2>${niceDate(selected, { weekday: true })}</h2>
        <div class="btn-row"><button class="btn btn-light" id="day-hours">⏱️ Add hours</button><button class="btn btn-light" id="day-event">📅 Add calendar item</button></div></div>
      <h3>Calendar items</h3>
      ${selEvents.length ? `<ul class="list">${selEvents.map((e) => `
        <li><span class="icon" aria-hidden="true">📌</span><div class="grow"><div class="title">${e.time ? `${niceTime(e.time)} – ` : ''}${esc(e.title)}</div>
          <div class="sub">${e.project_name ? `${esc(e.project_name)}${e.notes ? ' · ' : ''}` : ''}${esc(e.notes || '')}</div></div>
          <button class="btn btn-light" data-edit-ev="${e.id}">✏️ Change</button><button class="btn btn-light" data-del-ev="${e.id}">🗑️ Delete</button></li>`).join('')}</ul>`
        : '<p class="muted">Nothing planned.</p>'}
      <h3 style="margin-top:1rem">Hours worked</h3>
      ${selHours.length ? `<ul class="list">${selHours.map((h) => `
        <li><span class="dot" style="background:${esc(h.color)}"></span><div class="grow"><a class="title" href="#/projects/${h.project_id}">${esc(h.project)}</a><div class="sub">${esc(h.note || '')}</div></div>
          <span class="amount">${hoursText(h.hours)}</span><button class="btn btn-light" data-edit-h="${h.id}">✏️ Change</button></li>`).join('')}</ul>`
        : emptyState('⏱️', 'No hours recorded on this day.')}
    </section>`;

  main.querySelectorAll('[data-day]').forEach((b) => {
    b.onclick = () => {
      const d = b.dataset.day;
      go(`#/calendar/${d.slice(0, 7)}/${d}`);
      setTimeout(() => document.getElementById('day-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    };
  });
  main.querySelector('#add-event').onclick = () => eventDialog({ date: selected });
  main.querySelector('#day-event').onclick = () => eventDialog({ date: selected });
  main.querySelector('#day-hours').onclick = () => logHoursDialog({ date: selected });
  main.querySelectorAll('[data-edit-ev]').forEach((b) => { b.onclick = () => eventDialog(selEvents.find((e) => e.id === Number(b.dataset.editEv))); });
  main.querySelectorAll('[data-del-ev]').forEach((b) => {
    b.onclick = () => {
      const e = selEvents.find((x) => x.id === Number(b.dataset.delEv));
      trashWithUndo(`/api/events/${e.id}`, e.title, refresh).catch(showError);
    };
  });
  main.querySelectorAll('[data-edit-h]').forEach((b) => {
    b.onclick = async () => {
      const h = selHours.find((x) => x.id === Number(b.dataset.editH));
      editEntryDialog({ id: h.id, project_id: h.project_id, date: selected, hours: h.hours, note: h.note });
    };
  });
}
