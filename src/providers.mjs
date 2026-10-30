// Brain API keys. From the key alone Kiori knows the provider (and with it the address and the embedding model),
// checks that the key works, and lists the models it can use with one suggested. A customer pastes a key and, if
// they like, picks a model; there is nothing else to fill in.
import { getProject, updateProject } from './accounts.mjs';
import { credentialsFor, providerUrl, fetchProvider, OPENROUTER } from './llm.mjs';
import { answerJson } from './net.mjs';

const fail = (status, message, code = 'BAD_REQUEST') => { throw Object.assign(new Error(message), { status, code }); };

// picks: the short list shown first, recommended one first (only those the provider really lists are shown).
// prefer: for providers without picks, patterns for a fast, cheap model, tried in order.
export const PROVIDERS = [
    { id: 'openrouter', name: 'OpenRouter', match: /^sk-or-/, url: OPENROUTER, embed: 'openai/text-embedding-3-small', check: ['/key', '/auth/key'],
        picks: [['anthropic/claude-haiku-5.5', 'Fast and cheap, and plenty for building and organizing brains.'], ['anthropic/claude-sonnet-5.5', 'Richer memories and sharper checks, but slower and pricier.'], ['deepseek/deepseek-v3.2', 'The cheapest, but slow to build new brains.']] },
    { id: 'anthropic', name: 'Anthropic', match: /^sk-ant-/, unsupported: "Anthropic keys can't be used directly yet (their API speaks another format). An OpenRouter key reaches Claude too." },
    { id: 'gemini', name: 'Gemini', match: /^AIza/, url: 'https://generativelanguage.googleapis.com/v1beta/openai', embed: 'gemini-embedding-001', prefer: [/flash(?!.*(lite|image|tts|audio|live|exp))/i, /flash/i] },
    { id: 'openai', name: 'OpenAI', match: /^sk-/, url: 'https://api.openai.com/v1', embed: 'text-embedding-3-small', prefer: [/^gpt-[\d.]+-mini$/, /mini(?!.*(audio|realtime|search|transcribe|tts))/] },
];
const NOT_CHAT = /embed|whisper|tts|dall-e|image|audio|realtime|moderation|transcribe|search-preview|-instruct$/i;
// An answer whose body isn't needed, let go of (so its connection is free again)
const drain = r => r.body?.cancel().catch(() => {});

// Which provider a key is from (or why it can't be used)
export function detectProvider(key) {
    const k = String(key ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!k) fail(400, 'Paste your brain API key');
    const p = PROVIDERS.find(x => x.match.test(k));
    if (!p) fail(400, "That isn't a key Kiori recognizes: an OpenRouter, OpenAI or Gemini key is needed (check you copied all of it)", 'UNKNOWN_KEY');
    if (p.unsupported) fail(400, p.unsupported, 'UNSUPPORTED_KEY');
    return p;
}

const versionOf = id => (String(id).match(/\d+(?:\.\d+)*/g) ?? []).flatMap(x => x.split('.').map(Number));
const newerFirst = (a, b) => { const va = versionOf(a), vb = versionOf(b); for (let i = 0; i < Math.max(va.length, vb.length); i++) if ((vb[i] ?? 0) !== (va[i] ?? 0)) return (vb[i] ?? 0) - (va[i] ?? 0); return a.localeCompare(b); };
// Gemini lists its models as "models/gemini-…"; the chat API takes the bare name
const bare = id => String(id).replace(/^models\//, '');

// The models a key can chat with, from the provider itself. A new key the provider refuses is bad input (400); the
// saved one (saved: true) is refused the way the rest of the API says it (402 BAD_KEY)
async function providerModels(url, key, { saved = false } = {}) {
    let r;
    try { r = await fetchProvider(`${url}/models`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) }, { tries: 1 }); }
    catch (e) { if (e?.status) throw e; fail(502, `Couldn't reach the model provider (${e?.cause?.code ?? e?.message})`, 'PROVIDER'); }
    if (!r.ok) await drain(r);
    if (r.status === 401 || r.status === 403) fail(saved ? 402 : 400, saved ? `Your model provider refused your brain API key (${r.status}): check it in the console` : `Your model provider refused this key (${r.status})`, 'BAD_KEY');
    if (!r.ok) fail(502, `The model provider answered ${r.status} when asked for its models`, 'PROVIDER');
    const data = await answerJson(r);
    return (Array.isArray(data?.data) ? data.data : []).filter(m => m?.id && !NOT_CHAT.test(m.id)).map(m => ({ id: bare(m.id), name: typeof m.name === 'string' ? m.name : null }));
}

// OpenRouter lists its models to anyone, so the key itself is checked on its own address
async function checkKey(p, url, key) {
    for (const path of p.check ?? []) {
        let r;
        try { r = await fetchProvider(`${url}${path}`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) }, { tries: 1 }); }
        catch (e) { if (e?.status) throw e; fail(502, `Couldn't reach the model provider (${e?.cause?.code ?? e?.message})`, 'PROVIDER'); }
        await drain(r);
        if (r.status === 404) continue;
        if (r.status === 401 || r.status === 403) fail(400, `Your model provider refused this key (${r.status})`, 'BAD_KEY');
        if (r.ok) return;
    }
}

// The short list first (recommended first), then everything else the key can use
function pickList(p, models, current) {
    const ids = new Set(models.map(m => m.id));
    const picks = (p?.picks ?? []).filter(([id]) => ids.has(id)).map(([id, hint], i) => ({ id, name: models.find(m => m.id === id)?.name ?? id, hint, recommended: i === 0 }));
    const suggested = picks[0]?.id ?? (p?.prefer ?? []).map(re => models.map(m => m.id).filter(id => re.test(id)).sort(newerFirst)[0]).find(Boolean) ?? models[0]?.id ?? null;
    if (!picks.length && suggested) picks.push({ id: suggested, name: models.find(m => m.id === suggested)?.name ?? suggested, hint: 'A fast, cheap model from this provider, picked by Kiori.', recommended: true });
    const rest = models.filter(m => !picks.some(x => x.id === m.id)).sort((a, b) => a.id.localeCompare(b.id));
    return { suggested, current: current ?? suggested, picks, models: rest };
}

// The project's brain key as the console shows it: provider, the last four characters, the model, and the choices
export async function brainKeyView(project, { withModels = true } = {}) {
    const llm = getProject(project)?.settings?.llm ?? {};
    const cred = credentialsFor(project);
    if (!cred.own) return { set: Boolean(cred.key), provider: 'server', model: cred.organizer };
    if (!cred.key) return { set: false };
    const p = PROVIDERS.find(x => x.id === llm.provider) ?? null;
    const view = { set: true, provider: p?.name ?? 'Custom', base_url: cred.baseUrl, key: `…${cred.key.slice(-4)}`, model: cred.organizer };
    if (!withModels) return view;
    return { ...view, ...pickList(p, await providerModels(cred.baseUrl, cred.key, { saved: true }), cred.organizer) };
}

// Saving the brain key: { key } (the provider is recognized and the key checked), { model } (one the key can use),
// both, or null to remove it. base_url is for other OpenAI-compatible providers, set through the API.
export async function setBrainKey(project, patch) {
    if (patch === null) { updateProject(project, { settings: { llm: null } }); return { set: false }; }
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) fail(400, 'llm must be an object: { key, model }');
    const prev = getProject(project)?.settings?.llm ?? {};
    const key = patch.key == null ? null : String(patch.key).replace(/^Bearer\s+/i, '').trim();
    let next;
    if (key) {
        const custom = patch.base_url ? providerUrl(patch.base_url) : null;
        const p = custom ? null : detectProvider(key);
        const url = custom ?? p.url;
        if (p) await checkKey(p, url, key);
        const models = await providerModels(url, key);
        const list = pickList(p, models, null);
        const model = patch.model ? String(patch.model).trim() : list.suggested;
        if (patch.model && models.length && !models.some(m => m.id === model)) fail(400, `Your provider doesn't list a model "${model}" for this key`, 'UNKNOWN_MODEL');
        next = { provider: p?.id ?? 'custom', base_url: url, key, embed: p?.embed ?? patch.embed ?? undefined, model, organizer: null, auditor: null };
    } else if (patch.model != null) {
        if (!prev.key_sealed && !prev.key) fail(400, 'Add your brain API key first');
        const model = String(patch.model).trim();
        if (!model) fail(400, 'model must be a model id');
        const cred = credentialsFor(project);
        const models = await providerModels(cred.baseUrl, cred.key, { saved: true });
        if (models.length && !models.some(m => m.id === model)) fail(400, `Your provider doesn't list a model "${model}" for this key`, 'UNKNOWN_MODEL');
        next = { model, organizer: null, auditor: null };
    } else fail(400, 'Send { key } to set your brain API key, { model } to change the model, or null to remove it');
    updateProject(project, { settings: { llm: next } });
    return brainKeyView(project);
}
