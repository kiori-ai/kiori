// Creating a brain. The organizer writes what makes this person THIS person, on top of the shared human model. Like a
// novelist: first a sketch of the life (card, place on the 41 parameters, the people and places that matter, the
// turning points), then, in parallel and from that same sketch, their past (memories, people, places) and their inner
// life (beliefs, feelings, secrets, habits, how a few human mechanisms work in them). Three model calls on the
// customer's key, about a minute. A light brain is made from the card alone, with no model call at all: everything it
// knows beyond its card, the conversation teaches it.
import { askJSON, requireModelKey } from './llm.mjs';
import { PARAM_GUIDE, NEURON_TITLES, normalize, neuron } from './personality.mjs';
import { fromCharacterCard } from './cards.mjs';
import { newBrain, addMemories, setRelation, setState, mergeCard, setAliases, touch, CARD_FIELDS } from './brainfile.mjs';
import { embedMissing } from './recall.mjs';

const str = (description = '') => ({ type: 'string', description });
const list = (items, description = '') => ({ type: 'array', items, description });
const obj = (properties, description = '') => ({ type: 'object', properties, required: Object.keys(properties), description });

const SKETCH = obj({
    card: obj({
        who: str('One or two sentences: who they are now'),
        looks: str('A few concrete details'),
        personality: str('How they differ from an average person, with at least three contradictions; concrete'),
        voice: str('How they talk: rhythm, word choice, tics, how it changes under pressure, and 2-3 example lines'),
        core: str('The heart of them in 2-3 sentences, first person'),
    }),
    aliases: list(str(), 'Other names people call them'),
    pronouns: { type: 'string', enum: ['she', 'he', 'they'] },
    personality: { type: 'object', description: 'EVERY parameter id -> 0-100 (50 = average person)' },
    people: list(obj({ name: str(), role: str('Who they are to this character, one line') }), '4-7 people of their life'),
    places: list(obj({ name: str(), what: str('one line') }), '2-4 places'),
    turning_points: list(obj({ when: str('a year or an age'), what: str('one line') }), '5-8 events that made them who they are'),
    relations: list(obj({ target: str(), trust: { type: 'number' }, closeness: { type: 'number' }, respect: { type: 'number' }, resentment: { type: 'number' }, attraction: { type: 'number' }, note: str('one sentence, their view') }), 'Feelings (0-100) toward the people they know, the other world characters included'),
    state: obj({ mood: str(), on_mind: list(str()), wants: list(str()) }),
});

const item = kinds => obj({
    kind: { type: 'string', enum: kinds },
    title: str('Short, specific'),
    body: str('First person, in their voice. A memory: 2-3 sentences, the first one plain and factual (when, where, who, what happened). Anything else: 1-2 sentences'),
    keys: list(str(), '3-5 lowercase words that would bring this to mind'),
    about: list(str(), 'Names of the people it involves'),
    importance: { type: 'number', description: '0-1, how much it matters to them' },
    emotion: { type: 'number', description: '0-1, how intense' },
    links: list(str(), 'At most 3 titles of other items it connects to'),
});
const PAST = obj({ items: list(item(['memory', 'person', 'place']), 'One formative memory per turning point, one item per person in the sketch, one per place: about 15-20 items in all') });
const INNER = obj({
    items: list(item(['belief', 'feeling', 'secret', 'habit', 'trait', 'skill', 'object']), 'Beliefs 3-4, specific feelings 2-3, secrets 2-3, habits and odd 1% details 4-6, skills and objects 2-4: about 15-18 items in all'),
    mind_notes: list(obj({ neuron: str('An exact title from the list'), note: str('One sentence, first person') }), '6-10 notes on how human mechanisms work in them'),
});

const RULES = `Rules of realism:
- 99% of human psychology is shared and already known; write only the 1% that makes this person THIS person.
- Concrete over generic: "most people do X, they do Y because of Z". No empty adjectives.
- Every marked trait has a root in their past. People are contradictory.
- Stay faithful to the description and the lore: they are canon. Where they are silent, invent plausibly.
- Everyone involved is an adult. Write everything in English. Be concise: every word earns its place.`;

const sketchText = s => `CARD: ${JSON.stringify(s.card)}
PEOPLE: ${s.people.map(p => `${p.name} (${p.role})`).join('; ')}
PLACES: ${s.places.map(p => `${p.name} (${p.what})`).join('; ')}
TURNING POINTS: ${s.turning_points.map(t => `${t.when}: ${t.what}`).join('; ')}`;

const bad = message => Object.assign(new Error(message), { status: 400, code: 'BAD_REQUEST' });
const text = v => (v == null ? '' : typeof v === 'string' ? v : null);

// What a brain is made from: a character card (Tavern v1/v2/v3 JSON, or a card PNG in base64) as character_card, or
// as the body itself, and/or name, description and lore. A card sent as character_card adds to the description and
// lore given beside it. others: the other characters of the world ({ name, who } or names), so the brain knows them.
export function sourceOf(body) {
    const given = body.character_card != null;
    const card = fromCharacterCard(given ? body.character_card : body);
    if (given && !card) throw bad('character_card is not a character card Kiori can read (Tavern v1/v2/v3 JSON, or a card PNG in base64)');
    const [name, description, lore] = [text(body.name), text(body.description), text(body.lore)];
    if (name == null || description == null || lore == null) throw bad('name, description and lore are text');
    // A card sent as the body has its own "personality": the card's text (v1, and v2 exports that keep the v1 fields on
    // top), which is read with the card, not as Kiori's parameters
    const asCard = card && !given;
    const personality = asCard && (typeof body.personality !== 'object' || Array.isArray(body.personality)) ? null : body.personality;
    if (personality != null && (typeof personality !== 'object' || Array.isArray(personality))) throw bad('personality must be an object of { param_id: 0-100 }');
    if (body.others != null && !Array.isArray(body.others)) throw bad('others must be a list of names or { name, who }');
    const out = {
        name: (name.trim() || card?.name || '').trim(),
        description: card && !given ? card.description : [card?.description, description].filter(Boolean).join('\n\n'),
        lore: card && !given ? card.lore : [card?.lore, lore].filter(Boolean).join('\n\n'),
        cardExtra: card?.card ?? {},
        pronouns: ['she', 'he', 'they'].includes(body.pronouns) ? body.pronouns : null,
        personality: personality ?? {},
        archetype: typeof body.archetype === 'string' ? body.archetype : null,
        others: (body.others ?? []).slice(0, 40).map(o => (typeof o === 'string' ? { name: o } : o && typeof o === 'object' ? o : null)).filter(o => o?.name && typeof o.name === 'string'),
    };
    if (!out.name) throw bad('A brain needs a name: send a character card, or name and description');
    return out;
}

// POST /v1/brains: a new brain, for the customer to keep. depth "full" (default) writes a whole past; "light" costs
// nothing and starts from the card.
export async function createBrain(project, body = {}) {
    if (body.depth != null && !['full', 'light'].includes(body.depth)) throw bad('depth is "full" or "light"');
    const src = sourceOf(body);
    const depth = body.depth ?? 'full';
    if (depth === 'full') requireModelKey(project);
    const brain = newBrain({
        name: src.name, pronouns: src.pronouns ?? 'they', build: depth,
        card: { ...src.cardExtra, description: src.description, lore: src.lore },
        personality: normalize(src.personality, src.archetype),
    });
    if (depth === 'light') return brain;
    await writeBrain(project, brain, src);
    await embedMissing(project, brain);
    return touch(brain);
}

// The build prompts carry as much of a card as a brain keeps of it (a big lorebook is cut where an entry ends)
const upTo = (s, max) => { if (s.length <= max) return s; const cut = s.lastIndexOf('\n\n', max); return s.slice(0, cut > max * 0.8 ? cut : max); };

async function writeBrain(project, brain, { name, description, lore, pronouns, personality, archetype, others }) {
    const cast = others.filter(o => o.name.trim() !== name).map(o => `- ${o.name.trim().slice(0, 120)}${typeof o.who === 'string' && o.who.trim() ? `: ${o.who.trim().slice(0, 300)}` : ''}`);
    [description, lore] = [upTo(description, CARD_FIELDS.description), upTo(lore, CARD_FIELDS.lore)];
    const source = `CHARACTER: ${name}\nDESCRIPTION: ${description || '(none)'}${lore ? `\n\nTHE WORLD (canon):\n${lore}` : ''}${cast.length ? `\n\nOTHER CHARACTERS IN THIS WORLD:\n${cast.join('\n')}` : ''}`;
    const ask = (schema, prompt, validate) => askJSON({ role: 'organizer', project, op: 'build', schema, prompt, validate, maxTokens: 12000, temperature: 0.7 });

    // 1. The sketch of a life
    const s = await ask(SKETCH, `You are sketching a character for a roleplay engine's brain.\n\n${RULES}\n\n${source}\n\nPERSONALITY PARAMETERS (id: name, low / high), rate every one:\n${PARAM_GUIDE}`,
        x => (x.card.who && x.people.length >= 3 && x.turning_points.length >= 4 ? true : 'sketch too thin'));
    // 2. Their past and their inner life, in parallel, from the same sketch
    const [past, inner] = await Promise.all([
        ask(PAST, `Write ${name}'s past as memories, in their own voice, from this sketch.\n\n${RULES}\n\n${source}\n\n${sketchText(s)}`, x => (x.items.length >= 8 ? true : `only ${x.items.length} items`)),
        ask(INNER, `Write ${name}'s inner life, in their own voice, from this sketch: beliefs, feelings, secrets (things they never told anyone; say inside who else knows, if anyone), habits and odd details, skills, objects, and how some human mechanisms work in them.\n\n${RULES}\n\n${source}\n\n${sketchText(s)}\n\nHUMAN MODEL NEURONS (mind_notes use these exact titles):\n${NEURON_TITLES.join(', ')}`, x => (x.items.length >= 8 ? true : `only ${x.items.length} items`)),
    ]);

    setAliases(brain, s.aliases);
    brain.pronouns = pronouns ?? (['she', 'he', 'they'].includes(s.pronouns) ? s.pronouns : brain.pronouns);
    mergeCard(brain, s.card);
    brain.personality = normalize({ ...normalize(s.personality, archetype), ...personality });
    const items = [...past.items, ...inner.items];
    addMemories(brain, items, { scope: 'core', links: items.flatMap(m => (m.links ?? []).map(to => ({ from: m.title, to }))) });
    const notes = inner.mind_notes.filter(n => neuron(n.neuron) && n.note?.trim()).map(n => ({ kind: 'mind', title: neuron(n.neuron).title, body: n.note, keys: [], importance: 0.5 }));
    addMemories(brain, notes, { scope: 'core' });
    for (const rel of s.relations) setRelation(brain, rel, 'core');
    setState(brain, s.state, 'core');
}
