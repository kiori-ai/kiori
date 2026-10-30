// Turns markdown vaults (the karakter-ai prototype's format) into brain files: a character vault, or a world vault with
// its characters' full brains under Characters/ and lighter cast cards under Cast/. Nothing is stored; the brains come
// back for whoever imports them to keep (kiori import writes them to a folder).
import fs from 'node:fs';
import path from 'node:path';
import { newBrain, addMemories, KINDS } from './brainfile.mjs';
import { neuron, normalize } from './personality.mjs';
import { clamp, norm } from './text.mjs';

function readNote(file) {
    const raw = fs.readFileSync(file, 'utf8');
    const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
    const meta = {};
    if (m) for (const line of m[1].split('\n')) {
        const kv = line.match(/^([\w-]+):\s*(.*)$/);
        if (!kv) continue;
        const v = kv[2].trim();
        meta[kv[1]] = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean) : v;
    }
    return { meta, body: m ? raw.slice(m[0].length) : raw };
}
const section = (body, name) => body.match(new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm'))?.[1]?.trim() ?? '';
const bold = (body, name) => body.match(new RegExp(`\\*\\*${name}:\\*\\*\\s*(.+)`))?.[1]?.trim() ?? '';
const linkTargets = text => [...String(text).matchAll(/\[\[(?:[^\]|#]*\/)?([^\]|#/]+)(?:[#|][^\]]*)?\]\]/g)].map(m => m[1].trim());
const mdFiles = dir => (fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(f => (f.isDirectory() ? (f.name.startsWith('.') || f.name === 'before' ? [] : mdFiles(path.join(dir, f.name))) : f.name.endsWith('.md') ? [path.join(dir, f.name)] : [])) : []);

const FOLDER_KIND = { Memories: 'memory', People: 'person', Places: 'place', Beliefs: 'belief', Feelings: 'feeling', Secrets: 'secret', Traits: 'trait', Skills: 'skill', Objects: 'object', Intentions: 'intention', Life: 'habit', Concepts: 'fact', Gist: 'memory' };

// From the card's own wording: "she ... her" or "he ... his"
export function guessPronouns(card) {
    const t = ` ${Object.values(card).filter(Boolean).join(' ').toLowerCase()} `;
    const count = re => (t.match(re) ?? []).length;
    const she = count(/\b(she|her|hers|herself)\b/g), he = count(/\b(he|him|his|himself)\b/g);
    return she > he * 1.5 && she >= 2 ? 'she' : he > she * 1.5 && he >= 2 ? 'he' : 'they';
}

function cardFrom(file) {
    const { meta, body } = readNote(file);
    const who = section(body, 'Identity') || bold(body, 'Who') || (typeof meta.tagline === 'string' ? meta.tagline : '');
    return {
        name: typeof meta.name === 'string' && meta.name ? meta.name : null,
        card: {
            who, looks: section(body, 'Appearance') || bold(body, 'Looks'),
            personality: bold(body, 'Personality') || '', core: section(body, 'Core'),
            voice: section(body, 'Speech style') || bold(body, 'Voice'),
            scenario: section(body, 'Scenario') || undefined, first_message: section(body, 'First message') || undefined,
            examples: section(body, 'Example dialogue') || undefined, tagline: typeof meta.tagline === 'string' ? meta.tagline : undefined,
        },
    };
}

function noteToMemory(file, folderKind) {
    const { meta, body } = readNote(file);
    const [text, linksPart = ''] = body.split(/^## Links\s*$/m);
    const title = path.basename(file, '.md').replace(/ ·\d+$/, '');
    const kind = KINDS.includes(meta.type) ? meta.type : meta.type === 'wound' ? 'feeling' : meta.type === 'cast-memory' ? 'memory' : folderKind;
    const strength = clamp(Number(meta.strength) || 0.5), importance = clamp(Number(meta.permanence ?? meta.importance) || strength);
    return {
        kind, title, body: text.replace(/^>\s*Gist:.*$/m, '').trim(),
        keys: Array.isArray(meta.keys) ? meta.keys : [], about: [],
        importance, strength, emotion: 0,
        links: linkTargets(linksPart).filter(t => t !== title),
    };
}

// "Kingpin (Wilson Fisk)" as a file name: the name, and the other name as an alias
const splitName = n => { const m = n.match(/^(.*?)\s*\(([^)]+)\)\s*$/); return m ? { name: m[1].trim(), aliases: [m[2].trim()] } : { name: n.trim(), aliases: [] }; };
const imported = (name, aliases, card, personality = {}) => newBrain({ name, aliases, pronouns: guessPronouns(card), card, personality: normalize(personality), build: 'full' });

// One character brain folder → a brain, and the side characters of its Cast/ folder
export function characterVaultBrains(dir, { lore = '', cast = true } = {}) {
    const { name, card } = cardFrom(path.join(dir, 'Card.md'));
    const params = fs.existsSync(path.join(dir, 'parameters.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'parameters.json'), 'utf8')) : {};
    const cname = name ?? path.basename(dir).replace(/\s*\(.*\)$/, '');
    const brain = imported(cname, [], { ...card, lore: lore || undefined }, params);
    const items = [];
    for (const [folder, kind] of Object.entries(FOLDER_KIND)) for (const f of mdFiles(path.join(dir, folder))) items.push(noteToMemory(f, kind));
    // The person neurons give names: memories that link to a person are about them
    const persons = new Set(items.filter(m => m.kind === 'person').map(m => m.title));
    for (const m of items) m.about = m.links.filter(l => persons.has(l));
    addMemories(brain, items, { scope: 'core', links: items.flatMap(m => m.links.map(to => ({ from: m.title, to }))) });
    // "In me" notes on the human model
    const notes = mdFiles(path.join(dir, 'Mind')).map(f => ({ title: path.basename(f, '.md'), note: section(readNote(f).body, 'In me') })).filter(n => n.note && neuron(n.title));
    addMemories(brain, notes.map(n => ({ kind: 'mind', title: neuron(n.title).title, body: n.note.replace(/^- /gm, '').trim(), importance: 0.5 })), { scope: 'core' });
    return [brain, ...(cast ? castBrains(dir, [cname]) : [])];
}

// Side characters: their card and their own memories (Cast Memories/), a small brain each
function castBrains(dir, skip = []) {
    const out = [];
    for (const f of mdFiles(path.join(dir, 'Cast'))) {
        const file = path.basename(f, '.md');
        const { name, aliases } = splitName(file);
        if (skip.includes(file) || skip.includes(name)) continue;
        const brain = imported(name, aliases, cardFrom(f).card);
        addMemories(brain, mdFiles(path.join(dir, 'Cast Memories')).filter(m => path.basename(m).startsWith(`${file} — `)).map(m => ({ ...noteToMemory(m, 'memory'), title: path.basename(m, '.md').slice(file.length + 3) })), { scope: 'core' });
        out.push(brain);
    }
    return out;
}

// A vault → its brains (a world vault: its lore goes into each brain's card). Someone named twice is kept once.
export function vaultBrains(dir) {
    if (!fs.existsSync(path.join(dir, 'Card.md'))) throw new Error(`No Card.md in ${dir}`);
    const { meta, body } = readNote(path.join(dir, 'Card.md'));
    if (meta.type !== 'world') return { world: null, brains: characterVaultBrains(dir) };
    const lore = ['Setting', 'Tone', 'Rules of this world'].map(s => section(body, s) && `${s}: ${section(body, s)}`).filter(Boolean).join('\n\n');
    const full = fs.existsSync(path.join(dir, 'Characters')) ? fs.readdirSync(path.join(dir, 'Characters')).filter(n => fs.existsSync(path.join(dir, 'Characters', n, 'Card.md'))) : [];
    const brains = full.flatMap(n => characterVaultBrains(path.join(dir, 'Characters', n), { lore, cast: false }));
    for (const b of castBrains(dir, full)) { b.card.lore = lore || undefined; if (!b.card.lore) delete b.card.lore; brains.push(b); }
    const seen = new Set();
    return { world: typeof meta.name === 'string' ? meta.name : path.basename(dir), lore: Boolean(lore), brains: brains.filter(b => !seen.has(norm(b.name)) && seen.add(norm(b.name))) };
}
