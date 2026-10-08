import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createServer } from './server.js';
import { sandboxReadText, sandboxWriteText } from './security/filesystem.js';

describe('Phase 0 MCP dispatch', () => {
    let root: string, previous: string | undefined;
    let server: ReturnType<typeof createServer>;
    beforeEach(async () => {
        previous = process.env.SAFE_DATA_DIR;
        root = await fs.mkdtemp(path.join(os.tmpdir(), 'letsmcp-tools-test-'));
        process.env.SAFE_DATA_DIR = root;
        server = createServer();
    });
    afterEach(async () => {
        if (previous === undefined) delete process.env.SAFE_DATA_DIR; else process.env.SAFE_DATA_DIR = previous;
        await fs.rm(root, { recursive: true, force: true });
        await server.close();
    });
    const call = async (name: string, args?: unknown) => (server as any)._requestHandlers.get('tools/call')({ method: 'tools/call', params: { name, arguments: args } });
    it('advertises only safe tools', async () => {
        const handlers = (server as any)._requestHandlers;
        const listed = await handlers.get('tools/list')({ method: 'tools/list' });
        expect(listed.tools.map((tool: any) => tool.name)).toEqual(['echoText', 'summarizeDirectory', 'saveToFile', 'readFile', 'searchFiles', 'webFetch']);
        const info = await handlers.get('resources/read')({ method: 'resources/read', params: { uri: 'server://info' } });
        expect(info.contents[0].text).not.toContain('executeCommand');
        expect(info.contents[0].text).not.toContain('scrapeLinkedInJob');
    });
    it.each(['executeCommand', 'scrapeLinkedInJob'])('rejects legacy %s without side effects', async name => {
        expect((await call(name, { command: 'touch', args: [path.join(root, 'must-not-exist')], url: 'http://127.0.0.1' })).isError).toBe(true);
        await expect(fs.access(path.join(root, 'must-not-exist'))).rejects.toThrow();
    });
    it.each([undefined, { text: 1 }, { text: 'ok', extra: true }])('handles malformed object arguments: %j', async args => expect((await call('echoText', args)).isError).toBe(true));
    it.each([{ args: null }, { args: [] }, { args: 'wrong' }])('SDK rejects malformed argument records: %j', async ({ args }) => await expect(call('echoText', args)).rejects.toThrow());
    it('saves, reads and searches literal text', async () => {
        expect((await call('saveToFile', { filename: 'sample.txt', category: 'notes/demo', content: 'Python\nPython\n(a+)+' })).isError).toBeUndefined();
        expect(JSON.parse((await call('readFile', { path: 'notes/demo/sample.txt' })).content[0].text).content).toContain('(a+)+');
        expect(JSON.parse((await call('searchFiles', { path: '.', query: 'Python' })).content[0].text).totalMatches).toBe(2);
        expect(JSON.parse((await call('searchFiles', { path: '.', query: '(a+)+' })).content[0].text).totalMatches).toBe(1);
        expect(JSON.parse((await call('summarizeDirectory', { path: 'notes' })).content[0].text).directories).toBe(1);
    });
    it('requires explicit SAFE_DATA_DIR', async () => {
        delete process.env.SAFE_DATA_DIR;
        for (const [tool, args] of [['readFile', { path: 'package.json' }], ['summarizeDirectory', { path: '.' }], ['searchFiles', { path: '.', query: 'x' }], ['saveToFile', { filename: 'x.txt', content: 'x' }]] as const) expect((await call(tool, args)).isError).toBe(true);
    });
    it.each(['../outside.txt', '/etc/passwd', '.env', '.ssh/id_rsa', 'folder/../../etc/passwd'])('blocks escaped or sensitive reads: %s', async input => expect((await call('readFile', { path: input })).isError).toBe(true));
    it('rejects prefix sibling paths', async () => expect((await call('readFile', { path: root + '-sibling/file.txt' })).isError).toBe(true));
    it('rejects symlink files, parents and hardlinks without overwriting their target', async () => {
        const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'letsmcp-outside-test-'));
        try {
            const secret = path.join(outside, 'secret.txt');
            await fs.writeFile(secret, 'fixture-secret');
            await fs.symlink(secret, path.join(root, 'link.txt'));
            await fs.symlink(outside, path.join(root, 'linked-dir'));
            await fs.link(secret, path.join(root, 'hardlink.txt'));
            for (const input of ['link.txt', 'linked-dir/secret.txt', 'hardlink.txt']) expect((await call('readFile', { path: input })).isError).toBe(true);
            for (const filename of ['link.txt', 'hardlink.txt']) expect((await call('saveToFile', { filename, content: 'attack', overwrite: true })).isError).toBe(true);
            expect((await call('saveToFile', { filename: 'new.txt', category: 'linked-dir', content: 'attack' })).isError).toBe(true);
            expect(await fs.readFile(secret, 'utf8')).toBe('fixture-secret');
            expect((await call('searchFiles', { path: '.', query: 'fixture-secret' })).isError).toBe(true);
        } finally { await fs.rm(outside, { recursive: true, force: true }); }
    });
    it('rejects symlink configuration and roots readable by others', async () => {
        const linked = root + '-link';
        await fs.symlink(root, linked);
        try {
            process.env.SAFE_DATA_DIR = linked;
            expect((await call('summarizeDirectory', { path: '.' })).isError).toBe(true);
            process.env.SAFE_DATA_DIR = root;
            await fs.chmod(root, 0o755);
            expect((await call('summarizeDirectory', { path: '.' })).isError).toBe(true);
        } finally { await fs.unlink(linked); }
    });
    it('requires overwrite consent and keeps private file modes', async () => {
        await call('saveToFile', { filename: 'existing.txt', content: 'first' });
        expect((await call('saveToFile', { filename: 'existing.txt', content: 'second' })).isError).toBe(true);
        expect(await fs.readFile(path.join(root, 'existing.txt'), 'utf8')).toBe('first');
        await fs.chmod(path.join(root, 'existing.txt'), 0o644);
        expect((await call('saveToFile', { filename: 'existing.txt', content: 'second', overwrite: true })).isError).toBeUndefined();
        expect((await fs.stat(path.join(root, 'existing.txt'))).mode & 0o777).toBe(0o600);
    });
    it('publishes complete old/new versions to concurrent readers', async () => {
        const versions = [JSON.stringify({ version: 0, text: 'a'.repeat(250_000) }), JSON.stringify({ version: 1, text: 'b'.repeat(250_000) })];
        await sandboxWriteText('jobs.json', versions[0]);
        const reader = async () => {
            for (let index = 0; index < 40; index++) {
                const observed = await sandboxReadText('jobs.json');
                expect(versions).toContain(observed);
                expect(() => JSON.parse(observed)).not.toThrow();
            }
        };
        const writer = async () => {
            for (let index = 0; index < 20; index++) await sandboxWriteText('jobs.json', versions[index % 2]);
        };
        await Promise.all([writer(), reader(), reader()]);
        expect((await fs.readdir(root)).filter(name => name.startsWith('.poki-write-'))).toEqual([]);
    });
    it('no-overwrite races publish only one complete file and remove their own temporaries', async () => {
        const versions = ['a'.repeat(50_000), 'b'.repeat(50_000)];
        const writes = await Promise.all(versions.map(content => call('saveToFile', { filename: 'race.txt', content })));
        expect(writes.filter(value => !value.isError)).toHaveLength(1);
        expect(versions).toContain(await sandboxReadText('race.txt'));
        expect((await fs.readdir(root)).filter(name => name.startsWith('.poki-write-'))).toEqual([]);
    });
    it.each(['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.azure', '.git', '.codex', '.agents', '.env.d', 'credentials', 'secrets'])('rejects credential directory ancestors in configured root: %s', async segment => {
        const credentialRoot = path.join(root, segment, 'nested');
        await fs.mkdir(credentialRoot, { recursive: true, mode: 0o700 });
        process.env.SAFE_DATA_DIR = credentialRoot;
        expect((await call('summarizeDirectory', { path: '.' })).isError).toBe(true);
    });
    it('enforces limits even if schema checks are bypassed', async () => {
        for (const value of [0, -1, NaN, Infinity, 1024 * 1024 + 1]) expect((await call('readFile', { path: 'file.txt', maxSize: value })).isError).toBe(true);
        expect((await call('saveToFile', { filename: 'large.txt', content: 'x'.repeat(1024 * 1024 + 1) })).isError).toBe(true);
        expect((await call('searchFiles', { path: '.', query: 'x', maxResults: 1000 })).isError).toBe(true);
        await fs.writeFile(path.join(root, 'big.txt'), 'x'.repeat(1024 * 1024 + 1));
        expect((await call('readFile', { path: 'big.txt' })).isError).toBe(true);
    });
    it.each(['http://127.0.0.1', 'http://2130706433', 'http://[::ffff:127.0.0.1]', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.1', 'file:///etc/passwd', 'https://linkedin.com@127.0.0.1/jobs'])('blocks MCP SSRF: %s', async url => expect((await call('webFetch', { url })).isError).toBe(true));
});
