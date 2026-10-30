// Calls that carry a customer's model key, or go to an address a customer gave, leave through here: https only, never
// a redirect, and only to an address on the public internet. The address is checked when the name is looked up for
// the connection itself, so neither a name that points inside (this machine, its network, a cloud's metadata address)
// nor one that changes its answer between a check and the call (DNS rebinding) can make Kiori call in. A Kiori run
// with KIORI_PROXY_ALLOW_LOCAL=1 (a model on this machine or the local network) uses plain fetch instead.
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { Readable } from 'node:stream';
import { securityNote } from './limits.mjs';

// What isn't the public internet: this machine, private and shared networks, link-local (where clouds keep their
// metadata service), documentation and benchmark ranges, multicast, reserved; in IPv6 also the forms that carry an
// IPv4 address inside (IPv4-compatible ::a.b.c.d, IPv4-translated ::ffff:0:a.b.c.d, NAT64, 6to4, Teredo), so none of
// those is a way around the IPv4 list. An IPv4-mapped address
// (::ffff:127.0.0.1) is checked against the IPv4 list by BlockList itself; a rule for ::ffff:0:0/96 would catch
// every IPv4 address too, so there is none.
const inside = new net.BlockList();
for (const s of ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
    '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4']) inside.addSubnet(s.split('/')[0], Number(s.split('/')[1]), 'ipv4');
for (const s of ['::/96', '::ffff:0:0:0/96', '64:ff9b::/96', '64:ff9b:1::/48', '100::/64', '2001::/32', '2001:db8::/32', '2002::/16',
    'fc00::/7', 'fe80::/10', 'fec0::/10', 'ff00::/8']) inside.addSubnet(s.split('/')[0], Number(s.split('/')[1]), 'ipv6');

export function isPublicAddress(ip) {
    const a = String(ip ?? '').replace(/^\[|\]$/g, ''), v = net.isIP(a);
    if (!v) return false;
    try { return !inside.check(a, v === 6 ? 'ipv6' : 'ipv4'); } catch { return false; }
}

const refused = host => {
    securityNote("a call to a provider address that isn't on the public internet was refused");
    return Object.assign(new Error(`The model provider's address (${host}) is not on the public internet`), { status: 400, code: 'BAD_REQUEST' });
};
// A network failure, shaped the way fetch reports one (callers read e.cause.code)
const failed = cause => Object.assign(new TypeError('fetch failed'), { cause });

// Names are looked up over DNS itself, with a time limit, not through the system's resolver: that one waits on four
// threads the whole server shares, with no limit, so names whose name server never answers could hold them all and
// stall every call out (and the file and key work that needs the same threads)
const resolver = new dns.promises.Resolver({ timeout: 2500, tries: 2 });
async function addressesOf(host) {
    const [v4, v6] = await Promise.allSettled([resolver.resolve4(host), resolver.resolve6(host)]);
    const list = [...(v4.value ?? []).map(address => ({ address, family: 4 })), ...(v6.value ?? []).map(address => ({ address, family: 6 }))];
    if (!list.length) throw v4.reason ?? v6.reason ?? Object.assign(new Error(`${host} has no address`), { code: 'ENODATA' });
    return list;
}
// The connection's own lookup: every address the name has must be public, and the connection goes to one of them
function lookup(hostname, options, callback) {
    addressesOf(hostname).then(all => {
        const list = options?.family ? all.filter(a => a.family === options.family) : all;
        if (!list.length || all.some(a => !isPublicAddress(a.address))) return callback(Object.assign(refused(hostname), { code: 'EBLOCKED' }));
        if (options?.all) return callback(null, list);
        callback(null, list[0].address, list[0].family);
    }, err => callback(err));
}
const agent = new https.Agent({ keepAlive: true, maxSockets: 256, lookup });

// A provider's answer as a fetch Response (status, headers, json(), text(), a streamable body)
function toResponse(res, method) {
    const headers = new Headers();
    for (const [k, v] of Object.entries(res.headers)) for (const x of Array.isArray(v) ? v : [v]) { try { headers.append(k, x); } catch { /* a header fetch would refuse too */ } }
    const empty = method === 'HEAD' || [204, 205, 304].includes(res.statusCode);
    if (empty) res.resume();
    return new Response(empty ? null : Readable.toWeb(res), { status: res.statusCode, statusText: res.statusMessage ?? '', headers });
}

// A provider's answer is read up to a size, never whole whatever it is: a reply, a list of models or an error is far
// smaller, and an answer that keeps coming would otherwise fill this server's memory (and stop it for everyone)
export const MAX_ANSWER = 8e6;
export async function readAnswer(r, max = MAX_ANSWER) {
    if (!r.body) return '';
    const chunks = [];
    let size = 0;
    try {
        for await (const c of r.body) {
            size += c.length;
            if (size > max) throw Object.assign(new Error(`The model provider's answer was over ${max / 1e6} MB`), { status: 502, code: 'PROVIDER' });
            chunks.push(c);
        }
    } catch (e) {
        throw e.code === 'PROVIDER' ? e : Object.assign(new Error(`The model provider's answer broke off (${e.cause?.code ?? e.message})`), { status: 502, code: 'PROVIDER' });
    }
    return Buffer.concat(chunks).toString('utf8');
}
// ...as JSON: null when it isn't JSON (the caller says why), an error when it's too big
export async function answerJson(r, max) {
    const text = await readAnswer(r, max);
    try { return JSON.parse(text); } catch { return null; }
}

// fetch, for a model provider out on the internet: the same answer, or a refusal (400) for an address that isn't
// public, and a network failure for one that only turns out not to be once connecting. Redirects come back as they
// are (a 3xx), never followed.
export async function safeFetch(url, { method = 'GET', headers = {}, body = null, signal } = {}) {
    const u = new URL(url);
    if (u.protocol !== 'https:') throw Object.assign(new Error('A model provider must be an https address'), { status: 400, code: 'BAD_REQUEST' });
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host)) { if (!isPublicAddress(host)) throw refused(host); }
    else if (/(^|\.)localhost\.?$/i.test(host)) throw refused(host);
    else {
        // A clear answer up front for a name that points inside; the connection checks again (see lookup)
        let list;
        try { list = await addressesOf(host); } catch (e) { throw failed(e); }
        if (!list.length || list.some(a => !isPublicAddress(a.address))) throw refused(host);
    }
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const req = https.request(u, { method, agent, signal, headers: { ...headers, ...(body != null && { 'Content-Length': Buffer.byteLength(body) }) } }, res => {
            try { resolve(toResponse(res, method)); } catch (e) { res.destroy(); reject(failed(e)); }
        });
        req.on('error', e => reject(signal?.aborted ? signal.reason : e?.code === 'EBLOCKED' ? refused(host) : failed(e)));
        req.end(body ?? undefined);
    });
}
