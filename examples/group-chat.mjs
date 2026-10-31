// A group chat: three characters, each with a brain of their own, and one player. Each run is one turn: the player
// speaks, one drop-in chat call answers with the minds of the characters in the room, and every brain learns from it.
// The brains and the chat are kept in group-chat.json next to this script (Kiori keeps neither), so run it again to
// go on with the scene; delete the file to start over.
// Usage: KIORI_API_KEY=kio_... node examples/group-chat.mjs "Tom, what did Mira tell you about me?"
//   (spends a few cents on your brain API key; KIORI_CHAT_MODEL names the model that writes the replies)
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Kiori } from '../sdk/kiori.mjs';

const apiKey = process.env.KIORI_API_KEY, baseUrl = process.env.KIORI_URL ?? 'https://api.kiori.io';
const kiori = new Kiori({ apiKey, baseUrl });
const model = process.env.KIORI_CHAT_MODEL ?? 'anthropic/claude-haiku-5.5';   // one your brain API key's provider has
const file = fileURLToPath(new URL('group-chat.json', import.meta.url));
const log = (...a) => console.log(...a);

const player = 'Leo';
const cast = [
    { name: 'Mira', pronouns: 'she', description: 'Lighthouse keeper on a cold island, ex-war medic, dry humor, hates being pitied.' },
    { name: 'Tom', pronouns: 'he', description: 'The island ferryman, gossip, kind, terrible at keeping secrets.' },
    { name: 'Ines', pronouns: 'she', description: 'Runs the harbor tavern, trades in rumors, lost her brother on the Halcyon.' },
];
const names = cast.map(c => c.name);
const here = ['Tom', 'Ines'];   // who is in the room this turn

// The brains and the chat from the last run, or a new scene. Each brain is built once and kept
let { brains, messages } = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
if (!brains) {
    log('Building Mira, Tom and Ines...');
    brains = await Promise.all(cast.map(c => kiori.create({ ...c, others: names.filter(n => n !== c.name) })));
    // Where the scene starts: only Mira heard who Leo is
    messages = [
        { id: '1', role: 'narrator', content: '*Late at night, in the lighthouse kitchen.*', present: ['Mira', player] },
        { id: '2', role: 'user', content: "I'm the son of the man who sank the Halcyon. I came to find out what really happened.", present: ['Mira', player] },
        { id: '3', role: 'assistant', name: 'Mira', content: 'Then keep your voice down in town. Ines lost her brother on that ship.', present: ['Mira', player] },
        { id: '4', role: 'narrator', content: '*Morning. Leo walks into the harbor tavern. Tom is at the bar, Ines behind it.*', present: [...here, player] },
    ];
}
const add = m => messages.push({ id: String(messages.length + 1), ...m, present: [...here, player] });

// The player's turn
const line = process.argv[2] ?? 'Tom, what did Mira tell you about me?';
add({ role: 'user', content: line });
log(`${player}: ${line}`);

// The drop-in: an OpenAI-compatible chat call with the brains of the characters about to speak in "kiori". Kiori adds
// each one's mind to the system prompt and passes the call on to your model. The model gets plain messages, with the
// speaker's name in the text.
const forModel = messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.name ? `${m.name}: ${m.content}` : m.content }));
const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
        model,
        messages: [{ role: 'system', content: `You write a group roleplay; ${player} is the player. Write the next reply of the scene: one or two lines, each as "Name: words", only for ${here.join(' and ')}.` }, ...forModel],
        // check is 'auto' by default: when the player brings up the past, the reply is checked and fixed before it's sent
        kiori: { brains: brains.filter((b, i) => here.includes(names[i])), player },
    }),
});
if (!res.ok) throw new Error(`Kiori answered ${res.status}: ${await res.text()}`);
const reply = (await res.json()).choices[0].message.content ?? '';
// ok, fixed (the auditor took out what a character couldn't know), skipped or failed; no header when no check was needed
log(`(check: ${res.headers.get('x-kiori-check') ?? 'not needed'})`);

// Each "Name: words" line becomes that character's message; a reply in another shape is kept as it is
const spoken = reply.split('\n').map(l => l.match(/^\**([^:*\n]+?)\**:\s*(.+)$/)).filter(m => m && here.includes(m[1].trim()));
for (const s of spoken.length ? spoken.map(m => ({ name: m[1].trim(), content: m[2] })) : [{ content: reply.trim() }]) {
    add({ role: 'assistant', ...s });
    log(s.name ? `${s.name}: ${s.content}` : s.content);
}

// The brains learn: send all of them. Each learns only the scenes it was in, so Tom and Ines never learn what Leo told
// Mira at night. now: true learns what's settled at once, for this short demo; in an app, leave it out and call organize
// after every reply: learning waits for 12 new settled messages, and the newest 4 wait, since they may still be rerolled
const r = await kiori.organize({ brains, messages: messages.slice(-60), player, now: true });
brains = r.brains;   // keep the brains that come back, even when nothing was learned
for (const l of r.learned) log(`  ${l.name} learned from ${l.messages} messages: ${l.written} written`);
log(`  ${r.waiting} settled messages wait, the newest ${r.held} are held`);

fs.writeFileSync(file, JSON.stringify({ brains, messages }));
log(`\nSaved to ${file}. Run again to go on.`);
