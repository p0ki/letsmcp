import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as http from 'node:http';
import { fetchPublicText, isPublicAddress, resolvePublicTarget } from './network.js';
vi.mock('node:http', async importOriginal => ({ ...await importOriginal<typeof import('node:http')>(), request: vi.fn() }));
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
describe('Public fetch boundary', () => {
    it.each(['0.0.0.0', '10.1.2.3', '100.64.1.2', '127.0.0.1', '169.254.169.254', '172.16.1.2', '192.168.1.2', '192.0.2.1', '198.18.1.1', '224.0.0.1', '255.255.255.255', '::', '::1', '::ffff:8.8.8.8', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::', '64:ff9b::a00:1', 'ff02::1'])('rejects %s', address => expect(isPublicAddress(address)).toBe(false));
    it.each(['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111'])('accepts global %s', address => expect(isPublicAddress(address)).toBe(true));
    it.each(['http://localhost.', 'http://metadata.google.internal', 'https://user:pass@example.com', 'http://example.com:3000', 'ftp://example.com', 'http://0177.0.0.1', 'http://0x7f000001'])('rejects URL %s', async url => await expect(resolvePublicTarget(url, publicDns)).rejects.toThrow());
    it('rejects any private DNS answer', async () => await expect(resolvePublicTarget('https://mixed.example', async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }])).rejects.toThrow('non-public'));
    it('pins lookup without a second DNS resolution', async () => {
        const resolver = vi.fn(publicDns);
        const target = await resolvePublicTarget('https://example.com', resolver);
        const found = await new Promise(resolve => target.lookup('example.com', {}, (error, address, family) => resolve({ error, address, family })));
        expect(found).toEqual({ error: null, address: '93.184.216.34', family: 4 });
        expect(resolver).toHaveBeenCalledTimes(1);
    });
    it.each(['http://127.0.0.1/secret', 'http://169.254.169.254/latest', 'http://private.example/secret'])('blocks redirect %s before requesting it', async location => {
        const request = vi.fn(async () => ({ statusCode: 302, location, text: '', size: 0 }));
        const resolver = async (host: string) => host === 'private.example' ? [{ address: '10.0.0.1', family: 4 }] : publicDns();
        await expect(fetchPublicText('http://example.com', {}, { resolver, request })).rejects.toThrow('non-public');
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('revalidates DNS per redirect to block rebinding', async () => {
        let count = 0;
        const resolver = async () => [{ address: ++count === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }];
        const request = vi.fn(async () => ({ statusCode: 302, location: '/next', text: '', size: 0 }));
        await expect(fetchPublicText('http://example.com', {}, { resolver, request })).rejects.toThrow('non-public');
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('bounds redirects and prevents HTTPS downgrade', async () => {
        const request = vi.fn(async () => ({ statusCode: 302, location: '/next', text: '', size: 0 }));
        await expect(fetchPublicText('https://example.com', {}, { resolver: publicDns, request })).rejects.toThrow('Redirect limit');
        expect(request).toHaveBeenCalledTimes(5);
        await expect(fetchPublicText('https://example.com', {}, { resolver: publicDns, request: async () => ({ statusCode: 302, location: 'http://example.com/', text: '', size: 0 }) })).rejects.toThrow('downgrade');
    });
    it('bounds DNS time', async () => await expect(fetchPublicText('https://example.com', { timeoutMs: 5 }, { resolver: () => new Promise(() => {}) })).rejects.toThrow('DNS time limit'));
    it('native transport pins lookup and caps streamed body', async () => {
        let options: any;
        vi.mocked(http.request).mockImplementation(((url: unknown, input: unknown, callback: (response: any) => void) => {
            options = input;
            const req = new EventEmitter() as any;
            req.destroy = vi.fn();
            req.end = () => queueMicrotask(() => {
                const res = new EventEmitter() as any;
                res.statusCode = 200; res.headers = {}; res.destroy = vi.fn();
                callback(res); res.emit('data', Buffer.from('too-large')); res.emit('end');
            });
            return req;
        }) as typeof http.request);
        await expect(fetchPublicText('http://example.com', { maxBytes: 3 }, { resolver: publicDns })).rejects.toThrow('size limit');
        expect(options.agent).toBe(false);
        expect(options.family).toBe(4);
        const callback = vi.fn(); options.lookup('example.com', {}, callback);
        expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    });
    it('native transport enforces whole-response time limit', async () => {
        vi.mocked(http.request).mockImplementation((() => {
            const req = new EventEmitter() as any;
            req.destroy = vi.fn(); req.end = vi.fn(); return req;
        }) as typeof http.request);
        await expect(fetchPublicText('http://example.com', { timeoutMs: 5 }, { resolver: publicDns })).rejects.toThrow('Fetch time limit');
    });
});
