// Configuration: the project's .env, then the environment. Settings are KIORI_* (the older PSYCHE_* names still
// work).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Whatever Kiori writes (the database and its -wal and -shm, secret.key, admin.key, backups, brain files) is readable by
// its owner only
process.umask(0o077);

function readEnv(file) {
    if (!fs.existsSync(file)) return {};
    const out = {};
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
        if (m && !line.trim().startsWith('#')) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return out;
}

const own = readEnv(path.join(ROOT, '.env'));
const env = { ...own, ...process.env };
const get = (name, fallback) => (env[name] !== undefined && env[name] !== '' ? env[name] : fallback);
const opt = (name, fallback) => get(`KIORI_${name}`, get(`PSYCHE_${name}`, fallback));

export const config = {
    port: Number(get('PORT', opt('PORT', 7700))),
    // 127.0.0.1 keeps it on this machine; 0.0.0.0 for a container or behind a reverse proxy on another host
    host: opt('HOST', '127.0.0.1'),
    dataDir: path.resolve(ROOT, opt('DATA', 'data/local')),
    llm: {
        baseUrl: opt('LLM_BASE_URL', 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
        key: opt('LLM_KEY', ''),
        organizer: opt('ORGANIZER_MODEL', 'anthropic/claude-haiku-5.5'),
        auditor: opt('AUDITOR_MODEL', 'anthropic/claude-haiku-5.5'),
        // Used for the last attempt when the main model refuses or keeps answering badly
        fallback: opt('FALLBACK_MODEL', 'deepseek/deepseek-v4.1-flash'),
        embed: opt('EMBED_MODEL', 'openai/text-embedding-3-small'),
        embedOn: opt('EMBED', '1') !== '0',
        providerSort: opt('PROVIDER_SORT', 'throughput'),
    },
    // The drop-in chat endpoint passes requests on to the customer's model: only https addresses on the internet,
    // unless this is set (a model running on this machine or the local network)
    proxyAllowLocal: opt('PROXY_ALLOW_LOCAL', '0') === '1',
    // Where customers reach this Kiori (sign-in links point here), e.g. https://api.kiori.io
    publicUrl: opt('PUBLIC_URL', '').replace(/\/+$/, ''),
    // "cloudflare" when Cloudflare's tunnel is the proxy on this machine: its CF-Connecting-IP header then names the
    // caller. Any other proxy is read from X-Forwarded-For (see clientIp in limits.mjs)
    trustProxy: opt('TRUST_PROXY', '').toLowerCase(),
    // Seals customers' provider keys in the database (default: a random key kept in data/local/secret.key)
    secret: opt('SECRET', ''),
    // Organizing waits until this many settled messages are new (a request can say otherwise), so a call after every
    // reply costs nothing most of the time
    learnEvery: Number(opt('LEARN_EVERY', 12)),
    // ...and leaves the newest few for later: they're the ones still being rerolled or edited
    learnHold: Number(opt('LEARN_HOLD', 4)),
    adminKey: opt('ADMIN_KEY', ''),
    // Calls that set the model to work (building, learning, checking, the drop-in) one project may have running at once
    maxAtOnce: Math.max(1, Number(opt('MAX_AT_ONCE', 64)) || 64),
};

fs.mkdirSync(config.dataDir, { recursive: true });
// Installs from before the rename keep their psyche.db
const oldDb = path.join(config.dataDir, 'psyche.db'), newDb = path.join(config.dataDir, 'kiori.db');
export const dbPath = fs.existsSync(oldDb) && !fs.existsSync(newDb) ? oldDb : newDb;

// The admin key lives in the data folder when it isn't set in the environment
const adminFile = path.join(config.dataDir, 'admin.key');
export function adminKey() {
    if (config.adminKey) return config.adminKey;
    return fs.existsSync(adminFile) ? fs.readFileSync(adminFile, 'utf8').trim() : '';
}
export function setAdminKey(key) {
    fs.writeFileSync(adminFile, key + '\n', { mode: 0o600 });
}
// The data folder and what in it holds secrets or accounts readable by their owner only (a file made before, or copied
// in, may be open to others). Returns the ones it had to close.
export function guardSecretFiles() {
    const closed = [];
    const close = (file, mode) => { try { if (fs.existsSync(file) && (fs.statSync(file).mode & 0o077)) { fs.chmodSync(file, mode); closed.push(path.basename(file)); } } catch { /* not ours to change: left as it is */ } };
    close(config.dataDir, 0o700);
    for (const f of ['secret.key', 'admin.key', path.basename(dbPath), `${path.basename(dbPath)}-wal`, `${path.basename(dbPath)}-shm`]) close(path.join(config.dataDir, f), 0o600);
    return closed;
}
