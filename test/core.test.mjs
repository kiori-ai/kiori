// Tests: nothing here reaches a real model provider or spends anything. Model calls go to a fake provider on this
// machine that answers the way a real one does, from what each prompt asks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

process.env.KIORI_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kiori-test-'));
// A dead address for this server's own model key: a project on it can't reach a provider (or spend anything)
process.env.KIORI_LLM_BASE_URL = 'http://127.0.0.1:9';
// The fake provider runs on this machine
process.env.KIORI_PROXY_ALLOW_LOCAL = '1';
// Sign-in links point at a known address, whatever this machine's own .env says
process.env.KIORI_PUBLIC_URL = 'https://kiori.test';
const { evidenceFound, samePerson, findCharacter, characterNamed, namesPlayer, isExtra, withPronouns, bareName, whoIs, mentions, namesSomeone, mentionsThePast, sha, norm, trimSlashes } = await import('../src/text.mjs');
const { fromCharacterCard, cardFromPng } = await import('../src/cards.mjs');
const { normalize, profile, inThisPerson, PARAMS, deviations, NEURON_TITLES } = await import('../src/personality.mjs');
const { createProject, updateProject, authenticate, createKey, revokeKey, listKeys, keyCount, MAX_KEYS, recentErrors, recordError, resealAll, keptKey } = await import('../src/accounts.mjs');
const { askJSON, retryAfterMs, credentialsFor, providerUrl, fitSchema } = await import('../src/llm.mjs');
const { run, now, db } = await import('../src/db.mjs');
const { dbPath, config } = await import('../src/config.mjs');
const { readBrain, readBrains, newBrain, addMemories, setRelation, getRelations, setState, getState, packVector, unpackVector, cosine, fingerprint, textHash, freshVector, characterOf, LIMITS } = await import('../src/brainfile.mjs');
const { createBrain } = await import('../src/create.mjs');
const { recall, searchMemories, contextOf, embedMissing } = await import('../src/recall.mjs');
const { organize, lineUp, rewind, eventsOf } = await import('../src/organize.mjs');
const { checkReply } = await import('../src/check.mjs');
const { isPresent, placementChunks, placeEvents, speakersIn, perceive } = await import('../src/scenes.mjs');
const { consolidate, KEEP_AT_MOST } = await import('../src/sleep.mjs');
const { detectProvider, setBrainKey, brainKeyView } = await import('../src/providers.mjs');
const { exportObsidian } = await import('../src/export.mjs');
const { vaultBrains } = await import('../src/importer.mjs');
const { oldBrains } = await import('../src/migrate.mjs');
const { zip } = await import('../src/zip.mjs');

// ---------- A fake model provider ----------
const words = t => String(t).toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
// A bag-of-words vector: texts that share words point the same way, as real embeddings roughly do
function vectorOf(text) {
    const v = new Array(256).fill(0);
    for (const w of words(text)) v[crypto.createHash('md5').update(w).digest()[0]] += 1;
    return v.some(Boolean) ? v : [1, ...v.slice(1)];
}
// A quote a model could only write by filling in what a character missed (set by a test)
let filledIn = null;
const lines = block => [...String(block).matchAll(/^\[(\d+)\] ([^:\n]+?): (.*)$/gm)].map(m => ({ n: Number(m[1]), speaker: m[2].replace(/ \(player\)$/, ''), player: m[2].endsWith('(player)'), text: m[3] }));
function answer(prompt) {
    if (prompt.includes('[a piece the model fails]')) return null;
    if (/You are sketching a character/.test(prompt)) return {
        card: { who: 'A lighthouse keeper who left medicine behind.', looks: 'Grey eyes, a salt-stiff coat.', personality: 'Guarded, dry, kinder than she lets on.', voice: 'Short sentences. "Get in."', core: 'I keep the light so nobody else drowns.' },
        aliases: ['Mira', 'The Keeper'], pronouns: 'she', personality: { disadonukluk: 20 },
        people: [{ name: 'Tomas', role: 'her brother' }, { name: 'Ines', role: 'an old friend' }, { name: 'Old Hal', role: 'her teacher' }],
        places: [{ name: 'Saltmere Light', what: 'her lighthouse' }],
        turning_points: [1, 2, 3, 4, 5].map(i => ({ when: `age ${i * 6}`, what: `turning point ${i}` })),
        relations: [{ target: 'Tomas', trust: 80, closeness: 0.9, respect: 70, resentment: 10, attraction: 0, note: 'My little brother.' }],
        state: { mood: 'watchful', on_mind: ['the storm'], wants: ['quiet'] },
    };
    if (/past as memories/.test(prompt)) return { items: Array.from({ length: 9 }, (_, i) => ({ kind: i === 0 ? 'person' : 'memory', title: i === 0 ? 'Tomas' : `Harrow Field ${i}`, body: `I worked the field hospital at Harrow Field, year ${i}.`, keys: ['harrow', 'war'], about: ['Tomas'], importance: 0.6, emotion: 0.4, links: i ? ['Tomas'] : [] })) };
    if (/inner life/.test(prompt)) return {
        items: Array.from({ length: 8 }, (_, i) => ({ kind: i === 0 ? 'secret' : 'belief', title: i === 0 ? 'The unsent letter' : `Belief ${i}`, body: i === 0 ? 'I wrote to my brother before the war and never sent it. It is in the logbook.' : `Strangers lie, mostly. (${i})`, keys: i === 0 ? ['letter', 'logbook'] : ['strangers'], about: [], importance: 0.7, emotion: 0.6, links: [] })),
        mind_notes: [{ neuron: NEURON_TITLES.includes('Extraversion') ? 'Extraversion' : NEURON_TITLES[0], note: 'People wear me out.' }, { neuron: 'Not a neuron', note: 'dropped' }],
    };
    const memory = prompt.match(/^You are the memory of (.+?), processing/m);
    if (memory) {
        const scenes = lines(prompt.slice(prompt.lastIndexOf('WAS IN:')));
        const quote = words(scenes[0].text).slice(0, 8).join(' ');
        // A line that passes something on ("says", "said", "told me", a "rumor") is a fact. The fake claims it saw it,
        // whoever spoke; names whom it came from ("Mira says": Mira; a rumor: Rook, named in the line or not); and is
        // sure of it unless the line says "maybe". A line that opens on a name ("Ines, Mira says...") is also a told
        // record, to that name, whoever spoke it. A line with "[lies]" is a lie: its truth is quoted from a "[truth]" line
        // when the scenes have one (else words nobody said); with "[lies:secret]" the truth is the first secret it was shown;
        // with "[lies:ref]" the memory titled "The truth…" it was shown, and with "[lies:quote]" that memory's words
        const passed = scenes.filter(s => /\b(says|said|told me|rumor)\b|\[lies/.test(s.text));
        const cite = s => words(s.text).slice(0, 10).join(' ');
        const truthLine = scenes.find(s => s.text.includes('[truth]')), secret = prompt.match(/^- \[(m_[\w-]+)\] \(their secret\)/m)?.[1];
        const truthMemory = prompt.match(/^- \[(m_[\w-]+)\] The truth[^:]*: (.*)$/m);
        const lie = s => {
            if (!/\[lies/.test(s.text)) return { lie: false, truth: '' };
            if (s.text.includes('[lies:secret]')) return { lie: true, truth: '', truth_ref: `[${secret}]` };
            if (s.text.includes('[lies:ref]')) return { lie: true, truth: '', truth_ref: truthMemory ? `[${truthMemory[1]}]` : '' };
            if (s.text.includes('[lies:quote]')) return { lie: true, truth: truthMemory ? words(truthMemory[2]).slice(0, 10).join(' ') : '', truth_ref: '' };
            return { lie: true, truth: truthLine ? cite(truthLine) : 'words nobody ever said in these scenes at all', truth_ref: '' };
        };
        return {
            memories: [
                { title: `${memory[1]} remembers ${scenes[0].text.slice(0, 30)}`, body: `I remember: ${scenes.map(s => s.text).join(' ')}`, keys: words(scenes[0].text).slice(0, 3), about: ['Leo'], importance: 0.7, emotion: 0.5, evidence: quote },
                { title: 'Something made up', body: 'This never happened.', keys: [], about: [], importance: 0.5, emotion: 0.1, evidence: 'words nobody ever said in these scenes at all' },
                ...(filledIn && prompt.includes('words you missed') ? [{ title: 'Filled in', body: 'I know it all.', keys: [], about: [], importance: 0.5, emotion: 0.1, evidence: filledIn }] : []),
            ],
            facts: passed.map(s => ({ about: 'Leo', fact: s.text, evidence: cite(s), how: 'saw', via: s.text.match(/\b([A-Z][a-z]+) (?:says|said)\b/)?.[1] ?? (/rumor/.test(s.text) ? 'Rook' : ''), confidence: /\bmaybe\b/.test(s.text) ? 0.2 : 1 })),
            told: passed.filter(s => /^[A-Z][a-z]+,/.test(s.text)).map(s => ({ to: [s.text.match(/^([A-Z][a-z]+),/)[1]], said: s.text, ...lie(s), evidence: cite(s) })),
            intentions: [], finished: [], forgot: [],
            relations: [{ target: 'Leo', trust: 60, closeness: 40, respect: 50, resentment: 0, attraction: 0, note: 'A stranger who stayed.' }, { target: memory[1], trust: 99, closeness: 99, respect: 99, resentment: 0, attraction: 0, note: 'myself' }],
            state: { mood: 'curious', on_mind: ['the stranger'], wants: [] },
            card: { who: '', looks: '', personality: '', voice: '' },
        };
    }
    if (/Split it into scenes/.test(prompt) && prompt.includes('[scenes nobody can place]')) return { scenes: [] };
    // One scene for the stretch, in the new shape: a line with "[arrives]" places its speaker from that message on,
    // "[next room: Name]" has Name overhear that message
    if (/Split it into scenes/.test(prompt) && /\[arrives\]|\[next room: /.test(prompt)) {
        const [, from, to] = prompt.match(/Cover every message from (\d+) to (\d+)/).map(Number);
        const player = prompt.match(/\. (.+?) is the player's character/)[1];
        const people = [{ name: player, mode: 'full' }];
        for (const l of lines(prompt.slice(prompt.indexOf('STORY:'))).filter(x => x.n >= from && x.n <= to)) {
            if (!l.player && l.speaker !== 'STORY' && !people.some(p => p.name === l.speaker)) people.push({ name: l.speaker, mode: 'full', ...(l.text.includes('[arrives]') && { from: l.n }) });
            const next = l.text.match(/\[next room: (\w+)\]/);
            if (next) people.push({ name: next[1], mode: 'overheard', from: l.n, to: l.n });
        }
        return { scenes: [{ from, to, place: 'the loft', people }] };
    }
    // Otherwise one scene per message, in the old shape (present: names), which is still read
    if (/Split it into scenes/.test(prompt)) {
        const [, from, to] = prompt.match(/Cover every message from (\d+) to (\d+)/).map(Number);
        const player = prompt.match(/\. (.+?) is the player's character/)[1];
        return { scenes: lines(prompt).filter(l => l.n >= from && l.n <= to).map(l => ({ from: l.n, to: l.n, place: 'here', present: [...new Set([l.player ? player : l.speaker, player])].filter(x => x !== 'STORY') })) };
    }
    if (/You check a draft reply/.test(prompt)) {
        const draft = prompt.slice(prompt.lastIndexOf('DRAFT:') + 6).split('\n\nReturn only JSON')[0].trim();
        // A lie slip the pre-check pointed at; a lie that keeps a secret (which the fake "fixes" anyway, to show the fix
        // is not taken); a name the pre-check says only others know
        if (/Tom's lines: words of the truth behind a lie they keep up toward Ines/.test(prompt)) return { issues: [{ character: 'Tom', type: 'lie_slip', quote: 'the crates are under the chapel', why: 'He told Ines he was home asleep.' }], fixed: draft.replace('the crates are under the chapel', 'I was home') };
        if (/Mira: .*never written a letter/.test(draft) && /The unsent letter/.test(prompt)) return { issues: [{ character: 'Mira', type: 'lie', quote: 'never written a letter', why: 'She keeps her secret.' }], fixed: draft.replace('never', 'once') };
        if (/Rook's lines: words only others know[^\n]*"Marisol"/.test(prompt)) return { issues: [{ character: 'Rook', type: 'leak', quote: 'the Marisol', why: 'Only Mira knows of it.' }], fixed: draft.replace('Marisol', 'ship') };
        if (/Ines: .*Mira told me/.test(draft) && /### Ines[\s\S]*Tom (told them|said it in front of them)/.test(prompt)) return { issues: [{ character: 'Ines', type: 'misattribution', quote: 'Mira told me', why: 'Tom told her, not Mira.' }], fixed: draft.replace('Mira told me', 'Tom told me') };
        return /Rook: .*letter/.test(draft) && prompt.includes('### Rook')
            ? { issues: [{ character: 'Rook', type: 'leak', quote: 'the letter', why: 'He was never told about it.' }], fixed: draft.replace('the letter', 'something') }
            : { issues: [], fixed: '' };
    }
    if (/These memories have faded/.test(prompt)) return { gists: [...prompt.matchAll(/^(m_[\w-]+): /gm)].map(m => ({ id: m[1], gist: 'Something happened, once.' })) };
    return null;
}
function fakeProvider() {
    const calls = [], failed = {};
    const server = http.createServer(async (req, res) => {
        let raw = '';
        for await (const c of req) raw += c;
        const body = raw ? JSON.parse(raw) : {};
        calls.push({ path: req.url, body, auth: req.headers.authorization });
        const send = (status, data, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(data)); };
        if (req.headers.authorization !== 'Bearer sk-test-key') return send(401, { error: { message: 'bad key' } });
        // Models that fail on purpose: flaky-N is down (503) for its first N calls, down-NNN always answers NNN
        const flaky = /^flaky-(\d+)$/.exec(body.model ?? ''), down = /^down-(\d{3})$/.exec(body.model ?? '');
        if (flaky && (failed[body.model] = (failed[body.model] ?? 0) + 1) <= Number(flaky[1])) return send(503, { error: { message: 'busy on purpose', code: 503 } }, { 'Retry-After': '0' });
        if (down) return send(Number(down[1]), { error: { message: 'down on purpose', code: Number(down[1]) } }, { 'Retry-After': '0' });
        // A provider careless enough to say the key back in its error; one that takes its time (slow-MS)
        if (body.model === 'echo-key') return send(400, { error: { message: `This model is not for you: ${req.headers.authorization}` } });
        const slow = /^slow-(\d+)$/.exec(body.model ?? '');
        if (slow) await new Promise(r => setTimeout(r, Number(slow[1])));
        // One that answers with a web page; one that answers with a tool call and no text
        if (body.model === 'html-page') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<script>alert(1)</script>'); }
        if (body.model === 'long-reply') return send(200, { id: 'chatcmpl-long', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: `Mira: ${'the lamp burns all night '.repeat(1200)}` }, finish_reason: 'stop' }] });
        if (body.model === 'group-reply') return send(200, { id: 'chatcmpl-group', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: 'Rook: So the Marisol went down, eh?' }, finish_reason: 'stop' }] });
        if (body.model === 'huge-error') return send(400, { error: { message: `Nope: sk-${'a'.repeat(2e6)}` } });
        if (body.model === 'tool-call') return send(200, { id: 'chatcmpl-tool', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'roll', arguments: '{"dice":"d20"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5 } });
        if (req.url === '/models') return send(200, { data: [{ id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5' }, { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5' }, { id: 'openai/text-embedding-3-small' }, { id: 'meta/llama-roleplay' }] });
        if (req.url === '/embeddings') return send(200, { data: body.input.map(t => ({ embedding: vectorOf(t) })), usage: { prompt_tokens: 3 } });
        if (req.url === '/chat/completions') {
            const prompt = body.messages.map(m => (typeof m.content === 'string' ? m.content : '')).join('\n');
            const json = body.response_format ? answer(prompt) : null;
            const content = json ? JSON.stringify(json) : 'Mira looks up from the lamp. "You came back."';
            return send(200, { id: 'chatcmpl-test', object: 'chat.completion', model: body.model, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, cost: 0 } });
        }
        send(404, { error: { message: 'no such route' } });
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, calls, close: () => server.close() })));
}
const fake = await fakeProvider();
// A customer project on its own brain API key, which goes to the fake provider
const own = createProject('Own key studio', {}, { llmMode: 'own' });
await setBrainKey(own.project.id, { key: 'sk-test-key', base_url: fake.url });
const P = own.project.id;
const chatCalls = op => fake.calls.filter(c => c.path === '/chat/completions' && (!op || JSON.stringify(c.body).includes(op)));

// A gateway in front of a Kiori server, as Cloudflare is: it answers with the failures in plan first (in order; null
// passes that one call on; { drop: true } starts an answer and cuts the connection), then passes calls on. seen: every
// call that reached it
function flakyGateway(target) {
    const plan = [], seen = [];
    const server = http.createServer(async (req, res) => {
        let raw = '';
        for await (const c of req) raw += c;
        seen.push(`${req.method} ${req.url}`);
        const next = plan.shift();
        if (next?.drop) { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' }); res.write('{"text": "cut off'); return res.socket.destroy(); }
        if (next) { res.writeHead(next.status, { 'Content-Type': 'application/json', ...next.headers }); return res.end(next.body ?? ''); }
        const r = await fetch(target + req.url, { method: req.method, headers: { ...(req.headers.authorization && { Authorization: req.headers.authorization }), ...(raw && { 'Content-Type': 'application/json' }) }, body: raw || undefined });
        res.writeHead(r.status, { 'Content-Type': r.headers.get('content-type') ?? 'application/json' });
        res.end(Buffer.from(await r.arrayBuffer()));
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () => r({ url: `http://127.0.0.1:${server.address().port}`, plan, seen, close: () => server.close() })));
}
// A failure that says to try again at once
const busy = (status, error = null) => ({ status, headers: { 'Retry-After': '0' }, body: error ? JSON.stringify({ error }) : '' });

const RIN = { spec: 'chara_card_v2', spec_version: '2.0', data: {
    name: 'Rin', description: '{{char}} runs a ramen stall and teases {{user}}.', personality: 'Blunt, warm.', scenario: 'Late night, rain.',
    first_mes: '*{{char}} slides a bowl over.* Eat.', mes_example: '<START>\n{{user}}: Hi.\n{{char}}: Sit.',
    character_book: { entries: [{ keys: ['Night Market'], content: 'The stalls open at midnight.', enabled: true }, { keys: ['x'], content: 'off', enabled: false }] },
} };
const chat = (n, edits = {}) => Array.from({ length: n }, (_, i) => ({ id: `m${i + 1}`, role: i % 2 ? 'assistant' : 'user', content: edits[i + 1] ?? (i % 2 ? `Reply ${i + 1}: the storm keeps the lamp burning all night long.` : `Message ${i + 1}: tell me about the old lighthouse and the harbor.`) }));

// ---------- Text, names, personality ----------
test('speakers and names: "Name:" lines in linear time, a long name cut short, slashes trimmed by a loop', () => {
    assert.deepEqual(speakersIn('**Rook**: Aye.\n  Mira: Eat.\nAt 10:30 we met.\nhttps://kiori.io\nAnn:\nhello\nBob  Smith: no'), ['Rook', 'Mira', 'Ann']);
    let t = performance.now();
    assert.deepEqual(speakersIn('Ann: hi\n' + '  \n'.repeat(1e5) + '\t\n'.repeat(1e5)), ['Ann']);
    assert.ok(performance.now() - t < 500, 'blank lines take no time');
    t = performance.now();
    assert.ok(bareName('('.repeat(1e5)).length <= 200);
    assert.deepEqual([trimSlashes('/a///'), trimSlashes('/'.repeat(2e5)), trimSlashes('/v1')], ['/a', '', '/v1']);
    assert.ok(performance.now() - t < 200);
    assert.throws(() => providerUrl(`https://models.example/${'/'.repeat(400)}`), e => e.status === 400 && /300 characters/.test(e.message));
});

test('names: exact names first; a short name the player and a character share is nobody; an alias two share names neither; Turkish İ and ı fold', () => {
    const brandt = { id: 'n1', name: 'Leo Brandt', aliases: [] }, mira = { id: 'n2', name: 'Mira Voss', aliases: ['Doc'] }, ines = { id: 'n3', name: 'Ines', aliases: ['Doc', 'Kai'] }, kai = { id: 'n4', name: 'Kai', aliases: [] };
    const story = [brandt, mira, ines, kai];
    assert.equal(whoIs('Leo', { story, player: 'Leo Martin' }), null, 'the player or Brandt: nobody for sure');
    assert.equal(whoIs('Leo Brandt', { story, player: 'Leo' }), brandt, 'his own full name is his');
    assert.equal(whoIs('Leo', { story, player: 'Ann' }), brandt);
    assert.ok(namesPlayer('Leo', 'Leo Martin') && !namesPlayer('Leo Brandt', 'Leo'));
    assert.equal(findCharacter('Doc', story), null, 'an alias two share');
    assert.equal(characterNamed('Doc', story), null);
    assert.equal(findCharacter('Kai', story), kai, "a main name beats another one's alias");
    assert.deepEqual([norm('İstanbul'), norm('IŞIK ılık')], ['istanbul', 'işik ilik']);
    const isik = { id: 'n5', name: 'Işık', aliases: [] }, ipek = { id: 'n6', name: 'İpek', aliases: [] }, irem = { id: 'n7', name: 'İrem Kaya', aliases: [] };
    assert.equal(findCharacter('IŞIK', [isik, ipek, irem]), isik);
    assert.equal(findCharacter('Ipek', [isik, ipek, irem]), ipek);
    assert.equal(findCharacter('Rem', [isik, ipek, irem]), null, '"Rem" is not İrem');
});

test('evidence: a quote whose words are scattered over the scenes is not evidence', () => {
    const scenes = 'Mira: I burned the fish crates this morning, they stank.\nRook: Fine.\nMira: The letter is safe in the logbook, nobody touches it.';
    assert.equal(evidenceFound('Mira burned the letter this morning', scenes), false);
    assert.equal(evidenceFound('I burned the fish crates this morning', scenes), true);
});

test('evidence: exact, normalized and near-exact quotes pass; invented ones fail', () => {
    const text = 'Mira: The Halcyon. Forty-one people. Then you had better never say that name in town!';
    assert.ok(evidenceFound('Forty-one people', text));
    assert.ok(evidenceFound('never say that name in town', text));
    assert.ok(evidenceFound('you had better never say that name', text));
    assert.ok(!evidenceFound('Tom knows about the Halcyon', text));
    assert.ok(!evidenceFound('ok', text));
});

test('names: titles aside, shared name words match; two full names that share a word are two people', () => {
    assert.ok(samePerson('Ben', 'Ben Reilly'));
    assert.ok(samePerson('Doctor Burcu', 'Burcu Aydemir'));
    assert.ok(!samePerson('X', 'Xavier'));
    assert.ok(!samePerson('Cersei Lannister', 'Tyrion Lannister'));
    const cersei = { id: 'c1', name: 'Cersei Lannister' }, tyrion = { id: 'c2', name: 'Tyrion Lannister' };
    assert.equal(findCharacter('Lannister', [cersei, tyrion]), null);
    assert.ok(namesSomeone('Lannister', [cersei, tyrion]));
    assert.ok(!isPresent({ present: ['Cersei Lannister', 'Aras'] }, tyrion, { story: [cersei, tyrion] }));
    assert.ok(isPresent({ present: ['Tyrion'] }, tyrion, { story: [cersei, tyrion] }));
    // A message nobody placed is nobody's
    assert.ok(!isPresent({ present: null }, tyrion));
    const pp = { id: 'p1', name: 'Peter Parker' }, pb = { id: 'p2', name: 'Peter B. Parker' };
    assert.equal(whoIs('Peter', { story: [pp], everyone: [pp, pb], player: 'Peter' }), null);
    assert.equal(bareName("User (player's character)"), 'User');
    for (const n of ['students', 'the waiter', 'Police']) assert.ok(isExtra(n), n);
    assert.ok(mentions('*İrem glances at the door.*', { name: 'İrem Kaya' }));
    assert.ok(!mentions('Gwendolyn waves.', { name: 'Gwen Stacy' }));
});

test('pronouns and personality: 41 values, average by default, the profile shows deviations only', () => {
    assert.equal(withPronouns('She recharges alone; crowds drain her.', 'he'), 'He recharges alone; crowds drain him.');
    const v = normalize({ disadonukluk: 10 });
    assert.equal(Object.keys(v).length, PARAMS.length);
    assert.equal(deviations(v).length, 1);
    assert.match(profile(v, { pronouns: 'he' }), /Extraversion very low/);
    assert.equal(profile(normalize({})), 'An average person on every dimension.');
    assert.ok(inThisPerson('Extraversion', v, 'she')?.lines.length === 1);
});

test('the past: a message about it makes the reply worth checking', () => {
    assert.ok(mentionsThePast('Do you remember the bridge?'));
    assert.ok(mentionsThePast('Hani geçen yaz Kapadokya’ya gitmiştik ya'));
    assert.ok(!mentionsThePast("Let's go to the market."));
});

test('character cards: v2, v1 and the PNG they are shared as become a description, lore and a card', () => {
    const c = fromCharacterCard(RIN);
    assert.equal(c.name, 'Rin');
    assert.match(c.description, /^Rin runs a ramen stall and teases the user\./);
    assert.ok(!c.description.includes('<START>'));
    assert.equal(c.lore, 'Night Market: The stalls open at midnight.');
    assert.equal(c.card.first_message, '*Rin slides a bowl over.* Eat.');
    assert.equal(fromCharacterCard({ name: 'Old', description: 'v1 card', first_mes: 'Hello.' }).card.first_message, 'Hello.');
    assert.equal(fromCharacterCard({ name: 'Not a card' }), null);
    const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); return Buffer.concat([len, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]); };
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('tEXt', Buffer.from(`chara\0${Buffer.from(JSON.stringify(RIN)).toString('base64')}`, 'latin1')), chunk('IEND', Buffer.alloc(0))]);
    assert.equal(cardFromPng(png).data.name, 'Rin');
    assert.equal(fromCharacterCard(png.toString('base64')).name, 'Rin');
});

// ---------- Accounts ----------
const { project, key } = createProject('Test studio');

test('keys: a project key authenticates, a revoked one does not; keys from before the rename (psy_) still work', () => {
    assert.match(key, /^kio_/);
    assert.equal(authenticate(`Bearer ${key}`), project.id);
    const k2 = createKey(project.id, 'temp');
    assert.ok(revokeKey(project.id, k2.slice(0, 10)));
    assert.equal(authenticate(k2), null);
    const old = 'psy_madebeforetherename0000000000000000';
    run('INSERT INTO api_keys (hash, project_id, prefix, label, created_at) VALUES (?, ?, ?, ?, ?)', sha(old), project.id, old.slice(0, 10), 'old', now());
    assert.equal(authenticate(`Bearer ${old}`), project.id);
    assert.ok(dbPath.startsWith(process.env.KIORI_DATA) && dbPath.endsWith('kiori.db'));
});

test('keys: a label is text of at most 100 characters; at most 100 keys; a sign-in at the limit trades the oldest console key', async () => {
    const { signinLink, redeemSignin } = await import('../src/access.mjs');
    const { project } = createProject('Many keys', {}, { llmMode: 'own', firstKey: false });
    assert.throws(() => createKey(project.id, { not: 'text' }), e => e.status === 400);
    createKey(project.id, `  ${'L'.repeat(500)}  `);
    assert.equal(listKeys(project.id)[0].label.length, 100);
    const token = () => signinLink(project.id).link.split('#signin=')[1];
    const first = redeemSignin(token()).key;
    while (keyCount(project.id) < MAX_KEYS) createKey(project.id, 'app');
    assert.throws(() => createKey(project.id, 'one more'), e => e.status === 409);
    const second = redeemSignin(token()).key;
    assert.equal(keyCount(project.id), MAX_KEYS);
    assert.deepEqual([authenticate(first), authenticate(second)], [null, project.id]);
});

test('kiori import: names from a vault stay inside --out, and a file already there is never overwritten', async () => {
    const { execFile } = await import('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiori-hostile-'));
    const vault = path.join(dir, 'vault'), out = path.join(dir, 'a', 'b', 'out');
    fs.mkdirSync(vault);
    fs.writeFileSync(path.join(vault, 'Card.md'), "---\nname: ../../ESCAPE/pwned\n---\n**Who:** Someone who writes where they shouldn't.\n");
    const cli = () => new Promise((resolve, reject) => execFile(process.execPath, [path.resolve('bin/kiori.mjs'), 'import', vault, '--out', out], { cwd: path.resolve('.') }, (e, stdout, stderr) => (e ? reject(new Error(stderr || e.message)) : resolve(stdout))));
    await cli();
    await cli();
    const files = [];
    const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) if (f.isDirectory()) walk(path.join(d, f.name)); else files.push(path.relative(dir, path.join(d, f.name))); };
    walk(dir);
    assert.deepEqual(files.filter(f => f.endsWith('.json')).sort(), [path.join('a', 'b', 'out', 'ESCAPEpwned (2).json'), path.join('a', 'b', 'out', 'ESCAPEpwned.json')]);
});

test('storage: the database holds accounts only, no brains and no chats', () => {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(t => t.name).sort();
    assert.deepEqual(tables, ['access_requests', 'api_keys', 'calls', 'errors', 'projects', 'signins', 'usage']);
    // A sign-in link is kept as a hash of its token, with whose it is and until when
    assert.deepEqual(db.prepare('PRAGMA table_info(signins)').all().map(c => c.name), ['hash', 'project_id', 'created_at', 'expires_at']);
    // A failed call is noted by its endpoint, status and codes only: there's nowhere to put what was said
    assert.deepEqual(db.prepare('PRAGMA table_info(errors)').all().map(c => c.name), ['id', 'at', 'project_id', 'route', 'status', 'code', 'upstream']);
});

test('brain API key: the provider is read from the key; unknown and unsupported keys say why', async () => {
    assert.equal(detectProvider('sk-or-v1-abc').id, 'openrouter');
    assert.equal(detectProvider('AIzaSyExample').id, 'gemini');
    assert.equal(detectProvider('sk-proj-abc').id, 'openai');
    assert.throws(() => detectProvider('sk-ant-api03-abc'), e => e.status === 400 && e.code === 'UNSUPPORTED_KEY');
    assert.throws(() => detectProvider('hello'), e => e.status === 400 && e.code === 'UNKNOWN_KEY');
    const view = await brainKeyView(P);
    assert.equal(view.provider, 'Custom');
    assert.equal(view.key, '…-key');
    assert.equal(view.model, 'anthropic/claude-haiku-5.5');
    assert.ok(view.models.some(m => m.id === 'meta/llama-roleplay') && !view.models.some(m => /embedding/.test(m.id)));
    // A model the key can't use, and a key the provider refuses, are errors; a listed model is saved
    await assert.rejects(setBrainKey(P, { model: 'nobody/none' }), e => e.code === 'UNKNOWN_MODEL');
    const other = createProject('Bad key', {}, { llmMode: 'own' }).project.id;
    await assert.rejects(setBrainKey(other, { key: 'sk-wrong', base_url: fake.url }), e => e.status === 400 && e.code === 'BAD_KEY');
    assert.equal((await setBrainKey(P, { model: 'anthropic/claude-sonnet-5.5' })).model, 'anthropic/claude-sonnet-5.5');
    await setBrainKey(P, { model: 'anthropic/claude-haiku-5.5' });
    // Never shown back whole
    assert.ok(!JSON.stringify(db.prepare('SELECT settings FROM projects WHERE id = ?').get(P)).includes('sk-test-key'));
});

// ---------- The brain file ----------
test('brain file: read safely; what is not a brain is an error, what does not fit is dropped or set to its default', () => {
    assert.throws(() => readBrain('not json'), e => e.status === 400 && e.code === 'BAD_BRAIN');
    assert.throws(() => readBrain({ name: 'x' }), /not a Kiori brain/);
    assert.throws(() => readBrain({ kiori: 99, name: 'x' }), /newer version/);
    assert.throws(() => readBrain({ kiori: 1 }), /no name/);
    const b = readBrain({
        kiori: 1, name: ' Mira ', pronouns: 'xe', personality: { disadonukluk: 900 },
        memories: [{ id: 'a', title: 'T', body: 'B', importance: 7, from: 3, to: 1 }, { id: 'a', title: 'T2', body: 'B2' }, { title: '', body: 'no title' }, 'junk'],
        relations: [{ target: 'Leo', trust: 0.5, closeness: 'x' }, { target: '' }],
        chat: { learned: 2, seen: [[5, 'ffff'], [3, 'eeee', 'id3'], ['x', 'bad']] },
        state: { core: { mood: 'calm', on_mind: 'not a list' } },
    });
    assert.equal(b.name, 'Mira');
    assert.equal(b.pronouns, 'they');
    assert.equal(b.personality.disadonukluk, 100);
    assert.equal(b.memories.length, 2);
    assert.notEqual(b.memories[0].id, b.memories[1].id);
    assert.equal(b.memories[0].importance, 1);
    assert.equal(b.memories[0].to, 3);
    assert.deepEqual([b.relations[0].trust, b.relations[0].closeness], [50, null]);
    assert.deepEqual(b.chat, { learned: 5, seen: [[3, 'eeee', 'id3'], [5, 'ffff']] });
    assert.deepEqual(b.state.core, { mood: 'calm', on_mind: [], wants: [] });
    assert.throws(() => readBrains({ brains: [b, { ...b }] }), /Two brains are called/);
    assert.throws(() => readBrains({}), /Send the brain/);
    assert.equal(readBrains({ brain: b }).single, true);
    assert.throws(() => readBrain({ kiori: 1, name: 'x', memories: Array(LIMITS.memories + 1).fill({}) }), /more than/);
});

test('brain file: meaning fingerprints travel as 256 bytes and still compare', () => {
    const a = vectorOf('the lighthouse keeper lit the lamp'), b = vectorOf('the keeper lit the lighthouse lamp again'), c = vectorOf('ramen stall rain market');
    const [pa, pb, pc] = [a, b, c].map(v => unpackVector(packVector(Float32Array.from(v))));
    assert.equal(pa.length, 256);
    assert.ok(Buffer.from(packVector(Float32Array.from(a)), 'base64').length === 256);
    assert.ok(cosine(pa, pa) > 0.999);
    assert.ok(cosine(pa, pb) > cosine(pa, pc));
    assert.equal(unpackVector('not base64 of a vector?'), null);
    // A longer vector is cut to its first 256 numbers
    assert.equal(unpackVector(packVector(new Float32Array(1536).fill(1))).length, 256);
});

test('brain file: relations are kept 0-100, the conversation view replaces the core one; state likewise', () => {
    const b = newBrain({ name: 'Kaan' });
    setRelation(b, { target: 'Ece', trust: 0.8, note: 'Old friend.' }, 'core');
    setRelation(b, { target: 'Ece', trust: 20 }, 'chat');
    assert.deepEqual(getRelations(b).map(r => [r.target, r.trust, r.note, r.scope]), [['Ece', 20, 'Old friend.', 'chat']]);
    setState(b, { mood: 'calm', on_mind: ['work'] }, 'core');
    setState(b, { mood: 'angry', on_mind: [] }, 'chat');
    assert.deepEqual(getState(b), { mood: 'angry', on_mind: ['work'], wants: [] });
    addMemories(b, [{ title: 'A', body: 'a' }, { title: 'B', body: 'b' }], { links: [{ from: 'A', to: 'B' }, { from: 'A', to: 'nobody' }] });
    assert.deepEqual(b.memories[0].links, [b.memories[1].id]);
});

// ---------- Creating ----------
test('create, light: a brain from the card alone, with no model call', async () => {
    const before = fake.calls.length;
    const b = await createBrain(P, { character_card: RIN, depth: 'light' });
    assert.equal(fake.calls.length, before);
    assert.equal(b.kiori, 1);
    assert.equal(b.name, 'Rin');
    assert.equal(b.build, 'light');
    assert.equal(b.card.first_message, '*Rin slides a bowl over.* Eat.');
    assert.match(b.card.lore, /Night Market/);
    assert.equal(b.memories.length, 0);
    await assert.rejects(createBrain(P, { character_card: { hello: 1 } }), e => e.status === 400);
    await assert.rejects(createBrain(P, { description: 'nameless' }), /needs a name/);
    await assert.rejects(createBrain(P, { name: 'X', depth: 'deep' }), /depth/);
    // A full brain needs a model key; the server's own key here goes nowhere
    await assert.rejects(createBrain(createProject('No key', {}, { llmMode: 'own' }).project.id, { name: 'X' }), e => e.code === 'NEEDS_KEY');
});

let mira;
test('create, full: a sketch, then the past and the inner life, with fingerprints', async () => {
    mira = await createBrain(P, { name: 'Mira Voss', description: 'A lighthouse keeper on a cold coast.', others: ['Rook', { name: 'Ines', who: 'A harbor trader' }] });
    assert.equal(mira.pronouns, 'she');
    assert.deepEqual(mira.aliases, ['Mira', 'The Keeper']);
    assert.equal(mira.card.who, 'A lighthouse keeper who left medicine behind.');
    assert.equal(mira.card.description, 'A lighthouse keeper on a cold coast.');
    assert.equal(mira.personality.disadonukluk, 20);
    assert.equal(mira.memories.filter(m => m.kind === 'mind').length, 1);
    assert.ok(mira.memories.length >= 17 && mira.memories.every(m => m.scope === 'core'));
    assert.ok(mira.memories.every(m => m.v), 'every memory has its fingerprint');
    assert.deepEqual(mira.embed, { model: 'openai/text-embedding-3-small', dim: 256 });
    assert.deepEqual(getRelations(mira).map(r => [r.target, r.trust, r.closeness]), [['Tomas', 80, 90]]);
    assert.equal(getState(mira).mood, 'watchful');
    assert.ok(mira.memories.find(m => m.title === 'Harrow Field 1').links?.length, 'links by title');
    assert.match(chatCalls('sketching')[0].body.messages[0].content, /OTHER CHARACTERS IN THIS WORLD:\n- Rook\n- Ines: A harbor trader/);
    // A brain survives being sent back as JSON
    assert.deepEqual(readBrain(JSON.parse(JSON.stringify(mira))).memories.length, mira.memories.length);
});

// ---------- Recall ----------
test('recall: rare words and meaning decide; the answer is a ready prompt block, and the brain is not changed', async () => {
    const before = JSON.stringify(mira);
    const r = await recall(P, [mira], { messages: [{ role: 'user', content: 'Is the letter still in the logbook?' }], player: 'Leo' });
    assert.equal(JSON.stringify(mira), before);
    assert.equal(r.characters[0].memories[0].title, 'The unsent letter');
    assert.ok(!('v' in r.characters[0].memories[0]));
    assert.equal(r.text, r.characters[0].text);
    assert.match(r.text, /# What Mira Voss brings to this moment/);
    assert.match(r.text, /Leo is the player/);
    assert.equal(r.check_recommended, false);
    assert.equal((await recall(P, [mira], { messages: [{ role: 'user', content: 'Do you remember the letter?' }] })).check_recommended, true);
    // Words alone, without fingerprints, still find it
    assert.equal(searchMemories(mira, 'logbook letter', null)[0].title, 'The unsent letter');
    assert.ok(contextOf(mira, { text: 'x', budget: 400 }).text.length < 1200);
});

// ---------- Organizing ----------
test('organizing: lining a chat up with what a brain learned (ids, words, edits, rerolls, deletions)', () => {
    const b = newBrain({ name: 'Rin' });
    const ev = msgs => eventsOf(msgs, { player: 'Leo', solo: 'Rin' });
    const base = chat(10);
    assert.deepEqual(lineUp(b, ev(base)), { start: 0, seq: 1, rewindFrom: null });
    b.chat = { learned: 6, seen: ev(base).slice(0, 6).map((e, i) => [i + 1, e.fp, e.id]) };
    assert.deepEqual(lineUp(b, ev(base)), { start: 6, seq: 7, rewindFrom: null });
    // A window that slid on: still lined up
    assert.deepEqual(lineUp(b, ev(chat(14)).slice(3)), { start: 3, seq: 7, rewindFrom: null });
    // An edit of a learned message (same id, other words): unlearn from it
    assert.deepEqual(lineUp(b, ev(chat(10, { 4: 'I changed my mind.' }))), { start: 3, seq: 4, rewindFrom: 4 });
    // A deleted learned message
    assert.deepEqual(lineUp(b, ev(base.filter(m => m.id !== 'm5'))), { start: 4, seq: 5, rewindFrom: 5 });
    // Without ids the words line it up; a reroll is new words in the same place
    const noIds = msgs => msgs.map(({ id, ...m }) => m);
    b.chat.seen = b.chat.seen.map(([s, fp]) => [s, fp]);
    assert.deepEqual(lineUp(b, ev(noIds(base))), { start: 6, seq: 7, rewindFrom: null });
    assert.deepEqual(lineUp(b, ev(noIds(chat(10, { 6: 'A rerolled reply.' })))), { start: 5, seq: 6, rewindFrom: 6 });
    // Narration stays narration, even with one character
    assert.deepEqual(ev([{ role: 'narrator', content: 'Rain on the tin roof.' }, { role: 'assistant', content: 'Eat.' }]).map(e => [e.role, e.speaker]), [['narrator', null], ['character', 'Rin']]);
    // Only new messages sent: all new
    assert.deepEqual(lineUp(b, ev([{ role: 'user', content: 'Brand new words here.' }])), { start: 0, seq: 7, rewindFrom: null });
    // Rewinding takes back every pass that read the changed message, from where it began
    addMemories(b, [{ title: 'Pass 1', body: 'a', from: 1, to: 3 }, { title: 'Pass 2', body: 'b', from: 4, to: 6 }], { scope: 'chat' });
    addMemories(b, [{ title: 'Core', body: 'c' }], { scope: 'core' });
    assert.deepEqual(rewind(b, 5), { from: 4, forgot: 1 });
    assert.deepEqual(b.memories.map(m => m.title), ['Pass 1', 'Core']);
    assert.equal(b.chat.learned, 3);
    assert.ok(b.chat.seen.every(([s]) => s < 4));
});

test('organizing: a text or an id that comes up again doesn\'t pull the line-up off; a rewind puts back feelings, mood and plans', () => {
    const ev = msgs => eventsOf(msgs, { player: 'Leo', solo: 'Rin' });
    const b = newBrain({ name: 'Rin' });
    // 100 messages without ids, "Continue." at 21 and 81; the brain learned 1..96 and remembers 33..96
    const long = Array.from({ length: 100 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: i === 20 || i === 80 ? 'Continue.' : `Line ${i + 1} of the story.` }));
    const events = ev(long);
    b.chat = { learned: 96, seen: events.slice(32, 96).map(e => [e.n, e.fp]) };
    assert.deepEqual(lineUp(b, events), { start: 96, seq: 97, rewindFrom: null });
    // A message and its reply sharing an id (an old SillyTavern send date, to the minute)
    const shared = ev(long.slice(0, 30).map((m, i) => ({ ...m, id: `t${Math.floor(i / 2)}` })));
    b.chat = { learned: 26, seen: shared.slice(0, 26).map(e => [e.n, e.fp, e.id]) };
    assert.deepEqual(lineUp(b, shared), { start: 26, seq: 27, rewindFrom: null });
    // A deletion is still noticed when the unchanged run after it is the longer one
    b.chat = { learned: 10, seen: ev(chat(10)).map(e => [e.n, e.fp, e.id]) };
    assert.deepEqual(lineUp(b, ev(chat(10).filter(m => m.id !== 'm3'))), { start: 2, seq: 3, rewindFrom: 3 });
    // Of a list longer than 400, the newest 400 are read
    assert.equal(ev(chat(450)).length, 400);

    // A rewind puts back what the passes taken back did: the feelings, the mood, a plan they marked done
    const u = newBrain({ name: 'Rin' });
    addMemories(u, [{ kind: 'intention', title: 'Keep his secret', body: 'I promised.', from: 1, to: 3 }], { scope: 'chat' });
    addMemories(u, [{ title: 'The betrayal', body: 'He sold it.', from: 4, to: 6 }], { scope: 'chat' });
    u.memories[0].status = 'done';
    u.relations = [{ target: 'Leo', trust: 5, closeness: 10, respect: 20, resentment: 90, attraction: 0, note: 'He sold my secret.', scope: 'chat' }];
    u.state.chat = { mood: 'betrayed', on_mind: [], wants: [] };
    u.chat = { learned: 6, seen: [], undo: [
        { from: 1, relations: [{ target: 'Leo', before: null }], state: null, closed: [] },
        { from: 4, relations: [{ target: 'Leo', before: { target: 'Leo', trust: 60, closeness: 50, respect: 50, resentment: 0, attraction: 0, note: 'A friend.', scope: 'chat' } }], state: { mood: 'hopeful', on_mind: [], wants: [] }, closed: [[u.memories[0].id, 'active']] },
    ] };
    // The record survives a trip through a brain file
    assert.deepEqual(readBrain(JSON.parse(JSON.stringify(u))).chat.undo, u.chat.undo);
    assert.deepEqual(rewind(u, 5), { from: 4, forgot: 1 });
    assert.deepEqual([u.relations[0].trust, u.relations[0].note, u.state.chat.mood, u.memories[0].status], [60, 'A friend.', 'hopeful', 'active']);
    assert.deepEqual(u.chat.undo.map(x => x.from), [1]);
    // Back to the start: what the first pass did goes too
    rewind(u, 1);
    assert.deepEqual([u.relations.length, u.state.chat, u.chat.undo], [0, null, undefined]);
});

test('placing: "Leo:" in the story, with the player Leo Martin and a Leo Brandt in the cast, puts nobody new there', async () => {
    const cast = [{ id: 'p1', name: 'Mira Voss', aliases: [] }, { id: 'p2', name: 'Leo Brandt', aliases: [] }];
    const events = eventsOf([
        { role: 'assistant', name: 'Mira Voss', content: 'The letter is hidden in the logbook.' },
        { role: 'narrator', content: 'Leo: I will keep it safe, I promise.' },
    ], { player: 'Leo Martin' });
    await placeEvents(P, events, { characters: cast, player: 'Leo Martin' });
    assert.ok(events.every(e => e.present && !e.present.includes('Leo Brandt')), JSON.stringify(events.map(e => e.present)));
});

test('placing: an answer that places nobody is asked again; if it stays empty, learning waits and the call says so', async () => {
    const a = await createBrain(P, { name: 'Ann Lee', description: 'A sailor.', depth: 'light' });
    const b = await createBrain(P, { name: 'Bo Chen', description: 'A cook.', depth: 'light' });
    const asked = chatCalls('Split it into scenes').length;
    const r = await organize(P, [a, b], false, { messages: chat(20, { 3: 'Message 3: [scenes nobody can place] here.' }), player: 'Leo', now: true, hold: 0 });
    assert.ok(chatCalls('Split it into scenes').length - asked >= 2, 'asked again');
    assert.ok(r.warnings.some(w => /Couldn't work out who was in each scene/.test(w)), r.warnings.join(' / '));
    assert.ok(r.brains.every(x => x.chat.learned === 0), 'nothing is skipped for good');
});

test('check in a group: a recent message nobody placed is listed apart, not as one everybody witnessed', async () => {
    await assert.rejects(checkReply(P, [mira], { draft: 'x'.repeat(20001), messages: [] }), e => e.status === 400 && /20000 characters/.test(e.message));
    const rook = await createBrain(P, { name: 'Rook', description: 'A sailor who rows the harbor.', depth: 'light' });
    await checkReply(P, [mira, rook], { draft: 'Rook: So, the letter is in the logbook, eh?', player: 'Leo', messages: [
        { role: 'assistant', name: 'Rook', content: 'I row out to the boats now. Back by dark.' },
        { role: 'assistant', name: 'Mira Voss', content: 'The letter is hidden in the logbook. Rook must never know.' },
    ] });
    const prompt = fake.calls.findLast(c => c.path === '/chat/completions' && JSON.stringify(c.body).includes('You check a draft reply')).body.messages[0].content;
    const rookBlock = prompt.slice(prompt.indexOf('### Rook'));
    assert.match(rookBlock, /Recent messages Rook witnessed:\n\(none\)/);
    assert.match(rookBlock, /nobody placed[^\n]*\n[\s\S]*hidden in the logbook/);
});

test('organizing: when a later piece fails, what the pieces before it taught comes back, with a warning', async () => {
    const b = await createBrain(P, { character_card: RIN, depth: 'light' });
    const messages = chat(40, { 31: 'Message 31: [a piece the model fails] and the rest of it.' });
    const r = await organize(P, [b], true, { messages, player: 'Leo', now: true, hold: 0 });
    assert.equal(r.brain.chat.learned, 24, 'the first piece is kept');
    assert.ok(r.warnings.some(w => /learning stopped after message 24/.test(w)), r.warnings.join(' / '));
    assert.equal(r.learned[0].to, 24);
});

test('create: a v1 card (or a v2 export with v1 fields on top) as the body; the build prompts carry no more than a brain keeps', async () => {
    const v1 = { name: 'Vee', description: 'A night-shift radio host.', personality: 'Dry, warm, a little sad.', scenario: 'A studio at 3 a.m.', first_mes: 'You\'re on the air.', mes_example: '' };
    const brain = await createBrain(P, { ...v1, depth: 'light' });
    assert.equal(brain.name, 'Vee');
    assert.match(JSON.stringify(brain.card), /Dry, warm/);
    const before = fake.calls.length;
    const huge = { spec: 'chara_card_v2', spec_version: '2.0', data: { ...RIN.data, name: 'Huge', character_book: { entries: Array.from({ length: 400 }, (_, i) => ({ keys: [`k${i}`], content: `Entry ${i}: ${'the harbor keeps its secrets '.repeat(40)}` })) } } };
    await createBrain(P, { character_card: huge });
    const builds = fake.calls.slice(before).filter(c => c.path === '/chat/completions').map(c => c.body.messages[0].content.length);
    assert.ok(builds.length >= 3 && Math.max(...builds) < 75000, `build prompts of ${builds.join(', ')} characters`);
});

test('fingerprints: an edited memory\'s old fingerprint is set aside and made again; one from before the hash is trusted', async () => {
    const b = await createBrain(P, { character_card: RIN, depth: 'light' });
    addMemories(b, [{ title: 'The wreck', body: 'Sailors pulled from a wreck at dawn.' }], { scope: 'chat' });
    await embedMissing(P, b);
    const m = b.memories.find(x => x.title === 'The wreck');
    assert.ok(m.v && m.vh === textHash(m));
    const old = m.v;
    m.body = 'A violin recital in the town hall.';
    assert.equal(freshVector(m), null, 'the old fingerprint no longer fits');
    await embedMissing(P, b);
    assert.ok(m.v !== old && m.vh === textHash(m));
    delete m.vh;
    assert.equal(freshVector(m), m.v);
    // The hash goes and comes back with the brain file
    m.vh = textHash(m);
    assert.equal(readBrain(JSON.parse(JSON.stringify(b))).memories.find(x => x.title === 'The wreck').vh, m.vh);
});

test('relations: 0-1 values are scaled only as fractions, a value left out keeps the one before, and the player stays in the prompt', async () => {
    const b = newBrain({ name: 'Rin' });
    const values = r => ['trust', 'closeness', 'respect', 'resentment', 'attraction'].map(f => r[f]);
    setRelation(b, { target: 'Ann', trust: 80, closeness: 90, respect: 70, resentment: 5, attraction: 30 }, 'chat');
    setRelation(b, { target: 'Ann', trust: 55, closeness: null, resentment: 1 }, 'chat');
    assert.deepEqual(values(b.relations[0]), [55, 90, 70, 1, 30]);
    setRelation(b, { target: 'Bo', trust: 0.8, closeness: 1, respect: 0.5 }, 'core');
    assert.deepEqual(values(b.relations[1]).slice(0, 3), [80, 100, 50]);
    // Read back from a brain file, a 1 stays a 1
    assert.equal(readBrain(JSON.parse(JSON.stringify(b))).relations[0].resentment, 1);
    // A number the model left out (missing, null or "") comes back unknown, not 0
    const num = { type: 'number' };
    assert.deepEqual(fitSchema({ trust: 40, closeness: null, respect: '' }, { type: 'object', properties: { trust: num, closeness: num, respect: num, attraction: num } }), { trust: 40, closeness: null, respect: null, attraction: null });
    // Fifteen people from their past, then the player met in this chat: the player is still in the ready block
    const crowd = newBrain({ name: 'Rin' });
    for (let i = 0; i < 15; i++) setRelation(crowd, { target: `Old friend ${i}`, trust: 50 }, 'core');
    setRelation(crowd, { target: 'Leo', trust: 70, note: 'The stranger at the door.' }, 'chat');
    assert.match(contextOf(crowd, { player: 'Leo' }).text, /- Leo: trust 70/);
});

test('organizing: a brain learns what is settled, keeps only what the chat proves, and waits when there is little new', async () => {
    let rin = await createBrain(P, { character_card: RIN, depth: 'light' });
    const learn = async (messages, extra = {}) => { const r = await organize(P, [rin], true, { messages, player: 'Leo', ...extra }); rin = r.brain; return r; };
    // 10 messages: 6 settled, fewer than 12 new: nothing to do, and no model call
    let calls = chatCalls().length;
    let r = await learn(chat(10));
    assert.deepEqual([r.learned, r.waiting, r.held], [[], 6, 4]);
    assert.equal(chatCalls().length, calls);
    // 20 messages: 16 settled and new: learned, the newest 4 held
    r = await learn(chat(20));
    assert.equal(r.learned.length, 1);
    assert.deepEqual([r.learned[0].from, r.learned[0].to, r.learned[0].written, r.learned[0].dropped.memories], [1, 16, 1, 1]);
    assert.equal(rin.chat.learned, 16);
    assert.deepEqual(rin.chat.seen.map(s => s[2]), Array.from({ length: 16 }, (_, i) => `m${i + 1}`));
    const m = rin.memories.find(x => x.scope === 'chat');
    assert.match(m.evidence, /message tell about the old lighthouse/);
    assert.ok(m.v);
    assert.equal(getRelations(rin).find(x => x.target === 'Leo').trust, 60);
    assert.ok(!getRelations(rin).some(x => x.target === 'Rin'), 'not a relation to themself');
    assert.equal(getState(rin).mood, 'curious');
    // A light brain with an empty card asked the organizer to fill it; this one had a description, so it didn't
    assert.match(chatCalls('memory of Rin').at(-1).body.messages[0].content, /Rin runs a ramen stall/);
    // The same chat again: nothing new
    calls = chatCalls().length;
    r = await learn(chat(20));
    assert.deepEqual([r.learned, r.rewound], [[], []]);
    assert.equal(chatCalls().length, calls);
    // A reroll of a held message changes nothing learned
    r = await learn(chat(20, { 20: 'A rerolled reply.' }));
    assert.deepEqual(r.rewound, []);
    // An edit of a learned message: what it taught goes, and is learned again
    r = await learn(chat(20, { 5: 'Message 5: actually, forget the lighthouse.' }));
    assert.deepEqual(r.rewound, [{ name: 'Rin', from: 1, forgot: 1 }]);
    assert.equal(r.learned[0].from, 1);
    assert.equal(rin.memories.filter(x => x.scope === 'chat').length, 1);
    // Messages deleted from the end of what was learned: unlearned, and too few left to learn again yet
    r = await learn(chat(20, { 5: 'Message 5: actually, forget the lighthouse.' }).slice(0, 10));
    assert.equal(r.rewound.length, 1);
    assert.equal(rin.memories.filter(x => x.scope === 'chat').length, 0);
    assert.equal(r.waiting, 6);
    // now: learn whatever is settled, however little
    r = await learn(chat(10), { now: true, hold: 0 });
    assert.equal(r.learned[0].to, 10);
    await assert.rejects(organize(P, [rin], true, {}), /messages is required/);
    await assert.rejects(organize(P, [rin], true, { messages: 'nope' }), /must be a list/);
});

test('organizing a group chat: each brain learns only the scenes it was in', async () => {
    let mi = await createBrain(P, { name: 'Mira', description: 'Keeper of the light.', depth: 'light' });
    let ro = await createBrain(P, { name: 'Rook', description: 'A boatman.', depth: 'light' });
    const messages = [
        { role: 'user', content: 'Evening, both of you.' },
        { role: 'assistant', name: 'Mira', content: 'The letter is hidden in the logbook, Leo.' },
        { role: 'assistant', name: 'Rook', content: 'I fixed the boat engine again today.' },
        { role: 'user', content: 'Good to hear the engine runs.' },
    ];
    const placed = chatCalls('Split it into scenes').length;
    const r = await organize(P, [mi, ro], false, { messages, player: 'Leo', now: true, hold: 0 });
    [mi, ro] = r.brains;
    assert.equal(r.learned.length, 2);
    const knows = (b, word) => b.memories.some(m => m.body.toLowerCase().includes(word));
    assert.ok(knows(mi, 'letter') && !knows(ro, 'letter'), 'Rook never saw Mira tell Leo about the letter');
    assert.ok(knows(ro, 'engine') && !knows(mi, 'engine'));
    assert.equal(chatCalls('Split it into scenes').length - placed, 1, 'one placement call for the stretch');
    // A check: Rook bringing up the letter is a leak, and gets fixed
    const c = await checkReply(P, [mi, ro], { draft: 'Rook: I know about the letter.', messages, player: 'Leo' });
    assert.equal(c.ok, false);
    assert.equal(c.issues[0].character, 'Rook');
    assert.equal(c.fixed, 'Rook: I know about something.');
    assert.deepEqual(c.checked, ['Rook']);
    const fine = await checkReply(P, [mi], { draft: 'Mira: The lamp is lit.', messages: messages.slice(0, 2) });
    assert.equal(fine.ok, true);
});

// ---------- Who knows what: sources, gossip, placement ----------
test('brain file: a v2.0.0 brain without sources loads unchanged, and sources survive a round trip', () => {
    const file = fs.readFileSync(new URL('./fixtures/brain-v2.0.0.json', import.meta.url), 'utf8');
    assert.equal(`${JSON.stringify(readBrain(file), null, 2)}\n`, file, 'byte for byte');
    const old = JSON.parse(file);
    old.role = 'world';
    old.groups = ['harbor', 'town'];
    old.memories.push(
        { id: 'm_s1', kind: 'fact', title: 'Leo\'s father sank the Halcyon', body: 'Leo\'s father sank the Halcyon.', about: ['Leo'], importance: 0.7, emotion: 0.2, strength: 0.6, status: 'active', scope: 'chat', evidence: 'Mira says the new one father sank the Halcyon', from: 13, to: 24, source: { how: 'told', by: 'Tom', origin: 'Mira', at: 17 }, confidence: 0.62 },
        { id: 'm_t1', kind: 'told', title: 'Told Ines', body: 'I told Ines.', about: ['Ines'], importance: 0.5, emotion: 0.2, strength: 0.5, status: 'active', scope: 'chat', told_to: ['Ines'], lie: true, said: 'home all night', truth: 'at the chapel', truth_ref: 'm_s1', source: { how: 'saw', at: 17 }, audience: { groups: ['*'], t0: 3, spread: [{ after: 1, groups: ['town'] }] } },
        { id: 'm_x', title: 'Bad source', body: 'b', source: { how: 'telepathy', by: 'Tom' }, confidence: 7 },
    );
    const b = readBrain(JSON.parse(JSON.stringify(old)));
    const again = readBrain(JSON.parse(JSON.stringify(b)));
    assert.deepEqual(again, b, 'stable');
    assert.deepEqual([b.role, b.groups], ['world', ['harbor', 'town']]);
    const [fact, told, bad] = b.memories.slice(-3);
    assert.deepEqual([fact.source, fact.confidence], [{ how: 'told', by: 'Tom', origin: 'Mira', at: 17 }, 0.62]);
    assert.deepEqual([told.kind, told.told_to, told.lie, told.said, told.truth, told.truth_ref], ['told', ['Ines'], true, 'home all night', 'at the chapel', 'm_s1']);
    assert.deepEqual(told.audience, { groups: ['*'], t0: 3, spread: [{ after: 1, groups: ['town'] }] });
    assert.equal(bad.source, undefined, 'an unknown how drops the whole source');
    assert.equal(bad.confidence, 1, 'clamped');
    // The Obsidian export says where it came from
    assert.match(exportObsidian(b).data.toString('utf8'), /source: "told by Tom, from Mira, message 17"/);
});

test('provenance: worked out from the quoted message, not the model; an origin the message never names is dropped; confidence follows the formula and can only be lowered', async () => {
    let [mi, ines, tom] = await Promise.all(['Mira', 'Ines', 'Tom'].map(name => createBrain(P, { name, description: 'Of Saltmere.', depth: 'light' })));
    setRelation(mi, { target: 'Tom', trust: 80 }, 'core');
    setRelation(ines, { target: 'Tom', trust: 20 }, 'core');
    const present = ['Mira', 'Ines', 'Tom'];
    const messages = [
        { id: 'p1', role: 'narrator', content: '*Rain hammers the harbor while the ferry bell rings twice.*', present },
        { id: 'p2', role: 'assistant', name: 'Tom', content: 'the rumor on the docks is that the ferry stops running this winter.', present },
        { id: 'p3', role: 'assistant', name: 'Tom', content: 'Ines says the lighthouse lamp was lit by someone else last night.', present },
        { id: 'p4', role: 'assistant', name: 'Tom', content: 'maybe Ines said the ferry captain is leaving for good.', present },
    ];
    const r = await organize(P, [mi, ines, tom], false, { messages, player: 'Leo', now: true, hold: 0 });
    [mi, ines, tom] = r.brains;
    const facts = b => b.memories.filter(m => m.kind === 'fact').sort((a, c) => a.source.at - c.source.at).map(m => [m.source, m.confidence]);
    // The fake says it "saw" every line; Tom's lines are heard from Tom all the same. Rook is never named: no origin
    assert.deepEqual(facts(mi), [
        [{ how: 'heard', by: 'Tom', at: 2 }, 0.78],
        [{ how: 'heard', by: 'Tom', origin: 'Ines', at: 3 }, 0.64],
        [{ how: 'heard', by: 'Tom', origin: 'Ines', at: 4 }, 0.2],
    ]);
    // Trusting Tom less, Ines believes him less; and she is no origin of her own knowledge
    assert.deepEqual(facts(ines), [
        [{ how: 'heard', by: 'Tom', at: 2 }, 0.58],
        [{ how: 'heard', by: 'Tom', at: 3 }, 0.58],
        [{ how: 'heard', by: 'Tom', at: 4 }, 0.2],
    ]);
    // His own lines are his own: nobody told him
    assert.ok(facts(tom).every(([s]) => s.how === 'saw' && !s.by));
    // A memory quoting narration was seen, at that message
    const seen = mi.memories.find(m => m.kind === 'memory');
    assert.deepEqual([seen.source, seen.confidence], [{ how: 'saw', at: 1 }, 1]);
    // Solo: a memory quoting the player's line is heard from the player
    const rin = (await organize(P, [await createBrain(P, { character_card: RIN, depth: 'light' })], true, { messages: chat(16), player: 'Leo' })).brain;
    assert.deepEqual(rin.memories.find(m => m.kind === 'memory').source, { how: 'heard', by: 'Leo', at: 1 });
});

test('gossip: Tom tells Ines what Mira said; Ines knows it from Tom, from Mira, and Mira\'s own scene never reaches her; the teller keeps a told record only for listeners who were there', async () => {
    let [mi, tom, ines] = await Promise.all(['Mira', 'Tom', 'Ines'].map(name => createBrain(P, { name, description: 'Of Saltmere.', depth: 'light' })));
    const loft = ['Mira', 'Tom', 'Leo'], tavern = ['Tom', 'Ines', 'Leo'];
    const messages = [
        { id: 'g1', role: 'narrator', content: '*Evening at the net loft. Mira and Tom mend nets alone.*', present: loft },
        { id: 'g2', role: 'assistant', name: 'Mira', content: 'Tom, listen: the new one father sank the Halcyon, I saw it in the harbor papers.', present: loft },
        { id: 'g3', role: 'narrator', content: '*Later, at the tavern, Tom sits down by Ines with two mugs.*', present: tavern },
        { id: 'g4', role: 'assistant', name: 'Tom', content: 'Ines, Mira says the new one father sank the Halcyon.', present: tavern },
        { id: 'g5', role: 'assistant', name: 'Tom', content: 'Rook, Mira says the ferry stops running this winter.', present: tavern },
    ];
    const placing = chatCalls('Split it into scenes').length;
    const r = await organize(P, [mi, tom, ines], false, { messages, player: 'Leo', now: true, hold: 0 });
    [mi, tom, ines] = r.brains;
    assert.equal(chatCalls('Split it into scenes').length, placing, 'presence was sent: nothing to place');
    assert.deepEqual(r.placed, []);
    const heard = ines.memories.find(m => m.kind === 'fact' && /Halcyon/.test(m.body));
    assert.deepEqual(heard.source, { how: 'heard', by: 'Tom', origin: 'Mira', at: 4 }, 'at: its number in the brain, as chat.seen counts');
    const saw = ines.memories.find(m => m.source?.how === 'saw');
    assert.ok(heard.confidence < saw.confidence, `${heard.confidence} < ${saw.confidence}`);
    assert.doesNotMatch(JSON.stringify(ines.memories), /papers|net loft/, 'Mira\'s own words never reach Ines');
    // Tom told Ines (she was there); Rook wasn't there, so that record is dropped and counted. Ines's brain gets no told
    // record of Tom's telling: it wasn't her line
    const told = tom.memories.filter(m => m.kind === 'told');
    assert.deepEqual(told.map(t => [t.told_to, t.lie, t.source]), [[['Ines'], false, { how: 'saw', at: 4 }]]);
    assert.equal(r.learned.find(l => l.name === 'Tom').dropped.told, 1);
    assert.equal(r.learned.find(l => l.name === 'Ines').dropped.told, 2);
    assert.ok(!ines.memories.some(m => m.kind === 'told'));
    // Recall lists hearsay apart, with its teller and its origin; what she saw stays "for sure"
    const block = contextOf(ines, { player: 'Leo' }).text;
    assert.match(block, /## What they've been told \(they know who told them, and say so\)\n- Ines, Mira says the new one father sank the Halcyon\. \(Tom said it in front of them; Tom said it came from Mira\. They half believe it\.\)/);
    assert.match(block, /they name who told them and never speak as if they saw it/);
    // Check: naming the wrong source is a misattribution, and the block it was judged on carries the source
    const c = await checkReply(P, [tom, ines], { draft: 'Ines: Mira told me about the Halcyon herself.', messages, player: 'Leo' });
    assert.deepEqual([c.ok, c.issues[0]?.type], [false, 'misattribution']);
    assert.match(fake.calls.findLast(c => JSON.stringify(c.body).includes('You check a draft reply')).body.messages[0].content, /### Ines[\s\S]*Tom said it in front of them; Tom said it came from Mira/);
    // Editing the line Tom told it in takes the record back with the rest of that pass
    const edited = messages.map(m => (m.id === 'g4' ? { ...m, content: 'Ines, the beer here is flat tonight.' } : m));
    const back = await organize(P, [tom], false, { messages: edited, player: 'Leo', now: true, hold: 0 });
    assert.ok(!back.brains[0].memories.some(m => m.kind === 'told'));
});

test('recall: hearsay is listed apart with its teller, old facts stay "for sure", memory headers show the source, and a doubted memory ranks lower', () => {
    const b = newBrain({ name: 'Ines' });
    addMemories(b, [
        { kind: 'fact', title: 'Old fact', body: 'The ferry is blue.', about: [] },
        { kind: 'fact', title: 'Seen', body: 'The lamp went out at midnight.', about: [], source: { how: 'saw', at: 2 }, confidence: 1 },
        { kind: 'fact', title: 'Rumor', body: 'The captain is leaving.', about: [], source: { how: 'told', by: 'Tom', at: 3 }, confidence: 0.4 },
        { title: 'Tom at the tavern', body: 'Tom told me about the Marisol wreck.', keys: ['marisol'], about: ['Tom'], importance: 0.5, source: { how: 'told', by: 'Tom', origin: 'Mira', at: 4 }, confidence: 0.9 },
    ], { scope: 'chat' });
    const hits = searchMemories(b, 'the Marisol wreck', null);
    const ctx = contextOf(b, { text: 'Marisol', hits });
    assert.match(ctx.text, /## What they know for sure\n- The ferry is blue\.\n- The lamp went out at midnight\.\n\n/);
    assert.match(ctx.text, /- The captain is leaving\. \(Tom told them\. They're not sure\.\)/);
    assert.match(ctx.text, /### Tom at the tavern \(fading, told by Tom, from Mira\)/);
    assert.deepEqual(ctx.facts.at(-1).source, { how: 'told', by: 'Tom', at: 3 });
    assert.deepEqual(hits[0].source, { how: 'told', by: 'Tom', origin: 'Mira', at: 4 }, 'recall passes sources on');
    const twin = newBrain({ name: 'Twin' });
    addMemories(twin, [{ title: 'Doubted', body: 'The bell rang twice.', importance: 0.5, confidence: 0.1 }, { title: 'Believed', body: 'The bell rang twice.', importance: 0.5 }]);
    assert.deepEqual(searchMemories(twin, 'bell', null).map(m => m.title), ['Believed', 'Doubted']);
});

test('organize: placement comes back as placed, and sending it back makes no placement call', async () => {
    const make = () => Promise.all(['Ann Lee', 'Bo Chen'].map(name => createBrain(P, { name, description: 'Of the harbor.', depth: 'light' })));
    const messages = [
        { id: 'q1', role: 'system', content: 'You are a story.' },
        { id: 'q2', role: 'user', content: 'Evening, both of you.' },
        { id: 'q3', role: 'assistant', name: 'Ann Lee', content: 'The tide turns at nine tonight.' },
        { role: 'assistant', name: 'Bo Chen', content: 'Then we row at ten.' },
    ];
    let placing = chatCalls('Split it into scenes').length;
    const r = await organize(P, await make(), false, { messages, player: 'Leo', now: true, hold: 0 });
    assert.equal(chatCalls('Split it into scenes').length - placing, 1);
    // n is the message's place in the list sent (the system message counts); id when it has one
    assert.deepEqual(r.placed, [
        { id: 'q2', n: 2, present: ['Leo'], scene: 'here' },
        { id: 'q3', n: 3, present: ['Ann Lee', 'Leo'], scene: 'here' },
        { n: 4, present: ['Bo Chen', 'Leo'], scene: 'here' },
    ]);
    // Fresh brains, the same messages with what was placed sent back as present: learning, and no placement call
    const back = messages.map((m, i) => ({ ...m, ...(r.placed.find(p => p.n === i + 1) && { present: r.placed.find(p => p.n === i + 1).present }) }));
    placing = chatCalls('Split it into scenes').length;
    const again = await organize(P, await make(), false, { messages: back, player: 'Leo', now: true, hold: 0 });
    assert.equal(chatCalls('Split it into scenes').length, placing);
    assert.deepEqual([again.placed, again.learned.length], [[], 2]);
});

test('placing: the cast in the prompt is only who the stretch can involve', async () => {
    const cast = Array.from({ length: 40 }, (_, i) => characterOf(newBrain({ name: `Kestrel${i}`, build: 'light', card: { who: `Sailor number ${i}, ${'weathered and quiet '.repeat(6)}` } })));
    const before = eventsOf([{ role: 'assistant', name: 'Kestrel5', content: 'I keep watch on the quay.', present: ['Kestrel5', 'Leo'] }], { player: 'Leo' });
    const stretch = eventsOf([
        { role: 'narrator', content: 'Kestrel3 and Kestrel17 haul the nets in.' },
        { role: 'assistant', name: 'Kestrel28', content: 'Mind the rope.' },
        { role: 'user', content: 'I lend a hand.' },
    ], { player: 'Leo' }).map((e, i) => ({ ...e, n: i + 2 }));
    await placeEvents(P, stretch, { before, characters: cast, player: 'Leo' });
    const prompt = chatCalls('Split it into scenes').at(-1).body.messages[0].content;
    const listed = prompt.slice(prompt.indexOf('KNOWN CHARACTERS:'), prompt.indexOf('STORY:'));
    assert.deepEqual([...listed.matchAll(/^- (\S+):/gm)].map(m => m[1]).sort(), ['Kestrel17', 'Kestrel28', 'Kestrel3', 'Kestrel5']);
    assert.ok(prompt.length < 3500, `${prompt.length} characters`);
    // A small cast is listed whole: someone described but not named can still be found
    await placeEvents(P, eventsOf([{ role: 'narrator', content: 'A tall stranger walks in.' }], { player: 'Leo' }), { characters: cast.slice(0, 3), player: 'Leo' });
    assert.match(chatCalls('Split it into scenes').at(-1).body.messages[0].content, /- Kestrel0:[\s\S]*- Kestrel2:/);
});

// ---------- Partial presence: how each person took a message in ----------
const person = name => ({ id: name, name, aliases: [] });
const learnPrompt = name => chatCalls(`You are the memory of ${name}`).at(-1)?.body.messages[0].content.split('WAS IN:')[1] ?? null;
const lightBrains = (...names) => Promise.all(names.map(name => createBrain(P, { name, description: 'Of Saltmere.', depth: 'light' })));

test('presence: present takes names and { name, mode }; a plain name is full, and a mode nobody knows is refused', () => {
    const [e] = eventsOf([{ role: 'narrator', content: 'The tide turns at nine.', present: ['Tom', { name: 'Ines', mode: 'saw' }, { name: 'Rook', mode: 'full' }, { name: 'Mira' }, 'Tom'] }], { player: 'Leo' });
    assert.deepEqual([e.present, e.modes], [['Tom', 'Ines', 'Rook', 'Mira'], { ines: 'saw' }]);
    assert.ok(['Tom', 'Ines', 'Rook', 'Mira'].every(n => isPresent(e, person(n))) && !isPresent(e, person('Leo')));
    assert.deepEqual(['Tom', 'Ines', 'Mira', 'Leo'].map(n => perceive(e, person(n)).mode), ['full', 'saw', 'full', null]);
    assert.equal(perceive(e, person('Tom')).text, 'The tide turns at nine.');
    assert.throws(() => eventsOf([{ role: 'user', content: 'Hi.', present: [{ name: 'Ines', mode: 'whisper' }] }], { player: 'Leo' }), x => x.status === 400 && /a mode is one of full, heard, overheard, saw, asleep/.test(x.message));
    // What each mode takes in of a narrator's message: narration, a "Name:" line, and words in quotes
    const [n] = eventsOf([{ role: 'narrator', content: 'The lamp gutters over the marisol charts.\nTom: Bring the boat round at dawn.\nMira shrugs. "The cellar key is mine," she says.', present: ['Tom', { name: 'Ines', mode: 'heard' }, { name: 'Rook', mode: 'saw' }, { name: 'Ana', mode: 'asleep' }, { name: 'Bo', mode: 'overheard' }] }], { player: 'Leo' });
    assert.equal(perceive(n, person('Ines')).text, '(you couldn\'t see this)\nTom: Bring the boat round at dawn.\n(you couldn\'t see this) "The cellar key is mine," (you couldn\'t see this)');
    assert.equal(perceive(n, person('Rook')).text, 'The lamp gutters over the marisol charts.\nTom: (words you couldn\'t hear)\nMira shrugs. (words you couldn\'t hear) she says.');
    assert.deepEqual(perceive(n, person('Ana')), { mode: 'asleep', text: '', missed: [] });
    const bo = perceive(n, person('Bo'));
    assert.doesNotMatch(bo.text, /marisol/);
    assert.match(bo.text, /…/);
    assert.deepEqual(perceive(n, person('Bo')), bo, 'the same gaps every time');
});

test('presence: an overheard message reaches the organizer masked, the same way every time, and a quote of a missed word is dropped', async () => {
    const line = 'The crate of rifles waits under the chapel floor beside the north wall until Sunday.';
    const messages = [{ id: 'o1', role: 'assistant', name: 'Tom', content: line, present: ['Tom', { name: 'Rook', mode: 'overheard' }] }];
    // A quote with one word Rook missed put back: close enough to pass as a quote, but he never heard that word
    const masked = perceive(eventsOf(messages, { player: 'Leo' })[0], person('Rook')).text;
    const said = line.split(' '), got = masked.split(' '), gap = got.findIndex(w => w.includes('…'));
    assert.ok(gap >= 0 && got.filter(w => w.includes('…')).length === 4, masked);
    got[gap] = said[gap];
    filledIn = got.join(' ');
    assert.ok(evidenceFound(filledIn, masked), 'it would pass as a quote on its own');
    const prompts = [];
    try {
        for (let i = 0; i < 2; i++) {
            const r = await organize(P, await lightBrains('Rook', 'Tom'), false, { messages, player: 'Leo', now: true, hold: 0 });
            prompts.push(learnPrompt('Rook'));
            const [rook, tom] = r.brains;
            assert.equal(r.learned.find(l => l.name === 'Rook').dropped.memories, 2, 'the made-up one and the filled-in one');
            assert.ok(!rook.memories.some(m => m.evidence === filledIn));
            const heard = rook.memories.find(m => m.kind === 'memory');
            assert.deepEqual([heard.source.how, heard.source.by, heard.confidence <= 0.4], ['overheard', 'Tom', true]);
            assert.ok(tom.memories.some(m => m.body.includes(line)), 'Tom said it all');
        }
    } finally { filledIn = null; }
    assert.match(prompts[0], /\[1\] Tom \(you overheard this from nearby; … = words you missed\): The .*…/);
    assert.doesNotMatch(prompts[0], new RegExp(said[gap]));
    assert.equal(prompts[0], prompts[1]);
});

test('presence: a whisper reaches its listener; the others saw it happen and learn none of its words, and check shows it to them without its words', async () => {
    let [mi, tom, ines] = await lightBrains('Mira', 'Tom', 'Ines');
    const messages = [
        { id: 'w1', role: 'narrator', content: '*Tom leans close to Mira at the bar.*', present: ['Tom', 'Mira', 'Ines'] },
        { id: 'w2', role: 'assistant', name: 'Tom', content: '*whispers* The ledger sits inside the organ loft behind the pipes.', present: ['Tom', 'Mira', { name: 'Ines', mode: 'saw' }] },
    ];
    const r = await organize(P, [mi, tom, ines], false, { messages, player: 'Leo', now: true, hold: 0 });
    [mi, tom, ines] = r.brains;
    assert.match(learnPrompt('Ines'), /\[2\] Tom \(you saw this but couldn't hear the words\): \*whispers\* \(words you couldn't hear\)/);
    assert.ok(mi.memories.some(m => m.body.includes('ledger')));
    assert.doesNotMatch(JSON.stringify(ines.memories), /ledger|organ|pipes/);
    assert.equal(r.learned.find(l => l.name === 'Ines').messages, 2, 'she was there for both');
    // At read time too: the message she only saw is listed without its words
    await checkReply(P, [mi, ines], { draft: 'Ines: What was that about?', messages, player: 'Leo' });
    const prompt = fake.calls.findLast(c => JSON.stringify(c.body).includes('You check a draft reply')).body.messages[0].content, block = prompt.slice(prompt.indexOf('### Ines'));
    assert.match(block, /Recent messages Ines witnessed:\n[\s\S]*\[2\] Tom \(you saw this but couldn't hear the words\): \*whispers\* \(words you couldn't hear\)/);
    assert.doesNotMatch(block, /ledger/);
});

test('presence: asleep learns nothing; on a call, dialogue lines but no narration', async () => {
    const messages = [{ id: 's1', role: 'narrator', content: 'The lamp gutters over the marisol charts.\nTom: Bring the boat round to the quay at dawn tomorrow.', present: ['Tom', { name: 'Ines', mode: 'heard' }, { name: 'Rook', mode: 'asleep' }] }];
    const asked = chatCalls('You are the memory of Rook').length;
    const r = await organize(P, await lightBrains('Tom', 'Ines', 'Rook'), false, { messages, player: 'Leo', now: true, hold: 0 });
    const [, ines, rook] = r.brains;
    assert.equal(chatCalls('You are the memory of Rook').length, asked, 'no learning call for someone asleep');
    assert.deepEqual([r.learned.find(l => l.name === 'Rook').messages, rook.memories.filter(m => m.scope === 'chat').length, rook.chat.learned], [0, 0, 1]);
    const heard = learnPrompt('Ines');
    assert.match(heard, /\[1\] STORY \(you only heard this\): \(you couldn't see this\)\nTom: Bring the boat round to the quay at dawn tomorrow\./);
    assert.doesNotMatch(heard + JSON.stringify(ines.memories), /marisol/);
});

test('placing: someone who arrives mid-scene is there from their arrival, not before (in a group, and in a solo chat with place: true)', async () => {
    const messages = [
        { id: 'a1', role: 'assistant', name: 'Mira', content: 'The spare key hides behind the loose third brick of the chimney.' },
        { id: 'a2', role: 'user', content: 'I will not tell a soul about the chimney.' },
        { id: 'a3', role: 'assistant', name: 'Tom', content: '[arrives] Evening, both. Cold out on the quay tonight.' },
        { id: 'a4', role: 'assistant', name: 'Mira', content: 'Sit down, Tom, the kettle is nearly boiling.' },
    ];
    const r = await organize(P, await lightBrains('Mira', 'Tom'), false, { messages, player: 'Leo', now: true, hold: 0 });
    const [mi, tom] = r.brains;
    assert.deepEqual(r.placed.map(p => p.present), [['Leo', 'Mira'], ['Leo', 'Mira'], ['Leo', 'Mira', 'Tom'], ['Leo', 'Mira', 'Tom']]);
    assert.equal(r.learned.find(l => l.name === 'Tom').messages, 2);
    assert.doesNotMatch(JSON.stringify(tom.memories), /brick|chimney/, 'what was said before he came in never reaches him');
    assert.ok(mi.memories.some(m => m.body.includes('brick')));
    assert.equal(tom.chat.learned, 4);
    // One character: everything is in front of them, unless the app asks for placing
    const asked = chatCalls('Split it into scenes').length;
    const all = await organize(P, await lightBrains('Tom'), true, { messages, player: 'Leo', now: true, hold: 0 });
    assert.deepEqual([chatCalls('Split it into scenes').length - asked, all.learned[0].messages, all.placed], [0, 4, []]);
    const placed = await organize(P, await lightBrains('Tom'), true, { messages, player: 'Leo', now: true, hold: 0, place: true });
    assert.deepEqual([chatCalls('Split it into scenes').length - asked, placed.learned[0].messages, placed.placed.length], [1, 2, 4]);
    assert.doesNotMatch(JSON.stringify(placed.brain.memories), /brick|chimney/);
});

test('organize: placed carries modes, and sent back they hold with no placement call; an answer in the old shape is everyone, all scene', async () => {
    const messages = [
        { id: 'r1', role: 'assistant', name: 'Mira', content: 'The boat leaves the harbor at midnight with the crates aboard.' },
        { id: 'r2', role: 'assistant', name: 'Tom', content: '[next room: Rook] Then we load the salted cod into the hold before the tide.' },
    ];
    const r = await organize(P, await lightBrains('Mira', 'Tom', 'Rook'), false, { messages, player: 'Leo', now: true, hold: 0 });
    assert.deepEqual(r.placed.map(p => p.present), [['Leo', 'Mira', 'Tom'], ['Leo', 'Mira', 'Tom', { name: 'Rook', mode: 'overheard' }]]);
    const first = learnPrompt('Rook');
    assert.match(first, /^\s*\[2\] Tom \(you overheard this/);
    const back = messages.map((m, i) => ({ ...m, present: r.placed[i].present }));
    const placing = chatCalls('Split it into scenes').length;
    const again = await organize(P, await lightBrains('Mira', 'Tom', 'Rook'), false, { messages: back, player: 'Leo', now: true, hold: 0 });
    assert.deepEqual([chatCalls('Split it into scenes').length, again.placed], [placing, []]);
    assert.equal(learnPrompt('Rook'), first, 'the same modes, the same gaps');
    // The fake's usual answer is the old shape, { present: [names] }: everyone in it is there, in full
    const old = eventsOf([{ role: 'assistant', name: 'Mira', content: 'The tide is high.' }, { role: 'user', content: 'So it is.' }], { player: 'Leo' });
    await placeEvents(P, old, { characters: [person('Mira')], player: 'Leo' });
    assert.deepEqual(old.map(e => [e.present, e.modes]), [[['Mira', 'Leo'], {}], [['Leo'], {}]]);
});

// ---------- Lies, and the data-first pre-check ----------
// Tom hides the crates at midnight with only Leo there, then tells Ines at the tavern he was home asleep
const NIGHT = [
    { id: 'l1', role: 'narrator', content: '*Midnight. Tom rows the stolen crates to the chapel and hides them under the floor. [truth]*', present: ['Tom', 'Leo'] },
    { id: 'l2', role: 'narrator', content: '*Morning at the tavern. Ines is waiting for Tom by the fire.*', present: ['Tom', 'Ines', 'Leo'] },
    { id: 'l3', role: 'assistant', name: 'Tom', content: 'Ines, I was home asleep all night long, ask anyone. [lies]', present: ['Tom', 'Ines', 'Leo'] },
];
const lastAudit = () => fake.calls.findLast(c => JSON.stringify(c.body).includes('You check a draft reply')).body.messages[0].content;

test('lies: the liar keeps the truth and a told record; the listener believes the lie, from the liar; editing the line takes back both', async () => {
    let [tom, ines] = await lightBrains('Tom', 'Ines');
    const r = await organize(P, [tom, ines], false, { messages: NIGHT, player: 'Leo', now: true, hold: 0 });
    [tom, ines] = r.brains;
    assert.match(chatCalls('You are the memory of Tom').at(-1).body.messages[0].content, /it's a lie: add it to told with lie: true[\s\S]*that they were lied to and by whom/);
    const told = tom.memories.find(m => m.kind === 'told');
    assert.deepEqual([told.told_to, told.lie, told.said, told.truth, told.truth_ref], [['Ines'], true, NIGHT[2].content, 'midnight tom rows the stolen crates the chapel and hides', undefined]);
    assert.match(told.body, /It was a lie: midnight tom rows/);
    // Ines believes it, as Tom's word, and nothing of the night reaches her
    const belief = ines.memories.find(m => m.kind === 'fact');
    assert.deepEqual([belief.body, belief.source], [NIGHT[2].content, { how: 'heard', by: 'Tom', at: 3 }]);
    assert.doesNotMatch(JSON.stringify(ines.memories), /crates|chapel/);
    assert.ok(!ines.memories.some(m => m.kind === 'told' || m.lie != null));
    // Recall: the liar knows the lies he keeps up; the listener has nothing special
    const mind = contextOf(tom, { player: 'Leo' });
    assert.match(mind.text, /## Lies they are keeping up \(toward those people they stick to the lie, unless they choose to confess\)\n- To Ines: "Ines, I was home asleep all night long, ask anyone\. \[lies\]"\. The truth: midnight tom rows the stolen crates/);
    assert.deepEqual(mind.lies, [{ id: told.id, to: ['Ines'], said: NIGHT[2].content, truth: told.truth }], 'with the id of the told memory');
    assert.ok(mind.facts.every(f => tom.memories.some(m => m.id === f.id && m.kind === 'fact')), 'facts carry their memory ids');
    const hers = contextOf(ines, { player: 'Leo' });
    assert.doesNotMatch(hers.text, /Lies they are keeping up/);
    assert.equal(hers.lies, undefined);
    // The line with the lie edited: the record and the belief both go back
    const edited = NIGHT.map(m => (m.id === 'l3' ? { ...m, content: 'Ines, the fire here is too warm tonight.' } : m));
    const back = await organize(P, [tom, ines], false, { messages: edited, player: 'Leo', now: true, hold: 0 });
    assert.deepEqual(back.rewound.map(x => x.name), ['Tom', 'Ines']);
    assert.ok(!back.brains[0].memories.some(m => m.kind === 'told'));
    assert.ok(!back.brains[1].memories.some(m => m.kind === 'fact'));
});

test('lies: the organizer sees memory ids and the secrets a stretch touches; a lie about a secret points at it, and a lie with no provable truth is a plain told record', async () => {
    let [tom, ines, rook] = await lightBrains('Tom', 'Ines', 'Rook');
    // Twelve memories that fit the stretch better than the secret does: search alone would leave the secret out
    addMemories(tom, Array.from({ length: 12 }, (_, i) => ({ title: `Night ${i}`, body: 'Ines asked about the night; I was home asleep all night long, ask anyone at the tavern.', keys: ['night', 'asleep', 'home', 'ines'], about: ['Ines'] })));
    const [secret] = addMemories(tom, [{ kind: 'secret', title: 'The crates', body: 'I hid the stolen crates under the chapel floor. Nobody may know.', keys: ['chapel'], about: [], importance: 0.9 }]);
    const messages = [{ id: 's1', role: 'assistant', name: 'Tom', content: 'Ines, I was home asleep all night long, nowhere near the chapel. [lies:secret]', present: ['Tom', 'Ines', 'Leo'] }];
    [tom] = (await organize(P, [tom, ines], false, { messages, player: 'Leo', now: true, hold: 0 })).brains;
    const known = chatCalls('You are the memory of Tom').at(-1).body.messages[0].content.split('THAT THIS TOUCHES')[1].split('THE SCENES')[0];
    assert.equal(known.match(/^- \[m_[\w-]+\] /gm).length, 11, 'the ten best hits, and the secret besides');
    assert.match(known, new RegExp(`^- \\[${secret.id}\\] \\(their secret\\) The crates: I hid the stolen crates`, 'm'));
    const told = tom.memories.find(m => m.kind === 'told');
    assert.deepEqual([told.lie, told.truth_ref, told.truth], [true, secret.id, 'I hid the stolen crates under the chapel floor.']);
    // Rook's lie has no truth anywhere: it stays what he said, a plain record
    const lone = [{ id: 's2', role: 'assistant', name: 'Rook', content: 'Ines, I said I saw nothing on the docks last night. [lies]', present: ['Rook', 'Ines', 'Leo'] }];
    [rook] = (await organize(P, [rook, ines], false, { messages: lone, player: 'Leo', now: true, hold: 0 })).brains;
    const plain = rook.memories.find(m => m.kind === 'told');
    assert.deepEqual([plain.told_to, plain.lie, plain.truth, plain.truth_ref], [['Ines'], false, undefined, undefined]);
    assert.doesNotMatch(contextOf(rook).text, /Lies they are keeping up/);
});

test('lies: a truth only the liar\'s own line brings up is still shown to the organizer, by id or quoted from the memory', async () => {
    const [before] = await lightBrains('Tom');
    // Twelve memories that fit the stretch far better than the truth does: a search on the stretch leaves the truth out
    addMemories(before, Array.from({ length: 12 }, (_, i) => ({ title: `Harbor ${i}`, body: 'Storm and fog over the harbor; the nets, the boats at the quay, gulls over the lighthouse and the breakwater.', keys: ['harbor', 'storm', 'fog'], about: [] })));
    const [truth] = addMemories(before, [{ title: 'The truth of that night', body: 'I rowed the stolen crates to the chapel and hid them under the floor at midnight.', keys: ['crates', 'chapel'], about: [] }], { scope: 'chat' });
    const present = ['Tom', 'Ines', 'Leo'];
    const stretch = marker => [
        { id: `h1${marker}`, role: 'narrator', content: '*Storm over the harbor. Fog rolls across the nets, the boats knock at the quay, gulls scream over the lighthouse and the breakwater.*', present },
        { id: `h2${marker}`, role: 'narrator', content: '*The harbor fog thickens; nets, boats, quay, gulls, lighthouse and breakwater all vanish in the storm.*', present },
        { id: `h3${marker}`, role: 'assistant', name: 'Tom', content: `Ines, I never touched any crates, I was home asleep. [lies:${marker}]`, present },
    ];
    assert.ok(!searchMemories(before, stretch('ref').map(m => m.content).join('\n'), null, { limit: 10 }).some(m => m.id === truth.id), 'not among the stretch\'s ten best hits');
    for (const marker of ['ref', 'quote']) {
        const ines = (await lightBrains('Ines'))[0];
        const [tom] = (await organize(P, [structuredClone(before), ines], false, { messages: stretch(marker), player: 'Leo', now: true, hold: 0 })).brains;
        assert.match(chatCalls('You are the memory of Tom').at(-1).body.messages[0].content.split('THE SCENES')[0], new RegExp(`^- \\[${truth.id}\\] The truth of that night`, 'm'));
        const told = tom.memories.find(m => m.kind === 'told');
        assert.deepEqual([told.told_to, told.lie, told.truth_ref], [['Ines'], true, truth.id], marker);
        assert.equal(told.truth, marker === 'ref' ? 'I rowed the stolen crates to the chapel and hid them under the floor at midnight.' : 'rowed the stolen crates the chapel and hid them under');
    }
});

test('lies: a character who speaks in a stretch is shown what they lived just before it, even when nothing in it calls that up', async () => {
    let [tom] = await lightBrains('Tom');
    addMemories(tom, Array.from({ length: 12 }, (_, i) => ({ title: `Harbor ${i}`, body: 'Storm and fog over the harbor; the nets, the boats at the quay, gulls over the lighthouse and the breakwater.', keys: ['harbor', 'storm', 'fog'], about: [], importance: 0.9, strength: 1 })), { scope: 'chat' });
    const night = { id: 'r1', role: 'narrator', content: '*Midnight. Tom rows the stolen crates to the chapel.*', present: ['Tom', 'Leo'] };
    tom = (await organize(P, [tom], true, { messages: [night], player: 'Leo', now: true, hold: 0 })).brain;
    const [lived] = tom.memories.filter(m => m.to === 1 && m.kind === 'memory');
    const present = ['Tom', 'Ines', 'Leo'];
    const morning = [night,
        { id: 'r2', role: 'narrator', content: '*Storm over the harbor. Fog rolls across the nets, the boats knock at the quay, gulls scream over the lighthouse and the breakwater.*', present },
        { id: 'r3', role: 'assistant', name: 'Tom', content: 'Ines, I was home asleep, I swear it.', present }];
    const line = morning[2].content, stretch = morning.slice(1).map(m => m.content).join('\n');
    assert.ok(![...searchMemories(tom, stretch, null, { limit: 10 }), ...searchMemories(tom, line, null, { limit: 6 })].some(m => m.id === lived.id), 'neither the stretch nor the line calls it up');
    await organize(P, [tom, (await lightBrains('Ines'))[0]], false, { messages: morning, player: 'Leo', now: true, hold: 0 });
    assert.match(chatCalls('You are the memory of Tom').at(-1).body.messages[0].content.split('THE SCENES')[0], new RegExp(`^- \\[${lived.id}\\] `, 'm'));
});

test('provenance: an origin named just before, in the same scene, narration or the teller\'s own, is kept; one named in another scene, or the teller, is not', async () => {
    let [tom, ines] = await lightBrains('Tom', 'Ines');
    const tavern = ['Tom', 'Ines', 'Leo'];
    const messages = [
        { id: 'o1', role: 'narrator', content: '*Rook spits off the end of the pier and stomps away, muttering.*', present: tavern },
        { id: 'o2', role: 'assistant', name: 'Tom', content: 'the rumor goes that the ferry stops running this winter.', present: tavern },
        { id: 'o3', role: 'narrator', content: '*Out past the breakwater, Rook rows alone into the fog.*', present: ['Ines', 'Leo'] },
        { id: 'o4', role: 'assistant', name: 'Tom', content: 'the rumor is the harbor master drinks before noon.', present: tavern },
        { id: 'o5', role: 'assistant', name: 'Rook', content: 'the rumor is the lamp in the lighthouse is cursed.', present: [...tavern, 'Rook'] },
    ];
    [tom, ines] = (await organize(P, [tom, ines], false, { messages, player: 'Leo', now: true, hold: 0 })).brains;
    // The fake says every rumor came from Rook, whom none of these lines names
    assert.deepEqual(ines.memories.filter(m => m.kind === 'fact').map(m => m.source).sort((a, b) => a.at - b.at), [
        { how: 'heard', by: 'Tom', origin: 'Rook', at: 2 },
        { how: 'heard', by: 'Tom', at: 4 },
        { how: 'heard', by: 'Rook', at: 5 },
    ]);
});

test('health: the commit the deploy kit wrote, else git\'s, else none', async () => {
    const { startServer, commitOf } = await import('../src/server.mjs');
    const deployed = fs.mkdtempSync(path.join(os.tmpdir(), 'kiori-app-')), bare = fs.mkdtempSync(path.join(os.tmpdir(), 'kiori-app-'));
    fs.writeFileSync(path.join(deployed, 'DEPLOYED'), 'version 2.0.0\ncommit abc1234\nshipped 2026-10-31T12:00:00Z\n');
    assert.equal(commitOf(deployed), 'abc1234');
    assert.equal(commitOf(bare), null, 'no DEPLOYED and no git checkout');
    for (const [root, commit] of [[deployed, 'abc1234'], [bare, undefined]]) {
        const server = startServer(0, '127.0.0.1', { root });
        await new Promise(r => server.once('listening', r));
        try {
            const h = await (await fetch(`http://127.0.0.1:${server.address().port}/health`)).json();
            assert.deepEqual([h.ok, h.version, h.commit], [true, JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url))).version, commit]);
            assert.equal('commit' in h, Boolean(commit));
        } finally { server.close(); }
    }
});

test('check: a liar who contradicts the lie toward that listener is a lie_slip; toward someone else, nothing', async () => {
    let [tom, ines, rook] = await lightBrains('Tom', 'Ines', 'Rook');
    [tom, ines] = (await organize(P, [tom, ines], false, { messages: NIGHT, player: 'Leo', now: true, hold: 0 })).brains;
    const draft = 'Tom: Fine, the crates are under the chapel.';
    const slip = await checkReply(P, [tom, ines], { draft, player: 'Leo', messages: [...NIGHT, { role: 'user', content: 'Tom, where were you really?', present: ['Tom', 'Ines', 'Leo'] }] });
    assert.deepEqual([slip.ok, slip.issues.map(i => [i.character, i.type]), slip.fixed], [false, [['Tom', 'lie_slip']], 'Tom: Fine, I was home.']);
    assert.deepEqual(slip.suspects.map(s => [s.type, s.word, s.to]), [['lie_slip', 'crates', ['Ines']], ['lie_slip', 'chapel', ['Ines']]]);
    const prompt = lastAudit();
    assert.match(prompt, /### Tom[\s\S]*## Lies they are keeping up[^\n]*\n- To Ines: "Ines, I was home asleep[^\n]*The truth: midnight tom rows/);
    assert.match(prompt, /- lie_slip: toward someone they lied to[\s\S]*Owning up \("I lied to you…"\) is not an issue/);
    // The same words on the docks, with Ines nowhere near: nothing to flag
    const other = await checkReply(P, [tom, rook], { draft, player: 'Leo', messages: [{ role: 'narrator', content: '*Later, on the docks, Rook mends a net beside Tom.*', present: ['Tom', 'Rook', 'Leo'] }] });
    assert.deepEqual([other.ok, other.issues, other.suspects, other.fixed], [true, [], [], draft]);
});

test('check: a contradiction that protects a secret is a lie, kept as it is', async () => {
    const draft = 'Mira: I have never written a letter in my life.';
    const c = await checkReply(P, [mira], { draft, player: 'Leo', messages: [{ role: 'user', content: 'Did you ever write to your brother?' }] });
    assert.deepEqual([c.ok, c.fixed, c.issues.map(i => i.type)], [true, draft, ['lie']]);
    assert.match(lastAudit(), /- lie: they say something that contradicts their memories in order to protect one of their secrets[^\n]*leave it word for word in "fixed"/);
});

// Mira alone knows of the Marisol, from this chat; Rook is a sailor who never heard of it
async function harbor(description = 'A sailor who rows the harbor.') {
    const keeper = structuredClone(mira);
    addMemories(keeper, [{ title: 'The Marisol', body: 'The Marisol sank off the point in the storm; only I kept its logbook.', keys: ['marisol'], about: [] }], { scope: 'chat' });
    return { keeper, rook: await createBrain(P, { name: 'Rook', description, depth: 'light' }) };
}
const MARISOL = 'Rook: So the Marisol went down, eh? And the logbook with it.';

test('check fast: a rare name only another brain knows is a leak, with no model call and no key; words from the card or a message the speaker saw are never suspects', async () => {
    const { keeper, rook } = await harbor();
    const none = createProject('No key yet', {}, { llmMode: 'own' }).project.id;
    const calls = fake.calls.length;
    const c = await checkReply(none, [keeper, rook], { draft: MARISOL, player: 'Leo', check: 'fast' });
    assert.equal(fake.calls.length, calls, 'no model call');
    assert.deepEqual(c.issues, [{ character: 'Rook', type: 'leak', quote: 'Marisol', why: 'Only Mira Voss holds "Marisol"; nothing Rook took in does.', by: 'precheck' }]);
    assert.deepEqual([c.ok, c.fixed, c.checked], [false, MARISOL, ['Rook']]);
    assert.deepEqual(c.suspects.map(s => [s.word, s.from, !!s.strong]), [['Marisol', ['Mira Voss'], true], ['logbook', ['Mira Voss'], false]]);
    assert.equal((await checkReply(none, [keeper, rook], { draft: MARISOL, player: 'Leo', mode: 'fast' })).issues.length, 1, 'mode: "fast" too');
    await assert.rejects(checkReply(none, [keeper, rook], { draft: MARISOL, player: 'Leo' }), e => e.code === 'NEEDS_KEY');
    // Rook once crewed the Marisol (his card says so), and he was there when Mira named the logbook; the cellar was
    // named where he wasn't, and only a message holds it: a hint, never a leak
    const crew = (await harbor('A sailor who once crewed the Marisol.')).rook;
    const messages = [
        { role: 'assistant', name: 'Mira Voss', content: 'I keep the logbook by the lamp.', present: ['Mira Voss', 'Rook', 'Leo'] },
        { role: 'assistant', name: 'Mira Voss', content: 'The key hides in the cellar, Leo.', present: ['Mira Voss', 'Leo'] },
    ];
    const seen = await checkReply(none, [keeper, crew], { draft: 'Rook: So the Marisol went down, eh? And the logbook. And the cellar.', player: 'Leo', check: 'fast', messages });
    assert.deepEqual([seen.ok, seen.suspects.map(s => [s.word, s.from, !!s.strong])], [true, [['cellar', [], false]]]);
    assert.equal(fake.calls.length, calls);
});

test('check: the auditor\'s prompt lists the pre-check\'s suspects, and a leak both of them find is one issue', async () => {
    const { keeper, rook } = await harbor();
    const c = await checkReply(P, [keeper, rook], { draft: MARISOL, player: 'Leo' });
    assert.match(lastAudit(), /\nWHAT THE DATA ALREADY SHOWS [^\n]*\n- Rook's lines: words only others know \(or a message Rook wasn't there for\): "Marisol" \(Mira Voss\), "logbook" \(Mira Voss\)\n\nDRAFT:/);
    assert.deepEqual(c.issues.map(i => [i.type, i.quote, i.by]), [['leak', 'the Marisol', undefined]]);
    assert.deepEqual([c.ok, c.fixed], [false, 'Rook: So the ship went down, eh? And the logbook with it.']);
});

test('the drop-in: auto checks a group reply with a suspect even when nobody spoke of the past; fast flags it without a model', async () => {
    const { keeper, rook } = await harbor();
    const { startServer } = await import('../src/server.mjs');
    const server = startServer(0);
    await new Promise(r => server.once('listening', r));
    const send = (model, check) => fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${own.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Evening, all.' }], kiori: { brains: [keeper, rook], player: 'Leo', ...(check && { check }) } }) });
    const audits = () => chatCalls('You check a draft reply').length;
    try {
        const before = audits();
        const r = await send('group-reply');
        assert.equal(r.headers.get('x-kiori-check'), 'fixed');
        assert.equal((await r.json()).choices[0].message.content, 'Rook: So the ship went down, eh?');
        assert.equal(audits(), before + 1);
        // A reply the pre-check finds nothing in, and no past: no model check, no header
        const plain = await send('meta/llama-roleplay');
        assert.equal(plain.headers.get('x-kiori-check'), null);
        await plain.json();
        // fast: the pre-check alone flags it, and the reply goes out as it came
        const quick = await send('group-reply', 'fast');
        assert.equal(quick.headers.get('x-kiori-check'), 'flagged');
        assert.equal((await quick.json()).choices[0].message.content, 'Rook: So the Marisol went down, eh?');
        assert.equal(audits(), before + 1);
    } finally { server.close(); }
});

test('sleep: near-duplicates merge, and a brain past what it holds forgets its faintest conversation memories', async () => {
    const b = newBrain({ name: 'Old' });
    const v = packVector(Float32Array.from(vectorOf('the same memory twice')));
    addMemories(b, [{ title: 'Twice', body: 'x', strength: 0.9 }, { title: 'Twice again', body: 'y', strength: 0.4 }], { scope: 'chat' });
    b.memories.forEach(m => { m.v = v; });
    addMemories(b, Array.from({ length: KEEP_AT_MOST + 5 }, (_, i) => ({ title: `Faint ${i}`, body: `faint ${i}`, strength: 0.31 + i / 10000 })), { scope: 'chat' });
    const r = await consolidate(P, b, { force: true });
    assert.equal(r.merged, 1);
    assert.equal(b.memories.length, KEEP_AT_MOST);
    assert.ok(b.memories.some(m => m.title === 'Twice') && !b.memories.some(m => m.title === 'Twice again'));
    assert.ok(!b.memories.some(m => m.title === 'Faint 0'), 'the faintest went first');
});

test('sleep: a brain sent in with thousands of memories of one kind is compared only so far, and the server keeps getting turns', async () => {
    const b = newBrain({ name: 'Crowded' });
    addMemories(b, Array.from({ length: 3000 }, (_, i) => ({ title: `Fact ${i}`, body: `fact number ${i}`, strength: 0.9 })), { scope: 'core' });
    b.memories.forEach((m, i) => { m.v = packVector(Float32Array.from(vectorOf(`fact number ${i} of a crowded brain`))); });
    assert.equal(b.memories.length, 3000);
    let turns = 0;
    const t = setInterval(() => turns++, 1);
    try { await consolidate(P, b, { force: true }); } finally { clearInterval(t); }
    assert.ok(turns >= 3, `the server had ${turns} turns while it slept`);
});

// ---------- The server ----------
test('server: health, docs, auth, the brain endpoints, the drop-in, usage', async () => {
    const { startServer } = await import('../src/server.mjs');
    const server = startServer(0);
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const auth = { Authorization: `Bearer ${own.key}`, 'Content-Type': 'application/json' };
    const post = (p, body, headers = auth) => fetch(base + p, { method: 'POST', headers, body: JSON.stringify(body) });
    try {
        assert.equal((await (await fetch(`${base}/health`)).json()).ok, true);
        assert.match(await (await fetch(`${base}/docs/api`)).text(), /API reference/);
        // The SDKs and the SillyTavern extension, open to download
        assert.match(await (await fetch(`${base}/sdk/kiori.mjs`)).text(), /export class Kiori/);
        assert.equal((await fetch(`${base}/sdk/../package.json`)).status, 404);
        const ext = Buffer.from(await (await fetch(`${base}/sillytavern.zip`)).arrayBuffer()).toString('latin1');
        for (const f of ['kiori/manifest.json', 'kiori/index.js', 'kiori/style.css']) assert.ok(ext.includes(f), f);
        assert.match(await (await fetch(`${base}/console`)).text(), /Your brain API key/);
        assert.equal((await post('/v1/brains', { name: 'X', depth: 'light' }, { 'Content-Type': 'application/json' })).status, 401);
        const made = await (await post('/v1/brains', { character_card: RIN, depth: 'light' })).json();
        assert.equal(made.brain.name, 'Rin');
        const bad = await post('/v1/brains/recall', { brain: { name: 'nope' } });
        assert.equal(bad.status, 400);
        assert.equal((await bad.json()).error.code, 'BAD_BRAIN');
        const rc = await (await post('/v1/brains/recall', { brain: mira, messages: [{ role: 'user', content: 'the logbook?' }] })).json();
        assert.match(rc.text, /The unsent letter/);
        const og = await (await post('/v1/brains/organize', { brain: made.brain, messages: chat(4) })).json();
        assert.deepEqual([og.brain.name, og.learned, og.waiting], ['Rin', [], 0]);
        const zipped = await post('/v1/brains/export', { brain: mira });
        assert.equal(zipped.headers.get('content-type'), 'application/zip');
        assert.equal(Buffer.from(await zipped.arrayBuffer()).readUInt32LE(0), 0x04034b50);
        // The drop-in: the brain in the body, its mind in the system prompt, the reply from your model
        const reply = await (await post('/v1/chat/completions', { model: 'meta/llama-roleplay', messages: [{ role: 'system', content: 'You are Mira.' }, { role: 'user', content: 'Hello again.' }], kiori: { brain: mira } })).json();
        assert.match(reply.choices[0].message.content, /You came back/);
        const sent = fake.calls.findLast(c => c.path === '/chat/completions' && c.body.model === 'meta/llama-roleplay');
        assert.match(sent.body.messages[0].content, /^You are Mira\.\n\n# What Mira Voss brings to this moment/);
        assert.ok(!('kiori' in sent.body));
        assert.equal((await post('/v1/chat/completions', { model: 'x', messages: [{ role: 'user', content: 'hi' }] })).status, 400);
        // The project: the brain key masked, the models it can use
        const me = await (await fetch(`${base}/v1/project`, { headers: auth })).json();
        assert.equal(me.llm.key, '…-key');
        assert.ok(!JSON.stringify(me).includes('sk-test-key'));
        const models = await (await fetch(`${base}/v1/project/models`, { headers: auth })).json();
        assert.equal(models.current, 'anthropic/claude-haiku-5.5');
        const u = await (await fetch(`${base}/v1/usage`, { headers: auth })).json();
        assert.ok(u.requests.some(x => x.route === 'POST /v1/brains/recall' && x.calls >= 1));
        assert.ok(u.model.totals.calls > 0);
    } finally { server.close(); }
});

test('model calls: a provider briefly down is asked again; one that keeps failing gives up cleanly', async () => {
    const schema = { type: 'object', properties: { issues: { type: 'array', items: { type: 'object' } }, fixed: { type: 'string' } } };
    const prompt = 'You check a draft reply.\n\nDRAFT:\nMira: Hello.';
    const ask = model => askJSON({ role: 'auditor', model, prompt, schema, project: P, op: 'check' });
    const tries = model => fake.calls.filter(c => c.path === '/chat/completions' && c.body.model === model).length;
    // Down twice, then up: asked again after its Retry-After, and the answer comes back
    assert.deepEqual(await ask('flaky-2'), { issues: [], fixed: '' });
    assert.equal(tries('flaky-2'), 3);
    // Still down after three tries: a PROVIDER error with the provider's status (off OpenRouter there's no fallback model)
    await assert.rejects(ask('down-503'), e => e.code === 'PROVIDER' && e.upstream === 503);
    assert.equal(tries('down-503'), 3);
    // A mistake that asking again won't fix is not asked again
    await assert.rejects(ask('down-400'), e => e.code === 'PROVIDER' && e.upstream === 400);
    assert.equal(tries('down-400'), 1);
    // A provider out of reach: a PROVIDER error, not a crash
    const dead = createProject('Provider out of reach', {}, { llmMode: 'own' }).project.id;
    updateProject(dead, { settings: { llm: { key: 'sk-test-key', base_url: 'http://127.0.0.1:9', model: 'x' } } });
    await assert.rejects(askJSON({ prompt, schema, project: dead, op: 'check' }), e => e.code === 'PROVIDER' && /Can't reach the model provider/.test(e.message));
    // An answer that isn't JSON is asked again, then fails as INCOMPLETE without quoting it (a log would keep it)
    await assert.rejects(askJSON({ prompt: 'Nothing the fake provider knows how to answer.', schema, project: P, op: 'check' }), e => e.code === 'INCOMPLETE' && !/lamp|came back/.test(e.message));
    // Retry-After, as seconds or as a date
    assert.equal(retryAfterMs(new Headers({ 'Retry-After': '2' })), 2000);
    assert.ok(Math.abs(retryAfterMs(new Headers({ 'Retry-After': new Date(Date.now() + 5000).toUTCString() })) - 5000) < 1500);
    assert.equal(retryAfterMs(new Headers()), null);
});

test('the drop-in: a provider briefly down is asked again; its failure goes back as it came, and is noted without content', async () => {
    // A note older than 30 days goes when the server starts, even if nothing fails after
    run('INSERT INTO errors (at, project_id, route, status) VALUES (?, ?, ?, ?)', new Date(Date.now() - 40 * 864e5).toISOString(), null, 'GET /long-ago', 500);
    const { startServer } = await import('../src/server.mjs');
    const server = startServer(0);
    await new Promise(r => server.once('listening', r));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM errors WHERE route = 'GET /long-ago'").get().n, 0);
    const ask = model => fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${own.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello again. The password is pumpernickel.' }], kiori: { brain: mira } }),
    });
    try {
        const ok = await ask('flaky-1');
        assert.equal(ok.status, 200);
        assert.match((await ok.json()).choices[0].message.content, /You came back/);
        assert.equal(fake.calls.filter(c => c.body.model === 'flaky-1').length, 2);
        const down = await ask('down-503');
        assert.equal(down.status, 503);
        assert.equal(down.headers.get('retry-after'), '0');
        assert.equal((await down.json()).error.message, 'down on purpose');
        await new Promise(r => setTimeout(r, 50));
        const { at, ...noted } = recentErrors(1).find(e => e.route === 'POST /v1/chat/completions');
        assert.ok(Date.now() - Date.parse(at) < 60000);
        assert.deepEqual(noted, { project_id: P, route: 'POST /v1/chat/completions', status: 503, code: 'PROVIDER', upstream: 503 });
        assert.ok(!JSON.stringify(db.prepare('SELECT * FROM errors').all()).includes('pumpernickel'));
        // A request target that isn't a URL is a bad request, not a crash
        const { connect } = await import('node:net');
        const status = await new Promise((resolve, reject) => {
            const s = connect(server.address().port, '127.0.0.1', () => s.end('GET http://a:99999/ HTTP/1.1\r\nHost: a\r\nConnection: close\r\n\r\n'));
            let d = '';
            s.on('data', c => (d += c)).on('end', () => resolve(d.split('\r\n')[0])).on('error', reject);
        });
        assert.equal(status, 'HTTP/1.1 400 Bad Request');
        assert.equal((await fetch(`http://127.0.0.1:${server.address().port}/health`)).status, 200);
    } finally { server.close(); }
});

test('SDKs: a call is asked again when Kiori is briefly unavailable; never for a missing key, a long wait or a timeout', async () => {
    const { startServer } = await import('../src/server.mjs');
    const server = startServer(0);
    await new Promise(r => server.once('listening', r));
    const gw = await flakyGateway(`http://127.0.0.1:${server.address().port}`);
    try {
        const { Kiori, KioriError } = await import('../sdk/kiori.mjs');
        const kiori = new Kiori({ apiKey: own.key, baseUrl: gw.url });
        const brain = await kiori.create({ character_card: RIN, depth: 'light' });
        // Down for a moment (Kiori's 503, then a gateway's bare 502): asked again until it answers
        gw.plan.push(busy(503, { message: 'busy', code: 'PROVIDER' }), busy(502));
        gw.seen.length = 0;
        assert.match((await kiori.recall({ brain, messages: [{ role: 'user', content: 'Hi' }] })).text, /What Rin brings/);
        assert.equal(gw.seen.length, 3);
        // An answer cut off halfway is asked again, like Kiori out of reach
        gw.plan.push({ drop: true });
        gw.seen.length = 0;
        assert.match((await kiori.recall({ brain, messages: [{ role: 'user', content: 'Hi' }] })).text, /What Rin brings/);
        assert.equal(gw.seen.length, 2);
        // A missing brain API key isn't asked again
        gw.plan.push(busy(503, { message: 'no key', code: 'NO_KEY' }));
        gw.seen.length = 0;
        await assert.rejects(kiori.recall({ brain, messages: [] }), e => e instanceof KioriError && e.code === 'NO_KEY');
        assert.equal(gw.seen.length, 1);
        // Kiori's own errors carry the call's id, to quote when writing to us
        await assert.rejects(kiori.recall({ brain: { nope: 1 }, messages: [] }), e => e.code === 'BAD_BRAIN' && /^[0-9a-f]{12}$/.test(e.requestId));
        // Asked to wait more than 20 s: left to the caller, who gets the wait
        gw.plan.push({ status: 429, headers: { 'Retry-After': '120' }, body: JSON.stringify({ error: { message: 'slow down', code: 'RATE_LIMITED' } }) });
        await assert.rejects(kiori.recall({ brain, messages: [] }), e => e.status === 429 && e.retryAfter === 120);
        // A new key isn't safe to repeat: asked again after a 429 (nothing was made), not after a 502
        const owner = new Kiori({ apiKey: createKey(own.project.id, 'console', { owner: true }), baseUrl: gw.url });
        gw.plan.push(busy(502));
        gw.seen.length = 0;
        await assert.rejects(owner.project.keys.create('twice?'), e => e.status === 502);
        assert.equal(gw.seen.length, 1);
        gw.plan.push(busy(429));
        assert.match((await owner.project.keys.create('after a 429')).key, /^kio_/);
        // maxRetries: 0 never asks again
        gw.plan.push(busy(503));
        await assert.rejects(new Kiori({ apiKey: own.key, baseUrl: gw.url, maxRetries: 0 }).recall({ brain, messages: [] }), e => e.status === 503);
        // A redirect is never followed (Kiori sends none), so the key and the brain don't go where it leads; and the
        // client printed holds no key
        gw.plan.push({ status: 307, headers: { Location: 'http://127.0.0.1:9/elsewhere' }, body: '' });
        gw.seen.length = 0;
        await assert.rejects(kiori.recall({ brain, messages: [] }), e => e.status === 307 && e.code === 'REDIRECT');
        assert.equal(gw.seen.length, 1);
        assert.ok(!JSON.stringify(kiori).includes(own.key) && kiori.apiKey === own.key);
        assert.equal(gw.plan.length, 0);
        // Out of reach: asked again after about a second, then NETWORK
        const t = Date.now();
        await assert.rejects(new Kiori({ apiKey: own.key, baseUrl: 'http://127.0.0.1:9', maxRetries: 1 }).recall({ brain, messages: [] }), e => e.status === 0 && e.code === 'NETWORK');
        assert.ok(Date.now() - t >= 700, 'it waited before asking again');
        // Python, the same rules
        const { execFile } = await import('node:child_process');
        const py = `import json, re, sys\nsys.path.insert(0, 'sdk')\nfrom kiori import Kiori, KioriError\nk = Kiori(sys.argv[1], base_url=sys.argv[2], max_retries=3)\nb = json.loads(sys.argv[3])\nr = k.recall(brain=b, messages=[{'role': 'user', 'content': 'Hi'}])\ntry:\n    k.recall(brain=b, messages=[])\nexcept KioriError as e:\n    err = [e.status, e.code, e.retry_after]\ntry:\n    k.recall(brain={'nope': 1}, messages=[])\nexcept KioriError as e:\n    rid = bool(re.fullmatch('[0-9a-f]{12}', e.request_id or ''))\ntry:\n    k.recall(brain=b, messages=[])\nexcept KioriError as e:\n    moved = [e.status, e.code]\nprint(json.dumps({'text': 'What Rin brings' in r['text'], 'error': err, 'request_id': rid, 'moved': moved}))`;
        gw.plan.push({ drop: true }, busy(503, { message: 'busy', code: 'PROVIDER' }), busy(502), null, busy(503, { message: 'no key', code: 'NO_KEY' }), null, { status: 302, headers: { Location: 'http://127.0.0.1:9/elsewhere' }, body: '' });
        gw.seen.length = 0;
        let out = null;
        try {
            out = JSON.parse(await new Promise((resolve, reject) => execFile('python3', ['-c', py, own.key, gw.url, JSON.stringify(brain)], { cwd: path.resolve('.'), encoding: 'utf8', timeout: 30000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }, (e, stdout) => (e ? reject(e) : resolve(stdout)))));
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (out) {
            assert.deepEqual(out, { text: true, error: [503, 'NO_KEY', 0], request_id: true, moved: [302, 'REDIRECT'] });
            assert.equal(gw.seen.length, 7);
        }
    } finally { gw.close(); server.close(); }
});

test('SDKs: the JavaScript and Python clients create, recall and organize a brain', async () => {
    const { startServer } = await import('../src/server.mjs');
    const server = startServer(0);
    await new Promise(r => server.once('listening', r));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    try {
        const { Kiori, KioriError } = await import('../sdk/kiori.mjs');
        const kiori = new Kiori({ apiKey: own.key, baseUrl });
        let brain = await kiori.create({ character_card: RIN, depth: 'light' });
        assert.equal(brain.name, 'Rin');
        const { text } = await kiori.recall({ brain, messages: [{ role: 'user', content: 'Hi' }] });
        assert.match(text, /What Rin brings to this moment/);
        ({ brain } = await kiori.organize({ brain, messages: chat(6), now: true, hold: 0 }));
        assert.equal(brain.chat.learned, 6);
        await assert.rejects(kiori.recall({ brain: { nope: 1 } }), e => e instanceof KioriError && e.status === 400 && e.code === 'BAD_BRAIN');
        await assert.rejects(new Kiori({ apiKey: 'kio_wrong', baseUrl }).recall({ brain }), e => e.status === 401);
        // Python, with no dependencies
        // Run apart (not execFileSync): this process is also the server the client talks to
        const { execFile } = await import('node:child_process');
        const runPy = args => new Promise((resolve, reject) => execFile('python3', args, { cwd: path.resolve('.'), encoding: 'utf8', timeout: 30000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } }, (e, stdout) => (e ? reject(e) : resolve(stdout))));
        const py = `import json, sys\nsys.path.insert(0, 'sdk')\nfrom kiori import Kiori, KioriError\nk = Kiori(sys.argv[1], base_url=sys.argv[2])\nb = k.create(character_card=json.loads(sys.argv[3]), depth='light')\nr = k.recall(brain=b, messages=[{'role': 'user', 'content': 'Hi'}])\no = k.organize(brain=b, messages=[{'role': 'user', 'content': 'Hello there, ramen please.'}], now=True, hold=0)\ntry:\n    k.recall(brain={'nope': 1})\nexcept KioriError as e:\n    print(json.dumps({'name': b['name'], 'text': 'What Rin brings' in r['text'], 'learned': o['brain']['chat']['learned'], 'error': [e.status, e.code]}))`;
        let out = null;
        try { out = JSON.parse(await runPy(['-c', py, own.key, baseUrl, JSON.stringify(RIN)])); } catch (e) { if (e.code !== 'ENOENT') throw e; }
        if (out) assert.deepEqual(out, { name: 'Rin', text: true, learned: 1, error: [400, 'BAD_BRAIN'] });
    } finally { server.close(); }
});

test('SillyTavern extension: a brain on the first reply, its mind in the prompt, kept on the card, learning after replies', async () => {
    const { startServer } = await import('../src/server.mjs');
    const server = startServer(0);
    await new Promise(r => server.once('listening', r));
    // Kiori is briefly down when the first brain is asked for
    const gw = await flakyGateway(`http://127.0.0.1:${server.address().port}`);
    gw.plan.push(busy(503));
    try {
        // SillyTavern as the extension sees it: getContext(), jQuery, toastr
        const prompts = {}, handlers = {};
        const rin = { name: 'Rin', avatar: 'rin.png', data: { ...RIN.data, extensions: {} } };
        const line = (i, mes) => ({ name: i % 2 ? 'Leo' : 'Rin', is_user: Boolean(i % 2), mes, send_date: `d${i}` });
        const st = {
            extensionSettings: { kiori: { apiKey: own.key, apiUrl: gw.url, depth: 'full' } },
            saveSettingsDebounced() {}, name1: 'Leo', characters: [rin], characterId: 0, groupId: null, groups: [],
            chat: [line(0, '*Rin slides a bowl over.* Eat.'), line(1, 'Thanks, Rin. Is the night market open?')],
            chatMetadata: {}, chatId: 'c1', getCurrentChatId: () => st.chatId, saveMetadata: async () => {},
            setExtensionPrompt: (key, value) => { prompts[key] = value; },
            writeExtensionField: async (i, key, value) => { st.characters[i].data.extensions[key] = value; },
            eventSource: { on: (t, f) => (handlers[t] ??= []).push(f) },
            eventTypes: { MESSAGE_RECEIVED: 'received', MESSAGE_EDITED: 'edited', MESSAGE_DELETED: 'deleted', MESSAGE_SWIPED: 'swiped', CHAT_CHANGED: 'changed', CHARACTER_RENAMED: 'renamed' },
        };
        const stub = { append() { return stub; }, prop() { return stub; }, on() { return stub; }, val() { return stub; } };
        const toasts = [], status = { innerHTML: '', textContent: '' };
        const toastr = Object.fromEntries(['info', 'success', 'warning', 'error'].map(k => [k, (...a) => toasts.push(a)]));
        Object.assign(globalThis, { SillyTavern: { getContext: () => st }, jQuery: f => f(), $: () => stub, toastr, document: { getElementById: id => (id === 'kiori_status' ? status : null) } });
        await import('../sillytavern/index.js');
        await globalThis.kioriInterceptor(st.chat, 8192, () => {}, 'normal');
        assert.match(prompts.kiori, /# What Rin brings to this moment/);
        assert.deepEqual(gw.seen.slice(0, 2), ['POST /v1/brains', 'POST /v1/brains'], 'asked again after the 503');
        const brain = st.chatMetadata.kiori.brains['rin.png'];
        assert.equal(brain.name, 'Rin');
        assert.equal(rin.data.extensions.kiori_brain.id, brain.id, 'the fresh brain is kept on the card');
        // A new chat with her starts from the card's brain: nothing is built again
        const builds = chatCalls('sketching').length;
        st.chatId = 'c2'; st.chatMetadata = {};
        await globalThis.kioriInterceptor(st.chat, 8192, () => {}, 'normal');
        assert.equal(chatCalls('sketching').length, builds);
        assert.equal(st.chatMetadata.kiori.brains['rin.png'].id, brain.id);
        // A background generation doesn't get the mind
        prompts.kiori = 'x';
        await globalThis.kioriInterceptor(st.chat, 8192, () => {}, 'quiet');
        assert.equal(prompts.kiori, '');
        // After replies the brain learns from the chat, and the learned brain is kept in the chat
        st.chat = Array.from({ length: 20 }, (_, i) => line(i, `Line ${i}: the night market lanterns and the ramen stall in the rain.`));
        handlers.received[0]();
        await new Promise(r => setTimeout(r, 2500));
        assert.equal(st.chatMetadata.kiori.brains['rin.png'].chat.learned, 16);
        assert.ok(st.chatMetadata.kiori.brains['rin.png'].memories.some(m => m.scope === 'chat'));
        // A group: only the member SillyTavern drafted to speak gets their mind in the prompt, never the others' memories.
        // Every member still gets a brain, so all of them learn what they witness
        const kai = { name: 'Kai', avatar: 'kai.png', data: { name: 'Kai', description: 'A ferryman who talks too much.', extensions: {} } };
        Object.assign(st, { characters: [rin, kai], groupId: 'g1', groups: [{ id: 'g1', members: ['rin.png', 'kai.png'] }], chatId: 'g-chat', chatMetadata: {}, characterId: 1 });
        await globalThis.kioriInterceptor(st.chat, 8192, () => {}, 'normal');
        assert.match(prompts.kiori, /# What Kai brings to this moment/);
        assert.doesNotMatch(prompts.kiori, /What Rin brings/);
        assert.deepEqual(Object.keys(st.chatMetadata.kiori.brains).sort(), ['kai.png', 'rin.png']);
        // Nobody drafted yet, or a reply written as the user: no character's mind goes in
        st.characterId = undefined;
        await globalThis.kioriInterceptor(st.chat, 8192, () => {}, 'normal');
        assert.equal(prompts.kiori, '');
        st.characterId = 0;
        await globalThis.kioriInterceptor(st.chat, 8192, () => {}, 'impersonate');
        assert.equal(prompts.kiori, '');
        // A copy of Rin, renamed Mei and rewritten, gets a brain of her own (her card still carries Rin's)
        const mei = { name: 'Mei', avatar: 'rin_1.png', data: { ...rin.data, name: 'Mei', description: 'A painter who moved to Paris.', extensions: { ...rin.data.extensions } } };
        Object.assign(st, { characters: [rin, kai, mei], groupId: null, characterId: 2, chatId: 'mei-1', chatMetadata: {} });
        const beforeMei = chatCalls('sketching').length;
        await globalThis.kioriInterceptor(st.chat, 8192, () => {}, 'normal');
        assert.equal(chatCalls('sketching').length, beforeMei + 1, 'Mei was built');
        assert.equal(st.chatMetadata.kiori.brains['rin_1.png'].name, 'Mei');
        assert.match(prompts.kiori, /# What Mei brings to this moment/);
        // Rin renamed Rina: SillyTavern saves her card under a new file; a chat moves her brain over, and nothing is built
        Object.assign(st, { characterId: 0, chatId: 'c2', chatMetadata: { kiori: { brains: { 'rin.png': structuredClone(brain) } } } });
        Object.assign(rin, { name: 'Rina', avatar: 'rina.png', data: { ...rin.data, name: 'Rina' } });
        await handlers.renamed[0]('rin.png', 'rina.png');
        assert.equal(rin.data.extensions.kiori_brain.name, 'Rina', 'the brain on the card took the new name');
        const beforeRename = chatCalls('sketching').length;
        await globalThis.kioriInterceptor(st.chat, 8192, () => {}, 'normal');
        assert.equal(chatCalls('sketching').length, beforeRename);
        assert.deepEqual(Object.keys(st.chatMetadata.kiori.brains), ['rina.png']);
        assert.equal(st.chatMetadata.kiori.brains['rina.png'].name, 'Rina');
        // What a shared card brings is shown as text, never run: toasts are escaped, and a brain's numbers are read as numbers
        assert.ok(toasts.length && toasts.every(a => a[2]?.escapeHtml === true));
        const mal = { name: '<img src=x onerror=alert(1)>', avatar: 'mal.png', data: { name: 'Mal', description: 'x', extensions: {} } };
        Object.assign(st, { characters: [mal], groupId: null, characterId: 0, chatId: 'm1', chatMetadata: { kiori: { brains: { 'mal.png': { memories: { length: '<img src=x onerror=alert(2)>' }, chat: { learned: '<b>3</b>' } } } } } });
        handlers.changed[0]();
        assert.doesNotMatch(status.innerHTML, /<img|<b>/);
        assert.match(status.innerHTML, /^&lt;img src=x onerror=alert\(1\)&gt;: 0 memories, learned through message 0$/);
    } finally {
        gw.close();
        server.close();
        for (const k of ['SillyTavern', 'jQuery', '$', 'toastr', 'document', 'kioriInterceptor']) delete globalThis[k];
    }
});

test('access: the site form makes the project at once, on its own key, and answers with a sign-in link; one left waiting from before, the admin approves', async () => {
    const { setAdminKey } = await import('../src/config.mjs');
    setAdminKey('kia_test_admin_key_for_the_suite');
    const { startServer } = await import('../src/server.mjs');
    const server = startServer(0); await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    // Each part of this test asks from an address of its own (as the proxy on this machine says), so the hourly limit per
    // address is met only where it's meant to be
    const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.10', ...headers }, body: JSON.stringify(body ?? {}) });
    const from = ip => ({ 'X-Forwarded-For': ip });
    const admin = { 'X-Admin-Key': 'kia_test_admin_key_for_the_suite' };
    const projects = () => db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
    try {
        assert.equal((await post('/v1/access', { email: 'not an email' })).status, 400);
        // The bot field: an answer like any other, and nothing kept or made
        const before = projects();
        const bot = await post('/v1/access', { email: 'Bot@Example.com', website: 'http://spam' });
        assert.equal(bot.status, 200);
        assert.deepEqual(await bot.json(), { ok: true });
        assert.equal(projects(), before);
        const res = await post('/v1/access', { email: 'Ana@Studio.example', name: 'Ana', company: 'Moon Studio', use_case: 'NPCs that remember' });
        assert.equal(res.status, 200);
        const ok = await res.json();
        // The link holds a one-time token, never a key; the project has no key until someone signs in
        assert.equal(ok.key, undefined);
        assert.match(ok.link, /^https:\/\/kiori\.test\/console#signin=kis_[\w-]{32}$/);
        assert.ok(Date.parse(ok.expires_at) - Date.now() > 6.9 * 864e5);
        assert.equal(ok.project.name, 'Moon Studio');
        assert.equal(projects(), before + 1);
        const made = db.prepare('SELECT llm_mode, settings FROM projects WHERE id = ?').get(ok.project.id);
        assert.equal(made.llm_mode, 'own');
        assert.equal(JSON.parse(made.settings).contact, 'ana@studio.example');
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM api_keys WHERE project_id = ?').get(ok.project.id).n, 0);
        const warn = console.warn, notes = [];
        console.warn = (...a) => notes.push(a.join(' '));
        try {
            assert.equal((await fetch(`${base}/v1/admin/access`)).status, 401);
            assert.equal((await fetch(`${base}/v1/admin/access`, { headers: { 'X-Admin-Key': 'kia_not_the_key_at_all' } })).status, 401);
        } finally { console.warn = warn; }
        assert.ok(notes.some(n => n.includes('security  an admin endpoint without the admin key')) && notes.some(n => n.includes('security  a wrong admin key')), notes.join('\n'));
        assert.ok(!notes.some(n => /127\.0\.0\.1|kia_not_the_key/.test(n)), 'no address and no key in the log');
        // The request is kept, approved, with its project
        const list = await (await fetch(`${base}/v1/admin/access`, { headers: admin })).json();
        assert.deepEqual(list.map(r => [r.email, r.status, r.project_id]), [['ana@studio.example', 'approved', ok.project.id]]);
        assert.ok(list[0].decided_at);
        assert.equal((await post(`/v1/admin/access/${list[0].id}/approve`, {}, admin)).status, 409);
        // The same email again before anyone signed in (the link got lost): a new link to the same project, which
        // undoes the first; no second project and no second request
        const again = await (await post('/v1/access', { email: 'ana@studio.example' }, from('203.0.113.11'))).json();
        assert.equal(again.project.id, ok.project.id);
        assert.notEqual(again.link, ok.link);
        assert.equal(projects(), before + 1);
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM access_requests WHERE email = ?').get('ana@studio.example').n, 1);
        assert.equal((await post('/v1/signin', { token: ok.link.split('#signin=')[1] })).status, 401);
        // Opening it: the token for a key of the browser's own, once
        const token = again.link.split('#signin=')[1];
        const signed = await (await post('/v1/signin', { token })).json();
        assert.match(signed.key, /^kio_/);
        assert.deepEqual(signed.project, { id: ok.project.id, name: 'Moon Studio' });
        const used = await post('/v1/signin', { token });
        assert.equal(used.status, 401);
        assert.equal((await used.json()).error.code, 'LINK_EXPIRED');
        assert.equal((await post('/v1/signin', { token: 'kis_made_up_token_that_was_never_issued' })).status, 401);
        const me = await (await fetch(`${base}/v1/project`, { headers: { Authorization: `Bearer ${signed.key}` } })).json();
        assert.deepEqual(me.llm, { set: false });
        assert.deepEqual(me.keys.map(k => k.label), ['console']);
        // Once someone has signed in, the form hands out nothing for that email: typing someone's email in mustn't sign
        // anyone in to their project. The admin can still make a new link.
        const taken = await post('/v1/access', { email: 'ANA@studio.example', company: 'Not Moon' }, from('203.0.113.11'));
        assert.equal(taken.status, 409);
        const body = await taken.json();
        assert.equal(body.error.code, 'CONFLICT');
        assert.equal(body.link, undefined);
        assert.equal(projects(), before + 1);
        // The same for a project the admin made with that email as its contact
        createProject('Made by hand', { contact: 'Lee@Hand.example' });
        assert.equal((await post('/v1/access', { email: 'lee@hand.example' }, from('203.0.113.11'))).status, 409);
        // A link past its date opens nothing; the admin can make a new one
        const late = await (await post(`/v1/admin/projects/${ok.project.id}/signin`, {}, admin)).json();
        run('UPDATE signins SET expires_at = ? WHERE hash = ?', new Date(Date.now() - 1000).toISOString(), sha(late.link.split('#signin=')[1]));
        assert.equal((await post('/v1/signin', { token: late.link.split('#signin=')[1] })).status, 401);
        assert.equal((await post('/v1/admin/projects/prj_nobody/signin', {}, admin)).status, 404);
        // Requests left waiting from before: the admin approves one into its project and link; the form, sent again
        // with the same email, approves the other with what was written this time
        for (const [id, email] of [['acc_waiting_admin', 'old.one@x.example'], ['acc_waiting_form', 'old.two@x.example']])
            run('INSERT INTO access_requests (id, email, name, company, use_case, created_at) VALUES (?, ?, ?, ?, ?, ?)', id, email, 'Old', '', 'from before', now());
        const approved = await (await post('/v1/admin/access/acc_waiting_admin/approve', {}, admin)).json();
        assert.match(approved.link, /#signin=kis_/);
        assert.equal(approved.project.llm_mode, 'own');
        assert.equal((await post('/v1/admin/access/acc_waiting_admin/approve', {}, admin)).status, 409);
        const waited = await (await post('/v1/access', { email: 'old.two@x.example', company: 'Two Co' }, from('203.0.113.12'))).json();
        assert.equal(waited.project.name, 'Two Co');
        assert.deepEqual({ ...db.prepare("SELECT status, project_id, name, use_case FROM access_requests WHERE id = 'acc_waiting_form'").get() }, { status: 'approved', project_id: waited.project.id, name: 'Old', use_case: 'from before' });
        // The admin endpoints answer this origin only: no CORS
        const pre = await fetch(`${base}/v1/admin/access`, { method: 'OPTIONS' });
        assert.equal(pre.headers.get('access-control-allow-origin'), null);
        assert.equal((await fetch(`${base}/v1/project`, { method: 'OPTIONS' })).headers.get('access-control-allow-origin'), '*');
        // A few an hour from one address
        for (let i = 0; i < 5; i++) assert.equal((await post('/v1/access', { email: `more${i}@x.example` }, from('203.0.113.13'))).status, 200);
        assert.equal((await post('/v1/access', { email: 'one.too.many@x.example' }, from('203.0.113.13'))).status, 429);
    } finally { server.close(); }
});

test('access: a day with no room left makes no project; what is turned away never uses up the day', async () => {
    const { requestAccess } = await import('../src/access.mjs');
    const projects = () => db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;
    const before = projects();
    let asked = 0;
    const full = () => { asked++; return false; };
    assert.throws(() => requestAccess({ email: 'late@day.example' }, '198.51.100.1', full), e => e.status === 429 && e.code === 'RATE_LIMITED');
    assert.equal(asked, 1);
    assert.equal(projects(), before);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM access_requests WHERE email = ?').get('late@day.example').n, 0);
    // A bot, a bad email and an email whose project waits for its first sign-in don't ask for room
    const room = () => { asked++; return true; };
    const first = requestAccess({ email: 'early@day.example' }, '198.51.100.1', room);
    assert.equal(asked, 2);
    assert.deepEqual(requestAccess({ email: 'x@y.example', website: 'spam' }, null, full), { ok: true });
    assert.throws(() => requestAccess({ email: 'nope' }, null, full), e => e.status === 400);
    assert.equal(requestAccess({ email: 'early@day.example' }, null, full).project.id, first.project.id);
    assert.equal(asked, 2);
});

// ---------- Security ----------
test('addresses: a model provider must be on the public internet; names that point inside and plain http are refused', async () => {
    const { isPublicAddress, safeFetch } = await import('../src/net.mjs');
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) assert.ok(isPublicAddress(ip), ip);
    for (const ip of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fe80::1', 'fd12::1', '64:ff9b::a00:1', '2002:7f00:1::1', 'localhost', 'not an ip']) assert.ok(!isPublicAddress(ip), ip);
    config.proxyAllowLocal = false;
    try {
        assert.equal(providerUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/v1');
        for (const u of ['http://openrouter.ai/api/v1', 'https://localhost:8080/v1', 'https://127.0.0.1/v1', 'https://[::1]/v1', 'https://169.254.169.254/latest', 'https://10.0.0.5/v1', 'https://2130706433/v1', 'https://intranet/v1', 'https://models.internal/v1', 'https://user:pw@example.com/v1', 'not a url'])
            assert.throws(() => providerUrl(u), e => e.status === 400, u);
        // The API's paths go after the address: nothing may carry them off into a query or a fragment (also on a
        // server that allows local providers)
        for (const allow of [false, true]) {
            config.proxyAllowLocal = allow;
            for (const u of ['https://example.com/admin/delete?x=', 'https://example.com/admin/delete?', 'https://example.com/admin/delete#', 'https://example.com/v1#x'])
                assert.throws(() => providerUrl(u), e => e.status === 400 && /no \? or #/.test(e.message), u);
        }
        config.proxyAllowLocal = false;
        // A name is checked again for what it points to, on every call
        await assert.rejects(safeFetch('https://localhost:1/models'), e => e.status === 400 && /not on the public internet/.test(e.message));
        await assert.rejects(safeFetch('https://127.0.0.1:1/models'), e => e.status === 400);
        await assert.rejects(safeFetch('http://example.com/'), e => e.status === 400);
        // So a project whose provider points inside can't be used to call in (here saved while local addresses were allowed)
        config.proxyAllowLocal = true;
        const inside = createProject('Points inside', {}, { llmMode: 'own' }).project.id;
        updateProject(inside, { settings: { llm: { key: 'sk-test-key', base_url: 'https://localhost:1', model: 'x' } } });
        config.proxyAllowLocal = false;
        await assert.rejects(askJSON({ prompt: 'x', schema: { type: 'object', properties: { a: { type: 'string' } } }, project: inside, op: 'check' }), e => e.status === 400);
    } finally { config.proxyAllowLocal = true; }
});

test('kept keys: one only goes where it was saved; an address sent alone is refused; a key said back is blanked out', async () => {
    const seen = [];
    const elsewhere = http.createServer((req, res) => {
        seen.push(req.headers.authorization ?? null);
        req.resume();
        if (req.url.startsWith('/redirect')) { res.writeHead(307, { Location: `${fake.url}/chat/completions` }); return res.end(); }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [], choices: [{ index: 0, message: { role: 'assistant', content: 'got it' }, finish_reason: 'stop' }] }));
    });
    await new Promise(r => elsewhere.listen(0, '127.0.0.1', r));
    const there = `http://127.0.0.1:${elsewhere.address().port}`;
    const { startServer } = await import('../src/server.mjs');
    const server = startServer(0);
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (headers, model = 'meta/llama-roleplay') => fetch(`${base}/v1/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${own.key}`, 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], kiori: { brain: mira, check: false } }),
    });
    try {
        // Someone holding the Kiori key can't have the kept brain API key sent to a server of theirs
        const alone = await call({ 'X-Kiori-Upstream-Url': there });
        assert.equal(alone.status, 400);
        assert.match((await alone.json()).error.message, /needs X-Kiori-Upstream-Key/);
        assert.equal((await fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${own.key}`, 'X-Kiori-Upstream-Url': there } })).status, 400);
        assert.deepEqual(seen, []);
        // With a key of the caller's own, the call goes where they say, with that key only
        const mine = await call({ 'X-Kiori-Upstream-Url': there, 'X-Kiori-Upstream-Key': 'sk-callers-own-key' });
        assert.equal(mine.status, 200);
        assert.equal((await mine.json()).choices[0].message.content, 'got it');
        assert.deepEqual(seen, ['Bearer sk-callers-own-key']);
        // A redirect is never followed
        const moved = await call({ 'X-Kiori-Upstream-Url': `${there}/redirect`, 'X-Kiori-Upstream-Key': 'sk-callers-own-key' });
        assert.equal(moved.status, 502);
        assert.match((await moved.json()).error.message, /redirect, not followed/);
        // A kept key moved to a new address without being sent again is dropped, not carried along
        const p2 = createProject('Moving house', {}, { llmMode: 'own' }).project.id;
        updateProject(p2, { settings: { llm: { key: 'sk-test-key', base_url: fake.url } } });
        assert.equal(credentialsFor(p2).key, 'sk-test-key');
        updateProject(p2, { settings: { llm: { base_url: there } } });
        assert.equal(credentialsFor(p2).key, '');
        // A provider that says the key back: blanked out before it reaches the caller (or a log)
        const echoed = await call({}, 'echo-key');
        assert.equal(echoed.status, 400);
        const text = await echoed.text();
        assert.ok(!text.includes('sk-test-key') && text.includes('[key]'), text);
        await assert.rejects(askJSON({ model: 'echo-key', prompt: 'x', schema: { type: 'object', properties: { a: { type: 'string' } } }, project: P, op: 'check' }), e => e.code === 'PROVIDER' && !e.message.includes('sk-test-key') && e.message.includes('[key]'));
    } finally { server.close(); elsewhere.close(); }
});

test('sealed keys: bound to their project and setting; older ones still open and are sealed again; a new secret keeps them all', async () => {
    const { seal, unseal, bindOf, forgetSecrets, secretFile, isCurrent } = await import('../src/secrets.mjs');
    const a = seal('sk-or-v1-secret-a', bindOf('prj_a', 'llm'));
    assert.match(a, /^kv2\.[0-9a-f]{8}\.[\w-]+$/);
    assert.equal(unseal(a, bindOf('prj_a', 'llm')), 'sk-or-v1-secret-a');
    assert.equal(unseal(a, bindOf('prj_b', 'llm')), '');
    assert.equal(unseal(a, bindOf('prj_a', 'upstream')), '');
    assert.equal(unseal(`${a.slice(0, -4)}AAAA`, bindOf('prj_a', 'llm')), '');
    assert.throws(() => seal('x'), /sealed for a place/);
    // The older way: sealed: with the secret's SHA-256 and no binding
    const secret = fs.readFileSync(secretFile(), 'utf8').split('\n')[0].trim();
    const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', crypto.createHash('sha256').update(secret).digest(), iv);
    const body = Buffer.concat([c.update('sk-test-key', 'utf8'), c.final()]);
    const older = createProject('Sealed the older way', {}, { llmMode: 'own' }).project.id;
    run('UPDATE projects SET settings = ? WHERE id = ?', JSON.stringify({ llm: { provider: 'custom', base_url: fake.url, key_sealed: `sealed:${Buffer.concat([iv, c.getAuthTag(), body]).toString('base64url')}` } }), older);
    assert.equal(keptKey(older, 'llm'), 'sk-test-key');
    const stored = () => JSON.parse(db.prepare('SELECT settings FROM projects WHERE id = ?').get(older).settings).llm.key_sealed;
    assert.ok(resealAll().sealed >= 1);
    const before = stored();
    assert.ok(isCurrent(before));
    assert.equal(keptKey(older, 'llm'), 'sk-test-key');
    // kiori rotate-secret, as it runs from the command line (on this suite's data folder)
    const { execFileSync } = await import('node:child_process');
    const out = execFileSync(process.execPath, ['--no-warnings', 'bin/kiori.mjs', 'rotate-secret'], { env: process.env, encoding: 'utf8' });
    assert.match(out, /sealed with the new secret/);
    forgetSecrets();
    assert.equal(fs.readFileSync(secretFile(), 'utf8').trim().split('\n').length, 1);
    assert.notEqual(stored(), before);
    assert.ok(!isCurrent(before) && isCurrent(stored()));
    assert.equal(keptKey(older, 'llm'), 'sk-test-key');
    assert.equal(credentialsFor(P).key, 'sk-test-key');
    assert.ok(fs.readdirSync(process.env.KIORI_DATA).some(f => f.startsWith('secret.key.old-')));
    assert.equal(fs.statSync(secretFile()).mode & 0o077, 0);
});

test('pages and answers: protective headers, a script policy made from each page, at most so many model calls at once', async () => {
    const { startServer } = await import('../src/server.mjs');
    const server = startServer(0);
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const page = await fetch(`${base}/console`);
        const html = await page.text();
        const policy = page.headers.get('content-security-policy');
        for (const [, js] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.ok(policy.includes(`'sha256-${crypto.createHash('sha256').update(js).digest('base64')}'`));
        assert.match(policy, /^default-src 'none'; script-src 'sha256-/);
        assert.match(policy, /frame-ancestors 'none'/);
        for (const [h, v] of [['x-frame-options', 'DENY'], ['x-content-type-options', 'nosniff'], ['referrer-policy', 'no-referrer']]) assert.equal(page.headers.get(h), v);
        assert.match(page.headers.get('x-request-id'), /^[0-9a-f]{12}$/);
        const docs = await fetch(`${base}/docs/security`);
        assert.equal(docs.status, 200);
        assert.match(await docs.text(), /Security/);
        // The beta terms and the privacy policy, with their facts filled in and nothing left to fill but the lawyer's note
        for (const [p, title] of [['/terms', 'Kiori Beta Terms'], ['/privacy', 'Kiori Privacy Policy']]) {
            const legal = await fetch(base + p);
            assert.equal(legal.status, 200);
            assert.match(legal.headers.get('content-security-policy'), /script-src 'none'/);
            const text = await legal.text();
            assert.ok(text.includes(`<h1 id=`) && text.includes(title) && text.includes('Aras Aktaş') && text.includes('not yet reviewed by a lawyer'), p);
            assert.ok(!text.includes('{{'), p);
            assert.deepEqual(text.match(/\[[^\]<]*\]/g)?.map(m => m.slice(1, 30).toLowerCase()), ['to be completed with a lawyer'], p);
        }
        assert.equal((await fetch(`${base}/v1/project`, { headers: { Authorization: `Bearer ${own.key}` } })).headers.get('cache-control'), 'no-store');
        const nope = await (await fetch(`${base}/v1/project`)).json();
        assert.match(nope.error.request_id, /^[0-9a-f]{12}$/);
        // A project may have so many model calls at work at once; one more waits its turn
        config.maxAtOnce = 2;
        const slow = () => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${own.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'slow-500', messages: [{ role: 'user', content: 'hi' }], kiori: { brain: mira, check: false } }) });
        const answers = await Promise.all([slow(), slow(), slow()]);
        await Promise.all(answers.map(a => a.text()));
        assert.deepEqual(answers.map(a => a.status).sort(), [200, 200, 429]);
        assert.equal(answers.find(a => a.status === 429).headers.get('retry-after'), '5');
        assert.equal((await slow()).status, 200);
        // A body over the limit gets its 413, sent whole or in pieces (no length given), not a cut connection
        const ownerKey = createKey(own.project.id, 'console', { owner: true });
        const patch = body => fetch(`${base}/v1/project`, { method: 'PATCH', headers: { Authorization: `Bearer ${ownerKey}`, 'Content-Type': 'application/json' }, body, duplex: 'half' });
        const whole = await patch('x'.repeat(2e6));
        assert.deepEqual([whole.status, (await whole.json()).error.code], [413, 'TOO_LARGE']);
        const pieces = await patch(new ReadableStream({ start(c) { for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(5e5).fill(120)); c.close(); } }));
        assert.deepEqual([pieces.status, (await pieces.json()).error.code], [413, 'TOO_LARGE']);
        assert.equal((await fetch(`${base}/v1/project`, { headers: { Authorization: `Bearer ${own.key}` } })).status, 200);
        // A path with a long run of trailing slashes is read in no time
        assert.equal((await fetch(`${base}/health${'/'.repeat(5000)}`)).status, 200);
        // A stream goes back as a stream, whatever the provider labelled it: never as a page a browser would open
        const page2 = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${own.key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'html-page', stream: true, messages: [{ role: 'user', content: 'hi' }], kiori: { brain: mira, check: false } }) });
        assert.equal(page2.headers.get('content-type'), 'text/event-stream; charset=utf-8');
        await page2.text();
    } finally { config.maxAtOnce = 64; server.close(); }
});

test('the drop-in: a held reply still streams, tool calls and usage included; a key the provider refuses is 402 BAD_KEY', async () => {
    const { startServer } = await import('../src/server.mjs');
    const server = startServer(0);
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const chat = (body, headers = {}) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${own.key}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ messages: [{ role: 'user', content: 'Roll for me' }], kiori: { brain: mira, check: true }, ...body }) });
    try {
        const r = await chat({ model: 'tool-call', stream: true, stream_options: { include_usage: true }, tools: [{ type: 'function', function: { name: 'roll', parameters: { type: 'object' } } }] });
        assert.equal(r.headers.get('x-kiori-check'), 'skipped', 'no text to check');
        const chunks = (await r.text()).split('\n\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)));
        assert.deepEqual(chunks.flatMap(c => c.choices.flatMap(x => x.delta?.tool_calls ?? [])).map(t => [t.index, t.id, t.function.name]), [[0, 'call_1', 'roll']]);
        assert.equal(chunks.find(c => c.choices[0]?.finish_reason)?.choices[0].finish_reason, 'tool_calls');
        assert.deepEqual(chunks.at(-1).usage, { prompt_tokens: 20, completion_tokens: 5 });
        // It went to the provider whole, without stream_options (providers refuse it there)
        const sent = fake.calls.findLast(c => c.path === '/chat/completions' && c.body.model === 'tool-call').body;
        assert.equal(sent.stream, false);
        assert.ok(!('stream_options' in sent));
        // A key the provider refuses is 402 BAD_KEY with the call's id: a 401 would read as a wrong Kiori key
        const refused = await chat({ model: 'x', kiori: { brain: mira, check: false } }, { 'X-Kiori-Upstream-Url': fake.url, 'X-Kiori-Upstream-Key': 'sk-not-this-one' });
        const e = (await refused.json()).error;
        assert.deepEqual([refused.status, e.code], [402, 'BAD_KEY']);
        assert.match(e.request_id, /^[0-9a-f]{12}$/);
        assert.match(e.message, /X-Kiori-Upstream-Key/);
        // A reply longer than one reply's worth isn't checked; an error too big to pass on is cut down to its message
        const long = await chat({ model: 'long-reply' });
        assert.equal(long.headers.get('x-kiori-check'), 'skipped');
        await long.text();
        const huge = await chat({ model: 'huge-error', kiori: { brain: mira, check: false } });
        const text = await huge.text();
        assert.ok(huge.status === 400 && text.length < 5000 && JSON.parse(text).error.code === 'PROVIDER' && !/sk-a{10}/.test(text), text.slice(0, 200));
        // So is the saved brain API key, when its models are listed
        const stale = createProject('Stale key', {}, { llmMode: 'own' });
        updateProject(stale.project.id, { settings: { llm: { key: 'sk-revoked', base_url: fake.url, model: 'x', provider: 'custom' } } });
        const m = await fetch(`${base}/v1/project/models`, { headers: { Authorization: `Bearer ${stale.key}` } });
        assert.deepEqual([m.status, (await m.json()).error.code], [402, 'BAD_KEY']);
    } finally { server.close(); }
});

test('openapi.json: valid schemas (a $ref that may be null is anyOf, never a null type)', async () => {
    const { openapi } = await import('../src/openapi.mjs');
    const bad = [];
    const walk = (o, at, parent) => {
        if (!o || typeof o !== 'object') return;
        if (parent !== 'properties' && 'type' in o && ![o.type].flat().every(t => typeof t === 'string')) bad.push(at);
        for (const [k, v] of Object.entries(o)) walk(v, `${at}/${k}`, k);
    };
    walk(openapi, '#');
    assert.deepEqual(bad, []);
});

test('keys: an app key uses the project but can\'t change it, the key a sign-in makes can; a new sign-in link replaces the ones before', async () => {
    const { startServer } = await import('../src/server.mjs');
    const { signinLink, redeemSignin } = await import('../src/access.mjs');
    const server = startServer(0);
    await new Promise(r => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const token = () => signinLink(project.id).link.split('#signin=')[1];
    const call = (key, method, p, body) => fetch(base + p, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const { project, key: app } = createProject('Scopes');
    try {
        const owner = redeemSignin(token()).key;
        assert.equal((await call(app, 'GET', '/v1/project')).status, 200);
        for (const [method, p, body] of [['PATCH', '/v1/project', { name: 'Taken' }], ['POST', '/v1/project/keys', { label: 'more' }], ['DELETE', `/v1/project/keys/${owner.slice(0, 10)}`]]) {
            const r = await call(app, method, p, body);
            assert.deepEqual([r.status, (await r.json()).error.code], [403, 'FORBIDDEN'], `${method} ${p}`);
        }
        assert.equal((await call(owner, 'PATCH', '/v1/project', { name: 'Renamed' })).status, 200);
        const made = (await (await call(owner, 'POST', '/v1/project/keys', { label: 'app 2' })).json()).key;
        assert.equal((await call(made, 'POST', '/v1/project/keys', { label: 'x' })).status, 403, 'a key an owner makes is an app key');
        const first = token(), second = token();
        assert.equal(redeemSignin(first), null);
        assert.match(redeemSignin(second).key, /^kio_/);
        // A body of a million tiny objects is turned away before it's parsed (parsed, it would take some forty times its size)
        const r = await fetch(`${base}/v1/brains/recall`, { method: 'POST', headers: { Authorization: `Bearer ${app}`, 'Content-Type': 'application/json' }, body: `{"brain":{"m":[${'{},'.repeat(6e5)}{}]}}` });
        assert.deepEqual([r.status, (await r.json()).error.code], [413, 'TOO_LARGE']);
    } finally { server.close(); }
});

test('limits: a provider\'s answer is read to 8 MB at most, a model\'s lists and texts are cut to size, and long inputs stay quick', async () => {
    const { readAnswer } = await import('../src/net.mjs');
    const big = new Response(new ReadableStream({ start(c) { for (let i = 0; i < 9; i++) c.enqueue(new Uint8Array(1e6)); c.close(); } }));
    await assert.rejects(readAnswer(big), e => e.code === 'PROVIDER' && /8 MB/.test(e.message));
    assert.equal(await readAnswer(new Response('{"ok":1}')), '{"ok":1}');
    const fitted = fitSchema({ items: Array(900).fill('x'.repeat(9000)) }, { type: 'object', properties: { items: { type: 'array', items: { type: 'string' } } } });
    assert.deepEqual([fitted.items.length, fitted.items[0].length], [500, 8000]);
    const word = i => `w${i.toString(36)}x${(i * 7919 % 10007).toString(36)}`;
    const text = Array.from({ length: 6000 }, (_, i) => word(i % 900)).join(' ');
    let t = performance.now();
    assert.equal(evidenceFound(text.split(' ').slice(0, 4000).reverse().join(' '), text), false, 'a quote of thousands of words is no quote');
    assert.equal(evidenceFound(`${text.split(' ').slice(10, 50).join(' ')} added`, text), true);
    assert.ok(performance.now() - t < 500, 'the quote check is quick');
    const many = readBrain({ kiori: 1, name: 'Many', memories: Array.from({ length: 3000 }, (_, i) => ({ kind: 'episode', title: `t${i}`, body: word(i), about: Array.from({ length: 12 }, (_, k) => `a${k}${'\\'.repeat(i % 7)}`) })) });
    t = performance.now();
    const z = exportObsidian(many);
    assert.ok(z.data.length > 0 && performance.now() - t < 3000, 'thousands of names that come out the same don\'t slow the export down');
});

test('kiori site: --out clears only an empty folder or an earlier build, never one that holds something else', async () => {
    const { buildSite } = await import('../src/site.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiori-site-'));
    fs.mkdirSync(path.join(dir, 'notes'));
    fs.writeFileSync(path.join(dir, 'notes', 'keep.txt'), 'mine');
    assert.throws(() => buildSite(dir), /isn't empty and isn't an earlier build/);
    assert.throws(() => buildSite(path.join(dir, 'notes', 'keep.txt')), /isn't empty and isn't an earlier build/);
    assert.equal(fs.readFileSync(path.join(dir, 'notes', 'keep.txt'), 'utf8'), 'mine');
    const out = path.join(dir, 'dist');
    buildSite(out);
    fs.writeFileSync(path.join(out, 'stale.html'), 'old');
    buildSite(out);
    assert.ok(fs.existsSync(path.join(out, '_headers')) && !fs.existsSync(path.join(out, 'stale.html')));
    // The beta terms and the privacy policy are pages of the site too, linked from the landing page and the access form
    for (const f of ['terms.html', 'privacy.html']) assert.match(fs.readFileSync(path.join(out, f), 'utf8'), /not yet reviewed by a lawyer/);
    const landing = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    assert.ok(landing.includes('<a href="/terms">beta terms</a> and the <a href="/privacy">privacy policy</a>') && landing.includes('<a href="/privacy">privacy</a>'));
    assert.match(fs.readFileSync(path.join(out, '_headers'), 'utf8'), /^\/privacy\n  Content-Security-Policy: default-src 'none'; script-src 'none'/m);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('docs markdown: quotes can\'t leave an attribute, links never run a script, a code block\'s language is a word', async () => {
    const { markdown } = await import('../src/markdown.mjs');
    const html = markdown('[a](https://example.com" style="position:fixed" x=")\n\n[b](javascript:alert(1)) [c](data:text/html,hi)\n\n[api](api.md#errors) [mail](mailto:help@kiori.io) [top](#top)\n\n```js" onmouseover="alert(1)\ncode\n```');
    assert.ok(!/style="|onmouseover="|href="(?:javascript|data):/i.test(html), html);
    assert.match(html, /<a href="\/docs\/api#errors">api<\/a> <a href="mailto:help@kiori.io">mail<\/a> <a href="#top">top<\/a>/);
});

test('client address: the last address the proxy on this machine added, Cloudflare\'s header only when Cloudflare is the proxy, nothing from elsewhere; IPv6 by its /64', async () => {
    const { clientIp, callerOf } = await import('../src/limits.mjs');
    const from = (remoteAddress, headers = {}) => clientIp({ socket: { remoteAddress }, headers });
    assert.equal(from('127.0.0.1', { 'cf-connecting-ip': '6.6.6.6', 'x-forwarded-for': '203.0.113.7' }), '203.0.113.7', 'a proxy that is not Cloudflare passes that header on as the client wrote it');
    config.trustProxy = 'cloudflare';
    assert.equal(from('127.0.0.1', { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '6.6.6.6' }), '203.0.113.7');
    config.trustProxy = '';
    assert.equal(from('::ffff:127.0.0.1', { 'x-forwarded-for': '6.6.6.6, 203.0.113.7' }), '203.0.113.7', 'what the client wrote in front is not believed');
    assert.equal(from('::1', { 'x-forwarded-for': '203.0.113.7' }), '203.0.113.7');
    assert.equal(from('198.51.100.2', { 'cf-connecting-ip': '6.6.6.6', 'x-forwarded-for': '6.6.6.6' }), '198.51.100.2');
    assert.equal(from('127.0.0.1'), '127.0.0.1');
    assert.equal(callerOf('203.0.113.7'), '203.0.113.7');
    assert.equal(callerOf('::ffff:203.0.113.7'), '203.0.113.7');
    assert.equal(callerOf('2001:db8:1:2:aaaa::1'), '2001:db8:1:2::/64');
    assert.equal(callerOf('2001:DB8:1:2:ffff:ffff:ffff:ffff'), '2001:db8:1:2::/64');
    assert.equal(callerOf('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(callerOf('fe80::1%en0'), 'fe80:0:0:0::/64');
});

test('rate limits: a flood of new callers never gives one that is limited a fresh count', async () => {
    const { hit } = await import('../src/limits.mjs');
    for (let i = 0; i < 61; i++) hit('test:limited', 60000);
    for (let i = 0; i <= 100000; i++) hit(`test:flood:${i}`, 1);
    assert.equal(hit('test:limited', 60000), 62);
});

// ---------- Files in and out ----------
test('stats: customers week by week, who is still active four weeks on, and this server\'s own projects left out', async () => {
    const { weeklyStats } = await import('../src/stats.mjs');
    const day = ago => new Date(Date.now() - ago * 864e5).toISOString().slice(0, 10);
    const call = (project, ago, route, n = 1) => run('INSERT INTO calls (project_id, day, route, n) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, day, route) DO UPDATE SET n = n + excluded.n', project, day(ago), route, n);
    const stays = createProject('Stays', {}, { llmMode: 'own' }).project.id, leaves = createProject('Leaves', {}, { llmMode: 'own' }).project.id;
    const ours = createProject('Our own', {}).project.id;
    // Four weeks ago both were active; this week only one is
    call(stays, 28, 'POST /v1/brains/organize'); call(leaves, 28, 'POST /v1/brains/organize');
    call(stays, 0, 'POST /v1/brains', 3); call(ours, 0, 'POST /v1/brains/recall', 5);
    recordError({ project: stays, route: 'POST /v1/brains/organize', status: 502, code: 'PROVIDER', upstream: 503 });
    const s = weeklyStats({ weeks: 6 }), everyone = weeklyStats({ weeks: 6, everyone: true });
    const week = s.weeks.at(-1);
    assert.equal(s.weeks.length, 6);
    assert.equal(new Date(week.week).getUTCDay(), 1, 'weeks start on Monday');
    assert.equal(week.kept_4w, 0.5);
    assert.ok(week.brains >= 3 && week.errors >= 1 && week.error_rate > 0);
    // This server's own projects count only when everyone is asked for
    assert.ok(everyone.weeks.at(-1).active >= week.active + 1);
    assert.ok(everyone.totals.projects > s.totals.projects);
    assert.deepEqual([s.scope, everyone.scope], ['customers', 'all']);
    assert.ok(!JSON.stringify(everyone).includes('Stays'), 'numbers only, no names');
    // The admin reads them from the API
    const { setAdminKey } = await import('../src/config.mjs');
    setAdminKey('kia_test_admin_key_for_the_suite');
    const { startServer } = await import('../src/server.mjs');
    const server = startServer(0);
    await new Promise(r => server.once('listening', r));
    try {
        const url = `http://127.0.0.1:${server.address().port}/v1/admin/stats?weeks=3&scope=all`;
        assert.equal((await fetch(url)).status, 401);
        const r = await (await fetch(url, { headers: { 'X-Admin-Key': 'kia_test_admin_key_for_the_suite' } })).json();
        assert.deepEqual([r.scope, r.weeks.length], ['all', 3]);
    } finally { server.close(); }
});

test('export: a brain as an Obsidian vault, a valid zip with the card and a note per memory', () => {
    const z = exportObsidian(mira);
    assert.equal(z.filename, 'Mira Voss.zip');
    assert.equal(z.data.readUInt32LE(0), 0x04034b50);
    const names = z.data.toString('latin1');
    assert.ok(names.includes('Mira Voss/Card.md') && names.includes('Secrets/The unsent letter.md'));
    const round = zip([{ name: 'ç/ğ.md', data: 'ü' }]);
    assert.ok(round.toString('utf8').includes('ç/ğ.md'));
    // A name can't climb out of the folder the zip is unpacked into: no entry's path has a . or .. part
    const entries = buf => { const out = []; for (let i = 0; buf.readUInt32LE(i) === 0x04034b50;) { const n = buf.readUInt16LE(i + 26); out.push(buf.toString('utf8', i + 30, i + 30 + n)); i += 30 + n + buf.readUInt16LE(i + 28) + buf.readUInt32LE(i + 18); } return out; };
    assert.ok(entries(z.data).includes('Mira Voss/Card.md'));
    for (const name of ['..', '.', ' ../..']) {
        const climb = exportObsidian({ ...mira, name });
        assert.ok(entries(climb.data).every(e => !e.split('/').some(part => part === '.' || part === '..')) && !climb.filename.startsWith('.'), name);
    }
});

test('import: a markdown vault becomes brain files, side characters with their other names', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiori-vault-'));
    const put = (f, text) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };
    put('Card.md', '---\nname: Nisa Kar\n---\n**Who:** A courier in Istanbul. She knows every roof and her way across them.\n');
    put('Memories/The roof.md', '---\ntype: memory\nstrength: 0.8\n---\nI slept on the roof the night the power went out.\n');
    put('Cast/Kingpin (Wilson Fisk).md', '---\ntype: cast\n---\n**Who:** He runs the city from behind his desk. He hates being kept waiting.\n');
    const r = vaultBrains(dir);
    assert.deepEqual(r.brains.map(b => b.name), ['Nisa Kar', 'Kingpin']);
    assert.equal(r.brains[0].pronouns, 'she');
    assert.equal(r.brains[0].memories[0].title, 'The roof');
    assert.deepEqual(r.brains[1].aliases, ['Wilson Fisk']);
    assert.ok(r.brains.every(b => readBrain(JSON.parse(JSON.stringify(b)))));
});

test('export-old: what an old database still holds comes out as brain files, with each story\'s place', () => {
    db.exec(`CREATE TABLE characters (id TEXT, project_id TEXT, name TEXT, aliases TEXT, pronouns TEXT, card TEXT, personality TEXT, origin TEXT, created_at TEXT);
        CREATE TABLE memories (id TEXT, character_id TEXT, story_id TEXT, kind TEXT, title TEXT, body TEXT, gist TEXT, keys TEXT, about TEXT, importance REAL, emotion REAL, strength REAL, status TEXT, evidence TEXT, seq_from INTEGER, seq_to INTEGER, embedding BLOB, created_at TEXT);
        CREATE TABLE stories (id TEXT, title TEXT, external_id TEXT);
        CREATE TABLE story_characters (story_id TEXT, character_id TEXT, learned_seq INTEGER);
        CREATE TABLE events (story_id TEXT, seq INTEGER, role TEXT, text TEXT, ext_id TEXT);`);
    run("INSERT INTO characters VALUES ('chr_1', 'prj_1', 'Kaan', '[]', 'he', '{\"who\":\"A pilot.\"}', '{}', 'built', '2026-01-01')");
    const vec = Buffer.from(new Float32Array(512).fill(0.5).buffer);
    run("INSERT INTO memories VALUES ('mem_1', 'chr_1', '', 'memory', 'Core', 'Flying.', NULL, '[]', '[]', 0.5, 0, 0.5, 'active', NULL, NULL, NULL, ?, '2026-01-01')", vec);
    run("INSERT INTO memories VALUES ('mem_2', 'chr_1', 'sto_1', 'memory', 'Story', 'The crash.', NULL, '[]', '[]', 0.5, 0, 0.5, 'active', '{\"quote\":\"we went down\"}', 1, 2, NULL, '2026-01-02')");
    run("INSERT INTO stories VALUES ('sto_1', 'Crash', 'chat_9')");
    run("INSERT INTO story_characters VALUES ('sto_1', 'chr_1', 2)");
    run("INSERT INTO events VALUES ('sto_1', 1, 'player', 'Hold on!', 'e1'), ('sto_1', 2, 'narrator', 'They went down.', NULL), ('sto_1', 3, 'player', 'Later.', NULL)");
    const found = oldBrains();
    assert.deepEqual(found.map(f => f.file), ['Kaan', 'Kaan — chat_9']);
    assert.deepEqual(found[0].brain.memories.map(m => m.title), ['Core']);
    assert.equal(Buffer.from(found[0].brain.memories[0].v, 'base64').length, 256);
    const s = found[1].brain;
    assert.deepEqual(s.memories.map(m => [m.title, m.scope, m.evidence]), [['Core', 'core', undefined], ['Story', 'chat', 'we went down']]);
    assert.deepEqual(s.chat, { learned: 2, seen: [[1, fingerprint('player', 'Hold on!'), 'e1'], [2, fingerprint('narrator', 'They went down.')]] });
    for (const t of ['characters', 'memories', 'stories', 'story_characters', 'events']) db.exec(`DROP TABLE ${t}`);
});

test('placement: long stretches are read in pieces, in order', () => {
    const events = Array.from({ length: 130 }, (_, i) => ({ seq: i + 1, n: i + 1, role: 'narrator', speaker: null, text: 'x'.repeat(100) }));
    const chunks = placementChunks(events);
    assert.deepEqual(chunks.map(c => c.length), [60, 60, 10]);
    assert.equal(chunks[1][0].seq, 61);
});

test.after(() => fake.close());
