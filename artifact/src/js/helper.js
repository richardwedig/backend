// The "Ask the Helper" chat panel.
import { api, $, esc, uploadFiles, getFolders, showError, toast, chooseFiles, clearCaches } from './core.js';

let ctx = null;
let attachments = [];
let busy = false;
let loaded = false;

const SUGGESTIONS = [
  'How do I record my hours?',
  'How many hours did I work this week?',
  'Make a report of my hours this month',
  'Make an expenses spreadsheet for a project',
  'I deleted something by mistake. Can you help?',
];

// Very small, safe formatter: **bold**, lists, paragraphs and links to pages of this website.
function format(text) {
  const inline = (s) => esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((#\/[^)\s]*)\)/g, '<a href="$2">$1</a>');
  const out = [];
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    if (ol || ul) {
      const type = ol ? 'ol' : 'ul';
      if (!list || list.type !== type) { if (list) out.push(`</${list.type}>`); list = { type }; out.push(`<${type}>`); }
      out.push(`<li>${inline((ol || ul)[1])}</li>`);
      continue;
    }
    if (list) { out.push(`</${list.type}>`); list = null; }
    if (line.trim()) out.push(`<p>${inline(line.replace(/^#+\s*/, ''))}</p>`);
  }
  if (list) out.push(`</${list.type}>`);
  return out.join('');
}

function addMessage(role, text, { error = false } = {}) {
  const box = $('#helper-messages');
  box.querySelector('.helper-suggest')?.remove();
  const div = document.createElement('div');
  div.className = `msg msg-${role}${error ? ' msg-error' : ''}`;
  if (role === 'user') div.textContent = text;
  else div.innerHTML = format(text);
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}

function showWelcome(enabled) {
  const box = $('#helper-messages');
  box.innerHTML = '';
  addMessage('assistant', enabled
    ? 'Hello! I’m your helper. Ask me anything about the website, or ask me to do things for you, like recording hours, finding a file, or making a report. You can also attach a file with the 📎 button.\n\nHere are some ideas. Click one to ask it:'
    : 'Hello! The helper is not switched on yet: whoever set up this website needs to add an Anthropic API key. Everything else works normally, and the **Help** page explains how to use each part.');
  if (!enabled) return;
  const s = document.createElement('div');
  s.className = 'helper-suggest';
  s.innerHTML = SUGGESTIONS.map((q) => `<button class="chip" type="button">${esc(q)}</button>`).join('');
  s.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) send(b.textContent); });
  box.appendChild(s);
}

async function load() {
  const r = await api('GET', '/api/assistant');
  loaded = true;
  if (!r.messages.length) return showWelcome(r.enabled);
  $('#helper-messages').innerHTML = '';
  for (const m of r.messages) addMessage(m.role, m.display);
}

function drawAttachments() {
  $('#helper-attachments').innerHTML = attachments.map((a, i) => `<span class="chip">📎 ${esc(a.name)} <button type="button" class="btn-quiet" data-rm="${i}" aria-label="Remove ${esc(a.name)}" style="border:0;background:none;cursor:pointer">✕</button></span>`).join('');
}

async function send(text) {
  text = (text ?? $('#helper-input').value).trim();
  if (busy || (!text && !attachments.length)) return;
  busy = true;
  $('#helper-send').disabled = true;
  $('#helper-input').value = '';
  const sentAttachments = attachments;
  attachments = [];
  drawAttachments();
  addMessage('user', text + (sentAttachments.length ? `\n📎 ${sentAttachments.map((a) => a.name).join(', ')}` : ''));
  const typing = addMessage('assistant', '');
  typing.innerHTML = '<span class="typing">Thinking… (this can take a little while)</span>';
  try {
    const r = await api('POST', '/api/assistant', { message: text, context: { page: ctx.page.context, attachments: sentAttachments } });
    typing.remove();
    addMessage('assistant', r.reply || 'Done.', { error: r.error });
    let navigated = false;
    for (const a of r.actions || []) {
      if (a.type === 'navigate') { navigated = true; ctx.go(a.link); }
    }
    if (!navigated && r.actions?.some((a) => a.type === 'refresh')) { clearCaches(); ctx.refresh(); }
    if (r.actions?.length) ctx.updateTimerChip();
  } catch (e) {
    typing.remove();
    addMessage('assistant', e.message, { error: true });
  } finally {
    busy = false;
    $('#helper-send').disabled = false;
    $('#helper-input').focus();
  }
}

export function openHelper() {
  $('#helper').hidden = false;
  $('#app').classList.add('helper-open');
  $('#open-helper').setAttribute('aria-expanded', 'true');
  try { localStorage.setItem('wt-helper', '1'); } catch { /* ignore */ }
  if (!loaded) load().catch(showError);
  $('#helper-input').focus();
}

function closeHelper() {
  $('#helper').hidden = true;
  $('#app').classList.remove('helper-open');
  $('#open-helper').setAttribute('aria-expanded', 'false');
  try { localStorage.setItem('wt-helper', '0'); } catch { /* ignore */ }
  $('#open-helper').focus();
}

export function init(c) {
  ctx = c;
  $('#open-helper').onclick = () => ($('#helper').hidden ? openHelper() : closeHelper());
  $('#helper-close').onclick = closeHelper;
  $('#helper-new').onclick = async () => {
    await api('POST', '/api/assistant/new');
    const r = await api('GET', '/api/assistant');
    showWelcome(r.enabled);
  };
  $('#helper-form').onsubmit = (e) => { e.preventDefault(); send(); };
  $('#helper-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  $('#helper-attach').onclick = async () => {
    const files = await chooseFiles();
    if (!files.length) return;
    try {
      const { special } = await getFolders(true);
      const r = await uploadFiles(files, special.inbox, { editable: false });
      attachments.push(...r.files.map((f) => ({ id: f.id, name: f.name, folder_path: f.folder_path })));
      drawAttachments();
      toast('Attached. Now type what you would like me to do with it, then press Send.');
      $('#helper-input').focus();
    } catch (e) { showError(e); }
  };
  $('#helper-attachments').addEventListener('click', (e) => {
    const b = e.target.closest('[data-rm]');
    if (b) { attachments.splice(Number(b.dataset.rm), 1); drawAttachments(); }
  });
  let open = false;
  try { open = localStorage.getItem('wt-helper') === '1'; } catch { /* ignore */ }
  if (open && window.innerWidth > 1250) openHelper();
}
