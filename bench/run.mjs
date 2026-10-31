#!/usr/bin/env node
// The who-knows-what benchmark runner. It plays one or more scenarios (or the whole season) through one arm:
//   kiori                  recall -> the chat model -> check, and organize every 12 messages, with Kiori placing
//   kiori-given-presence   the same, with the spine's presence and modes sent on every message (separates placement
//                          errors from learning errors)
//   no-kiori               the same prompt template with the last 150 messages and nothing else (what apps do)
//   oracle-filter          each speaker gets only the messages they perceived, from the ground truth (the honest upper
//                          bound for "just filter the transcript")
// Probes are asked on a fork: their answers never enter the story. Every run writes a replay file (bench/README.md).
//
// By default everything is fake: a local Kiori server booted here, on a fake model provider, and a fake chat model.
// Any real model, or a remote Kiori, spends money: the runner prints its cost estimate and refuses unless --spend is
// given, and real runs are approved by the owner first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadStory, newState, applyMessage, applyFree, applyClock, clock, rowOf, perceive, opportunity, slipsIn, factsIn, entry as entryOf, STORY } from './engine.mjs';
import { score, leaksIn } from './scorer.mjs';
import { fakeProvider, fakeChat, isFake, FAKE_KEY, FAKE_BRAIN_MODEL } from './fake.mjs';
import { newReplay, addMessage, held as heldOf, blockRef, truthTracker, truthOf, validateReplay, formatReplay } from './replay.mjs';
import { tokens } from '../src/text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ARMS = ['kiori', 'kiori-given-presence', 'no-kiori', 'oracle-filter'];
const KIORI = new Set(['kiori', 'kiori-given-presence']);
const OPENROUTER = 'https://openrouter.ai/api/v1';
// Unit costs per call (docs/concepts.md, Haiku 5.5; see the cost table in bench/README.md)
export const UNITS = { placement: 0.002, learning: 0.002, recall: 0.00001, check: 0.001, judge: 0.0005, sleep_per_message: 0.00002 };
// Price per million tokens, input and output (Haiku 5.5 as measured, 2026-10-29)
const HAIKU = [0.10, 0.50];

// ---------- Options ----------
const HELP = `node bench/run.mjs [options]

  --arm <kiori|kiori-given-presence|no-kiori|oracle-filter>   (default kiori)
  --scenario <1|s1|1,3>       one or more scenarios, played as one story
  --season                    all eleven, as one story
  --chat-model <id>           fake/parrot (default), fake/oracle, fake/leaky, or a real model id
  --brain-model <id>          the model Kiori's local server organizes and checks with (default fake/brain)
  --judge-model <id>          a model for the cases the metrics table marks "judge" (default: none)
  --server <url>              a Kiori server to use instead of booting a local one (spends: needs --spend)
  --fake                      insist that everything is fake (an error if any model isn't)
  --spend                     allow real model calls (prints the estimate first; the owner approves real runs)
  --cap <usd>                 stop a real run when it has spent this much (default: twice the estimate)
  --out <file|dir>            where the replay goes (default bench/results/<date>-<arm>-<model>[-<scenarios>].replay.json)
  --window <n>                recent messages the chat model sees in the Kiori arms (default 20)
  --every <n> --hold <n>      organize's settings (default 12 and 4)
  --check <always|auto|fast|off>   check every free turn and probe answer (default); as the drop-in's auto does (the
                              pre-check on every one, the auditor when it has suspects or recall recommends a check);
                              the pre-check alone (free, never changes a line); or never
  --present-as <modes|hearers|room>   given presence: { name, mode } objects (default), names of those who hear in
                              full or on the phone, or everyone awake in the room (an app without modes)
  --send-modes                same as --present-as modes
  --chat-price <in,out>       chat model price per million tokens (default 0.10,0.50)
  --brain-price <in,out>      brain model price per million tokens (default 0.10,0.50)
  --judge-price <in,out>      judge model price per million tokens (default 0.10,0.50)
  --quiet                     print only the metrics and the replay path

Keys for real runs come from the environment, never from files: KIORI_BENCH_CHAT_KEY (and KIORI_BENCH_CHAT_URL,
default OpenRouter), KIORI_BENCH_BRAIN_KEY (and KIORI_BENCH_BRAIN_URL), KIORI_BENCH_JUDGE_KEY (default the chat key),
KIORI_BENCH_KIORI_KEY for --server.`;

export function parseArgs(argv) {
    const o = { arm: 'kiori', chatModel: 'fake/parrot', brainModel: FAKE_BRAIN_MODEL, judgeModel: null, scenario: null, season: false, server: null, spend: false, fake: false, out: null, cap: null, window: 20, every: 12, hold: 4, check: 'always', presentAs: 'modes', chatPrice: HAIKU, brainPrice: HAIKU, judgePrice: HAIKU, quiet: false, help: false };
    const price = v => { const p = String(v).split(',').map(Number); if (p.length !== 2 || p.some(x => !Number.isFinite(x) || x < 0)) throw new Error(`a price is "in,out" per million tokens, not "${v}"`); return p; };
    const flags = { '--spend': 'spend', '--season': 'season', '--fake': 'fake', '--quiet': 'quiet', '--help': 'help', '-h': 'help' };
    const values = { '--arm': 'arm', '--scenario': 'scenario', '--chat-model': 'chatModel', '--brain-model': 'brainModel', '--judge-model': 'judgeModel', '--server': 'server', '--out': 'out', '--cap': 'cap', '--window': 'window', '--every': 'every', '--hold': 'hold', '--check': 'check', '--present-as': 'presentAs', '--chat-price': 'chatPrice', '--brain-price': 'brainPrice', '--judge-price': 'judgePrice' };
    for (let i = 0; i < argv.length; i++) {
        const [a, inline] = argv[i].split(/=(.*)/s);
        if (a === '--send-modes') { o.presentAs = 'modes'; continue; }
        if (flags[a]) { o[flags[a]] = true; continue; }
        if (!values[a]) throw new Error(`unknown option ${a} (see --help)`);
        const v = inline ?? argv[++i];
        if (v == null) throw new Error(`${a} needs a value`);
        o[values[a]] = v;
    }
    for (const k of ['window', 'every', 'hold', 'cap']) if (o[k] != null) { o[k] = Number(o[k]); if (!Number.isFinite(o[k]) || o[k] < 0) throw new Error(`--${k} must be a number`); }
    for (const k of ['chatPrice', 'brainPrice', 'judgePrice']) if (typeof o[k] === 'string') o[k] = price(o[k]);
    if (!ARMS.includes(o.arm)) throw new Error(`--arm is one of ${ARMS.join(', ')}`);
    if (!['always', 'auto', 'fast', 'off'].includes(o.check)) throw new Error('--check is always, auto, fast or off');
    if (!['modes', 'hearers', 'room'].includes(o.presentAs)) throw new Error('--present-as is modes, hearers or room');
    if (!o.season && !o.scenario && !o.help) throw new Error('say which: --scenario <n> or --season');
    return o;
}

// What would cost money in this run, in words (empty: nothing)
export function spending(o) {
    const out = [];
    if (!isFake(o.chatModel)) out.push(`the chat model ${o.chatModel}`);
    if (KIORI.has(o.arm) && !o.server && !isFake(o.brainModel)) out.push(`the brain model ${o.brainModel}`);
    if (KIORI.has(o.arm) && o.server) out.push(`the Kiori server at ${o.server} (its brain model)`);
    if (o.judgeModel && !isFake(o.judgeModel)) out.push(`the judge ${o.judgeModel}`);
    return out;
}

// ---------- Scenarios ----------
export function loadScenarios({ scenario = null, season = false } = {}) {
    const dir = path.join(HERE, 'scenarios');
    const cast = JSON.parse(fs.readFileSync(path.join(dir, 'cast.json'), 'utf8'));
    const files = fs.readdirSync(dir).filter(f => /^\d\d-.*\.json$/.test(f)).sort();
    const all = files.map(f => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
    if (season) return { scenarios: all, cast, scope: 'season' };
    const want = String(scenario).split(',').map(s => s.trim().replace(/^s/i, '')).filter(Boolean);
    const picked = want.map(w => all.find(sc => sc.id === `s${Number(w)}`) ?? (() => { throw new Error(`no scenario ${w} (there are 1-${all.length})`); })());
    return { scenarios: picked, cast, scope: picked.map(s => s.id).join('+') };
}

// ---------- The cost estimate (from the unit costs) ----------
export function estimate(story, o) {
    const free = story.items.filter(i => i.type === 'free').length, probes = story.items.filter(i => i.type === 'probe').length;
    const stretches = Math.floor(story.messages / o.every);
    // People in each stretch: the brains that learn it
    const msgs = story.items.filter(i => i.type === 'message' || i.type === 'free');
    let present = 0;
    for (let s = 0; s < stretches; s++) {
        const names = new Set(msgs.slice(s * o.every, (s + 1) * o.every).flatMap(m => Object.entries(m.present).filter(([n, mode]) => mode !== 'asleep' && n !== story.player).map(([n]) => n)));
        present += names.size;
    }
    // The pre-check alone costs nothing; auto is priced as if the auditor ran every time (its upper bound)
    const kiori = KIORI.has(o.arm), checks = kiori && !['off', 'fast'].includes(o.check) ? free + probes : 0;
    const scale = ([i, out]) => (0.2 * i / HAIKU[0] + 0.8 * out / HAIKU[1]);   // output is ~80% of a learn call
    // Priced as a real run at the given prices, fake models included: a fake run shows what the real one would cost
    const brain = scale(o.brainPrice);
    const chatIn = kiori ? 8000 : 4000, chatOut = 300;
    const chatUnit = (chatIn * o.chatPrice[0] + chatOut * o.chatPrice[1]) / 1e6;
    const judgeUnit = o.judgeModel ? UNITS.judge * scale(o.judgePrice) : 0;
    const lines = [
        ['placement', o.arm === 'kiori' ? stretches : 0, UNITS.placement * brain],
        ['learning (present brains x stretches)', kiori ? present : 0, UNITS.learning * brain],
        ['recall', kiori ? free + probes : 0, UNITS.recall],
        ['check', checks, UNITS.check * brain],
        ['sleep', kiori ? story.messages : 0, UNITS.sleep_per_message * brain],
        [`chat model (${chatIn / 1000}k in, 0.3k out)`, free + probes, chatUnit],
        ['judge (about half the probes)', o.judgeModel ? Math.ceil(probes / 2) : 0, judgeUnit],
    ].map(([what, count, unit]) => ({ what, count, unit: round(unit), usd: round(count * unit) }));
    return { messages: story.messages, free, probes, stretches, lines, total: round(lines.reduce((t, l) => t + l.usd, 0)) };
}
const round = v => Math.round(v * 1e6) / 1e6;
export function printEstimate(e, o, log = console.log) {
    const fake = !spending(o).length;
    log(`Cost estimate for ${o.arm}, chat ${o.chatModel}, brain ${o.server ? `(the server's)` : o.brainModel}: ${e.messages} messages, ${e.free} free turns, ${e.probes} probes`);
    if (fake) log(`  (everything here is fake and spends nothing: this is what the same run would cost on real models at the given prices)`);
    for (const l of e.lines.filter(x => x.count)) log(`  ${l.what.padEnd(42)} ${String(l.count).padStart(5)} x $${l.unit.toFixed(6)} = $${l.usd.toFixed(4)}`);
    log(`  ${'total'.padEnd(42)} ${''.padStart(5)}             $${e.total.toFixed(4)}   (the measured averages run 20-30% under these units)`);
}

// ---------- Talking to Kiori and to models ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
function kioriClient(base, key) {
    const call = async (method, p, body) => {
        for (let attempt = 1; ; attempt++) {
            const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
            const data = await r.json().catch(() => ({}));
            if (r.ok) return data;
            if (attempt < 3 && [429, 502, 503].includes(r.status)) { await sleep(Number(r.headers.get('retry-after') ?? 1) * 1000); continue; }
            throw Object.assign(new Error(`${method} ${p}: ${r.status} ${data?.error?.message ?? ''}`.trim()), { status: r.status });
        }
    };
    return { post: (p, b) => call('POST', p, b), get: p => call('GET', p) };
}

// An OpenAI-compatible chat call (OpenRouter by default). Returns the text and what the provider says it used.
async function modelCall({ base, key, model, messages, maxTokens = 400, json = false }) {
    for (let attempt = 1; ; attempt++) {
        const r = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: json ? 0 : 0.8, usage: { include: true }, ...(json && { response_format: { type: 'json_object' } }) }) });
        const data = await r.json().catch(() => ({}));
        if (r.ok) return { text: String(data.choices?.[0]?.message?.content ?? ''), usage: data.usage ?? {} };
        if (attempt < 3 && [408, 429, 500, 502, 503, 504].includes(r.status)) { await sleep(1500 * attempt); continue; }
        throw new Error(`${model}: ${r.status} ${data?.error?.message ?? ''}`.trim());
    }
}

// The judge, for the cases the metrics table marks "judge"
function judgeWith(o, keys, meter) {
    if (!o.judgeModel) return null;
    if (isFake(o.judgeModel)) return async () => true;
    const ask = {
        topic: a => `Does this answer reveal the fact below, even in other words?\nFACT: ${a.fact.truth}\nQUESTION: ${a.question}\nANSWER: ${a.answer}`,
        hedge: a => `Does the speaker of this answer claim to know the fact below (rather than deny or dodge it)?\nFACT: ${a.fact.truth}\nQUESTION: ${a.question}\nANSWER: ${a.answer}`,
        attribution: a => `Does this answer say the speaker heard it from ${a.expected[0]}${a.expected[1] ? `, who had it from ${a.expected[1]}` : ''}?\nQUESTION: ${a.question}\nANSWER: ${a.answer}`,
    };
    return async args => {
        const t = Date.now();
        const r = await modelCall({ base: keys.judgeBase, key: keys.judge, model: o.judgeModel, json: true, maxTokens: 50, messages: [{ role: 'user', content: `${ask[args.kind](args)}\n\nReturn only JSON: {"verdict": true} or {"verdict": false}.` }] });
        meter('judge', r.usage, Date.now() - t, o.judgePrice);
        try { return JSON.parse(r.text.replace(/^\s*```(?:json)?|```\s*$/g, '')).verdict === true; } catch { return false; }
    };
}

// A local Kiori server in this process, on its own throwaway data folder: on the fake provider, or on a real brain key
async function bootLocal({ fake, brainKey, brainBase, brainModel, story }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiori-bench-'));
    // Set before Kiori's modules are first imported: config reads the environment once. The server's own model address
    // is a dead one, so nothing but the project's key below can reach a provider.
    Object.assign(process.env, { KIORI_DATA: dir, KIORI_LLM_BASE_URL: 'http://127.0.0.1:9', KIORI_PUBLIC_URL: 'http://kiori.localhost', KIORI_HOST: '127.0.0.1', KIORI_EMBED: '1', KIORI_LEARN_EVERY: '12', KIORI_LEARN_HOLD: '4', KIORI_PROXY_ALLOW_LOCAL: fake ? '1' : '0' });
    const provider = fake ? await fakeProvider({ story }) : null;
    const { startServer } = await import('../src/server.mjs');
    const { createProject } = await import('../src/accounts.mjs');
    const { setBrainKey } = await import('../src/providers.mjs');
    const own = createProject('Kiori bench', {}, { llmMode: 'own' });
    await setBrainKey(own.project.id, fake ? { key: FAKE_KEY, base_url: provider.url, model: FAKE_BRAIN_MODEL } : { key: brainKey, ...(brainBase && { base_url: brainBase }), model: brainModel });
    const log = console.log;
    console.log = () => {};   // the server's "running" line
    const server = startServer(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    console.log = log;
    return {
        url: `http://127.0.0.1:${server.address().port}`, key: own.key, provider,
        close: async () => { await new Promise(r => server.close(r)); await provider?.close(); fs.rmSync(dir, { recursive: true, force: true }); },
    };
}

// ---------- What Kiori is sent ----------
// Who was there, as the API takes it: { name, mode } objects (a plain name for full; the server reads modes since the
// partial-presence change), names of those who hear (full, or on the phone), or everyone awake in the room
export function presentFor(present, presentAs = 'modes') {
    const entries = Object.entries(present);
    if (presentAs === 'modes') return entries.map(([name, mode]) => (mode === 'full' ? name : { name, mode }));
    return entries.filter(([, mode]) => (presentAs === 'room' ? mode !== 'asleep' : mode === 'full' || mode === 'heard')).map(([name]) => name);
}
// A message of the story as an API message: narration, the player, or a named character; with who was there only
// when the arm gives presence
export const apiMessage = (m, { player, presentAs = null }) => ({
    id: `m${m.n}`, role: m.who === STORY ? 'narrator' : m.who === player ? 'user' : 'assistant',
    ...(m.who !== STORY && m.who !== player && { name: m.who }), content: m.text,
    ...(presentAs && { present: presentFor(m.present, presentAs) }),
});

// ---------- The chat prompt: one template for every arm ----------
const lineOf = (story, m, mode = 'full') => `[${m.n}] ${m.who === story.player ? `${m.who} (player)` : m.who}${mode === 'full' ? '' : ` (${mode === 'heard' ? 'you only heard this' : mode === 'overheard' ? 'you overheard this; … = words you missed' : 'you saw this but could not hear it'})`}: ${m.text}`;
export function chatPrompt({ story, speaker, mind, recent, probe = null, hint = '' }) {
    const p = story.people[speaker] ?? {};
    const system = `You are writing one character's next line in an ongoing story set in Saltmere, a fishing town on a cold northern coast. You write only for ${speaker}.

Rules:
- Write ${speaker}'s next line only, in their voice: one to three sentences of speech, with at most a short action in *stars*. Start with "${speaker}:".
- ${speaker} knows only what they witnessed or were told in this story. They never mention, hint at or guess what happened where they weren't.
- ${story.player} is the player's character.

WHO ${speaker.toUpperCase()} IS:
${[p.who, p.voice && `Voice: ${p.voice}`].filter(Boolean).join(' ')}

WHAT ${speaker.toUpperCase()} KNOWS:
${mind}

THE STORY SO FAR:
${recent || '(nothing yet)'}`;
    const user = probe ? `${probe.asker} asks ${speaker}: "${probe.ask}"\nWrite ${speaker}'s answer.` : `Write ${speaker}'s next line.${hint ? ` (Stage direction: ${hint})` : ''}`;
    return { system, user };
}
const NO_MIND = '(Nothing beyond the story below: what they witnessed in it is what they know.)';
// A reply as one line of the story: without its "Name:", one paragraph, at most 800 characters
const cleanLine = (text, speaker) => String(text ?? '').replace(new RegExp(`^\\s*\\**${speaker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\**\\s*:\\s*`, 'i'), '').replace(/\s*\n+\s*/g, ' ').trim().slice(0, 800) || '*says nothing*';

// ---------- The run ----------
export async function runBench(o) {
    const { scenarios, cast, scope } = loadScenarios(o);
    const story = loadStory(scenarios, cast);
    const est = estimate(story, o);
    const spends = spending(o);
    if (o.fake && spends.length) throw new Error(`--fake, but this run would use ${spends.join(', ')}`);
    if (spends.length && !o.spend) return { refused: true, estimate: est, spends };
    const keys = {
        chat: process.env.KIORI_BENCH_CHAT_KEY, chatBase: process.env.KIORI_BENCH_CHAT_URL || OPENROUTER,
        brain: process.env.KIORI_BENCH_BRAIN_KEY, brainBase: process.env.KIORI_BENCH_BRAIN_URL || null,
        judge: process.env.KIORI_BENCH_JUDGE_KEY || process.env.KIORI_BENCH_CHAT_KEY, judgeBase: process.env.KIORI_BENCH_JUDGE_URL || process.env.KIORI_BENCH_CHAT_URL || OPENROUTER,
        kiori: process.env.KIORI_BENCH_KIORI_KEY,
    };
    const missing = [!isFake(o.chatModel) && !keys.chat && 'KIORI_BENCH_CHAT_KEY', KIORI.has(o.arm) && !o.server && !isFake(o.brainModel) && !keys.brain && 'KIORI_BENCH_BRAIN_KEY', KIORI.has(o.arm) && o.server && !keys.kiori && 'KIORI_BENCH_KIORI_KEY', o.judgeModel && !isFake(o.judgeModel) && !keys.judge && 'KIORI_BENCH_JUDGE_KEY'].filter(Boolean);
    if (missing.length) throw new Error(`a real run needs ${missing.join(', ')} in the environment`);
    const cap = o.cap ?? (spends.length ? Math.max(0.5, 2 * est.total) : Infinity);

    const kioriArm = KIORI.has(o.arm), player = story.player;
    const local = kioriArm && !o.server ? await bootLocal({ fake: isFake(o.brainModel), brainKey: keys.brain, brainBase: keys.brainBase, brainModel: o.brainModel, story }) : null;
    const api = kioriArm ? kioriClient(local?.url ?? o.server.replace(/\/+$/, ''), local?.key ?? keys.kiori) : null;
    const date = new Date().toISOString().slice(0, 10);
    const run = { date, started: new Date().toISOString(), arm: o.arm, chat_model: o.chatModel, brain_model: kioriArm ? (o.server ? 'the server\'s' : o.brainModel) : null, judge_model: o.judgeModel, scope, server: kioriArm ? (o.server ? 'remote' : isFake(o.brainModel) ? 'local-fake' : 'local') : null, kiori: JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version, options: { window: o.window, history: 150, every: o.every, hold: o.hold, check: o.check, present_as: o.arm === 'kiori-given-presence' ? o.presentAs : null }, estimate_usd: est.total, errors: [] };
    const replay = newReplay({ run, story });
    const st = newState(story);
    // The truth as it changes: a delta at each message that changes it, from what everyone holds at the start (0)
    const truth = truthTracker(replay);
    truth.step(st, 0);
    const transcript = [], lines = [], probes = [], turnMs = [];
    const latency = {}, cost = { kiori_usd: 0, chat_usd: 0, judge_usd: 0, estimated_usd: 0 };
    let kioriTokens = { prompt: 0, completion: 0, usd: 0 }, kioriBase = null;
    const meter = (what, usage, ms, price) => {
        (latency[what] ??= { calls: 0, ms: 0 }).calls++;
        latency[what].ms += ms;
        if (!usage) return;
        const est$ = ((usage.prompt_tokens ?? 0) * price[0] + (usage.completion_tokens ?? 0) * price[1]) / 1e6;
        cost.estimated_usd += est$;
        cost[`${what}_usd`] = (cost[`${what}_usd`] ?? 0) + (Number(usage.cost) > 0 ? Number(usage.cost) : isFake(what === 'chat' ? o.chatModel : o.judgeModel) ? 0 : est$);
    };
    const timed = async (what, fn) => { const t = Date.now(); try { return await fn(); } finally { (latency[what] ??= { calls: 0, ms: 0 }).calls++; latency[what].ms += Date.now() - t; } };
    // Kiori's own spend, from its usage counts (only this run's: what was there before it is taken off)
    const kioriSpend = async () => {
        if (!api) return;
        const u = await api.get('/v1/usage?days=1').catch(() => null);
        if (!u) return;
        const ops = u.model.by_op ?? [];
        const now = { prompt: ops.reduce((t, x) => t + (x.prompt_tokens ?? 0), 0), completion: ops.reduce((t, x) => t + (x.completion_tokens ?? 0), 0), usd: u.model.totals.cost ?? 0 };
        kioriBase ??= now;
        const was = kioriTokens;
        kioriTokens = { prompt: now.prompt - kioriBase.prompt, completion: now.completion - kioriBase.completion, usd: now.usd - kioriBase.usd };
        cost.kiori_usd = kioriTokens.usd;
        cost.estimated_usd += ((kioriTokens.prompt - was.prompt) * o.brainPrice[0] + (kioriTokens.completion - was.completion) * o.brainPrice[1]) / 1e6;
    };
    await kioriSpend();

    // The brains: one light brain per character and walk-on, made from the cast (free: no model call)
    const brains = new Map();
    const chars = Object.values(story.people).filter(p => p.role !== 'player');
    if (kioriArm) for (const p of chars) {
        const made = await api.post('/v1/brains', { name: p.name, description: [p.who, p.voice && `Voice: ${p.voice}`].filter(Boolean).join('\n'), depth: 'light', others: chars.filter(x => x !== p).slice(0, 40).map(x => ({ name: x.name, who: x.who })) });
        brains.set(p.name, made.brain);
    }
    // Who a call carries: the story's characters, then the walk-ons who were around lately, at most 12 (one call's limit)
    const main = chars.filter(p => p.role === 'character').map(p => p.name);
    const groupFor = (must = []) => {
        const recent = [...new Set(transcript.slice(-(2 * o.every + o.hold)).reverse().flatMap(m => Object.keys(m.present)))].filter(n => brains.has(n) && !main.includes(n));
        return [...new Set([...must.filter(n => brains.has(n)), ...main, ...recent])].slice(0, 12);
    };
    const toApi = m => apiMessage(m, { player, presentAs: o.arm === 'kiori-given-presence' ? o.presentAs : null });
    const render = (msgs, viewer = null) => msgs.map(m => {
        if (!viewer) return lineOf(story, m);
        const seen = perceive(story, m.item, viewer, m.text);
        return seen && lineOf(story, { ...m, text: seen.text }, seen.mode);
    }).filter(Boolean).join('\n');
    const recentFor = speaker => (kioriArm ? render(transcript.slice(-o.window)) : o.arm === 'no-kiori' ? render(transcript.slice(-150)) : render(transcript.filter(m => m.present[speaker] && m.present[speaker] !== 'asleep').slice(-150), speaker));

    const recallFor = async (name, extra = []) => {
        const r = await timed('recall', () => api.post('/v1/brains/recall', { brain: brains.get(name), messages: [...transcript.slice(-6).map(toApi), ...extra], player }));
        return { text: r.text ?? r.characters?.[0]?.text ?? '', memories: r.characters?.[0]?.memories ?? [], check_recommended: r.check_recommended };
    };
    const checkDraft = async (speaker, text, extra = [], fast = false) => {
        const r = await timed('check', () => api.post('/v1/brains/check', { brains: groupFor([speaker]).map(n => brains.get(n)), messages: [...transcript.slice(-40).map(toApi), ...extra], draft: `${speaker}: ${text}`, player, ...(fast && { check: 'fast' }) }));
        return { ok: r.ok, issues: r.issues ?? [], suspects: r.suspects ?? [], fixed: cleanLine(r.fixed, speaker) };
    };
    const chat = async (args) => {
        const t = Date.now();
        const r = isFake(o.chatModel)
            ? fakeChat(o.chatModel, { ...args, view: { story, st, transcript } })
            : await modelCall({ base: keys.chatBase, key: keys.chat, model: o.chatModel, messages: [{ role: 'system', content: args.system }, { role: 'user', content: args.user }] });
        meter('chat', r.usage, Date.now() - t, o.chatPrice);
        return cleanLine(r.text, args.speaker);
    };
    // One character speaks (a free turn) or answers (a probe): their mind, the model, the check. The check as asked:
    // always the full one; auto as the drop-in does it (the pre-check, then the auditor when the pre-check has suspects
    // or recall recommends a check); fast, the pre-check alone (it never changes the text)
    const speak = async (speaker, { item, probe = null, hint = '' }) => {
        const extra = probe ? [{ role: probe.asker === player ? 'user' : 'assistant', ...(probe.asker !== player && { name: probe.asker }), content: probe.ask }] : [];
        let mind = NO_MIND, recalled = null;
        if (kioriArm) {
            try { recalled = await recallFor(speaker, extra); mind = recalled.text; }
            catch (e) { run.errors.push(`recall at ${item.n ?? item.after}: ${e.message}`); }
        }
        const { system, user } = chatPrompt({ story, speaker, mind, recent: recentFor(speaker), probe, hint });
        const draft = await chat({ system, user, speaker, item, probe });
        let text = draft, issues = [], suspects = [];
        if (kioriArm && o.check !== 'off') {
            try {
                let c = o.check === 'always' ? null : await checkDraft(speaker, draft, extra, true);
                if (o.check === 'always' || (o.check === 'auto' && (c.suspects.length || recalled?.check_recommended))) c = await checkDraft(speaker, draft, extra);
                ({ issues, suspects } = c);
                if (!c.ok && o.check !== 'fast') text = c.fixed;
            } catch (e) { run.errors.push(`check at ${item.n ?? item.after}: ${e.message}`); }
        }
        return { draft, text, issues, suspects, recalled };
    };
    // What the check flagged, against the ground truth before the line: real when the speaker couldn't know the flagged
    // words (a lie slip: the draft did slip; a lie: they keep that lie up), and the cut when the check took them out
    const catches = (said, draftSlips = []) => said.issues.map(i => {
        const who = i.character, row = st.K[who] ?? {};
        const quote = String(i.quote ?? '');
        let real;
        if (i.type === 'lie_slip') real = draftSlips.some(x => x.speaker === who);
        else if (i.type === 'lie') real = factsIn(story, said.draft).some(m => story.facts[m.fact].lie_of && entryOf(st, who, m.fact)?.told?.length && ['knows', 'believes_lie'].includes(entryOf(st, who, story.facts[m.fact].lie_of)?.state));
        else {
            const words = new Set(tokens(quote));
            real = Object.values(story.facts).some(f => {
                const e = row[f.id];
                if (e && ['knows', 'believes_lie'].includes(e.state)) return false;
                // The whole fact's canaries, and the parts they haven't got
                const theirs = e?.state === 'half' ? (e.parts ?? []) : [];
                const unknown = [...f.canaries, ...Object.entries(f.parts).filter(([part]) => !theirs.includes(part)).flatMap(([, cs]) => [cs].flat())];
                return unknown.some(c => tokens(c).some(w => words.has(w)));
            });
        }
        let at = said.draft.indexOf(quote);
        if (at < 0 && quote) at = said.draft.toLowerCase().indexOf(quote.toLowerCase());
        const word = at >= 0 ? said.draft.slice(at, at + quote.length) : null;
        const cut = said.text !== said.draft && word && !said.text.includes(word) ? { word, at } : null;
        return { character: who, type: i.type, quote, ...(i.why && { why: i.why }), by: i.by === 'precheck' ? 'precheck' : 'auditor', real, ...(cut && { cut }) };
    });
    // The last message of a scene, and what one person was there as
    const modeIn = (scene, upTo, name) => transcript.findLast(m => m.n <= upTo && m.item.scene === scene)?.present[name] ?? null;

    const costBy = {}, castBy = {};
    let organizeCalls = 0, brainsSent = 0;
    const costMark = () => ({ usd: cost.kiori_usd + cost.chat_usd + cost.judge_usd, estimated_usd: cost.estimated_usd, organize_calls: organizeCalls, brains_sent: brainsSent });
    let mark = costMark(), markScenario = story.scenarios[0]?.id;
    const closeScenario = id => {
        const now = costMark();
        costBy[id] = { usd: now.usd - mark.usd, estimated_usd: now.estimated_usd - mark.estimated_usd, organize_calls: now.organize_calls - mark.organize_calls, brains_sent: now.brains_sent - mark.brains_sent };
        castBy[id] = new Set(transcript.filter(m => m.scenario === id).flatMap(m => Object.keys(m.present)).filter(n => n !== player)).size;
        mark = now;
    };
    const checkpoint = async (kind, heldNames = []) => {
        await kioriSpend();
        let held = null;
        if (kioriArm) {
            held = {};
            for (const name of heldNames) {
                try { held[name] = heldOf(replay, await recallFor(name)); } catch (e) { run.errors.push(`recall for ${name}: ${e.message}`); }
            }
        }
        const at = transcript.length, last = replay.checkpoints.at(-1);
        const entry = { at, kind: [kind], truth: truthOf(st, truth.changed), held, cost: { kiori_usd: round(cost.kiori_usd), chat_usd: round(cost.chat_usd), judge_usd: round(cost.judge_usd), estimated_usd: round(cost.estimated_usd) }, latency_ms: Object.fromEntries(Object.entries(latency).map(([k, v]) => [k, v.ms])) };
        // An organize and a probe round after the same message are one checkpoint
        if (last && last.at === at) { last.kind = [...new Set([...last.kind, kind])]; last.truth = entry.truth; last.cost = entry.cost; last.latency_ms = entry.latency_ms; if (held) last.held = { ...(last.held ?? {}), ...held }; }
        else replay.checkpoints.push(entry);
        const spent = cost.kiori_usd + cost.chat_usd + cost.judge_usd;
        if (spent > cap) throw Object.assign(new Error(`stopped: spent $${spent.toFixed(4)}, over the cap of $${cap.toFixed(2)}`), { capped: true });
    };
    const organizeNow = async () => {
        const names = groupFor();
        organizeCalls++; brainsSent += names.length;
        try {
            const r = await timed('organize', () => api.post('/v1/brains/organize', { brains: names.map(n => brains.get(n)), messages: transcript.slice(-200).map(toApi), player, every: o.every, hold: o.hold }));
            r.brains.forEach((b, i) => brains.set(names[i], b));
            replay.organize.push({ at: transcript.length, sent: names, learned: r.learned, rewound: r.rewound, waiting: r.waiting, ...(r.warnings && { warnings: r.warnings }) });
            await checkpoint('organize', r.learned.filter(l => l.messages > 0).map(l => l.name));
        } catch (e) { if (e.capped) throw e; run.errors.push(`organize at ${transcript.length}: ${e.message}`); }
    };
    const append = (item, text, spine) => {
        const m = { n: item.n, who: spine ? item.who : item.speaker, text, present: item.present, spine, scenario: item.scenario, scene: item.scene, item };
        transcript.push(m);
        addMessage(replay, { n: m.n, who: m.who, text, present: m.present, spine, scene: m.scene });
    };

    let stopped = null;
    try {
        const items = story.items;
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const sid = item.scenario;
            if (sid !== markScenario) { closeScenario(markScenario); markScenario = sid; }
            if (item.type === 'clock') { applyClock(st, item); truth.step(st, Math.min(st.n, story.messages)); continue; }
            if (item.type === 'message') { applyMessage(st, item); append(item, item.text, true); truth.step(st, item.n); }
            else if (item.type === 'free') {
                const t = Date.now();
                const row = rowOf(st, item.speaker), opp = opportunity(st, item.speaker);
                const said = await speak(item.speaker, { item, hint: item.hint });
                // Weighed before the line changes anything: what the draft would have slipped, what the check caught
                const draftSlips = slipsIn(st, item, said.draft);
                const issues = catches(said, draftSlips);
                const res = applyFree(st, item, said.text);
                append(item, said.text, false);
                truth.step(st, item.n);
                const draftLeaks = leaksIn(story, row, said.draft).map(l => l.fact);
                lines.push({ n: item.n, scenario: sid, speaker: item.speaker, text: said.text, draft: said.draft, leaks: res.leaks.map(l => l.fact), draft_leaks: draftLeaks, opportunity: opp, slips: res.slips, draft_slips: draftSlips, issues, suspects: said.suspects, row });
                replay.turns.push({ n: item.n, ...(said.draft !== said.text && { draft: said.draft }), changed: said.draft !== said.text, block: said.recalled ? blockRef(replay, said.recalled.text) : null, ...(said.suspects.length && { suspects: said.suspects }), issues, leaks: res.leaks.map(l => l.fact), ...(draftLeaks.length && { draft_leaks: draftLeaks }), ...(res.slips.length && { slips: res.slips }), ...(draftSlips.length && { draft_slips: draftSlips }), ...(res.spread.length && { spread: res.spread }) });
                turnMs.push(Date.now() - t);
            } else if (item.type === 'probe') {
                // A round: every probe asked after this same message, each on the same fork of the story
                const round = [item];
                while (items[i + 1]?.type === 'probe' && items[i + 1].after === item.after) round.push(items[++i]);
                for (const p of round) {
                    clock(st, p.world_time);
                    truth.step(st, Math.min(st.n, story.messages));
                    const row = rowOf(st, p.target), opp = opportunity(st, p.target);
                    const said = await speak(p.target, { item: p, probe: p });
                    const issues = catches(said);
                    const rec = { ...p, answer: said.text, draft: said.draft, row, opportunity: opp, issues, suspects: said.suspects };
                    probes.push(rec);
                    // What the one asking could know of the facts asked about, and how the target was there last
                    const askerKnows = truthOf({ K: { [p.asker]: Object.fromEntries(p.facts.filter(f => st.K[p.asker]?.[f]).map(f => [f, st.K[p.asker][f]])) } }, truth.changed)[p.asker] ?? {};
                    replay.probes.push({ id: p.id, at: p.after, scenario: p.scenario, target: p.target, asker: p.asker, ask: p.ask, facts: p.facts, target_mode: modeIn(p.scene, p.after, p.target), asker_knows: askerKnows, answer: said.text, ...(said.draft !== said.text && { draft: said.draft }), changed: said.draft !== said.text, ...(said.suspects.length && { suspects: said.suspects }), ...(issues.length && { issues }), held: said.recalled ? heldOf(replay, said.recalled) : null });
                }
                await checkpoint('probes');
                continue;
            }
            if (kioriArm && transcript.length % o.every === 0) await organizeNow();
        }
    } catch (e) {
        if (!e.capped) throw e;
        stopped = e.message;
        run.errors.push(e.message);
    } finally {
        closeScenario(markScenario);
        await kioriSpend().catch(() => {});
    }
    const record = { story, lines, probes, cost, latency, turnMs, costBy, castBy };
    const judge = judgeWith(o, keys, meter);
    replay.metrics = await score(record, { judge });
    replay.probes.forEach((p, k) => { p.score = probes[k].score; });
    replay.metrics.cost = { ...replay.metrics.cost, ...(judge && { judge_usd: round(cost.judge_usd) }) };
    replay.checkpoints.push({ at: transcript.length, kind: ['end'], truth: truthOf(st, truth.changed), held: kioriArm ? Object.fromEntries(await Promise.all(main.filter(n => brains.has(n)).map(async n => [n, heldOf(replay, await recallFor(n))]))) : null, cost: { kiori_usd: round(cost.kiori_usd), chat_usd: round(cost.chat_usd), judge_usd: round(cost.judge_usd), estimated_usd: round(cost.estimated_usd) }, latency_ms: Object.fromEntries(Object.entries(latency).map(([k, v]) => [k, v.ms])) });
    run.finished = new Date().toISOString();
    if (stopped) run.stopped = stopped;
    await local?.close();

    const problems = validateReplay(replay);
    if (problems.length) throw new Error(`the replay doesn't fit its schema: ${problems.slice(0, 5).join('; ')}`);
    const slug = s => String(s).replace(/[^\w.-]+/g, '_');
    const name = `${date}-${o.arm}-${slug(o.chatModel)}${scope === 'season' ? '' : `-${slug(scope)}`}.replay.json`;
    const out = o.out ? (o.out.endsWith('.json') ? path.resolve(o.out) : path.resolve(o.out, name)) : path.join(HERE, 'results', name);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, formatReplay(replay));
    return { metrics: replay.metrics, replayPath: out, replay, estimate: est };
}

// ---------- The command ----------
export function summary(m) {
    const pct = v => (v == null ? '  n/a' : `${(v * 100).toFixed(1).padStart(5)}%`);
    return [
        `messages ${m.messages}, free lines ${m.lines}, probes ${m.probes}`,
        `  leak rate                ${pct(m.leak_rate)}   (${m.leaks} of ${m.opportunities} chances; drafts before check ${pct(m.leak_rate_drafts)}, caught by check ${m.caught_by_check}: caught by precheck ${m.caught_by_precheck}, by auditor ${m.caught_by_auditor})`,
        `  false-ignorance rate     ${pct(m.false_ignorance_rate)}`,
        `  attribution accuracy     ${pct(m.attribution_accuracy)}`,
        `  lie consistency          ${pct(m.lie_consistency)}   (drafts ${pct(m.lie_consistency_drafts)}; slips in free lines: ${m.lie_slips}, in drafts ${m.lie_slips_drafts}; lie slips flagged by check ${m.lie_slips_flagged}, ${m.lie_slips_flagged_real} real; lies flagged ${m.lies_flagged})`,
        `  gossip propagation F1    ${m.propagation_f1 == null ? '  n/a' : m.propagation_f1.toFixed(3).padStart(6)}   (tp ${m.propagation.tp}, fp ${m.propagation.fp}, fn ${m.propagation.fn})`,
        `  half-heard vagueness     ${pct(m.half_vagueness)}`,
        `  judged ${m.judged}, undecided without a judge ${m.undecided}`,
        `  cost                     $${m.cost.total_usd.toFixed(4)} spent ($${m.cost.per_message_usd.toFixed(6)} a message); at list prices $${m.cost.estimated_usd.toFixed(4)} ($${m.cost.estimated_per_message_usd.toFixed(6)} a message)`,
        `  latency (ms, average)    recall ${m.latency_ms.recall ?? '-'}, chat ${m.latency_ms.chat ?? '-'}, check ${m.latency_ms.check ?? '-'}, organize ${m.latency_ms.organize ?? '-'}, per free turn ${m.latency_ms.per_turn ?? '-'}`,
    ].join('\n');
}

async function main(argv) {
    let o;
    try { o = parseArgs(argv); } catch (e) { console.error(`run: ${e.message}`); return 1; }
    if (o.help) { console.log(HELP); return 0; }
    const { scenarios, cast } = loadScenarios(o);
    const est = estimate(loadStory(scenarios, cast), o);
    const spends = spending(o);
    if (!o.quiet || spends.length) printEstimate(est, o);
    if (spends.length && !o.spend) {
        console.error(`\nRefusing: this run would call ${spends.join(', ')}, which costs money (about $${est.total.toFixed(2)}). Nothing was called.\nAdd --spend to run it, once the owner has approved the spend.`);
        return 2;
    }
    try {
        const r = await runBench(o);
        console.log(`\n${summary(r.metrics)}`);
        if (r.replay.run.stopped) console.log(`\n${r.replay.run.stopped}`);
        if (r.replay.run.errors.length) console.log(`\n${r.replay.run.errors.length} call(s) failed along the way; see run.errors in the replay`);
        console.log(`\nreplay: ${r.replayPath}`);
        return 0;
    } catch (e) { console.error(`run: ${e.message}`); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2));
