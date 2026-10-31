// The API described as OpenAPI 3.1, served at /openapi.json: import it into Postman or Insomnia, or generate a
// client in any language. Kept next to the routes (server.mjs); the prose reference is docs/api.md.
const ref = name => ({ $ref: `#/components/schemas/${name}` });
const str = (description, extra = {}) => ({ type: 'string', ...(description && { description }), ...extra });
const int = (description, extra = {}) => ({ type: 'integer', ...(description && { description }), ...extra });
const num = (description, extra = {}) => ({ type: 'number', ...(description && { description }), ...extra });
const bool = description => ({ type: 'boolean', ...(description && { description }) });
// A schema that may also be null (a $ref has no type of its own, so it's one of the two)
const nul = schema => (schema.$ref ? { anyOf: [schema, { type: 'null' }] } : { ...schema, type: [schema.type, 'null'] });
const arr = (items, description) => ({ type: 'array', items, ...(description && { description }) });
const obj = (properties, required = [], description) => ({ type: 'object', properties, ...(required.length && { required }), ...(description && { description }) });
const json = schema => ({ content: { 'application/json': { schema } } });
const ok = (schema, description = 'OK') => ({ 200: { description, ...json(schema) } });
const errors = { 400: { description: 'Bad input (a brain that isn\'t one: BAD_BRAIN)', ...json(ref('Error')) }, 401: { description: 'Bad or missing key', ...json(ref('Error')) }, 402: { description: 'No brain API key yet (NEEDS_KEY), or your provider refused it (BAD_KEY) or is out of credits (CREDITS)', ...json(ref('Error')) } };
const op = (summary, { description, body, response, params = [], query = [], tags, extra = {} } = {}) => ({
    summary, ...(description && { description }), ...(tags && { tags }),
    parameters: [...params.map(p => ({ name: p, in: 'path', required: true, schema: { type: 'string' } })), ...query],
    ...(body && { requestBody: { required: true, ...json(body) } }),
    responses: { ...ok(response ?? obj({})), ...errors }, ...extra,
});
const q = (name, schema, description) => ({ name, in: 'query', schema, ...(description && { description }) });
// The drop-in's headers for another provider: both or neither
const UPSTREAM = [
    { name: 'X-Kiori-Upstream-Url', in: 'header', schema: { type: 'string' }, description: 'Another OpenAI-compatible provider (https, on the public internet); needs X-Kiori-Upstream-Key' },
    { name: 'X-Kiori-Upstream-Key', in: 'header', schema: { type: 'string' }, description: 'Your key at that provider; it goes there only' },
];

const schemas = {
    Error: obj({ error: obj({ message: str(), code: str('BAD_REQUEST, BAD_BRAIN, UNAUTHORIZED, LINK_EXPIRED, FORBIDDEN, NOT_FOUND, NEEDS_KEY, BAD_KEY, CREDITS, PROVIDER, RATE_LIMITED, TOO_LARGE, ...'), request_id: str('The same as the X-Request-Id header: mention it when you write to us about a call') }) }),
    Brain: {
        ...obj({
            kiori: int('The brain file format: 1', { const: 1 }), id: str(), name: str(), aliases: arr(str()), pronouns: str(null, { enum: ['she', 'he', 'they'] }),
            build: str(null, { enum: ['full', 'light'] }), card: obj({ who: str(), looks: str(), personality: str(), voice: str(), core: str(), description: str(), lore: str(), scenario: str(), first_message: str(), examples: str() }),
            personality: { type: 'object', additionalProperties: int(null, { minimum: 0, maximum: 100 }), description: '41 values, 50 = an average person' },
            memories: arr(ref('Memory')), relations: arr(ref('Relation')),
            state: obj({ core: nul(ref('State')), chat: nul(ref('State')) }),
            chat: obj({ learned: int('The last message learned'), seen: arr(arr({}), 'Fingerprints of the last messages learned: [number, fingerprint, your id?]') }),
            embed: nul(obj({ model: str(), dim: int() })), created: str(), updated: str(),
        }, ['kiori', 'name'], 'A character\'s brain in one conversation. Kiori stores none: keep it as it comes back, and send it with each call.'),
    },
    Memory: obj({
        id: str(), kind: str(null, { enum: ['memory', 'person', 'place', 'belief', 'feeling', 'secret', 'habit', 'skill', 'object', 'fact', 'intention', 'trait', 'mind', 'forgot'] }),
        title: str(), body: str(), keys: arr(str()), about: arr(str()), importance: num(), emotion: num(), strength: num(),
        status: str(null, { enum: ['active', 'done'] }), scope: str('core: who they are; chat: learned in this conversation', { enum: ['core', 'chat'] }),
        evidence: str('The words from the chat it was learned from'), from: int(), to: int(), links: arr(str()), v: str('Its meaning fingerprint (base64)'),
    }),
    Relation: obj({ target: str(), trust: nul(int()), closeness: nul(int()), respect: nul(int()), resentment: nul(int()), attraction: nul(int()), note: nul(str()) }),
    State: obj({ mood: nul(str()), on_mind: arr(str()), wants: arr(str()) }),
    ChatMessage: obj({
        id: str('Your id for the message: edits and rerolls are noticed exactly'), role: str('user, assistant, or narrator (narration in nobody\'s voice); system and tool messages are skipped'),
        content: { description: 'Text, or OpenAI-style parts', oneOf: [{ type: 'string' }, { type: 'array' }] },
        name: str('Who speaks: a group chat\'s character, or the player\'s name on user messages'), present: arr(str(), 'Who is there, when you know it'),
    }, ['role', 'content']),
    OneOrMany: obj({ brain: ref('Brain'), brains: arr(ref('Brain'), 'For a group chat: one brain per character (at most 12)') }, [], 'Send "brain" or "brains"'),
    CreateInput: obj({
        character_card: { description: 'A Tavern / SillyTavern character card (v1, v2, v3) as JSON, or a card PNG in base64', oneOf: [{ type: 'object' }, { type: 'string' }] },
        name: str(), description: str('Who they are; the more, the more faithful'), lore: str('Canon for their world'),
        pronouns: str(null, { enum: ['she', 'he', 'they'] }), archetype: str(), personality: { type: 'object', additionalProperties: int() },
        others: arr({ oneOf: [{ type: 'string' }, obj({ name: str(), who: str() })] }, 'The other characters of their world'),
        depth: str('full (default): a whole past, about a minute, on your brain API key. light: from the card alone, free.', { enum: ['full', 'light'] }),
    }),
    RecallInput: { allOf: [ref('OneOrMany'), obj({ messages: arr(ref('ChatMessage')), query: str('Recall for this instead of the last messages'), player: str(), budget: int('Characters of text per brain (default 6000)'), limit: int('Memories per brain (default 10)') })] },
    CharacterContext: obj({
        name: str(), text: str('A ready-to-use block for your prompt'), memories: arr(ref('Memory')), relations: arr(ref('Relation')), state: ref('State'),
        facts: arr(obj({ about: arr(str()), fact: str() })), forgot: arr(str()), intentions: arr(str()), mind: arr(obj({})),
    }),
    RecallResult: obj({ characters: arr(ref('CharacterContext')), text: str('The context, when one brain was sent'), check_recommended: bool('The player brought up the past: worth checking the reply') }),
    OrganizeInput: { allOf: [ref('OneOrMany'), obj({
        messages: arr(ref('ChatMessage'), 'The chat\'s recent messages as they are now, oldest first (send at least the last 30, not only the new ones)'), player: str(),
        hold: int('The newest messages left for later, as they may still be rerolled (default 4)'), every: int('Learn once this many settled messages are new (default 12)'), now: bool('Learn whatever is settled now'),
    }, ['messages'])] },
    OrganizeResult: obj({
        brain: ref('Brain'), brains: arr(ref('Brain')),
        learned: arr(obj({ name: str(), from: int(), to: int(), messages: int(), written: int(), dropped: obj({ memories: int(), facts: int(), intentions: int(), forgot: int() }) })),
        rewound: arr(obj({ name: str(), from: int(), forgot: int() }), 'Brains that unlearned what an edited, rerolled or deleted message taught'),
        waiting: int('Settled messages not learned yet'), held: int(), warnings: arr(str()),
    }),
    CheckInput: { allOf: [ref('OneOrMany'), obj({ draft: str('The reply to check'), messages: arr(ref('ChatMessage')), player: str() }, ['draft'])] },
    CheckResult: obj({
        ok: bool(), issues: arr(obj({ character: str(), type: str(null, { enum: ['leak', 'contradiction', 'invented_past', 'unsupported'] }), quote: str(), why: str() })),
        fixed: str('The draft with only the problem lines changed'), checked: arr(str()),
    }),
    BrainKey: obj({ set: bool(), provider: str(), key: str('Its last four characters'), model: str(), base_url: str() }),
};

export const openapi = {
    openapi: '3.1.0',
    info: {
        title: 'Kiori API', version: '2.0.0',
        description: 'Brains for characters: memory, personality and who-knows-what for character AI. Kiori stores no brains and no chats: a brain is a JSON object you keep and send with each call, and calls that change it give it back. Every call needs a project key (Authorization: Bearer kio_...) unless marked otherwise; the model work runs on your own brain API key, set in the console and kept sealed. Every answer carries an X-Request-Id header. Limits: 1200 calls a minute and 64 model calls at once per project (429 with Retry-After).',
    },
    servers: [{ url: 'https://api.kiori.io', description: 'Hosted' }],
    security: [{ key: [] }],
    tags: [{ name: 'Brains', description: 'Create, recall, organize, check' }, { name: 'Drop-in' }, { name: 'Project' }],
    paths: {
        '/v1/brains': { post: op('A new brain', { tags: ['Brains'], description: 'From a character card, or name and description. Keep what comes back; start each new conversation from a copy.', body: ref('CreateInput'), response: obj({ brain: ref('Brain') }) }) },
        '/v1/brains/recall': { post: op('What each character knows right now', { tags: ['Brains'], description: 'Search over each brain for this moment, as a ready-to-use prompt block. The brains are only read.', body: ref('RecallInput'), response: ref('RecallResult') }) },
        '/v1/brains/organize': { post: op('The brains learn from the chat', { tags: ['Brains'], description: 'Send the brains and the recent messages as they are now. What\'s new and settled is learned (each brain only from the scenes it was in); an edited, rerolled or deleted message that was learned is unlearned. Keep the brains that come back.', body: ref('OrganizeInput'), response: ref('OrganizeResult') }) },
        '/v1/brains/check': { post: op('Check a draft reply before it is shown', { tags: ['Brains'], description: 'Leaks, contradictions and invented pasts, flagged and fixed with minimal edits.', body: ref('CheckInput'), response: ref('CheckResult') }) },
        '/v1/brains/export': { post: { ...op('A brain as an Obsidian vault', { tags: ['Brains'], body: obj({ brain: ref('Brain') }, ['brain']) }), responses: { 200: { description: 'A zip', content: { 'application/zip': {} } }, ...errors } } },
        '/v1/chat/completions': {
            post: op('The drop-in: an OpenAI-compatible chat call with the brains', {
                tags: ['Drop-in'],
                description: 'Your usual chat completion request, plus "kiori": { "brain": ... } (or "brains"). Each character\'s mind goes into the system prompt and the request goes on to your model: the model you name, at your brain API key\'s provider. For another provider, send X-Kiori-Upstream-Url with X-Kiori-Upstream-Key (an address without a key is refused: the key Kiori keeps only goes to its own provider). Streaming works. With check (auto by default: when the player brings up the past) the reply is checked and fixed before it is sent; the X-Kiori-Check header says how it went. Nothing is kept: call /v1/brains/organize to let the brains learn.',
                params: [], query: UPSTREAM,
                body: obj({ model: str(), messages: arr(ref('ChatMessage')), stream: bool(), kiori: { allOf: [ref('OneOrMany'), obj({ player: str(), check: str(null, { enum: ['auto', 'true', 'false'] }), budget: int() })] } }, ['messages', 'kiori']),
            }),
        },
        '/v1/models': { get: op('Your provider\'s models, passed on', { tags: ['Drop-in'], query: UPSTREAM }) },
        '/v1/project': {
            get: op('The project, its brain API key (masked) and its keys', { tags: ['Project'] }),
            patch: op('Change the name or the brain API key', { tags: ['Project'], description: 'llm: { key } sets your brain API key (OpenRouter, OpenAI or Gemini: the provider is recognized from the key, and the key is checked); { model } picks the model; null removes it.', body: obj({ name: str(), llm: nul(obj({ key: str(), model: str(), base_url: str('Another OpenAI-compatible provider') })) }) }),
        },
        '/v1/project/models': { get: op('The models your brain API key can use, the suggested one first', { tags: ['Project'], response: { allOf: [ref('BrainKey'), obj({ suggested: str(), current: str(), picks: arr(obj({ id: str(), name: str(), hint: str(), recommended: bool() })), models: arr(obj({ id: str(), name: str() })) })] } }) },
        '/v1/project/keys': { post: op('A new API key (shown once)', { tags: ['Project'], body: obj({ label: str() }), response: obj({ key: str() }) }) },
        '/v1/project/keys/{prefix}': { delete: op('Revoke a key', { tags: ['Project'], extra: { parameters: [{ name: 'prefix', in: 'path', required: true, schema: { type: 'string' } }] } }) },
        '/v1/usage': { get: op('Calls, and model calls and their cost', { tags: ['Project'], query: [q('days', { type: 'integer' })] }) },
        '/v1/personality': { get: { ...op('The 41 personality dimensions and the archetypes', { tags: ['Brains'] }), security: [] } },
        '/v1/access': { post: { summary: 'Ask for access (no key needed): your project at once, and a sign-in link', description: 'A valid request makes a project on your own brain API key and answers with a one-time sign-in link to the console (good for 7 days). An email whose project nobody has signed in to yet gets a new link to that project; once someone has, the answer is 409.', tags: ['Project'], security: [], requestBody: { required: true, ...json(obj({ email: str(), name: str(), company: str(), use_case: str() }, ['email'])) }, responses: { ...ok(obj({ ok: bool(), link: str('A one-time sign-in link to the console'), expires_at: str(), project: obj({ id: str(), name: str() }) })), 400: errors[400], 409: { description: 'This email already has a project someone signed in to', ...json(ref('Error')) }, 429: { description: 'Too many requests from this address, or for today' } } } },
        '/v1/signin': { post: { summary: 'Trade a sign-in link\'s one-time token for a Kiori key (no key needed)', description: 'The console does this when a sign-in link opens. A token works once, within 7 days.', tags: ['Project'], security: [], requestBody: { required: true, ...json(obj({ token: str('kis_...') }, ['token'])) }, responses: { ...ok(obj({ key: str('A new Kiori key for this browser'), project: obj({ id: str(), name: str() }) })), 401: { description: 'The link was used or ran out (LINK_EXPIRED)', ...json(ref('Error')) }, 429: { description: 'Too many sign-ins from this address' } } } },
        '/health': { get: { summary: 'Is it running', security: [], responses: ok(obj({ ok: bool(), name: str(), version: str() })) } },
    },
    components: { securitySchemes: { key: { type: 'http', scheme: 'bearer', description: 'A project key: kio_...' } }, schemas },
};
