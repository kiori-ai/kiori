// Storage: one SQLite file, for the accounts only. Kiori stores no brains and no chats (they live with the customer
// and come with each call); what is here is who may call (projects and their API keys, a sealed brain API key in the
// settings, sign-in links not used yet, as hashes), who asked for access, how much each project used (counts and
// costs, never content), and which calls failed on this side (when, the endpoint, the status and its code, never
// content; kept 30 days).
// A database from before brains moved out still has its old tables; nothing reads them (kiori export-old can turn
// them into brain files).
import { DatabaseSync } from 'node:sqlite';
import { dbPath } from './config.mjs';

export const db = new DatabaseSync(dbPath);
// busy_timeout: the command line (kiori project, key) can write while the server runs
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS api_keys (
    hash TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    prefix TEXT NOT NULL, label TEXT, created_at TEXT NOT NULL, last_used TEXT
);
CREATE TABLE IF NOT EXISTS access_requests (
    id TEXT PRIMARY KEY, email TEXT NOT NULL, name TEXT, company TEXT, use_case TEXT,
    status TEXT NOT NULL DEFAULT 'pending', project_id TEXT, ip TEXT, created_at TEXT NOT NULL, decided_at TEXT
);
CREATE TABLE IF NOT EXISTS usage (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT, at TEXT NOT NULL, op TEXT NOT NULL, model TEXT,
    prompt_tokens INTEGER, completion_tokens INTEGER, cost REAL
);
CREATE INDEX IF NOT EXISTS usage_by_project ON usage(project_id, at);
CREATE TABLE IF NOT EXISTS calls (
    project_id TEXT NOT NULL, day TEXT NOT NULL, route TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, day, route)
);
CREATE TABLE IF NOT EXISTS errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, project_id TEXT, route TEXT NOT NULL,
    status INTEGER NOT NULL, code TEXT, upstream INTEGER
);
CREATE INDEX IF NOT EXISTS errors_by_time ON errors(at);
CREATE TABLE IF NOT EXISTS signins (
    hash TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);
`);

// Columns added after v1.0 (safe to run on an existing file), each with what's done once when it's added.
// llm_mode: whose model key pays for this project's model calls: 'server' (this Kiori's own key) or 'own' (the customer's)
// owner: 1 for a key the console made when someone signed in with a link; only such a key changes the project (its
// brain API key, provider address, Kiori keys). Keys from before that say "console" were made that way.
for (const [table, col, def, then] of [['projects', 'llm_mode', "TEXT NOT NULL DEFAULT 'server'"],
    ['api_keys', 'owner', 'INTEGER NOT NULL DEFAULT 0', "UPDATE api_keys SET owner = 1 WHERE label = 'console'"]]) {
    if (db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    if (then) db.exec(then);
}

export const now = () => new Date().toISOString();
export const json = (s, fallback) => { try { return s == null ? fallback : JSON.parse(s); } catch { return fallback; } };
export const one = (sql, ...args) => db.prepare(sql).get(...args);
export const all = (sql, ...args) => db.prepare(sql).all(...args);
export const run = (sql, ...args) => db.prepare(sql).run(...args);

// Several writes as one: all or nothing
export function tx(fn) {
    db.exec('BEGIN');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}
