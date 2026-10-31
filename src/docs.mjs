// The docs pages: the markdown in docs/ (overview.md is the front page), as HTML in kiori.io's look: cream paper,
// cobalt ink, the serif headings; the pages down the side, the page's sections on the right. No scripts. The beta terms
// and the privacy policy (legal/, see legal.mjs) are pages of the same kind, at /terms and /privacy.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';
import { markdown } from './markdown.mjs';
import { LEGAL, LEGAL_TITLES, legalText } from './legal.mjs';

export const DOCS = ['overview', 'integration', 'concepts', 'api', 'security'];
const TITLES = { overview: 'Overview', integration: 'Integration', concepts: 'Concepts', api: 'API reference', security: 'Security' };
// The tab and home-screen icons (the mascot's face, in site/img); site/index.html and console/index.html carry the same tags
export const ICONS = '<link rel="icon" type="image/png" sizes="32x32" href="/site/img/favicon-32.png"><link rel="icon" type="image/png" sizes="16x16" href="/site/img/favicon-16.png"><link rel="icon" type="image/png" sizes="192x192" href="/site/img/favicon-192.png"><link rel="apple-touch-icon" href="/site/img/apple-touch-icon.png">';
const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="https://fonts.googleapis.com/css2?family=Caveat:wght@600;700&family=DM+Mono:wght@400;500&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&family=Instrument+Serif:ital@0;1&display=swap" rel="stylesheet">';

const CSS = `:root{--paper:#f6f1e6;--card:#fff;--line:#e4dccb;--ink:#13204a;--ink-2:#4b5781;--ink-3:#8b93ae;--cobalt:#1d55c4;--cobalt-2:#e8eefb;--gold:#f2c75c;--note:#fdf0bf;--code:#0e2153;--code-ink:#e2e8ff;
--serif:'Instrument Serif',Georgia,serif;--sans:'DM Sans',system-ui,-apple-system,sans-serif;--mono:'DM Mono',ui-monospace,Menlo,monospace;--hand:'Caveat','Bradley Hand',cursive}
@media (prefers-color-scheme:dark){:root{--paper:#0e1430;--card:#141c3d;--line:#242e58;--ink:#eef1fb;--ink-2:#b4bddd;--ink-3:#7d87ae;--cobalt:#86aaff;--cobalt-2:#1c2b5e;--note:#2c2714;--code:#0a1030}}
*{box-sizing:border-box}html{scroll-padding-top:76px}body{margin:0;background:var(--paper);color:var(--ink);font:15.5px/1.7 var(--sans);-webkit-font-smoothing:antialiased}
a{color:var(--cobalt);text-decoration:none}a:hover{text-decoration:underline}img{-webkit-user-drag:none;user-select:none;-webkit-touch-callout:none;pointer-events:none}
.top{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:18px;height:60px;padding:0 28px;border-bottom:1px solid var(--line);background:color-mix(in srgb,var(--paper) 90%,transparent);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px)}
.logo{position:relative;display:inline-flex;align-items:baseline;gap:9px;color:var(--ink);font:italic 400 26px/1 var(--serif)}.logo:hover{text-decoration:none}
.logo i{position:absolute;left:1px;top:-6px;width:16px;height:6px;border:1.6px solid var(--gold);border-radius:50%;transform:rotate(-14deg)}
.logo small{font:400 10px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3);font-style:normal}
.top .sp{flex:1}.top nav{display:flex;align-items:center;gap:20px;font-size:13.5px}.top nav a{color:var(--ink-2)}
.btn{display:inline-flex;align-items:center;height:34px;padding:0 15px;border-radius:999px;background:var(--ink);color:var(--paper)!important;font-weight:500}.btn:hover{text-decoration:none;background:var(--cobalt)}
.page{display:grid;grid-template-columns:220px minmax(0,760px) 200px;justify-content:center;gap:48px;padding:0 28px}
.side{position:sticky;top:60px;align-self:start;height:calc(100vh - 60px);overflow:auto;padding:34px 4px 24px 14px;margin-left:-14px}
.side p{margin:0 0 10px;font:400 10px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
.side a{display:block;margin:0 0 2px -10px;padding:6px 10px;border-radius:8px;color:var(--ink-2);font-size:14px}.side a:hover{background:var(--cobalt-2);text-decoration:none}
.side p.sub{margin-top:26px}
.side a.on{background:var(--card);color:var(--ink);font-weight:500;box-shadow:0 0 0 1px var(--line)}
.side .help{display:flex;align-items:center;gap:10px;margin-top:28px;padding-top:18px;border-top:1px dashed var(--line);font:600 19px/1.1 var(--hand);color:var(--ink-2)}
.side .help img{width:46px;height:46px;border-radius:50%;border:3px solid var(--card);box-shadow:0 0 0 1.5px var(--cobalt);background:#f3ead8}
main{padding:40px 0 90px;min-width:0}
main h1{margin:0 0 8px;font:400 44px/1.08 var(--serif);letter-spacing:-.015em}
main h1+p{font-size:17px;color:var(--ink-2)}
main h2{margin:2.4em 0 .5em;padding-top:1.1em;border-top:1.5px dashed var(--line);font:400 30px/1.15 var(--serif);letter-spacing:-.01em}
main h3{margin:1.9em 0 .4em;font:600 17px/1.35 var(--sans)}main h4{margin:1.5em 0 .3em;font:600 15px/1.4 var(--sans);color:var(--ink-2)}
main p,main li{color:var(--ink)}main ul,main ol{padding-left:1.25em}main li{margin:.3em 0}main li::marker{color:var(--cobalt)}
main code{padding:.12em .38em;border-radius:5px;background:var(--cobalt-2);color:var(--ink);font:400 .86em var(--mono)}
main pre{margin:1.1em 0 1.4em;padding:16px 18px;overflow-x:auto;border-radius:10px;background:var(--code);color:var(--code-ink);font:400 12.8px/1.75 var(--mono);box-shadow:0 18px 34px -26px rgba(8,22,61,.6)}
main pre code{padding:0;background:none;color:inherit;font:inherit}
main table{display:block;width:100%;margin:1.1em 0 1.4em;overflow-x:auto;border-collapse:collapse;font-size:14px}
main th{padding:7px 12px 9px;border-bottom:1.5px solid var(--line);text-align:left;vertical-align:bottom;font:400 10.5px/1.3 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);white-space:nowrap}
main td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:top}main td:first-child{white-space:nowrap}
main blockquote{margin:1.3em 0;padding:12px 16px;border-radius:4px;background:var(--note);color:var(--ink);box-shadow:0 12px 24px -20px rgba(60,40,10,.5)}
main strong{font-weight:600}
.toc{position:sticky;top:60px;align-self:start;padding:38px 0 24px;font-size:13px}
.toc p{margin:0 0 10px;font:400 10px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--ink-3)}
.toc a{display:block;padding:4px 0 4px 12px;border-left:1.5px solid var(--line);color:var(--ink-2);line-height:1.35}.toc a:hover{border-color:var(--cobalt);text-decoration:none;color:var(--ink)}
.pager{display:flex;justify-content:space-between;gap:16px;margin-top:64px;padding-top:22px;border-top:1.5px dashed var(--line)}
.pager a{display:flex;flex-direction:column;gap:2px;padding:12px 16px;border-radius:10px;background:var(--card);box-shadow:0 0 0 1px var(--line);color:var(--ink);min-width:180px}.pager a:hover{text-decoration:none;box-shadow:0 0 0 1.5px var(--cobalt)}
.pager small{font:400 10px/1 var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--ink-3)}.pager .next{margin-left:auto;text-align:right}
.foot{margin-top:40px;font-size:12.5px;color:var(--ink-3)}
@media (max-width:1180px){.page{grid-template-columns:200px minmax(0,760px);gap:40px}.toc{display:none}}
@media (max-width:820px){.top{padding:0 16px;gap:12px}.top nav a.wide{display:none}.page{display:block;padding:0 16px}
.side{position:static;height:auto;display:flex;gap:4px;overflow-x:auto;padding:12px 0;margin-left:0;border-bottom:1px solid var(--line);scrollbar-width:none}.side::-webkit-scrollbar{display:none}
.side p,.side .help{display:none}.side a{flex:none;margin:0}main{padding-top:26px}main h1{font-size:36px}.pager a{min-width:0;flex:1}}`;

// One docs page, rendered from the markdown. site: for the static site, where the console is on the API's server (api).
// email_off keeps Cloudflare's email obfuscation away: its decoding script would be blocked by the page's script policy.
// The side nav scrolls, so it keeps room on its left for what reaches past its edge (the links' highlight, the face's ring).
export function docsPage(name, { site = false, api = '' } = {}) {
    const legal = LEGAL.includes(name);
    if (!legal && !DOCS.includes(name)) return null;
    const file = path.join(ROOT, 'docs', `${name}.md`);
    if (!legal && !fs.existsSync(file)) return null;
    const body = markdown(legal ? legalText(name) : fs.readFileSync(file, 'utf8'));
    const href = d => LEGAL.includes(d) ? `/${d}` : `/docs${d === 'overview' ? '' : `/${d}`}`;
    const link = (d, title) => `<a href="${href(d)}"${d === name ? ' class="on" aria-current="page"' : ''}>${title}</a>`;
    const h1 = (body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? TITLES[name] ?? LEGAL_TITLES[name]).replace(/<[^>]+>/g, '');
    const sections = [...body.matchAll(/<h2 id="([^"]+)">([\s\S]*?)<\/h2>/g)].map(m => `<a href="#${m[1]}">${m[2].replace(/<[^>]+>/g, '')}</a>`).join('');
    const i = legal ? -1 : DOCS.indexOf(name), prev = DOCS[i - 1], next = legal ? null : DOCS[i + 1];
    const signIn = site ? `${api}/console` : '/console';
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${h1} · Kiori${legal ? '' : ' docs'}</title><meta name="description" content="Kiori${legal ? `: ${LEGAL_TITLES[name]}` : ` docs: ${TITLES[name]}`}.">${ICONS}${FONTS}<style>${CSS}</style></head>
<body><!--email_off--><header class="top"><a class="logo" href="/docs"><i></i>kiori<small>docs</small></a><span class="sp"></span><nav><a class="wide" href="/">Home</a><a class="wide" href="/openapi.json">OpenAPI</a><a class="wide" href="https://github.com/kiori-ai/kiori">GitHub</a><a href="${signIn}">Sign in</a><a class="btn" href="/#access">Get access</a></nav></header>
<div class="page"><nav class="side" aria-label="Docs"><p>Docs</p>${DOCS.map(d => link(d, TITLES[d])).join('')}<p class="sub">Legal</p>${LEGAL.map(d => link(d, LEGAL_TITLES[d])).join('')}<div class="help"><img src="/site/img/face-wink.webp" alt="" width="46" height="46"><span>stuck? <a href="mailto:help@kiori.io">write to us</a></span></div></nav>
<main>${body}<nav class="pager">${prev ? `<a href="${href(prev)}"><small>Previous</small>${TITLES[prev]}</a>` : ''}${next ? `<a class="next" href="${href(next)}"><small>Next</small>${TITLES[next]}</a>` : ''}</nav><p class="foot">© 2026 kiori · brains for characters · <a href="/terms">terms</a> · <a href="/privacy">privacy</a></p></main>
${sections ? `<aside class="toc"><p>On this page</p>${sections}</aside>` : '<aside class="toc"></aside>'}</div><!--/email_off--></body></html>`;
}
