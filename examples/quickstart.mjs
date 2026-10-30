// End to end: build two brains, play a short scene where only one of them hears a secret, let them learn, then ask
// each what they know and let the auditor catch a leak. Kiori keeps no brains: they live in this script.
// Usage: KIORI_API_KEY=kio_... node examples/quickstart.mjs   (spends a few cents on your brain API key)
import { Kiori } from '../sdk/kiori.mjs';

const kiori = new Kiori({ apiKey: process.env.KIORI_API_KEY ?? process.env.PSYCHE_API_KEY, ...((process.env.KIORI_URL ?? process.env.PSYCHE_URL) && { baseUrl: process.env.KIORI_URL ?? process.env.PSYCHE_URL }) });
const log = (...a) => console.log(...a);

log('Building Mira and Tom...');
let [mira, tom] = await Promise.all([
    kiori.create({ name: 'Mira', pronouns: 'she', description: 'Lighthouse keeper on a cold island, ex-war medic, dry humor, hates being pitied, keeps a box of letters she never sent.', others: ['Tom'] }),
    kiori.create({ name: 'Tom', pronouns: 'he', description: 'The island ferryman, gossip, kind, terrible at keeping secrets, owes Mira for saving his son.', others: ['Mira'] }),
]);

// The chat as your app has it. Who was there is given here; leave "present" out and Kiori works it out.
const messages = [
    { id: '1', role: 'narrator', content: '*The ferry docks in the storm. Tom ties the rope while Leo climbs onto the pier.*', present: ['Tom', 'Leo'] },
    { id: '2', role: 'assistant', name: 'Tom', content: "Lighthouse is up the hill. Mira doesn't like visitors, but she won't let you drown.", present: ['Tom', 'Leo'] },
    { id: '3', role: 'narrator', content: '*Leo climbs alone to the lighthouse. Mira opens the door, sees him soaked, and lets him in without a word.*', present: ['Mira', 'Leo'] },
    { id: '4', role: 'user', content: "I have to tell someone. I'm not a tourist. I'm the son of the man who sank the Halcyon.", present: ['Mira', 'Leo'] },
    { id: '5', role: 'assistant', name: 'Mira', content: "The Halcyon. Forty-one people. *she sets the kettle down too hard* Then you'd better never say that name in town. Especially not to Tom.", present: ['Mira', 'Leo'] },
];
log('Learning...');
const r = await kiori.organize({ brains: [mira, tom], messages, player: 'Leo', now: true, hold: 0 });
[mira, tom] = r.brains;   // keep the brains that come back
log(r.learned.map(l => `  ${l.name}: ${l.messages} messages, ${l.written} written, dropped ${JSON.stringify(l.dropped)}`).join('\n'));

const { characters } = await kiori.recall({ brains: [mira, tom], query: "Leo's father, the Halcyon", player: 'Leo' });
for (const c of characters) log(`\n--- What ${c.name} brings to the moment ---\n${c.text.slice(0, 1200)}`);

log("\nChecking a draft where Tom knows what he shouldn't...");
const verdict = await kiori.check({ brains: [mira, tom], messages, player: 'Leo', draft: 'Tom: Morning, Leo. Shame about your father and the Halcyon, eh? Mira told me everything.' });
log(JSON.stringify(verdict, null, 2));
