#!/usr/bin/env node
// kiori: run the server and manage projects from the command line. `psyche` is the same command under its old name.
process.removeAllListeners('warning');
process.on('warning', w => { if (w.name !== 'ExperimentalWarning') console.warn(w.message); });

const crypto = await import('node:crypto');
const fs = await import('node:fs');
const path = await import('node:path');
const { config, adminKey, setAdminKey } = await import('../src/config.mjs');

const [cmd, ...rest] = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : fallback; };
const positional = rest.filter((a, i) => !a.startsWith('--') && !rest[i - 1]?.startsWith('--'));
// Brain files into a folder, one JSON each; says what was written. parts: the file's path in the folder, a part each
// (a brain's name; an old project and a file). Each part is cleaned the way exports clean names (no slashes, no
// leading dots: a vault's or an old database's names can't reach outside the folder), nothing is written outside it,
// and a file already there is never overwritten (the new one is "<name> (2).json")
const part = s => String(s ?? '').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '').replace(/^[.\s]+/, '').trim().slice(0, 120) || 'brain';
function writeBrains(out, items) {
    const root = path.resolve(out);
    for (const { parts, brain } of items) {
        const clean = parts.map(part);
        const dir = path.join(root, ...clean.slice(0, -1));
        const name = clean.at(-1);
        for (let n = 1; ; n++) {
            const target = path.join(dir, `${name}${n > 1 ? ` (${n})` : ''}.json`);
            const where = path.relative(root, target);
            if (where.startsWith('..') || path.isAbsolute(where)) throw new Error(`refusing to write outside ${root}: ${target}`);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            try { fs.writeFileSync(target, JSON.stringify(brain), { flag: 'wx' }); break; }
            catch (e) { if (e.code !== 'EEXIST') throw e; }
        }
    }
    return `${items.length} brain file${items.length === 1 ? '' : 's'} in ${root}: ${items.map(i => `${i.brain.name} (${i.brain.memories.length} memories)`).join(', ')}`;
}

const HELP = `Kiori — brains for characters

  kiori serve                         start the API, console and docs (port ${config.port})
  kiori init                          create the admin key (once)
  kiori project create <name> [--own]  new project; prints its API key once, and a console sign-in link
                                      (--own: a customer's project, on their own model key)
  kiori projects                      list projects
  kiori key create --project <id>     another API key for a project
  kiori login --project <id>          a console sign-in link (one use, good for 7 days; holds no key)
  kiori rotate-secret                 a new secret for the sealed model keys: every key is sealed again with it
  kiori import <vault> --out <dir> [--project <id>]
                                      a markdown brain vault (a character or a world) as brain files;
                                      with --project, their meaning fingerprints are made on its key
  kiori export-old --out <dir>        what a database from before brains moved out still holds, as brain files
  kiori errors [--days 7]             the calls that failed on this side: when, which endpoint and project, the
                                      status and its code, the model provider's status (never what was said)
  kiori stats [--weeks 12] [--all]    how Kiori is used, week by week: customers' projects (--all: everyone's)
  kiori site [--out dist] [--origin https://kiori.io] [--api https://api.kiori.io]
                                      the public site as static files (landing page, docs, OpenAPI, SDKs)
`;

if (cmd === 'init') {
    if (adminKey()) console.log(`Admin key already exists (${path.join(config.dataDir, 'admin.key')}).`);
    else { setAdminKey(`kia_${crypto.randomBytes(24).toString('base64url')}`); console.log(`Admin key written to ${path.join(config.dataDir, 'admin.key')}`); }
} else if (cmd === 'serve') {
    if (!adminKey()) setAdminKey(`kia_${crypto.randomBytes(24).toString('base64url')}`);
    const { startServer } = await import('../src/server.mjs');
    startServer();
} else if (cmd === 'project' && rest[0] === 'create') {
    const { createProject } = await import('../src/accounts.mjs');
    const own = rest.includes('--own');
    const { signinLink } = await import('../src/access.mjs');
    const { project, key } = createProject(positional.slice(1).join(' ') || 'My project', {}, { llmMode: own ? 'own' : 'server' });
    const { link, expires_at } = signinLink(project.id);
    console.log(`Project ${project.name} (${project.id})${own ? ', on its own brain API key (add it in the console)' : ''}\nAPI key for your app (shown once, keep it safe): ${key}\nSign in to the console to change the project or its keys (one use, until ${expires_at.slice(0, 10)}): ${link}`);
} else if (cmd === 'projects') {
    const { listProjects } = await import('../src/accounts.mjs');
    for (const p of listProjects()) console.log(`${p.id}  ${p.name}`);
} else if (cmd === 'key' && rest[0] === 'create') {
    const { createKey, getProject } = await import('../src/accounts.mjs');
    const id = flag('project');
    if (!getProject(id)) { console.error('Unknown project'); process.exit(1); }
    try { console.log(createKey(id, flag('label'))); } catch (e) { console.error(e.message); process.exit(1); }
} else if (cmd === 'import') {
    const { vaultBrains } = await import('../src/importer.mjs');
    const dir = positional[0], out = flag('out'), project = flag('project');
    if (!dir || !fs.existsSync(dir) || !out) { console.error('Usage: kiori import <vault> --out <dir> [--project <id>]'); process.exit(1); }
    const r = vaultBrains(path.resolve(dir));
    if (project) {
        const { getProject } = await import('../src/accounts.mjs');
        const { embedMissing } = await import('../src/recall.mjs');
        if (!getProject(project)) { console.error('Unknown project'); process.exit(1); }
        for (const b of r.brains) await embedMissing(project, b);
    }
    console.log(`${r.world ? `World ${r.world}: ` : ''}${writeBrains(out, r.brains.map(b => ({ parts: [b.name], brain: b })))}`);
} else if (cmd === 'export-old') {
    const { oldBrains } = await import('../src/migrate.mjs');
    const out = flag('out');
    if (!out) { console.error('Usage: kiori export-old --out <dir>'); process.exit(1); }
    const found = oldBrains();
    console.log(found.length ? writeBrains(out, found.map(f => ({ parts: [f.project, f.file], brain: f.brain }))) : 'This database holds no brains from before.');
} else if (cmd === 'errors') {
    const { recentErrors } = await import('../src/accounts.mjs');
    const days = Math.max(1, Number(flag('days', 7)) || 7);
    const rows = recentErrors(days);
    console.log(rows.length ? rows.map(r => `${r.at}  ${r.status}  ${r.route}${r.code ? `  ${r.code}` : ''}${r.upstream ? ` (provider ${r.upstream})` : ''}${r.project_id ? `  ${r.project_id}` : ''}`).join('\n') : `No failed calls in the last ${days} day${days === 1 ? '' : 's'}.`);
} else if (cmd === 'stats') {
    const { weeklyStats } = await import('../src/stats.mjs');
    const s = weeklyStats({ weeks: Math.min(104, Math.max(1, Number(flag('weeks', 12)) || 12)), everyone: rest.includes('--all') });
    const cols = [['Week', 'week'], ['Active', 'active'], ['New', 'new_projects'], ['Brains', 'brains'], ['Recalls', 'recalls'], ['Learns', 'learns'], ['Checks', 'checks'], ['Chats', 'chats'], ['Model $', 'model_cost'], ['5xx', 'errors'], ['Kept 4w', 'kept_4w'], ['Requests', 'requests']];
    const cell = (r, k) => (k === 'kept_4w' ? (r[k] == null ? '–' : `${Math.round(r[k] * 100)}%`) : String(r[k]));
    const widths = cols.map(([title, k]) => Math.max(title.length, ...s.weeks.map(r => cell(r, k).length)));
    const line = cells => cells.map((c, i) => c.padEnd(widths[i])).join('  ');
    console.log(`${s.scope === 'all' ? 'Everyone' : 'Customers (projects on their own brain API key)'}: ${s.totals.projects} projects, ${s.totals.brains} brains made, ${s.totals.learns} learning calls in all\n`);
    console.log([line(cols.map(c => c[0])), ...s.weeks.map(r => line(cols.map(([, k]) => cell(r, k))))].join('\n'));
} else if (cmd === 'login') {
    const { getProject } = await import('../src/accounts.mjs');
    const { signinLink } = await import('../src/access.mjs');
    const id = flag('project');
    if (!getProject(id)) { console.error('Unknown project'); process.exit(1); }
    const { link, expires_at } = signinLink(id);
    console.log(`${link}\n(one use, until ${expires_at.slice(0, 10)}; opening it makes the browser a Kiori key of its own)`);
} else if (cmd === 'rotate-secret') {
    // A new secret in front of the old one, every kept key sealed again with it, then the old one moved aside. Each step
    // leaves every key openable: a server running meanwhile reads the new secret when it meets a key sealed with it.
    const { secretFile, readSecrets, forgetSecrets } = await import('../src/secrets.mjs');
    if (config.secret) {
        console.error('KIORI_SECRET is set, so the secret lives in your settings, not in secret.key. To change it: put a new random value in front of the old one (KIORI_SECRET="new old"), restart Kiori, run kiori rotate-secret --check-env, then remove the old one and restart again.');
        if (!rest.includes('--check-env')) process.exit(1);
        const { resealAll } = await import('../src/accounts.mjs');
        const r = resealAll({ all: true });
        console.log(`${r.sealed} kept key${r.sealed === 1 ? '' : 's'} sealed again with the first secret in KIORI_SECRET${r.unopened ? `; ${r.unopened} could not be opened` : ''}.`);
        process.exit(r.unopened ? 1 : 0);
    }
    const file = secretFile(), old = readSecrets();
    const write = lines => { fs.writeFileSync(`${file}.tmp`, `${lines.join('\n')}\n`, { mode: 0o600 }); fs.renameSync(`${file}.tmp`, file); forgetSecrets(); };
    const fresh = crypto.randomBytes(32).toString('base64url');
    write([fresh, ...old]);
    const { resealAll } = await import('../src/accounts.mjs');
    const r = resealAll({ all: true });
    if (r.unopened) { console.error(`${r.unopened} kept key${r.unopened === 1 ? '' : 's'} could not be opened with any secret here; secret.key keeps the old secrets too, so nothing is lost. Look into it before rotating again.`); process.exit(1); }
    const aside = `${file}.old-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}`;
    fs.writeFileSync(aside, `${old.join('\n')}\n`, { mode: 0o600 });
    write([fresh]);
    console.log(`${r.sealed} kept key${r.sealed === 1 ? '' : 's'} sealed with the new secret (secret.key). The old one is in ${path.basename(aside)}: delete it once your backups hold the new secret.key.`);
} else if (cmd === 'site') {
    const { buildSite } = await import('../src/site.mjs');
    try {
        const r = buildSite(path.resolve(flag('out', 'dist')), { origin: flag('origin', 'https://kiori.io'), api: flag('api', 'https://api.kiori.io') });
        console.log(`${r.files} files, ${(r.bytes / 1e6).toFixed(1)} MB in ${r.out}`);
    } catch (e) { console.error(e.message); process.exit(1); }
} else {
    console.log(HELP);
}
