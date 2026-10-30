// The drop-in. Point the chat calls you already make at Kiori (OpenAI-compatible: base URL .../v1, your Kiori key as
// the API key) and send the brains with them: "kiori": { "brain": ... } (or "brains" for a group chat) in the body.
// Kiori puts each character's mind into the system prompt, passes the request on to your model with your brain API
// key (or another provider of yours), and sends the reply back. Streaming works. With check (by default when the
// player brings up the past) the reply is held, checked by the auditor and fixed, then sent. Nothing is kept: the
// brains learn from the chat when you call POST /v1/brains/organize.
import { getProject, keptKey } from './accounts.mjs';
import { textOf, num, scrub } from './text.mjs';
import { once } from 'node:events';
import { credentialsFor, providerUrl, fetchProvider } from './llm.mjs';
import { answerJson } from './net.mjs';
import { readBrains } from './brainfile.mjs';
import { recall } from './recall.mjs';
import { checkReply, MAX_DRAFT } from './check.mjs';

const fail = (status, message, code = 'BAD_REQUEST') => { throw Object.assign(new Error(message), { status, code }); };
export const DEFAULT_UPSTREAM = 'https://openrouter.ai/api/v1';

// The brains and how: "kiori": { brain | brains, player, check, budget } in the body; X-Kiori-Player and X-Kiori-Check
// headers win over the body
function options(ctx) {
    const h = ctx.headers ?? {};
    const k = ctx.body.kiori && typeof ctx.body.kiori === 'object' && !Array.isArray(ctx.body.kiori) ? ctx.body.kiori : null;
    if (!k || (k.brain == null && k.brains == null)) fail(400, 'Send the brain with the chat: "kiori": { "brain": ... } in the body (or "brains" for a group chat), as POST /v1/brains returned it');
    const { brains } = readBrains(k);
    return {
        brains,
        player: h['x-kiori-player'] ?? k.player ?? null,
        check: String(h['x-kiori-check'] ?? k.check ?? 'auto').toLowerCase(),
        budget: num(k.budget, 6000, 200, 60000),
    };
}

// Where the request goes on to, and with which key. A key sent with the request goes where the request says
// (X-Kiori-Upstream-Url, or OpenRouter). A key Kiori keeps for a project only ever goes back to the address it was
// saved with: the project's upstream { url, key }, or its brain API key's own provider. An address sent without a key
// is refused, so nobody holding a Kiori key can have a kept key sent to a server of theirs.
const bearer = v => String(v ?? '').replace(/^Bearer\s+/i, '').trim();
function upstreamOf(ctx) {
    const h = ctx.headers ?? {};
    if (bearer(h['x-kiori-upstream-key'])) return { url: providerUrl(h['x-kiori-upstream-url'] ?? DEFAULT_UPSTREAM), key: bearer(h['x-kiori-upstream-key']), sent: true };
    if (h['x-kiori-upstream-url'] != null) fail(400, 'X-Kiori-Upstream-Url needs X-Kiori-Upstream-Key with it: the keys Kiori keeps for you only go to the provider they were saved for');
    const saved = getProject(ctx.project)?.settings?.upstream;
    const savedKey = saved && keptKey(ctx.project, 'upstream');
    if (savedKey) return { url: saved.url ?? DEFAULT_UPSTREAM, key: savedKey };
    const own = credentialsFor(ctx.project);
    if (own.own && own.key) return { url: own.baseUrl, key: own.key };
    fail(400, 'No key for your model provider: add your brain API key in the console, or send X-Kiori-Upstream-Key');
}

// Each character's mind goes into the system prompt (yours stays first); a new system message if there is none
function withMinds(messages, minds) {
    if (!minds.length) return messages;
    const block = minds.length === 1 ? minds[0].text : `# The characters in this scene, each with a mind of their own (each knows only what their part says)\n\n${minds.map(c => c.text).join('\n\n')}`;
    const i = messages.findIndex(m => m?.role === 'system' || m?.role === 'developer');
    if (i < 0) return [{ role: 'system', content: block }, ...messages];
    return messages.map((m, j) => (j === i ? { ...m, content: `${textOf(m.content)}\n\n${block}` } : m));
}

// Your provider's error goes back as it came, with its Retry-After (and anything in it that looks like a key blanked
// out); the server notes a 5xx as the provider's. A redirect is not followed: it's an error here. A key the provider
// refuses, or one out of credits, says so the way the rest of the API does (402 BAD_KEY or CREDITS): an OpenAI client
// takes a 401 for its own key, which here is the Kiori key.
const passError = (res, r, data, headers, up) => {
    res.kiori = { ...res.kiori, code: 'PROVIDER', upstream: r.status };
    const refused = r.status === 401 || r.status === 403 ? 'BAD_KEY' : r.status === 402 ? 'CREDITS' : null;
    if (refused) {
        res.kiori.code = refused;
        const which = up.sent ? 'the X-Kiori-Upstream-Key you sent' : 'your brain API key (check it in the console)';
        res.writeHead(402, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
        return res.end(JSON.stringify({ error: { message: refused === 'BAD_KEY' ? `Your model provider refused ${which} (${r.status})` : `Your model provider says ${which} is out of credits`, code: refused, request_id: res.kiori.rid } }));
    }
    const after = r.headers.get('retry-after');
    const status = r.status >= 300 && r.status < 400 ? 502 : r.status;
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers, ...(after && { 'Retry-After': after }) });
    // As it came while it's of a sensible size; a huge one is cut down to the start of its message (blanking keys out of
    // megabytes of text would hold things up, and can overflow the stack)
    let text = JSON.stringify(data ?? { error: { message: status === 502 && r.status !== 502 ? `Your model provider answered ${r.status} (a redirect, not followed)` : `Model provider error ${r.status}`, code: 'PROVIDER' } });
    if (text.length > 4000) text = JSON.stringify({ error: { message: `Model provider error ${r.status}: ${String(data?.error?.message ?? data?.message ?? '').slice(0, 1000)}`, code: 'PROVIDER' } });
    res.end(scrub(text, up.key));
};
// A provider that never answered (after fetchProvider's retries): a 502, or a 504 when it ran out of time. A client
// that hung up gets nothing (499, nginx's "client closed request"). An address that isn't allowed says so (400).
function unreachable(e, abort) {
    if (abort?.signal.aborted) fail(499, 'The client hung up', 'CLIENT_GONE');
    if (e?.status) throw e;
    if (e?.name === 'TimeoutError') fail(504, 'Your model provider did not answer in time', 'PROVIDER');
    fail(502, `Can't reach your model provider (${e?.cause?.code ?? e?.message})`, 'PROVIDER');
}

// A reply that was held (checked first) still goes out as a stream, so a streaming client reads it as usual: each
// choice whole (its text, tool calls and anything else the message has), then the usage when the client asked for it
function streamWhole(res, data, headers, withUsage) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...headers });
    const base = { id: data?.id ?? `kiori-${Date.now()}`, object: 'chat.completion.chunk', created: data?.created ?? Math.floor(Date.now() / 1000), model: data?.model ?? '' };
    const send = chunk => res.write(`data: ${JSON.stringify({ ...base, ...chunk })}\n\n`);
    const choices = Array.isArray(data?.choices) && data.choices.length ? data.choices : [{ index: 0, message: { role: 'assistant', content: '' } }];
    for (const [i, c] of choices.entries()) {
        const { role = 'assistant', content = null, tool_calls, ...more } = c?.message ?? {};
        const delta = { role, content, ...more, ...(Array.isArray(tool_calls) && tool_calls.length && { tool_calls: tool_calls.map((t, index) => ({ index, ...t })) }) };
        send({ choices: [{ index: c?.index ?? i, delta, finish_reason: null }] });
        send({ choices: [{ index: c?.index ?? i, delta: {}, finish_reason: c?.finish_reason ?? 'stop' }] });
    }
    if (withUsage && data?.usage) send({ choices: [], usage: data.usage });
    res.end('data: [DONE]\n\n');
}

export async function chatCompletions(ctx) {
    const body = ctx.body;
    if (!Array.isArray(body.messages) || !body.messages.length) fail(400, 'messages is required');
    const o = options(ctx);
    const up = upstreamOf(ctx);
    const minds = await recall(ctx.project, o.brains, { messages: body.messages, player: o.player, budget: o.budget });
    // stream_options only goes with a streaming request: a held one goes out whole, and providers refuse it there
    const { kiori, stream_options, ...rest } = body;
    const forward = { ...rest, messages: withMinds(body.messages, minds.characters) };
    const hold = o.check === 'true' || (o.check === 'auto' && minds.check_recommended);
    const headers = {};
    // A client that hangs up stops the model too
    const abort = new AbortController();
    ctx.res.on('close', () => { if (!ctx.res.writableEnded) abort.abort(); });
    // Asked again when your provider is briefly unavailable, before anything is sent back (see fetchProvider)
    const ask = stream => fetchProvider(`${up.url}/chat/completions`, {
        method: 'POST', headers: { Authorization: `Bearer ${up.key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...forward, stream, ...(stream && stream_options !== undefined && { stream_options }) }), signal: AbortSignal.any([abort.signal, AbortSignal.timeout(300000)]),
    }).catch(e => unreachable(e, abort));

    if (!body.stream || hold) {
        const r = await ask(false);
        const data = await answerJson(r);
        if (!r.ok) return passError(ctx.res, r, data, headers, up);
        let reply = textOf(data?.choices?.[0]?.message?.content);
        // The check runs on the project's brain API key; without one, with no text to check (a tool call), or with more
        // than one reply's worth of it, the reply goes out unchecked
        if (hold && (!reply.trim() || reply.length > MAX_DRAFT || !credentialsFor(ctx.project).key)) headers['X-Kiori-Check'] = 'skipped';
        else if (hold && reply.trim()) {
            try {
                const c = await checkReply(ctx.project, o.brains, { draft: reply, messages: body.messages, player: o.player });
                headers['X-Kiori-Check'] = c.ok ? 'ok' : 'fixed';
                if (!c.ok) reply = c.fixed;
            } catch { headers['X-Kiori-Check'] = 'failed'; }
            if (data.choices[0].message) data.choices[0].message.content = reply;
        }
        if (body.stream) return streamWhole(ctx.res, data, headers, stream_options?.include_usage === true);
        ctx.res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
        return ctx.res.end(JSON.stringify(data));
    }

    // Streaming: every chunk goes straight through
    const r = await ask(true);
    if (!r.ok) return passError(ctx.res, r, await answerJson(r).catch(() => null), headers, up);
    // Passed on as the stream (or JSON, from a provider that doesn't stream) it is, never as a page a browser would open
    const type = r.headers.get('content-type') ?? '';
    ctx.res.writeHead(200, { 'Content-Type': /^(text\/event-stream|application\/json|application\/x-ndjson|text\/plain)\b/i.test(type) ? type : 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', ...headers });
    try {
        // At the reader's pace: a client that falls behind holds the provider back rather than filling this server's memory
        for await (const chunk of r.body) if (!ctx.res.write(chunk)) await once(ctx.res, 'drain', { signal: abort.signal });
    } catch (e) {
        if (!abort.signal.aborted) console.error('Kiori: the model stream broke off:', e.message);
    }
    ctx.res.end();
}

// GET /v1/models, passed on to your provider (some chat apps list models before they talk)
export async function listModels(ctx) {
    const up = upstreamOf(ctx);
    const r = await fetchProvider(`${up.url}/models`, { headers: { Authorization: `Bearer ${up.key}` }, signal: AbortSignal.timeout(30000) }).catch(e => unreachable(e));
    const data = await answerJson(r);
    if (!r.ok) return passError(ctx.res, r, data, {}, up);
    return data;
}
