// Kiori JavaScript client. Works in Node 18+ and browsers (fetch). Types: kiori.d.ts.
//
// Kiori stores no brains and no chats. A brain is a JSON object you keep (in your database, or on your player's
// device) and send with each call; calls that change it give it back.
//
//   import { Kiori } from './kiori.mjs';
//   const kiori = new Kiori({ apiKey: process.env.KIORI_API_KEY });
//   // once per character: a brain from its card. Keep it, and start each new conversation from a copy of it
//   let brain = await kiori.create({ character_card: card });
//   // every turn: what the character knows right now, for your prompt (the recent messages are enough)
//   const recent = messages.slice(-60);
//   const { text, check_recommended } = await kiori.recall({ brain, messages: recent });
//   // after the reply: the brain learns from the chat; keep the brain that comes back
//   ({ brain } = await kiori.organize({ brain, messages: messages.slice(-60) }));
//   // optionally, when check_recommended: let the auditor check your model's draft before it's shown
//   const verdict = await kiori.check({ brain, messages: recent, draft: reply });
//
// A call is asked again on its own (twice at most) when Kiori or the model provider is briefly unavailable or out of
// reach. That's safe: Kiori keeps nothing between calls, so the same brain in gives the same kind of brain out.

// status is the HTTP status, or 0 when Kiori couldn't be reached (code NETWORK) or didn't answer in time (TIMEOUT);
// retryAfter is the seconds Kiori asked to wait (Retry-After), when it did; requestId is the call's id, to quote when
// you write to us about it
export class KioriError extends Error {
    constructor(status, body, retryAfter = null, requestId = null) {
        super(body?.error?.message ?? `HTTP ${status}`);
        this.status = status;
        this.code = body?.error?.code;
        if (retryAfter != null) this.retryAfter = retryAfter;
        const id = body?.error?.request_id ?? requestId;
        if (id) this.requestId = id;
    }
}

// Retry-After in seconds (it's seconds, or a date); null when there is none
const secondsAfter = v => {
    if (v == null || v === '') return null;
    if (Number.isFinite(Number(v))) return Math.max(0, Number(v));
    const at = Date.parse(v);
    return Number.isFinite(at) ? Math.max(0, (at - Date.now()) / 1000) : null;
};
// Asked again: Kiori or the model provider was busy or briefly down (or a gateway in front of them failed), or Kiori
// was out of reach. Not a timeout (the work may still be going on), not a key or credit problem, not answers that stayed
// unusable after Kiori's own tries (INCOMPLETE), and not when Kiori asks to wait more than 20 seconds. A call that isn't
// safe to repeat (a new key) is asked again only after a 429.
const AGAIN = new Set([408, 429, 502, 503, 520, 521, 522, 523, 530]);
const FINAL = new Set(['NEEDS_KEY', 'NO_KEY', 'BAD_KEY', 'CREDITS', 'INCOMPLETE']);
function retryDelay(e, attempt, safe) {
    const again = e.code === 'NETWORK' ? safe : AGAIN.has(e.status) && !FINAL.has(e.code) && (safe || e.status === 429);
    if (!again) return null;
    if (e.retryAfter != null) return e.retryAfter <= 20 ? e.retryAfter * 1000 : null;
    return 1000 * 2 ** attempt * (0.75 + Math.random() * 0.5);
}

export class Kiori {
    // timeout: per request; building a full brain takes about a minute. maxRetries: how many times a call is asked
    // again when Kiori or the model provider is briefly unavailable (after Retry-After, else about 1 s, then 2 s); 0 never
    constructor({ apiKey, baseUrl = 'https://api.kiori.io', timeout = 150000, maxRetries = 2 } = {}) {
        if (!apiKey) throw new Error('Kiori: apiKey is required');
        // Left out when the client is printed or turned into JSON, so a log line never holds the key
        Object.defineProperty(this, 'apiKey', { value: apiKey, writable: true, configurable: true, enumerable: false });
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.timeout = timeout;
        this.maxRetries = maxRetries;
        const r = (m, p, b, o) => this.request(m, p, b, o);
        const q = o => { const s = new URLSearchParams(Object.entries(o ?? {}).filter(([, v]) => v != null)).toString(); return s ? `?${s}` : ''; };
        this.project = {
            get: () => r('GET', '/v1/project'),
            // { name }, { llm: { key } } (your brain API key: the provider is recognized from it), { llm: { model } }
            update: body => r('PATCH', '/v1/project', body),
            // The models your brain API key can use, the suggested one first
            models: () => r('GET', '/v1/project/models'),
            usage: days => r('GET', `/v1/usage${q({ days })}`),
            keys: {
                create: label => r('POST', '/v1/project/keys', { label }, { safe: false }),
                revoke: prefix => r('DELETE', `/v1/project/keys/${encodeURIComponent(prefix)}`),
            },
        };
    }

    // A new brain. From a character card (character_card: Tavern v1/v2/v3 JSON, or a card PNG in base64), or from name,
    // description and lore. depth: 'full' (a whole past, about a minute, on your brain API key) or 'light' (free, at once)
    async create(body) { return (await this.request('POST', '/v1/brains', body)).brain; }
    // What each character knows right now: { text (one brain), characters, check_recommended }
    recall(body) { return this.request('POST', '/v1/brains/recall', body); }
    // The chat moved on: { brain (or brains), learned, rewound, waiting }. Send the recent messages as they are now,
    // oldest first, with your message ids if you have them (edits and rerolls are noticed), and keep what comes back
    organize(body) { return this.request('POST', '/v1/brains/organize', body); }
    // A draft reply checked against what each character knows: { ok, issues, fixed }
    check(body) { return this.request('POST', '/v1/brains/check', body); }
    // A brain as an Obsidian vault: the zip's bytes
    exportObsidian(brain) { return this.raw('POST', '/v1/brains/export', { brain }, { read: async res => new Uint8Array(await res.arrayBuffer()) }); }
    // The 41 personality dimensions and the archetypes
    personality() { return this.request('GET', '/v1/personality'); }

    // safe: false for a call that isn't safe to repeat (see retryDelay). read: how the answer is read (the Response
    // itself by default); it's read within the try, so an answer cut off halfway is asked again like any other failure
    async raw(method, path, body, { safe = true, read = res => res } = {}) {
        for (let attempt = 0; ; attempt++) {
            let failure;
            try {
                const res = await fetch(this.baseUrl + path, {
                    method,
                    headers: { Authorization: `Bearer ${this.apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
                    body: body ? JSON.stringify(body) : undefined,
                    // Kiori never redirects: a redirect means baseUrl leads somewhere else, and following it would
                    // take the call (and the brain in it) there
                    redirect: 'manual',
                    signal: this.timeout ? AbortSignal.timeout(this.timeout) : undefined,
                });
                if (res.ok) return await read(res);
                if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) failure = new KioriError(res.status, { error: { message: `${this.baseUrl} answered with a redirect, and Kiori never redirects: check baseUrl`, code: 'REDIRECT' } });
                else failure = new KioriError(res.status, await res.json().catch(() => null), secondsAfter(res.headers.get('retry-after')), res.headers.get('x-request-id'));
            } catch (e) {
                const late = e?.name === 'TimeoutError' || e?.name === 'AbortError';
                failure = new KioriError(0, { error: { message: late ? `Kiori did not answer within ${this.timeout < 1000 ? `${this.timeout} ms` : `${Math.round(this.timeout / 1000)} s`}` : `Can't reach Kiori at ${this.baseUrl} (${e?.cause?.code ?? e?.message})`, code: late ? 'TIMEOUT' : 'NETWORK' } });
            }
            const wait = attempt < this.maxRetries ? retryDelay(failure, attempt, safe) : null;
            if (wait == null) throw failure;
            await new Promise(r => setTimeout(r, wait));
        }
    }
    request(method, path, body, options) {
        return this.raw(method, path, body, { ...options, read: res => res.json() });
    }
}
