// Who was there. Each message needs the list of people present: customers can send it (exact); with one character it
// is that character and the player; in a group chat the organizer infers it, scene by scene, for the stretch being
// learned. Everything about who knows what rests on this list, and on how each person there took a message in (its
// mode): all of it, only by ear, half of it through a wall, only by sight, or not at all, asleep.
import { askJSON } from './llm.mjs';
import { findCharacter, characterNamed, namesPlayer, sameCharacter, whoIs, norm, bareName, mentions, tokens, sha } from './text.mjs';

export const MODES = ['full', 'heard', 'overheard', 'saw', 'asleep'];

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
                    people: {
                        type: 'array', description: 'Everyone there who speaks, acts or is clearly present, the player included, and anyone close enough to overhear',
                        items: {
                            type: 'object',
                            properties: {
                                name: { type: 'string' }, mode: { type: 'string', enum: MODES },
                                from: { type: 'integer', description: 'Only if they arrive mid-scene: the first message they are there for' },
                                to: { type: 'integer', description: 'Only if they leave mid-scene: the last message they are there for' },
                            },
                            required: ['name', 'mode'],
                        },
                    },
                },
                required: ['from', 'to', 'place', 'people'],
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

// A message as one numbered line of the conversation; as one character took it in, when it was only partly (mode)
const TOOK = { heard: 'you only heard this', overheard: 'you overheard this from nearby; … = words you missed', saw: "you saw this but couldn't hear the words" };
export const eventLine = (e, i) => `[${i ?? e.seq}] ${e.role === 'player' ? `${e.speaker} (player)` : e.speaker ?? 'STORY'}${TOOK[e.mode] ? ` (${TOOK[e.mode]})` : ''}: ${e.text}`;

// What is said in a message and what is only seen, line by line: in someone's own message, their words are said and
// actions in *stars* are seen; in narration, the words of a "Name: words" line and words in quotes are said, the rest
// is seen. A line's "Name:" stays with what it says.
const ACTION = /(\*[^*\n]+\*)/, QUOTE = /("[^"\n]*"|“[^”\n]*”)/, WORD = /[\p{L}\p{N}]+/gu;
function pieces(e) {
    return String(e.text).split(LINE_BREAK).map(line => {
        const who = !e.speaker && speakersIn(line)[0];
        const head = who ? line.slice(0, line.indexOf(':') + 1) : '';
        const body = line.slice(head.length);
        const parts = e.speaker || who ? body.split(ACTION).map((t, i) => ({ t, said: i % 2 === 0 })) : body.split(QUOTE).map((t, i) => ({ t, said: i % 2 === 1 }));
        return { head, parts };
    });
}
// About 40% of what is said, gone: the content words to hide are picked by the message's fingerprint, so the same
// message always loses the same words (a re-learn sees the same gaps). missed: the words lost.
function masker(e, list, missed) {
    const said = list.flatMap(l => l.parts.filter(x => x.said).map(x => x.t)).join(' ').match(WORD) ?? [];
    const content = said.filter(w => tokens(w).length).map((w, k) => [sha(`${e.fp}:${k}`), k]).sort();
    const hidden = new Set(content.slice(0, Math.ceil(content.length * 0.4)).map(([, k]) => k));
    let k = 0;
    return t => t.replace(WORD, w => (tokens(w).length && hidden.has(k++) ? (missed.push(...tokens(w)), '…') : w));
}
const UNSEEN = "(you couldn't see this)", UNHEARD = "(words you couldn't hear)";
// A message as this character took it in: { mode, text, missed }. full: all of it; heard: only what is said, the rest
// "(you couldn't see this)"; overheard: what is said, with about 40% of its words lost; saw: what is seen, the words
// "(words you couldn't hear)"; asleep, or not there (mode null): nothing. The masking is done here, in code, and what
// learning writes is checked against this text: a word they didn't hear can't be quoted.
export function perceive(e, character, scope = {}) {
    const mode = modeOf(e, character, scope);
    if (mode !== 'heard' && mode !== 'overheard' && mode !== 'saw') return { mode, text: mode === 'full' ? e.text : '', missed: [] };
    const list = pieces(e), missed = [], mask = mode === 'overheard' ? masker(e, list, missed) : t => t;
    const lines = list.map(({ head, parts }) => {
        const text = parts.map(({ t, said }) => (!t.trim() ? t : mode === 'saw' ? (said ? ` ${UNHEARD} ` : t) : said ? mask(t) : ` ${UNSEEN} `)).join('');
        const tidy = text.replace(/\s+/g, ' ').replace(/(\((?:you couldn't see this|words you couldn't hear)\))(?: \1)+/g, '$1').trim();
        return head && tidy !== UNSEEN ? `${head} ${tidy}` : tidy;
    });
    const text = lines.filter(Boolean).join('\n').replace(/(\(you couldn't see this\))(?:\n\1)+/g, '$1');
    return { mode, text, missed };
}
// The message as a character took it in, for learning and checking; null when they weren't there or were asleep
export function perceived(e, character, scope) {
    const p = perceive(e, character, scope);
    return p.mode && p.mode !== 'asleep' ? { ...e, ...p } : null;
}

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
- Someone who arrives or leaves mid-scene: give "from" (the first message they are there for) or "to" (the last). Leave both out for someone there all scene.
- mode: "full" when there; next room, at the door, through a wall: "overheard"; on the phone: "heard"; asleep or unconscious: "asleep". A whisper or an aside: an extra entry "saw" for everyone but its listeners, with from and to on that message (the shorter entry wins).
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
            const names = new Map(), modes = {};
            // Exact names first: the player's (a player called "Peter" is not the character Peter Parker), then a
            // character's own name or alias. A shortened one counts only when it fits one of them: "Leo", with the
            // player Leo Martin and a Leo Brandt in the story, places nobody. A mode set before stays, unless forced
            const add = (raw, mode = 'full', force = true) => {
                const n = bareName(raw);
                if (!n) return;
                let name = norm(n) === norm(player) ? player : characterNamed(n, characters)?.name;
                if (!name) {
                    const c = findCharacter(n, characters), you = namesPlayer(n, player);
                    if (c && you) return;
                    name = you ? player : c?.name ?? n;
                }
                if (!force && names.has(norm(name))) return;
                names.set(norm(name), name);
                modes[norm(name)] = MODES.includes(mode) ? mode : 'full';
            };
            // Who was there for this message, the widest entries first so the shortest one (a whisper) decides. An
            // answer in the old shape (present: names) is everyone in full, for the whole scene
            const people = s.people.length ? s.people : (Array.isArray(s.present) ? s.present : []).map(name => ({ name, mode: 'full' }));
            const width = p => (p.to ?? Infinity) - (p.from ?? -Infinity);
            people.filter(p => (p.from == null || p.from <= e.n) && (p.to == null || e.n <= p.to)).sort((a, b) => width(b) - width(a)).forEach(p => add(p.name, p.mode));
            // Whoever speaks hears themselves; someone speaking inside a narrator's message is there, as placed if placed
            if (e.speaker) add(e.speaker);
            speakersIn(e.text).forEach(n => findCharacter(n, characters) && add(n, 'full', false));
            e.present = [...names.values()];
            e.modes = Object.fromEntries(Object.entries(modes).filter(([k, m]) => names.has(k) && m !== 'full'));
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
// How they took the message in (a mode), or null when they weren't there. Asleep is there, and takes nothing in.
export function modeOf(event, character, scope = {}) {
    const n = (event.present ?? []).find(x => sameCharacter(scope.story ? whoIn(x, scope) : whoIs(x, { story: [character], ...scope }), character));
    return n == null ? null : event.modes?.[norm(n)] ?? 'full';
}
export const isPresent = (event, character, scope = {}) => modeOf(event, character, scope) != null;
// Who was there, as the API takes it and gives it back: a name for full, { name, mode } otherwise
export const presentOf = e => e.present.map(name => (e.modes?.[norm(name)] && e.modes[norm(name)] !== 'full' ? { name, mode: e.modes[norm(name)] } : name));
