// The pre-check: what the data alone can tell about a draft, before any model reads it, at no cost. For each character
// checked, the words of their lines that only someone else could know: words another brain holds, or a message they
// didn't take in, and nothing they did take in (their memories, card and people, the messages they perceived, the
// names in the call). A name or a number only another brain holds is a leak outright; any other such word is a
// suspect for the auditor to judge. So are the words of a truth they lied about, said in front of someone they lied
// to, and the words of something they were made to forget. CPU only: no model, no key.
import { tokens, norm, samePerson, sameCharacter, whoIs, mentions, STOP } from './text.mjs';
import { characterOf, getRelations, CARD_FIELDS } from './brainfile.mjs';
import { perceive, speakersIn } from './scenes.mjs';

const WORD = /[\p{L}\p{N}]+/gu;
// A word worth a look: a number of two digits or more, or a word of four letters or more that isn't a stop word
const worth = w => (/^\p{N}+$/u.test(w) ? w.length >= 2 : w.length >= 4 && !STOP.has(w));
const wordsOf = text => new Set((norm(text).match(WORD) ?? []).filter(worth));
const itemText = m => [m.title, m.body, m.gist, m.keys.join(' '), m.about.join(' '), m.evidence, m.said, m.truth].filter(Boolean).join(' ');
// A brain's words, read once: all of them, the ones it may know (all but what it was made to forget), and the ones
// only it can give away (its memories of this chat, and its secrets)
function brainWords(b) {
    const text = test => wordsOf(b.memories.filter(test).map(itemText).join('\n'));
    const forgot = text(m => m.kind === 'forgot'), shared = text(m => m.kind !== 'forgot' && (m.scope === 'chat' || m.kind === 'secret'));
    const own = new Set([...text(m => m.kind !== 'forgot' && m.scope !== 'chat' && m.kind !== 'secret'), ...shared]);
    return { all: new Set([...own, ...forgot, ...wordsOf(b.name)]), own, shared };
}
// Capitalized words that name no secret: days and months
const CALENDAR = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)$/;

// A character's lines in a draft: with one brain, all of it; in a group, their "Name: words" lines and the lines that
// follow one, up to the next speaker or a blank line
function linesOf(draft, character, { solo, scope }) {
    if (solo) return draft.split(/\r?\n/);
    const out = [];
    let mine = false;
    for (const line of draft.split(/\r?\n/)) {
        const who = line.includes(':') && speakersIn(line)[0];
        if (who) { mine = sameCharacter(whoIs(who, scope), character); if (mine) out.push(line.slice(line.indexOf(':') + 1)); }
        else if (!line.trim()) mine = false;
        else if (mine) out.push(line);
    }
    return out;
}
// Names and numbers as written in a line: a number of three digits or more, or a capitalized word that doesn't open a
// sentence (so "Marisol" in "the Marisol sank", not "Never" in "Never mind"). norm(word) -> the word as written.
// A strong suspect is one of these that only other brains hold, and few of them: a leak outright
function namesIn(line) {
    const out = new Map();
    for (const m of line.matchAll(WORD)) {
        const w = m[0], n = norm(w), before = line.slice(0, m.index).trimEnd();
        const opens = !before || /[.!?…:;"“”*(\-—]$/u.test(before);
        if (/^\p{N}{3,}$/u.test(w) || (/^\p{Lu}/u.test(w) && !opens && tokens(w).length && !CALENDAR.test(n))) out.set(n, w);
    }
    return out;
}
// Who is in the draft's scene: those in the last message placed (as long as they can hear), else the player, and in
// either case whoever speaks in the draft or, with nothing placed, is named in it
function sceneOf(events, draft, { cast, player }) {
    const last = events.findLast(e => e.present);
    const names = last ? last.present.filter(n => !['asleep', 'saw'].includes(last.modes?.[norm(n)])) : [player];
    return [...names, ...speakersIn(draft), ...(last ? [] : cast.filter(c => mentions(draft, c)).map(c => c.name))];
}

// checked: the brains whose lines are checked; brains: every brain in the call; events: the recent messages (with
// present when known). Returns { issues (deterministic leaks, by: "precheck"), suspects }.
export function precheck(checked, brains, { draft, events, scope, player }) {
    const solo = brains.length === 1;
    const cast = brains.map(characterOf);
    // How many brains hold a word: a word most of them hold says little. "Rare" is at most a third of the brains in
    // the call (at least one)
    const read = brains.map(brainWords);
    const rare = w => read.filter(h => h.all.has(w)).length <= Math.max(1, Math.floor(brains.length / 3));
    // What everyone in the call knows: the people in it, the player, who each one is, and the world's lore as the
    // auditor reads it (the first brain's card.lore). A world brain (design section 5, not built yet) plugs in here:
    // the world items each character's audience allows would join what they know.
    const common = wordsOf([player, ...cast.flatMap(c => [c.name, ...(c.aliases ?? [])]), ...brains.map(b => b.card.who), brains.map(b => b.card.lore).find(Boolean)].filter(Boolean).join(' '));
    const here = sceneOf(events, draft, { cast, player });
    const issues = [], suspects = [];
    for (const b of checked) {
        const c = characterOf(b), held = read[brains.indexOf(b)] ?? brainWords(b);
        const lines = linesOf(draft, c, { solo, scope });
        if (!lines.some(l => l.trim())) continue;
        const card = wordsOf(Object.keys(CARD_FIELDS).map(k => b.card[k] ?? '').join(' '));
        // What they could know: their own memories (not what they were made to forget), card and people, every recent
        // message as they took it in, and the ones nobody placed (they may have been there: the auditor tells)
        const known = wordsOf([...getRelations(b).map(r => `${r.target} ${r.note ?? ''}`), ...events.map(e => (e.present ? perceive(e, c, scope).text : e.text))].join('\n'));
        for (const w of [...held.own, ...card, ...common]) known.add(w);
        const missed = wordsOf(events.filter(e => e.present).map(e => e.text).join('\n'));
        const names = new Map(lines.flatMap(l => [...namesIn(l)]));
        const said = new Set([...wordsOf(lines.join('\n')), ...names.keys()]);
        const found = [];
        for (const w of said) {
            if (known.has(w)) continue;
            const from = brains.filter((o, i) => o !== b && read[i].shared.has(w)).map(o => o.name);
            if (!from.length && !missed.has(w)) continue;
            if (!names.has(w) && !rare(w)) continue;
            const strong = names.has(w) && from.length > 0 && rare(w);
            found.push({ character: b.name, type: 'leak', word: names.get(w) ?? w, from, ...(strong && { strong }) });
            if (strong) issues.push({ character: b.name, type: 'leak', quote: names.get(w), why: `Only ${from.join(', ')} ${from.length > 1 ? 'hold' : 'holds'} "${names.get(w)}"; nothing ${b.name} took in does.`, by: 'precheck' });
        }
        // A lie they keep up toward someone in this scene: the words of its truth that the lie didn't say
        for (const m of b.memories.filter(x => x.kind === 'told' && x.lie && x.truth && x.status !== 'done')) {
            const to = (m.told_to ?? []).filter(n => here.some(h => samePerson(h, n)));
            const lied = wordsOf(m.said ?? '');
            if (to.length) for (const w of wordsOf(m.truth)) if (said.has(w) && !lied.has(w) && !card.has(w) && !common.has(w)) found.push({ character: b.name, type: 'lie_slip', word: w, to });
        }
        for (const m of b.memories.filter(x => x.kind === 'forgot')) for (const w of wordsOf(m.body)) if (said.has(w) && !card.has(w) && !common.has(w)) found.push({ character: b.name, type: 'forgot', word: w });
        const seen = new Set();
        suspects.push(...found.filter(s => !seen.has(`${s.type}:${norm(s.word)}`) && seen.add(`${s.type}:${norm(s.word)}`)).sort((x, y) => Number(!!y.strong) - Number(!!x.strong)).slice(0, 12));
    }
    return { issues, suspects };
}

// The suspects as lines for the auditor's prompt
export function suspectLines(suspects) {
    const by = new Map();
    for (const s of suspects) (by.get(s.character) ?? by.set(s.character, []).get(s.character)).push(s);
    return [...by].map(([name, list]) => {
        const words = type => list.filter(s => s.type === type);
        const quote = s => `"${s.word}"${s.from?.length ? ` (${s.from.join(', ')})` : ''}`;
        const lied = [...new Set(words('lie_slip').flatMap(s => s.to))];
        return [
            words('leak').length && `words only others know (or a message ${name} wasn't there for): ${words('leak').map(quote).join(', ')}`,
            lied.length && `words of the truth behind a lie they keep up toward ${lied.join(', ')}, who ${lied.length > 1 ? 'are' : 'is'} here: ${words('lie_slip').map(quote).join(', ')}`,
            words('forgot').length && `words of what they were made to forget: ${words('forgot').map(quote).join(', ')}`,
        ].filter(Boolean).map(t => `- ${name}'s lines: ${t}`).join('\n');
    }).join('\n');
}
