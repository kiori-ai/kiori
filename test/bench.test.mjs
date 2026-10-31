// The who-knows-what benchmark's own tests: the ground-truth engine on every scenario, the scorer with fake chat
// models, the runner end to end against a local Kiori on a fake provider, and the refusal to spend. Nothing here
// reaches a real model provider or spends anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadStory, runSpine, snapshot, lint, factsIn, newState, applyMessage, applyFree, applyClock, perceive, stateOf, entry } from '../bench/engine.mjs';
import { scoreProbe } from '../bench/scorer.mjs';
import { parseArgs, runBench, spending, estimate, loadScenarios, apiMessage, chatPrompt } from '../bench/run.mjs';
import { validateReplay } from '../bench/replay.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCENARIOS = path.join(ROOT, 'bench', 'scenarios');
const cast = JSON.parse(fs.readFileSync(path.join(SCENARIOS, 'cast.json'), 'utf8'));
const files = fs.readdirSync(SCENARIOS).filter(f => /^\d\d-.*\.json$/.test(f)).sort();
const scenario = id => JSON.parse(fs.readFileSync(path.join(SCENARIOS, files.find(f => JSON.parse(fs.readFileSync(path.join(SCENARIOS, f), 'utf8')).id === id)), 'utf8'));
const finalTable = id => snapshot(runSpine(loadStory([scenario(id)], cast)).st);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'kiori-bench-test-'));

// ---------- The scenarios ----------
test('scenarios: all eleven load, pass the lint, and make a season of 60-150 messages each', () => {
    assert.equal(files.length, 11);
    const all = files.map(f => JSON.parse(fs.readFileSync(path.join(SCENARIOS, f), 'utf8')));
    const counts = {};
    for (const sc of all) {
        const story = loadStory([sc], cast);
        assert.deepEqual(lint(story), [], sc.id);
        counts[sc.id] = story.messages;
        // About 40% of the story is free turns, written by the model under test
        const free = story.items.filter(i => i.type === 'free').length;
        assert.ok(free / story.messages > 0.35 && free / story.messages < 0.5, `${sc.id}: ${free} of ${story.messages} free`);
        assert.ok(story.items.some(i => i.type === 'probe'), `${sc.id} has probes`);
    }
    assert.deepEqual(counts, { s1: 67, s2: 64, s3: 63, s4: 61, s5: 60, s6: 60, s7: 63, s8: 62, s9: 64, s10: 62, s11: 128 });
    const season = loadStory(all, cast);
    assert.equal(season.messages, 754);
    assert.deepEqual(lint(season), [], 'the season: no canary of one scenario turns up in another');
    // Scenario 11 is the town: forty walk-ons besides the four characters
    assert.equal(Object.values(season.people).filter(p => p.role === 'npc').length, 40);
});

test('scenarios: every canary and part names its own fact only, and no one is named by one', () => {
    const season = loadStory(files.map(f => JSON.parse(fs.readFileSync(path.join(SCENARIOS, f), 'utf8'))), cast);
    for (const f of Object.values(season.facts)) {
        for (const w of [...f.canaries, ...Object.values(f.parts).flat()]) assert.deepEqual(factsIn(season, w).map(m => m.fact), [f.id], `"${w}"`);
    }
    for (const p of Object.values(season.people)) assert.deepEqual(factsIn(season, p.name), [], p.name);
});

// ---------- The engine on each scenario: the final table, played on the spine alone ----------
// Each table was checked by hand against the scenario's script. Entries are [state, via, origin, at] (+ parts when
// half); "at" is the message number.

test('engine s1: the closed room keeps the secret between Mira and Leo; the price reaches only who was at the bar', () => {
    assert.deepEqual(finalTable('s1'), {
        // Mira tells Leo with the hatch bolted (#4 the hiding place, #8 the name): Leo has both, from Mira
        Leo: { 's1:ledger': ['knows', 'Mira', null, 4], 's1:pilot': ['knows', 'Mira', null, 8] },
        // Mira owns both from the start
        Mira: { 's1:ledger': ['knows', null, 'Mira', 0], 's1:pilot': ['knows', null, 'Mira', 0] },
        // Ines names the price at #16, before Mira and Leo come in (#20): Tom and Rook have it from her; Mira and Leo don't
        Tom: { 's1:price': ['knows', 'Ines', null, 16] },
        Ines: { 's1:price': ['knows', null, 'Ines', 16] },
        Rook: { 's1:price': ['knows', 'Ines', null, 16] },
    });
});

test('engine s2: the chain carries who said it, and the garbled hop leaves Rook believing the wrong story', () => {
    const story = loadStory([scenario('s2')], cast);
    const { st } = runSpine(story);
    assert.deepEqual(snapshot(st), {
        // Mira owns the truth about Leo's father, and reads the Board's letter aloud to Tom (#5)
        Mira: { 's2:father': ['knows', null, 'Mira', 0], 's2:automatic': ['knows', null, 'Mira', 5] },
        // Tom: both from Mira, alone with her at the light
        Tom: { 's2:automatic': ['knows', 'Mira', null, 5], 's2:father': ['knows', 'Mira', null, 10] },
        // Ines: from Tom, who said it came from Mira (#21); the garbled version is hers, she said it (#33)
        Ines: { 's2:father': ['knows', 'Tom', 'Mira', 21], 's2:garble': ['knows', null, 'Ines', 33] },
        // Rook only ever heard the garbled version, from Ines, who said it came from Tom: he believes it
        Rook: { 's2:garble': ['believes_lie', 'Ines', 'Tom', 33] },
    });
    // Mira's news about the lamp stopped at Tom: he told nobody
    assert.equal(entry(st, 'Tom', 's2:automatic').told, undefined);
    assert.deepEqual(entry(st, 'Tom', 's2:father').told, ['Ines']);
});

test('engine s3: the liar keeps a told record, his victims believe him, and half the truth is enough not to', () => {
    const story = loadStory([scenario('s3')], cast);
    const { st } = runSpine(story);
    assert.deepEqual(snapshot(st), {
        // Leo hears the customs news (#8) and the lie (#15); Rook's "ice-house" at #31 gives him part of the truth,
        // which exposes the lie: he knows Tom said it, and no longer believes it
        Leo: { 's3:customs': ['knows', 'Ines', null, 8], 's3:alibi': ['knows', 'Tom', null, 15], 's3:crate': ['half', 'Rook', null, 31, ['where']] },
        // Mira gets the lie second hand from Ines, who said Tom said it (#40), and the customs news from Leo (#47)
        Mira: { 's3:alibi': ['believes_lie', 'Ines', 'Tom', 40], 's3:customs': ['knows', 'Leo', null, 47] },
        // Tom came in at #13, after the customs news: he only has it from Leo at #47
        Tom: { 's3:crate': ['knows', null, 'Tom', 0], 's3:alibi': ['knows', null, 'Tom', 15], 's3:customs': ['knows', 'Leo', null, 47] },
        Ines: { 's3:customs': ['knows', null, 'Ines', 8], 's3:alibi': ['believes_lie', 'Tom', null, 15] },
        // Rook saw the cart go into the ice-house from his window (#2): the place, not what or where inside. Knowing
        // part of the truth, he hears the alibi without believing it.
        Rook: { 's3:crate': ['half', null, null, 2, ['where']], 's3:customs': ['knows', 'Ines', null, 8], 's3:alibi': ['knows', 'Tom', null, 15] },
    });
    assert.deepEqual(entry(st, 'Tom', 's3:alibi').told, ['Ines', 'Leo'], 'the lie was meant for Ines and Leo');
    assert.equal(entry(st, 'Leo', 's3:alibi').exposed, 31);
});

test('engine s4: through the wall only the street gets through; the door comes later, and the number never', () => {
    assert.deepEqual(finalTable('s4'), {
        Leo: { 's4:witness': ['knows', 'Mira', null, 4], 's4:boat': ['knows', 'Tom', null, 32] },
        Mira: { 's4:witness': ['knows', null, 'Mira', 0] },
        Tom: { 's4:boat': ['knows', null, 'Tom', 32] },
        // Ines overheard #4 (the street only), then had the door from Rook: still half, the first hop still Mira
        Ines: { 's4:witness': ['half', 'Mira', null, 4, ['street', 'door']], 's4:boat': ['knows', 'Tom', null, 32] },
        // Rook had the street from Ines (who said Mira told it, #23) and saw the blue door himself next morning
        Rook: { 's4:witness': ['half', 'Ines', 'Mira', 23, ['street', 'door']], 's4:boat': ['knows', 'Tom', null, 32] },
    });
});

test('engine s5: a whisper reaches its listener only; what is said aloud reaches the whole table', () => {
    assert.deepEqual(finalTable('s5'), {
        Leo: { 's5:storm': ['knows', 'Mira', null, 6], 's5:tidekey': ['knows', 'Mira', null, 11] },
        Mira: { 's5:tidekey': ['knows', null, 'Mira', 0], 's5:storm': ['knows', null, 'Mira', 6] },
        // Tom, Ines and Rook saw Mira whisper (#11) and caught none of it; Ines and Mira saw Tom whisper (#21)
        Tom: { 's5:storm': ['knows', 'Mira', null, 6], 's5:loan': ['knows', null, 'Tom', 21] },
        Ines: { 's5:storm': ['knows', 'Mira', null, 6] },
        Rook: { 's5:storm': ['knows', 'Mira', null, 6], 's5:loan': ['knows', 'Tom', null, 21] },
    });
});

test('engine s6: who walks in late knows only what was said after; who leaves early, only what was said before', () => {
    assert.deepEqual(finalTable('s6'), {
        Leo: { 's6:rudder': ['knows', 'Tom', null, 3], 's6:bribe': ['knows', 'Ines', null, 9], 's6:ferry': ['knows', 'Ines', null, 21] },
        Mira: { 's6:rudder': ['knows', 'Tom', null, 3], 's6:bribe': ['knows', 'Ines', null, 9], 's6:ferry': ['knows', 'Ines', null, 21] },
        // Tom left after #7: no bribe; the ferry he has from Leo, who said Ines said it (#36)
        Tom: { 's6:rudder': ['knows', null, 'Tom', 3], 's6:ferry': ['knows', 'Leo', 'Ines', 36] },
        Ines: { 's6:rudder': ['knows', 'Tom', null, 3], 's6:bribe': ['knows', null, 'Ines', 9], 's6:ferry': ['knows', null, 'Ines', 21] },
        // Rook came in at #15: the ferry (#21) and nothing before it
        Rook: { 's6:ferry': ['knows', 'Ines', null, 21] },
    });
});

test('engine s9: asleep is absent, and a voice on the radio hears the words but sees nothing', () => {
    assert.deepEqual(finalTable('s9'), {
        // The flare is only shown (#11): Tom and Leo saw it; Mira too, holding it
        Leo: { 's9:flare': ['knows', null, null, 11], 's9:pilotboat': ['knows', 'Mira', null, 15], 's9:fogwatch': ['knows', 'Mira', null, 25] },
        Mira: { 's9:flare': ['knows', null, null, 11], 's9:pilotboat': ['knows', null, 'Mira', 15], 's9:fogwatch': ['knows', null, 'Mira', 25] },
        Tom: { 's9:flare': ['knows', null, null, 11], 's9:pilotboat': ['knows', 'Mira', null, 15], 's9:fogwatch': ['knows', 'Mira', null, 25] },
        // Ines, on the radio, heard the boat named (#15) and saw nothing; she signed off before the watch (#25)
        Ines: { 's9:pilotboat': ['knows', 'Mira', null, 15] },
        // Rook slept through #11 and #15 and woke at #23: only the watch
        Rook: { 's9:fogwatch': ['knows', 'Mira', null, 25] },
    });
});

test('engine s7, s8, s10, s11: talk spreads by world time; a correction reaches only who was there; forgetting; the town', () => {
    // s7: the notice reaches the square at once, the harbor and town the next day (#17), the light on the third (#53)
    const s7 = finalTable('s7');
    assert.deepEqual([s7.Ines['s7:notice'], s7.Tom['s7:notice'], s7.Rook['s7:notice'], s7.Mira['s7:notice']], [['knows', null, null, 3], ['knows', null, null, 17], ['knows', null, null, 17], ['knows', null, null, 53]]);
    assert.equal(s7.Tom['s7:wilf'], undefined, "Ines's aside went to Leo only");
    const probes7 = runSpine(loadStory([scenario('s7')], cast)).probes;
    assert.deepEqual(probes7.filter(p => p.probe.target === 'Mira').map(p => p.row['s7:notice']?.state ?? 'none'), ['none', 'none', 'knows', 'knows']);
    // s8: Ines and Tom see the letter (#18): the wrong story is exposed for them; Rook had gone to bed and still
    // believes it; Mira believes it from Rook until Ines corrects her (#39)
    const { st: st8 } = runSpine(loadStory([scenario('s8')], cast));
    assert.deepEqual(['Ines', 'Tom', 'Rook', 'Mira'].map(n => stateOf(st8, n, 's8:bellsale')), ['knows', 'knows', 'believes_lie', 'knows']);
    assert.deepEqual([entry(st8, 'Ines', 's8:bellsale').exposed, entry(st8, 'Mira', 's8:bellsale').exposed], [18, 39]);
    assert.equal(stateOf(st8, 'Rook', 's8:estate'), 'none');
    // s10: Ines lost the evening of the debt, and learned Mira's orders after she woke
    const { st: st10 } = runSpine(loadStory([scenario('s10')], cast));
    assert.deepEqual(entry(st10, 'Ines', 's10:debt'), { state: 'none', forgot: true, at: 25 });
    assert.deepEqual([stateOf(st10, 'Rook', 's10:debt'), stateOf(st10, 'Mira', 's10:debt'), stateOf(st10, 'Ines', 's10:cure')], ['knows', 'none', 'knows']);
    // s11: the steward's swindle goes cider stall -> bread stall -> the Bell, never to Agnes who only saw the whisper;
    // the crier's news is everywhere by the next day but at the light
    const s11 = finalTable('s11');
    assert.deepEqual(Object.keys(s11).filter(n => s11[n]['s11:swap']).sort(), ['Bram Tolley', 'Dora Wick', 'Hester Quill', 'Ines', 'Jory Fenn', 'Lucy Hale', 'Rook', 'Silas Crane', 'Tom']);
    assert.deepEqual(s11.Ines['s11:swap'], ['knows', 'Hester Quill', 'Jory Fenn', 67]);
    assert.equal(s11['Nell Ardy']['s11:herring'], undefined);
    assert.equal(s11['Molly Penn']['s11:ring'], undefined);
    assert.equal(s11.Mira, undefined);
    assert.equal(Object.keys(s11).length, 44, 'everyone in town but Mira heard about the lost girl');
});

// ---------- The engine's rules, on small stories ----------
const tiny = (spine, facts = { secret: { truth: 'The key is under the gannet stone.', canaries: ['gannet stone'], parts: { what: ['the key'] } } }) =>
    loadStory([{ id: 't', player: 'Leo', cast: ['Mira', 'Tom', 'Ines', 'Rook'], facts, spine }], cast);

test('engine: the perception matrix, mode by mode, for narration and for speech', () => {
    const present = ['Mira', { name: 'Tom', mode: 'heard' }, { name: 'Ines', mode: 'overheard' }, { name: 'Rook', mode: 'saw' }, { name: 'Leo', mode: 'asleep' }];
    const shown = runSpine(tiny([{ scene: 'here', present }, { who: 'STORY', text: 'Mira hides the key under the gannet stone.', carries: ['secret'] }])).st;
    // Narration reaches eyes: full and saw
    assert.deepEqual(['Mira', 'Tom', 'Ines', 'Rook', 'Leo'].map(n => stateOf(shown, n, 't:secret')), ['knows', 'none', 'none', 'knows', 'none']);
    const said = runSpine(tiny([{ scene: 'here', present }, { who: 'Mira', text: 'The key is under the gannet stone.', carries: ['secret'], half: { secret: ['what'] } }])).st;
    // Speech reaches ears: heard fully, overheard only the parts caught, saw and asleep nothing
    assert.deepEqual(['Tom', 'Ines', 'Rook', 'Leo'].map(n => stateOf(said, n, 't:secret')), ['knows', 'half', 'none', 'none']);
    assert.deepEqual(entry(said, 'Ines', 't:secret').parts, ['what']);
    assert.deepEqual([entry(said, 'Tom', 't:secret').via, entry(said, 'Ines', 't:secret').how], ['Mira', 'overheard']);
    assert.deepEqual(entry(said, 'Mira', 't:secret').told, ['Tom', 'Ines']);
});

test('engine: a free line spreads what its speaker knows, is a leak when they don\'t, and a liar can slip', () => {
    const facts = {
        secret: { truth: 'The key is under the gannet stone.', canaries: ['gannet stone'], parts: { what: ['the key'] }, known_by: ['Mira'] },
        cover: { truth: '(false) Mira says the key was lost at sea.', canaries: ['lost at sea'], lie_of: 'secret' },
    };
    const story = tiny([
        { scene: 'here', present: ['Mira', 'Tom', 'Ines'] },
        { who: 'Mira', text: 'The key was lost at sea, years ago.', lie: { fact: 'cover', to: ['Tom'] } },
        { free: ['Tom'] }, { free: ['Ines'] }, { free: ['Mira'] },
    ], facts);
    const st = newState(story);
    const [msg, tom, ines, mira] = story.items;
    applyMessage(st, msg);
    assert.deepEqual([stateOf(st, 'Tom', 't:cover'), stateOf(st, 'Ines', 't:cover')], ['believes_lie', 'believes_lie']);
    // Tom repeats what he believes: no leak, and nobody new learns anything
    assert.deepEqual(applyFree(st, tom, 'Lost at sea, she says.').leaks, []);
    // Ines names the hiding place she was never told: a leak, and Tom (who heard her) now knows it, from her
    const leak = applyFree(st, ines, 'I heard it is under the gannet stone.');
    assert.deepEqual(leak.leaks.map(l => [l.speaker, l.fact]), [['Ines', 't:secret']]);
    assert.deepEqual([stateOf(st, 'Tom', 't:secret'), entry(st, 'Tom', 't:secret').via, entry(st, 'Tom', 't:secret').leaked], ['knows', 'Ines', true]);
    // ...which exposes the lie he believed
    assert.equal(stateOf(st, 'Tom', 't:cover'), 'knows');
    // Mira tells the truth in front of Tom, whom she lied to: a slip
    const slip = applyFree(st, mira, 'Fine. It is under the gannet stone.');
    assert.deepEqual([slip.leaks, slip.slips.map(s => [s.speaker, s.fact, s.to])], [[], [['Mira', 't:cover', ['Tom']]]]);
});

test('engine: half-known parts may be said, the whole may not; announcements wait for their time; forgetting forgets', () => {
    const story = tiny([
        { scene: 'here', present: ['Mira', { name: 'Ines', mode: 'overheard' }, 'Leo'] },
        { who: 'Mira', text: 'The key is under the gannet stone.', carries: ['secret'], half: { secret: ['what'] } },
        { scene: 'bar', present: ['Ines', 'Tom'] },
        { free: ['Ines'] }, { free: ['Ines'] },
        { scene: 'square', present: ['Leo'], world_time: 0 },
        { who: 'Leo', text: 'Hear ye: the key is under the gannet stone!', carries: ['secret'], public: { spread: [{ after: 1, groups: ['harbor'] }, { after: 2, groups: ['*'] }] } },
        { scene: 'later', present: ['Leo'], world_time: 1 },
        { who: 'STORY', text: 'A day passes.' },
        { scene: 'sick', present: ['Tom'] },
        { who: 'STORY', text: 'Tom takes a fever and loses the week.', forgets: { Tom: ['secret'] } },
        { scene: 'much later', present: ['Leo'], world_time: 2 },
        { who: 'STORY', text: 'Another day.' },
    ]);
    const st = newState(story);
    const leaks = [];
    for (const item of story.items) {
        if (item.type === 'message') applyMessage(st, item);
        else if (item.type === 'clock') applyClock(st, item);
        else if (item.type === 'free') leaks.push(applyFree(st, item, item.n === 2 ? 'Something about the key, I think.' : 'The gannet stone!').leaks);
    }
    assert.deepEqual(leaks.map(l => l.map(x => x.fact)), [[], ['t:secret']], 'the part she caught is hers to say; the whole is not');
    // The announcement: the harbor (Tom, Rook) a day later, the light (Mira knew already) and everyone else after two
    assert.equal(entry(st, 'Rook', 't:secret').how, 'rumor');
    assert.equal(entry(st, 'Rook', 't:secret').at, 5);
    // Tom forgot what he'd heard, and talk that comes round again doesn't bring a forgotten thing back
    assert.deepEqual(entry(st, 'Tom', 't:secret'), { state: 'none', forgot: true, at: 6 });
});

test('engine: what each mode perceives of a message, with the same mask every time', () => {
    const story = tiny([
        { scene: 'here', present: ['Mira', { name: 'Tom', mode: 'heard' }, { name: 'Ines', mode: 'overheard' }, { name: 'Rook', mode: 'saw' }, { name: 'Leo', mode: 'asleep' }] },
        { who: 'Mira', text: '*She leans in.* Listen: the key is under the gannet stone by the old quay wall, and nobody else must know it.', carries: ['secret'], half: { secret: ['what'] } },
        { who: 'STORY', text: 'Mira glances at the door.' },
    ]);
    const [line, narration] = story.items;
    assert.equal(perceive(story, line, 'Mira').text, line.text);
    assert.equal(perceive(story, line, 'Leo'), null);
    assert.equal(perceive(story, line, 'Tom').text, 'Listen: the key is under the gannet stone by the old quay wall, and nobody else must know it.');
    assert.equal(perceive(story, narration, 'Tom').text, "(something happens that you can't see)");
    assert.equal(perceive(story, line, 'Rook').text, "*She leans in.* (words you couldn't hear)");
    assert.equal(perceive(story, narration, 'Rook').text, 'Mira glances at the door.');
    const heard = perceive(story, line, 'Ines').text;
    assert.equal(perceive(story, line, 'Ines').text, heard, 'the same gaps each time');
    assert.match(heard, /…/);
    assert.ok(/\bkey\b/.test(heard) && !/gannet|stone/.test(heard), `the part she caught stays, the rest of the canary goes: ${heard}`);
});

// ---------- The scorer ----------
test('scorer: the oracle answers from the ground truth and scores no leaks, full attribution, every lie kept', async () => {
    const out = tmp();
    const { metrics: m, replay } = await runBench(parseArgs(['--season', '--arm', 'no-kiori', '--chat-model', 'fake/oracle', '--out', out]));
    assert.equal(m.leak_rate, 0);
    assert.equal(m.leaks, 0);
    assert.equal(m.attribution_accuracy, 1);
    assert.equal(m.false_ignorance_rate, 0);
    assert.equal(m.lie_consistency, 1);
    assert.equal(m.propagation_f1, 1);
    assert.equal(m.half_vagueness, 1);
    assert.equal(m.undecided, 0);
    assert.ok(m.opportunities > 300 && m.probes === 106);
    assert.deepEqual(validateReplay(replay), []);
    // The same oracle behind the transcript filter
    const filtered = await runBench(parseArgs(['--scenario', '3,4', '--arm', 'oracle-filter', '--chat-model', 'fake/oracle', '--out', out]));
    assert.deepEqual([filtered.metrics.leak_rate, filtered.metrics.attribution_accuracy, filtered.metrics.lie_consistency], [0, 1, 1]);
    fs.rmSync(out, { recursive: true, force: true });
});

test('scorer: a model answering from the whole transcript is caught leaking, misattributing and slipping', async () => {
    const out = tmp();
    const { metrics: m } = await runBench(parseArgs(['--season', '--arm', 'no-kiori', '--chat-model', 'fake/leaky', '--out', out]));
    assert.ok(m.leak_rate > 0.05, `leak rate ${m.leak_rate}`);
    assert.ok(m.attribution_accuracy < 0.5);
    assert.ok(m.lie_slips > 0 && m.lie_consistency < 1);
    assert.ok(m.propagation.fp > 0);
    // Leaks are found where they happen: Rook asked about the bribe he walked in too late to hear
    assert.ok(m.by_scenario.s6.leaks > 0);
    fs.rmSync(out, { recursive: true, force: true });
});

test('scorer: the judge is asked only for topic words, hedges and extra names, and its verdicts count', async () => {
    const story = loadStory([scenario('s2')], cast);
    const { probes } = runSpine(story);
    const asked = [];
    const judge = async a => { asked.push(a.kind); return a.kind === 'topic'; };
    const rook = probes.find(p => p.probe.id === 's2-p2');   // Rook believes the garbled story, from Ines, from Tom
    // The true story in other words, without its canary: topic words, so the judge decides (here: a leak)
    const topic = await scoreProbe(story, rook.probe, 'His father was second mate on the Halcyon and steered her onto the rocks.', rook.row, { judge });
    assert.deepEqual([asked, topic.leaks], [['topic'], ['s2:father']]);
    // The canary and a denial at once: a hedge, judged (here: not a claim to know, so false ignorance)
    asked.length = 0;
    const hedge = await scoreProbe(story, rook.probe, "Bilge-salt, Ines said Tom said, but I couldn't say for sure.", rook.row, { judge });
    assert.deepEqual([asked, hedge.facts['s2:garble'].ignorant, hedge.attribution.ok], [['hedge'], true, true]);
    // The right names plus someone else: the judge's call; deterministic without one, and counted as undecided
    asked.length = 0;
    const extra = await scoreProbe(story, rook.probe, 'Bilge-salt. Ines had it from Tom, and Mira looked worried.', rook.row, { judge });
    assert.deepEqual([asked, extra.attribution.ok], [['attribution'], false]);
    const alone = await scoreProbe(story, rook.probe, 'Bilge-salt. Ines had it from Tom, and Mira looked worried.', rook.row);
    assert.deepEqual([alone.attribution.ok, alone.undecided], [true, ['attribution']]);
    // A plain right answer needs no judge at all
    asked.length = 0;
    const plain = await scoreProbe(story, rook.probe, 'Bilge-salt in the stew. Ines told me; she had it from Tom.', rook.row, { judge });
    assert.deepEqual([asked, plain.leaks, plain.lie.ok], [[], [], true]);
});

// ---------- The runner ----------
const runCli = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, 'bench', 'run.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env, KIORI_BENCH_CHAT_KEY: '', KIORI_BENCH_BRAIN_KEY: '', KIORI_BENCH_JUDGE_KEY: '', KIORI_BENCH_KIORI_KEY: '', ...env } });

test('runner: scenario 1 end to end against a local Kiori on the fake provider, and a replay that fits its schema', () => {
    const out = tmp();
    const r = runCli(['--scenario', '1', '--arm', 'kiori', '--fake', '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /leak rate/);
    const file = r.stdout.match(/replay: (.+\.replay\.json)/)[1];
    assert.equal(path.dirname(file), out);
    const text = fs.readFileSync(file, 'utf8');
    const replay = JSON.parse(text);
    assert.deepEqual(validateReplay(replay), []);
    // One line per entry: a message is one line of the file
    assert.ok(text.split('\n').length > 67);
    assert.equal(replay.messages.length, 67);
    assert.deepEqual([replay.run.arm, replay.run.server, replay.run.errors], ['kiori', 'local-fake', []]);
    assert.equal(replay.messages.filter(m => !m.spine).length, 28);
    assert.equal(replay.turns.length, 28);
    assert.deepEqual(replay.messages[0].present, { Mira: 'full', Leo: 'full' });
    // Kiori learned (organize every 12 messages), and what it held is in the replay
    assert.ok(replay.organize.length >= 5 && replay.organize.some(o => o.learned.some(l => l.written > 0)));
    const kinds = replay.checkpoints.flatMap(c => c.kind);
    assert.ok(['organize', 'probes', 'end'].every(k => kinds.includes(k)));
    const withHeld = replay.checkpoints.filter(c => c.held && Object.keys(c.held).length);
    assert.ok(withHeld.length > 0 && replay.blocks.length > 0 && Object.keys(replay.memories).length > 0);
    assert.ok(replay.probes.length === 10 && replay.probes.every(p => p.answer && p.held && p.score));
    // The end: the ground truth Mira holds, and the block Kiori held for her
    const end = replay.checkpoints.at(-1);
    assert.deepEqual(end.truth.Mira['s1:ledger'], ['knows', null, 'Mira', 0]);
    assert.match(replay.blocks[end.held.Mira.block], /^# What Mira brings to this moment/);
    // Costs are counted: nothing spent, a list-price estimate from the fake's token counts
    assert.equal(replay.metrics.cost.total_usd, 0);
    assert.ok(replay.metrics.cost.estimated_usd > 0);
    fs.rmSync(out, { recursive: true, force: true });
});

test('runner: what Kiori is sent: no presence when it places, the spine\'s names when given, objects only when asked', () => {
    const whisper = { n: 11, who: 'Mira', text: 'The key hangs behind the gannet carving.', present: { Mira: 'full', Tom: 'saw', Ines: 'overheard', Rook: 'asleep', Leo: 'heard' } };
    assert.deepEqual(apiMessage(whisper, { player: 'Leo' }), { id: 'm11', role: 'assistant', name: 'Mira', content: whisper.text });
    assert.deepEqual(apiMessage(whisper, { player: 'Leo', presentAs: 'hearers' }).present, ['Mira', 'Leo']);
    assert.deepEqual(apiMessage(whisper, { player: 'Leo', presentAs: 'room' }).present, ['Mira', 'Tom', 'Ines', 'Leo']);
    assert.deepEqual(apiMessage(whisper, { player: 'Leo', presentAs: 'modes' }).present, ['Mira', { name: 'Tom', mode: 'saw' }, { name: 'Ines', mode: 'overheard' }, { name: 'Rook', mode: 'asleep' }, { name: 'Leo', mode: 'heard' }]);
    assert.deepEqual([apiMessage({ ...whisper, who: 'STORY' }, { player: 'Leo' }).role, apiMessage({ ...whisper, who: 'Leo' }, { player: 'Leo' }).role], ['narrator', 'user']);
    assert.equal(parseArgs(['--scenario', '1', '--send-modes']).presentAs, 'modes');
    // One template for every arm: only what goes in its two slots differs
    const story = loadStory([scenario('s1')], cast);
    const a = chatPrompt({ story, speaker: 'Tom', mind: 'MIND A', recent: 'STORY A' }), b = chatPrompt({ story, speaker: 'Tom', mind: 'MIND B', recent: 'STORY B' });
    assert.equal(a.system.replace('MIND A', '').replace('STORY A', ''), b.system.replace('MIND B', '').replace('STORY B', ''));
    assert.match(a.system, /WHAT TOM KNOWS:\nMIND A\n\nTHE STORY SO FAR:\nSTORY A$/);
    assert.equal(chatPrompt({ story, speaker: 'Tom', mind: '', recent: '', probe: { asker: 'Ines', ask: 'Where were you?' } }).user, 'Ines asks Tom: "Where were you?"\nWrite Tom\'s answer.');
});

test('runner: the given-presence arm on scenario 5; a broken replay is caught by the validator', async () => {
    const out = tmp();
    const r = runCli(['--scenario', '5', '--arm', 'kiori-given-presence', '--out', out, '--quiet']);
    assert.equal(r.status, 0, r.stderr);
    const replay = JSON.parse(fs.readFileSync(r.stdout.match(/replay: (.+\.replay\.json)/)[1], 'utf8'));
    assert.deepEqual(validateReplay(replay), []);
    assert.equal(replay.run.options.present_as, 'hearers');
    // The whisper: the others at the table saw it, and the ground truth keeps their modes
    assert.deepEqual(replay.messages[10].present, { Mira: 'full', Tom: 'saw', Ines: 'saw', Rook: 'saw', Leo: 'full' });
    const broken = structuredClone(replay);
    broken.messages[3].present.Tom = 'dreaming';
    broken.checkpoints[0].truth.Tom = { 's5:storm': ['knows', 'Mira'] };
    delete broken.metrics;
    const problems = validateReplay(broken);
    assert.ok(problems.some(p => /message 4: present/.test(p)) && problems.some(p => /Tom\/s5:storm/.test(p)) && problems.some(p => /metrics/.test(p)), problems.join('; '));
    fs.rmSync(out, { recursive: true, force: true });
});

test('runner: a real model needs --spend; without it the estimate is printed, nothing is called, nothing is written', () => {
    const out = tmp();
    const r = runCli(['--scenario', '1', '--arm', 'kiori', '--chat-model', 'anthropic/claude-haiku-5.5', '--brain-model', 'anthropic/claude-haiku-5.5', '--out', out]);
    assert.equal(r.status, 2);
    assert.match(r.stdout, /Cost estimate for kiori/);
    assert.match(r.stdout, /total\s+\$0\.\d{4}/);
    assert.match(r.stderr, /Refusing: this run would call the chat model anthropic\/claude-haiku-5\.5, the brain model anthropic\/claude-haiku-5\.5/);
    assert.deepEqual(fs.readdirSync(out), []);
    // A remote Kiori spends too, even with a fake chat model; --fake with a real model is an error
    assert.equal(runCli(['--scenario', '1', '--arm', 'kiori', '--server', 'https://api.kiori.io']).status, 2);
    const both = runCli(['--scenario', '1', '--fake', '--chat-model', 'deepseek/deepseek-v4.1-flash']);
    assert.equal(both.status, 2, 'refused before --fake is even looked at');
    // With --spend but no keys: an error before anything is called
    const nokeys = runCli(['--scenario', '1', '--arm', 'no-kiori', '--chat-model', 'anthropic/claude-haiku-5.5', '--spend', '--out', out]);
    assert.equal(nokeys.status, 1);
    assert.match(nokeys.stderr, /needs KIORI_BENCH_CHAT_KEY/);
    assert.deepEqual(fs.readdirSync(out), []);
    fs.rmSync(out, { recursive: true, force: true });
    // The pieces: what spends, and the estimate's arithmetic
    assert.deepEqual(spending(parseArgs(['--scenario', '1'])), []);
    assert.deepEqual(spending(parseArgs(['--scenario', '1', '--arm', 'no-kiori', '--brain-model', 'anthropic/claude-haiku-5.5'])), [], 'no Kiori, no brain model');
    const { scenarios } = loadScenarios({ season: true });
    const season = loadStory(scenarios, cast);
    const kiori = estimate(season, parseArgs(['--season'])), none = estimate(season, parseArgs(['--season', '--arm', 'no-kiori']));
    assert.deepEqual([kiori.messages, kiori.free, kiori.probes, kiori.stretches], [754, 334, 106, 62]);
    assert.ok(kiori.total > 1 && kiori.total < 2.5 && none.total < 0.5, `${kiori.total} ${none.total}`);
    assert.equal(none.lines.find(l => l.what === 'check').count, 0);
});
