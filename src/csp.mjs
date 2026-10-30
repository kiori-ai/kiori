// The Content-Security-Policy of Kiori's pages (the site, the docs, the console), from the page itself: a script runs
// only if it is one of the page's own inline scripts (each allowed by its hash), and none comes from anywhere else.
// Styles and fonts may come from Google Fonts, images from the same site, calls go back to the same site (and to the
// API, for the site's access form), and no other site may frame the page.
import crypto from 'node:crypto';

export const scriptHashes = html => [...String(html).matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(m => `'sha256-${crypto.createHash('sha256').update(m[1], 'utf8').digest('base64')}'`);

export function csp(html, { connect = [] } = {}) {
    const scripts = [...new Set(scriptHashes(html))];
    return [
        "default-src 'none'",
        `script-src ${scripts.length ? scripts.join(' ') : "'none'"}`,
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        'font-src https://fonts.gstatic.com',
        "img-src 'self' data:",
        ["connect-src 'self'", ...connect].join(' '),
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
    ].join('; ');
}
