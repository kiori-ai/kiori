// The replay: everything one benchmark run did, message by message, for the site's playground to play back. Compact
// on purpose: each text is written once and referred to by message number, recall blocks are pooled (a block that
// comes back unchanged is the same entry), and memories are a table by id. The schema is versioned ("replay": 2) and
// documented in bench/README.md; a change that breaks a reader bumps the version. Version 1 files still validate.
import crypto from 'node:crypto';
import { MODES } from './engine.mjs';

export const REPLAY_VERSION = 2;
const STATES = new Set(['knows', 'believes_lie', 'half']);
const KINDS = new Set(['organize', 'probes', 'end']);
const pools = new WeakMap();

// How the playground draws people: the main cast in five fixed colors with a portrait each, everyone else in a color
// of their own from their name (the same in every run)
export const CAST_COLORS = { Leo: '#6b5bb5', Mira: '#2f6f8f', Tom: '#c0652b', Ines: '#a8457a', Rook: '#5b7a3a' };
function hslHex(h, s, l) {
    const a = s * Math.min(l, 1 - l), f = n => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))).toString(16).padStart(2, '0'); };
    return `#${f(0)}${f(8)}${f(4)}`;
}
export const colorOf = name => CAST_COLORS[name] ?? hslHex(crypto.createHash('md5').update(String(name)).digest().readUInt16BE(0) % 360, 0.42, 0.46);
export const portraitOf = name => (CAST_COLORS[name] ? `img/cast/${name.toLowerCase()}.jpg` : '');

export function newReplay({ run, story }) {
    const r = {
        replay: REPLAY_VERSION,
        run,
        player: story.player,
        people: Object.fromEntries(Object.values(story.people).map(p => [p.name, { role: p.role, groups: p.groups, who: p.who ?? '', voice: p.voice ?? '', color: colorOf(p.name), portrait: portraitOf(p.name) }])),
        facts: Object.fromEntries(Object.values(story.facts).map(f => [f.id, { label: f.label ?? '', truth: f.truth, canaries: f.canaries, ...(Object.keys(f.parts).length && { parts: f.parts }), ...(f.lie_of && { lie_of: f.lie_of }) }])),
        scenarios: story.scenarios.map(({ id, title, from, to }) => ({ id, title, from, to })),
        messages: [], deltas: [], turns: [], probes: [], organize: [], blocks: [], memories: {}, checkpoints: [],
        metrics: null,
    };
    pools.set(r, new Map());
    return r;
}

// ---------- The truth, as it changes ----------
// Follows the ground truth through a run: after each step, every (person, fact) entry that changed becomes a delta at
// that message, and the message it last changed at is kept for the checkpoints' tuples
export function truthTracker(r) {
    const sigs = new Map(), changed = new Map();
    const sig = e => JSON.stringify([e.state, e.via ?? null, e.origin ?? null, e.parts ? [...e.parts].sort() : null, e.exposed ?? null, !!e.forgot]);
    return {
        changed,
        step(st, n) {
            for (const [person, row] of Object.entries(st.K)) for (const [fact, e] of Object.entries(row)) {
                const key = `${person}\u0000${fact}`, was = sigs.get(key), now = sig(e);
                if (was === now || (!was && e.state === 'none' && !e.forgot)) continue;
                sigs.set(key, now);
                changed.set(key, n);
                const exposed = e.exposed != null && !(was && JSON.parse(was)[4] != null);
                r.deltas.push({ n, person, fact, state: e.state, ...(e.via && { via: e.via }), ...(e.origin && { origin: e.origin }), ...(e.state === 'half' && { parts: e.parts ?? [] }), ...(exposed && { exposed: true }), ...(e.forgot && { forgot: true }), ...(e.leaked && { leaked: true }) });
            }
        },
    };
}
// The table at a checkpoint: only what someone holds, as [state, via, origin, at, parts, exposed, changed_at], with
// the trailing empty ones left off (parts is null unless half; changed_at only when it isn't at)
export function truthOf(st, changed = new Map()) {
    const out = {};
    for (const [name, row] of Object.entries(st.K)) {
        const facts = Object.entries(row).filter(([, e]) => e.state !== 'none');
        if (!facts.length) continue;
        out[name] = Object.fromEntries(facts.map(([f, e]) => {
            const last = changed.get(`${name}\u0000${f}`);
            const t = [e.state, e.via ?? null, e.origin ?? null, e.at, e.state === 'half' ? e.parts ?? [] : null, e.exposed ?? null, last != null && last !== e.at ? last : null];
            while (t.length > 4 && t.at(-1) === null) t.pop();
            return [f, t];
        }));
    }
    return out;
}

// A message of the story as it was shown. present: { name: mode }
export function addMessage(r, { n, who, text, present, spine, scene }) {
    const last = r.messages.findLast(m => m.scene !== undefined)?.scene;
    r.messages.push({ n, who, text, present, spine, ...(scene && scene !== last && { scene }) });
}

// A recall block, pooled: its index
export function blockRef(r, text) {
    let pool = pools.get(r);
    if (!pool) { pool = new Map(r.blocks.map((b, i) => [b, i])); pools.set(r, pool); }
    if (!pool.has(text)) { pool.set(text, r.blocks.length); r.blocks.push(text); }
    return pool.get(text);
}

// The memories recall returned, into the table (without their bodies: the block they came back in has those), as
// [id, score] pairs
export function memoryRefs(r, memories = []) {
    return memories.map(m => {
        if (!r.memories[m.id]) r.memories[m.id] = { kind: m.kind, title: m.title, ...(m.from != null && { from: m.from }), ...(m.to != null && { to: m.to }), ...(m.source && { source: m.source }), ...(m.confidence != null && { confidence: m.confidence }), ...(m.strength != null && { strength: m.strength }), ...(m.told_to?.length && { told_to: m.told_to }), ...(m.lie === true && { lie: true }) };
        return [m.id, m.score ?? null];
    });
}

// What Kiori held for one character: their recall block and the memories that came back with it
export const held = (r, recall) => ({ block: blockRef(r, recall.text), memories: memoryRefs(r, recall.memories) });

// The file: one line per top-level field, per message, per checkpoint, per memory... (valid JSON, near the size of
// the minified form, and a diff of two runs reads line by line)
export function formatReplay(r) {
    const field = ([k, v]) => {
        const key = JSON.stringify(k);
        if (Array.isArray(v) && v.length) return `${key}: [\n${v.map(x => `  ${JSON.stringify(x)}`).join(',\n')}\n]`;
        if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length && k !== 'run' && k !== 'metrics') return `${key}: {\n${Object.entries(v).map(([k2, x]) => `  ${JSON.stringify(k2)}: ${JSON.stringify(x)}`).join(',\n')}\n}`;
        return `${key}: ${JSON.stringify(v)}`;
    };
    return `{\n${Object.entries(r).map(field).join(',\n')}\n}\n`;
}

// ---------- Validation ----------
const BY = new Set(['precheck', 'auditor']);
// Everything wrong with a replay, as a list of problems (empty: it is valid). Version 2, and version 1 as it was.
export function validateReplay(r) {
    const bad = [];
    const need = (ok, why) => { if (!ok) bad.push(why); };
    const isNum = v => typeof v === 'number' && Number.isFinite(v);
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    const isStr = v => typeof v === 'string';
    const v = r?.replay;
    need(v === 1 || v === REPLAY_VERSION, `replay must be ${REPLAY_VERSION} (or 1)`);
    if (!isObj(r)) return bad;
    const v2 = v === 2;
    need(isObj(r.run) && isStr(r.run.arm) && isStr(r.run.chat_model) && isStr(r.run.date), 'run needs arm, chat_model and date');
    need(isStr(r.player), 'player is a name');
    need(isObj(r.people) && isObj(r.facts), 'people and facts are objects');
    for (const [id, f] of Object.entries(r.facts ?? {})) {
        need(isStr(f.truth) && Array.isArray(f.canaries) && f.canaries.length, `fact ${id} needs truth and canaries`);
        if (v2) need(isStr(f.label) && f.label.trim(), `fact ${id} needs a label`);
    }
    if (v2) for (const [name, p] of Object.entries(r.people ?? {})) need(isStr(p.role) && isStr(p.who) && isStr(p.voice) && /^#[0-9a-f]{6}$/.test(p.color ?? '') && isStr(p.portrait), `person ${name}: role, who, voice, color (#rrggbb), portrait`);
    need(Array.isArray(r.scenarios) && r.scenarios.every(s => isStr(s.id) && isNum(s.from) && isNum(s.to)), 'scenarios: [{ id, title, from, to }]');
    const N = r.messages?.length ?? 0;
    need(Array.isArray(r.messages), 'messages is a list');
    (r.messages ?? []).forEach((m, i) => {
        need(m.n === i + 1, `message ${i}: n must be ${i + 1}`);
        need(isStr(m.who) && isStr(m.text) && typeof m.spine === 'boolean', `message ${m.n}: who, text, spine`);
        need(isObj(m.present) && Object.values(m.present).every(mode => MODES.includes(mode)), `message ${m.n}: present is { name: mode }`);
    });
    const people = r.people ?? {}, facts = r.facts ?? {};
    if (v2) {
        need(Array.isArray(r.deltas), 'deltas is a list');
        let last = 0;
        for (const d of r.deltas ?? []) {
            const where = `delta at ${d.n} (${d.person}/${d.fact})`;
            need(Number.isInteger(d.n) && d.n >= 0 && d.n <= N && d.n >= last, `${where}: n is a message number, in order`);
            last = d.n;
            need(people[d.person] && facts[d.fact], `${where}: a known person and fact`);
            need(STATES.has(d.state) || d.state === 'none', `${where}: state is knows, believes_lie, half or none`);
            need((d.via == null || isStr(d.via)) && (d.origin == null || isStr(d.origin)) && (d.exposed == null || d.exposed === true) && (d.state !== 'half' || Array.isArray(d.parts)), `${where}: via, origin, exposed, parts`);
        }
    }
    const blocks = r.blocks ?? [];
    need(Array.isArray(blocks) && blocks.every(isStr), 'blocks is a list of texts');
    const blockOk = b => Number.isInteger(b) && b >= 0 && b < blocks.length;
    const issuesOk = (list, where) => {
        need(Array.isArray(list), `${where}: issues is a list`);
        if (v2) for (const i of list ?? []) need(isStr(i.type) && isStr(i.character) && BY.has(i.by) && typeof i.real === 'boolean' && (i.cut == null || (isStr(i.cut.word) && Number.isInteger(i.cut.at) && i.cut.at >= 0)), `${where}: an issue is { character, type, quote, by: precheck | auditor, real, cut? }`);
    };
    const free = new Set((r.messages ?? []).filter(m => !m.spine).map(m => m.n));
    for (const t of r.turns ?? []) {
        need(free.has(t.n), `turn ${t.n}: not a free message`);
        need(Array.isArray(t.leaks), `turn ${t.n}: leaks is a list`);
        issuesOk(t.issues, `turn ${t.n}`);
        if (v2) need(typeof t.changed === 'boolean' && (t.block === null || blockOk(t.block)) && (t.suspects == null || Array.isArray(t.suspects)), `turn ${t.n}: changed, block (a block or null), suspects`);
    }
    const heldOk = h => isObj(h) && blockOk(h.block) && Array.isArray(h.memories) && h.memories.every(([id, s]) => r.memories?.[id] && (s === null || isNum(s)));
    for (const p of r.probes ?? []) {
        need(isStr(p.id) && isStr(p.target) && isStr(p.ask) && isStr(p.answer), `probe ${p.id}: id, target, ask, answer`);
        need(isNum(p.at) && p.at >= 0 && p.at <= N, `probe ${p.id}: at is a message number`);
        need(p.held == null || heldOk(p.held), `probe ${p.id}: held refers to a block and memories`);
        need(isObj(p.score), `probe ${p.id}: score`);
        if (p.issues) issuesOk(p.issues, `probe ${p.id}`);
        if (v2) need((p.target_mode === null || MODES.includes(p.target_mode)) && isObj(p.asker_knows) && typeof p.changed === 'boolean', `probe ${p.id}: target_mode, asker_knows, changed`);
    }
    for (const o of r.organize ?? []) need(isNum(o.at) && Array.isArray(o.learned), 'organize: [{ at, learned }]');
    for (const [id, m] of Object.entries(r.memories ?? {})) need(isStr(m.kind) && isStr(m.title), `memory ${id}: kind and title`);
    need(Array.isArray(r.checkpoints) && r.checkpoints.length > 0, 'checkpoints: at least the end');
    const tupleOk = e => Array.isArray(e) && STATES.has(e[0]) && (e[1] === null || isStr(e[1])) && (e[2] === null || isStr(e[2])) && isNum(e[3])
        && (v2 ? e.length <= 7 && (e[0] !== 'half' || Array.isArray(e[4])) && (e[4] == null || Array.isArray(e[4])) && (e[5] == null || isNum(e[5])) && (e[6] == null || isNum(e[6])) : e[0] !== 'half' || Array.isArray(e[4]));
    for (const c of r.checkpoints ?? []) {
        const where = `checkpoint at ${c.at}`;
        need(isNum(c.at) && c.at >= 0 && c.at <= N, `${where}: at is a message number`);
        need(Array.isArray(c.kind) && c.kind.length && c.kind.every(k => KINDS.has(k)), `${where}: kind is a list of organize | probes | end`);
        need(isObj(c.truth), `${where}: truth is an object`);
        for (const [name, row] of Object.entries(c.truth ?? {})) for (const [f, e] of Object.entries(row)) {
            need(facts[f], `${where}: unknown fact ${f}`);
            need(tupleOk(e), `${where}: ${name}/${f} is [state, via, origin, at${v2 ? ', parts, exposed, changed_at' : ', parts?'}]`);
        }
        need(c.held === null || (isObj(c.held) && Object.values(c.held).every(heldOk)), `${where}: held is null or { name: { block, memories } }`);
        need(isObj(c.cost) && ['kiori_usd', 'chat_usd', 'judge_usd', 'estimated_usd'].every(k => isNum(c.cost[k])), `${where}: cost has kiori_usd, chat_usd, judge_usd, estimated_usd`);
        need(isObj(c.latency_ms), `${where}: latency_ms`);
    }
    need(r.checkpoints?.at(-1)?.kind?.includes('end'), 'the last checkpoint is the end');
    need(isObj(r.metrics) && 'leak_rate' in r.metrics && 'false_ignorance_rate' in r.metrics, 'metrics has the metrics table');
    return bad;
}
