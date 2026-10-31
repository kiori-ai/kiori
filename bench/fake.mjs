// The fakes: nothing here reaches a real model or spends anything. A fake model provider for the Kiori server the
// runner boots (it answers organize, placement, check, sleep and embeddings the way a real provider would, from what
// each prompt asks, with token counts about the size of the text so a cost can be estimated; it is handed the story,
// so its organizer can say what a good one would: how each thing was learned, from whom, and which lines were lies),
// and three fake chat models the runner calls in-process: a parrot that answers from its prompt (the realistic one),
// an oracle that answers from the ground truth (scores perfectly), and a leaky one that answers from the whole
// transcript.
import http from 'node:http';
import crypto from 'node:crypto';
import { tokens, norm } from '../src/text.mjs';
import { STORY } from './engine.mjs';

export const FAKE_KEY = 'sk-bench-fake';
export const FAKE_BRAIN_MODEL = 'fake/brain';
const words = t => String(t).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
const hash = s => crypto.createHash('md5').update(String(s)).digest();
const approxTokens = s => Math.ceil(String(s ?? '').length / 4);

// ---------- The provider behind the Kiori server ----------
// A bag-of-words vector: texts that share words point the same way, as real embeddings roughly do
function vectorOf(text) {
    const v = new Array(256).fill(0);
    for (const w of words(text)) v[hash(w)[0]] += 1;
    return v.some(Boolean) ? v : [1, ...v.slice(1)];
}
// The lines of a prompt: "[n] Speaker: text", where the speaker may carry "(player)" and the mark of a message taken in
// only partly ("(you overheard this from nearby; … = words you missed)"), which is not part of the name
export const linesOf = block => [...String(block).matchAll(/^\[(\d+)\] ([^:\n]+?)(?: \((you [^)]*)\))?: (.*)$/gm)].map(m => ({ n: Number(m[1]), speaker: m[2].replace(/ \(player\)$/, ''), player: m[2].endsWith('(player)'), took: m[3] ?? null, text: m[4] }));
// The narration that opens a new place or time in these scenarios
const OPENS_SCENE = /^(Dusk|Dawn|Morning|Noon|Midday|Afternoon|Evening|Night|Late|Early|Past midnight|Next|That (?:evening|night)|Three days|Back|Out on|Inside|Down the|On the church|The (?:morning|prize|Lantern|Drowned|forge|bonfire))/;
// What a partly taken-in message shows in place of what was missed
const UNSEEN = /\((?:you couldn't see this|words you couldn't hear)\)/g;
const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What the fake organizer knows of the story it is behind (the runner hands it the scenarios it plays): each spine
// line by its text, with what it carries, the lie it tells, whom the speaker says it came from and who heard it; and the
// people's names, to tell "Tom says..." from a word that happens to be capitalized
function storyIndex(story) {
    if (!story) return { lines: new Map(), people: [], facts: {} };
    const lines = new Map();
    for (const i of story.items) if (i.type === 'message') lines.set(norm(i.text), i);
    const people = Object.values(story.people).map(p => ({ name: p.name, forms: [...new Set([p.name, ...(p.aliases ?? []), ...p.name.split(/\s+/).filter(w => w.length >= 3 && /^\p{Lu}/u.test(w))])] }));
    return { lines, people, facts: story.facts };
}
// "Tom says...", "Mira told him", "Bram Tolley says", "had it from Ines": the person a line passes on words from
const SAYS = "(?:'s)?\\s+(?:says|said|swears|swore|reckons|claims|claimed|told (?:me|us|him|her|them)|tells (?:me|us|him|her)|was saying|had it|'s heard|has heard)\\b";
const FROM = '\\b(?:according to|heard it from|had it from|got it from|came from)\\s+';
function reported(index, text, not = []) {
    for (const p of index.people) {
        if (not.includes(p.name)) continue;
        for (const f of p.forms) if (new RegExp(`(^|[^\\p{L}])${escape(f)}${SAYS}`, 'u').test(text) || new RegExp(`${FROM}${escape(f)}(?![\\p{L}])`, 'u').test(text)) return p.name;
    }
    return null;
}
// About twelve words of a text, verbatim, around a phrase when one is given
function quoteOf(text, around = null) {
    const ws = String(text).replace(UNSEEN, ' ').split(/\s+/).filter(Boolean);
    let at = 0;
    if (around) { const first = norm(around).split(' ')[0]; const k = ws.findIndex(w => norm(w).split(' ').includes(first)); if (k >= 0) at = Math.max(0, k - 5); }
    return ws.slice(at, at + 12).join(' ');
}
// Words a fact can be told by: its canaries and the canaries of its parts
const wordsOfFact = f => [...f.canaries, ...Object.values(f.parts ?? {}).flat()];
const holdsAny = (text, phrases) => phrases.find(c => ` ${norm(text)} `.includes(` ${norm(c)} `)) ?? null;

// The organizer: one memory per line it was shown, quoting the line, with how they came by it (seen, heard, or told by
// someone the line names as its source); a fact for each line that carries one or passes words on; and, for their own
// lines of the spine that tell something, what they told and to whom: a lie when the spine marks it, with its truth
// quoted from these scenes or pointed at in what they already remember. Nothing it wasn't shown.
function learn(prompt, name, index) {
    const scenes = linesOf(prompt.slice(prompt.lastIndexOf('WAS IN:')));
    const knownAt = prompt.indexOf('WHAT THEY ALREADY REMEMBER'), scenesAt = prompt.lastIndexOf('THE SCENES');
    const known = knownAt >= 0 ? [...prompt.slice(knownAt, scenesAt).matchAll(/^- \[([^\]]+)\] (.*)$/gm)].map(m => ({ id: m[1], text: m[2] })) : [];
    const memories = [], facts = [], told = [];
    for (const s of scenes) {
        const shown = s.text.replace(UNSEEN, ' ').trim();
        if (norm(shown).length < 12) continue;
        const quote = quoteOf(s.text);
        const story = s.speaker === STORY, spine = index.lines.get(norm(s.text));
        const via = story ? null : (spine?.origin ?? reported(index, s.text, [s.speaker, name]));
        const how = story ? 'saw' : via ? 'told' : 'heard';
        memories.push({ title: `${story ? 'Saw' : s.speaker}: ${shown.slice(0, 50)}`, body: `${story ? '' : `${s.speaker} said: `}${shown}`, keys: tokens(shown).slice(0, 3), about: story ? [] : [s.speaker], importance: 0.6, emotion: 0.3, evidence: quote, how, via: via ?? '' });
        const carried = spine ? [...spine.says, ...spine.shows].map(r => index.facts[r.fact]).filter(Boolean) : [];
        if (carried.length || via) {
            const about = via ?? (story ? (index.people.find(p => p.forms.some(f => new RegExp(`(^|[^\\p{L}])${escape(f)}(?![\\p{L}])`, 'u').test(shown)))?.name ?? name) : s.speaker);
            facts.push({ about, fact: shown.slice(0, 240), evidence: quote, how, via: via ?? '' });
        }
        // Their own line: what they passed on, to those who heard it
        if (!spine || s.speaker !== name || story || !spine.says.length) continue;
        const hearers = Object.entries(spine.present).filter(([n, mode]) => n !== name && (mode === 'full' || mode === 'heard')).map(([n]) => n);
        const lie = spine.lie && index.facts[spine.lie.fact];
        const to = (lie && spine.lie.to) || hearers;
        if (!to.length) continue;
        if (!lie) { told.push({ to, said: shown.slice(0, 240), lie: false, truth: '', truth_ref: '', evidence: quote }); continue; }
        // The truth the lie denies: a line of these scenes that shows it, else a memory of theirs that holds it
        const truthWords = wordsOfFact(index.facts[lie.lie_of]);
        const seen = scenes.find(x => x !== s && holdsAny(x.text, truthWords));
        const remembered = !seen && known.find(k => holdsAny(k.text, truthWords));
        told.push({ to, said: shown.slice(0, 240), lie: true, truth: seen ? quoteOf(seen.text, holdsAny(seen.text, truthWords)) : index.facts[lie.lie_of].truth, truth_ref: remembered ? remembered.id : '', evidence: quote });
    }
    return { memories, facts, relations: [], state: { mood: 'thoughtful', on_mind: [], wants: [] }, intentions: [], finished: [], told, forgot: [], card: { who: `${name}, of Saltmere.`, looks: '', personality: '', voice: '' } };
}

// Placement: a new scene at each narration line that opens a place or time; everyone who speaks in a scene, or is
// named in it, is there for all of it (the coarse placement whose arrival leak the benchmark measures)
function place(prompt) {
    const [, from, to] = prompt.match(/Cover every message from (\d+) to (\d+)/).map(Number);
    const player = prompt.match(/\. (.+?) is the player's character/)?.[1] ?? 'Player';
    const known = [...prompt.slice(prompt.indexOf('KNOWN CHARACTERS:'), prompt.indexOf('STORY:')).matchAll(/^- (.+?)(?: \(also: [^)]*\))?:/gm)].map(m => m[1]);
    const lines = linesOf(prompt.slice(prompt.indexOf('STORY:'))).filter(l => l.n >= from && l.n <= to);
    const scenes = [];
    for (const l of lines) {
        if (!scenes.length || (l.speaker === STORY && OPENS_SCENE.test(l.text))) scenes.push({ from: l.n, to: l.n, place: `scene at ${l.n}`, people: new Set() });
        const s = scenes.at(-1);
        s.to = l.n;
        if (l.player) s.people.add(player);
        else if (l.speaker !== STORY) s.people.add(l.speaker);
        for (const k of known) if (new RegExp(`(^|[^\\p{L}])${escape(k)}(?![\\p{L}])`, 'u').test(l.text)) s.people.add(k);
        if (/\bLeo\b/.test(l.text)) s.people.add(player);
    }
    return { scenes: scenes.map(({ people, ...s }) => ({ ...s, present: [...people] })) };
}

// The auditor: a capitalized word or a number in a character's line that the story's recent messages or another
// character's block hold, and their own block doesn't, is a leak; and a word the pre-check lists as the truth behind a
// lie they keep up, said in front of someone they lied to, is a lie slip. Both are cut from the fixed reply.
function audit(prompt) {
    const draft = prompt.slice(prompt.lastIndexOf('DRAFT:') + 6).split('\n\nReturn only JSON')[0].trim();
    const knowsAt = prompt.indexOf('WHAT EACH CHARACTER KNOWS:'), dataAt = prompt.indexOf('\nWHAT THE DATA ALREADY SHOWS'), draftAt = prompt.lastIndexOf('DRAFT:');
    const knows = prompt.slice(knowsAt, dataAt > knowsAt ? dataAt : draftAt);
    // Each character's block opens "### Name" and "Who:" (the memories inside it have "###" headers of their own)
    const blocks = Object.fromEntries([...knows.matchAll(/^### (.+)\nWho:([\s\S]*?)(?=^### .+\nWho:|(?![\s\S]))/gm)].map(m => [m[1].trim(), m[2]]));
    const data = dataAt > knowsAt ? prompt.slice(dataAt, draftAt) : '';
    const slips = [...data.matchAll(/^- (.+?)'s lines: words of the truth behind a lie they keep up toward (.+?), who (?:is|are) here: (.*)$/gm)].map(m => ({ name: m[1], to: m[2], words: [...m[3].matchAll(/"([^"]+)"/g)].map(w => w[1]) }));
    const recent = prompt.slice(prompt.indexOf("THE STORY'S RECENT MESSAGES"), knowsAt);
    const common = prompt.slice(prompt.indexOf('WHO IS WHO'), prompt.indexOf("THE STORY'S RECENT MESSAGES"));
    const issues = [];
    let fixed = draft;
    for (const line of draft.split('\n')) {
        const [, who, said] = line.match(/^([^:\n]{1,40}): (.*)$/) ?? [];
        const name = who && Object.keys(blocks).find(n => n === who.trim()) || (Object.keys(blocks).length === 1 && !who ? Object.keys(blocks)[0] : null);
        if (!name) continue;
        const elsewhere = recent + Object.entries(blocks).filter(([n]) => n !== name).map(([, b]) => b).join('\n');
        // A capitalized word that only starts a sentence is no name
        const named = String(said).replace(/(^|[.!?*]\s*)[A-Z][a-z]*/g, '$1');
        for (const w of new Set(named.match(/\b(?:\d{2,}|[A-Z][a-z]{3,})\b/g) ?? [])) {
            const re = new RegExp(`\\b${w}\\b`);
            if (re.test(elsewhere) && !re.test(blocks[name]) && !re.test(common) && !re.test(name)) {
                issues.push({ character: name, type: 'leak', quote: w, why: `${name} never heard of ${w}.` });
                fixed = fixed.replace(new RegExp(`\\b${w}\\b`, 'g'), '…');
            }
        }
        for (const s of slips.filter(x => x.name === name)) for (const w of s.words) {
            const at = String(said).match(new RegExp(`(?<![\\p{L}\\p{N}])${escape(w)}(?![\\p{L}\\p{N}])`, 'iu'));
            if (!at) continue;
            issues.push({ character: name, type: 'lie_slip', quote: at[0], why: `${name} lied to ${s.to} about this.` });
            fixed = fixed.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escape(at[0])}(?![\\p{L}\\p{N}])`, 'gu'), '…');
        }
    }
    return issues.length ? { issues, fixed } : { issues: [], fixed: '' };
}

function answer(prompt, index) {
    const memory = prompt.match(/^You are the memory of (.+?), processing/m);
    if (memory) return learn(prompt, memory[1], index);
    if (/Split it into scenes/.test(prompt)) return place(prompt);
    if (/You check a draft reply/.test(prompt)) return audit(prompt);
    if (/These memories have faded/.test(prompt)) return { gists: [...prompt.matchAll(/^(m_[\w-]+): (.*)$/gm)].map(m => ({ id: m[1], gist: m[2].split(/[.!?]/)[0].slice(0, 80) || 'Something happened, once.' })) };
    return null;
}

// story: the story the runner plays (optional), so the organizer can say what the spine marks: lies, origins, facts
export function fakeProvider({ story = null } = {}) {
    const calls = [], index = storyIndex(story);
    const server = http.createServer(async (req, res) => {
        let raw = '';
        for await (const c of req) raw += c;
        const body = raw ? JSON.parse(raw) : {};
        calls.push({ path: req.url, model: body.model ?? null });
        const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
        if (req.headers.authorization !== `Bearer ${FAKE_KEY}`) return send(401, { error: { message: 'bad key' } });
        if (req.url === '/models') return send(200, { data: [{ id: FAKE_BRAIN_MODEL, name: 'Fake brain model' }, { id: 'openai/text-embedding-3-small' }] });
        if (req.url === '/embeddings') return send(200, { data: body.input.map(t => ({ embedding: vectorOf(t) })), usage: { prompt_tokens: body.input.reduce((t, x) => t + approxTokens(x), 0) } });
        if (req.url === '/chat/completions') {
            const prompt = body.messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
            const json = body.response_format ? answer(prompt, index) : null;
            const content = json ? JSON.stringify(json) : 'Aye.';
            return send(200, { id: 'chatcmpl-fake', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: approxTokens(prompt), completion_tokens: approxTokens(content), cost: 0 } });
        }
        send(404, { error: { message: 'no such route' } });
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise(c => server.close(c)) })));
}

// ---------- Fake chat models ----------
const BLAND = ['*nods slowly* Aye, well.', 'Hm. The tide is turning.', "Let's not talk about that here.", '*looks out at the rain*', 'Pass the bread, would you?', "That's Saltmere for you."];
const bland = (speaker, n) => BLAND[hash(`${speaker}${n}`)[0] % BLAND.length];
const DIRECTION = new Set(['write', 'line', 'next', 'answer', 'asks', 'reply', 'their', 'story', 'only', 'short']);

// The parrot: it answers with the sentence of its prompt that best matches what it was asked (or the stage
// direction), which is how a model that uses its context and ignores the rules would behave
function parrot({ system, user, speaker, item, view }) {
    const at = system.search(/^WHAT .+ KNOWS:$/m);
    const names = new Set([speaker, ...Object.keys(view?.story?.people ?? {})].flatMap(n => tokens(n)));
    const query = new Set(tokens(user).filter(w => !names.has(w) && !DIRECTION.has(w)));
    const found = [];
    for (const raw of (at >= 0 ? system.slice(at) : '').split('\n').slice(1)) {
        if (/^(#|THE STORY SO FAR:)/.test(raw) || /knows only what/.test(raw)) continue;
        for (const sentence of raw.replace(/^\s*(?:- |\[\d+\] )?(?:[^:\n]{1,40}: )?/, '').split(/(?<=[.!?])\s+/)) {
            const score = new Set(tokens(sentence).filter(w => query.has(w))).size;
            if (score && !found.some(f => f.sentence === sentence.trim())) found.push({ score, sentence: sentence.trim(), at: found.length });
        }
    }
    // The two best matches, the later one first when they tie (the most recent thing said about it)
    const best = found.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, 2).map(f => f.sentence);
    return best.length ? best.join(' ') : bland(speaker, item?.n ?? user.length);
}

// The oracle: from the ground truth, what the target knows of the facts asked about, who told them, and whether
// they are keeping a lie up toward the one asking. Never a word more.
function oracle({ speaker, item, probe, view }) {
    if (!probe) return bland(speaker, item.n);
    const row = view.st.K[speaker] ?? {};
    const facts = view.story.facts;
    const parts = [];
    for (const f of probe.facts) {
        const e = row[f], fact = facts[f];
        const liar = fact.lie_of && e?.told?.includes(probe.asker) && ['knows', 'believes_lie'].includes(row[fact.lie_of]?.state);
        if (liar) { parts.push(`Like I told you: ${fact.canaries[0]}.`); continue; }
        if (!e || e.state === 'none') continue;
        const from = e.via ? ` ${e.via} told me${e.origin && e.origin !== e.via ? `, and ${e.origin} was where it came from` : ''}.` : '';
        if (e.state === 'half') parts.push(e.parts?.length ? `I only caught part of it: ${e.parts.map(p => [fact.parts[p]].flat()[0]).join(', ')}.${from}` : 'I only caught a word or two.');
        else parts.push(`${fact.canaries[0]}.${from}`);
    }
    return parts.join(' ') || "I don't know anything about that.";
}

// The leaky one: answers from the whole transcript, whoever was there
function leaky({ speaker, item, probe, view }) {
    const said = view.transcript.map(m => m.text).join('\n');
    if (!probe) {
        const last = view.transcript.findLast(m => m.who !== speaker && Object.values(view.story.facts).some(f => f.canaries.some(c => norm(m.text).includes(norm(c)))));
        return last ? `I heard it said: ${last.text.replace(/\*[^*]+\*/g, '').trim()}` : bland(speaker, item.n);
    }
    const found = probe.facts.flatMap(f => view.story.facts[f].canaries.filter(c => norm(said).includes(norm(c))));
    return found.length ? `Everyone knows: ${found.join(', ')}.` : 'No idea.';
}

export const FAKE_CHATS = { 'fake/parrot': parrot, 'fake/oracle': oracle, 'fake/leaky': leaky };
export const isFake = model => String(model ?? '').startsWith('fake/');
// A fake chat call, timed and sized like a real one
export function fakeChat(model, args) {
    const fn = FAKE_CHATS[model];
    if (!fn) throw new Error(`No fake chat model "${model}" (there are ${Object.keys(FAKE_CHATS).join(', ')})`);
    const text = fn(args);
    return { text, usage: { prompt_tokens: approxTokens(args.system) + approxTokens(args.user), completion_tokens: approxTokens(text), cost: 0 } };
}
