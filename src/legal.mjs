// The beta terms and the privacy policy: the markdown in legal/, with the facts it depends on filled in from this one
// table. Change a fact here, not in the text: {{name}} in legal/*.md becomes its value, and a line whose fact is empty
// is left out (the postal address, for now). Both are beta documents, not yet reviewed by a lawyer.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

export const FACTS = {
    operator: 'Aras Aktaş',
    email: 'help@kiori.io',
    address: '',                                            // a postal address, if one is ever published
    country: 'Turkey',                                      // where the operator is based
    law: 'Turkey',                                          // whose laws govern the terms
    courts: 'Istanbul',                                     // whose courts decide disputes
    effective: '2026-10-31',
    hosting: 'OVHcloud, in Beauharnois (Canada)',
    mail: 'Cloudflare (email routing), which passes mail on to Google (Gmail)',
    logs: '14 days, in the server\'s system journal',
    backups: 'A backup of the database is made every night and kept on the server for 14 days. Our hosting provider also keeps a daily image of the whole server, each one replaced in turn.',
};

export const LEGAL = ['privacy', 'terms'];
export const LEGAL_TITLES = { privacy: 'Privacy policy', terms: 'Beta terms' };

// A document's markdown with its facts filled in; a name the table doesn't have is a mistake, never left in the page
export function legalText(name) {
    if (!LEGAL.includes(name)) return null;
    const src = fs.readFileSync(path.join(ROOT, 'legal', `${name}.md`), 'utf8');
    return src.split('\n').flatMap(line => {
        let empty = false;
        const out = line.replace(/\{\{(\w+)\}\}/g, (_, k) => {
            if (!(k in FACTS)) throw new Error(`legal/${name}.md: no fact "${k}" in src/legal.mjs`);
            if (!FACTS[k]) empty = true;
            return FACTS[k];
        });
        return empty ? [] : [out];
    }).join('\n');
}
