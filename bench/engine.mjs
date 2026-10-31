// The ground truth of the who-knows-what benchmark: who knows which fact, how, from whom, since when. It is the
// executable spec of the perception modes (bench/README.md), so it never looks at Kiori: it reads the scripted spine (what
// is said and shown, to whom, in which mode) and the free lines the chat model wrote, and nothing else. Pure functions,
// no I/O; scenarios come in as parsed JSON.
//
// K[person][fact] = { state, via, origin, at, how, parts?, told?, exposed?, forgot?, leaked? }
//   state: knows | believes_lie | half | none (an absent entry is none)
//   via: the person they got it from (the first hop), null when they saw it, own it, or it is talk going around
//   origin: the person the teller said it came from, when the spine says so
//   at: the message number they got it at (0: they knew it from the start)
//   how: own | saw | heard | overheard | said | rumor
import crypto from 'node:crypto';
import { norm, tokens } from '../src/text.mjs';

export const MODES = ['full', 'heard', 'overheard', 'saw', 'asleep'];
export const STORY = 'STORY';
// The perception matrix (bench/README.md): what each mode sees of narration and hears of speech
const SEES = { full: true, heard: false, overheard: false, saw: true, asleep: false };
const HEARS = { full: 'all', heard: 'all', overheard: 'part', saw: 'none', asleep: 'none' };
const HOLDS = new Set(['knows', 'believes_lie']);

const fail = message => { throw new Error(`scenario: ${message}`); };
const list = v => (v == null ? [] : Array.isArray(v) ? v : [v]);

// ---------- Loading ----------
// A present list as { name: mode }: names are full, { name, mode } objects carry their mode
function presentMap(entries, where) {
    const out = {};
    for (const e of list(entries)) {
        const [name, mode] = typeof e === 'string' ? [e, 'full'] : [e?.name, e?.mode ?? 'full'];
        if (!name) fail(`${where}: a present entry without a name`);
        if (!MODES.includes(mode)) fail(`${where}: ${name} has an unknown mode "${mode}"`);
        out[name] = mode;
    }
    return out;
}

// One or more scenarios (in order) as one story. Facts are namespaced by scenario ("s3:crate"), messages are numbered
// across the whole story (n), and every free turn is one numbered message per speaker, so numbering is fixed before
// anything runs. cast: the shared cast file (bench/scenarios/cast.json).
export function loadStory(scenarios, cast = { people: {}, npcs: {} }) {
    scenarios = list(scenarios);
    const player = scenarios[0]?.player ?? cast.player ?? 'Leo';
    const story = { player, people: {}, facts: {}, items: [], scenarios: [] };
    // Who someone is comes from the cast file: its people are characters, its npcs the town's walk-on brains
    const person = name => {
        if (!story.people[name]) {
            const def = cast.people?.[name] ?? cast.npcs?.[name];
            if (!def && name !== player) fail(`${name} is in no cast (bench/scenarios/cast.json)`);
            const role = name === player ? 'player' : cast.people?.[name] ? 'character' : 'npc';
            story.people[name] = { name, role, who: def?.who ?? '', voice: def?.voice ?? '', groups: def?.groups ?? ['town'], aliases: def?.aliases ?? [] };
        }
        return story.people[name];
    };
    person(player);
    let n = 0;
    for (const sc of scenarios) {
        if (!sc?.id) fail('a scenario without an id');
        const ns = id => (String(id).includes(':') ? String(id) : `${sc.id}:${id}`);
        // "crate" or "crate.where": a fact, or one part of it
        const ref = r => {
            const [fact, part] = String(r).split('.');
            const id = ns(fact);
            if (!story.facts[id]) fail(`${sc.id}: no fact "${fact}"`);
            if (part && !story.facts[id].parts[part]) fail(`${sc.id}: fact "${fact}" has no part "${part}"`);
            return { fact: id, parts: part ? [part] : null };
        };
        for (const name of sc.cast ?? []) person(name);
        for (const name of sc.npcs ?? []) person(name);
        for (const [id, f] of Object.entries(sc.facts ?? {})) {
            if (!f.truth || !list(f.canaries).length) fail(`${sc.id}: fact "${id}" needs truth and canaries`);
            story.facts[ns(id)] = { id: ns(id), scenario: sc.id, truth: f.truth, canaries: list(f.canaries), parts: f.parts ?? {}, lie_of: f.lie_of ? ns(f.lie_of) : null, known_by: list(f.known_by), believed_by: list(f.believed_by) };
        }
        for (const f of Object.values(story.facts)) if (f.scenario === sc.id && f.lie_of && !story.facts[f.lie_of]) fail(`${sc.id}: ${f.id} is a lie of a fact that doesn't exist`);
        const from = n + 1;
        let present = {}, scene = null, probeNo = 0;
        for (const [i, e] of (sc.spine ?? []).entries()) {
            const where = `${sc.id} spine[${i}]`;
            if (e.scene) { scene = e.scene; present = presentMap(e.present, where); for (const p of Object.keys(present)) person(p); }
            const world_time = e.world_time ?? null;
            if (e.probe) {
                const p = e.probe;
                if (!p.target || !p.ask) fail(`${where}: a probe needs target and ask`);
                const expect = p.expect ?? {};
                const facts = [...new Set([...list(expect.knows), ...list(expect.not), ...list(expect.believes), ...list(expect.half), ...list(expect.lie)].map(r => ref(r).fact))];
                const asker = p.asker ?? player;
                person(p.target); person(asker);
                story.items.push({ type: 'probe', id: p.id ?? `${sc.id}-p${++probeNo}`, scenario: sc.id, after: n, scene, target: p.target, asker, ask: p.ask, expect, facts, world_time, present: { [p.target]: 'full', [asker]: 'full' } });
                continue;
            }
            if (e.free) {
                const here = e.present ? presentMap(e.present, where) : present;
                for (const speaker of list(e.free)) {
                    person(speaker);
                    if (!here[speaker] || !HEARS[here[speaker]] || here[speaker] === 'asleep') fail(`${where}: ${speaker} speaks in a free turn but isn't awake in the scene`);
                    story.items.push({ type: 'free', n: ++n, scenario: sc.id, scene, speaker, hint: e.hint ?? '', present: { ...here }, world_time });
                }
                continue;
            }
            if (e.text == null) { if (!e.scene) fail(`${where}: an entry that is no scene, message, free turn or probe`); if (world_time != null) story.items.push({ type: 'clock', after: n, world_time }); continue; }
            // Who comes in for this message, who changes for good from here (falls asleep, wakes), who differs for
            // this message only (the others at a whisper), and who leaves after it
            for (const e2 of list(e.enter)) Object.assign(present, presentMap([e2], where));
            if (e.becomes) for (const [name, mode] of Object.entries(e.becomes)) Object.assign(present, presentMap([{ name, mode }], where));
            const here = { ...present };
            if (e.modes) for (const [name, mode] of Object.entries(e.modes)) Object.assign(here, presentMap([{ name, mode }], where));
            const who = e.who ?? STORY;
            if (who !== STORY) { person(who); here[who] ??= 'full'; }
            for (const p of Object.keys(here)) person(p);
            const shows = [], says = [];
            for (const r of list(e.carries)) (who === STORY ? shows : says).push(ref(r));
            for (const r of list(e.shows)) shows.push(ref(r));
            for (const r of list(e.says)) says.push(ref(r));
            const lie = e.lie ? { fact: ref(e.lie.fact).fact, to: e.lie.to ? list(e.lie.to) : null } : null;
            if (lie && !story.facts[lie.fact].lie_of) fail(`${where}: lie of "${e.lie.fact}", which has no lie_of`);
            if (lie && !says.some(s => s.fact === lie.fact)) says.push({ fact: lie.fact, parts: null });
            if (who === STORY && says.length) fail(`${where}: narration can only show, not say`);
            const half = Object.fromEntries(Object.entries(e.half ?? {}).map(([f, parts]) => { const r = ref(f); for (const p of list(parts)) ref(`${f}.${p}`); return [r.fact, list(parts)]; }));
            const forgets = Object.fromEntries(Object.entries(e.forgets ?? {}).map(([name, facts]) => [name, list(facts).map(f => ref(f).fact)]));
            const item = { type: 'message', n: ++n, scenario: sc.id, scene, who, role: who === STORY ? 'narrator' : who === player ? 'user' : 'assistant', text: e.text, present: here, world_time, shows, says, lie, half, origin: e.origin ?? null, forgets, public: e.public ? { spread: list(e.public.spread) } : null };
            story.items.push(item);
            for (const name of list(e.leave)) delete present[typeof name === 'string' ? name : name.name];
        }
        story.scenarios.push({ id: sc.id, title: sc.title ?? sc.id, from, to: n });
    }
    story.messages = n;
    return story;
}

// ---------- Matching canaries ----------
const padded = s => ` ${norm(s)} `;
export const says = (text, phrase) => Boolean(norm(phrase)) && padded(text).includes(padded(phrase));
// Which facts a text gives away, and how much: full (a canary of the whole fact) and the parts it names
export function factsIn(story, text) {
    const t = padded(text), out = [];
    for (const f of Object.values(story.facts)) {
        const full = f.canaries.filter(c => t.includes(padded(c)));
        const parts = Object.entries(f.parts).filter(([, cs]) => list(cs).some(c => t.includes(padded(c)))).map(([p]) => p);
        if (full.length || parts.length) out.push({ fact: f.id, full: full.length > 0, parts, words: [...full, ...Object.entries(f.parts).flatMap(([, cs]) => list(cs).filter(c => t.includes(padded(c))))] });
    }
    return out;
}

// ---------- State ----------
export function newState(story) {
    // n: the last message applied, so talk that reaches someone later is dated when it reached them
    const st = { story, K: {}, clock: 0, n: 0, spreads: [], log: [] };
    for (const name of Object.keys(story.people)) st.K[name] = {};
    for (const f of Object.values(story.facts)) {
        for (const name of f.known_by) set(st, name, f.id, { state: 'knows', via: null, origin: name, at: 0, how: 'own' });
        for (const name of f.believed_by) set(st, name, f.id, { state: 'believes_lie', via: null, origin: null, at: 0, how: 'own' });
    }
    return st;
}
const set = (st, name, fact, e) => { (st.K[name] ??= {})[fact] = clean(e); st.log.push({ at: e.at, name, fact, state: e.state }); };
export const entry = (st, name, fact) => st.K[name]?.[fact] ?? null;
export const stateOf = (st, name, fact) => entry(st, name, fact)?.state ?? 'none';
export const holds = (st, name, fact) => HOLDS.has(stateOf(st, name, fact));

// Someone takes in a fact. Knowing never goes back down (forgetting aside); a half-heard fact gains parts, and becomes
// whole when it is heard or seen whole. A false fact (a lie, a mistake) is believed unless they know the truth it
// denies; learning that truth exposes it: they still know it was said, they no longer believe it.
function learn(st, name, fact, info) {
    const f = st.story.facts[fact];
    let { state } = info;
    // Knowing the truth, even part of it (Rook saw the cart go into the ice-house), means not believing the lie
    if (state === 'knows' && f.lie_of && !holds(st, name, f.lie_of) && stateOf(st, name, f.lie_of) !== 'half') state = 'believes_lie';
    const cur = entry(st, name, fact);
    const parts = state === 'half' ? [...new Set(info.parts ?? [])] : undefined;
    if (!cur || cur.state === 'none') set(st, name, fact, { ...info, state, parts });
    else if (cur.state === 'half' && state === 'half') cur.parts = [...new Set([...cur.parts, ...parts])];
    else if (cur.state === 'half') set(st, name, fact, { ...info, state, parts: undefined, told: cur.told });
    if (state === 'none' || f.lie_of) return;
    for (const lie of Object.values(st.story.facts)) {
        const e = lie.lie_of === fact && entry(st, name, lie.id);
        if (e && e.state === 'believes_lie') { e.state = 'knows'; e.exposed = info.at; st.log.push({ at: info.at, name, fact: lie.id, state: 'knows', exposed: true }); }
    }
}
const clean = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== false));
const tell = (st, name, fact, to) => { const e = entry(st, name, fact); if (e && to.length) e.told = [...new Set([...(e.told ?? []), ...to])]; };

// The world clock moves (never back); talk that was announced reaches each group when its time comes
export function clock(st, t) {
    if (t != null && t > st.clock) st.clock = t;
    for (const s of st.spreads) for (const step of s.steps) {
        if (st.clock < s.t0 + (step.after ?? 0)) continue;
        const groups = list(step.groups);
        for (const p of Object.values(st.story.people)) {
            if (!groups.includes('*') && !p.groups.some(g => groups.includes(g))) continue;
            for (const r of s.facts) if (stateOf(st, p.name, r.fact) === 'none' && !entry(st, p.name, r.fact)?.forgot) learn(st, p.name, r.fact, { state: r.parts ? 'half' : 'knows', parts: r.parts ?? undefined, via: null, origin: s.by ?? undefined, at: Math.max(s.at, st.n), how: 'rumor' });
        }
    }
}

// A scene that moves the clock on: what reaches people now reaches them with the next message
export function applyClock(st, item) {
    st.n = Math.max(st.n, item.after + 1);
    clock(st, item.world_time);
}

// A spine message, applied by perception mode. What the speaker says that they didn't hold (a lie they make up, a
// story they garble) is theirs from then on.
export function applyMessage(st, item) {
    st.n = item.n;
    clock(st, item.world_time);
    const speaker = item.who === STORY ? null : item.who;
    if (speaker) for (const r of item.says) {
        if (holds(st, speaker, r.fact)) continue;
        if (!r.parts) set(st, speaker, r.fact, { state: 'knows', via: null, origin: speaker, at: item.n, how: 'said', told: entry(st, speaker, r.fact)?.told });
        else if (!r.parts.every(p => entry(st, speaker, r.fact)?.parts?.includes(p))) learn(st, speaker, r.fact, { state: 'half', parts: r.parts, via: null, origin: speaker, at: item.n, how: 'said' });
    }
    const hearers = [];
    for (const [name, mode] of Object.entries(item.present)) {
        if (name === speaker) continue;
        if (SEES[mode]) for (const r of item.shows) learn(st, name, r.fact, { state: r.parts ? 'half' : 'knows', parts: r.parts ?? undefined, via: null, origin: null, at: item.n, how: 'saw' });
        const hears = HEARS[mode];
        if (hears === 'none' || !item.says.length) continue;
        hearers.push(name);
        for (const r of item.says) {
            const info = { via: speaker, origin: item.origin ?? undefined, at: item.n };
            if (hears === 'all') learn(st, name, r.fact, { ...info, state: r.parts ? 'half' : 'knows', parts: r.parts ?? undefined, how: 'heard' });
            else learn(st, name, r.fact, { ...info, state: 'half', parts: (item.half[r.fact] ?? []).filter(p => !r.parts || r.parts.includes(p)), how: 'overheard' });
        }
    }
    if (speaker) for (const r of item.says) tell(st, speaker, r.fact, item.lie?.fact === r.fact && item.lie.to ? item.lie.to : hearers);
    for (const [name, facts] of Object.entries(item.forgets)) for (const f of facts) set(st, name, f, { state: 'none', forgot: true, at: item.n });
    if (item.public) st.spreads.push({ t0: st.clock, at: item.n, by: speaker, steps: item.public.spread, facts: [...item.says, ...item.shows] });
    clock(st, null);
}

// A free line the chat model wrote (as shown, after any check). A canary said by someone who holds that fact reaches
// the people who heard the line; said by someone who doesn't, it is a leak (and still reaches them: the story now
// contains it). A liar who tells the truth in front of someone they lied to has slipped.
export function applyFree(st, item, text) {
    st.n = item.n;
    clock(st, item.world_time);
    const speaker = item.speaker, leaks = [], slips = [], spread = [];
    const found = factsIn(st.story, text);
    for (const m of found) {
        const e = entry(st, speaker, m.fact);
        const legit = (e && HOLDS.has(e.state)) || (e?.state === 'half' && !m.full && m.parts.every(p => e.parts.includes(p)));
        if (!legit) leaks.push({ n: item.n, speaker, fact: m.fact, words: m.words });
        const hearers = [];
        for (const [name, mode] of Object.entries(item.present)) {
            if (name === speaker || HEARS[mode] === 'none') continue;
            hearers.push(name);
            const before = stateOf(st, name, m.fact);
            const info = { via: speaker, at: item.n, ...(legit ? {} : { leaked: true }) };
            if (HEARS[mode] === 'all') learn(st, name, m.fact, { ...info, state: m.full ? 'knows' : 'half', parts: m.full ? undefined : m.parts, how: 'heard' });
            else learn(st, name, m.fact, { ...info, state: 'half', parts: [], how: 'overheard' });
            if (stateOf(st, name, m.fact) !== before) spread.push({ name, fact: m.fact });
        }
        if (legit) tell(st, speaker, m.fact, hearers);
    }
    for (const lie of Object.values(st.story.facts)) {
        const told = entry(st, speaker, lie.id)?.told ?? [];
        const victims = told.filter(v => item.present[v] && HEARS[item.present[v]] !== 'none');
        if (lie.lie_of && victims.length && found.some(m => m.fact === lie.lie_of && m.full) && holds(st, speaker, lie.lie_of)) slips.push({ n: item.n, speaker, fact: lie.id, to: victims });
    }
    return { leaks, slips, spread };
}

// Is this a chance to leak: is there a fact someone holds by now that this person doesn't fully know?
export function opportunity(st, name) {
    return Object.values(st.story.facts).some(f => !holds(st, name, f.id) && Object.keys(st.K).some(p => p !== name && holds(st, p, f.id)));
}

// The story played through on its spine; free turns get their text from freeText(item) (none by default), probes are
// recorded with the target's knowledge at that moment. For the tests, and the runner's dry estimate.
export function runSpine(story, { freeText = () => '' } = {}) {
    const st = newState(story), probes = [], leaks = [];
    for (const item of story.items) {
        if (item.type === 'clock') applyClock(st, item);
        else if (item.type === 'message') applyMessage(st, item);
        else if (item.type === 'free') leaks.push(...applyFree(st, item, freeText(item) ?? '').leaks);
        else if (item.type === 'probe') { clock(st, item.world_time); probes.push({ probe: item, row: rowOf(st, item.target) }); }
    }
    return { st, probes, leaks };
}

// ---------- Views ----------
// One person's knowledge, copied
export const rowOf = (st, name) => structuredClone(st.K[name] ?? {});
// The whole table, compact for a replay: only what someone holds, as [state, via, origin, at] (+ parts when half)
export function snapshot(st) {
    const out = {};
    for (const [name, row] of Object.entries(st.K)) {
        const facts = Object.entries(row).filter(([, e]) => e.state !== 'none');
        if (facts.length) out[name] = Object.fromEntries(facts.map(([f, e]) => [f, e.state === 'half' ? [e.state, e.via ?? null, e.origin ?? null, e.at, e.parts] : [e.state, e.via ?? null, e.origin ?? null, e.at]]));
    }
    return out;
}

// A message as this person perceived it, or null when they weren't there (or slept): what the oracle-filter arm shows
// a speaker. Narration only to eyes, speech only to ears; overheard speech is masked (every canary word they didn't
// catch, and about 40% of the other words, seeded by the text so it's the same mask each time).
export function perceive(story, item, name, text = item.text) {
    const mode = item.present?.[name];
    if (!mode || mode === 'asleep') return null;
    const who = item.type === 'free' ? item.speaker : item.who;
    if (who === name) return { mode: 'full', text };
    const narration = who === STORY;
    if (mode === 'full') return { mode, text };
    if (mode === 'saw') return { mode, text: narration ? text : (text.match(/\*[^*]+\*/g) ?? []).concat('(words you couldn\'t hear)').join(' ') };
    if (narration) return { mode, text: '(something happens that you can\'t see)' };
    const words = text.replace(/\*[^*]+\*/g, ' ').replace(/\s+/g, ' ').trim();
    if (mode === 'heard') return { mode, text: words || '(nothing you could hear)' };
    // overheard: the parts the spine says they caught stay, every other canary word goes, then 40% of the rest
    const keep = new Set(), drop = new Set();
    for (const f of Object.values(story.facts)) {
        const caught = item.half?.[f.id] ?? [];
        for (const [p, cs] of Object.entries(f.parts)) for (const c of list(cs)) for (const w of tokens(c)) (caught.includes(p) ? keep : drop).add(w);
        for (const c of f.canaries) for (const w of tokens(c)) drop.add(w);
    }
    for (const w of keep) drop.delete(w);
    const seed = crypto.createHash('sha256').update(words).digest();
    let i = 0;
    const masked = words.split(' ').map(w => {
        const t = tokens(w)[0];
        if (!t) return w;
        const k = i++;
        return drop.has(t) || (!keep.has(t) && seed[k % seed.length] % 10 < 4) ? '…' : w;
    }).join(' ');
    return { mode, text: masked };
}

// ---------- Checking a scenario ----------
// What's wrong with a story as written, played on its spine alone: a canary in a spine line that the line doesn't
// declare (or a declared fact whose words aren't there), a probe question or a free-turn hint that gives a canary
// away, a probe whose expectation the ground truth doesn't bear out, and a scenario outside 60-150 messages.
export function lint(story) {
    const problems = [], refFact = r => `${r.fact}${r.parts ? `.${r.parts[0]}` : ''}`;
    for (const item of story.items) {
        if (item.type === 'message') {
            const declared = [...item.says, ...item.shows];
            for (const m of factsIn(story, item.text)) if (!declared.some(r => r.fact === m.fact)) problems.push(`#${item.n}: says "${m.words[0]}" (${m.fact}) without declaring it`);
            for (const r of declared) {
                const f = story.facts[r.fact];
                const words = r.parts ? r.parts.flatMap(p => list(f.parts[p])) : [...f.canaries];
                if (!words.some(w => says(item.text, w))) problems.push(`#${item.n}: declares ${refFact(r)} but none of its words are in the text`);
            }
        }
        const asked = item.type === 'probe' ? item.ask : item.type === 'free' ? item.hint : '';
        for (const m of factsIn(story, asked)) problems.push(`${item.type === 'probe' ? item.id : `#${item.n} hint`}: gives away "${m.words[0]}"`);
    }
    const { probes } = runSpine(story);
    for (const { probe: p, row } of probes) {
        const e = p.expect, ns = r => { const [f, part] = String(r).split('.'); return { fact: f.includes(':') ? f : `${p.scenario}:${f}`, part }; };
        const st = f => row[f]?.state ?? 'none';
        const bad = why => problems.push(`${p.id} (${p.target}): ${why}`);
        for (const r of list(e.knows).map(ns)) if (!(HOLDS.has(st(r.fact)) || (r.part && row[r.fact]?.parts?.includes(r.part)))) bad(`expected to know ${r.fact}${r.part ? `.${r.part}` : ''}, is ${st(r.fact)}`);
        for (const r of list(e.not).map(ns)) if (r.part ? HOLDS.has(st(r.fact)) || row[r.fact]?.parts?.includes(r.part) : HOLDS.has(st(r.fact))) bad(`expected not to know ${r.fact}, is ${st(r.fact)}`);
        for (const r of list(e.believes).map(ns)) if (st(r.fact) !== 'believes_lie') bad(`expected to believe ${r.fact}, is ${st(r.fact)}`);
        for (const r of list(e.half).map(ns)) if (st(r.fact) !== 'half') bad(`expected to half know ${r.fact}, is ${st(r.fact)}`);
        for (const r of list(e.lie).map(ns)) if (!row[r.fact]?.told?.includes(p.asker) || !HOLDS.has(st(story.facts[r.fact].lie_of))) bad(`expected to keep up ${r.fact} toward ${p.asker}`);
        const held = p.facts.find(f => st(f) !== 'none' && !story.facts[f].lie_of) ?? p.facts.find(f => st(f) !== 'none');
        if (e.via && row[held]?.via !== e.via) bad(`expected it via ${e.via}, has it via ${row[held]?.via ?? 'nobody'}`);
        if (e.origin && row[held]?.origin !== e.origin) bad(`expected it to come from ${e.origin}, has ${row[held]?.origin ?? 'nobody'}`);
    }
    for (const s of story.scenarios) { const count = s.to - s.from + 1; if (count < 60 || count > 150) problems.push(`${s.id}: ${count} messages (60-150)`); }
    return problems;
}
