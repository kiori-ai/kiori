// What customers hand Kiori to act for them (their model provider keys) is kept sealed: AES-256-GCM, each value bound
// to where it belongs (its project and setting go in as additional data), so a sealed key moved to another project or
// setting doesn't open. The sealing key is made (HKDF-SHA256) from a secret kept apart from the database
// (data/local/secret.key, or KIORI_SECRET), so a copy of the database alone reveals none of them.
//
// secret.key may hold several secrets, one per line, newest first (kiori rotate-secret puts a new one in front): the
// newest seals, any of them opens. Values from before (sealed: with no binding, or plain text) are still read, and
// accounts.resealAll seals them again the current way when the server starts.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';

export const secretFile = () => path.join(config.dataDir, 'secret.key');
const derive = secret => {
    const key = Buffer.from(crypto.hkdfSync('sha256', Buffer.from(secret, 'utf8'), 'kiori', 'kiori seal v2', 32));
    // The key's id travels with each value, so the right secret is picked without trying them all
    return { key, kid: crypto.createHash('sha256').update(key).digest('hex').slice(0, 8), legacy: crypto.createHash('sha256').update(secret).digest() };
};
// The secrets as written: KIORI_SECRET (several may be given, newest first, separated by spaces), or secret.key, made
// with a random one the first time
export function readSecrets() {
    if (config.secret) return config.secret.split(/[\s,]+/).filter(Boolean);
    const file = secretFile();
    if (!fs.existsSync(file)) fs.writeFileSync(file, `${crypto.randomBytes(32).toString('base64url')}\n`, { mode: 0o600 });
    return fs.readFileSync(file, 'utf8').split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
}
let cache = null;
// reload: read them again (a secret added while the server runs, by kiori rotate-secret)
function keys(reload = false) {
    if (!cache || reload) {
        const list = readSecrets();
        if (!list.length) throw new Error(`No secret to seal keys with: ${config.secret ? 'KIORI_SECRET' : secretFile()} is empty`);
        cache = list.map(derive);
    }
    return cache;
}
export const forgetSecrets = () => { cache = null; };
// Where a sealed value belongs: its project and setting (llm: the brain API key; upstream: the drop-in's provider)
export const bindOf = (project, part) => `${project}/${part}`;
// Sealed with the newest secret, the current way
export const isCurrent = value => typeof value === 'string' && value.startsWith(`kv2.${keys()[0].kid}.`);

export function seal(text, bind) {
    if (text == null || text === '') return null;
    if (!bind) throw new Error('seal: a value is sealed for a place (bindOf)');
    const { key, kid } = keys()[0];
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', key, iv);
    c.setAAD(Buffer.from(`kiori:${bind}`, 'utf8'));
    const body = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
    return `kv2.${kid}.${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url')}`;
}

const open = (key, data, aad) => {
    const b = Buffer.from(data, 'base64url');
    if (b.length < 29) throw new Error('too short');
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    if (aad) d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
};
// '' when there is nothing, or when it can't be opened (another secret, or sealed for another place)
export function unseal(value, bind) {
    if (value == null || value === '') return '';
    const v = String(value);
    if (v.startsWith('kv2.')) {
        const [, kid, data] = v.split('.');
        const k = keys().find(x => x.kid === kid) ?? keys(true).find(x => x.kid === kid);
        if (!k || !bind) return '';
        try { return open(k.key, data, `kiori:${bind}`); } catch { return ''; }
    }
    if (v.startsWith('sealed:')) {
        for (const k of keys()) { try { return open(k.legacy, v.slice(7), null); } catch { /* the next secret, if any */ } }
        return '';
    }
    return v;
}

// How a stored key is shown back: its last four characters only
export const masked = (value, bind) => { const v = unseal(value, bind); return v ? `…${v.slice(-4)}` : null; };
