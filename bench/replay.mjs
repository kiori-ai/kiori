// The replay: everything one benchmark run did, message by message, for the site's playground to play back. Compact
// on purpose: each text is written once and referred to by message number, recall blocks are pooled (a block that
// comes back unchanged is the same entry), and memories are a table by id. The schema is versioned ("replay": 1) and
// documented in bench/README.md; a change that breaks a reader bumps the version.
import { MODES } from './engine.mjs';

export const REPLAY_VERSION = 1;
const STATES = new Set(['knows', 'believes_lie', 'half']);
const KINDS = new Set(['organize', 'probes', 'end']);
const pools = new WeakMap();

export function newReplay({ run, story }) {
    const r = {
        replay: REPLAY_VERSION,
        run,
        player: story.player,
        people: Object.fromEntries(Object.values(story.people).map(p => [p.name, { role: p.role, groups: p.groups }])),
        facts: Object.fromEntries(Object.values(story.facts).map(f => [f.id, { truth: f.truth, canaries: f.canaries, ...(Object.keys(f.parts).length && { parts: f.parts }), ...(f.lie_of && { lie_of: f.lie_of }) }])),
        scenarios: story.scenarios.map(({ id, title, from, to }) => ({ id, title, from, to })),
        messages: [], turns: [], probes: [], organize: [], blocks: [], memories: {}, checkpoints: [],
        metrics: null,
    };
    pools.set(r, new Map());
    return r;
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
        if (!r.memories[m.id]) r.memories[m.id] = { kind: m.kind, title: m.title, ...(m.from != null && { from: m.from }), ...(m.to != null && { to: m.to }), ...(m.source && { source: m.source }), ...(m.confidence != null && { confidence: m.confidence }), ...(m.strength != null && { strength: m.strength }) };
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
// Everything wrong with a replay, as a list of problems (empty: it is valid)
export function validateReplay(r) {
    const bad = [];
    const need = (ok, why) => { if (!ok) bad.push(why); };
    const isNum = v => typeof v === 'number' && Number.isFinite(v);
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    need(r?.replay === REPLAY_VERSION, `replay must be ${REPLAY_VERSION}`);
    if (!isObj(r)) return bad;
    need(isObj(r.run) && typeof r.run.arm === 'string' && typeof r.run.chat_model === 'string' && typeof r.run.date === 'string', 'run needs arm, chat_model and date');
    need(typeof r.player === 'string', 'player is a name');
    need(isObj(r.people) && isObj(r.facts), 'people and facts are objects');
    for (const [id, f] of Object.entries(r.facts ?? {})) need(typeof f.truth === 'string' && Array.isArray(f.canaries) && f.canaries.length, `fact ${id} needs truth and canaries`);
    need(Array.isArray(r.scenarios) && r.scenarios.every(s => typeof s.id === 'string' && isNum(s.from) && isNum(s.to)), 'scenarios: [{ id, title, from, to }]');
    const N = r.messages?.length ?? 0;
    need(Array.isArray(r.messages), 'messages is a list');
    (r.messages ?? []).forEach((m, i) => {
        need(m.n === i + 1, `message ${i}: n must be ${i + 1}`);
        need(typeof m.who === 'string' && typeof m.text === 'string' && typeof m.spine === 'boolean', `message ${m.n}: who, text, spine`);
        need(isObj(m.present) && Object.values(m.present).every(mode => MODES.includes(mode)), `message ${m.n}: present is { name: mode }`);
    });
    const free = new Set((r.messages ?? []).filter(m => !m.spine).map(m => m.n));
    for (const t of r.turns ?? []) {
        need(free.has(t.n), `turn ${t.n}: not a free message`);
        need(Array.isArray(t.leaks) && Array.isArray(t.issues), `turn ${t.n}: leaks and issues are lists`);
    }
    const blocks = r.blocks ?? [];
    need(Array.isArray(blocks) && blocks.every(b => typeof b === 'string'), 'blocks is a list of texts');
    const heldOk = h => isObj(h) && Number.isInteger(h.block) && h.block >= 0 && h.block < blocks.length && Array.isArray(h.memories) && h.memories.every(([id, s]) => r.memories?.[id] && (s === null || isNum(s)));
    for (const p of r.probes ?? []) {
        need(typeof p.id === 'string' && typeof p.target === 'string' && typeof p.ask === 'string' && typeof p.answer === 'string', `probe ${p.id}: id, target, ask, answer`);
        need(isNum(p.at) && p.at >= 0 && p.at <= N, `probe ${p.id}: at is a message number`);
        need(p.held == null || heldOk(p.held), `probe ${p.id}: held refers to a block and memories`);
        need(isObj(p.score), `probe ${p.id}: score`);
    }
    for (const o of r.organize ?? []) need(isNum(o.at) && Array.isArray(o.learned), 'organize: [{ at, learned }]');
    for (const [id, m] of Object.entries(r.memories ?? {})) need(typeof m.kind === 'string' && typeof m.title === 'string', `memory ${id}: kind and title`);
    need(Array.isArray(r.checkpoints) && r.checkpoints.length > 0, 'checkpoints: at least the end');
    for (const c of r.checkpoints ?? []) {
        const where = `checkpoint at ${c.at}`;
        need(isNum(c.at) && c.at >= 0 && c.at <= N, `${where}: at is a message number`);
        need(Array.isArray(c.kind) && c.kind.length && c.kind.every(k => KINDS.has(k)), `${where}: kind is a list of organize | probes | end`);
        need(isObj(c.truth), `${where}: truth is an object`);
        for (const [name, row] of Object.entries(c.truth ?? {})) for (const [f, e] of Object.entries(row)) {
            need(r.facts?.[f], `${where}: unknown fact ${f}`);
            need(Array.isArray(e) && STATES.has(e[0]) && (e[1] === null || typeof e[1] === 'string') && (e[2] === null || typeof e[2] === 'string') && isNum(e[3]) && (e[0] !== 'half' || Array.isArray(e[4])), `${where}: ${name}/${f} is [state, via, origin, at, parts?]`);
        }
        need(c.held === null || (isObj(c.held) && Object.values(c.held).every(heldOk)), `${where}: held is null or { name: { block, memories } }`);
        need(isObj(c.cost) && ['kiori_usd', 'chat_usd', 'judge_usd', 'estimated_usd'].every(k => isNum(c.cost[k])), `${where}: cost has kiori_usd, chat_usd, judge_usd, estimated_usd`);
        need(isObj(c.latency_ms), `${where}: latency_ms`);
    }
    need(r.checkpoints?.at(-1)?.kind?.includes('end'), 'the last checkpoint is the end');
    need(isObj(r.metrics) && 'leak_rate' in r.metrics && 'false_ignorance_rate' in r.metrics, 'metrics has the metrics table');
    return bad;
}
