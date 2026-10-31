// The public site as static files, for kiori.io on any static host (Cloudflare Pages): the landing page, the docs,
// the beta terms and the privacy policy, the OpenAPI description and the SDKs. The console and the API live on the server (api): "Sign in" leads there, and
// the access form under the plan sends its requests there. Every page goes out with its Content-Security-Policy
// (in _headers), made from the page's own scripts.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { DOCS, ICONS, docsPage } from './docs.mjs';
import { LEGAL } from './legal.mjs';
import { openapi } from './openapi.mjs';
import { csp } from './csp.mjs';

const DESCRIPTION = 'Kiori gives each of your characters a brain: what they remember, what they never saw, who they love, what they hide. You keep your chat, your model and their brains.';

// The build replaces its folder, so it only clears one that is empty or holds an earlier build: `--out .` must never take
// the checkout and its data/local with it.
function clearOut(out) {
    const st = fs.statSync(out, { throwIfNoEntry: false });
    if (!st) return;
    const was = st.isDirectory() ? fs.readdirSync(out) : null;
    if (!was || (was.length && !['_headers', 'openapi.json', 'index.html'].every(f => was.includes(f))))
        throw new Error(`site: ${out} isn't empty and isn't an earlier build; pick an empty folder, or delete it first`);
    fs.rmSync(out, { recursive: true, force: true });
}

export function buildSite(out = path.join(ROOT, 'dist'), { origin = 'https://kiori.io', api = 'https://api.kiori.io' } = {}) {
    clearOut(out);
    const write = (p, data) => { fs.mkdirSync(path.dirname(path.join(out, p)), { recursive: true }); fs.writeFileSync(path.join(out, p), data); };

    let s = fs.readFileSync(path.join(ROOT, 'site', 'index.html'), 'utf8');
    const swap = (a, b, count = 1) => {
        const n = s.split(a).length - 1;
        if (n !== count) throw new Error(`site: expected ${count}× "${a.slice(0, 70)}", found ${n}`);
        s = s.split(a).join(b);
    };
    // Shared links get a preview card
    swap('<title>Kiori — brains for characters</title>', `<title>Kiori — brains for characters</title>
<link rel="canonical" href="${origin}/">
<meta property="og:type" content="website">
<meta property="og:url" content="${origin}/">
<meta property="og:title" content="Kiori — brains for characters">
<meta property="og:description" content="${DESCRIPTION}">
<meta property="og:image" content="${origin}/site/img/hero.webp">
<meta name="twitter:card" content="summary_large_image">`);
    // The console and the API are on the API's server
    swap('<a class="btn ink" href="/console">Sign in</a>', `<a class="btn ink" href="${api}/console">Sign in</a>`);
    swap('<a href="/console">sign in</a>', `<a href="${api}/console">sign in</a>`);
    swap("fetch('/v1/access'", `fetch('${api}/v1/access'`);
    const left = [...s.matchAll(/href="\/console|fetch\('\/v1\//g)];
    if (left.length) throw new Error(`site: ${left.length} links to the API's server left`);
    write('index.html', s);
    fs.cpSync(path.join(ROOT, 'site', 'img'), path.join(out, 'site', 'img'), { recursive: true });
    // The icons also at the paths browsers and crawlers try on their own
    for (const f of ['favicon.ico', 'apple-touch-icon.png']) fs.copyFileSync(path.join(ROOT, 'site', 'img', f), path.join(out, f));

    // The docs (/docs is the overview), the API description, the SDKs to download
    const docs = DOCS.map(d => ({ d, html: docsPage(d, { site: true, api }) }));
    for (const { d, html } of docs) write(d === 'overview' ? 'docs/index.html' : `docs/${d}.html`, html);
    // The beta terms and the privacy policy at /terms and /privacy (Pages serves terms.html there)
    const legal = LEGAL.map(d => ({ d, html: docsPage(d, { site: true, api }) }));
    for (const { d, html } of legal) write(`${d}.html`, html);
    write('openapi.json', `${JSON.stringify(openapi, null, 2)}\n`);
    for (const f of ['kiori.mjs', 'kiori.d.ts', 'kiori.py']) write(`sdk/${f}`, fs.readFileSync(path.join(ROOT, 'sdk', f)));

    // Cloudflare Pages: headers (each page's script policy; the pictures shown only on kiori.io's own pages, not in other
    // sites' or in image search), a not-found page, and what search engines read
    const pagePolicy = csp(s, { connect: [api] });
    const docsPolicy = csp([...docs, ...legal].map(x => x.html).join('\n'));
    write('_headers', `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  X-Frame-Options: DENY
  Strict-Transport-Security: max-age=31536000
  Permissions-Policy: camera=(), microphone=(), geolocation=()
  Cross-Origin-Opener-Policy: same-origin
/
  Content-Security-Policy: ${pagePolicy}
/index.html
  Content-Security-Policy: ${pagePolicy}
/docs
  Content-Security-Policy: ${docsPolicy}
/docs/*
  Content-Security-Policy: ${docsPolicy}
${LEGAL.map(d => `/${d}\n  Content-Security-Policy: ${docsPolicy}\n/${d}.html\n  Content-Security-Policy: ${docsPolicy}\n`).join('')}/site/img/*
  Cache-Control: public, max-age=2592000
  Cross-Origin-Resource-Policy: same-site
  X-Robots-Tag: noindex
/favicon.ico
  Content-Type: image/x-icon
/site/img/favicon.ico
  Content-Type: image/x-icon
/sdk/kiori.d.ts
  Content-Type: text/plain; charset=utf-8
/sdk/kiori.py
  Content-Type: text/plain; charset=utf-8
`);
    write('404.html', `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Not here · Kiori</title>${ICONS}
<style>:root{--bg:#f6f1e6;--ink:#13204a;--blue:#1d55c4}@media (prefers-color-scheme: dark){:root{--bg:#0e1430;--ink:#eef1fb;--blue:#86aaff}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:17px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;padding:24px;text-align:center}
h1{font-size:28px;margin:0 0 6px}a{color:var(--blue)}</style></head>
<body><main><h1>Nothing here.</h1><p>Kiori remembers a lot, but not this page.</p><p><a href="/">Home</a> · <a href="/docs">Docs</a></p></main></body></html>
`);
    const pages = ['', 'docs', ...DOCS.filter(d => d !== 'overview').map(d => `docs/${d}`), ...LEGAL];
    write('robots.txt', `User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`);
    write('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages.map(p => `  <url><loc>${origin}/${p}</loc></url>`).join('\n')}\n</urlset>\n`);

    const files = [];
    const walk = d => { for (const e of fs.readdirSync(d, { withFileTypes: true })) e.isDirectory() ? walk(path.join(d, e.name)) : files.push(path.join(d, e.name)); };
    walk(out);
    return { out, files: files.length, bytes: files.reduce((t, f) => t + fs.statSync(f).size, 0) };
}
