// A brain as a file: what one character knows in one conversation, as JSON the customer keeps. Kiori stores no brains
// and no chats: a brain comes in with a call and goes back out, changed or not. This module reads one safely (every
// field checked, nothing trusted: it comes from outside) and holds the small operations the rest of Kiori does on it.
//
// One file per character per conversation: its core (who they are, written when it was built) and what this
// conversation taught them. A new conversation starts from a copy of the freshly built brain, so conversations never mix.
import { newId, clamp, norm, sha, bareName } from './text.mjs';
import { normalize } from './personality.mjs';

export const VERSION = 1;
export const KINDS = ['memory', 'person', 'place', 'belief', 'feeling', 'secret', 'habit', 'skill', 'object', 'fact', 'intention', 'trait', 'mind', 'forgot'];
export const RELATION_FIELDS = ['trust', 'closeness', 'respect', 'resentment', 'attraction'];
export const CARD_FIELDS = { who: 1000, looks: 1000, personality: 3000, voice: 2000, core: 1000, description: 30000, lore: 30000, scenario: 4000, first_message: 4000, examples: 8000, tagline: 300 };
// What one brain may hold. A brain this big is consolidated long before (see sleep.mjs); these only stop a bad file.
export const LIMITS = { memories: 3000, relations: 200, seen: 64, brains: 12, undo: 32 };

const bad = message => Object.assign(new Error(message), { status: 400, code: 'BAD_BRAIN' });
const str = (v, max) => (v == null ? '' : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '').slice(0, max);
const isObject = v => v != null && typeof v === 'object' && !Array.isArray(v);
const strings = (v, max, len) => (Array.isArray(v) ? v.map(x => str(x, len).trim()).filter(Boolean).slice(0, max) : []);
const positive = v => (Number.isInteger(v) && v > 0 ? v : null);
const time = v => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v.slice(0, 40) : new Date().toISOString());

// Meaning fingerprints travel as 256 signed bytes each (a few hundred characters of base64), so a brain stays small.
// Embedding models that support it are asked for 256 numbers; longer vectors are cut to their first 256, which keeps
// their meaning for the models trained that way (OpenAI's text-embedding-3, Gemini's).
export const DIM = 256;
export function packVector(v) {
    if (!v?.length) return null;
    const n = Math.min(DIM, v.length);
    let len = 0;
    for (let i = 0; i < n; i++) len += v[i] * v[i];
    len = Math.sqrt(len) || 1;
    const q = new Int8Array(n);
    for (let i = 0; i < n; i++) q[i] = Math.max(-127, Math.min(127, Math.round((v[i] / len) * 127)));
    return Buffer.from(q.buffer).toString('base64');
}
// Back to a unit vector (null for anything that isn't one)
export function unpackVector(s) {
    if (typeof s !== 'string' || !s || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
    const b = Buffer.from(s, 'base64');
    if (!b.length || b.length > DIM) return null;
    const v = new Float32Array(b.length);
    let len = 0;
    for (let i = 0; i < b.length; i++) { v[i] = (b[i] << 24) >> 24; len += v[i] * v[i]; }
    len = Math.sqrt(len) || 1;
    for (let i = 0; i < v.length; i++) v[i] /= len;
    return v;
}
export function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

// A message's fingerprint: who spoke (the player or the story) and the words. A brain remembers the fingerprints of the
// last messages it learned, so the next call can line the conversation up and notice an edit, a reroll or a deletion.
export const fingerprint = (role, text) => sha(`${role === 'player' ? 'p' : 'o'}\n${String(text ?? '').trim()}`).slice(0, 16);

function memoryOf(m, ids) {
    if (!isObject(m)) return null;
    const title = str(m.title, 160).trim(), body = str(m.body, 3000).trim();
    if (!title || !body) return null;
    let id = str(m.id, 40).trim();
    if (!id || ids.has(id)) id = newId('m');
    ids.add(id);
    const importance = clamp(m.importance ?? 0.5), emotion = clamp(m.emotion ?? 0);
    const evidence = str(isObject(m.evidence) ? m.evidence.quote : m.evidence, 800).trim();
    const out = {
        id, kind: KINDS.includes(m.kind) ? m.kind : 'memory', title, body,
        keys: strings(m.keys, 20, 60).map(k => k.toLowerCase()),
        about: strings(m.about, 12, 120),
        importance, emotion,
        strength: clamp(m.strength ?? 0.25 + 0.5 * importance + 0.25 * emotion),
        status: m.status === 'done' ? 'done' : 'active',
        scope: m.scope === 'chat' ? 'chat' : 'core',
    };
    const gist = str(m.gist, 500).trim();
    if (gist) out.gist = gist;
    // Pressed down to its gist by sleep: the body is all that's left of it
    if (m.gisted === true) out.gisted = true;
    if (evidence) out.evidence = evidence;
    if (positive(m.from)) out.from = m.from;
    if (positive(m.to)) out.to = Math.max(m.to, out.from ?? m.to);
    const links = strings(m.links, 8, 40);
    if (links.length) out.links = links;
    if (typeof m.v === 'string' && m.v) {
        out.v = m.v.slice(0, 400);
        if (typeof m.vh === 'string' && m.vh) out.vh = m.vh.slice(0, 16);
    }
    return out;
}

// Feelings toward someone, 0-100. A fraction (0 < n < 1) is on a 0-1 scale and is scaled up, and so is a 1 beside
// fractions; a 1 among whole numbers is 1.
function relationValue(v, fractions) {
    let n = Number(v);
    if (v == null || v === '' || !Number.isFinite(n)) return null;
    if ((n > 0 && n < 1) || (n === 1 && fractions)) n *= 100;
    return Math.round(clamp(n, 0, 100));
}
function relationOf(r) {
    if (!isObject(r)) return null;
    const target = str(r.target, 120).trim();
    if (!target) return null;
    const given = RELATION_FIELDS.map(f => r[f]).filter(v => v != null && v !== '').map(Number).filter(Number.isFinite);
    const fractions = given.some(n => n > 0 && n < 1) && given.every(n => n <= 1);
    return { target, ...Object.fromEntries(RELATION_FIELDS.map(f => [f, relationValue(r[f], fractions)])), note: str(r.note, 500).trim() || null, scope: r.scope === 'chat' ? 'chat' : 'core' };
}
// What a learning pass changed in feelings, mood and plans, as it was before the pass: a rewind past the pass puts it
// back. { from: the pass's first message, relations: [{ target, before }], state: the chat mood before, closed: [[plan
// id, its status before]] }
function undoOf(u) {
    if (!isObject(u) || !positive(u.from)) return null;
    const relations = (Array.isArray(u.relations) ? u.relations : []).slice(0, 40)
        .filter(x => isObject(x) && str(x.target, 120).trim())
        .map(x => ({ target: str(x.target, 120).trim(), before: x.before == null ? null : relationOf({ ...x.before, scope: 'chat' }) }));
    const closed = (Array.isArray(u.closed) ? u.closed : []).slice(0, 40).filter(c => Array.isArray(c) && typeof c[0] === 'string' && c[0]).map(([id, status]) => [str(id, 40), str(status, 20) || 'active']);
    return { from: u.from, relations, state: stateOf(u.state), closed };
}
const stateOf = s => (isObject(s) ? { mood: str(s.mood, 300).trim() || null, on_mind: strings(s.on_mind, 8, 300), wants: strings(s.wants, 8, 300) } : null);
const cardOf = c => Object.fromEntries(Object.entries(CARD_FIELDS).map(([k, max]) => [k, str(c?.[k], max).trim()]).filter(([, v]) => v));

export function newBrain({ name, aliases = [], pronouns = 'they', card = {}, personality = {}, build = 'full' }) {
    const t = new Date().toISOString();
    return {
        kiori: VERSION, id: newId('brn'), name: str(name, 120).trim(), aliases: strings(aliases, 20, 120),
        pronouns: ['she', 'he', 'they'].includes(pronouns) ? pronouns : 'they', build: build === 'light' ? 'light' : 'full',
        card: cardOf(card), personality: normalize(isObject(personality) ? personality : {}),
        memories: [], relations: [], state: { core: null, chat: null }, chat: { learned: 0, seen: [] },
        embed: null, created: t, updated: t,
    };
}

// A brain sent by a customer, checked field by field. What doesn't fit is dropped or set to its default; only what
// makes it not a brain at all is an error.
export function readBrain(input, label = 'brain') {
    if (typeof input === 'string') { try { input = JSON.parse(input); } catch { throw bad(`${label} is not valid JSON`); } }
    if (!isObject(input)) throw bad(`${label} must be a brain: the object POST /v1/brains returned`);
    if (input.kiori !== VERSION) throw bad(`${label} is not a Kiori brain${typeof input.kiori === 'number' && input.kiori > VERSION ? ' this server can read (it is from a newer version)' : ''}`);
    const name = str(input.name, 120).trim();
    if (!name) throw bad(`${label} has no name`);
    if (Array.isArray(input.memories) && input.memories.length > LIMITS.memories) throw bad(`${label} has more than ${LIMITS.memories} memories`);
    const ids = new Set();
    const memories = (Array.isArray(input.memories) ? input.memories : []).map(m => memoryOf(m, ids)).filter(Boolean);
    const relations = (Array.isArray(input.relations) ? input.relations : []).slice(0, LIMITS.relations).map(relationOf).filter(Boolean);
    const chat = isObject(input.chat) ? input.chat : {};
    const seen = (Array.isArray(chat.seen) ? chat.seen : [])
        .filter(s => Array.isArray(s) && positive(s[0]) && typeof s[1] === 'string')
        .map(([seq, fp, id]) => (id == null || id === '' ? [seq, fp.slice(0, 16)] : [seq, fp.slice(0, 16), str(id, 200)]))
        .sort((a, b) => a[0] - b[0]).slice(-LIMITS.seen);
    const learned = Math.max(positive(chat.learned) ?? 0, seen.at(-1)?.[0] ?? 0);
    const undo = (Array.isArray(chat.undo) ? chat.undo : []).map(undoOf).filter(Boolean).sort((a, b) => a.from - b.from).slice(-LIMITS.undo);
    const embedInfo = isObject(input.embed) && str(input.embed.model, 200) ? { model: str(input.embed.model, 200), dim: positive(input.embed.dim) ?? DIM } : null;
    return {
        kiori: VERSION, id: str(input.id, 40).trim() || newId('brn'), name, aliases: strings(input.aliases, 20, 120),
        pronouns: ['she', 'he', 'they'].includes(input.pronouns) ? input.pronouns : 'they', build: input.build === 'light' ? 'light' : 'full',
        card: cardOf(input.card), personality: normalize(isObject(input.personality) ? input.personality : {}),
        memories, relations,
        state: { core: stateOf(input.state?.core), chat: stateOf(input.state?.chat) },
        chat: { learned, seen, ...(undo.length && { undo }) }, embed: embedInfo,
        created: time(input.created), updated: time(input.updated),
    };
}

// The brains of a call: "brain" (one) or "brains" (a list, for a group chat). The answer mirrors what was sent.
export function readBrains(body) {
    if (body.brain != null && body.brains != null) throw bad('Send "brain" or "brains", not both');
    if (body.brains != null) {
        if (!Array.isArray(body.brains) || !body.brains.length) throw bad('brains must be a non-empty list');
        if (body.brains.length > LIMITS.brains) throw bad(`At most ${LIMITS.brains} brains in one call`);
        const brains = body.brains.map((b, i) => readBrain(b, `brains[${i}]`));
        const names = new Set();
        for (const b of brains) {
            if (names.has(norm(b.name))) throw bad(`Two brains are called "${b.name}": every character in one call needs its own name`);
            names.add(norm(b.name));
        }
        return { brains, single: false };
    }
    if (body.brain == null) throw bad('Send the brain: "brain" (or "brains" for a group chat), as POST /v1/brains returned it');
    return { brains: [readBrain(body.brain)], single: true };
}
export const answerWith = (out, brains, single) => (single ? { brain: brains[0], ...out } : { brains, ...out });

// The character a brain is, for the name tools in text.mjs (which match names and aliases)
export const characterOf = b => ({ id: b.id, name: b.name, aliases: b.aliases, card: b.card, pronouns: b.pronouns, personality: b.personality });

export const touch = brain => { brain.updated = new Date().toISOString(); return brain; };
// New card fields (from building, or from a conversation that showed who someone is) over the old ones
export function mergeCard(brain, patch) { brain.card = cardOf({ ...brain.card, ...(isObject(patch) ? patch : {}) }); }
export function setAliases(brain, list) { brain.aliases = [...new Set(strings(list, 20, 120))].filter(a => norm(a) !== norm(brain.name)); }
// Everything that hasn't been merged away; done plans stay (they were promised once)
export const embedText = m => `${m.title}. ${(m.keys ?? []).join(', ')}. ${m.body}`.replace(/\s+/g, ' ').slice(0, 700);
// A short hash of the text a memory's fingerprint was made from (its vh), so an edited memory's old fingerprint is told
// apart from a current one (FNV-1a)
export function textHash(m) {
    const t = embedText(m);
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
}
// A memory's meaning fingerprint while it still fits its text (one from before vh was kept is trusted), else null
export const freshVector = m => (m.v && (!m.vh || m.vh === textHash(m)) ? m.v : null);

// New memories into a brain, with links by title (within this brain). They get their meaning fingerprints from
// embedMissing, so a batch of them costs one embedding call.
export function addMemories(brain, items, { scope = 'core', links = [] } = {}) {
    const ids = new Set(brain.memories.map(m => m.id));
    const added = items.map(m => memoryOf({ ...m, scope, v: undefined, id: undefined }, ids)).filter(Boolean);
    brain.memories.push(...added);
    if (links.length) {
        const byTitle = new Map(brain.memories.map(m => [norm(m.title), m]));
        for (const l of links) {
            const a = byTitle.get(norm(l.from)), b = byTitle.get(norm(l.to));
            if (!a || !b || a === b) continue;
            a.links = [...new Set([...(a.links ?? []), b.id])].slice(0, 8);
        }
    }
    return added;
}

// The conversation's view of a person replaces the core one
export function getRelations(brain) {
    const byTarget = new Map();
    for (const r of [...brain.relations].sort((a, b) => (a.scope === b.scope ? 0 : a.scope === 'core' ? -1 : 1))) byTarget.set(norm(r.target), r);
    return [...byTarget.values()];
}
// The same relations with the ones the conversation is about first: the player, then the people met or seen anew in
// this chat, then the rest. Where a list for a prompt is cut short, these are the ones that stay.
export function closestFirst(relations, player) {
    const rank = r => (player && nameKey(r.target) === nameKey(player) ? 0 : r.scope === 'chat' ? 1 : 2);
    return [...relations].sort((a, b) => rank(a) - rank(b));
}
export function setRelation(brain, rel, scope = 'core') {
    const r = relationOf({ ...rel, scope });
    if (!r) return;
    const prev = getRelations(brain).find(x => norm(x.target) === norm(r.target));
    const next = { target: prev?.target ?? r.target, ...Object.fromEntries(RELATION_FIELDS.map(f => [f, r[f] ?? prev?.[f] ?? null])), note: r.note ?? prev?.note ?? null, scope };
    const i = brain.relations.findIndex(x => x.scope === scope && norm(x.target) === norm(r.target));
    if (i >= 0) brain.relations[i] = next;
    else brain.relations.push(next);
}

export const getState = brain => brain.state.chat ?? brain.state.core ?? { mood: null, on_mind: [], wants: [] };
export function setState(brain, s, scope = 'core') {
    const next = stateOf(s);
    if (!next) return;
    const prev = getState(brain);
    brain.state[scope] = { mood: next.mood ?? prev.mood, on_mind: next.on_mind.length ? next.on_mind : prev.on_mind, wants: next.wants.length ? next.wants : prev.wants };
}

// A name as people write it, for matching ("Leo (the player)" → "Leo")
export const nameKey = n => norm(bareName(n));
