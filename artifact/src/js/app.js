import { api, $, $$, esc, toast, showError, clearCaches, fileIcon, niceDate, download } from './core.js';
import * as dashboard from './pages/dashboard.js';
import * as hours from './pages/hours.js';
import * as projects from './pages/projects.js';
import * as calendar from './pages/calendar.js';
import * as files from './pages/files.js';
import * as reports from './pages/reports.js';
import * as trash from './pages/trash.js';
import * as help from './pages/help.js';
import * as helper from './helper.js';
import { ready, canSave, onChange } from '../local/store.js';

const routes = [
  [/^\/?$/, dashboard.render, 'home'],
  [/^\/hours$/, hours.render, 'hours'],
  [/^\/projects$/, projects.renderList, 'projects'],
  [/^\/projects\/(\d+)$/, projects.renderOne, 'projects'],
  [/^\/calendar(?:\/(\d{4}-\d{2}))?(?:\/(\d{4}-\d{2}-\d{2}))?$/, calendar.render, 'calendar'],
  [/^\/files(?:\/(\d+))?$/, files.renderFolder, 'files'],
  [/^\/file\/(\d+)$/, files.renderFile, 'files'],
  [/^\/reports$/, reports.render, 'reports'],
  [/^\/trash$/, trash.render, 'trash'],
  [/^\/help$/, help.render, 'help'],
  [/^\/search\/(.*)$/, renderSearch, null],
];

// What the helper is told about the current screen.
export const page = { context: 'Home page' };
let leaveGuard = null;
export const setLeaveGuard = (fn) => { leaveGuard = fn; };

async function route() {
  if (leaveGuard) { await leaveGuard(); leaveGuard = null; }
  const hash = decodeURIComponent(current.replace(/^#/, '')) || '/';
  const main = $('#main');
  for (const [re, fn, nav] of routes) {
    const m = hash.match(re);
    if (!m) continue;
    $$('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.nav === nav));
    $('.sidebar').classList.remove('open');
    $('.menu-toggle').setAttribute('aria-expanded', 'false');
    page.context = null;
    try {
      await fn(main, ...m.slice(1));
    } catch (e) {
      main.innerHTML = `<div class="card"><h1>Sorry, this page could not be shown</h1><p class="big">${esc(e.message)}</p><a class="btn btn-primary" href="#/">🏠 Go to the Home page</a></div>`;
    }
    const h1 = main.querySelector('h1');
    document.title = h1 ? `${h1.textContent.trim()} – Work Tracker` : 'Work Tracker';
    if (!page.context) page.context = h1 ? `the "${h1.textContent.trim()}" page` : hash;
    updateTrashBadge();
    return;
  }
  go('#/');
}

// Re-draws the current page without moving the scroll position.
export async function refresh() {
  clearCaches();
  const y = window.scrollY;
  await route();
  window.scrollTo(0, y);
}
let current = '#/';
export const go = (link) => {
  if (link === current) return refresh();
  current = link;
  try { history.pushState(null, '', link); } catch { /* address bar not available */ }
  onNavigate();
};
async function onNavigate() { await route(); $('#main').focus({ preventScroll: true }); window.scrollTo(0, 0); }
window.addEventListener('popstate', () => { current = location.hash || '#/'; onNavigate(); });

// Links to pages of this website, and download buttons, anywhere on the page.
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#/"]');
  if (a && !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey) { e.preventDefault(); go(a.getAttribute('href')); return; }
  const d = e.target.closest('[data-download]');
  if (d) { e.preventDefault(); download(Number(d.dataset.download)); }
});


// ---------- search
async function renderSearch(main, q) {
  const r = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
  const total = r.projects.length + r.files.length + r.folders.length + r.events.length;
  const section = (title, items) => (items ? `<div class="card"><h2>${title}</h2><ul class="list">${items}</ul></div>` : '');
  main.innerHTML = `
    <div class="page-head"><div><h1>Search results</h1><p>Looking for “${esc(q)}” — found ${total} ${total === 1 ? 'thing' : 'things'}.</p></div></div>
    ${total ? '' : '<div class="card"><p class="big">Nothing matched. Try a shorter word, or ask the Helper to find it for you.</p></div>'}
    ${section('Projects', r.projects.map((p) => `<li><span class="dot" style="background:${esc(p.color)}"></span><a class="title grow" href="#/projects/${p.id}">${esc(p.name)}</a></li>`).join(''))}
    ${section('Folders', r.folders.map((f) => `<li><span class="icon">📁</span><div class="grow"><a class="title" href="#/files/${f.id}">${esc(f.name)}</a><div class="sub">${esc(f.path)}</div></div></li>`).join(''))}
    ${section('Files', r.files.map((f) => `<li><span class="icon">${fileIcon(f)}</span><div class="grow"><a class="title" href="#/file/${f.id}">${esc(f.name)}</a><div class="sub">In ${esc(f.folder_path)}</div></div></li>`).join(''))}
    ${section('Calendar', r.events.map((e) => `<li><span class="icon">📅</span><div class="grow"><a class="title" href="#/calendar/${e.date.slice(0, 7)}/${e.date}">${esc(e.title)}</a><div class="sub">${niceDate(e.date)}</div></div></li>`).join(''))}`;
}

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('#search-box').value.trim();
  if (q) go(`#/search/${encodeURIComponent(q)}`);
});

// ---------- running stopwatch shown at the top of every page
let timerTick = null;
export async function updateTimerChip(timer) {
  if (timer === undefined) {
    try { timer = (await api('GET', '/api/timer')).timer; } catch { return; }
  }
  clearInterval(timerTick);
  const chip = $('#timer-chip');
  if (!timer) { chip.innerHTML = ''; return; }
  const draw = () => {
    const s = Math.max(0, Math.floor((Date.now() - new Date(timer.started_at).getTime()) / 1000));
    chip.innerHTML = `<a class="timer-chip" href="#/hours" title="The stopwatch is running. Click to stop it."><span class="pulse"></span>${esc(timer.project_name)} · ${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}</a>`;
  };
  draw();
  timerTick = setInterval(draw, 30000);
}

async function updateTrashBadge() {
  try {
    const n = (await api('GET', '/api/trash')).length;
    const b = $('#trash-badge');
    b.textContent = n;
    b.hidden = !n;
  } catch { /* ignore */ }
}

// ---------- text size
function setScale(s) {
  document.documentElement.style.setProperty('--scale', s);
  $$('.text-size .btn').forEach((b) => b.classList.toggle('on', b.dataset.size === String(s)));
  try { localStorage.setItem('wt-scale', s); } catch { /* private mode */ }
}
$$('.text-size .btn').forEach((b) => { b.onclick = () => setScale(b.dataset.size); });
try { setScale(localStorage.getItem('wt-scale') || '1'); } catch { setScale('1'); }

$('.menu-toggle').onclick = () => {
  const open = $('.sidebar').classList.toggle('open');
  $('.menu-toggle').setAttribute('aria-expanded', String(open));
};

window.addEventListener('unhandledrejection', (e) => { showError(e.reason); });

// When stored data changes (another tab or device, or the Helper), redraw the
// page, but never while someone is typing or a pop-up is open.
let pendingRedraw = false;
function softRefresh() {
  const busy = document.querySelector('.modal-back') || document.querySelector('#sheet-editor')
    || (document.activeElement?.matches?.('input, textarea, select') && $('#main').contains(document.activeElement));
  if (busy) { pendingRedraw = true; return; }
  pendingRedraw = false;
  refresh();
  updateTimerChip();
}
document.addEventListener('focusout', () => setTimeout(() => { if (pendingRedraw) softRefresh(); }, 300));

let started = false;
async function start() {
  if (started) return;
  started = true;
  $('#main').innerHTML = '<div class="card"><p class="big">Opening your work…</p></div>';
  const { stored } = await ready();
  if (!stored) {
    toast('Your work can’t be saved on this screen. Open the page in Claude while signed in to keep your changes.', { kind: 'error', duration: 60000 });
  } else if (!canSave()) {
    toast('You can look at everything here, but only the owner can make changes.', { duration: 15000 });
  }
  onChange(softRefresh);
  helper.init({ page, go, refresh, updateTimerChip });
  updateTimerChip();
  if (/^#\/[\w/-]*$/.test(location.hash)) current = location.hash;
  await route();
}
start().catch(() => toast('The website could not be opened. Please reload the page.', { kind: 'error', duration: 60000 }));
