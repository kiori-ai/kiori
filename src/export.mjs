// A brain as an Obsidian vault: every memory a note, every connection a [[link]], ready for the graph view.
import { getRelations, getState, RELATION_FIELDS } from './brainfile.mjs';
import { profile, attachment, inThisPerson } from './personality.mjs';
import { norm } from './text.mjs';
import { zip } from './zip.mjs';

const FOLDERS = { memory: 'Memories', person: 'People', place: 'Places', belief: 'Beliefs', feeling: 'Feelings', secret: 'Secrets', habit: 'Habits', skill: 'Skills', object: 'Objects', fact: 'Facts', intention: 'Plans', trait: 'Traits', forgot: 'Forgotten' };
const COLORS = { Memories: '#a5b4fc', People: '#f472b6', Places: '#34d399', Beliefs: '#fbbf24', Feelings: '#f87171', Secrets: '#c084fc', Habits: '#2dd4bf', Skills: '#60a5fa', Objects: '#fb923c', Facts: '#e2e8f0', Plans: '#facc15', Traits: '#4ade80', Mind: '#64748b' };
// A file or folder name: no path separators or characters Obsidian and Windows refuse, and no leading dots (so never
// . or .., which would climb out of the folder the zip is unpacked into)
const safe = s => String(s).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/^[.\s]+/, '').trim().slice(0, 90) || 'Untitled';
const fm = o => `---\n${Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${Array.isArray(v) ? `[${v.join(', ')}]` : v}`).join('\n')}\n---\n`;

export function exportObsidian(brain) {
    const rows = brain.memories;
    const files = [];
    const root = safe(brain.name);
    const put = (p, data) => files.push({ name: `${root}/${p}`, data });
    // Two notes never share a name: a name taken goes on as "Name (2)", "Name (3)"... counting on from the last one given,
    // so a brain with thousands of names that come out the same stays quick
    const taken = new Set(), counts = new Map();
    const noteName = (folder, title) => {
        const base = safe(title), key = `${folder}/${base}`.toLowerCase();
        let n = base, i = counts.get(key) ?? 2;
        while (taken.has(`${folder}/${n}`.toLowerCase())) n = `${base} (${i++})`;
        counts.set(key, i);
        taken.add(`${folder}/${n}`.toLowerCase());
        return n;
    };
    const card = brain.card ?? {};
    put('Card.md', `${fm({ name: brain.name, pronouns: brain.pronouns, aliases: brain.aliases })}# ${brain.name}\n\n${['who', 'looks', 'personality', 'voice', 'core'].filter(k => card[k]).map(k => `## ${k[0].toUpperCase() + k.slice(1)}\n${card[k]}`).join('\n\n')}\n`);
    put('Profile.md', `# Psychological profile\n\nAttachment: ${attachment(brain.personality)}\n\n## How ${brain.name} differs from the average person\n${profile(brain.personality, { pronouns: brain.pronouns })}\n`);
    const st = getState(brain);
    put('State.md', `# State\n\n- Mood: ${st.mood ?? '-'}\n- On their mind: ${st.on_mind.join('; ') || '-'}\n- Wants: ${st.wants.join('; ') || '-'}\n`);
    const people = new Map(rows.filter(m => m.kind === 'person').map(m => [norm(m.title), m.title]));
    const personLink = name => `[[${safe(people.get(norm(name)) ?? name)}]]`;
    put('Relationships.md', `# Relationships\n\n${getRelations(brain).map(r => `- ${personLink(r.target)}: ${RELATION_FIELDS.filter(f => r[f] != null).map(f => `${f} ${r[f]}`).join(', ')}${r.note ? `. ${r.note}` : ''}`).join('\n')}\n`);
    const titleOf = new Map();
    for (const m of rows) if (m.kind !== 'mind') titleOf.set(m.id, noteName(FOLDERS[m.kind] ?? 'Memories', m.title));
    const mentioned = new Set();
    for (const m of rows) {
        if (m.kind === 'mind') continue;
        m.about.forEach(a => mentioned.add(a));
        const links = [...m.about.map(a => `- ${personLink(a)}`), ...(m.links ?? []).filter(id => titleOf.has(id)).map(id => `- [[${titleOf.get(id)}]]`)];
        put(`${FOLDERS[m.kind] ?? 'Memories'}/${titleOf.get(m.id)}.md`, `${fm({ type: m.kind, keys: m.keys, strength: m.strength.toFixed(2), importance: m.importance.toFixed(2), scope: m.scope === 'chat' ? 'conversation' : 'core', evidence: m.evidence ? `"${m.evidence.replace(/"/g, "'")}"` : null })}${m.gist ? `> Gist: ${m.gist}\n\n` : ''}${m.body}\n\n## Links\n${links.join('\n')}\n`);
    }
    for (const name of mentioned) if (!people.has(norm(name))) put(`People/${noteName('People', name)}.md`, `${fm({ type: 'person' })}Someone in ${brain.name}'s life.\n`);
    // The human model only where this person has something of their own to say
    for (const m of rows.filter(r => r.kind === 'mind')) {
        const n = inThisPerson(m.title, brain.personality, brain.pronouns);
        if (!n) continue;
        put(`Mind/${safe(n.region)}/${safe(n.title)}.md`, `${fm({ type: 'mind', region: n.region })}## In ${brain.name}\n${m.body}\n${n.lines.length ? `\n## Their parameters\n${n.lines.map(l => `- ${l}`).join('\n')}\n` : ''}\n## In everyone (the human model)\n${n.general}\n`);
    }
    put('.obsidian/graph.json', JSON.stringify({ colorGroups: Object.entries(COLORS).map(([f, hex]) => ({ query: `path:"${f}"`, color: { a: 1, rgb: parseInt(hex.slice(1), 16) } })), showOrphans: true }, null, 2));
    return { filename: `${root}.zip`, data: zip(files) };
}
