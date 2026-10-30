// Character cards, the format character apps already use (Tavern / SillyTavern "chara_card_v2" and v3, the older
// v1, and the PNG files they are shared as). A customer sends the card they have; it becomes the description and
// the lore a brain is built from, and its scenario, first message and example dialogue stay on the character's card.

const str = v => (v == null ? '' : String(v)).trim();

// The JSON hidden in a card PNG: a tEXt chunk named "chara" (v2, base64) or "ccv3" (v3)
export function cardFromPng(buffer) {
    const b = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''), 'base64');
    if (b.length < 8 || b.readUInt32BE(0) !== 0x89504e47) return null;
    const found = {};
    for (let i = 8; i + 8 <= b.length;) {
        const len = b.readUInt32BE(i), type = b.toString('latin1', i + 4, i + 8);
        if (i + 12 + len > b.length) break;
        if (type === 'tEXt') {
            const data = b.subarray(i + 8, i + 8 + len), zero = data.indexOf(0);
            if (zero > 0) found[data.toString('latin1', 0, zero)] = data.toString('latin1', zero + 1);
        }
        if (type === 'IEND') break;
        i += 12 + len;
    }
    const raw = found.ccv3 ?? found.chara;
    if (!raw) return null;
    try { return JSON.parse(Buffer.from(raw, 'base64').toString('utf8')); } catch { return null; }
}

const isCard = o => !!o && typeof o === 'object' && (String(o.spec ?? '').startsWith('chara_card') || (o.data && typeof o.data === 'object' && 'name' in o.data && 'description' in o.data)
    || ('name' in o && ['first_mes', 'mes_example', 'scenario'].some(k => k in o)));

// A card → what a brain is built from: { name, description, lore, card: { scenario, first_message, examples } }.
// {{char}} and {{user}} become the character's name and "the user".
export function fromCharacterCard(input) {
    const raw = typeof input === 'string' ? cardFromPng(input) ?? (() => { try { return JSON.parse(input); } catch { return null; } })() : input;
    if (!isCard(raw)) return null;
    const d = raw.data && typeof raw.data === 'object' ? raw.data : raw;
    const name = str(d.name);
    if (!name) return null;
    const fill = t => str(t).replace(/\{\{char\}\}|<BOT>/gi, name).replace(/\{\{user\}\}|<USER>/gi, 'the user');
    const description = [
        fill(d.description),
        d.personality && `Personality: ${fill(d.personality)}`,
        d.scenario && `Scenario: ${fill(d.scenario)}`,
        d.mes_example && `How they talk (example dialogue):\n${fill(d.mes_example).replace(/<START>\s*/gi, '')}`,
        d.first_mes && `Their first message: ${fill(d.first_mes)}`,
    ].filter(Boolean).join('\n\n');
    // The card's lorebook is canon for the world they live in
    const entries = Array.isArray(d.character_book?.entries) ? d.character_book.entries : [];
    const lore = entries.filter(e => e && e.enabled !== false && str(e.content)).map(e => {
        const keys = (Array.isArray(e.keys) ? e.keys : []).map(str).filter(Boolean);
        return `${keys.length ? `${keys.slice(0, 4).join(', ')}: ` : ''}${fill(e.content)}`;
    }).join('\n\n');
    return {
        name, description, lore,
        card: Object.fromEntries(Object.entries({ scenario: fill(d.scenario), first_message: fill(d.first_mes), examples: fill(d.mes_example), tagline: str(d.creator_notes).slice(0, 300) }).filter(([, v]) => v)),
    };
}
