import { api, $, $$, esc, toast, showError, clearCaches, fileIcon, niceDate } from './core.js';
import * as dashboard from './pages/dashboard.js';
import * as hours from './pages/hours.js';
import * as projects from './pages/projects.js';
import * as calendar from './pages/calendar.js';
import * as files from './pages/files.js';
import * as reports from './pages/reports.js';
import * as trash from './pages/trash.js';
import * as help from './pages/help.js';
import * as helper from './helper.js';

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
  const hash = decodeURIComponent(location.hash.replace(/^#/, '')) || '/';
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
  location.hash = '#/';
}

// Re-draws the current page without moving the scroll position.
export async function refresh() {
  clearCaches();
  const y = window.scrollY;
  await route();
  window.scrollTo(0, y);
}
export const go = (link) => { if (location.hash === link) refresh(); else location.hash = link; };

window.addEventListener('hashchange', async () => { await route(); $('#main').focus({ preventScroll: true }); window.scrollTo(0, 0); });

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
  if (q) location.hash = `#/search/${encodeURIComponent(q)}`;
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

// ---------- sign in (only when a password is set)
async function checkLogin() {
  const me = await api('GET', '/api/me');
  $('#signout').hidden = !me.password_required;
  if (me.signed_in) { $('#login').hidden = true; return true; }
  $('#login').hidden = false;
  $('#login-pw').focus();
  return false;
}
$('#login form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const err = $('#login .modal-error');
  try {
    await api('POST', '/api/login', { password: $('#login-pw').value });
    $('#login').hidden = true;
    start();
  } catch (ex) { err.textContent = ex.message; err.hidden = false; }
});
$('#signout').onclick = async () => { await api('POST', '/api/logout'); location.reload(); };
window.addEventListener('needs-login', () => { $('#login').hidden = false; });

window.addEventListener('unhandledrejection', (e) => { showError(e.reason); });

let started = false;
async function start() {
  if (started) return;
  started = true;
  helper.init({ page, go, refresh, updateTimerChip });
  updateTimerChip();
  await route();
}
checkLogin().then((ok) => ok && start()).catch(() => toast('The website could not be reached. Please check your connection and reload the page.', { kind: 'error', duration: 60000 }));
