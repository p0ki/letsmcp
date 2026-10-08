import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.js';
import { createApp } from './app.js';

const PORT = Number(process.env.PORT ?? '3002');
const HOST = process.env.HOST ?? '127.0.0.1';
if (!['127.0.0.1', 'localhost', '::1'].includes(HOST) || !Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error('Phase 0 permits only a loopback listener and valid port');
}
// No default password, public enrollment, deployment, or provider calls at startup.
const app = createApp();
const httpServer = app.listen(PORT, HOST, () => console.error(`Local API listening on ${HOST}:${PORT}`));
httpServer.maxConnections = 128;
httpServer.requestTimeout = 30_000;
httpServer.headersTimeout = 10_000;
const server = createServer();
const transport = new StdioServerTransport();
server.connect(transport).catch(() => {
    console.error('MCP transport failed');
    httpServer.close();
    process.exitCode = 1;
});
async function shutdown() {
    httpServer.close();
    await server.close();
    process.exitCode = 0;
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
