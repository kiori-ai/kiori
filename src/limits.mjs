// Rate limits, in memory (one server): a fixed window per key. Enough to keep one caller from crowding out the rest
// and to slow down guessing; a fleet of servers would keep these in a shared store instead.
import { config } from './config.mjs';

const windows = new Map(), MAX_WINDOWS = 100000;
let swept = 0;
// The calls counted under a key in its current window, this one included. Past the most windows kept, the ones that
// ended go (at most once a second); a window still running is never dropped, since a fresh count for everyone is what a
// flood of new addresses would be after. While every window kept is still running, a new caller isn't counted.
export function hit(key, ms) {
    const now = Date.now();
    let w = windows.get(key);
    if (!w || now >= w.end) {
        if (!w && windows.size >= MAX_WINDOWS) {
            if (now - swept > 1000) { swept = now; for (const [k, x] of windows) if (now >= x.end) windows.delete(k); }
            if (windows.size >= MAX_WINDOWS) return 1;
        }
        windows.set(key, (w = { end: now + ms, n: 0 }));
    }
    return ++w.n;
}
export const allow = (key, max, ms) => hit(key, ms) <= max;

// Something worth a look: wrong admin keys, a flood of wrong keys, a refused sign-in link or provider address. A line
// in the log (the request's id, if there is one), never the address it came from or anything that was sent, so the
// log stays free of personal data
export const securityNote = (what, rid = null) => console.warn(`${new Date().toISOString()}  security  ${what}${rid ? `  [${rid}]` : ''}`);
// Seconds until a key's window opens again
export const retryAfter = key => Math.max(1, Math.ceil(((windows.get(key)?.end ?? Date.now()) - Date.now()) / 1000));

// The client's address. A proxy on this machine connects from 127.0.0.1 and says whom it passes on: the last address in
// X-Forwarded-For is the one it added (any before it, the client could have written). Cloudflare's CF-Connecting-IP is
// believed only with KIORI_TRUST_PROXY=cloudflare (Cloudflare's tunnel): another proxy passes that header on just as
// the client wrote it. From anywhere else neither header is believed.
export function clientIp(req) {
    const remote = String(req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
    if (remote !== '127.0.0.1' && remote !== '::1') return remote;
    return String((config.trustProxy === 'cloudflare' && req.headers['cf-connecting-ip']) || String(req.headers['x-forwarded-for'] ?? '').split(',').pop().trim() || remote);
}
// Who a limit counts: an IPv6 caller by its /64, the block one connection is usually given (counting each address
// apart would let a caller with such a block start over at will)
export function callerOf(ip) {
    ip = ip.split('%')[0].replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, '');
    if (!ip.includes(':')) return ip;
    const [head, tail] = ip.split('::'), a = head ? head.split(':') : [], b = tail ? tail.split(':') : [];
    const g = [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b].slice(0, 4).map(x => /^[\da-f]{1,4}$/i.test(x) ? parseInt(x, 16) : NaN);
    return g.length === 4 && g.every(n => n >= 0) ? `${g.map(n => n.toString(16)).join(':')}::/64` : ip;
}
