// Kiori for SillyTavern. Every character gets a brain, kept in the chat's own file on this computer (Kiori itself
// stores no brains and no chats). Before each reply, what the character knows right now goes into the prompt; after
// it, the brain learns from the chat. A character's freshly built brain is also kept on their card, so every new chat
// with them starts from it instead of building again. Edits, swipes and deletions are noticed and unlearned.

const MODULE = 'kiori';
const DEFAULTS = { enabled: true, apiUrl: 'https://api.kiori.io', apiKey: '', depth: 'full', budget: 4000 };
// SillyTavern's extension_prompt_types.IN_PROMPT: with the system prompt, before the chat
const IN_PROMPT = 0;

const ctx = () => SillyTavern.getContext();
// toastr renders HTML unless told otherwise; a name or a message can come from a shared card or the API, so it's text
const say = (kind, text) => globalThis.toastr?.[kind]?.(text, 'Kiori', { escapeHtml: true });
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function settings() {
    const all = ctx().extensionSettings;
    all[MODULE] = { ...DEFAULTS, ...(all[MODULE] ?? {}) };
    return all[MODULE];
}

// A call is asked again (twice at most) when Kiori or the model provider is briefly unavailable or out of reach: after
// the Retry-After Kiori gives (up to 20 s), else after about a second, then two. Safe: Kiori keeps nothing between calls
const AGAIN = new Set([408, 429, 502, 503, 520, 521, 522, 523, 530]);
const FINAL = new Set(['NEEDS_KEY', 'NO_KEY', 'BAD_KEY', 'CREDITS']);
async function kiori(path, body) {
    const s = settings();
    if (!s.apiKey) throw new Error('add your Kiori key in Extensions, Kiori');
    for (let attempt = 0; ; attempt++) {
        let res, error, wait = null;
        const backoff = 1000 * 2 ** attempt * (0.75 + Math.random() * 0.5);
        try {
            res = await fetch(`${s.apiUrl.replace(/\/+$/, '')}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${s.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        } catch {
            error = new Error(`can't reach Kiori at ${s.apiUrl}`);
            wait = backoff;
        }
        if (res) {
            const data = await res.json().catch(() => null);
            if (res.ok) return data;
            error = Object.assign(new Error(data?.error?.message ?? `Kiori answered ${res.status}`), { code: data?.error?.code ?? null });
            if (AGAIN.has(res.status) && !FINAL.has(data?.error?.code)) {
                const after = res.headers.get('retry-after');
                wait = after == null || after === '' ? backoff : Number(after) <= 20 ? Number(after) * 1000 : null;
            }
        }
        if (wait == null || attempt >= 2) throw error;
        await new Promise(r => setTimeout(r, wait));
    }
}

// Who is in this chat: its character, or the members of a group
function cast() {
    const c = ctx();
    if (c.groupId != null) {
        const group = c.groups.find(g => g.id == c.groupId);
        return (group?.members ?? []).map(avatar => c.characters.find(ch => ch.avatar === avatar)).filter(Boolean);
    }
    const ch = c.characters[c.characterId];
    return ch ? [ch] : [];
}
const keyOf = ch => ch.avatar || ch.name;

// This chat's brains live in its metadata, so they're saved with the chat file
function brainsHere() {
    const md = ctx().chatMetadata;
    if (!md.kiori || typeof md.kiori !== 'object') md.kiori = {};
    if (!md.kiori.brains || typeof md.kiori.brains !== 'object') md.kiori.brains = {};
    return md.kiori.brains;
}

// The chat as messages, oldest first. Hidden messages are left out; a message's send date is its id, so an edit or a
// swipe of it is noticed
function chatMessages(last = 60) {
    return ctx().chat
        .filter(m => !m.is_system && typeof m.mes === 'string' && m.mes.trim())
        .slice(-last)
        .map(m => ({ ...(m.send_date ? { id: String(m.send_date) } : {}), role: m.is_user ? 'user' : 'assistant', name: m.name, content: m.mes }));
}

// A character's card the way Kiori reads it (Tavern v2)
const cardOf = ch => (ch.data && typeof ch.data === 'object'
    ? { spec: 'chara_card_v2', spec_version: '2.0', data: { ...ch.data, name: ch.data.name || ch.name } }
    : { name: ch.name, description: ch.description ?? '', personality: ch.personality ?? '', scenario: ch.scenario ?? '', first_mes: ch.first_mes ?? '', mes_example: ch.mes_example ?? '' });

// What of a card a brain is built from, as a short hash (FNV-1a). The brain kept on a card is used only while the card
// still says the same: a duplicated character renamed and rewritten, or a card edited, gets a brain of its own. A brain
// kept before this hash is trusted while its name is the card's.
const CARD_READ = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'character_book'];
function cardHash(ch) {
    const c = cardOf(ch), d = c.data ?? c;
    const t = JSON.stringify(CARD_READ.map(f => d[f] ?? null));
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
}
const fitsCard = (ch, brain) => {
    if (!brain?.kiori) return false;
    const kept = ch.data?.extensions?.kiori_card;
    return kept ? kept === cardHash(ch) : brain.name === (ch.data?.name || ch.name);
};

// SillyTavern renames a character by saving their card under a new file name, while each chat keeps their brain under
// the old one: remembered here (old file → new), so a chat moves its brain over when it next needs it
function renamedTo(k) {
    const map = settings().renamed ?? {};
    for (const seen = new Set(); map[k] && !seen.has(k);) { seen.add(k); k = map[k]; }
    return k;
}
// This chat's brain for a character (moved over from the name they had before a rename)
function chatBrain(ch) {
    const here = brainsHere(), k = keyOf(ch);
    if (!here[k]) {
        const old = Object.keys(here).find(o => o !== k && renamedTo(o) === k);
        if (old) { here[k] = { ...here[old], name: ch.name }; delete here[old]; Promise.resolve(ctx().saveMetadata()).catch(() => {}); }
    }
    return here[k];
}

// A character's brain for this chat: the chat's own, else a copy of the one kept on their card, else built now
const building = new Map();
async function brainFor(ch) {
    const chatId = ctx().getCurrentChatId();
    const k = keyOf(ch);
    if (chatBrain(ch)) return chatBrain(ch);
    let template = ch.data?.extensions?.kiori_brain;
    if (!fitsCard(ch, template)) {
        if (!building.has(k)) {
            const s = settings();
            say('info', `Building ${ch.name}'s brain${s.depth === 'full' ? ' (about a minute)' : ''}…`);
            const others = cast().filter(x => x !== ch).map(x => x.name);
            building.set(k, kiori('/v1/brains', { character_card: cardOf(ch), depth: s.depth, others })
                .then(async ({ brain }) => {
                    // Kept on the card, with what of the card it was built from: the next chat with them starts from it
                    try {
                        const i = ctx().characters.indexOf(ch);
                        await ctx().writeExtensionField(i, 'kiori_brain', brain);
                        await ctx().writeExtensionField(i, 'kiori_card', cardHash(ch));
                    } catch (e) { console.warn('[Kiori] could not keep the brain on the card', e); }
                    say('success', `${ch.name} has a brain now.`);
                    return brain;
                })
                .finally(() => building.delete(k)));
        }
        template = await building.get(k);
    }
    // Another chat opened meanwhile: this one copies it from the card next time
    if (ctx().getCurrentChatId() !== chatId) return null;
    const here = brainsHere();
    here[k] ??= structuredClone(template);
    await ctx().saveMetadata();
    return here[k];
}

// Before each reply: what the character about to speak knows right now, into the prompt. In a group, SillyTavern makes
// the member it drafts the current character just before generating; only that one's mind goes in, so the others'
// memories and secrets stay theirs. Every member still gets a brain, so all of them learn from what they witness.
// Nothing goes in for a background generation, or for one written as the user (impersonate).
globalThis.kioriInterceptor = async function (chat, contextSize, abort, type) {
    const s = settings();
    ctx().setExtensionPrompt(MODULE, '', IN_PROMPT, 0);
    if (!s.enabled || !s.apiKey || type === 'quiet' || type === 'impersonate') return;
    const members = cast();
    if (!members.length) return;
    const c = ctx();
    const speaker = members.length === 1 ? members[0] : members.find(ch => ch === c.characters[c.characterId]);
    if (!speaker) return;
    try {
        // Every member's brain at once (a new group builds them side by side); only the speaker's has to be there
        const got = await Promise.allSettled(members.map(ch => brainFor(ch)));
        got.forEach((g, i) => { if (g.status === 'rejected' && members[i] !== speaker) console.warn('[Kiori]', g.reason); });
        const mine = got[members.indexOf(speaker)];
        if (mine.status === 'rejected') throw mine.reason;
        const brain = mine.value;
        if (!brain) return;
        const r = await kiori('/v1/brains/recall', { brain, messages: chatMessages(12), player: ctx().name1, budget: s.budget });
        ctx().setExtensionPrompt(MODULE, r.text, IN_PROMPT, 0);
    } catch (e) {
        console.warn('[Kiori]', e);
        say('warning', `No memories this time: ${e.message}`);
    }
};

// After the chat moves on: the brains learn (one call at a time; one more runs after it if anything changed meanwhile,
// as "now" when Learn now was pressed meanwhile). warned: the last failure the user was told about while learning ran in
// the background (said once, not on every reply)
let running = null, again = false, againNow = false, timer = null, warned = null;
function organizeSoon(ms = 1500) { clearTimeout(timer); timer = setTimeout(() => organize().catch(() => {}), ms); }
async function organize({ now = false } = {}) {
    if (running) { again = true; againNow ||= now; return running; }
    const s = settings();
    if (!s.enabled || !s.apiKey) return;
    const chatId = ctx().getCurrentChatId();
    const pairs = cast().map(ch => [keyOf(ch), chatBrain(ch)]).filter(([, b]) => b);
    // "Forget this chat" puts a new object here: an answer that comes back after it is not written back
    const mine = ctx().chatMetadata.kiori;
    if (!pairs.length) { if (now) say('info', 'Nothing to learn yet: the brains come with the first reply.'); return; }
    running = (async () => {
        try {
            const r = await kiori('/v1/brains/organize', { brains: pairs.map(([, b]) => b), messages: chatMessages(60), player: ctx().name1, ...(now && { now: true, hold: 0 }) });
            if (ctx().getCurrentChatId() !== chatId || ctx().chatMetadata.kiori !== mine) return;
            const fresh = brainsHere();
            pairs.forEach(([k], i) => { fresh[k] = r.brains[i]; });
            await ctx().saveMetadata();
            if (now || r.learned.some(l => l.written)) say('info', r.learned.length ? r.learned.map(l => `${l.name} learned ${l.written} new memor${l.written === 1 ? 'y' : 'ies'}`).join('; ') : 'Nothing new to learn yet.');
            for (const w of r.warnings ?? []) console.warn('[Kiori]', w);
            warned = null;
        } catch (e) {
            console.warn('[Kiori]', e);
            if (now) say('error', e.message);
            else if (FINAL.has(e.code) && warned !== e.code) { warned = e.code; say('error', `Brains can't learn: ${e.message}`); }
        } finally {
            running = null;
            showStatus();
            if (again) {
                const asNow = againNow;
                again = againNow = false;
                if (asNow) organize({ now: true }).catch(() => {}); else organizeSoon();
            }
        }
    })();
    return running;
}

function showStatus() {
    const el = document.getElementById('kiori_status');
    if (!el) return;
    const s = settings();
    if (!s.apiKey) { el.textContent = 'Paste your Kiori key to start.'; return; }
    const here = ctx().chatMetadata?.kiori?.brains ?? {};
    // A brain may come from a shared card: only its numbers are read, as numbers
    const count = v => Math.max(0, Math.floor(Number(v) || 0));
    const lines = cast().map(ch => { const b = here[keyOf(ch)] ?? here[Object.keys(here).find(o => o !== keyOf(ch) && renamedTo(o) === keyOf(ch))]; return b ? `${esc(ch.name)}: ${count(b.memories?.length)} memories, learned through message ${count(b.chat?.learned)}` : `${esc(ch.name)}: a brain on the first reply`; });
    el.innerHTML = lines.join('<br>') || 'Open a chat to see its brains.';
}

const SETTINGS_HTML = `
<div class="kiori-settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header"><b>Kiori</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
    <div class="inline-drawer-content">
      <label class="checkbox_label"><input type="checkbox" id="kiori_enabled"><span>Give characters a brain</span></label>
      <label for="kiori_key">Kiori key</label>
      <input id="kiori_key" class="text_pole" type="password" placeholder="kio_..." autocomplete="off">
      <label for="kiori_url">Kiori address</label>
      <input id="kiori_url" class="text_pole" placeholder="https://api.kiori.io">
      <label for="kiori_depth">New brains</label>
      <select id="kiori_depth" class="text_pole">
        <option value="full">Full: a whole past (about a minute, about a cent on your brain key)</option>
        <option value="light">Light: from the card alone, free, at once</option>
      </select>
      <label for="kiori_budget">Memory per reply (characters)</label>
      <input id="kiori_budget" class="text_pole" type="number" min="800" max="20000" step="100">
      <div id="kiori_status" class="kiori-status"></div>
      <div class="kiori-row">
        <div id="kiori_learn" class="menu_button">Learn now</div>
        <div id="kiori_forget" class="menu_button">Forget this chat</div>
      </div>
      <small class="kiori-note">Brains are kept in your chat files and on your character cards, on this computer. Kiori stores no brains and no chats.</small>
    </div>
  </div>
</div>`;

jQuery(async () => {
    const s = settings();
    $('#extensions_settings2').append(SETTINGS_HTML);
    $('#kiori_enabled').prop('checked', s.enabled).on('change', e => { settings().enabled = e.target.checked; ctx().saveSettingsDebounced(); });
    $('#kiori_key').val(s.apiKey).on('change', e => { settings().apiKey = e.target.value.trim(); ctx().saveSettingsDebounced(); showStatus(); });
    $('#kiori_url').val(s.apiUrl).on('change', e => { settings().apiUrl = e.target.value.trim() || DEFAULTS.apiUrl; ctx().saveSettingsDebounced(); });
    $('#kiori_depth').val(s.depth).on('change', e => { settings().depth = e.target.value; ctx().saveSettingsDebounced(); });
    $('#kiori_budget').val(s.budget).on('change', e => { settings().budget = Math.min(20000, Math.max(800, Number(e.target.value) || DEFAULTS.budget)); ctx().saveSettingsDebounced(); });
    $('#kiori_learn').on('click', () => organize({ now: true }));
    $('#kiori_forget').on('click', async () => {
        if (!confirm("Forget what this chat taught its characters? They start again from their card's brain.")) return;
        ctx().chatMetadata.kiori = { brains: {} };
        await ctx().saveMetadata();
        showStatus();
    });
    const { eventSource, eventTypes } = ctx();
    eventSource.on(eventTypes.MESSAGE_RECEIVED, () => organizeSoon());
    for (const t of [eventTypes.MESSAGE_EDITED, eventTypes.MESSAGE_DELETED, eventTypes.MESSAGE_SWIPED]) eventSource.on(t, () => organizeSoon(4000));
    eventSource.on(eventTypes.CHAT_CHANGED, showStatus);
    // A renamed character: their chats move their brain over when next opened, and the brain on the card takes the new
    // name with the card (so new chats don't build it again)
    if (eventTypes.CHARACTER_RENAMED) eventSource.on(eventTypes.CHARACTER_RENAMED, async (oldAvatar, newAvatar) => {
        const st = settings();
        st.renamed = { ...(st.renamed ?? {}), [oldAvatar]: newAvatar };
        ctx().saveSettingsDebounced();
        const i = ctx().characters.findIndex(c => c.avatar === newAvatar);
        const ch = ctx().characters[i], b = ch?.data?.extensions?.kiori_brain;
        if (!b?.kiori) return;
        try {
            await ctx().writeExtensionField(i, 'kiori_brain', { ...b, name: ch.data?.name || ch.name });
            await ctx().writeExtensionField(i, 'kiori_card', cardHash(ch));
        } catch (e) { console.warn('[Kiori] could not rename the brain on the card', e); }
    });
    showStatus();
});
