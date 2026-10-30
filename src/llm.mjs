// The models behind the organizer and the auditor. Any OpenAI-compatible endpoint works (OpenRouter by default,
// so a customer can point Kiori at any model). A project either runs on this Kiori's own key ('server') or brings
// its own ('own': the customer's provider, key and model, from the project's settings). Every call is metered: which
// project, what for, which model and what it cost; never what was said.
import net from 'node:net';
import { config } from './config.mjs';
import { run, now, one, json } from './db.mjs';
import { unseal, bindOf } from './secrets.mjs';
import { DIM } from './brainfile.mjs';
import { safeFetch, isPublicAddress, readAnswer, answerJson } from './net.mjs';
import { scrub, trimSlashes } from './text.mjs';

// upstream: the model provider's HTTP status, when the provider answered with an error
export class LLMError extends Error {
    constructor(message, code, upstream = null) { super(message); this.code = code; if (upstream) this.upstream = upstream; }
}

export const OPENROUTER = 'https://openrouter.ai/api/v1';
const isOpenRouter = url => /^https:\/\/openrouter\.ai(\/|$)/.test(String(url));
const bad = message => Object.assign(new Error(message), { status: 400, code: 'BAD_REQUEST' });
// A model provider's address, as customers give it: only https on the internet (nothing on this machine or a private
// network, so Kiori can't be made to call into one), unless KIORI_PROXY_ALLOW_LOCAL=1. This is the quick look at the
// address as written; a name is checked again for what it points to, each time it's called (see net.mjs).
export function providerUrl(url) {
    const raw = String(url ?? '').trim();
    if (raw.length > 300) throw bad('A model provider address is at most 300 characters');
    let u;
    try { u = new URL(raw); } catch { throw bad('Not a URL'); }
    // The API's paths go after it (/chat/completions, /models): a ? or # would carry them off into a query or a fragment
    // and leave the call on whatever path came before
    if (/[?#]/.test(u.href)) throw bad('A model provider address ends at its path, like https://openrouter.ai/api/v1 (no ? or # part)');
    if (config.proxyAllowLocal) return trimSlashes(u.href);
    // A name may end with a dot ("x.local." is x.local): it goes before the name is looked at
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.+$/, '');
    const local = net.isIP(host) ? !isPublicAddress(host) : host === 'localhost' || /\.(localhost|local|internal|home\.arpa)$/.test(host) || !host.includes('.');
    if (u.protocol !== 'https:' || local || u.username || u.password) throw bad('A model provider must be an https address on the internet (KIORI_PROXY_ALLOW_LOCAL=1 allows a local one)');
    return trimSlashes(u.href);
}
// How a call to a provider leaves: this server's own model address (KIORI_LLM_BASE_URL) as it was configured; every
// other one, and every call with a customer's key, through safeFetch (public internet only). A redirect is never
// followed, either way: it comes back as the answer.
const plain = (url, init) => fetch(url, { ...init, redirect: 'manual' });
const transport = trusted => (trusted || config.proxyAllowLocal ? plain : safeFetch);

// Who pays for a project's model calls, with which provider and models
export function credentialsFor(project) {
    const p = project ? one('SELECT llm_mode, settings FROM projects WHERE id = ?', project) : null;
    if (!p || p.llm_mode !== 'own') {
        const { key, baseUrl, organizer, auditor, embed, fallback } = config.llm;
        return { key, baseUrl, organizer, auditor, embed, fallback, own: false };
    }
    const s = json(p.settings, {}).llm ?? {};
    const baseUrl = trimSlashes(String(s.base_url || OPENROUTER));
    const onOpenRouter = isOpenRouter(baseUrl);
    // One model does the brain work (model, picked in the console); organizer and auditor are older, separate settings
    return {
        key: unseal(s.key_sealed ?? s.key, bindOf(project, 'llm')), baseUrl, own: true,
        organizer: s.model || s.organizer || config.llm.organizer, auditor: s.model || s.auditor || s.organizer || config.llm.auditor,
        embed: s.embed || config.llm.embed,
        // The fallback model is an OpenRouter name; elsewhere there is none
        fallback: onOpenRouter ? config.llm.fallback : null,
    };
}
const needsKey = () => new LLMError('This project has no brain API key yet: add yours in the console, or with PATCH /v1/project { "llm": { "key": "..." } }', 'NEEDS_KEY');
// For work that can't be done without a model: fail at once, with the reason
export function requireModelKey(project) {
    if (!credentialsFor(project).key) throw credentialsFor(project).own ? needsKey() : new LLMError('No model key configured: set KIORI_LLM_KEY in .env', 'NO_KEY');
}

// What a provider says a call used, as a number that can be added up (an answer can say anything)
const count = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
function meter(project, op, model, usage) {
    run('INSERT INTO usage (project_id, at, op, model, prompt_tokens, completion_tokens, cost) VALUES (?, ?, ?, ?, ?, ?, ?)',
        project ?? null, now(), op, model, count(usage?.prompt_tokens), count(usage?.completion_tokens), Math.min(count(usage?.cost), 100));
}

// On OpenRouter, the same model is served by several providers: take the fastest
const fastest = (body, cred) => (isOpenRouter(cred.baseUrl) && config.llm.providerSort ? { ...body, provider: { sort: config.llm.providerSort } } : body);

// Answers worth asking again: the provider (or the gateway in front of it) was busy or briefly down
const TRANSIENT = new Set([408, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);
const sleep = ms => new Promise(r => setTimeout(r, ms));
// Retry-After in milliseconds (it's seconds, or a date); null when there is none
export function retryAfterMs(headers) {
    const v = headers?.get('retry-after');
    if (v == null || v === '') return null;
    const seconds = Number(v);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
    const at = Date.parse(v);
    return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

// fetch to a model provider, asked again (twice at most) when it was busy, briefly down or out of reach: after its
// Retry-After when it gives one, else after about half a second, then a second. Not asked again: a timeout or a
// hang-up (the model may still be at it), an address that was refused, and a provider that asks to wait more than 10
// seconds. trusted: this server's own model address (see transport).
const LOOKUP_FAILED = new Set(['ENOTFOUND', 'ETIMEOUT', 'ENODATA', 'ESERVFAIL', 'EREFUSED', 'EBADNAME', 'EAI_AGAIN', 'EAI_NONAME']);
export async function fetchProvider(url, init, { tries = 3, trusted = false } = {}) {
    const go = transport(trusted);
    for (let attempt = 1; ; attempt++) {
        let res;
        try {
            res = await go(url, init);
        } catch (e) {
            // A customer's name that couldn't be looked up isn't asked again: its name server answers no better a
            // moment later, and each try would wait out the lookup's time limit once more
            if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.status || attempt >= tries || (!trusted && LOOKUP_FAILED.has(e?.cause?.code))) throw e;
            await sleep(500 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
            continue;
        }
        if (!TRANSIENT.has(res.status) || attempt >= tries) return res;
        const after = retryAfterMs(res.headers);
        if (after != null && after > 10000) return res;
        await res.body?.cancel().catch(() => {});
        await sleep(after ?? 500 * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5));
    }
}

async function post(pathname, body, cred) {
    if (!cred.key) throw cred.own ? needsKey() : new LLMError('No model key configured: set KIORI_LLM_KEY in .env', 'NO_KEY');
    let res;
    try {
        res = await fetchProvider(`${cred.baseUrl}${pathname}`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${cred.key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(180000),
        }, { trusted: !cred.own });
    } catch (e) {
        if (e?.status) throw e;
        throw new LLMError(e?.name === 'TimeoutError' ? 'The model provider did not answer within 3 minutes' : `Can't reach the model provider (${e?.cause?.code ?? e?.message})`, 'PROVIDER');
    }
    if (res.status === 402 || (cred.own && (res.status === 401 || res.status === 403))) await res.body?.cancel().catch(() => {});
    if (res.status === 402) throw new LLMError(cred.own ? 'Your model provider says your key is out of credits.' : 'The model provider is out of credits.', 'CREDITS');
    if (cred.own && (res.status === 401 || res.status === 403)) throw new LLMError(`Your model provider refused your key (${res.status}): check your brain API key in the console`, 'BAD_KEY');
    // The provider's own words go along (a few hundred characters), with anything that looks like a key blanked out
    if (!res.ok) throw new LLMError(`Model provider error ${res.status}: ${scrub((await readAnswer(res, 64e3).catch(() => '')).slice(0, 300), cred.key)}`, 'PROVIDER', res.status);
    // An answer that isn't JSON at all: said so without quoting it. One too big to read is a failure of its own
    let data;
    try { data = await answerJson(res); } catch (e) { throw new LLMError(e.message, 'PROVIDER'); }
    if (data === null) throw new LLMError('The model provider sent an answer that is not JSON', 'PROVIDER');
    return data;
}
// Mistakes a retry won't fix
const FINAL = ['CREDITS', 'NO_KEY', 'NEEDS_KEY', 'BAD_KEY'];

// Fill what a model left out from the schema (an empty list, '', 0), so one missing field doesn't sink a call
// Held to sizes no real answer comes near (a list of 500, a text of 8000 characters): what a model sends, or an address
// posing as one, is never trusted to be small
export function fitSchema(value, schema) {
    if (schema.type === 'array') return Array.isArray(value) ? value.slice(0, 500).map(v => fitSchema(v, schema.items ?? {})) : [];
    if (schema.type === 'object') {
        const o = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
        for (const [k, s] of Object.entries(schema.properties ?? {})) o[k] = fitSchema(o[k], s);
        return o;
    }
    if (schema.type === 'string') return (typeof value === 'string' ? value : value == null ? '' : String(value)).slice(0, 8000);
    // A number the model left out (missing, null or "") stays unknown, so what it would change keeps its earlier value
    if (schema.type === 'number' || schema.type === 'integer') return value == null || value === '' || !Number.isFinite(Number(value)) ? null : Number(value);
    if (schema.type === 'boolean') return !!value;
    return value;
}

// A JSON answer that matches the schema. A broken or mostly empty answer is asked again (twice at most); a provider
// still failing after post's own retries is only tried once more, on the fallback model (there's one on OpenRouter).
// validate(result) may return a string saying what's wrong: the answer is then asked for again
// role: 'organizer' or 'auditor', the project's model for it (model overrides)
export async function askJSON({ role = 'organizer', model = null, prompt, schema, project, op, maxTokens = 8000, temperature = 0.3, validate = null }) {
    const cred = credentialsFor(project);
    const main = model ?? cred[role];
    const fields = Object.keys(schema.properties ?? {});
    let lastError;
    for (let attempt = 1; attempt <= 3; attempt++) {
        const useModel = attempt === 3 && cred.fallback ? cred.fallback : main;
        try {
            const r = await post('/chat/completions', fastest({
                model: useModel, temperature, max_tokens: maxTokens, usage: { include: true },
                response_format: { type: 'json_object' },
                messages: [{ role: 'user', content: `${prompt}\n\nReturn only JSON matching this schema (every field required; use [] or "" when empty):\n${JSON.stringify(schema)}` }],
            }, cred), cred);
            meter(project, op, useModel, r.usage);
            // Not JSON: asked again. The parser's own message quotes the answer, so it goes no further (a log would keep it)
            let parsed;
            try { parsed = JSON.parse(String(r.choices?.[0]?.message?.content ?? '').replace(/^\s*```(?:json)?|```\s*$/g, '').trim()); }
            catch { lastError = new LLMError("The model's answer was not valid JSON", 'INCOMPLETE'); continue; }
            if (parsed?.type === 'object' && parsed.properties) parsed = parsed.properties;  // some models echo the schema
            const filled = fields.filter(f => parsed?.[f] != null).length;
            if (filled >= Math.ceil(fields.length * 0.6)) {
                const result = fitSchema(parsed, schema);
                const problem = validate?.(result);
                if (!problem || problem === true) return result;
                lastError = new LLMError(`Answer rejected: ${problem}`, 'INCOMPLETE');
                continue;
            }
            lastError = new LLMError(`Incomplete answer (${filled}/${fields.length} fields)`, 'INCOMPLETE');
        } catch (e) {
            if ((e instanceof LLMError && FINAL.includes(e.code)) || e?.status) throw e;
            lastError = e;
            if (e instanceof LLMError && e.code === 'PROVIDER') {
                if (!cred.fallback || useModel === cred.fallback) throw e;
                attempt = 2;   // so the next attempt is the fallback model's
            }
        }
    }
    throw lastError;
}

// Meaning fingerprints for recall by meaning. Returns null when switched off, without a key, or failing (recall then
// uses words). Models that can shorten their vectors are asked for as many numbers as a brain keeps (DIM).
export async function embed(texts, project) {
    const cred = credentialsFor(project);
    if (!config.llm.embedOn || !cred.key || !texts.length) return null;
    try {
        const out = [];
        for (let i = 0; i < texts.length; i += 96) {
            const r = await post('/embeddings', { model: cred.embed, input: texts.slice(i, i + 96), ...(/text-embedding-3/.test(cred.embed) && { dimensions: DIM }) }, cred);
            meter(project, 'embed', cred.embed, r.usage);
            for (const d of r.data) {
                const v = Float32Array.from(d.embedding);
                const n = Math.hypot(...v) || 1;
                for (let j = 0; j < v.length; j++) v[j] /= n;
                out.push(v);
            }
        }
        return out;
    } catch (e) {
        if (e.code === 'CREDITS') throw e;
        return null;
    }
}
