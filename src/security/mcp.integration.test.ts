import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';

afterEach(() => vi.unstubAllEnvs());
describe('real SDK protocol handshake and confined tools', () => {
    it('negotiates tools and enforces policy through client calls', async () => {
        const directory = await mkdtemp(path.join(tmpdir(), 'poki-mcp-protocol-test-'));
        vi.stubEnv('SAFE_DATA_DIR', directory);
        const server = createServer();
        const client = new Client({ name: 'synthetic-security-client', version: '1.0.0' });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        try {
            await server.connect(serverTransport);
            await client.connect(clientTransport);
            const { tools } = await client.listTools();
            expect(tools.map(tool => tool.name)).not.toContain('executeCommand');
            expect(tools.map(tool => tool.name)).not.toContain('scrapeLinkedInJob');
            const saved = await client.callTool({ name: 'saveToFile', arguments: { filename: 'fixture.txt', content: 'synthetic fixture' } });
            expect(saved.isError).not.toBe(true);
            const read = await client.callTool({ name: 'readFile', arguments: { path: 'fixture.txt' } });
            expect(JSON.stringify(read.content)).toContain('synthetic fixture');
            for (const input of [
                { name: 'readFile', arguments: { path: '/etc/passwd' } },
                { name: 'executeCommand', arguments: { command: 'touch', args: [path.join(directory, 'must-not-exist')] } },
                { name: 'scrapeLinkedInJob', arguments: { url: 'https://www.linkedin.com/jobs/view/123' } },
                { name: 'webFetch', arguments: { url: 'http://169.254.169.254/latest/meta-data/' } },
            ]) expect((await client.callTool(input)).isError).toBe(true);
            expect(await readdir(directory)).toEqual(['fixture.txt']);
        } finally {
            await client.close(); await server.close(); await rm(directory, { recursive: true, force: true });
        }
    });
});
