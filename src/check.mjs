// The auditor at read time: before a reply is shown, it is checked against what each speaking character really
// knows. Leaks (knowing what happened where they weren't, other people's secrets), contradictions with their
// memories, and a shared past nobody can find in them are flagged and fixed with minimal edits.
import { askJSON, requireModelKey } from './llm.mjs';
import { mentions, sameCharacter, whoIs } from './text.mjs';
import { characterOf } from './brainfile.mjs';
import { isPresent, speakersIn, eventLine } from './scenes.mjs';
import { contextOf, searchMemories, queryVector, vectorFor } from './recall.mjs';
import { eventsOf, playerOf } from './organize.mjs';

const SCHEMA = {
    type: 'object',
    properties: {
        issues: {
            type: 'array',
            items: {
                type: 'object',
                properties: {
                    character: { type: 'string' },
                    type: { type: 'string', enum: ['leak', 'contradiction', 'invented_past', 'unsupported', 'misattribution'] },
                    quote: { type: 'string', description: 'The exact words in the draft' },
                    why: { type: 'string' },
                },
                required: ['character', 'type', 'quote', 'why'],
            },
        },
        fixed: { type: 'string', description: 'The draft with only the problem lines changed, everything else word for word: same lines, same "Name:" prefixes, same format, same language; empty if no issues' },
    },
    required: ['issues', 'fixed'],
};

const bad = message => Object.assign(new Error(message), { status: 400, code: 'BAD_REQUEST' });

// POST /v1/brains/check. Who is checked: with one brain, that character; in a group, whoever speaks in the draft ("Name:
// words" lines) and whoever its narration names, at most 6. A draft is one reply: MAX_DRAFT characters at most.
export const MAX_DRAFT = 20000;
export async function checkReply(project, brains, body) {
    const draft = String(body.draft ?? '');
    if (!draft.trim()) throw bad('draft is required: the reply to check');
    if (draft.length > MAX_DRAFT) throw bad(`draft is one reply: at most ${MAX_DRAFT} characters`);
    requireModelKey(project);
    const player = playerOf(body);
    const cast = brains.map(characterOf);
    const scope = { story: cast, everyone: cast, player };
    // Who speaks in the draft, each looked up once (not again for every brain)
    const speakers = brains.length === 1 ? [] : speakersIn(draft).map(n => whoIs(n, scope));
    const checked = brains.length === 1 ? brains : brains.filter(b => {
        const c = characterOf(b);
        return speakers.some(s => sameCharacter(s, c)) || mentions(draft, c);
    }).slice(0, 6);
    if (!checked.length) return { ok: true, issues: [], fixed: draft, checked: [] };
    const events = eventsOf(Array.isArray(body.messages) ? body.messages.slice(-40) : [], { player, solo: brains.length === 1 ? brains[0].name : null });
    if (brains.length === 1) for (const e of events) e.present ??= [brains[0].name, player];
    const qv = await queryVector(project, checked, draft);
    const blocks = checked.map(b => {
        const c = characterOf(b);
        const ctx = contextOf(b, { text: draft, hits: searchMemories(b, draft, vectorFor(project, b, qv), { limit: 8 }), budget: 4500, player });
        // The recent messages they were there for, and apart from them the ones nobody placed (whether they saw those
        // is for the auditor to tell from the messages, such as who came and went)
        const seen = events.filter(e => e.present && isPresent(e, c, scope)).slice(-12);
        const unplaced = events.filter(e => !e.present).slice(-12);
        return `### ${b.name}\nWho: ${[b.card.who, b.card.personality].filter(Boolean).join(' ').slice(0, 600)}\n${ctx.text}\n\nRecent messages ${b.name} witnessed:\n${seen.map(e => eventLine(e, e.n)).join('\n') || '(none)'}${unplaced.length ? `\n\nRecent messages nobody placed (whether ${b.name} was there, tell from the messages themselves):\n${unplaced.map(e => eventLine(e, e.n)).join('\n')}` : ''}`;
    });
    const recent = events.slice(-12).map(e => eventLine(e, e.n)).join('\n');
    const lore = brains.map(b => b.card.lore).find(Boolean) ?? '';
    const r = await askJSON({
        role: 'auditor', project, op: 'check', schema: SCHEMA, maxTokens: 5000, temperature: 0.1,
        prompt: `You check a draft reply in a story before it is shown. Each character below may know only what their block says: their memories, what they know for sure, what they've been told (and by whom), and the recent messages they witnessed. A recent message nobody placed counts as witnessed only when the messages show the character was there (not when they had left, or it was said apart from them).

Flag, for the characters listed only:
- leak: they say, hint at, guess too precisely or act on something that happened in THIS story in a scene they were not in, or another person's private thing (a secret, a whisper, a confession) they never heard. A plausible general guess from what they saw is fine; the specific detail is not.
- contradiction: they state something about the past that contradicts their memories.
- invented_past: they go along with or add details to a shared past that isn't in their memories (the player may claim things; a claim is not a memory).
- unsupported: a concrete claim about a past event in their own life (a name, a date, something that happened) that their memories contradict or clearly can't contain.
- misattribution: they name a source their block doesn't give for something (who told them, where they heard it), or speak as an eyewitness of something they were only told.
Do NOT flag: what a person in this world would know from their own life and position (who runs what, who someone is, the world's lore); opinions, estimates, rhetoric, threats, jokes; reactions, feelings, new actions; narration placing someone in the scene. When unsure, don't flag.

If nothing is wrong, return {"issues": [], "fixed": ""}.

${lore ? `THE WORLD (common knowledge for the people who live in it):\n${lore.slice(0, 3000)}\n\n` : ''}WHO IS WHO (common knowledge in this world):\n${brains.filter(b => b.card.who).map(b => `- ${b.name}: ${b.card.who.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n') || '(nothing more)'}\n\nTHE STORY'S RECENT MESSAGES (for orientation; the narrator saw all of it):
${recent || '(none sent)'}

WHAT EACH CHARACTER KNOWS:
${blocks.join('\n\n')}

DRAFT:
${draft}`,
    });
    const names = checked.map(characterOf);
    const issues = r.issues.filter(i => i.quote?.trim() && names.some(c => sameCharacter(whoIs(i.character, { story: names }), c)));
    return { ok: !issues.length, issues, fixed: issues.length && r.fixed?.trim() ? r.fixed.trim() : draft, checked: checked.map(b => b.name) };
}
