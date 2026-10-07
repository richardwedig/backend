// SQLite storage. Everything that can be deleted is "soft deleted": we stamp
// deleted_at plus a delete_batch id, and record one row in `trash`. Restoring a
// batch brings back every row stamped with it (a project together with its
// hours, folders and files), so nothing is ever lost by accident.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// node:sqlite prints an "experimental" warning once; it is stable enough here.
const origEmit = process.emitWarning;
process.emitWarning = (w, ...a) => (String(w).includes('SQLite') ? undefined : origEmit.call(process, w, ...a));
const { DatabaseSync } = require('node:sqlite');
process.emitWarning = origEmit;

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'files');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'tracker.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  color TEXT DEFAULT '#2a78d6',
  hourly_rate REAL DEFAULT 0,
  status TEXT DEFAULT 'active',
  folder_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  deleted_at TEXT, delete_batch TEXT
);
CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL,
  date TEXT NOT NULL,
  hours REAL NOT NULL,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  deleted_at TEXT, delete_batch TEXT
);
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id INTEGER,
  project_id INTEGER,
  system TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  deleted_at TEXT, delete_batch TEXT
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  folder_id INTEGER,
  project_id INTEGER,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,            -- 'upload' | 'report' | 'spreadsheet'
  mime TEXT,
  size INTEGER DEFAULT 0,
  stored_name TEXT,              -- file on disk (uploads and reports)
  sheet TEXT,                    -- JSON {columns:[], rows:[[]]} for spreadsheets
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  deleted_at TEXT, delete_batch TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT DEFAULT '',
  notes TEXT DEFAULT '',
  project_id INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  deleted_at TEXT, delete_batch TEXT
);
CREATE TABLE IF NOT EXISTS trash (
  batch TEXT PRIMARY KEY,
  item_type TEXT NOT NULL,
  item_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  deleted_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  at TEXT DEFAULT (datetime('now')),
  icon TEXT,
  message TEXT NOT NULL,
  link TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY,
  conversation INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,         -- JSON content blocks, stored exactly as sent/received
  display TEXT,                  -- plain text shown in the chat window (null = hidden)
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, created_at TEXT DEFAULT (datetime('now')));
CREATE INDEX IF NOT EXISTS idx_entries_date ON time_entries(date);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folder_id);
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
`);

const all = (sql, ...p) => db.prepare(sql).all(...p);
const get = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

function tx(fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function setting(key, value) {
  if (value === undefined) {
    const r = get('SELECT value FROM settings WHERE key = ?', key);
    return r ? JSON.parse(r.value) : null;
  }
  if (value === null) run('DELETE FROM settings WHERE key = ?', key);
  else run('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  return value;
}

function logActivity(icon, message, link = null) {
  run('INSERT INTO activity(icon, message, link) VALUES (?, ?, ?)', icon, message, link);
}

// Built-in top-level folders. They can be renamed but not deleted.
const SYSTEM_FOLDERS = [
  ['projects', 'Projects'],
  ['reports', 'Reports'],
  ['inbox', 'Inbox (new uploads)'],
  ['documents', 'My Documents'],
];
for (const [key, name] of SYSTEM_FOLDERS) {
  if (!get('SELECT id FROM folders WHERE system = ?', key)) {
    run('INSERT INTO folders(name, parent_id, system) VALUES (?, NULL, ?)', name, key);
  }
}
const systemFolder = (key) => get('SELECT id FROM folders WHERE system = ?', key).id;

const newBatch = () => crypto.randomUUID();

module.exports = { db, all, get, run, tx, setting, logActivity, systemFolder, newBatch, DATA_DIR, UPLOAD_DIR };
