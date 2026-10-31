// Who was there. Each message needs the list of people present: customers can send it (exact); with one character it
// is that character and the player; in a group chat the organizer infers it, scene by scene, for the stretch being
// learned. Everything about who knows what rests on this list.
import { askJSON } from './llm.mjs';
import { findCharacter, characterNamed, namesPlayer, sameCharacter, whoIs, norm, bareName, mentions } from './text.mjs';

const SCHEMA = {
    type: 'object',
    properties: {
        scenes: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    from: { type: 'integer' }, to: { type: 'integer' },
                    place: { type: 'string', description: 'Where and when, short' },
                    present: { type: 'array', items: { type: 'string' }, description: 'Everyone physically there who speaks, acts or is clearly present, the player included' },
                },
                required: ['from', 'to', 'place', 'present'],
            },
        },
    },
    required: ['scenes'],
};

// Lines that start with "Name:" inside a narrator's message: whoever speaks is there. A name of up to 40 characters,
// maybe between stars ("**Ann**:"), then ":" and a space before the words, or the words on a later line. Read line by
// line, with no pattern that could backtrack: a regular expression did, and a few kilobytes of blank lines held the
// whole server for a minute.
const LINE_BREAK = /[\n\r\u2028\u2029]/, MAX_SPEAKERS = 50;
export function speakersIn(text) {
    const lines = String(text).split(LINE_BREAK);
    let last = lines.length - 1;
    while (last >= 0 && !lines[last].trim()) last--;
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i], colon = line.indexOf(':');
        if (colon < 0) continue;
        // Words after a space, or a name alone on its line with the words on a later one ("10:30" and "https:" aren't)
        const after = line.slice(colon + 1);
        if (after.trim() ? !/^\s/.test(after) : i >= last) continue;
        // Stars only around the name
        const head = line.slice(0, colon).trimStart().replace(/^\*+/, '');
        const star = head.indexOf('*');
        if (star >= 0 && head.slice(star).replace(/^\*+/, '').trim()) continue;
        const name = star >= 0 ? head.slice(0, star) : head.trimEnd();
        if (name.length > 40) continue;
        const n = name.trim();
        if (n && !/\s{2,}/.test(n) && !out.includes(n)) out.push(n);
        // A message with more speakers than any scene has is not a scene: the rest aren't looked up
        if (out.length === MAX_SPEAKERS) break;
    }
    return out;
}

// A message as one numbered line of the conversation
export const eventLine = (e, i) => `[${i ?? e.seq}] ${e.role === 'player' ? `${e.speaker} (player)` : e.speaker ?? 'STORY'}: ${e.text}`;

// A stretch of messages in pieces of one model call each: at most 60 and about 40k characters
export function placementChunks(events, { maxEvents = 60, maxChars = 40000 } = {}) {
    const chunks = [];
    let cur = [], size = 0;
    for (const e of events) {
        const len = eventLine(e).length + 2;
        if (cur.length && (cur.length >= maxEvents || size + len > maxChars)) { chunks.push(cur); cur = []; size = 0; }
        cur.push(e);
        size += len;
    }
    if (cur.length) chunks.push(cur);
    return chunks;
}

// Fills in who was there for the messages that don't say. Messages are numbered by their place in the call (n);
// before: a few messages before the stretch, for context. characters: the brains' characters.
// A small cast is listed whole (so someone described but not named is still found); a bigger one only by who the
// piece can involve: those named in it or in its context, and those present in its context. So the prompt grows with
// the scene, not the cast.
const WHOLE_CAST = 8;
export async function placeEvents(project, events, { before = [], characters = [], player = 'Player' } = {}) {
    if (!events.some(e => !e.present)) return 0;
    const castFor = shown => {
        const text = shown.map(e => eventLine(e, e.n)).join('\n'), there = new Set(shown.flatMap(e => e.present ?? []).map(n => whoIs(n, { story: characters, player })));
        return characters.filter(c => characters.length <= WHOLE_CAST || there.has(c) || mentions(text, c))
            .map(c => `- ${c.name}${c.aliases?.length ? ` (also: ${c.aliases.join(', ')})` : ''}: ${[c.card?.who, c.card?.looks].filter(Boolean).join(' / ').slice(0, 260)}`).join('\n');
    };
    const all = [...before, ...events];
    let done = 0;
    for (const chunk of placementChunks(events)) {
        if (chunk.every(e => e.present)) continue;
        const from = chunk[0].n, to = chunk.at(-1).n;
        // A little context before each piece, so a scene that started earlier is understood
        const shown = [...all.filter(e => e.n < from).slice(-4), ...chunk];
        const cast = castFor(shown);
        const r = await askJSON({
            role: 'organizer', project, op: 'scenes', schema: SCHEMA, maxTokens: 4000, temperature: 0.1,
            // An answer that places nobody is asked again (the last time on the fallback model); if it still does, the
            // call says so and learning waits, rather than the stretch counting for no one
            validate: x => (x.scenes.some(sc => sc.from >= 1 && sc.to >= sc.from) ? true : 'no scenes'),
            prompt: `Below is part of a story (numbered messages). ${player} is the player's character. Split it into scenes and list who is present in each.

Rules:
- A new scene starts when the place or time changes, or when the story moves to people somewhere else.
- The message that moves the story ("in the elevator", "the next morning", "when it's just the two of them", "they end up at") is the FIRST message of the new scene, never the last of the old one.
- Present means physically there: whoever speaks or acts, and whoever the narration places there. Someone only talked about, or left behind in the previous place, is not present.
- Someone described but not named (by looks, clothes, role) is one of the known characters when the description fits: use that name.
- Use the known names below when they fit; otherwise the name the story uses. Cover every message from ${from} to ${to}.

KNOWN CHARACTERS:
${cast || '(none)'}

STORY:
${shown.map(e => eventLine(e, e.n)).join('\n\n')}`,
        });
        const scenes = r.scenes.filter(s => s.from >= 1 && s.to >= s.from).sort((a, b) => a.from - b.from);
        for (const e of chunk) {
            if (e.present) continue;
            // A message no scene covered belongs to the scene before it
            const s = scenes.filter(x => x.from <= e.n).find(x => e.n <= x.to) ?? scenes.findLast(x => x.from <= e.n) ?? scenes[0];
            const names = new Map();
            // Exact names first: the player's (a player called "Peter" is not the character Peter Parker), then a
            // character's own name or alias. A shortened one counts only when it fits one of them: "Leo", with the
            // player Leo Martin and a Leo Brandt in the story, places nobody
            const add = raw => {
                const n = bareName(raw);
                if (!n) return;
                let name = norm(n) === norm(player) ? player : characterNamed(n, characters)?.name;
                if (!name) {
                    const c = findCharacter(n, characters), you = namesPlayer(n, player);
                    if (c && you) return;
                    name = you ? player : c?.name ?? n;
                }
                names.set(norm(name), name);
            };
            (s.present ?? []).forEach(add);
            if (e.speaker) add(e.speaker);
            speakersIn(e.text).forEach(n => findCharacter(n, characters) && add(n));
            e.present = [...names.values()];
            e.scene = s.place || null;
            done++;
        }
    }
    return done;
}

// Is this character in this message? Every name there is resolved among everyone in the call, so "Cersei Lannister"
// being there doesn't put Tyrion Lannister there too. A message nobody could place is nobody's: who knows what matters
// more than one memory. With the call's whole cast as the story, each name is resolved once for the call (the same
// names come up message after message, and for every brain of a group chat), and the call's first 200 different names
// are all that get resolved: past them, a name is nobody.
const resolved = new WeakMap(), MAX_NAMES = 200;
function whoIn(n, scope) {
    let known = resolved.get(scope.story);
    if (!known) resolved.set(scope.story, (known = new Map()));
    const key = `${scope.player ?? ''}\u0000${n}`;
    if (!known.has(key)) known.set(key, known.size < MAX_NAMES ? whoIs(n, scope) : null);
    return known.get(key);
}
export const isPresent = (event, character, scope = {}) =>
    (event.present ?? []).some(n => sameCharacter(scope.story ? whoIn(n, scope) : whoIs(n, { story: [character], ...scope }), character));
