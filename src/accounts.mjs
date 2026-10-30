// Projects (one customer workspace each), their API keys and their usage. Keys are stored hashed; the model provider
// keys a project hands Kiori are kept sealed (secrets.mjs), each bound to its project and setting.
import crypto from 'node:crypto';
import { one, all, run, now, json, tx } from './db.mjs';
import { newId, sha } from './text.mjs';
import { seal, unseal, masked, bindOf, isCurrent } from './secrets.mjs';
import { providerUrl } from './llm.mjs';

const isObject = v => v != null && typeof v === 'object' && !Array.isArray(v);
const bad = message => Object.assign(new Error(message), { status: 400, code: 'BAD_REQUEST' });

// llmMode: 'server' (this Kiori's own model key pays) or 'own' (the customer's key, in settings.llm). firstKey: false
// for a project whose people sign in with a link and make their own keys (an approved access request)
export function createProject(name, settings = {}, { llmMode = 'server', firstKey = true } = {}) {
    if (!isObject(settings)) throw bad('settings must be an object');
    if (!['server', 'own'].includes(llmMode)) throw bad('llm_mode is "server" or "own"');
    const id = newId('prj');
    run('INSERT INTO projects (id, name, settings, llm_mode, created_at) VALUES (?, ?, ?, ?, ?)', id, String(name ?? '').trim().slice(0, 120) || 'Untitled', '{}', llmMode, now());
    if (Object.keys(settings).length) updateProject(id, { settings });
    return { project: getProject(id), key: firstKey ? createKey(id, 'default') : null };
}
export function getProject(id) {
    const p = one('SELECT * FROM projects WHERE id = ?', id);
    return p && { id: p.id, name: p.name, llm_mode: p.llm_mode ?? 'server', settings: json(p.settings, {}), created_at: p.created_at };
}
export const listProjects = () => all('SELECT id FROM projects ORDER BY created_at').map(p => getProject(p.id));

// The provider parts of the settings: llm (the brain API key Kiori's own calls use, see providers.mjs) and upstream
// (where the drop-in chat endpoint passes requests on to, when that's another provider). Their keys are kept sealed;
// a part sent without "key" keeps the key it had, and "key": null or "" removes it. A key belongs to the address it was
// saved with: changing the address without sending the key again drops the key (it never goes somewhere new on its own).
const PROVIDER_PARTS = { llm: ['provider', 'base_url', 'model', 'organizer', 'auditor', 'embed'], upstream: ['url'] };
const ADDRESS = { llm: 'base_url', upstream: 'url' };
function providerPart(project, name, prev = {}, patch) {
    if (patch === null) return undefined;
    if (!isObject(patch)) throw bad(`settings.${name} must be an object`);
    const out = { ...prev };
    for (const f of PROVIDER_PARTS[name]) if (f in patch) out[f] = patch[f] == null || patch[f] === '' ? undefined : String(patch[f]).trim().slice(0, 300);
    if (out[ADDRESS[name]]) out[ADDRESS[name]] = providerUrl(out[ADDRESS[name]]);
    const bind = bindOf(project, name);
    if ('key' in patch) out.key_sealed = patch.key ? seal(String(patch.key).replace(/^Bearer\s+/i, '').trim(), bind) : undefined;
    else if ((out[ADDRESS[name]] ?? null) !== (prev[ADDRESS[name]] ?? null)) out.key_sealed = undefined;
    else if (prev.key && !prev.key_sealed) out.key_sealed = seal(prev.key, bind);
    delete out.key;
    return JSON.parse(JSON.stringify(out));
}
export function updateProject(id, { name, settings } = {}) {
    const p = getProject(id);
    if (!p) return null;
    if (settings != null && !isObject(settings)) throw bad('settings must be an object');
    const next = { ...p.settings, ...(settings ?? {}) };
    for (const part of Object.keys(PROVIDER_PARTS)) if (settings && part in settings) next[part] = providerPart(id, part, p.settings[part], settings[part]);
    run('UPDATE projects SET name = ?, settings = ? WHERE id = ?', String(name ?? '').trim().slice(0, 120) || p.name, JSON.stringify(next), id);
    return getProject(id);
}
// A project as it is shown: provider keys only as their last four characters
export function publicProject(p) {
    if (!p) return p;
    const show = (part, name) => part && { ...Object.fromEntries(Object.entries(part).filter(([k]) => k !== 'key_sealed' && k !== 'key')), key: masked(part.key_sealed ?? part.key, bindOf(p.id, name)), key_set: Boolean(part.key_sealed ?? part.key) };
    return { ...p, settings: { ...p.settings, ...(p.settings.llm && { llm: show(p.settings.llm, 'llm') }), ...(p.settings.upstream && { upstream: show(p.settings.upstream, 'upstream') }) } };
}
// A project's kept key for one of its provider parts, opened (only for the call that uses it)
export const keptKey = (project, part) => { const s = getProject(project)?.settings?.[part]; return s ? unseal(s.key_sealed ?? s.key, bindOf(project, part)) : ''; };

// Every kept key sealed the current way: bound to its project and setting, with the newest secret. The server runs
// this when it starts (keys from before are sealed again), and kiori rotate-secret with all: true (every key moves to
// the new secret). A key no secret here opens is left as it is. Returns { sealed, unopened }.
export function resealAll({ all: every = false } = {}) {
    let sealed = 0, unopened = 0;
    tx(() => {
        for (const row of all('SELECT id, settings FROM projects')) {
            const s = json(row.settings, {});
            let changed = false;
            for (const part of Object.keys(PROVIDER_PARTS)) {
                const p = s[part], raw = isObject(p) ? p.key_sealed ?? p.key : null;
                if (!raw || (!every && isCurrent(raw))) continue;
                const plain = unseal(raw, bindOf(row.id, part));
                if (!plain) { unopened++; continue; }
                p.key_sealed = seal(plain, bindOf(row.id, part));
                delete p.key;
                changed = true; sealed++;
            }
            if (changed) run('UPDATE projects SET settings = ? WHERE id = ?', JSON.stringify(s), row.id);
        }
    });
    return { sealed, unopened };
}

// A project has at most MAX_KEYS keys at once: revoke one to make another. A label is text, kept to 100 characters.
export const MAX_KEYS = 100;
export const keyCount = projectId => one('SELECT COUNT(*) AS n FROM api_keys WHERE project_id = ?', projectId).n;
// owner: a key that may change the project (made only by signing in with a link: see access.mjs)
export function createKey(projectId, label = null, { owner = false } = {}) {
    if (label != null && typeof label !== 'string') throw bad('label must be text');
    if (keyCount(projectId) >= MAX_KEYS) throw Object.assign(new Error(`A project has at most ${MAX_KEYS} keys: revoke one first`), { status: 409, code: 'CONFLICT' });
    const key = `kio_${crypto.randomBytes(24).toString('base64url')}`;
    run('INSERT INTO api_keys (hash, project_id, prefix, label, created_at, owner) VALUES (?, ?, ?, ?, ?, ?)', sha(key), projectId, key.slice(0, 10), label?.trim().slice(0, 100) || null, now(), owner ? 1 : 0);
    return key;
}
export const listKeys = projectId => all('SELECT prefix, label, created_at, last_used FROM api_keys WHERE project_id = ? ORDER BY created_at', projectId);
export function revokeKey(projectId, prefix) {
    return run('DELETE FROM api_keys WHERE project_id = ? AND prefix = ?', projectId, prefix).changes > 0;
}
// The project a key is for, and whether it's an owner key (one that may change the project); null for no key
export function keyOf(header) {
    const key = String(header ?? '').replace(/^Bearer\s+/i, '').trim();
    // kio_ keys, and psy_ keys made before the rename
    if (!/^(kio|psy)_/.test(key)) return null;
    const hash = sha(key);
    const row = one('SELECT project_id, last_used, owner FROM api_keys WHERE hash = ?', hash);
    if (!row) return null;
    // last_used is kept to the minute: not a write on every request
    const t = now();
    if (row.last_used?.slice(0, 16) !== t.slice(0, 16)) run('UPDATE api_keys SET last_used = ? WHERE hash = ?', t, hash);
    return { project: row.project_id, owner: row.owner === 1 };
}
export const authenticate = header => keyOf(header)?.project ?? null;

// What a project used: its API calls by endpoint, and the model calls Kiori made on its key (what for, tokens, cost).
// Counts and costs only: nothing that was said is kept.
export function usage(projectId, days = 30) {
    const since = new Date(Date.now() - days * 864e5).toISOString();
    const byOp = all(`SELECT op, COUNT(*) calls, SUM(prompt_tokens) prompt_tokens, SUM(completion_tokens) completion_tokens, ROUND(SUM(cost), 5) cost
        FROM usage WHERE project_id = ? AND at >= ? GROUP BY op ORDER BY cost DESC`, projectId, since);
    const byDay = all(`SELECT substr(at, 1, 10) day, COUNT(*) calls, ROUND(SUM(cost), 5) cost FROM usage WHERE project_id = ? AND at >= ? GROUP BY day ORDER BY day`, projectId, since);
    const totals = one(`SELECT COUNT(*) calls, ROUND(COALESCE(SUM(cost), 0), 5) cost FROM usage WHERE project_id = ? AND at >= ?`, projectId, since);
    const requests = all('SELECT route, SUM(n) calls FROM calls WHERE project_id = ? AND day >= ? GROUP BY route ORDER BY calls DESC', projectId, since.slice(0, 10));
    return { days, requests, model: { totals, by_op: byOp, by_day: byDay } };
}

// One API call counted, per project, day and endpoint
export const countCall = (projectId, route) => run('INSERT INTO calls (project_id, day, route, n) VALUES (?, ?, ?, 1) ON CONFLICT(project_id, day, route) DO UPDATE SET n = n + 1', projectId, now().slice(0, 10), route);

// A call that failed on this side (a 5xx), to see later what went wrong: when, which project and endpoint, the status
// and its code, and the model provider's status when the failure was theirs. Never what was said. Kept 30 days.
export function recordError({ project = null, route, status, code = null, upstream = null }) {
    run('INSERT INTO errors (at, project_id, route, status, code, upstream) VALUES (?, ?, ?, ?, ?, ?)', now(), project, route, status, code, upstream);
    pruneErrors();
}
// The server also runs this when it starts and once a day, so notes go after 30 days even when nothing fails
export const pruneErrors = () => run('DELETE FROM errors WHERE at < ?', new Date(Date.now() - 30 * 864e5).toISOString());
export const recentErrors = (days = 7) => all('SELECT at, project_id, route, status, code, upstream FROM errors WHERE at >= ? ORDER BY at DESC', new Date(Date.now() - days * 864e5).toISOString());
