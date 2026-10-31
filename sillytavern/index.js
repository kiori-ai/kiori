// Kiori for SillyTavern. Every character gets a brain, kept in the chat's own file on this computer (Kiori itself
// stores no brains and no chats). Before each reply, what the character knows right now goes into the prompt; after
// it, the brain learns from the chat. A character's freshly built brain is also kept on their card, so every new chat
// with them starts from it instead of building again. Edits, swipes and deletions are noticed and unlearned. Each reply
// is checked against what its speaker could know: marked, or fixed in the chat, when it gives away what they never
// witnessed.

const MODULE = 'kiori';
const DEFAULTS = { enabled: true, apiUrl: 'https://api.kiori.io', apiKey: '', depth: 'full', budget: 4000, check: 'fast' };
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

// The chat as messages, oldest first (before: only the messages before that one). Hidden messages are left out; a
// message's send date is its id, so an edit or a swipe of it is noticed. present: who was there, for the messages Kiori
// placed while learning (a group chat)
function chatMessages(last = 60, { before, present = false } = {}) {
    const placed = present ? ctx().chatMetadata?.kiori?.placed ?? {} : {};
    return ctx().chat.slice(0, before)
        .filter(m => !m.is_system && typeof m.mes === 'string' && m.mes.trim())
        .slice(-last)
        .map(m => {
            const id = m.send_date ? String(m.send_date) : null, here = id && whoWasThere(placed[id]);
            return { ...(id && { id }), role: m.is_user ? 'user' : 'assistant', name: m.name, content: m.mes, ...(here && { present: here }) };
        });
}
// Who was there for a message, as Kiori placed it: names, or { name, mode }. Read from the chat file, so anything else
// in it is left out
const MODES = ['full', 'heard', 'overheard', 'saw', 'asleep'];
function whoWasThere(list) {
    if (!Array.isArray(list)) return null;
    const out = list.flatMap(x => (typeof x === 'string' ? [x.slice(0, 120)] : x && typeof x.name === 'string' && MODES.includes(x.mode) ? [{ name: x.name.slice(0, 120), mode: x.mode }] : [])).slice(0, 50);
    return out.length ? out : null;
}

// A character's card the way Kiori reads it (Tavern v2)
const cardOf = ch => (ch.data && typeof ch.data === 'object'
    ? { spec: 'chara_card_v2', spec_version: '2.0', data: { ...ch.data, name: ch.data.name || ch.name } }
    : { name: ch.name, description: ch.description ?? '', personality: ch.personality ?? '', scenario: ch.scenario ?? '', first_mes: ch.first_mes ?? '', mes_example: ch.mes_example ?? '' });

// What of a card a brain is built from, as a short hash (FNV-1a). The brain kept on a card is used only while the card
// still says the same: a duplicated character renamed and rewritten, or a card edited, gets a brain of its own. A brain
// kept before this hash is trusted while its name is the card's.
const CARD_READ = ['name', 'description', 'personality', 'scenario', 'first_mes', 'mes_example', 'creator_notes', 'character_book'];
function fnv(t) {
    let h = 0x811c9dc5;
    for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 0x01000193);
    return (h >>> 0).toString(36);
}
function cardHash(ch) {
    const c = cardOf(ch), d = c.data ?? c;
    return fnv(JSON.stringify(CARD_READ.map(f => d[f] ?? null)));
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
    const messages = chatMessages(60);
    // "Forget this chat" puts a new object here: an answer that comes back after it is not written back
    const mine = ctx().chatMetadata.kiori;
    if (!pairs.length) { if (now) say('info', 'Nothing to learn yet: the brains come with the first reply.'); return; }
    running = (async () => {
        try {
            const r = await kiori('/v1/brains/organize', { brains: pairs.map(([, b]) => b), messages, player: ctx().name1, ...(now && { now: true, hold: 0 }) });
            if (ctx().getCurrentChatId() !== chatId || ctx().chatMetadata.kiori !== mine) return;
            const fresh = brainsHere();
            pairs.forEach(([k], i) => { fresh[k] = r.brains[i]; });
            // Who Kiori placed in which message (a group chat), kept for the messages still sent: checking a reply sends
            // them, so a word said where its speaker wasn't stands out
            if (r.placed?.length) {
                const ids = new Set(messages.map(m => m.id).filter(Boolean));
                mine.placed = Object.fromEntries(Object.entries(mine.placed ?? {}).filter(([id]) => ids.has(id)));
                for (const p of r.placed) if (p.id && ids.has(p.id) && whoWasThere(p.present)) mine.placed[p.id] = p.present;
            }
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

// After each reply: checked against what its speaker could know (POST /v1/brains/check), never holding the chat up.
// fast: Kiori's pre-check alone, free, which marks a name or number only another brain holds; "ask the auditor" on the
// mark runs the full check for that reply. full: the pre-check, then the auditor on what it found, and a fixed reply
// takes the place of the one written, in the chat file too (so the brains learn from the fixed one). A failed check
// leaves the reply as it is. What was found is kept on the message (on its swipe), with the text it was found in.
const SKIP_CHECK = new Set(['first_message', 'command', 'impersonate', 'quiet']);
const checking = new WeakMap();
let checkWarned = null;
// Who wrote a reply: the chat's character, or in a group the member SillyTavern drafted for it
function speakerOf(m) {
    const members = cast();
    if (members.length === 1) return members[0];
    return members.find(ch => m.original_avatar && ch.avatar === m.original_avatar) ?? members.find(ch => ch.name === m.name) ?? null;
}
// A group's draft is checked as "Name: words" lines, one per paragraph, so Kiori knows whose words they are; the fix
// comes back the same way
const PARAGRAPHS = /(\n[ \t]*\n+)/;
const escRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const asLines = (text, name) => text.split(PARAGRAPHS).map((p, i) => (i % 2 || !p.trim() || p.trimStart().startsWith(`${name}:`) ? p : p.replace(/^\s*/, w => `${w}${name}: `))).join('');
const fromLines = (text, name) => text.replace(new RegExp(`^([ \\t]*)${escRe(name)}: ?`, 'gm'), '$1');
const editing = i => $(`#chat .mes[mesid="${i}"] .edit_textarea`).length > 0;

async function checkMessage(m, { mode = settings().check, asked = false } = {}) {
    const s = settings();
    if (!s.enabled || !s.apiKey || mode === 'off') { if (asked) say('info', s.enabled ? 'Add your Kiori key first.' : 'Kiori is off: turn on "Give characters a brain".'); return null; }
    if (!m || m.is_user || m.is_system || typeof m.mes !== 'string' || !m.mes.trim()) return null;
    const c = ctx(), chatId = c.getCurrentChatId(), at = c.chat.indexOf(m);
    const ch = at >= 0 && speakerOf(m), mine = ch && chatBrain(ch);
    if (!mine) return null;
    const reply = m.mes, job = `${mode}:${reply}`;
    if (checking.get(m) === job) return null;
    checking.set(m, job);
    try {
        // The speaker's brain, and in a group the others', so what only they hold stands out
        const brains = [mine, ...cast().filter(x => x !== ch).map(chatBrain).filter(Boolean)].slice(0, 12);
        const group = brains.length > 1, draft = group ? asLines(reply, mine.name) : reply;
        const r = await kiori('/v1/brains/check', { brains, messages: chatMessages(40, { before: at, present: true }), player: c.name1, draft, ...(mode === 'fast' && { check: 'fast' }) });
        // The chat moved on meanwhile (another chat; the reply edited, swiped, continued or gone): it stays as it is
        const now = ctx(), i = now.chat.indexOf(m);
        if (now.getCurrentChatId() !== chatId || i < 0 || m.mes !== reply || editing(i)) return null;
        const issues = (Array.isArray(r?.issues) ? r.issues : [])
            .filter(x => x && (mode === 'full' || (x.type === 'leak' && x.by === 'precheck')))
            .map(x => ({ character: String(x.character ?? mine.name).slice(0, 120), type: String(x.type ?? ''), quote: String(x.quote ?? '').slice(0, 200) }))
            .slice(0, 12);
        const back = typeof r?.fixed === 'string' && r.fixed.trim() && r.fixed.trim() !== draft.trim() ? (group ? fromLines(r.fixed, mine.name) : r.fixed) : null;
        const fixed = mode === 'full' && back?.trim() ? back : null;
        if (fixed) {
            m.mes = fixed;
            if (Array.isArray(m.swipes) && typeof m.swipe_id === 'number' && m.swipe_id < m.swipes.length) m.swipes[m.swipe_id] = fixed;
        }
        const record = { text: fnv(m.mes), mode, issues, ...(fixed && { fixed: true, original: reply.slice(0, 20000) }) };
        m.extra = m.extra && typeof m.extra === 'object' ? m.extra : {};
        m.extra.kiori_check = record;
        const info = Array.isArray(m.swipe_info) && m.swipe_info[m.swipe_id];
        if (info && typeof info === 'object') { info.extra = info.extra && typeof info.extra === 'object' ? info.extra : {}; info.extra.kiori_check = record; }
        if (fixed) {
            now.updateMessageBlock?.(i, m);
            try { await now.eventSource.emit?.(now.eventTypes.MESSAGE_UPDATED, i); } catch (e) { console.warn('[Kiori]', e); }
            // Learned already ("Learn now"): learned again from the fixed reply
            organizeSoon(4000);
        }
        if (fixed || issues.length) await now.saveChat?.();
        checkWarned = null;
        draw(ctx().chat.indexOf(m));
        return record;
    } catch (e) {
        console.warn('[Kiori] the check failed; the reply stays as it is', e);
        if (asked) say('error', `The auditor couldn't check it: ${e.message}`);
        else if (FINAL.has(e.code) && checkWarned !== e.code) { checkWarned = e.code; say('warning', `Replies aren't checked: ${e.message}`); }
        return null;
    } finally {
        if (checking.get(m) === job) checking.delete(m);
    }
}
function checkSoon(i, type) {
    if (SKIP_CHECK.has(type)) return;
    const m = ctx().chat[i];
    if (!m || m.extra?.kiori_check?.text === fnv(String(m.mes ?? ''))) return;
    checkMessage(m).catch(e => console.warn('[Kiori]', e));
}

// What a check found, under the reply: a lie a character keeps up is theirs, never a fault
const SAYS = {
    leak: "couldn't know", contradiction: 'contradicts their memories:', invented_past: "goes along with a past they don't have:",
    unsupported: "claims a past their memories don't hold:", misattribution: "names a source they don't have:", lie_slip: 'lets slip the truth behind their lie:',
};
function badgeHtml(m) {
    const rec = m?.extra?.kiori_check;
    if (!rec || !Array.isArray(rec.issues) || rec.text !== fnv(String(m.mes ?? ''))) return '';
    const faults = new Map(), liars = new Set();
    for (const x of rec.issues) {
        if (x.type === 'lie') { liars.add(String(x.character)); continue; }
        const k = JSON.stringify([String(x.character), SAYS[x.type] ? x.type : 'unsupported']);
        faults.set(k, [...(faults.get(k) ?? []), String(x.quote)]);
    }
    const lines = [...faults].map(([k, quotes]) => {
        const [who, type] = JSON.parse(k);
        return `${esc(who)} ${SAYS[type]} ${[...new Set(quotes)].map(q => `&quot;${esc(q)}&quot;`).join(', ')}`;
    });
    const out = [];
    if (lines.length || rec.fixed) {
        const head = rec.fixed ? 'Kiori fixed this' : 'Kiori';
        const ask = rec.mode === 'fast' && lines.length ? ' <span class="kiori-check-ask" role="button" tabindex="0">ask the auditor</span>' : '';
        const before = rec.fixed && rec.original ? ` title="${esc(`Before: ${String(rec.original).slice(0, 400)}`)}"` : '';
        out.push(`<div class="kiori-check${rec.fixed ? ' kiori-check-fixed' : ''}"${before}>${head}${lines.length ? `: ${lines.join('; ')}` : ''}${ask}</div>`);
    }
    for (const who of liars) out.push(`<div class="kiori-check kiori-check-lie">Kiori: ${esc(who)} is keeping up a lie</div>`);
    return out.join('');
}
function draw(i) {
    if (!(i >= 0)) return;
    const block = $(`#chat .mes[mesid="${i}"]`);
    block.find('.kiori-check').remove();
    const html = badgeHtml(ctx().chat[i]);
    if (html) block.find('.mes_text').after(html);
}
const drawAll = () => ctx().chat?.forEach((m, i) => { if (m?.extra?.kiori_check) draw(i); });
async function askAuditor(target) {
    const el = $(target), i = Number(el.closest('.mes').attr('mesid'));
    const m = ctx().chat[i];
    if (!m || el.hasClass('kiori-busy')) return;
    el.addClass('kiori-busy').text('asking the auditor…');
    const rec = await checkMessage(m, { mode: 'full', asked: true });
    if (rec && !rec.fixed && !rec.issues.some(x => x.type !== 'lie')) say('info', 'The auditor found nothing to fix.');
    draw(ctx().chat.indexOf(m));
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
      <label for="kiori_check">Check replies</label>
      <select id="kiori_check" class="text_pole">
        <option value="off">Off: replies stay as the model wrote them</option>
        <option value="fast">Fast: marks what a character couldn't know (free)</option>
        <option value="full">Full: the auditor fixes what slipped (about $0.001 a reply on your brain key)</option>
      </select>
      <small class="kiori-note">After each reply, Kiori checks it against what the speaker could know. Fast is Kiori's own pre-check, free and at once: it marks a name or a number only another character holds, and "ask the auditor" on the mark fixes that reply. Full sends every reply to the auditor too, which rewrites only the words that slipped; a fixed reply takes the place of the one written. A lie a character keeps up is theirs, and is left as it is.</small>
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
    $('#kiori_check').val(s.check).on('change', e => { settings().check = ['off', 'fast', 'full'].includes(e.target.value) ? e.target.value : DEFAULTS.check; ctx().saveSettingsDebounced(); });
    $(document).on('click', '.kiori-check-ask', e => { askAuditor(e.currentTarget).catch(err => console.warn('[Kiori]', err)); });
    $(document).on('keydown', '.kiori-check-ask', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); askAuditor(e.currentTarget).catch(err => console.warn('[Kiori]', err)); } });
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
    // A reply, once it is on screen with its final text (streamed or not, a swipe or a continue too), is checked in the
    // background; what a check found is drawn again when the message is swiped, edited or the chat shown again
    if (eventTypes.CHARACTER_MESSAGE_RENDERED) eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (i, type) => { draw(Number(i)); checkSoon(Number(i), type); });
    for (const t of [eventTypes.MESSAGE_SWIPED, eventTypes.MESSAGE_EDITED, eventTypes.MESSAGE_UPDATED]) if (t) eventSource.on(t, i => draw(Number(i)));
    for (const t of [eventTypes.CHAT_CHANGED, eventTypes.MORE_MESSAGES_LOADED]) if (t) eventSource.on(t, () => setTimeout(drawAll));
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
