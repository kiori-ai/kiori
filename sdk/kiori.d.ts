// Types for the Kiori JavaScript client (kiori.mjs).

/** A character's brain in one conversation. Keep it as it is (a JSON object) and send it back with each call. */
export interface Brain {
    kiori: 1;
    id: string;
    name: string;
    aliases: string[];
    pronouns: 'she' | 'he' | 'they';
    build: 'full' | 'light';
    card: Partial<Record<'who' | 'looks' | 'personality' | 'voice' | 'core' | 'description' | 'lore' | 'scenario' | 'first_message' | 'examples' | 'tagline', string>>;
    personality: Record<string, number>;
    memories: Memory[];
    relations: Relation[];
    state: { core: State | null; chat: State | null };
    /** Where learning stands in the conversation: the last message learned, and fingerprints of the last ones */
    chat: { learned: number; seen: Array<[number, string] | [number, string, string]> };
    embed: { model: string; dim: number } | null;
    created: string;
    updated: string;
}

export type MemoryKind = 'memory' | 'person' | 'place' | 'belief' | 'feeling' | 'secret' | 'habit' | 'skill' | 'object' | 'fact' | 'intention' | 'trait' | 'mind' | 'forgot' | 'told' | 'lore' | 'event';

export interface Memory {
    id: string;
    kind: MemoryKind;
    title: string;
    body: string;
    keys: string[];
    about: string[];
    importance: number;
    emotion: number;
    strength: number;
    status: 'active' | 'done';
    /** core: who they are, from when the brain was built; chat: learned in this conversation */
    scope: 'core' | 'chat';
    /** The words from the chat this was learned from */
    evidence?: string;
    from?: number;
    to?: number;
    links?: string[];
    gist?: string;
    gisted?: boolean;
    /** How they know it: worked out from the message the evidence is in */
    source?: { how: 'saw' | 'heard' | 'told' | 'overheard' | 'read' | 'inferred' | 'rumor'; by?: string; origin?: string; at?: number };
    /** How much they believe it, 0-1 */
    confidence?: number;
    /** A told record: to whom, what they said, and for a lie the truth (or the id of the memory that holds it) */
    told_to?: string[];
    said?: string;
    lie?: boolean;
    truth?: string;
    truth_ref?: string;
    /** The memory's meaning fingerprint (base64) */
    v?: string;
}

export interface Relation {
    target: string;
    trust: number | null;
    closeness: number | null;
    respect: number | null;
    resentment: number | null;
    attraction: number | null;
    note: string | null;
    scope?: 'core' | 'chat';
}

export interface State { mood: string | null; on_mind: string[]; wants: string[] }

/** An OpenAI-style chat message. Your own id lets Kiori notice edits and rerolls exactly. */
export interface Message {
    id?: string;
    role: 'user' | 'assistant' | 'system' | string;
    content: string | Array<{ type: string; text?: string }>;
    /** Who speaks (a group chat's character, or the player's name on user messages) */
    name?: string;
    /** Who is there, when you know it (otherwise Kiori works it out in group chats) */
    /** Who was there: names, or { name, mode } with mode full | heard | overheard | saw | asleep (a plain name is full). */
    present?: (string | { name: string; mode: 'full' | 'heard' | 'overheard' | 'saw' | 'asleep' })[];
}

type OneOrMany = { brain: Brain; brains?: never } | { brains: Brain[]; brain?: never };

export interface CreateRequest {
    /** A Tavern / SillyTavern card (v1, v2, v3) as JSON, or a card PNG in base64 */
    character_card?: object | string;
    name?: string;
    description?: string;
    lore?: string;
    pronouns?: 'she' | 'he' | 'they';
    personality?: Record<string, number>;
    archetype?: string;
    /** The other characters of the world, so the brain knows them */
    others?: Array<string | { name: string; who?: string }>;
    /** full (default): a whole past, about a minute, on your brain API key. light: from the card alone, free. */
    depth?: 'full' | 'light';
}

export type RecallRequest = OneOrMany & { messages?: Message[]; query?: string; player?: string | { name: string }; budget?: number; limit?: number };

export interface CharacterContext {
    name: string;
    /** A ready-to-use block for your prompt */
    text: string;
    memories: Array<Omit<Memory, 'v'> & { score: number }>;
    relations: Relation[];
    state: State;
    facts: Array<{ about: string[]; fact: string }>;
    forgot: string[];
    intentions: string[];
    mind: Array<{ title: string; general: string; in_them: string[]; note: string | null }>;
    /** The lies they keep up, only when there are any */
    lies?: Array<{ to: string[]; said: string; truth: string | null }>;
}

export interface RecallResult {
    characters: CharacterContext[];
    /** The context of the one brain sent */
    text?: string;
    /** The player brought up the past: a reply is worth checking before it's shown */
    check_recommended: boolean;
}

export type OrganizeRequest = OneOrMany & {
    messages: Message[];
    player?: string | { name: string };
    /** The newest messages left for later (they may still be rerolled). Default 4. */
    hold?: number;
    /** Learn once this many settled messages are new. Default 12. */
    every?: number;
    /** Learn whatever is settled now */
    now?: boolean;
};

export interface OrganizeResult {
    brain?: Brain;
    brains?: Brain[];
    learned: Array<{ name: string; from: number; to: number; messages: number; written: number; dropped: { memories: number; facts: number; intentions: number; forgot: number } }>;
    rewound: Array<{ name: string; from: number; forgot: number }>;
    /** Settled messages not learned yet (learning waits for more) */
    waiting: number;
    held: number;
    warnings?: string[];
}

/** check (or mode) "fast": the pre-check alone, with no model call and no brain API key needed */
export type CheckRequest = OneOrMany & { draft: string; messages?: Message[]; player?: string | { name: string }; check?: 'fast'; mode?: 'fast' };
export interface CheckResult {
    /** No issue but a lie (a lie is the character's, and never fixed) */
    ok: boolean;
    issues: Array<{ character: string; type: 'leak' | 'contradiction' | 'invented_past' | 'unsupported' | 'misattribution' | 'lie_slip' | 'lie'; quote: string; why: string; by?: 'precheck' }>;
    fixed: string;
    checked: string[];
    /** Words of their lines worth a look, from the pre-check */
    suspects?: Array<{ character: string; type: 'leak' | 'lie_slip' | 'forgot'; word: string; from?: string[]; to?: string[]; strong?: true }>;
}

export interface BrainKey { set: boolean; provider?: string; key?: string; model?: string; base_url?: string }
export interface Project {
    id: string;
    name: string;
    llm_mode: 'server' | 'own';
    settings: Record<string, unknown>;
    created_at: string;
    llm: BrainKey;
    keys: Array<{ prefix: string; label: string | null; created_at: string; last_used: string | null }>;
}
export interface ModelChoice { id: string; name: string | null; hint?: string; recommended?: boolean }
export interface ProjectModels extends BrainKey { suggested?: string | null; current?: string | null; picks?: ModelChoice[]; models?: ModelChoice[] }

export class KioriError extends Error {
    /** The HTTP status, or 0 when Kiori couldn't be reached (code NETWORK) or didn't answer in time (TIMEOUT) */
    status: number;
    code?: string;
    /** The seconds Kiori asked to wait before trying again (Retry-After), when it did */
    retryAfter?: number;
    /** The call's id (X-Request-Id), to quote when you write to us about it */
    requestId?: string;
}

export class Kiori {
    constructor(options: {
        apiKey: string;
        /** Default https://api.kiori.io */
        baseUrl?: string;
        /** Per request, in ms (default 150000); building a full brain takes about a minute */
        timeout?: number;
        /** How many times a call is asked again when Kiori or the model provider is briefly unavailable or out of reach
         *  (429, 502, 503 and the like; not a timeout), after Retry-After, else about 1 s, then 2 s. Default 2; 0 never */
        maxRetries?: number;
    });
    apiKey: string;
    baseUrl: string;
    timeout: number;
    maxRetries: number;
    create(body: CreateRequest): Promise<Brain>;
    recall(body: RecallRequest): Promise<RecallResult>;
    organize(body: OrganizeRequest): Promise<OrganizeResult>;
    check(body: CheckRequest): Promise<CheckResult>;
    exportObsidian(brain: Brain): Promise<Uint8Array>;
    personality(): Promise<{ params: Array<{ id: string; name: string; group: string; low: string; high: string }>; archetypes: Array<{ id: string; name: string; description: string }> }>;
    project: {
        get(): Promise<Project>;
        update(body: { name?: string; llm?: { key?: string; model?: string; base_url?: string } | null }): Promise<Project>;
        models(): Promise<ProjectModels>;
        usage(days?: number): Promise<{ days: number; requests: Array<{ route: string; calls: number }>; model: { totals: { calls: number; cost: number }; by_op: unknown[]; by_day: unknown[] } }>;
        keys: { create(label?: string): Promise<{ key: string }>; revoke(prefix: string): Promise<{ revoked: boolean }> };
    };
    /** safe: false for a call that isn't safe to repeat; it's asked again only after a 429 */
    raw(method: string, path: string, body?: unknown, options?: { safe?: boolean }): Promise<Response>;
    request<T = any>(method: string, path: string, body?: unknown, options?: { safe?: boolean }): Promise<T>;
}
