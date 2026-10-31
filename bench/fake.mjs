// The fakes: nothing here reaches a real model or spends anything. A fake model provider for the Kiori server the
// runner boots (it answers organize, placement, check, sleep and embeddings the way a real provider would, from what
// each prompt asks, with token counts about the size of the text so a cost can be estimated), and three fake chat
// models the runner calls in-process: a parrot that answers from its prompt (the realistic one), an oracle that
// answers from the ground truth (scores perfectly), and a leaky one that answers from the whole transcript.
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
const linesOf = block => [...String(block).matchAll(/^\[(\d+)\] ([^:\n]+?): (.*)$/gm)].map(m => ({ n: Number(m[1]), speaker: m[2].replace(/ \(player\)$/, ''), player: m[2].endsWith('(player)'), text: m[3] }));
// The narration that opens a new place or time in these scenarios
const OPENS_SCENE = /^(Dusk|Dawn|Morning|Noon|Midday|Afternoon|Evening|Night|Late|Early|Past midnight|Next|That (?:evening|night)|Three days|Back|Out on|Inside|Down the|On the church|The (?:morning|prize|Lantern|Drowned|forge|bonfire))/;

// The organizer: one memory per line it was shown, quoting the line; nothing it wasn't shown
function learn(prompt, name) {
    const scenes = linesOf(prompt.slice(prompt.lastIndexOf('WAS IN:')));
    const memories = scenes.filter(s => norm(s.text).length >= 12).map(s => {
        const quote = s.text.split(/\s+/).slice(0, 12).join(' ');
        return { title: `${s.speaker === STORY ? 'Saw' : s.speaker}: ${s.text.slice(0, 50)}`, body: `${s.speaker === STORY ? '' : `${s.speaker} said: `}${s.text}`, keys: tokens(s.text).slice(0, 3), about: s.speaker === STORY ? [] : [s.speaker], importance: 0.6, emotion: 0.3, evidence: quote };
    });
    return { memories, facts: [], relations: [], state: { mood: 'thoughtful', on_mind: [], wants: [] }, intentions: [], finished: [], forgot: [], card: { who: `${name}, of Saltmere.`, looks: '', personality: '', voice: '' } };
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
        for (const k of known) if (new RegExp(`(^|[^\\p{L}])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}])`, 'u').test(l.text)) s.people.add(k);
        if (/\bLeo\b/.test(l.text)) s.people.add(player);
    }
    return { scenes: scenes.map(({ people, ...s }) => ({ ...s, present: [...people] })) };
}

// The auditor: a capitalized word or a number in a character's line that the story's recent messages or another
// character's block hold, and their own block doesn't, is a leak; it is cut from the fixed reply
function audit(prompt) {
    const draft = prompt.slice(prompt.lastIndexOf('DRAFT:') + 6).split('\n\nReturn only JSON')[0].trim();
    const knows = prompt.slice(prompt.indexOf('WHAT EACH CHARACTER KNOWS:'), prompt.lastIndexOf('DRAFT:'));
    const blocks = Object.fromEntries([...knows.matchAll(/^### (.+)\n([\s\S]*?)(?=^### |(?![\s\S]))/gm)].map(m => [m[1].trim(), m[2]]));
    const recent = prompt.slice(prompt.indexOf("THE STORY'S RECENT MESSAGES"), prompt.indexOf('WHAT EACH CHARACTER KNOWS:'));
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
    }
    return issues.length ? { issues, fixed } : { issues: [], fixed: '' };
}

function answer(prompt) {
    const memory = prompt.match(/^You are the memory of (.+?), processing/m);
    if (memory) return learn(prompt, memory[1]);
    if (/Split it into scenes/.test(prompt)) return place(prompt);
    if (/You check a draft reply/.test(prompt)) return audit(prompt);
    if (/These memories have faded/.test(prompt)) return { gists: [...prompt.matchAll(/^(m_[\w-]+): (.*)$/gm)].map(m => ({ id: m[1], gist: m[2].split(/[.!?]/)[0].slice(0, 80) || 'Something happened, once.' })) };
    return null;
}

export function fakeProvider() {
    const calls = [];
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
            const json = body.response_format ? answer(prompt) : null;
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
