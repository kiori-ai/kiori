// The Kiori API (v1), the console and the docs, on one port. Kiori stores no brains and no chats: a brain comes in
// with a call and goes back out. What this server keeps is the accounts (projects, their keys, a sealed brain API key),
// how much each project used, and a note of each call that failed on this side (its status and code, never content).
// Every answer carries the usual protective headers and an X-Request-Id; the pages carry a Content-Security-Policy
// that lets only their own scripts run; the admin endpoints answer this origin only (no CORS).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config, adminKey, guardSecretFiles } from './config.mjs';
import { keyOf, createProject, listProjects, getProject, updateProject, publicProject, createKey, listKeys, revokeKey, usage, countCall, recordError, pruneErrors, resealAll } from './accounts.mjs';
import { readBrains, readBrain } from './brainfile.mjs';
import { createBrain } from './create.mjs';
import { recall } from './recall.mjs';
import { organize } from './organize.mjs';
import { checkReply } from './check.mjs';
import { exportObsidian } from './export.mjs';
import { zip } from './zip.mjs';
import { docsPage } from './docs.mjs';
import { num, trimSlashes } from './text.mjs';
import { brainKeyView, setBrainKey } from './providers.mjs';
import { chatCompletions, listModels } from './proxy.mjs';
import { openapi } from './openapi.mjs';
import { requestAccess, listRequests, approve, decline, signinLink, redeemSignin, pruneSignins } from './access.mjs';
import { csp } from './csp.mjs';
import { weeklyStats } from './stats.mjs';
import { allow, hit, retryAfter, clientIp, callerOf, securityNote } from './limits.mjs';
import { PARAMS, ARCHETYPES } from './personality.mjs';

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }
const fail = (status, message, code) => { throw new HttpError(status, message, code); };

// A page (a string) goes out with its Content-Security-Policy, made from its own scripts, and keeps no tie to a window
// another site opened it from
function send(res, status, body, headers = {}) {
    const isBuf = Buffer.isBuffer(body), page = typeof body === 'string';
    res.writeHead(status, { 'Content-Type': isBuf ? 'application/octet-stream' : page ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', ...(page && { 'Content-Security-Policy': csp(body), 'Cross-Origin-Opener-Policy': 'same-origin' }), ...headers });
    res.end(isBuf || page ? body : JSON.stringify(body));
}
// Calls that carry brains may be big (a group chat's brains); the rest are small. A body over the limit isn't kept: what
// is left of it is read and dropped, so the caller gets the 413 rather than a cut connection (which clients retry)
// A body's objects and lists are counted before it's parsed: JSON of many tiny ones ([{},{},…]) takes some forty times
// its size in memory once parsed, while brains, however big, hold far fewer
const MAX_CONTAINERS = 500000;
function containers(buf) {
    let n = 0;
    for (let i = 0, inString = false; i < buf.length; i++) {
        const c = buf[i];
        if (inString) { if (c === 92) i++; else if (c === 34) inString = false; }
        else if (c === 34) inString = true;
        else if (c === 123 || c === 91) n++;
    }
    return n;
}
async function readBody(req, max = 1e6) {
    let size = Number(req.headers['content-length']) || 0; const chunks = [];
    if (size <= max) {
        size = 0;
        for await (const c of req.iterator({ destroyOnReturn: false })) { size += c.length; if (size > max) break; chunks.push(c); }
    }
    if (size > max) { req.resume(); fail(413, `Body too large (at most ${Math.round(max / 1e6)} MB)`, 'TOO_LARGE'); }
    if (!chunks.length) return {};
    const buf = Buffer.concat(chunks);
    if (buf.length > 1e6 && containers(buf) > MAX_CONTAINERS) fail(413, `Body too large (at most ${MAX_CONTAINERS} objects and lists)`, 'TOO_LARGE');
    let body;
    try { body = JSON.parse(buf.toString('utf8')); } catch { fail(400, 'Body must be JSON', 'BAD_JSON'); }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) fail(400, 'Body must be a JSON object', 'BAD_JSON');
    return body;
}
const decode = s => { try { return decodeURIComponent(s); } catch { return fail(400, 'Bad URL encoding', 'BAD_REQUEST'); } };

// Routes: [method, pattern, handler(ctx)]; ctx = { project, params, body, query, res }
const routes = [];
// heavy: the call sets the model to work (see running). owner: it changes the project, so it takes an owner key
const route = (method, pattern, handler, { admin = false, open = false, owner = false, maxBody = 1e6, heavy = false } = {}) => {
    const keys = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, pattern, re, keys, handler, admin, open, owner, maxBody, heavy });
};
const BRAINS = { maxBody: 24e6 };

// ---------- Admin ----------
route('GET', '/v1/admin/projects', () => listProjects().map(publicProject), { admin: true });
// Asking for access (the site's form; no key needed): a few per address an hour, a few hundred a day in all
route('POST', '/v1/access', ctx => {
    if (!allow(`access:${ctx.ip}`, 5, 3600000)) fail(429, 'Too many requests for access from here: try again later', 'RATE_LIMITED');
    return requestAccess(ctx.body, ctx.ip, () => allow('access:all', 300, 86400000));
}, { open: true });
// The admin answers them; approving makes the customer's project and a sign-in link to send them
route('GET', '/v1/admin/access', () => listRequests(), { admin: true });
route('POST', '/v1/admin/access/:id/approve', ({ params }) => approve(params.id), { admin: true });
route('POST', '/v1/admin/access/:id/decline', ({ params }) => decline(params.id), { admin: true });
// How Kiori is used, week by week: customers' projects, or everyone's with ?scope=all (see stats.mjs)
route('GET', '/v1/admin/stats', ({ query }) => weeklyStats({ weeks: num(query.get('weeks'), 12, 1, 104), everyone: query.get('scope') === 'all' }), { admin: true });
// A project made by the admin is a customer's: it runs on their own brain API key unless llm_mode says "server"
route('POST', '/v1/admin/projects', ({ body }) => { const r = createProject(body.name ?? 'Untitled', body.settings ?? {}, { llmMode: body.llm_mode ?? 'own' }); return { ...r, project: publicProject(r.project) }; }, { admin: true });
// A new sign-in link for a project (one use, 7 days), e.g. when the first one ran out
route('POST', '/v1/admin/projects/:id/signin', ({ params }) => signinLink(params.id), { admin: true });
// Signing in with a link: its one-time token traded for a Kiori key of this browser's own (see access.mjs)
route('POST', '/v1/signin', ctx => {
    if (!allow(`signin:${ctx.ip}`, 30, 3600000)) fail(429, 'Too many sign-ins from here: try again later', 'RATE_LIMITED');
    const signed = redeemSignin(ctx.body.token);
    if (!signed) { securityNote('a sign-in link that was used, ran out or never was', ctx.res.kiori.rid); fail(401, 'This sign-in link was already used or has expired: ask for a new one', 'LINK_EXPIRED'); }
    return signed;
}, { open: true });

// ---------- Project ----------
// The brain API key is never shown back, only its last four characters
const projectView = async project => ({ ...publicProject(getProject(project)), llm: await brainKeyView(project, { withModels: false }), keys: listKeys(project) });
route('GET', '/v1/project', ({ project }) => projectView(project));
// name, and llm: { key } (the provider is recognized from the key, and the key checked), { model }, or null
route('PATCH', '/v1/project', async ({ project, body }) => {
    if (body.name != null) updateProject(project, { name: body.name });
    if ('llm' in body) await setBrainKey(project, body.llm);
    return projectView(project);
}, { owner: true });
// The models your brain API key can use, the suggested one first
route('GET', '/v1/project/models', ({ project }) => brainKeyView(project));
route('POST', '/v1/project/keys', ({ project, body }) => ({ key: createKey(project, body.label ?? null) }), { owner: true });
route('DELETE', '/v1/project/keys/:prefix', ({ project, params }) => ({ revoked: revokeKey(project, params.prefix) }), { owner: true });
route('GET', '/v1/usage', ({ project, query }) => usage(project, num(query.get('days'), 30, 1, 3650)));
route('GET', '/v1/personality', () => ({ params: PARAMS.map(({ id, name, group, low, high }) => ({ id, name, group, low, high })), archetypes: ARCHETYPES.map(({ id, name, description }) => ({ id, name, description })) }), { open: true });

// ---------- Brains ----------
// A new brain from a character card (or name and description), for you to keep
route('POST', '/v1/brains', async ({ project, body }) => ({ brain: await createBrain(project, body) }), { maxBody: 12e6, heavy: true });
// What each character knows right now, for your prompt
route('POST', '/v1/brains/recall', ({ project, body }) => recall(project, readBrains(body).brains, body), BRAINS);
// After the chat moved on: the brains learn what's new and settled (and unlearn what was edited away)
route('POST', '/v1/brains/organize', ({ project, body }) => { const { brains, single } = readBrains(body); return organize(project, brains, single, body); }, { ...BRAINS, heavy: true });
// Before a reply is shown: leaks and invented pasts flagged and fixed
route('POST', '/v1/brains/check', ({ project, body }) => checkReply(project, readBrains(body).brains, body), { ...BRAINS, heavy: true });
// A brain as an Obsidian vault (zip)
route('POST', '/v1/brains/export', ctx => {
    const z = exportObsidian(readBrain(ctx.body.brain));
    send(ctx.res, 200, z.data, { 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(z.filename)}` });
}, BRAINS);

// ---------- The drop-in ----------
// An OpenAI-compatible chat endpoint in front of your own model, with the brains in the body (see proxy.mjs)
route('POST', '/v1/chat/completions', ctx => chatCompletions(ctx), { ...BRAINS, heavy: true });
route('GET', '/v1/models', ctx => listModels(ctx), { heavy: true });

// Calls that set the model to work can take a minute: a project may have config.maxAtOnce of them running at once
// (KIORI_MAX_AT_ONCE), so a runaway loop, or someone with a leaked Kiori key, can't run up a customer's bill all at once
const running = new Map();

// ---------- Static: console and docs ----------
async function handle(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { return send(res, 400, { error: { message: 'Bad URL', code: 'BAD_REQUEST', request_id: res.kiori.rid } }); }
    const p = trimSlashes(url.pathname) || '/';
    // Any site may call the API with a key (browser apps, the SillyTavern extension); the admin endpoints only this one
    if (!p.startsWith('/v1/admin/')) {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Kiori-Player, X-Kiori-Check, X-Kiori-Upstream-Url, X-Kiori-Upstream-Key');
        res.setHeader('Access-Control-Expose-Headers', 'X-Kiori-Check, X-Request-Id, Retry-After');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Max-Age', '600');
    }
    if (req.method === 'OPTIONS') return send(res, 204, Buffer.alloc(0));
    // What the API answers is for whoever asked, not for a cache along the way
    if (p.startsWith('/v1/')) res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'GET' && p === '/') return send(res, 200, fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8'));
    if (req.method === 'GET' && p === '/console') return send(res, 200, fs.readFileSync(path.join(ROOT, 'console', 'index.html'), 'utf8'));
    // The site's own files (the demo brain, images); nothing outside site/. The icons also answer at the paths browsers
    // and crawlers try on their own.
    const asset = p === '/favicon.ico' || p === '/apple-touch-icon.png' ? `/site/img${p}` : p;
    if (req.method === 'GET' && asset.startsWith('/site/')) {
        const file = path.resolve(ROOT, 'site', decode(asset.slice(6)));
        // Pictures only: a file of another kind that ends up in site/ (an SVG can carry a script) is never served from
        // this address, which is the console's too
        const type = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' }[path.extname(file).toLowerCase()];
        if (!type || !file.startsWith(path.join(ROOT, 'site') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found');
        // shown on this site's own pages only: other sites can't put them in theirs, and image search leaves them out
        return send(res, 200, fs.readFileSync(file), { 'Content-Type': type, 'Cache-Control': 'public, max-age=300', 'Cross-Origin-Resource-Policy': 'same-site', 'X-Robots-Tag': 'noindex' });
    }
    if (req.method === 'GET' && (p === '/docs' || p.startsWith('/docs/'))) {
        const page = docsPage(p === '/docs' ? 'overview' : decode(p.slice(6)));
        return page ? send(res, 200, page) : send(res, 404, 'Not found');
    }
    if (p === '/health') return send(res, 200, { ok: true, name: 'kiori', version: VERSION });
    // The SDKs, and the SillyTavern extension as a zip (unzipped into SillyTavern's extensions folder, it's a folder "kiori")
    if (req.method === 'GET' && /^\/sdk\/kiori\.(mjs|py|d\.ts)$/.test(p)) return send(res, 200, fs.readFileSync(path.join(ROOT, p)), { 'Content-Type': `${p.endsWith('.mjs') ? 'text/javascript' : 'text/plain'}; charset=utf-8`, 'Cache-Control': 'public, max-age=300' });
    if (req.method === 'GET' && p === '/sillytavern.zip') return send(res, 200, sillytavernZip(), { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="kiori-sillytavern.zip"' });
    if (req.method === 'GET' && p === '/openapi.json') return send(res, 200, openapi);
    for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = p.match(r.re);
        if (!m) continue;
        // What a failed call is noted under (see noteError)
        res.kiori.route = `${r.method} ${r.pattern}`;
        const ctx = { params: Object.fromEntries(r.keys.map((k, i) => [k, decode(m[i + 1])])), query: url.searchParams, headers: req.headers, ip: callerOf(clientIp(req)), req, res };
        // Rate limits: wrong keys from one address, each project's calls, and calls without a key. When a limit on wrong
        // keys trips, the log says so once per window
        const limited = (key, max, ms, note) => {
            const n = hit(key, ms);
            if (n <= max) return;
            if (note && n === max + 1) securityNote(note, res.kiori.rid);
            res.setHeader('Retry-After', String(retryAfter(key)));
            fail(429, 'Too many requests: slow down and try again shortly', 'RATE_LIMITED');
        };
        if (r.admin) {
            if (!adminKey() || !sameSecret(req.headers['x-admin-key'], adminKey())) {
                securityNote(req.headers['x-admin-key'] ? 'a wrong admin key' : 'an admin endpoint without the admin key', res.kiori.rid);
                limited(`adminfail:${ctx.ip}`, 20, 3600000, 'too many wrong admin keys from one address');
                fail(401, 'Admin key required', 'UNAUTHORIZED');
            }
        } else if (!r.open) {
            const key = keyOf(req.headers.authorization);
            ctx.project = key?.project;
            if (!ctx.project) { limited(`authfail:${ctx.ip}`, 60, 60000, 'too many wrong Kiori keys from one address'); fail(401, 'A valid API key is required: Authorization: Bearer kio_...', 'UNAUTHORIZED'); }
            // The keys an app uses do everything but change the project: a leaked one can't send the project's calls to
            // another address, or take its keys away
            if (r.owner && !key.owner) fail(403, "This key can use the project but not change it: sign in to the console with your link to change its settings or keys", 'FORBIDDEN');
            res.kiori.project = ctx.project;
            limited(`project:${ctx.project}`, 1200, 60000);
            countCall(ctx.project, `${r.method} ${r.pattern}`);
        } else limited(`open:${ctx.ip}`, 120, 60000);
        if (r.heavy) {
            const n = running.get(ctx.project) ?? 0;
            if (n >= config.maxAtOnce) { res.setHeader('Retry-After', '5'); fail(429, `This project already has ${config.maxAtOnce} calls at work: wait for some to finish`, 'RATE_LIMITED'); }
            running.set(ctx.project, n + 1);
        }
        try {
            ctx.body = ['POST', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req, r.maxBody) : {};
            const out = await r.handler(ctx);
            if (!res.headersSent) send(res, 200, out ?? {});
        } finally {
            if (r.heavy) { const n = running.get(ctx.project) - 1; if (n > 0) running.set(ctx.project, n); else running.delete(ctx.project); }
        }
        return;
    }
    fail(404, `No route ${req.method} ${p}`, 'NOT_FOUND');
}

const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
// The extension's own files, named: anything else that ends up in the folder stays out of the zip
const EXTENSION_FILES = ['manifest.json', 'index.js', 'style.css', 'README.md', 'LICENSE'];
export const sillytavernZip = () => zip(EXTENSION_FILES.map(f => ({ name: `kiori/${f}`, data: fs.readFileSync(path.join(ROOT, 'sillytavern', f)) })));
// Compared in constant time, so the key can't be guessed from how long a wrong one takes
const sameSecret = (given, key) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(given ?? '')).digest(), crypto.createHash('sha256').update(key).digest());
const STATUS_OF = { CREDITS: 402, NEEDS_KEY: 402, BAD_KEY: 402, NO_KEY: 503, PROVIDER: 502, INCOMPLETE: 502 };

// A 5xx is noted, to find out later what went wrong (kiori errors lists them): a line in the log and a row in the
// database, with the endpoint, the status, its code and the model provider's status. Never what was said. Outside a
// route, the path stands for the endpoint (without its query, and nothing parsed: noting must never fail).
function noteError(req, res) {
    try {
        const { route = `${req.method} ${String(req.url).split('?')[0].slice(0, 200)}`, project = null, code = null, upstream = null, rid = null } = res.kiori ?? {};
        console.error(`${new Date().toISOString()}  ${res.statusCode} ${route}${code ? `  ${code}` : ''}${upstream ? ` (provider ${upstream})` : ''}${rid ? `  [${rid}]` : ''}`);
        recordError({ project, route, status: res.statusCode, code, upstream });
    } catch (e) { console.error('Kiori: could not note the error:', e.message); }
}

export function startServer(port = config.port, host = config.host) {
    // Before anything is served: the files with secrets closed to others, and the keys kept from before sealed the
    // current way (bound to their project, with the newest secret)
    const closed = guardSecretFiles();
    if (closed.length) console.warn(`Kiori: ${closed.join(', ')} could be read by others; now only by their owner`);
    if (config.secret && config.secret.split(/[\s,]+/)[0].length < 32) console.warn('Kiori: KIORI_SECRET is short. Use a long random value (32 characters or more, e.g. from openssl rand -base64 32)');
    if (config.proxyAllowLocal && /^https:/.test(config.publicUrl)) console.warn(`Kiori: KIORI_PROXY_ALLOW_LOCAL=1 on a server customers reach at ${config.publicUrl}: their provider addresses may point into this machine and its network. Turn it off unless this Kiori is yours alone.`);
    const kept = resealAll();
    if (kept.sealed) console.log(`Kiori: ${kept.sealed} kept key${kept.sealed === 1 ? '' : 's'} sealed the current way`);
    if (kept.unopened) console.warn(`Kiori: ${kept.unopened} kept key${kept.unopened === 1 ? '' : 's'} can't be opened with this server's secret (KIORI_SECRET or data/local/secret.key)`);
    const server = http.createServer((req, res) => {
        res.kiori = { rid: crypto.randomBytes(6).toString('hex') };
        res.setHeader('X-Request-Id', res.kiori.rid);
        res.on('finish', () => { if (res.statusCode >= 500) noteError(req, res); });
        handle(req, res).catch(e => {
            const status = e.status ?? STATUS_OF[e.code] ?? 500;
            // An unexpected error is a bug: its stack goes to the log, and the caller gets no more than that it happened
            if (status === 500) console.error(`[${res.kiori.rid}]`, e);
            res.kiori = { ...res.kiori, code: e.code ?? 'ERROR', upstream: e.upstream ?? null };
            if (!res.headersSent) send(res, status, { error: { message: status === 500 ? 'Something went wrong on our side' : e.message, code: e.code ?? 'ERROR', request_id: res.kiori.rid } });
        });
    });
    // A request has 30 seconds to send its headers and 2 minutes to arrive whole (the answer may take longer)
    server.headersTimeout = 30000;
    server.requestTimeout = 120000;
    server.listen(port, host, () => console.log(`Kiori is running: http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${server.address().port}  (console /console, docs /docs)`));
    // Failed-call notes older than 30 days go, and sign-in links past their date, now and once a day
    const prune = () => { pruneErrors(); pruneSignins(); };
    prune();
    const daily = setInterval(prune, 864e5);
    daily.unref();
    server.on('close', () => clearInterval(daily));
    return server;
}
