// Organizing: as a chat moves on, each brain learns what it witnessed. The customer sends the brains and the chat's
// recent messages as they are now (OpenAI-style, ideally with their own message ids), oldest first. Kiori lines them
// up with what each brain already learned (a brain keeps the fingerprints of the last messages it learned), notices an
// edit, a reroll or a deletion of something learned and takes back what it taught, and learns what's new and settled.
// The newest few messages wait (they're the ones still being rerolled), and learning waits for a handful of settled
// ones, so calling this after every reply costs nothing most of the time.
//
// The organizer writes the memories, from each character's own point of view and only from the scenes they were in.
// The auditor then keeps only what the messages prove: every memory, fact, plan or forgetting must quote the words it
// comes from, or it is not written.
import { config } from './config.mjs';
import { askJSON, requireModelKey } from './llm.mjs';
import { evidenceFound, norm, textOf, num, tokens, whoIs, sameCharacter, samePerson, mentions, bareName, firstSentence } from './text.mjs';
import { fingerprint, characterOf, addMemories, setRelation, setState, getRelations, getState, closestFirst, mergeCard, touch, answerWith, RELATION_FIELDS, LIMITS } from './brainfile.mjs';
import { placeEvents, modeOf, perceived, presentOf, placementChunks, eventLine, speakersIn, MODES } from './scenes.mjs';
import { searchMemories, queryVectors, vectorFor, playerName, embedMissing } from './recall.mjs';
import { profile } from './personality.mjs';
import { decay, consolidate } from './sleep.mjs';

const quoted = { type: 'string', description: 'The exact words from the scenes this comes from (copy 6-20 words verbatim)' };
// How they know it: a claim, not the source stored (that is worked out from the message the quote is in)
const SOURCE = {
    how: { type: 'string', enum: ['saw', 'heard', 'told', 'read', 'inferred'], description: 'How they came to know it: saw it happen, heard it said, were told it, read it, or worked it out' },
    via: { type: 'string', description: 'If the speaker was passing on what someone else said, that person; else ""' },
    confidence: { type: 'number', description: '0-1, only when they doubt it' },
};
const SCHEMA = {
    type: 'object',
    properties: {
        memories: {
            type: 'array',
            description: '1-6 memories (more for a long stretch): first person, in their voice; each starts with one plain factual sentence (when, where, who, what happened), then what they felt',
            items: {
                type: 'object',
                properties: {
                    title: { type: 'string' }, body: { type: 'string' },
                    keys: { type: 'array', items: { type: 'string' } }, about: { type: 'array', items: { type: 'string' } },
                    importance: { type: 'number', description: '0-1, how much this matters to THEM (their personality and how much they care about the people involved decide)' },
                    emotion: { type: 'number', description: '0-1, how intense it felt' },
                    evidence: quoted, ...SOURCE,
                },
                required: ['title', 'body', 'keys', 'about', 'importance', 'emotion', 'evidence'],
            },
        },
        facts: {
            type: 'array', description: 'Things they now know, or were told, that they did not before (an identity, a secret, a fact about someone), one per item',
            items: { type: 'object', properties: { about: { type: 'string' }, fact: { type: 'string' }, evidence: quoted, ...SOURCE }, required: ['about', 'fact', 'evidence'] },
        },
        relations: {
            type: 'array', description: 'Only people whose place in their heart changed; 0-100. Trust rises slowly and falls fast.',
            items: { type: 'object', properties: { target: { type: 'string' }, trust: { type: 'number' }, closeness: { type: 'number' }, respect: { type: 'number' }, resentment: { type: 'number' }, attraction: { type: 'number' }, note: { type: 'string', description: 'One sentence, their view of that person now' } }, required: ['target', 'trust', 'closeness', 'respect', 'resentment', 'attraction', 'note'] },
        },
        state: { type: 'object', properties: { mood: { type: 'string' }, on_mind: { type: 'array', items: { type: 'string' } }, wants: { type: 'array', items: { type: 'string' } } }, required: ['mood', 'on_mind', 'wants'] },
        intentions: {
            type: 'array', description: 'Plans, promises or dates they now carry',
            items: { type: 'object', properties: { title: { type: 'string' }, body: { type: 'string' }, importance: { type: 'number' }, evidence: quoted }, required: ['title', 'body', 'importance', 'evidence'] },
        },
        finished: { type: 'array', items: { type: 'string' }, description: 'Titles of their existing plans that were done or dropped here' },
        told: {
            type: 'array', description: 'Only when THEY passed on to someone there what someone else said, a secret, or a lie: whom they told and what they said',
            items: { type: 'object', properties: { to: { type: 'array', items: { type: 'string' } }, said: { type: 'string' }, lie: { type: 'boolean', description: 'Only if they knew it was false' }, truth: { type: 'string', description: 'For a lie: the exact words from the scenes that show the truth, or the truth in one sentence when truth_ref gives the memory that holds it' }, truth_ref: { type: 'string', description: 'For a lie: the [id] of the memory below that holds the truth; else ""' }, evidence: quoted }, required: ['to', 'said', 'lie', 'evidence'] },
        },
        forgot: {
            type: 'array', description: 'Only if something made THEM forget (a memory wipe, amnesia, a spell): exactly what is gone',
            items: { type: 'object', properties: { what: { type: 'string' }, evidence: quoted }, required: ['what', 'evidence'] },
        },
        card: {
            type: 'object', description: 'Only if their card below is empty: who they are, looks, personality, voice, from what the scenes show',
            properties: { who: { type: 'string' }, looks: { type: 'string' }, personality: { type: 'string' }, voice: { type: 'string' } }, required: ['who', 'looks', 'personality', 'voice'],
        },
    },
    required: ['memories', 'facts', 'relations', 'state', 'intentions', 'finished', 'forgot', 'card'],
};

const KNOWN_AS = { secret: '(their secret) ', told: '(what they told) ' };
function prompt({ c, player, events, known, relations, state, plans, forgot }) {
    const card = c.card ?? {};
    const hasCard = Boolean(card.who || card.personality || card.description);
    return `You are the memory of ${c.name}, processing what just happened to them, the way a real person's brain does in sleep. Below are ONLY the scenes ${c.name} was in.

How memory works here:
- They know only what happened in front of them or was said to them out loud. A message at the edge of a scene can also narrate what happened before they arrived or after they left (someone running from another room, a night before, a talk elsewhere): they know none of that. Never write "after he saw X" or anything they couldn't have witnessed.
- Narration (STORY lines, and the narration inside a reply) is what really happened. What people say is a claim: ${c.name} believes it or not according to how much they trust the speaker. A shared past the player only claims in dialogue, that isn't in their memories, is not a fact.
- For each item, say how they came to know it. Someone telling them something is not them seeing it: if Tom says what Mira did, they know Tom said it.
- A message marked as only heard, overheard or seen without the words is all they got of it. Never fill in what they missed; a half-heard thing is a vague memory, and they know they only half heard it.
- Their personality and how much they care about the people involved decide what matters: a small thing from someone they love becomes an anchor, a gesture from someone they dislike stays faint.
- Keep the concrete details that will matter later: where, who, what exactly, the order of events, names, numbers, promises, what was given. Use every name exactly as the story gives it; never mix two people's names.
- ${player} is the player's character. ${c.name} knows about them only what these scenes show.
- If ${c.name} themself said something that their memories or these scenes show they know is false, it's a lie: add it to told with lie: true, who they said it to, and the truth (quote where the truth shows, or the id of the memory that holds it). A mistake isn't a lie: only when they knew.
- When something they believed is shown false in front of them, write what they now know, and in the body that they were lied to and by whom. What they believed before stays a memory: people remember the lie too.
- Every memory, fact, plan and forgetting must quote the exact words from the scenes it comes from (copy them verbatim). Without a real quote it will be discarded.
- Write everything in English.

${c.name.toUpperCase()}'S CARD:
${hasCard ? [card.who, card.personality && `Personality: ${card.personality}`, card.core && `Core: ${card.core}`, !card.who && card.description && card.description.slice(0, 2500)].filter(Boolean).join('\n') : '(empty: fill "card" from the scenes)'}

HOW THEY DIFFER FROM AN AVERAGE PERSON:
${profile(c.personality, { pronouns: c.pronouns, max: 8 })}

THEIR FEELINGS TOWARD PEOPLE SO FAR:
${closestFirst(relations, player).slice(0, 12).map(r => `- ${r.target}: ${RELATION_FIELDS.filter(f => r[f] != null).map(f => `${f} ${r[f]}`).join(', ')}${r.note ? `. ${r.note}` : ''}`).join('\n') || '(none)'}

THEIR STATE BEFORE: ${[state.mood, state.on_mind.join('; ')].filter(Boolean).join(' / ') || '(unknown)'}
THEIR OPEN PLANS: ${plans.join('; ') || '(none)'}
${forgot.length ? `THEY WERE MADE TO FORGET (nothing may show they still know it): ${forgot.join('; ')}\n` : ''}
WHAT THEY ALREADY REMEMBER THAT THIS TOUCHES (don't write these again; build on them):
${known.map(m => `- [${m.id}] ${KNOWN_AS[m.kind] ?? ''}${m.title}: ${m.body.slice(0, 220)}${m.lie && m.truth ? ` (the truth: ${m.truth.slice(0, 200)})` : ''}`).join('\n') || '(nothing yet)'}

THE SCENES ${c.name.toUpperCase()} WAS IN:
${events.map(e => eventLine(e)).join('\n\n')}`;
}

const bad = message => Object.assign(new Error(message), { status: 400, code: 'BAD_REQUEST' });
// A memory id as a model writes it back: "m_abc" or "[m_abc]"
const bareRef = r => String(r ?? '').trim().replace(/^\[(.*)\]$/, '$1').trim();
const FINAL = ['CREDITS', 'NO_KEY', 'NEEDS_KEY', 'BAD_KEY'];
const ROLE = { user: 'player', human: 'player', player: 'player', assistant: 'narrator', ai: 'narrator', bot: 'narrator', model: 'narrator', narrator: 'narrator', character: 'character' };
export const MAX_MESSAGES = 400;

// The chat's messages as events, numbered by their place in the call (n). System and tool messages, and empty ones,
// are not part of the story. The player's messages carry the player's name; with one character (solo), a reply without
// a name is theirs. role "narrator" is narration: what happened, in nobody's voice. Of a longer list, the newest
// MAX_MESSAGES are read (lining up and learning only need the recent part). at: the message's place in the list sent,
// from 1, for answers that point back at it.
export function eventsOf(messages, { player, solo = null }) {
    if (!Array.isArray(messages)) throw bad('messages must be a list, oldest first');
    const skipped = Math.max(0, messages.length - MAX_MESSAGES);
    if (skipped) messages = messages.slice(-MAX_MESSAGES);
    const out = [];
    for (const [k, m] of messages.entries()) {
        if (!m || typeof m !== 'object' || Array.isArray(m)) throw bad('each message must be an object: { id, role, content }');
        const given = String(m.role ?? '').toLowerCase();
        let role = ROLE[given];
        const text = textOf(m.content ?? m.text).trim().slice(0, 20000);
        if (!role || !text) continue;
        const named = typeof (m.name ?? m.speaker) === 'string' ? String(m.name ?? m.speaker).trim().slice(0, 120) : '';
        let speaker = null;
        if (role === 'player') speaker = player;
        else if (named) { role = 'character'; speaker = named; }
        else if (solo && given !== 'narrator') { role = 'character'; speaker = solo; }
        // Who was there: names (full), or { name, mode }. At most 50 people in one message: more is no scene, and each
        // name is looked up for every brain
        let present = null;
        const modes = {};
        if (Array.isArray(m.present)) {
            const names = new Map();
            for (const x of m.present) {
                const person = x && typeof x === 'object' && !Array.isArray(x);
                const name = String((person ? x.name : x) ?? '').trim().slice(0, 120), mode = person && x.mode != null ? String(x.mode) : 'full';
                if (!MODES.includes(mode)) throw bad(`present: a mode is one of ${MODES.join(', ')}`);
                if (!name || names.has(norm(name)) || names.size >= 50) continue;
                names.set(norm(name), name);
                if (mode !== 'full') modes[norm(name)] = mode;
            }
            present = [...names.values()];
        }
        out.push({ n: out.length + 1, at: skipped + k + 1, id: m.id == null || m.id === '' ? null : String(m.id).slice(0, 200), role, speaker, text, present, modes, scene: null, fp: fingerprint(role, text) });
    }
    return out;
}

// The player's name: as sent ("player"), else the name on their messages, else "Player"
export const playerOf = (body) => playerName(body.player)
    ?? (Array.isArray(body.messages) ? body.messages.find(m => /^(user|human|player)$/i.test(String(m?.role ?? '')) && typeof m.name === 'string' && m.name.trim())?.name.trim().slice(0, 120) : null)
    ?? 'Player';

// Where a brain's learning stands in this list of messages: the index of the first message it hasn't learned (start),
// the number that message gets in the brain (seq), and, when a message it learned was edited, rerolled or deleted, the
// number to unlearn from (rewindFrom). Lined up by message id when both sides have one, else by fingerprint.
// The list and what the brain learned overlap from the start of one of them: the list's first message is somewhere in
// what was learned, or the first message learned is somewhere in the list. Of the places where they meet like that,
// the longest unchanged run wins; so a text or an id that comes up again later (a "Continue.", a send date shared by
// two messages) can't pull the alignment off. Only when they don't meet like that (the list's first messages were
// edited) is any meeting place taken, the first one in the list.
export function lineUp(brain, events) {
    const seen = brain.chat.seen.map(([seq, fp, id]) => ({ seq, fp, id: id ?? null }));
    const fresh = { start: 0, seq: brain.chat.learned + 1, rewindFrom: null };
    if (!seen.length) return fresh;
    const same = (e, s) => (e.id && s.id ? e.id === s.id : e.fp === s.fp);
    const unchanged = (e, s) => same(e, s) && e.fp === s.fp;
    const runAt = (i, j) => { let run = 0; while (i + run < events.length && j + run < seen.length && unchanged(events[i + run], seen[j + run])) run++; return run; };
    let best = null;
    const consider = (i, j) => { if (same(events[i], seen[j])) { const run = runAt(i, j); if (!best || run > best.run) best = { i, j, run }; } };
    for (let j = 0; j < seen.length && events.length; j++) consider(0, j);
    for (let i = 1; i < events.length; i++) consider(i, 0);
    for (let i = 0; i < events.length && !best; i++) for (let j = 0; j < seen.length; j++) consider(i, j);
    // The list doesn't touch what was learned: everything in it is new (a client that sends only the new messages)
    if (!best) return fresh;
    const { i: i0, j: j0, run: kept } = best;
    if (j0 + kept >= seen.length) return { start: i0 + kept, seq: brain.chat.learned + 1, rewindFrom: null };
    // A learned message changed or is gone: from there on the brain unlearns, and the list is new from that point
    const seq = seen[j0 + kept].seq;
    return { start: i0 + kept, seq, rewindFrom: seq };
}

// Taking back what changed messages taught: the memories of every learning pass that read any of them go, and learning
// starts again where that pass began (the rest of the conversation stays, so nothing else is forgotten meanwhile).
// Feelings, mood and plans go back to how they were before the first pass taken back (from each pass's undo record;
// a pass from before such records keeps what it did, for the next pass to rewrite). Returns the first number learned
// again.
export function rewind(brain, from) {
    const gone = new Set(brain.memories.filter(m => m.scope === 'chat' && (m.to ?? m.from ?? 0) >= from).map(m => m.id));
    const start = Math.min(from, ...brain.memories.filter(m => gone.has(m.id) && m.from).map(m => m.from));
    brain.memories = brain.memories.filter(m => !gone.has(m.id));
    for (const m of brain.memories) if (m.links) { m.links = m.links.filter(id => !gone.has(id)); if (!m.links.length) delete m.links; }
    // Newest pass first, so what the earliest pass taken back found is what stays
    const undo = brain.chat.undo ?? [];
    for (const u of [...undo].reverse()) {
        if (u.from < start) break;
        for (const { target, before } of u.relations) {
            const i = brain.relations.findIndex(x => x.scope === 'chat' && norm(x.target) === norm(target));
            if (i >= 0) brain.relations.splice(i, 1);
            if (before) brain.relations.push(before);
        }
        brain.state.chat = u.state;
        for (const [id, status] of u.closed) { const m = brain.memories.find(x => x.id === id); if (m) m.status = status; }
    }
    const kept = undo.filter(u => u.from < start);
    if (kept.length) brain.chat.undo = kept;
    else delete brain.chat.undo;
    brain.chat.learned = Math.max(0, start - 1);
    brain.chat.seen = brain.chat.seen.filter(([seq]) => seq < start);
    if (!brain.chat.learned) brain.state.chat = null;
    return { from: start, forgot: gone.size };
}

// A long stretch is learned in order, piece by piece: each piece is one model call of at most 24 scenes and about 30k
// characters, and builds on what the pieces before it wrote
export const learningBatches = events => placementChunks(events, { maxEvents: 24, maxChars: 30000 });

// Moves a brain's place in the conversation forward to seq, remembering the fingerprints of what it went through
function advance(brain, mine, seq) {
    const passed = mine.filter(e => e.seq > brain.chat.learned && e.seq <= seq).map(e => (e.id ? [e.seq, e.fp, e.id] : [e.seq, e.fp]));
    brain.chat.seen = [...brain.chat.seen, ...passed].slice(-LIMITS.seen);
    brain.chat.learned = Math.max(brain.chat.learned, seq);
}

// Where a quote comes from: the first message that holds it, else the first two in a row that do (a quote across two
// lines), else the first message with its first word. null: the scenes don't hold it, and the item isn't written.
const lineOf = e => `${e.speaker ?? ''}: ${e.text}`;
function locate(quote, batch, scenes) {
    if (!evidenceFound(quote, scenes)) return null;
    const first = tokens(quote)[0];
    return batch.find(e => evidenceFound(quote, lineOf(e)))
        ?? batch.find((e, i) => i + 1 < batch.length && evidenceFound(quote, `${lineOf(e)}\n${lineOf(batch[i + 1])}`))
        ?? batch.find(e => tokens(e.text).includes(first)) ?? batch[0];
}
// Who said the quoted words: the message's speaker, or the "Name:" line of a narrator's message that holds them
function saidBy(e, quote) {
    if (e.role !== 'narrator') return e.speaker;
    const line = e.text.split('\n').find(l => evidenceFound(quote, l));
    return (line && speakersIn(line)[0]) || null;
}
const NARRATED = ['saw', 'read', 'inferred'], SPOKEN = ['heard', 'told', 'inferred'];
// What a message taken in only partly allows: only heard, it was heard or told; overheard, overheard; only seen, seen
const PARTLY = { heard: ['heard', 'told'], overheard: ['overheard'], saw: ['saw'] }, CAP = { heard: 0.85, overheard: 0.4 };
const BELIEF = { saw: 1, read: 0.9, heard: 0.85, told: 0.85, overheard: 0.4, inferred: 0.5, rumor: 0.5 };
// Two messages of one scene: as placed, or, with presence sent, with the same people there
const people = e => (e.present ?? []).map(norm).sort().join('\u0000');
const sameScene = (a, b) => (a.scene || b.scene ? a.scene === b.scene : people(a) === people(b));
// How a character knows an item, worked out from the message its quote is in, not taken from the model: narration (or
// an action in *stars*, or their own line) is seen, someone's line is heard from them. The person the teller quoted
// stays only when that message names them, or one of the two just before it in the same scene that they took in too
// (narration, or the teller's own), and is neither the teller nor themself. A message they took in only partly decides
// it (e.mode). Confidence comes from how, and from how much they trusted the teller before this pass; the model may
// only lower it.
function provenance(item, e, { self, scope, trust, batch }) {
    let by = e.mode === 'saw' ? null : saidBy(e, item.evidence);
    if (by && (sameCharacter(whoIs(by, scope), self) || [...e.text.matchAll(/\*([^*\n]+)\*/g)].some(m => evidenceFound(item.evidence, m[1])))) by = null;
    const allowed = PARTLY[e.mode] ?? (by ? SPOKEN : NARRATED);
    const source = { how: allowed.includes(item.how) ? item.how : allowed[0], ...(by && { by }), at: e.seq };
    const via = bareName(item.via);
    const named = x => mentions(x.text, { name: via });
    const before = batch.filter(x => x.seq < e.seq && x.seq >= e.seq - 2 && sameScene(x, e) && (x.role === 'narrator' || (by && x.speaker && samePerson(x.speaker, by))));
    if (via && (named(e) || before.some(named)) && !(by && samePerson(via, by)) && ![self.name, ...self.aliases].some(n => samePerson(n, via))) source.origin = via;
    let confidence = Math.min(by && source.origin ? 0.7 : BELIEF[source.how], CAP[e.mode] ?? 1);
    if (by) confidence *= 0.6 + 0.4 * trust(by) / 100;
    // A 0 is how models leave a number empty, so only a doubt above it counts
    if (item.confidence > 0) confidence = Math.min(confidence, item.confidence);
    return { source, confidence: Math.round(confidence * 100) / 100 };
}

// What they already remember that a stretch touches: the best search hits; when they speak in it, what each of their
// own lines brings up and what they lived just before it (the truth behind a lie is often far from the rest of the
// stretch, and most often what they just did); and always their secrets whose keys come up in it and what they told
// about its topic (a lie above all), so the organizer can tell a lie from a mistake. A few of each at most: the prompt
// stays about the size it was.
function knownFor(brain, text, qv, own = [], from = Infinity) {
    const hits = searchMemories(brain, text, qv, { limit: 10 });
    const words = new Set(tokens(text)), has = new Set(hits.map(m => m.id)), lines = [];
    const add = m => { if (lines.length < 20 && !has.has(m.id)) { has.add(m.id); lines.push(m); } };
    for (const line of own) searchMemories(brain, line.text, line.qv, { limit: 6 }).forEach(add);
    const chat = brain.memories.filter(m => m.scope === 'chat' && m.to < from && ['memory', 'fact'].includes(m.kind)), last = Math.max(0, ...chat.map(m => m.to));
    if (own.length) chat.filter(m => m.to === last).sort((a, b) => b.importance - a.importance).slice(0, 4).forEach(add);
    const touches = list => list.some(w => words.has(w));
    const more = kind => brain.memories.filter(m => m.kind === kind && m.status !== 'done' && !has.has(m.id)
        && touches(kind === 'secret' ? m.keys.flatMap(tokens) : tokens(`${m.said ?? ''} ${m.truth ?? ''}`).filter(w => w.length >= 4)));
    const told = more('told').sort((a, b) => Number(!!b.lie) - Number(!!a.lie));
    return [...hits, ...lines, ...more('secret').slice(0, 5), ...told.slice(0, 5)];
}
// Their own lines in a stretch: their messages, and their "Name:" lines in a narrator's
const ownLines = (batch, self, scope) => batch.flatMap(e => (e.role === 'narrator' ? e.text.split('\n') : [e.text])
    .filter(l => { const by = e.role === 'narrator' ? speakersIn(l)[0] : e.speaker; return l.trim() && by && sameCharacter(whoIs(by, scope), self); }));

async function learnBatch(project, brain, batch, player, scope) {
    const text = batch.map(e => e.text).join('\n'), self = characterOf(brain), own = ownLines(batch, self, scope);
    // One embedding call for the stretch and each of their own lines
    const [qv, ...vs] = await queryVectors(project, [brain], [text, ...own]);
    const known = knownFor(brain, text, vectorFor(project, brain, qv), own.map((t, i) => ({ text: t, qv: vectorFor(project, brain, vs[i]) })), batch[0].seq);
    const plans = brain.memories.filter(m => m.kind === 'intention' && m.status === 'active').map(m => m.title);
    const forgot = brain.memories.filter(m => m.kind === 'forgot').map(m => m.body);
    const r = await askJSON({
        role: 'organizer', project, op: 'learn', schema: SCHEMA, maxTokens: 6000,
        prompt: prompt({ c: brain, player, events: batch, known, relations: getRelations(brain), state: getState(brain), plans, forgot }),
    });

    // The auditor at write time: only what the scenes prove is kept, as the character took them in. A word they missed
    // everywhere in them can't be in a quote, however close the rest of the quote is
    const scenes = batch.map(lineOf).join('\n');
    const missed = new Set(batch.flatMap(e => e.missed ?? []));
    for (const w of tokens(scenes)) missed.delete(w);
    const proven = q => evidenceFound(q, scenes) && !tokens(q).some(w => missed.has(w));
    const dropped = { memories: 0, facts: 0, intentions: 0, forgot: 0, told: 0 };
    const keep = (list, key) => list.filter(x => (proven(x.evidence) ? true : (dropped[key]++, false)));
    const span = { from: batch[0].seq, to: batch.at(-1).seq };
    const relations = getRelations(brain);
    const trust = name => relations.find(x => samePerson(bareName(x.target), bareName(name)))?.trust ?? 50;
    // Memories and facts with where they came from: the message their quote is in
    const sourced = (list, key) => list.flatMap(x => { const e = proven(x.evidence) && locate(x.evidence, batch, scenes); return e ? [{ x, ...provenance(x, e, { self, scope, trust, batch }) }] : (dropped[key]++, []); });
    const memories = sourced(r.memories, 'memories').map(({ x, source, confidence }) => ({ ...x, kind: 'memory', ...span, source, confidence }));
    const facts = sourced(r.facts, 'facts').map(({ x: f, source, confidence }) => ({ kind: 'fact', title: f.fact.slice(0, 120), body: f.fact, about: [f.about], importance: 0.7, emotion: 0.2, ...span, evidence: f.evidence, source, confidence }));
    // What they passed on: only from their own line, and only to people who were there to hear it (in full, or on the
    // phone: not through a wall, not only seeing it, not asleep). A lie needs its truth: quoted from the scenes, or a
    // memory of theirs that holds it (its id, a secret too, or one whose words the truth quotes); without either it is
    // kept as a plain record of what they said
    const there = (e, name) => {
        const c = whoIs(name, scope), n = c ? null : (e.present ?? []).find(x => samePerson(bareName(x), name));
        const mode = c ? modeOf(e, c, scope) : n == null ? null : e.modes?.[norm(n)] ?? 'full';
        return mode === 'full' || mode === 'heard';
    };
    const told = r.told.flatMap(t => {
        const e = proven(t.evidence) && locate(t.evidence, batch, scenes), to = [...new Set(t.to.map(bareName).filter(Boolean))].slice(0, 12), said = t.said.trim() || t.evidence;
        if (!e || !to.length || !sameCharacter(whoIs(saidBy(e, t.evidence) ?? '', scope), self) || to.some(n => samePerson(n, self.name) || !there(e, n))) return (dropped.told++, []);
        const quote = String(t.truth ?? '').trim();
        const ref = t.lie !== true ? null : brain.memories.find(m => m.id === bareRef(t.truth_ref) && m.kind !== 'told')
            ?? (quote && !proven(quote) ? brain.memories.find(m => !['told', 'forgot', 'mind'].includes(m.kind) && evidenceFound(quote, `${m.title}\n${m.body}`)) : null);
        const lie = t.lie === true && (proven(t.truth) || !!ref);
        const truth = lie ? quote || firstSentence(ref.body) : null;
        return [{
            kind: 'told', title: `${lie ? 'Lied to' : 'Told'} ${to.join(', ')}: ${said}`.slice(0, 120), body: `I told ${to.join(', ')}: "${said}"${lie ? `. It was a lie: ${truth}` : ''}`,
            about: to, told_to: to, said, lie, ...(lie && { truth, ...(ref && { truth_ref: ref.id }) }), importance: lie ? 0.7 : 0.5, emotion: 0.2, evidence: t.evidence, ...span, source: { how: 'saw', at: e.seq },
        }];
    });
    const intentions = keep(r.intentions, 'intentions').map(i => ({ kind: 'intention', title: i.title, body: i.body, importance: i.importance, ...span, evidence: i.evidence }));
    const forgets = keep(r.forgot, 'forgot').map(f => ({ kind: 'forgot', title: `Forgot: ${f.what}`.slice(0, 120), body: f.what, importance: 1, strength: 1, ...span, evidence: f.evidence }));
    addMemories(brain, [...memories, ...facts, ...intentions, ...forgets, ...told], { scope: 'chat' });
    // What this pass changes in feelings, mood and plans is kept as it was before, so a rewind past the pass puts it back
    const undo = { from: span.from, relations: [], state: brain.state.chat, closed: [] };
    for (const rel of r.relations) {
        if (!rel.target || norm(rel.target) === norm(brain.name)) continue;
        if (!undo.relations.some(x => norm(x.target) === norm(rel.target))) undo.relations.push({ target: rel.target, before: brain.relations.find(x => x.scope === 'chat' && norm(x.target) === norm(rel.target)) ?? null });
        setRelation(brain, rel, 'chat');
    }
    setState(brain, r.state, 'chat');
    const done = new Set(r.finished.map(norm));
    for (const m of brain.memories) if (m.kind === 'intention' && m.scope === 'chat' && m.status !== 'done' && done.has(norm(m.title))) { undo.closed.push([m.id, m.status ?? 'active']); m.status = 'done'; }
    brain.chat.undo = [...(brain.chat.undo ?? []), undo].slice(-LIMITS.undo);
    if (!brain.card.who && r.card?.who) mergeCard(brain, r.card);
    decay(brain);
    await embedMissing(project, brain);
    return { written: memories.length + facts.length + intentions.length + forgets.length + told.length, dropped };
}

// One brain learns its new stretch (events, in order; the first gets number seq), each message as they took it in:
// asleep, or not there, they learn nothing from it
async function learnBrain(project, brain, events, seq, { player, cast }) {
    const mine = events.map((e, k) => ({ ...e, seq: seq + k }));
    const character = characterOf(brain);
    const witnessed = mine.map(e => perceived(e, character, { story: cast, everyone: cast, player })).filter(Boolean);
    const out = { name: brain.name, from: mine[0].seq, to: mine.at(-1).seq, messages: witnessed.length, written: 0, dropped: { memories: 0, facts: 0, intentions: 0, forgot: 0, told: 0 } };
    let pieces = 0;
    for (const batch of learningBatches(witnessed)) {
        let r;
        try { r = await learnBatch(project, brain, batch, player, { story: cast, everyone: cast, player }); }
        catch (e) {
            // A piece further on failed: what the pieces before it taught is kept and goes back with the brain, and the
            // next call resumes at this piece. (When nothing was learned yet, or the key or credits are the problem,
            // the error stands.)
            if (!pieces || FINAL.includes(e.code)) throw e;
            out.to = batch[0].seq - 1;
            out.stopped = e.message;
            return out;
        }
        pieces++;
        out.written += r.written;
        for (const k of Object.keys(out.dropped)) out.dropped[k] += r.dropped[k];
        // Progress is kept after every piece, so a failure further on resumes from here
        advance(brain, mine, batch.at(-1).seq);
    }
    advance(brain, mine, mine.at(-1).seq);
    return out;
}

// POST /v1/brains/organize
export async function organize(project, brains, single, body) {
    if (body.messages == null) throw bad('messages is required: the chat\'s recent messages as they are now, oldest first');
    const player = playerOf(body);
    const events = eventsOf(body.messages, { player, solo: brains.length === 1 ? brains[0].name : null });
    const hold = num(body.hold, config.learnHold, 0, 50);
    const every = body.now === true ? 1 : num(body.every, config.learnEvery, 1, 200);
    // The newest `hold` messages wait; everything before them is settled and may be learned now
    const settled = Math.max(0, events.length - hold);
    const warnings = [], rewound = [];
    if (body.messages.length > MAX_MESSAGES) warnings.push(`Only the last ${MAX_MESSAGES} of the ${body.messages.length} messages were read: the recent ones are enough (60 is plenty)`);
    const plans = brains.map(brain => {
        const at = lineUp(brain, events);
        let start = at.start;
        if (at.rewindFrom) {
            const r = rewind(brain, at.rewindFrom);
            rewound.push({ name: brain.name, from: r.from, forgot: r.forgot });
            // What the undone pass read before the changed message is learned again, if this list still has it
            start = at.start - (at.rewindFrom - r.from);
            if (start < 0) {
                warnings.push(`${brain.name}: ${-start} earlier messages couldn't be learned again (send more of the chat to keep them)`);
                brain.chat.learned += -start;
                start = 0;
            }
        }
        return { brain, start, seq: brain.chat.learned + 1 };
    });
    let due = plans.filter(p => settled - p.start >= every);
    if (due.length) requireModelKey(project);
    const cast = brains.map(characterOf);
    let placed = [];
    if (due.length) {
        const first = Math.min(...due.map(p => p.start));
        const stretch = events.slice(first, settled);
        // One character: whatever happens in the chat happens in front of them and the player, unless the app asks for
        // placing (place: true), which costs a call
        if (brains.length === 1 && body.place !== true) for (const e of stretch) e.present ??= [brains[0].name, player];
        else {
            // What Kiori places here goes back as placed: sent back as present, it is never placed again
            const unplaced = stretch.filter(e => !e.present);
            try {
                await placeEvents(project, stretch, { before: events.slice(Math.max(0, first - 4), first), characters: cast, player });
                placed = unplaced.map(e => ({ ...(e.id && { id: e.id }), n: e.at, present: presentOf(e), scene: e.scene }));
            }
            catch (e) {
                if (FINAL.includes(e.code)) throw e;
                warnings.push(`Couldn't work out who was in each scene (${e.message}); learning waits for the next call`);
                due = [];
            }
        }
    }
    const learned = [];
    const queue = [...due];
    const worker = async () => {
        for (let p; (p = queue.shift());) {
            try {
                const { stopped, ...l } = await learnBrain(project, p.brain, events.slice(p.start, settled), p.seq, { player, cast });
                if (stopped) warnings.push(`${p.brain.name}: learning stopped after message ${l.to} (${stopped}); what came before is kept, and the next call goes on from there`);
                learned.push(l);
            } catch (e) {
                if (FINAL.includes(e.code)) throw e;
                warnings.push(`${p.brain.name}: learning failed (${e.message}); what was learned so far is kept`);
            }
        }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (due.length && !learned.length && warnings.length) throw Object.assign(new Error(warnings.join('; ')), { status: 502, code: 'PROVIDER' });
    for (const p of due) {
        try { await consolidate(project, p.brain); }
        catch (e) { if (FINAL.includes(e.code)) throw e; }
    }
    for (const b of brains) if (learned.some(l => l.name === b.name) || rewound.some(r => r.name === b.name)) touch(b);
    const waiting = Math.max(0, ...plans.filter(p => !due.includes(p)).map(p => settled - p.start));
    return answerWith({ learned, rewound, waiting, held: Math.min(hold, events.length), placed, ...(warnings.length && { warnings }) }, brains, single);
}
