// The Average Human Model: 296 neurons of shared human psychology and 41 personality parameters.
// It is stored once. A character keeps only its own values (0-100, 50 = average person) and a few notes of its
// own on some neurons ("in me"); everything else it shares with every other character.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { tokens, withPronouns } from './text.mjs';

const MODEL = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'human-model.json'), 'utf8'));
export const PARAMS = MODEL.params;
export const ARCHETYPES = MODEL.archetypes;
export const NEURONS = MODEL.neurons;
const BY_TITLE = new Map(NEURONS.map(n => [n.title.toLowerCase(), n]));
export const neuron = title => BY_TITLE.get(String(title ?? '').toLowerCase()) ?? null;

export const LEVEL_NAMES = ['very low', 'low', 'average', 'high', 'very high'];
export const level = v => (v <= 20 ? 0 : v <= 40 ? 1 : v < 60 ? 2 : v < 80 ? 3 : 4);

// Every parameter, 0-100, missing ones average; an archetype gives the starting point
export function normalize(values = {}, archetype = null) {
    const base = ARCHETYPES.find(a => a.id === archetype)?.values ?? {};
    return Object.fromEntries(PARAMS.map(p => {
        const v = Number(values[p.id] ?? base[p.id] ?? 50);
        return [p.id, Math.round(Math.min(100, Math.max(0, Number.isFinite(v) ? v : 50)))];
    }));
}

// How this person differs from the average, strongest deviations first
export function deviations(values, max = Infinity) {
    return PARAMS.map(p => ({ p, v: values[p.id] ?? 50 }))
        .filter(({ v }) => level(v) !== 2)
        .sort((a, b) => Math.abs(b.v - 50) - Math.abs(a.v - 50))
        .slice(0, max)
        .map(({ p, v }) => ({ id: p.id, name: p.name, group: p.group, value: v, level: LEVEL_NAMES[level(v)], text: p.levels[level(v)] }));
}

export function profile(values, { pronouns = 'they', max = Infinity } = {}) {
    const d = deviations(values, max);
    if (!d.length) return 'An average person on every dimension.';
    return d.map(x => `- ${x.name} ${x.level} (${x.value}): ${withPronouns(x.text, pronouns)}`).join('\n');
}

export function attachment(values) {
    const anx = values.baglanma_kaygisi ?? 50, avo = values.baglanma_kacinmasi ?? 50;
    return anx < 50 && avo < 50 ? 'secure' : anx >= 50 && avo < 50 ? 'anxious' : anx < 50 ? 'avoidant' : 'fearful-avoidant';
}

// One neuron as it works in this person: the general mechanism and the lines their parameters add
export function inThisPerson(title, values, pronouns = 'they') {
    const n = neuron(title);
    if (!n) return null;
    const lines = [];
    for (const p of PARAMS) {
        if (!p.neurons.includes(n.title)) continue;
        const v = values[p.id] ?? 50;
        if (level(v) !== 2) lines.push(`${p.name} ${LEVEL_NAMES[level(v)]}: ${withPronouns(p.levels[level(v)], pronouns)}`);
    }
    return { title: n.title, region: n.region, general: n.text, lines };
}

// Which human-model mechanisms a moment touches (by their trigger words), most specific first
const NEURON_KEYS = NEURONS.filter(n => n.kind !== 'hub').map(n => ({ n, keys: new Set([...n.keys.flatMap(k => tokens(k)), ...tokens(n.title)]) }));
export function mindFor(text, max = 2) {
    const t = new Set(tokens(text));
    return NEURON_KEYS.map(({ n, keys }) => ({ n, hits: [...keys].filter(k => t.has(k)).length }))
        .filter(x => x.hits > 0)
        .sort((a, b) => b.hits - a.hits)
        .slice(0, max)
        .map(x => x.n.title);
}

// The parameter list, for the organizer when it rates a new character
export const PARAM_GUIDE = PARAMS.map(p => `${p.id}: ${p.name} (low: ${p.low} / high: ${p.high})`).join('\n');
export const NEURON_TITLES = NEURONS.filter(n => n.kind !== 'hub').map(n => n.title);
