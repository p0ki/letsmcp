import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import * as cheerio from 'cheerio';
import { MAX_FILE_BYTES, readSafeFile, saveSafeFile, searchSafeFiles, summarizeSafeDirectory } from './security/filesystem.js';
import { fetchPublicText } from './security/network.js';

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] });
const error = (message: string) => ({ ...result(message), isError: true });
const string = (input: Record<string, unknown>, key: string, max = 4096): string => {
    if (typeof input[key] !== 'string' || !(input[key] as string).length || (input[key] as string).length > max) throw new Error(`Invalid input: ${key} must be a bounded non-empty string`);
    return input[key] as string;
};
const optionalBoolean = (input: Record<string, unknown>, key: string): boolean | undefined => {
    if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`Invalid input: ${key} must be boolean`);
    return input[key] as boolean | undefined;
};
const integer = (input: Record<string, unknown>, key: string, fallback: number, max: number) => {
    const value = input[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid input: ${key} outside supported limits`);
    return value;
};
const schema = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object' as const, properties, required, additionalProperties: false });
const textSchema = { type: 'string', minLength: 1, maxLength: 4096 };
const definitions = [
    { name: 'echoText', description: 'Echo bounded text for connection testing.', inputSchema: schema({ text: textSchema }, ['text']) },
    { name: 'summarizeDirectory', description: 'Summarize an explicit SAFE_DATA_DIR subdirectory.', inputSchema: schema({ path: textSchema }, ['path']) },
    { name: 'saveToFile', description: 'Write bounded UTF-8 text inside SAFE_DATA_DIR.', inputSchema: schema({ content: { type: 'string', maxLength: MAX_FILE_BYTES }, filename: textSchema, category: textSchema, overwrite: { type: 'boolean' } }, ['content', 'filename']) },
    { name: 'readFile', description: 'Read a bounded regular UTF-8 file inside SAFE_DATA_DIR.', inputSchema: schema({ path: textSchema, encoding: { type: 'string', enum: ['utf8', 'utf-8'] }, maxSize: { type: 'integer', minimum: 1, maximum: MAX_FILE_BYTES } }, ['path']) },
    { name: 'searchFiles', description: 'Search literal text (not regular expressions) within bounded SAFE_DATA_DIR files.', inputSchema: schema({ query: textSchema, path: textSchema, fileTypes: { type: 'array', items: textSchema, maxItems: 20 }, caseSensitive: { type: 'boolean' }, recursive: { type: 'boolean' }, maxResults: { type: 'integer', minimum: 1, maximum: 100 } }, ['query', 'path']) },
    { name: 'webFetch', description: 'Fetch bounded public HTTP(S) content with DNS pinning and redirect checks.', inputSchema: schema({ url: textSchema, selector: { type: 'string', maxLength: 1024 }, format: { type: 'string', enum: ['text', 'html', 'json'] }, timeout: { type: 'integer', minimum: 1, maximum: 30000 } }, ['url']) },
];

export function registerTools(server: Server) {
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
    server.setRequestHandler(CallToolRequestSchema, async request => {
        if (request.params.name === 'executeCommand' || request.params.name === 'scrapeLinkedInJob') return error('Tool disabled by Phase 0 security policy');
        try {
            const raw = request.params.arguments;
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid input: expected an object');
            const args = raw as Record<string, unknown>;
            const definition = definitions.find(tool => tool.name === request.params.name);
            if (!definition) return error('Unknown tool');
            if (Object.keys(args).some(key => !(key in definition.inputSchema.properties))) throw new Error('Invalid input: unknown property');
            switch (request.params.name) {
                case 'echoText': return result({ echoed: string(args, 'text') });
                case 'summarizeDirectory': return result(await summarizeSafeDirectory(string(args, 'path')));
                case 'saveToFile': {
                    if (typeof args.content !== 'string') throw new Error('Invalid input: content must be a string');
                    return result(await saveSafeFile(string(args, 'filename', 255), args.content, args.category === undefined ? '' : string(args, 'category'), optionalBoolean(args, 'overwrite')));
                }
                case 'readFile': {
                    if (args.encoding !== undefined && !['utf8', 'utf-8'].includes(args.encoding as string)) throw new Error('Only UTF-8 text is supported');
                    const read = await readSafeFile(string(args, 'path'), integer(args, 'maxSize', MAX_FILE_BYTES, MAX_FILE_BYTES));
                    return result({ content: read.content, metadata: { ...read.metadata, path: read.metadataPath } });
                }
                case 'searchFiles': {
                    if (args.fileTypes !== undefined && (!Array.isArray(args.fileTypes) || args.fileTypes.length > 20 || args.fileTypes.some(type => typeof type !== 'string' || !/^[a-zA-Z0-9]{1,16}$/.test(type)))) throw new Error('Invalid fileTypes');
                    return result(await searchSafeFiles({ path: string(args, 'path'), query: string(args, 'query'), caseSensitive: optionalBoolean(args, 'caseSensitive'), recursive: optionalBoolean(args, 'recursive'), maxResults: integer(args, 'maxResults', 50, 100), fileTypes: args.fileTypes as string[] | undefined }));
                }
                case 'webFetch': {
                    const format = args.format ?? 'text';
                    if (!['text', 'html', 'json'].includes(format as string)) throw new Error('Invalid format');
                    const fetched = await fetchPublicText(string(args, 'url'), { timeoutMs: integer(args, 'timeout', 10000, 30000) });
                    let content = fetched.text;
                    if (format === 'json') content = JSON.stringify(JSON.parse(content));
                    else {
                        const $ = cheerio.load(content);
                        const selected = args.selector === undefined ? $('body') : $(string(args, 'selector', 1024));
                        content = format === 'text' ? selected.text() : args.selector === undefined ? content : selected.html() ?? '';
                    }
                    return result({ content, metadata: { url: fetched.url, statusCode: fetched.statusCode, contentType: fetched.contentType, size: fetched.size } });
                }
            }
            return error('Unknown tool');
        } catch (caught) {
            // Avoid exposing filesystem paths or runtime configuration from OS error messages.
            const osError = caught as NodeJS.ErrnoException;
            return error(osError.code ? `Operation rejected (${osError.code})` : caught instanceof Error ? caught.message : 'Operation rejected');
        }
    });
}
