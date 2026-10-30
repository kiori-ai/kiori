#!/usr/bin/env node
// Checks a Kiori data folder: is the database whole, what does it hold (counts only), and does this machine's secret
// (secret.key, or KIORI_SECRET) open every customer model key sealed in it. Run it on both sides of the move: the
// counts and fingerprints on the server should match the old machine's.
//
//   On the old machine:      node deploy/check-data.mjs   (in Kiori's folder)
//   On the server:           sudo kiori-restore --check     (runs this as the kiori user, with the service's settings)
//
// It only reads: it never writes to the database and never makes a secret.key (Kiori itself makes one on first use,
// which is exactly what must not happen next to a moved database). It prints counts and short fingerprints, never a
// key. Exit status 1 when something is wrong.
process.removeAllListeners('warning');
process.on('warning', w => { if (w.name !== 'ExperimentalWarning') console.warn(w.message); });

const fs = await import('node:fs');
const path = await import('node:path');
const crypto = await import('node:crypto');
const { DatabaseSync } = await import('node:sqlite');
const { config, dbPath, adminKey } = await import('../src/config.mjs');

let failed = false;
const ok = text => console.log(`  ok    ${text}`);
const note = text => console.log(`        ${text}`);
const bad = text => { console.log(`  FAIL  ${text}`); failed = true; };
// A short fingerprint to compare two copies of a secret without showing it (unrelated to the key Kiori derives from it)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fingerprint = text => crypto.createHash('sha256').update(`kiori-check:${String(text).trim()}`).digest('hex').slice(0, 12);

console.log(`Kiori data check: ${dbPath}`);
if (!fs.existsSync(dbPath)) { bad('there is no database here'); process.exit(1); }
const db = new DatabaseSync(dbPath);

const integrity = db.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]).join('; ');
if (integrity === 'ok') ok('the database is whole (integrity_check)');
else bad(`integrity_check: ${integrity}`);

const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
const count = sql => db.prepare(sql).get().n;
if (!tables.has('projects')) bad('no projects table: this is not a Kiori database');
else {
    const hasMode = db.prepare('PRAGMA table_info(projects)').all().some(c => c.name === 'llm_mode');
    const projects = count('SELECT count(*) AS n FROM projects');
    const onServerKey = hasMode ? count("SELECT count(*) AS n FROM projects WHERE llm_mode = 'server'") : projects;
    const keys = tables.has('api_keys') ? count('SELECT count(*) AS n FROM api_keys') : 0;
    const asks = tables.has('access_requests') ? count('SELECT count(*) AS n FROM access_requests') : 0;
    note(`projects: ${projects} (${onServerKey} on this server's model key), Kiori keys: ${keys}, access requests: ${asks}`);

    // Sealed customer model keys live in the projects' settings (llm.key_sealed, upstream.key_sealed), each bound to its
    // project and setting (kv2.…), or from before that binding (sealed:…, sealed again when Kiori starts)
    const sealed = [];
    for (const row of db.prepare('SELECT id, settings FROM projects').all()) {
        let settings;
        try { settings = JSON.parse(row.settings); } catch { continue; /* not JSON: nothing sealed in it */ }
        for (const part of ['llm', 'upstream']) {
            const v = settings?.[part]?.key_sealed;
            if (typeof v === 'string' && (v.startsWith('kv2.') || v.startsWith('sealed:'))) sealed.push({ value: v, bind: `${row.id}/${part}` });
        }
    }
    const older = sealed.filter(s => s.value.startsWith('sealed:')).length;
    if (older) note(`${plural(older, 'model key')} sealed the older way: Kiori seals ${older === 1 ? 'it' : 'them'} again, bound to the project, when it starts`);
    const keyFile = path.join(config.dataDir, 'secret.key');
    const source = config.secret ? 'KIORI_SECRET' : fs.existsSync(keyFile) ? 'secret.key' : null;
    const print = source && fingerprint(source === 'KIORI_SECRET' ? config.secret : fs.readFileSync(keyFile, 'utf8'));
    if (!sealed.length) note(`no sealed model keys yet${source ? `; secret: ${source}, fingerprint ${print}` : ''}`);
    else if (!source) bad(`${plural(sealed.length, 'sealed model key')}, but no secret.key and no KIORI_SECRET: none of them can be opened`);
    else {
        // Only imported now: with no secret at all, secrets.mjs would make a new secret.key
        const { unseal } = await import('../src/secrets.mjs');
        const opened = sealed.filter(s => unseal(s.value, s.bind) !== '').length;
        if (opened === sealed.length) ok(`${source} (fingerprint ${print}) opens all ${plural(sealed.length, 'sealed model key')}`);
        else bad(`${source} (fingerprint ${print}) opens ${opened} of ${plural(sealed.length, 'sealed model key')}: not the secret they were sealed with`);
    }

    const llmKey = config.llm.key;
    if (!llmKey) {
        const text = "this server's own model key (KIORI_LLM_KEY) is not set";
        if (onServerKey) bad(`${text}: ${onServerKey === 1 ? 'the project' : `the ${onServerKey} projects`} on it can't call a model`); else note(text);
    } else if (/^<.*>$/.test(llmKey)) bad('KIORI_LLM_KEY is still a placeholder');
    else ok(`this server's own model key is set (…${llmKey.slice(-4)})`);
}

const admin = adminKey();
note(admin ? `admin key: fingerprint ${fingerprint(admin)}` : 'admin key: none yet (Kiori makes one on its first start)');
note(config.publicUrl ? `public URL: ${config.publicUrl}` : 'public URL: not set (KIORI_PUBLIC_URL), so sign-in links would point at this machine');
db.close();
if (failed) process.exitCode = 1;
