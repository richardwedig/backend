// Access to the claude.ai capabilities this page runs on, and lazy loading of
// the few libraries needed for Word and Excel files.

const caps = {};
export async function cap(name) {
  if (!(name in caps)) {
    caps[name] = window.claude?.use ? window.claude.use(name).catch(() => null) : Promise.resolve(null);
  }
  return caps[name];
}

const LIBS = {
  XLSX: 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  mammoth: 'https://cdn.jsdelivr.net/npm/mammoth@1.13.0/mammoth.browser.min.js',
  docx: 'https://cdn.jsdelivr.net/npm/docx@9.9.0/dist/index.iife.js',
};
const loading = {};
export function lib(name) {
  if (window[name]) return Promise.resolve(window[name]);
  loading[name] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LIBS[name];
    s.onload = () => (window[name] ? resolve(window[name]) : reject(new Error('A helper library did not load. Please reload the page.')));
    s.onerror = () => { delete loading[name]; reject(new Error('A helper library could not be loaded. Please check your connection and try again.')); };
    document.head.appendChild(s);
  });
  return loading[name];
}

export class UserError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Offers a generated or stored file to the viewer.
export async function saveFile(filename, data) {
  const dl = await cap('downloads');
  if (!dl) throw new UserError('Downloading is not available here.');
  try {
    await dl.save({ filename, data });
    return true;
  } catch (e) {
    if (e?.code === 'declined') return false;
    if (e?.code === 'rejected_extension') throw new UserError('This kind of file cannot be downloaded here.');
    if (e?.code === 'rate_limited') throw new UserError('A download is already waiting for your answer.');
    throw new UserError('The download did not work. Please try again.');
  }
}
