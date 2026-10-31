// Scoring a run against the ground truth: the metrics table in bench/README.md. Canaries and names are
// matched deterministically; a judge (an async function, a model in a real run) is asked only for the cases the table
// marks "judge": topic words without the canary, an answer that has the canary but denies knowing, and several names
// where one was asked for. Without a judge those cases are decided the deterministic way and counted as undecided.
import { factsIn, says } from './engine.mjs';
import { tokens, mentions } from '../src/text.mjs';

const HOLDS = new Set(['knows', 'believes_lie']);
const list = v => (v == null ? [] : Array.isArray(v) ? v : [v]);
const rate = (num, den) => (den ? Math.round((num / den) * 1000) / 1000 : null);
// "I don't know", "never heard", ...: an answer that has the words but says it doesn't know them
const DENIES = /\b(don'?t know|do not know|no idea|never heard|haven'?t heard|can'?t say|couldn'?t say|not sure|couldn'?t tell|no notion)\b/i;

// What a text gives away that its speaker doesn't know, given their knowledge row: a canary of a fact they don't hold,
// or a part of one beyond the parts they half know
export function leaksIn(story, row, text) {
    const out = [];
    for (const m of factsIn(story, text)) {
        const e = row[m.fact];
        const legit = (e && HOLDS.has(e.state)) || (e?.state === 'half' && !m.full && m.parts.every(p => e.parts?.includes(p)));
        if (!legit) out.push({ fact: m.fact, words: m.words });
    }
    return out;
}

// Facts the text seems to be about without a canary: two or more of the fact's own rarer words (not names, not words
// the question already used). Only a judge can tell whether that gives the fact away.
export function topicHints(story, row, text, asked = '') {
    const names = new Set(Object.values(story.people).flatMap(p => tokens(p.name)));
    const skip = new Set([...tokens(asked), ...names]);
    const have = new Set(tokens(text));
    const found = new Set(factsIn(story, text).map(m => m.fact));
    return Object.values(story.facts).filter(f => !found.has(f.id) && !HOLDS.has(row[f.id]?.state ?? 'none'))
        .filter(f => new Set(tokens(f.truth.replace(/^\(false\)\s*/, '')).filter(w => w.length >= 5 && !skip.has(w) && have.has(w))).size >= 2)
        .map(f => f.id);
}

// The people a text names (by name, alias, or one of their name words)
export const named = (story, text) => Object.values(story.people).filter(p => mentions(text, p)).map(p => p.name);

// One probe answer, scored. row: the target's knowledge when the probe was asked.
export async function scoreProbe(story, probe, answer, row, { judge = null } = {}) {
    const out = { leaks: leaksIn(story, row, answer).map(l => l.fact), facts: {}, judged: [], undecided: [] };
    const ask = async (kind, args, fallback) => {
        if (!judge) { out.undecided.push(kind); return fallback; }
        const verdict = Boolean(await judge({ kind, question: probe.ask, answer, ...args }));
        out.judged.push({ kind, verdict, ...(args.fact && { fact: args.fact.id }) });
        return verdict;
    };
    for (const id of topicHints(story, row, answer, probe.ask)) if (await ask('topic', { fact: story.facts[id] }, false)) out.leaks.push(id);
    const people = named(story, answer).filter(n => n !== probe.target);
    for (const f of probe.facts) {
        const fact = story.facts[f], e = row[f] ?? { state: 'none' };
        const m = factsIn(story, answer).find(x => x.fact === f) ?? { full: false, parts: [] };
        const said = m.full ? 'full' : m.parts.length ? 'parts' : 'none';
        const r = { truth: e.state, said };
        if (HOLDS.has(e.state)) {
            r.ignorant = said === 'none';
            if (!r.ignorant && DENIES.test(answer)) r.ignorant = !(await ask('hedge', { fact }, true));
        }
        if (e.state === 'half' && e.parts?.length) r.vague = !m.full && m.parts.length > 0 && m.parts.every(p => e.parts.includes(p));
        out.facts[f] = r;
    }
    // Attribution: the first hop (and the origin, when the probe asks for it) of the fact they hold
    if (probe.expect?.via || probe.expect?.origin) {
        const held = probe.facts.find(f => (row[f]?.state ?? 'none') !== 'none' && !story.facts[f].lie_of) ?? probe.facts.find(f => (row[f]?.state ?? 'none') !== 'none');
        const e = held && row[held];
        if (e?.via) {
            const want = [e.via, ...(probe.expect.origin && e.origin ? [e.origin] : [])];
            let ok = want.every(n => people.includes(n));
            // Other names (not the teller, the true origin or the one asking) make it a judge's call
            if (ok && people.some(n => !want.includes(n) && n !== e.origin && n !== probe.asker)) ok = await ask('attribution', { expected: want, names: people }, true);
            out.attribution = { expected: want, named: people, ok };
        }
    }
    // Lies: the liar keeps it up toward the one they told; the one who believes it holds it. Neither shows the truth.
    for (const l of [...list(probe.expect?.lie), ...list(probe.expect?.believes)]) {
        const id = String(l).includes(':') ? l : `${probe.scenario}:${l}`, lie = story.facts[id];
        if (!lie?.lie_of) continue;
        const liar = list(probe.expect?.lie).includes(l);
        const applies = liar ? row[id]?.told?.includes(probe.asker) && HOLDS.has(row[lie.lie_of]?.state) : row[id]?.state === 'believes_lie';
        if (!applies) continue;
        const truth = story.facts[lie.lie_of];
        const showsTruth = [...truth.canaries, ...Object.values(truth.parts).flat()].some(c => says(answer, c));
        out.lie = { fact: id, role: liar ? 'liar' : 'believer', ok: lie.canaries.some(c => says(answer, c)) && !showsTruth };
    }
    return out;
}

// The metrics of a whole run. record: { story, lines, probes, cost, latency } as the runner keeps them:
// lines: [{ n, scenario, speaker, text, draft, leaks, draft_leaks, opportunity, slips }]
// probes: [{ ...probe, answer, row, opportunity }]
export async function score(record, { judge = null } = {}) {
    const { story } = record;
    const scored = [];
    for (const p of record.probes) scored.push({ p, s: p.score ?? (p.score = await scoreProbe(story, p, p.answer, p.row, { judge })) });
    const metricsOf = (lines, probes) => {
        const facts = probes.flatMap(({ p, s }) => Object.entries(s.facts).map(([f, r]) => ({ p, s, f, r })));
        const opp = lines.filter(l => l.opportunity).length + probes.filter(x => x.p.opportunity).length;
        const leaking = lines.filter(l => l.leaks.length).length + probes.filter(x => x.s.leaks.length).length;
        // Before the check: the drafts the chat model wrote, lines and answers alike
        const draftLeaks = x => leaksIn(story, x.p.row ?? {}, x.p.draft ?? x.p.answer).length > 0;
        const should = facts.filter(x => HOLDS.has(x.r.truth));
        const attr = probes.filter(x => x.s.attribution);
        const lies = probes.filter(x => x.s.lie);
        const half = facts.filter(x => x.r.vague !== undefined);
        // Propagation F1 over (character, fact, knows?, via): a hit needs the right first hop when the probe asks for it
        let tp = 0, fp = 0, fn = 0;
        for (const x of facts) {
            const truth = x.r.truth !== 'none', pred = x.r.said !== 'none' && !x.r.ignorant;
            const viaOk = !x.s.attribution || x.s.attribution.ok;
            if (truth && pred && viaOk) tp++;
            else if (!truth && pred) fp++;
            else if (truth) fn++;
        }
        return {
            lines: lines.length, probes: probes.length,
            leak_rate: rate(leaking, opp), leaks: leaking, opportunities: opp,
            leak_rate_drafts: rate(lines.filter(l => l.opportunity && l.draft_leaks?.length).length + probes.filter(x => x.p.opportunity && draftLeaks(x)).length, opp),
            caught_by_check: lines.filter(l => l.draft_leaks?.length && !l.leaks.length).length + probes.filter(x => draftLeaks(x) && !x.s.leaks.length).length,
            false_ignorance_rate: rate(should.filter(x => x.r.ignorant).length, should.length),
            attribution_accuracy: rate(attr.filter(x => x.s.attribution.ok).length, attr.length),
            lie_consistency: rate(lies.filter(x => x.s.lie.ok).length, lies.length),
            propagation_f1: tp + fp + fn ? Math.round((2 * tp / (2 * tp + fp + fn)) * 1000) / 1000 : null,
            propagation: { tp, fp, fn },
            half_vagueness: rate(half.filter(x => x.r.vague).length, half.length),
            lie_slips: lines.reduce((t, l) => t + (l.slips?.length ?? 0), 0),
            judged: probes.reduce((t, x) => t + x.s.judged.length, 0),
            undecided: probes.reduce((t, x) => t + x.s.undecided.length, 0),
        };
    };
    const all = metricsOf(record.lines, scored);
    const by_scenario = Object.fromEntries(story.scenarios.map(sc => [sc.id, metricsOf(record.lines.filter(l => l.scenario === sc.id), scored.filter(x => x.p.scenario === sc.id))]));
    const messages = story.messages;
    const cost = record.cost ?? {};
    const spent = (cost.kiori_usd ?? 0) + (cost.chat_usd ?? 0) + (cost.judge_usd ?? 0);
    const latency = record.latency ?? {};
    const avg = k => (latency[k]?.calls ? Math.round(latency[k].ms / latency[k].calls) : null);
    // Scale: what a turn cost against how many brains the story has, per scenario (the cast only grows in s11)
    const scale = Object.fromEntries(story.scenarios.map(sc => {
        const c = record.costBy?.[sc.id];
        return [sc.id, { messages: sc.to - sc.from + 1, cast: record.castBy?.[sc.id] ?? null, ...(c && { usd: round(c.usd), usd_per_message: round(c.usd / (sc.to - sc.from + 1)), estimated_usd: round(c.estimated_usd), estimated_usd_per_message: round(c.estimated_usd / (sc.to - sc.from + 1)), brains_per_organize: c.organize_calls ? Math.round((c.brains_sent / c.organize_calls) * 10) / 10 : null }) }];
    }));
    return {
        ...all,
        messages,
        cost: { kiori_usd: round(cost.kiori_usd ?? 0), chat_usd: round(cost.chat_usd ?? 0), judge_usd: round(cost.judge_usd ?? 0), total_usd: round(spent), per_message_usd: round(spent / (messages || 1)), estimated_usd: round(cost.estimated_usd ?? 0), estimated_per_message_usd: round((cost.estimated_usd ?? 0) / (messages || 1)) },
        latency_ms: { recall: avg('recall'), chat: avg('chat'), check: avg('check'), organize: avg('organize'), per_turn: record.turnMs?.length ? Math.round(record.turnMs.reduce((a, b) => a + b, 0) / record.turnMs.length) : null },
        scale,
        by_scenario,
    };
}
const round = v => Math.round((v ?? 0) * 1e6) / 1e6;
