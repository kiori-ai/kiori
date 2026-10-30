// Asking for access, and signing in. On the site someone leaves their email and what they're building; the admin
// approves in the console, which makes their project (running on their own model key) and a sign-in link to send them.
//
// A sign-in link holds no key: it holds a one-time token (kis_...), good for 7 days, kept here only as a hash. Opening
// it, the console trades the token for a Kiori key of its own (POST /v1/signin), and the token is gone. A link that
// leaks from a mailbox later opens nothing.
import crypto from 'node:crypto';
import { one, all, run, now } from './db.mjs';
import { newId, sha } from './text.mjs';
import { config } from './config.mjs';
import { createProject, publicProject, createKey, revokeKey, keyCount, getProject, MAX_KEYS } from './accounts.mjs';

const fail = (status, message, code) => { throw Object.assign(new Error(message), { status, code }); };
const str = (v, max) => String(v ?? '').trim().slice(0, max);
// Where customers reach this Kiori: KIORI_PUBLIC_URL, or this machine
export const publicUrl = () => config.publicUrl || `http://127.0.0.1:${config.port}`;

// room() says whether there is room for one more request today; it's asked only for one that will be kept, so
// requests that are turned away (a bad email, a bot, one already waiting) never use up the day for real ones
export function requestAccess(body, ip, room = () => true) {
    // "website" is a field people never see: a bot filled it in
    if (str(body.website, 200)) return { ok: true };
    const email = str(body.email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) fail(400, 'A valid email is required', 'BAD_REQUEST');
    if (!one("SELECT id FROM access_requests WHERE email = ? AND status = 'pending'", email)) {
        if (!room()) fail(429, 'Too many requests for access today: try again tomorrow', 'RATE_LIMITED');
        run('INSERT INTO access_requests (id, email, name, company, use_case, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            newId('acc'), email, str(body.name, 120), str(body.company, 160), str(body.use_case, 2000), ip ?? null, now());
    }
    return { ok: true };
}

export const listRequests = () => all("SELECT id, email, name, company, use_case, status, project_id, created_at, decided_at FROM access_requests ORDER BY status = 'pending' DESC, created_at DESC LIMIT 500");

// A link that signs someone in to a project's console once, within `days`
export function signinLink(projectId, days = 7) {
    if (!getProject(projectId)) fail(404, 'No such project', 'NOT_FOUND');
    pruneSignins();
    // A new link takes the place of the project's earlier ones: a link sent to the wrong address is undone by making another
    run('DELETE FROM signins WHERE project_id = ?', projectId);
    const token = `kis_${crypto.randomBytes(24).toString('base64url')}`;
    const expires = new Date(Date.now() + days * 864e5).toISOString();
    run('INSERT INTO signins (hash, project_id, created_at, expires_at) VALUES (?, ?, ?, ?)', sha(token), projectId, now(), expires);
    return { link: `${publicUrl()}/console#signin=${token}`, expires_at: expires };
}
// The token traded for a new Kiori key, once: whoever deletes the row first gets the key. A project already at the
// most keys it may have trades its oldest console key for the new one (signing in never runs into the limit; with no
// console key to trade, the link is left unused and the call says so)
export function redeemSignin(token) {
    const t = String(token ?? '');
    if (!/^kis_[\w-]{20,64}$/.test(t)) return null;
    const row = one('SELECT project_id, expires_at FROM signins WHERE hash = ?', sha(t));
    if (!row || row.expires_at < now()) return null;
    const project = getProject(row.project_id);
    if (!project) return null;
    const full = keyCount(project.id) >= MAX_KEYS;
    const oldest = full ? one("SELECT prefix FROM api_keys WHERE project_id = ? AND label = 'console' ORDER BY created_at LIMIT 1", project.id) : null;
    if (full && !oldest) fail(409, `This project has ${MAX_KEYS} keys: revoke one in the console of a browser that's signed in, then use the link`, 'CONFLICT');
    if (run('DELETE FROM signins WHERE hash = ?', sha(t)).changes !== 1) return null;
    if (oldest) revokeKey(project.id, oldest.prefix);
    return { key: createKey(project.id, 'console', { owner: true }), project: { id: project.id, name: project.name } };
}
export const pruneSignins = () => run('DELETE FROM signins WHERE expires_at < ?', now());

// A project of their own (on their own model key) and a link that signs them in to the console, where they make
// their keys. No key is made here: none travels by email.
export function approve(id) {
    const r = one('SELECT * FROM access_requests WHERE id = ?', id) ?? fail(404, 'No such request', 'NOT_FOUND');
    if (r.status === 'approved') fail(409, 'This request was already approved', 'CONFLICT');
    const { project } = createProject(r.company || r.name || r.email, { contact: r.email }, { llmMode: 'own', firstKey: false });
    run("UPDATE access_requests SET status = 'approved', project_id = ?, decided_at = ? WHERE id = ?", project.id, now(), id);
    return { email: r.email, name: r.name, project: publicProject(project), ...signinLink(project.id) };
}

export function decline(id) {
    const r = one('SELECT * FROM access_requests WHERE id = ?', id) ?? fail(404, 'No such request', 'NOT_FOUND');
    if (r.status !== 'pending') fail(409, `This request was already ${r.status}`, 'CONFLICT');
    run("UPDATE access_requests SET status = 'declined', decided_at = ? WHERE id = ?", now(), id);
    return { declined: true };
}
