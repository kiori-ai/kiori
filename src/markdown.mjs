// A small markdown renderer for the docs pages (headings, lists, tables, code, emphasis, links).
// A link to another docs file (integration.md, docs/api.md#errors) goes to its page on the site; overview.md is /docs.
const docLink = u => u.replace(/^(?:\.\/)?(?:docs\/)?([\w-]+)\.md(?=#|$)/, (_, n) => n === 'overview' ? '/docs' : `/docs/${n}`);
// Quotes too, so nothing in the text can leave an attribute; a link goes to a web page, a mail address or a place on
// this site, never to a script (javascript:, data: and the like stay plain text)
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const linkable = u => /^(?:https?|mailto):/i.test(u) || !/^[^/?#]*:/.test(u);
const inline = s => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => linkable(u) ? `<a href="${docLink(u)}">${t}</a>` : t);

export function markdown(src) {
    const lines = src.replace(/\r/g, '').split('\n');
    const out = [];
    for (let i = 0; i < lines.length;) {
        const l = lines[i];
        if (l.startsWith('```')) {
            const lang = l.slice(3).trim(), buf = [];
            for (i++; i < lines.length && !lines[i].startsWith('```'); i++) buf.push(lines[i]);
            out.push(`<pre><code class="lang-${lang.replace(/[^\w-]/g, '')}">${esc(buf.join('\n'))}</code></pre>`); i++; continue;
        }
        const h = l.match(/^(#{1,4})\s+(.*)$/);
        if (h) { const id = h[2].toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, ''); out.push(`<h${h[1].length} id="${id}">${inline(h[2])}</h${h[1].length}>`); i++; continue; }
        if (/^\|/.test(l) && /^\|?\s*:?-+/.test(lines[i + 1] ?? '')) {
            const row = r => r.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
            const head = row(l); i += 2;
            const body = [];
            for (; i < lines.length && /^\|/.test(lines[i]); i++) body.push(row(lines[i]));
            out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
            continue;
        }
        if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
            const ordered = /^\s*\d+\./.test(l), buf = [];
            for (; i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i]); i++) buf.push(`<li>${inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`);
            out.push(`<${ordered ? 'ol' : 'ul'}>${buf.join('')}</${ordered ? 'ol' : 'ul'}>`); continue;
        }
        if (l.startsWith('> ')) { const buf = []; for (; i < lines.length && lines[i].startsWith('> '); i++) buf.push(inline(lines[i].slice(2))); out.push(`<blockquote>${buf.join('<br>')}</blockquote>`); continue; }
        if (!l.trim()) { i++; continue; }
        const buf = [];
        for (; i < lines.length && lines[i].trim() && !/^(#|```|\||>|\s*([-*]|\d+\.)\s)/.test(lines[i]); i++) buf.push(inline(lines[i]));
        out.push(`<p>${buf.join(' ')}</p>`);
    }
    return out.join('\n');
}
