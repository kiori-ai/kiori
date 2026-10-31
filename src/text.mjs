// Small text tools shared by learning, recall and checking.
import crypto from 'node:crypto';

export const newId = prefix => `${prefix}_${crypto.randomBytes(9).toString('base64url')}`;
export const sha = s => crypto.createHash('sha256').update(s).digest('hex');
// Text from outside (a model provider's error), fit to pass on or log: the keys given, and anything else that looks
// like a key or a token, blanked out
const KEYLIKE = /\b(?:sk-[\w-]{6,}|AIza[\w-]{10,}|(?:kio|kia|kis|psy|psa)_[\w-]{6,})|\bBearer\s+[\w.~+/=-]{6,}/g;
export function scrub(text, ...keys) {
    let s = String(text ?? '');
    for (const k of keys) if (typeof k === 'string' && k.length >= 8) s = s.split(k).join('[key]');
    return s.replace(KEYLIKE, '[key]');
}
export const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : lo));

// Lowercase, letters and digits only (any script), single spaces. Turkish dotted and dotless i fold to i, so "İstanbul",
// "Istanbul" and "istanbul" are one word and "IŞIK" finds "Işık" (lowercasing İ leaves a combining dot behind)
export const norm = s => String(s ?? '').toLocaleLowerCase('en').normalize('NFC').replace(/i\u0307/g, 'i').replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
// A path or an address without its trailing slashes. A loop: /\/+$/ takes quadratic time on a long run of slashes
export function trimSlashes(s) {
    let end = s.length;
    while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
    return s.slice(0, end);
}

export const STOP = new Set(('the and for are but not you your yours with this that what when where which who whom why how was were has have had '
    + 'his her hers him she they them their theirs its our ours from into onto over under about then than there here just also very '
    + 'can could would should will shall may might must did does doing done been being out off all any some such only own same too '
    + 'one two now say said like know get got make made want went come came see saw ever never yes yeah okay well').split(' '));
export const tokens = s => norm(s).split(' ').filter(w => w.length >= 3 && !STOP.has(w));

// Was this quote really said in the text? Exact (normalized), or nearly all of its words (85%) in order within one
// stretch of the text about as long as the quote (its words and 3 more): words found scattered over the whole text
// don't make a quote. The auditor's cheapest check: whatever learning writes must point at something that happened.
export function evidenceFound(quote, text) {
    const q = norm(quote);
    if (q.length < 8) return false;
    const t = norm(text);
    if (t.includes(q)) return true;
    const qt = tokens(quote);
    // A quote is a sentence or two: one of more than 60 words is only taken word for word (above)
    if (qt.length < 4 || qt.length > 60) return false;
    // Where each word of the quote is, so a word of the text is found in it at once
    const at = new Map();
    qt.forEach((w, k) => (at.get(w) ?? at.set(w, []).get(w)).push(k));
    const tt = tokens(text), need = Math.ceil(qt.length * 0.85), span = qt.length + 3;
    for (let start = 0; start < tt.length; start++) {
        if (!at.has(tt[start])) continue;
        let next = 0, found = 0;
        for (let i = start; i < Math.min(tt.length, start + span) && next < qt.length; i++) {
            const k = at.get(tt[i])?.find(x => x >= next);
            if (k !== undefined) { found++; next = k + 1; }
        }
        if (found >= need) return true;
    }
    return false;
}

// Same person? One name is the other or a shortening of it: every name word of the shorter one (titles aside) is in
// the longer one ("Tyrion" → "Tyrion Lannister", "Doctor Burcu" → "Burcu Aydemir"). Two full names that only share a
// word are two people ("Cersei Lannister" ≠ "Tyrion Lannister"). A short name ("X", "Ty") must match whole.
const TITLES = new Set(['doctor', 'dr', 'mr', 'mrs', 'ms', 'miss', 'sir', 'ser', 'lord', 'lady', 'the', 'captain', 'uncle', 'aunt', 'bey', 'hanım', 'abi', 'abla', 'usta']);
const nameWords = s => norm(s).split(' ').filter(w => w.length >= 3 && !TITLES.has(w));
// A name as a model sometimes writes it, with a note after it: "Leo (the player's character)" → "Leo". Cut short first:
// a name is never long, and the pattern takes quadratic time on a long run of "("
export const bareName = n => String(n ?? '').slice(0, 200).replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();

export function samePerson(a, b) {
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return false;
    if (na === nb) return true;
    const wa = nameWords(a), wb = nameWords(b);
    if (!wa.length || !wb.length) return false;
    const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
    return short.every(w => long.includes(w));
}
const namesOf = c => [c.name, ...(c.aliases ?? [])];
// The character a name is exactly: their main name first, else an alias only one of them has. An alias two of them
// share ("Doc") names neither for sure: AMBIGUOUS. No exact name: null.
const AMBIGUOUS = Symbol('ambiguous');
function exactly(n, characters) {
    const byName = characters.find(c => norm(c.name) === n);
    if (byName) return byName;
    const byAlias = characters.filter(c => (c.aliases ?? []).some(x => norm(x) === n));
    return byAlias.length === 1 ? byAlias[0] : byAlias.length ? AMBIGUOUS : null;
}
// The character a name is exactly (main name, or an alias only they have), or null
export function characterNamed(name, characters) {
    const c = exactly(norm(name), characters);
    return c === AMBIGUOUS ? null : c;
}
// The character a name refers to: by exact name (see characterNamed), else by a shortened form that fits exactly one of
// them. A short form that fits several people ("Lannister", "Peter"), or an alias two share, refers to nobody for sure:
// null.
export function findCharacter(name, characters) {
    const n = norm(name);
    if (!n) return null;
    const exact = exactly(n, characters);
    if (exact) return exact === AMBIGUOUS ? null : exact;
    const partial = characters.filter(c => namesOf(c).some(x => samePerson(x, name)));
    return partial.length === 1 ? partial[0] : null;
}
// Is this name the player's own, or a shortening of it ("Leo" for "Leo Martin")? Only the player's own name counts: a
// longer name that contains theirs ("Leo Brandt", with a player called "Leo") is someone else's.
export function namesPlayer(name, player) {
    const n = norm(bareName(name)), p = norm(bareName(player));
    if (!n || !p) return false;
    if (n === p) return true;
    const own = nameWords(player), words = nameWords(bareName(name));
    return words.length > 0 && words.every(w => own.includes(w));
}
// Who a name in a story refers to: the player (no character), or a character. The player's exact name, then exact
// names (main names, then aliases only one of them has) in the story's cast and among everyone in the project. A
// shortened name that is also a shortening of the player's ("Leo", with the player Leo Martin and a Leo Brandt in the
// story) is nobody for sure; otherwise it is looked up in the story's cast first, then among everyone, so "Peter"
// means the Peter of this story.
export function whoIs(name, { story = [], everyone = [], player = null } = {}) {
    const n = norm(bareName(name));
    if (!n || (player && n === norm(player))) return null;
    for (const list of [story, everyone]) {
        const c = exactly(n, list);
        if (c) return c === AMBIGUOUS ? null : c;
    }
    if (player && namesPlayer(name, player)) return null;
    return findCharacter(name, story) ?? findCharacter(name, everyone);
}
// Does a name fit anyone at all, even ambiguously? Then it is not a new person
export const namesSomeone = (name, characters) => characters.some(c => namesOf(c).some(x => samePerson(x, name)));
// The same character (objects from different queries compare by id)
export const sameCharacter = (a, b) => !!a && !!b && (a === b || (a.id != null && a.id === b.id));
// Is this character named in a text: their full name, an alias, or one of their own name words ("Gwen", "Stacy"), as
// a whole word in any script ("İrem" too), not inside another word
export function mentions(text, character) {
    const t = String(text ?? '');
    const words = [character.name, ...(character.aliases ?? []), ...String(character.name).split(/\s+/).filter(w => w.length >= 3 && /^\p{Lu}/u.test(w) && !TITLES.has(norm(w)))];
    return words.some(w => w?.trim() && new RegExp(`(^|[^\\p{L}\\p{N}])${w.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'u').test(t));
}
// Does a message bring up the past ("do you remember", "how's your sister", "hani geçen yaz")? Then a reply is worth
// checking before it's shown: that's where a model invents a shared past or knows what it shouldn't.
const PAST = /\b(remember|recall|forgot|forget|last time|that (?:night|day|time|morning|summer|trip)|back (?:when|then|in)|when (?:did|was|were|we)|what did|how did|where did|who did|did (?:you|we|i|he|she|they)|first (?:time|night|day)|ago|used to|before (?:you|we|i)|the (?:night|time) (?:we|you|i)|how much|how many|our (?:trip|day|night|vacation|holiday)|how'?s your|how (?:is|are) your|still (?:have|got)|last (?:summer|year|spring|winter|week|month))\b|hatırl|unuttu|geçen|o gece|o gün|ilk (?:gün|gece|kez)|önceden|eskiden|ne zaman|hani/iu;
export const mentionsThePast = text => PAST.test(String(text ?? ''));

// A crowd or a nameless extra is not a character ("students", "a guard", "the waiter")
export const isExtra = name => /^[\p{Ll}]/u.test(String(name).trim())
    || /\b(students?|police|cops?|guards?|crowd|men|women|soldiers|people|family|kids|children|waiters?|staff|team|everyone|someone|narrator|story)\b/iu.test(name);

// Pronouns for the shared human model's texts, which are written about "her"
export function withPronouns(text, pronouns = 'they') {
    if (pronouns === 'she') return text;
    const p = pronouns === 'he' ? { she: 'he', She: 'He', herPos: 'his', herObj: 'him' } : { she: 'they', She: 'They', herPos: 'their', herObj: 'them' };
    let out = text
        .replace(/\bshe\b/g, p.she).replace(/\bShe\b/g, p.She)
        .replace(/\bherself\b/g, pronouns === 'he' ? 'himself' : 'themselves')
        .replace(/\bher\b(?=\s+(?:own\s+)?(?![a-z]+ly\b)(?:about|to|with|for|at|in|on|up|down|out|off|away|and|or|but|as|so|when|than)\b)/g, p.herObj).replace(/\bher\b(?=\s+(?:own\s+)?(?![a-z]+ly\b)[a-z])/g, p.herPos).replace(/\bher\b/g, p.herObj).replace(/\bHer\b/g, p.herPos[0].toUpperCase() + p.herPos.slice(1));
    if (pronouns !== 'he') {
        out = out.replace(/\b(they|They) (is|was|has|does|doesn't|isn't|wasn't|hasn't)\b/g, (_, t, v) => `${t} ${{ is: 'are', was: 'were', has: 'have', does: 'do', "doesn't": "don't", "isn't": "aren't", "wasn't": "weren't", "hasn't": "haven't" }[v]}`)
            .replace(/\b(they|They) (\w+?)(ies)\b/g, (_, t, w) => `${t} ${w}y`)
            .replace(/\b(they|They) (\w+?(?:ch|sh|ss|x|o))es\b/g, '$1 $2')
            .replace(/\b(they|They) (\w{2,}?[^su])s\b/g, '$1 $2');
    }
    return out;
}

export const firstSentence = s => (String(s ?? '').match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? String(s ?? '')).trim().slice(0, 240);

// The words of a chat message: a string, or OpenAI-style parts ({ type: 'text', text })
export const textOf = c => (Array.isArray(c) ? c.map(p => (typeof p === 'string' ? p : p?.type === 'text' || p?.text ? p.text ?? '' : '')).join('\n') : c == null ? '' : String(c));
// A number from a request, kept in range (missing or not a number: the default)
export const num = (v, fallback, min, max) => (v == null || v === '' || !Number.isFinite(Number(v)) ? fallback : Math.min(max, Math.max(min, Math.trunc(Number(v)))));
