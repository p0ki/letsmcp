import * as dns from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.168.0.0', 16], ['192.88.99.0', 24], ['198.18.0.0', 15], ['198.51.100.0', 24],
    ['203.0.113.0', 24], ['168.63.129.16', 32], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) blocked.addSubnet(address, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
    const family = isIP(address);
    if (family === 4) return !blocked.check(address, 'ipv4');
    // Mapped IPv4, unspecified, loopback, ULA, link-local, NAT64, and multicast fail this allow range.
    if (family === 6) return globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
    return false;
}

type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;
const resolveDns: Resolver = hostname => dns.lookup(hostname, { all: true, verbatim: true });

/** DNS results are checked in full; the connection lookup is pinned to a checked address. */
export async function resolvePublicTarget(input: string, resolver: Resolver = resolveDns) {
    const url = new URL(input);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Only public HTTP(S) URLs on standard ports without credentials are allowed');
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (!hostname || hostname === 'localhost' || /\.(?:localhost|local|internal|home|lan)$/.test(hostname) || hostname === 'metadata.google.internal') throw new Error('Local and metadata hosts are forbidden');
    const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await resolver(hostname);
    if (!addresses.length || addresses.some(result => !isPublicAddress(result.address))) throw new Error('URL resolves to a non-public address');
    const selected = addresses[0];
    const lookup: LookupFunction = (_hostname, _options, callback) => callback(null, selected.address, selected.family);
    return { url, hostname, lookup, address: selected.address };
}

export type PublicTextResponse = { text: string; url: string; statusCode: number; contentType: string | undefined; size: number };
type Hop = { statusCode: number; location?: string; text: string; contentType?: string; size: number };
type Target = Awaited<ReturnType<typeof resolvePublicTarget>>;
type RequestHop = (target: Target, timeoutMs: number, maxBytes: number) => Promise<Hop>;

const requestHop: RequestHop = (target, timeoutMs, maxBytes) => new Promise((resolve, reject) => {
    const transport = target.url.protocol === 'https:' ? https : http;
    let completed = false;
    const req = transport.request(target.url, {
        // An explicit family prevents Node's automatic multi-address lookup path.
        method: 'GET', lookup: target.lookup, agent: false, family: isIP(target.address),
        headers: { 'user-agent': 'Poki-Career-OS-security-fetch/1', 'accept': 'text/html, text/plain, application/json', 'accept-encoding': 'identity' },
    }, res => {
        const statusCode = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(statusCode)) {
            res.destroy();
            finish(undefined, { statusCode, location: res.headers.location, text: '', size: 0 });
            return;
        }
        if (statusCode < 200 || statusCode >= 300) { res.destroy(); finish(new Error(`HTTP ${statusCode}`)); return; }
        if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') { res.destroy(); finish(new Error('Compressed responses are unsupported')); return; }
        const declaredSize = Number(res.headers['content-length']);
        if (declaredSize > maxBytes) { res.destroy(); finish(new Error('Response exceeds size limit')); return; }
        let size = 0;
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > maxBytes) { res.destroy(); finish(new Error('Response exceeds size limit')); } else chunks.push(chunk);
        });
        res.on('end', () => finish(undefined, { statusCode, text: Buffer.concat(chunks).toString('utf8'), contentType: res.headers['content-type'], size }));
        res.on('error', error => finish(error));
    });
    const timer = setTimeout(() => { req.destroy(); finish(new Error('Fetch time limit exceeded')); }, timeoutMs);
    function finish(error?: Error, result?: Hop) {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        if (error) reject(error); else resolve(result!);
    }
    req.on('error', error => finish(error));
    req.end();
});

/** A single total deadline covers DNS, all redirects and the complete response body.
 * Injectable resolver/request are for deterministic security tests, never URL-controlled.
 */
export async function fetchPublicText(input: string, options: { timeoutMs?: number; maxBytes?: number } = {}, dependencies: { resolver?: Resolver; request?: RequestHop } = {}): Promise<PublicTextResponse> {
    const timeoutMs = options.timeoutMs ?? 10000;
    const maxBytes = options.maxBytes ?? 1024 * 1024;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000 || !Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024) throw new Error('Invalid fetch limits');
    const deadline = Date.now() + timeoutMs;
    let current = input;
    for (let redirect = 0; redirect <= 4; redirect++) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error('Fetch time limit exceeded');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const target = await Promise.race([
            resolvePublicTarget(current, dependencies.resolver),
            new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('DNS time limit exceeded')), remaining); }),
        ]).finally(() => clearTimeout(timer));
        const response = await (dependencies.request ?? requestHop)(target, Math.max(1, deadline - Date.now()), maxBytes);
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
            if (!response.location || redirect === 4) throw new Error('Redirect limit exceeded or missing location');
            const next = new URL(response.location, target.url);
            if (target.url.protocol === 'https:' && next.protocol !== 'https:') throw new Error('HTTPS redirect downgrade is forbidden');
            current = next.toString();
            continue;
        }
        return { text: response.text, url: target.url.toString(), statusCode: response.statusCode, contentType: response.contentType, size: response.size };
    }
    throw new Error('Redirect limit exceeded');
}
