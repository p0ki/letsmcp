import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

export const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ENTRIES = 1000;
const MAX_SEARCH_BYTES = 8 * MAX_FILE_BYTES;
const MAX_DEPTH = 16;
const denied = /^(?:\.|\.env(?:\..*)?|\.ssh|\.aws|\.git|\.codex|\.agents|credentials?(?:\..*)?|secrets?(?:\..*)?|authorized_keys|known_hosts|id_(?:rsa|ed25519|ecdsa)(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i;
const anchor = (handle: FileHandle) => `/proc/self/fd/${handle.fd}`;

function partsFor(root: string, input: string): string[] {
    if (typeof input !== 'string' || !input || input.includes('\0') || input.includes('\\')) throw new Error('Invalid path');
    // Reject traversal before normalization; absolute paths must be inside the root boundary.
    if (input.split('/').includes('..')) throw new Error('Path traversal is forbidden');
    const relative = path.isAbsolute(input) ? path.relative(root, input) : input;
    if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Path is outside SAFE_DATA_DIR');
    const parts = relative.split('/').filter(part => part !== '' && part !== '.');
    if (parts.length > MAX_DEPTH || parts.some(part => part.startsWith('.') || denied.test(part))) throw new Error('Sensitive or overly deep path is forbidden');
    return parts;
}

async function openRoot(): Promise<{ root: string; handle: FileHandle }> {
    if (process.platform !== 'linux') throw new Error('Filesystem tools require Linux fd confinement');
    const configured = process.env.SAFE_DATA_DIR;
    if (!configured || !path.isAbsolute(configured)) throw new Error('An explicit absolute SAFE_DATA_DIR is required');
    const root = path.resolve(configured);
    if ([path.parse(root).root, process.cwd(), process.env.HOME, '/tmp'].includes(root) || ['/etc', '/proc', '/sys', '/dev', '/run', '/var/run'].some(prefix => root === prefix || root.startsWith(prefix + '/')) || root.split(path.sep).some(part => denied.test(part) || /^\.(?:gnupg|kube|docker|azure)$/.test(part))) throw new Error('SAFE_DATA_DIR must be a dedicated private data directory');
    // Do not accept symlinked configuration or symlink ancestors.
    let cursor = path.parse(root).root;
    for (const part of root.split(path.sep).filter(Boolean)) {
        cursor = path.join(cursor, part);
        if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('SAFE_DATA_DIR cannot contain symlinks');
    }
    if ((await fs.realpath(root)) !== root) throw new Error('SAFE_DATA_DIR must be canonical');
    const handle = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if ((stat.mode & 0o077) !== 0) throw new Error('SAFE_DATA_DIR must be private (0700)');
        if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('SAFE_DATA_DIR must be owned by the service user');
        if ((await fs.realpath(anchor(handle))) !== root) throw new Error('SAFE_DATA_DIR changed during validation');
        return { root, handle };
    } catch (error) { await handle.close(); throw error; }
}

async function openDirectory(parent: FileHandle, name: string, create: boolean): Promise<FileHandle> {
    const target = `${anchor(parent)}/${name}`;
    if (create) await fs.mkdir(target, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
        const stat = await handle.stat();
        if ((stat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Data subdirectories must be private and service-owned');
        return handle;
    } catch (error) { await handle.close(); throw error; }
}

/** Each component is opened without following links, relative to an already-open directory.
 * This keeps parent-path replacement from redirecting subsequent opens outside the root.
 */
async function withDirectory<T>(input: string, create: boolean, callback: (directory: FileHandle, root: string) => Promise<T>): Promise<T> {
    const { root, handle } = await openRoot();
    const handles = [handle];
    try {
        for (const part of partsFor(root, input)) handles.push(await openDirectory(handles.at(-1)!, part, create));
        const current = await fs.realpath(anchor(handles.at(-1)!));
        const relative = path.relative(root, current);
        if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative)) throw new Error('Directory moved outside SAFE_DATA_DIR');
        return await callback(handles.at(-1)!, root);
    } finally { for (const opened of handles.reverse()) await opened.close(); }
}

async function readAt(directory: FileHandle, filename: string, maxBytes: number) {
    // O_NONBLOCK avoids a FIFO blocking before fstat can reject it.
    const file = await fs.open(`${anchor(directory)}/${filename}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await file.stat();
        // An atomic replacement may unlink this already-open old version before fstat.
        // Zero links is safe for that descriptor; multiple links remain forbidden.
        if (!stat.isFile() || stat.nlink > 1) throw new Error('Path must be a regular file without hard links');
        if (stat.size > maxBytes) throw new Error('File exceeds size limit');
        const bytes = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while (length < bytes.length) {
            const chunk = await file.read(bytes, length, bytes.length - length, null);
            if (!chunk.bytesRead) break;
            length += chunk.bytesRead;
        }
        if (length > maxBytes) throw new Error('File exceeds size limit');
        return { content: bytes.subarray(0, length).toString('utf8'), metadata: { size: length, modified: stat.mtime.toISOString(), encoding: 'utf-8' } };
    } finally { await file.close(); }
}

export async function readSafeFile(input: string, maxBytes = MAX_FILE_BYTES) {
    const configured = process.env.SAFE_DATA_DIR;
    if (!configured) throw new Error('An explicit absolute SAFE_DATA_DIR is required');
    const parts = partsFor(path.resolve(configured), input);
    const filename = parts.pop();
    if (!filename) throw new Error('Path is not a file');
    return withDirectory(parts.join('/') || '.', false, async directory => ({ ...(await readAt(directory, filename, maxBytes)), metadataPath: parts.concat(filename).join('/') }));
}

export async function saveSafeFile(filename: string, content: string, category = '', overwrite = false) {
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) throw new Error('Content exceeds size limit');
    if (!filename || filename.includes('/') || filename.includes('\\') || filename === '..' || filename.startsWith('.') || denied.test(filename)) throw new Error('Filename must be a safe single component');
    return withDirectory(category || '.', true, async directory => {
        const target = `${anchor(directory)}/${filename}`;
        async function checkTarget() {
            const existing = await fs.lstat(target).catch(error => { if (error.code !== 'ENOENT') throw error; return undefined; });
            if (!existing) return;
            if (!existing.isFile() || existing.nlink !== 1) throw new Error('Path must be a regular file without hard links');
            if (!overwrite) throw Object.assign(new Error('File already exists'), { code: 'EEXIST' });
        }
        await checkTarget();
        // Write a private sibling completely before publishing it. Hidden temporary
        // names cannot be read/listed using these tools; all paths use the open parent.
        const temporary = `${anchor(directory)}/.poki-write-${randomUUID()}`;
        let file: FileHandle | undefined;
        let created = false;
        try {
            file = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
            created = true;
            const stat = await file.stat();
            if (!stat.isFile() || stat.nlink !== 1) throw new Error('Path must be a regular file without hard links');
            await file.writeFile(content, 'utf8');
            await file.sync();
            const completed = await file.stat();
            if (!completed.isFile() || completed.nlink !== 1) throw new Error('Temporary file changed during write');
            await file.close();
            file = undefined;
            // Recheck before publication; symlinks/devices/hardlinks are never followed.
            // Same-account hostile filesystem mutations remain outside the OS boundary.
            await checkTarget();
            const candidate = await fs.lstat(temporary);
            if (!candidate.isFile() || candidate.nlink !== 1 || candidate.dev !== completed.dev || candidate.ino !== completed.ino) throw new Error('Temporary file changed before publication');
            if (overwrite) await fs.rename(temporary, target);
            else {
                // link is atomic and fails if the destination appeared after checkTarget.
                await fs.link(temporary, target);
                await fs.unlink(temporary);
            }
            await directory.sync();
        } finally {
            try { await file?.close(); }
            finally {
                if (created) await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
            }
        }
        return { success: true, path: path.posix.join(category, filename), message: 'File saved inside SAFE_DATA_DIR' };
    });
}

async function entriesAt(directory: FileHandle, consume?: () => void) {
    // Iterate with a limit instead of allocating an unbounded readdir result.
    const reader = await fs.opendir(anchor(directory));
    const entries = [];
    let visited = 0;
    for await (const entry of reader) {
        if (++visited > MAX_ENTRIES) throw new Error('Directory entry limit exceeded');
        consume?.();
        if (!entry.name.startsWith('.') && !denied.test(entry.name) && (entry.isFile() || entry.isDirectory())) entries.push(entry);
    }
    return entries;
}

/** HTTP compatibility helpers share the exact same root and confinement as MCP tools. */
export async function sandboxReadText(relativePath: string): Promise<string> {
    return (await readSafeFile(relativePath)).content;
}

export async function sandboxWriteText(relativePath: string, content: string, overwrite = true) {
    if (path.isAbsolute(relativePath) || relativePath.includes('\\') || relativePath.split('/').includes('..')) throw new Error('Expected safe relative data path');
    return saveSafeFile(path.posix.basename(relativePath), content, path.posix.dirname(relativePath), overwrite);
}

export async function summarizeSafeDirectory(input: string) {
    return withDirectory(input, false, async directory => {
        const entries = await entriesAt(directory);
        return { files: entries.filter(entry => entry.isFile()).length, directories: entries.filter(entry => entry.isDirectory()).length, total: entries.length, items: entries.slice(0, 20).map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : 'file' })) };
    });
}

export async function searchSafeFiles(input: { path: string; query: string; recursive?: boolean; caseSensitive?: boolean; maxResults?: number; fileTypes?: string[] }) {
    return withDirectory(input.path, false, async directory => {
        const matches: { file: string; line: number; content: string }[] = [];
        const needle = input.caseSensitive ? input.query : input.query.toLowerCase();
        const limit = input.maxResults ?? 50;
        let visited = 0, filesSearched = 0, bytesRead = 0;
        async function walk(current: FileHandle, prefix: string, depth: number): Promise<void> {
            if (depth > MAX_DEPTH) throw new Error('Search depth limit exceeded');
            for (const entry of await entriesAt(current, () => { if (++visited > MAX_ENTRIES) throw new Error('Search entry limit exceeded'); })) {
                if (matches.length >= limit) break;
                const relative = path.posix.join(prefix, entry.name);
                if (entry.isDirectory() && input.recursive !== false) {
                    const child = await openDirectory(current, entry.name, false);
                    try { await walk(child, relative, depth + 1); } finally { await child.close(); }
                } else if (entry.isFile() && (!input.fileTypes?.length || input.fileTypes.includes(path.extname(entry.name).slice(1)))) {
                    const remaining = Math.min(MAX_FILE_BYTES, MAX_SEARCH_BYTES - bytesRead);
                    if (remaining <= 0) throw new Error('Search byte limit exceeded');
                    const read = await readAt(current, entry.name, remaining);
                    bytesRead += read.metadata.size;
                    if (bytesRead > MAX_SEARCH_BYTES) throw new Error('Search byte limit exceeded');
                    filesSearched++;
                    const lines = read.content.split('\n');
                    for (let index = 0; index < lines.length && matches.length < limit; index++) {
                        const line = lines[index];
                        if ((input.caseSensitive ? line : line.toLowerCase()).includes(needle)) matches.push({ file: relative, line: index + 1, content: line.slice(0, 4096).trim() });
                    }
                }
            }
        }
        await walk(directory, '', 0);
        return { matches, totalMatches: matches.length, filesSearched };
    });
}
