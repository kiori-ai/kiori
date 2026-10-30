// Before Kiori stopped storing brains, it kept characters, stories and memories in its database. This turns what an
// old database still holds into brain files, one per character (its core) and one per character per story (core plus
// what that story taught them, with its place in the story), so nothing learned is lost. Read-only: the old tables
// stay as they are until their owner deletes them.
import { db, json } from './db.mjs';
import { newBrain, packVector, fingerprint, LIMITS } from './brainfile.mjs';

const hasTable = name => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
const blobVector = b => (b ? new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)) : null);

function memoryOf(r) {
    return {
        id: r.id, kind: r.kind, title: r.title, body: r.body, gist: r.gist ?? undefined, keys: json(r.keys, []), about: json(r.about, []),
        importance: r.importance, emotion: r.emotion, strength: r.strength, status: r.status === 'done' ? 'done' : 'active',
        scope: r.story_id ? 'chat' : 'core', evidence: json(r.evidence, null)?.quote ?? undefined, from: r.seq_from ?? undefined, to: r.seq_to ?? undefined,
        v: packVector(blobVector(r.embedding)) ?? undefined,
    };
}

// [{ project, file, brain }] for everything the old tables hold
export function oldBrains() {
    if (!hasTable('characters') || !hasTable('memories')) return [];
    const out = [];
    const links = hasTable('links') ? db.prepare('SELECT from_id, to_id FROM links').all() : [];
    for (const c of db.prepare('SELECT * FROM characters ORDER BY created_at').all()) {
        const all = db.prepare("SELECT * FROM memories WHERE character_id = ? AND status NOT IN ('merged', 'deleted') ORDER BY created_at").all(c.id);
        const rels = hasTable('relations') ? db.prepare('SELECT * FROM relations WHERE character_id = ?').all(c.id) : [];
        const states = hasTable('states') ? db.prepare('SELECT * FROM states WHERE character_id = ?').all(c.id) : [];
        const embedded = all.some(m => m.embedding);
        const make = storyId => {
            const b = newBrain({ name: c.name, aliases: json(c.aliases, []), pronouns: c.pronouns, card: json(c.card, {}), personality: json(c.personality, {}), build: c.origin === 'auto' ? 'light' : 'full' });
            const mine = all.filter(m => m.story_id === '' || m.story_id === storyId).map(memoryOf);
            const ids = new Set(mine.map(m => m.id));
            for (const m of mine) { const to = links.filter(l => l.from_id === m.id && ids.has(l.to_id)).map(l => l.to_id); if (to.length) m.links = to.slice(0, 8); }
            b.memories = mine;
            b.relations = rels.filter(r => r.story_id === '' || r.story_id === storyId).map(r => ({ target: r.target, trust: r.trust, closeness: r.closeness, respect: r.respect, resentment: r.resentment, attraction: r.attraction, note: r.note, scope: r.story_id ? 'chat' : 'core' }));
            const st = s => s && { mood: s.mood, on_mind: json(s.on_mind, []), wants: json(s.wants, []) };
            b.state = { core: st(states.find(s => s.story_id === '')), chat: storyId ? st(states.find(s => s.story_id === storyId)) : null };
            if (embedded) b.embed = { model: 'openai/text-embedding-3-small', dim: 256 };
            return b;
        };
        out.push({ project: c.project_id, file: c.name, brain: make('') });
        if (!hasTable('story_characters') || !hasTable('stories')) continue;
        for (const sc of db.prepare('SELECT sc.*, s.title, s.external_id FROM story_characters sc JOIN stories s ON s.id = sc.story_id WHERE sc.character_id = ?').all(c.id)) {
            const b = make(sc.story_id);
            // Its place in the story: the last messages it learned, so the chat can be lined up and go on from there
            const events = hasTable('events') ? db.prepare('SELECT seq, role, text, ext_id FROM events WHERE story_id = ? AND seq <= ? ORDER BY seq DESC LIMIT ?').all(sc.story_id, sc.learned_seq, LIMITS.seen).reverse() : [];
            b.chat = { learned: sc.learned_seq, seen: events.map(e => (e.ext_id ? [e.seq, fingerprint(e.role, e.text), e.ext_id] : [e.seq, fingerprint(e.role, e.text)])) };
            out.push({ project: c.project_id, file: `${c.name} — ${sc.external_id ?? sc.title ?? sc.story_id}`, brain: b });
        }
    }
    return out;
}
