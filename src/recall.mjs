// Recall: what a character has in mind for this moment. No model writes anything here; it is search over the
// character's own brain: words weighted by how rare they are in this brain, meaning (embeddings), strength and
// importance, and a pull toward memories about the people in the best hits. The brain is only read, never changed.
import { tokens, norm, firstSentence, textOf, num, mentionsThePast } from './text.mjs';
import { embed, credentialsFor } from './llm.mjs';
import { unpackVector, packVector, cosine, getRelations, getState, closestFirst, embedText, textHash, freshVector, DIM, RELATION_FIELDS } from './brainfile.mjs';
import { profile, mindFor, inThisPerson } from './personality.mjs';

const CHAT_ROLES = /^(system|tool|function|developer)$/i;
// The moment to recall for: the query, or the last six messages of the chat (their last 4000 characters, the words
// that are said now). Every memory is matched against it, so it is kept that size whatever is sent.
const MOMENT = 4000;
export function momentText(body) {
    if (typeof body.query === 'string' && body.query.trim()) return body.query.slice(0, MOMENT);
    if (!Array.isArray(body.messages)) return '';
    return body.messages.filter(m => typeof m === 'string' || !CHAT_ROLES.test(String(m?.role ?? ''))).slice(-6).map(m => (typeof m === 'string' ? m : textOf(m?.content ?? m?.text))).join('\n').slice(-MOMENT);
}
// The player's name, from "player": "Leo" or { "name": "Leo" }
export const playerName = p => String((p && typeof p === 'object' ? p.name : p) ?? '').trim().slice(0, 120) || null;

// The moment's meaning fingerprint, made once for every brain in the call that can use it (same embedding model)
export async function queryVector(project, brains, text) {
    const model = credentialsFor(project).embed;
    if (!String(text).trim() || !brains.some(b => b.embed?.model === model && b.memories.some(m => m.v))) return null;
    const v = (await embed([String(text).slice(0, 2000)], project))?.[0];
    // Shortened and rounded the way the brain's own fingerprints are, so the two compare
    return v ? unpackVector(packVector(v)) : null;
}
// The query vector for one brain: only when its fingerprints come from the same model
export const vectorFor = (project, brain, qv) => (qv && brain.embed?.model === credentialsFor(project).embed ? qv : null);

// Memories without a meaning fingerprint (new ones, edited ones, or ones made with another embedding model) get one,
// with the hash of the text it was made from. Without a model key, or when embeddings are off, they stay without:
// recall then goes by words.
export async function embedMissing(project, brain) {
    const model = credentialsFor(project).embed;
    if (brain.embed && brain.embed.model !== model) {
        for (const m of brain.memories) delete m.v;
    }
    const missing = brain.memories.filter(m => !freshVector(m));
    if (!missing.length) { if (!brain.embed && brain.memories.length) brain.embed = { model, dim: DIM }; return 0; }
    const vectors = await embed(missing.map(embedText), project);
    if (!vectors) return 0;
    missing.forEach((m, i) => { const v = packVector(vectors[i]); if (v) { m.v = v; m.vh = textHash(m); } });
    brain.embed = { model, dim: DIM };
    return missing.length;
}

// A memory as answers show it: without its fingerprint
const publicMemory = ({ v, vh, ...m }) => m;

// Score every memory of a brain for a piece of text
export function searchMemories(brain, text, qv, { limit = 10, kinds = null } = {}) {
    const rows = brain.memories.filter(m => !['mind', 'forgot'].includes(m.kind) && m.status !== 'done' && (!kinds || kinds.includes(m.kind)));
    if (!rows.length) return [];
    const q = tokens(text);
    // How rare a word is in this brain: rare words ("Haydarpaşa") decide more than common ones ("night")
    const docs = rows.map(m => new Set(tokens(`${m.title} ${m.keys.join(' ')} ${m.body} ${m.about.join(' ')}`)));
    const df = new Map();
    for (const d of docs) for (const w of d) df.set(w, (df.get(w) ?? 0) + 1);
    const idf = w => Math.log(1 + rows.length / (df.get(w) ?? rows.length));
    // The rarest 256 of the text's words decide: a long text (a draft being checked) costs no more than that per memory
    const qUnique = [...new Set(q)].sort((a, b) => idf(b) - idf(a)).slice(0, 256);
    const maxKw = qUnique.reduce((t, w) => t + idf(w), 0) || 1;
    const scored = rows.map((m, i) => {
        const titleWords = new Set(tokens(`${m.title} ${m.keys.join(' ')}`));
        let kw = 0;
        for (const w of qUnique) if (docs[i].has(w)) kw += idf(w) * (titleWords.has(w) ? 1.5 : 1);
        kw = Math.min(1, (kw / maxKw) * 1.6);
        const fv = qv && freshVector(m);
        const sem = fv ? Math.max(0, cosine(qv, unpackVector(fv))) : 0;
        const base = 0.12 * m.strength * (m.confidence ?? 1) + 0.08 * m.importance + (m.scope === 'chat' ? 0.04 : 0);
        const score = (qv ? 0.5 * sem + 0.35 * kw : 0.8 * kw) + base;
        return { m, score, about: m.about.map(norm) };
    }).sort((a, b) => b.score - a.score);
    // Spreading activation: the people in the best hits pull their other memories up a little
    const people = new Set(scored.slice(0, 3).flatMap(x => x.about));
    for (const x of scored.slice(3)) if (x.about.some(a => people.has(a))) x.score += 0.06;
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(x => ({ ...publicMemory(x.m), score: Math.round(x.score * 1000) / 1000 }));
}

const clarity = m => (m.strength >= 0.6 ? 'clear' : m.strength >= 0.3 ? 'fading' : 'faded');
// Known for sure: seen or read, or from before sources were kept
const sure = m => !m.source || ['saw', 'read'].includes(m.source.how);
// Where something they were told came from: in a few words for a memory's header ("told by Tom, from Mira"), and as a
// sentence for what they've been told, with how much they believe it
const SHORT = { heard: 'heard from', told: 'told by', overheard: 'overheard from', inferred: 'guessed from what' };
const TOLD = { heard: b => `${b} said it in front of them`, told: b => `${b} told them`, overheard: b => `they overheard ${b}`, inferred: b => `they worked it out from what ${b} said` };
const NOBODY = { inferred: 'they worked it out', rumor: 'talk going around' };
const fromWhom = s => [s.by ? `${SHORT[s.how] ?? 'told by'} ${s.by}${s.how === 'inferred' ? ' said' : ''}` : NOBODY[s.how] ?? s.how, s.origin && `from ${s.origin}`].filter(Boolean).join(', ');
const belief = c => (c == null || c >= 0.75 ? 'They believe it.' : c >= 0.5 ? 'They half believe it.' : "They're not sure.");
const toldLine = ({ fact, source: s, confidence }) => `- ${fact} (${s.by ? (TOLD[s.how] ?? TOLD.told)(s.by) : NOBODY[s.how] ?? s.how}${s.origin ? `; ${s.by ?? 'it'} said it came from ${s.origin}` : ''}. ${belief(confidence)})`;

// Everything a character brings to this moment, as data and as a ready-to-use text block for a prompt
export function contextOf(brain, { text = '', hits = [], budget = 6000, player = null } = {}) {
    const relations = getRelations(brain);
    const state = getState(brain);
    const own = brain.memories;
    const timeline = own.filter(m => m.scope === 'chat' && !['mind', 'forgot', 'fact'].includes(m.kind)).sort((a, b) => (a.from ?? 0) - (b.from ?? 0)).map(m => firstSentence(m.gist || m.body));
    // What this conversation taught them for sure (their core facts come up as memories when relevant)
    const facts = own.filter(m => m.kind === 'fact' && m.scope === 'chat').map(m => ({ about: m.about, fact: m.body, ...(m.source && { source: m.source }), ...(m.confidence != null && { confidence: m.confidence }) }));
    const forgot = own.filter(m => m.kind === 'forgot').map(m => m.body);
    // The lies they told, to whom and what the truth is: theirs to keep up (the people they lied to just believe them)
    const lies = own.filter(m => m.kind === 'told' && m.lie && m.status !== 'done').map(m => ({ to: m.told_to ?? m.about, said: m.said ?? m.body, truth: m.truth ?? null }));
    const intentions = own.filter(m => m.kind === 'intention' && m.status === 'active').map(m => m.title);
    const notes = new Map(own.filter(m => m.kind === 'mind').map(m => [m.title.toLowerCase(), m.body]));
    const mind = mindFor(text, 2).map(t => {
        const n = inThisPerson(t, brain.personality, brain.pronouns);
        return n && { title: n.title, general: firstSentence(n.general.replace(/^What:\s*/, '')), in_them: n.lines.slice(0, 2), note: notes.get(n.title.toLowerCase()) ?? null };
    }).filter(Boolean);

    const name = brain.name;
    const card = brain.card;
    const parts = [];
    const add = (title, body) => { if (body && String(body).trim()) parts.push(`## ${title}\n${String(body).trim()}`); };
    // A brain built light knows its card and what the chat taught it; a full one has a whole past besides
    if (brain.build === 'light' && !own.some(m => m.scope === 'core')) add(`Who ${name} is`, [card.who, card.description].filter(Boolean).join('\n').slice(0, 1500));
    add(`How ${name} differs from an average person`, profile(brain.personality, { pronouns: brain.pronouns, max: 6 }));
    add('Right now', [state.mood && `Mood: ${state.mood}`, state.on_mind.length && `On their mind: ${state.on_mind.join('; ')}`, state.wants.length && `Wants: ${state.wants.join('; ')}`, intentions.length && `Plans and promises: ${intentions.join('; ')}`].filter(Boolean).join('\n'));
    add('People in their life', closestFirst(relations, player).slice(0, 14).map(r => `- ${r.target}: ${RELATION_FIELDS.filter(f => r[f] != null).map(f => `${f} ${r[f]}`).join(', ')}${r.note ? `. ${r.note}` : ''}`).join('\n'));
    add('What they know for sure', facts.filter(sure).slice(-20).map(f => `- ${f.fact}`).join('\n'));
    add("What they've been told (they know who told them, and say so)", facts.filter(f => !sure(f)).slice(-20).map(toldLine).join('\n'));
    add('Lies they are keeping up (toward those people they stick to the lie, unless they choose to confess)', lies.slice(-12).map(l => `- To ${l.to.join(', ')}: "${l.said}".${l.truth ? ` The truth: ${l.truth}` : ''}`).join('\n'));
    add("Their story so far, as they lived it (details not recalled below stay vague; they don't make them up)", timeline.slice(-30).map(s => `- ${s}`).join('\n'));
    add('What this moment brings to mind', hits.map(h => `### ${h.title} (${[clarity(h), !sure(h) && fromWhom(h.source)].filter(Boolean).join(', ')})\n${clarity(h) === 'faded' ? `Only the gist is left: ${h.gist ?? firstSentence(h.body)}` : h.body}`).join('\n\n'));
    add('In their mind', mind.map(m => `- ${m.title}: ${m.general}${m.in_them.length ? ` In them: ${m.in_them.join(' ')}` : ''}${m.note ? ` (${m.note})` : ''}`).join('\n'));
    add('They were made to forget (nothing they say may show they still know it)', forgot.map(f => `- ${f}`).join('\n'));
    // "This section", not "above": in a group chat several characters' sections stand one after another
    parts.push(`## Ground rules\n${name} knows only what this section ("What ${name} brings to this moment") says, what is in their card, and what happened in front of them in this conversation. Anything else (what was said where they weren't, other people's secrets, a shared past nobody can find here) they don't know: they don't mention it, hint at it or "sense" it. What they were told, they know as told: they name who told them and never speak as if they saw it.${player ? ` ${player} is the player; ${name} knows about them only what they saw or were told.` : ''}`);
    // Over budget: the longest part (never the rules) is shortened until it fits
    let out = parts.join('\n\n');
    for (let guard = 0; out.length > budget && guard < 20; guard++) {
        const i = parts.slice(0, -1).reduce((best, p, j, arr) => (p.length > arr[best].length ? j : best), 0);
        if (parts[i].length <= 300) break;
        parts[i] = `${parts[i].slice(0, Math.max(300, parts[i].length - (out.length - budget) - 20)).replace(/\n[^\n]*$/, '')}\n…`;
        out = parts.join('\n\n');
    }
    return {
        name, text: `# What ${name} brings to this moment\n\n${out}`,
        memories: hits, relations: relations.map(({ scope, ...r }) => r), state, facts, forgot, intentions, mind, ...(lies.length && { lies }),
    };
}

// POST /v1/brains/recall: each brain's context for this moment (one embedding call for all of them)
export async function recall(project, brains, body) {
    const text = momentText(body);
    const qv = await queryVector(project, brains, text);
    const opts = { budget: num(body.budget, 6000, 200, 60000), limit: num(body.limit, 10, 1, 50), player: playerName(body.player) };
    const characters = brains.map(b => contextOf(b, { text, hits: text.trim() ? searchMemories(b, text, vectorFor(project, b, qv), { limit: opts.limit }) : [], ...opts }));
    const lastPlayer = (Array.isArray(body.messages) ? body.messages : []).findLast(m => /^(user|human|player)$/i.test(String(m?.role ?? '')));
    // The player brought up the past: that's when a reply is worth checking (POST /v1/brains/check) before it's shown
    return { characters, ...(characters.length === 1 && { text: characters[0].text }), check_recommended: mentionsThePast(textOf(lastPlayer?.content ?? lastPlayer?.text)) };
}
