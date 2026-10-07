import { api, esc, niceDate, niceTime, hoursText, fileIcon, when, emptyState, parseISO } from '../core.js';
import { page } from '../app.js';
import { logHoursDialog, newProjectDialog } from './hours.js';
import { uploadDialog } from './files.js';

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

// Hours per day for the last 14 days: one series, so the title names it (no legend).
function dailyChart(days) {
  const W = 480, H = 230, padL = 28, padB = 40, padT = 10;
  const max = Math.max(4, ...days.map((d) => d.hours));
  const step = max <= 8 ? 2 : max <= 16 ? 4 : 8;
  const top = Math.ceil(max / step) * step;
  const bw = (W - padL) / days.length;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  let grid = '';
  for (let v = 0; v <= top; v += step) grid += `<line class="grid" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  const bars = days.map((d, i) => {
    const x = padL + i * bw + bw * 0.18;
    const w = bw * 0.64;
    const label = parseISO(d.date).toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 2);
    const tip = `${niceDate(d.date, { weekday: true, noYear: true })}: ${hoursText(d.hours)}`;
    const h = Math.max(0, y(0) - y(d.hours));
    // Rounded top, square bottom on the baseline.
    const r = Math.min(4, w / 2, h);
    const path = h > 0 ? `M${x},${y(0)} V${y(d.hours) + r} Q${x},${y(d.hours)} ${x + r},${y(d.hours)} H${x + w - r} Q${x + w},${y(d.hours)} ${x + w},${y(d.hours) + r} V${y(0)} Z` : '';
    return `<g data-tip="${esc(tip)}"><rect x="${padL + i * bw}" y="${padT}" width="${bw}" height="${H - padT - padB}" fill="transparent"/>${path ? `<path class="bar" d="${path}"/>` : ''}
      <text x="${x + w / 2}" y="${H - padB + 18}" text-anchor="middle">${label}</text><text x="${x + w / 2}" y="${H - padB + 35}" text-anchor="middle">${parseISO(d.date).getDate()}</text></g>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bar chart of hours worked each day for the last 14 days">${grid}${bars}</svg>`;
}

function attachTooltips(root) {
  let tip = null;
  root.querySelectorAll('[data-tip]').forEach((g) => {
    g.addEventListener('mousemove', (e) => {
      if (!tip) { tip = document.createElement('div'); tip.className = 'tooltip'; document.body.appendChild(tip); }
      tip.textContent = g.dataset.tip;
      tip.style.left = `${e.clientX + 14}px`;
      tip.style.top = `${e.clientY - 34}px`;
    });
    g.addEventListener('mouseleave', () => { tip?.remove(); tip = null; });
  });
}

export async function render(main) {
  const d = await api('GET', '/api/dashboard');
  page.context = 'the Home page (dashboard)';
  const maxProj = Math.max(1, ...d.by_project_month.map((p) => p.hours));
  const monthName = new Date().toLocaleDateString('en-US', { month: 'long' });
  const tableRows = d.last14.map((x) => `<tr><td>${niceDate(x.date, { weekday: true, noYear: true })}</td><td>${x.hours}</td></tr>`).join('');

  main.innerHTML = `
    <div class="page-head">
      <div><h1>${greeting()}!</h1><p>Today is ${niceDate(d.today, { weekday: true })}.</p></div>
    </div>

    ${d.timer ? `<div class="notice notice-good big"><span class="pulse" style="display:inline-block"></span> The stopwatch is running for <strong>${esc(d.timer.project_name)}</strong>. <a href="#/hours">Go to My Hours to stop it</a>.</div>` : ''}

    <div class="quick">
      <button class="btn" data-q="log"><span aria-hidden="true">⏱️</span> Add hours I worked</button>
      <a class="btn" href="#/hours"><span aria-hidden="true">▶️</span> Start the stopwatch</a>
      <button class="btn" data-q="project"><span aria-hidden="true">📁</span> Start a new project</button>
      <button class="btn" data-q="upload"><span aria-hidden="true">📎</span> Add a file</button>
      <a class="btn" href="#/reports"><span aria-hidden="true">📊</span> Make a report</a>
    </div>

    <div class="stats">
      <div class="stat"><div class="label">Today</div><div class="value">${d.hours.today} <span class="unit">hours</span></div></div>
      <div class="stat"><div class="label">This week</div><div class="value">${d.hours.week} <span class="unit">hours</span></div></div>
      <div class="stat"><div class="label">This month</div><div class="value">${d.hours.month} <span class="unit">hours</span></div></div>
      <div class="stat"><div class="label">Active projects</div><div class="value">${d.active_projects}</div></div>
    </div>

    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h2>Hours worked each day (last 2 weeks)</h2></div>
        ${dailyChart(d.last14)}
        <details><summary>Show as a list</summary><table class="data-table"><thead><tr><th>Day</th><th>Hours</th></tr></thead><tbody>${tableRows}</tbody></table></details>
      </section>
      <section class="card">
        <div class="card-head"><h2>Hours by project in ${monthName}</h2></div>
        ${d.by_project_month.length ? d.by_project_month.map((p) => `
          <div class="hbar">
            <a class="name" href="#/projects/${p.id}">${esc(p.name)}</a>
            <div class="track"><div class="fill" style="width:${(p.hours / maxProj) * 100}%;background:${esc(p.color)}"></div></div>
            <div class="val">${p.hours} h</div>
          </div>`).join('') : emptyState('📈', `No hours recorded yet in ${monthName}.`)}
      </section>
    </div>

    <div class="grid-2">
      <section class="card">
        <div class="card-head"><h2>📅 Coming up</h2><a class="btn btn-light" href="#/calendar">Open calendar</a></div>
        ${d.upcoming.length ? `<ul class="list">${d.upcoming.map((e) => `
          <li><div class="grow"><a class="title" href="#/calendar/${e.date.slice(0, 7)}/${e.date}">${esc(e.title)}</a>
            <div class="sub">${niceDate(e.date, { weekday: true, noYear: true })}${e.time ? ` at ${niceTime(e.time)}` : ''}${e.project_name ? ` · ${esc(e.project_name)}` : ''}</div></div></li>`).join('')}</ul>`
          : emptyState('🗓️', 'Nothing on the calendar for the next 30 days.')}
      </section>
      <section class="card">
        <div class="card-head"><h2>🕘 Recent activity</h2></div>
        ${d.activity.length ? `<ul class="list">${d.activity.map((a) => `
          <li><span class="icon" aria-hidden="true">${a.icon || '•'}</span><div class="grow">${a.link ? `<a class="title" href="${esc(a.link)}">${esc(a.message)}</a>` : `<span class="title">${esc(a.message)}</span>`}<div class="sub">${when(a.at)}</div></div></li>`).join('')}</ul>`
          : emptyState('✨', 'Things you do will show up here.')}
      </section>
    </div>

    <section class="card">
      <div class="card-head"><h2>📄 Recent files</h2><a class="btn btn-light" href="#/files">All files &amp; folders</a></div>
      ${d.recent_files.length ? `<ul class="list">${d.recent_files.map((f) => `
        <li><span class="icon" aria-hidden="true">${fileIcon(f)}</span><div class="grow"><a class="title" href="#/file/${f.id}">${esc(f.name)}</a><div class="sub">In ${esc(f.folder_path)} · ${when(f.updated_at)}</div></div></li>`).join('')}</ul>`
        : emptyState('📂', 'No files yet. Use “Add a file” above to upload one.')}
    </section>`;

  attachTooltips(main);
  main.querySelector('[data-q=log]').onclick = () => logHoursDialog();
  main.querySelector('[data-q=project]').onclick = () => newProjectDialog();
  main.querySelector('[data-q=upload]').onclick = () => uploadDialog();
}

