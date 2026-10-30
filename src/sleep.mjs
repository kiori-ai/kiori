// Sleep: the brain's maintenance. Unimportant memories fade a little after each stretch of conversation, faded ones are
// pressed down to their gist (details blur, the meaning stays), memories that say the same thing are merged, and a
// brain that grows past what a mind holds forgets its faintest conversation memories. It also keeps a brain small
// enough to travel with every call.
import { askJSON } from './llm.mjs';
import { unpackVector, cosine, freshVector } from './brainfile.mjs';

// When a brain is big enough for sleep to be worth a model call, and the most it keeps
export const SLEEP_AT = 300, KEEP_AT_MOST = 800;
// The most pairs of memories one sleep compares (a brain at KEEP_AT_MOST, all of one kind, is about 320,000), and how
// many it compares before the server gets a turn
export const MERGE_PAIRS = 500000;
const YIELD_EVERY = 20000;
const FINAL = ['CREDITS', 'NO_KEY', 'NEEDS_KEY', 'BAD_KEY'];

// Cheap, after every learning: what doesn't matter to them fades; what matters holds
export function decay(brain) {
    for (const m of brain.memories) {
        if (m.scope === 'chat' && ['memory', 'intention'].includes(m.kind) && m.status === 'active') m.strength = Math.max(0.05, m.strength - 0.03 * (1 - m.importance) * (1 - m.emotion));
    }
}

const GIST = {
    type: 'object',
    properties: { gists: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, gist: { type: 'string' } }, required: ['id', 'gist'] } } },
    required: ['gists'],
};

const dropLinksTo = brain => {
    const ids = new Set(brain.memories.map(m => m.id));
    for (const m of brain.memories) if (m.links) { m.links = m.links.filter(id => ids.has(id)); if (!m.links.length) delete m.links; }
};

export async function consolidate(project, brain, { force = false } = {}) {
    if (!force && brain.memories.length < SLEEP_AT) return null;
    // Gist: a faded memory keeps one sentence of meaning, and that is all that's left of it
    const faded = brain.memories.filter(m => m.strength < 0.3 && m.kind === 'memory' && m.scope === 'chat' && !m.gisted).slice(0, 40);
    let gisted = 0;
    if (faded.length) {
        try {
            const r = await askJSON({
                role: 'auditor', project, op: 'sleep', schema: GIST, maxTokens: 3000,
                prompt: `These memories have faded. For each, write its gist in one first-person sentence: the meaning and who it involved, with the specific details gone (no numbers, exact words or minor names). Keep the id.\n\n${faded.map(m => `${m.id}: ${m.body}`).join('\n\n')}`,
            });
            for (const g of r.gists) {
                const m = faded.find(x => x.id === g.id);
                if (m && g.gist?.trim()) { m.body = g.gist.trim().slice(0, 500); m.gisted = true; gisted++; }
            }
        } catch (e) { if (FINAL.includes(e.code)) throw e; }
    }
    // Merge: two memories of the same kind and scope that mean the same thing; the stronger one stays. Each kind and scope
    // is compared on its own, at most MERGE_PAIRS pairs a sleep, and the server gets a turn every so often: a brain sent
    // in with thousands of memories can't hold everyone else up (what's left is compared at the next sleep)
    let merged = 0, pairs = 0, turn = YIELD_EVERY;
    const gone = new Set();
    // Only by a fingerprint that still fits the memory's text (an edited one waits for its new fingerprint)
    const groups = Map.groupBy(brain.memories.filter(m => freshVector(m) && m.kind !== 'mind'), m => `${m.kind}\n${m.scope}`);
    for (const group of groups.values()) {
        const withVec = group.map(m => ({ m, v: unpackVector(freshVector(m)) }));
        for (let i = 0; i < withVec.length && pairs < MERGE_PAIRS; i++) {
            if (pairs >= turn) { turn = pairs + YIELD_EVERY; await new Promise(r => setImmediate(r)); }
            for (let j = i + 1; j < withVec.length; j++) {
                const a = withVec[i], b = withVec[j];
                if (gone.has(a.m.id) || gone.has(b.m.id)) continue;
                pairs++;
                if (cosine(a.v, b.v) < 0.93) continue;
                const [keep, drop] = a.m.strength >= b.m.strength ? [a.m, b.m] : [b.m, a.m];
                keep.strength = Math.min(1, keep.strength + 0.05);
                gone.add(drop.id);
                merged++;
            }
        }
    }
    // Past what a mind holds: the faintest memories of the conversation go (never the core, facts, plans or forgettings)
    const over = brain.memories.length - gone.size - KEEP_AT_MOST;
    let forgotten = 0;
    if (over > 0) {
        for (const m of brain.memories.filter(x => !gone.has(x.id) && x.scope === 'chat' && x.kind === 'memory').sort((a, b) => a.strength - b.strength).slice(0, over)) { gone.add(m.id); forgotten++; }
    }
    if (gone.size) { brain.memories = brain.memories.filter(m => !gone.has(m.id)); dropLinksTo(brain); }
    return { gisted, merged, forgotten };
}
