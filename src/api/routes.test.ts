import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtemp, rm, symlink, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { createAuth } from '../security/auth.js';
import { createAPIRoutes } from './routes.js';
import express from 'express';

vi.mock('../ai/service.js', () => ({ getAIService: vi.fn(() => ({
    hasProvider: () => true, getConfiguredProviders: () => ['groq'],
    generateText: async () => ({ text: 'Generated text', provider: 'groq' }),
    extractJobDetails: async () => ({ data: { title: 'Engineer' }, provider: 'groq' }),
    analyzeResume: async () => ({ data: { matchScore: 80 }, provider: 'groq' }),
    draftEmail: async () => ({ data: { subject: 'Hello', body: 'Draft' }, provider: 'groq' }),
    researchCompany: async () => ({ data: { name: 'Example' }, provider: 'groq' }),
    parseJobDescription: async () => ({ data: { requiredSkills: [] }, provider: 'groq' }),
    parseProfile: async () => ({ data: { name: 'Synthetic owner' }, provider: 'groq' }),
}) ) }));
const ORIGIN = 'http://127.0.0.1:8080';
const PASSWORD = 'synthetic-phase-zero-owner-passphrase-only';
const HOST = '127.0.0.1:3002';
let directory: string;
let app: ReturnType<typeof createApp>;
let cookie: string;
async function login(target = app) {
    const result = await request(target).post('/api/auth/login').set('Host', HOST).set('Origin', ORIGIN).send({ password: PASSWORD });
    expect(result.status).toBe(200);
    const header = result.headers['set-cookie'];
    return (Array.isArray(header) ? header[0] : header).split(';')[0];
}
function get(url: string) { return request(app).get(url).set('Host', HOST).set('Cookie', cookie); }
function post(url: string) { return request(app).post(url).set('Host', HOST).set('Origin', ORIGIN).set('Cookie', cookie); }

beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'poki-api-test-'));
    vi.stubEnv('SAFE_DATA_DIR', directory);
    app = createApp({ password: PASSWORD });
    cookie = await login();
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(directory, { recursive: true, force: true }); });

describe('backend sessions and browser boundary', () => {
    it('enforces authentication on every business route and method', async () => {
        for (const [method, route] of [['get', '/status'], ['get', '/jobs'], ['post', '/jobs'], ['delete', '/jobs'],
            ['get', '/resume'], ['post', '/resume'], ['get', '/profile'], ['post', '/profile'], ['post', '/generate'],
            ['post', '/extract-job'], ['post', '/analyze-resume'], ['post', '/research'], ['post', '/draft-email'],
            ['post', '/parse-jd'], ['post', '/config'], ['post', '/scrape-linkedin'], ['delete', '/jobs/example']] as const) {
            const result = await request(app)[method](`/api${route}`).set('Host', HOST).set('Origin', ORIGIN);
            expect(result.status, `${method} ${route}`).toBe(401);
        }
        expect((await request(app).get('/api/status').set('Host', HOST).set('Authorization', 'Bearer fabricated')).status).toBe(401);
    });
    it('router enforces auth even when mounted without the application factory', async () => {
        const minimal = express(); minimal.use('/api', createAPIRoutes(createAuth({ password: PASSWORD })));
        expect((await request(minimal).get('/api/jobs')).status).toBe(401);
    });
    it('issues HttpOnly SameSite Strict session cookie without exposing it in JSON', async () => {
        const result = await request(app).post('/api/auth/login').set('Host', HOST).set('Origin', ORIGIN).send({ password: PASSWORD });
        expect(result.headers['set-cookie'][0]).toMatch(/HttpOnly/);
        expect(result.headers['set-cookie'][0]).toMatch(/SameSite=Strict/);
        expect(result.headers['set-cookie'][0]).toMatch(/Path=\/api/);
        expect(JSON.stringify(result.body)).not.toMatch(/token|password|synthetic-phase/);
        expect((await get('/api/auth/session')).body.user.id).toBe('local-owner');
    });
    it('sets Secure cookies with an HTTPS origin', async () => {
        const secure = createApp({ password: PASSWORD, appOrigin: 'https://poki.example', allowedHosts: [HOST] });
        const result = await request(secure).post('/api/auth/login').set('Host', HOST).set('Origin', 'https://poki.example').send({ password: PASSWORD });
        expect(result.headers['set-cookie'][0]).toMatch(/Secure/);
    });
    it('revokes on logout and rotates login sessions', async () => {
        const old = cookie;
        const rotated = await post('/api/auth/login').send({ password: PASSWORD });
        expect(rotated.status).toBe(200);
        expect((await get('/api/status')).status).toBe(401);
        cookie = rotated.headers['set-cookie'][0].split(';')[0];
        expect(cookie).not.toBe(old);
        expect((await post('/api/auth/logout').send({})).status).toBe(200);
        expect((await get('/api/auth/session')).status).toBe(401);
    });
    it('expires sessions and does not accept them after server restart', async () => {
        let current = 0;
        app = createApp({ password: PASSWORD, now: () => current }); cookie = await login();
        current = 8 * 60 * 60 * 1000;
        expect((await get('/api/status')).status).toBe(401);
        app = createApp({ password: PASSWORD });
        expect((await get('/api/status')).status).toBe(401);
    });
    it('rejects cross-origin reads, writes, preflight and missing-origin mutations', async () => {
        expect((await get('/api/status').set('Origin', 'https://attacker.example')).status).toBe(403);
        expect((await post('/api/jobs').set('Origin', 'null').send({ title: 'Synthetic' })).status).toBe(403);
        expect((await request(app).post('/api/jobs').set('Host', HOST).set('Cookie', cookie).send({ title: 'Synthetic' })).status).toBe(403);
        expect((await request(app).options('/api/jobs').set('Host', HOST).set('Origin', 'https://attacker.example')).status).toBe(403);
        const result = await request(app).options('/api/jobs').set('Host', HOST).set('Origin', ORIGIN).set('Access-Control-Request-Method', 'DELETE');
        expect(result.status).toBe(204); expect(result.headers['access-control-allow-origin']).toBe(ORIGIN);
        expect((await get('/api/status').set('Sec-Fetch-Site', 'cross-site')).status).toBe(403);
    });
    it('rejects foreign Host headers and ambiguous/fabricated cookies', async () => {
        expect((await get('/api/status').set('Host', 'attacker.example')).status).toBe(403);
        expect((await get('/api/status').set('Cookie', `${cookie}; ${cookie}`)).status).toBe(401);
        expect((await get('/api/status').set('Cookie', 'poki_session=forged')).status).toBe(401);
    });
    it('limits all API requests and permits a fresh window', async () => {
        let current = 0;
        app = createApp({ password: PASSWORD, limits: { maxRequests: 2, now: () => current } });
        cookie = await login();
        expect((await get('/api/status')).status).toBe(200);
        expect((await get('/api/status')).status).toBe(429);
        current = 60_000;
        expect((await get('/api/status')).status).toBe(200);
    });
    it('has no default password and rate limits failed logins', async () => {
        const disabled = createApp({ password: '' });
        expect((await request(disabled).post('/api/auth/login').set('Host', HOST).set('Origin', ORIGIN).send({ password: PASSWORD })).status).toBe(503);
        app = createApp({ password: PASSWORD });
        for (let i = 0; i < 5; i++) expect((await request(app).post('/api/auth/login').set('Host', HOST).set('Origin', ORIGIN).send({ password: 'wrong' })).status).toBe(401);
        expect((await request(app).post('/api/auth/login').set('Host', HOST).set('Origin', ORIGIN).send({ password: PASSWORD })).status).toBe(429);
    });
});
describe('authenticated API behavior with synthetic data', () => {
    it('keeps AI config and unsafe browser scraping disabled', async () => {
        expect((await post('/api/config').send({ groq: { apiKey: 'synthetic' } })).status).toBe(403);
        expect((await post('/api/scrape-linkedin').send({ url: 'https://www.linkedin.com/jobs/view/123' })).status).toBe(410);
    });
    it('validates fields and runs mocked AI operations', async () => {
        expect((await post('/api/generate').send({ prompt: 'Synthetic test' })).body.text).toBe('Generated text');
        expect((await post('/api/generate').send({ prompt: 123 })).status).toBe(400);
        expect((await post('/api/generate').send({ prompt: 'x', apiKey: 'unexpected' })).status).toBe(400);
        expect((await post('/api/extract-job').send({ text: 'Synthetic description' })).body.data.title).toBe('Engineer');
        expect((await post('/api/analyze-resume').send({ jobDescription: 'synthetic', resumeText: 'fixture' })).body.data.matchScore).toBe(80);
        expect((await post('/api/draft-email').send({ recipientName: 'Test', companyName: 'Example', jobTitle: 'Fixture' })).body.data.subject).toBe('Hello');
        expect((await post('/api/parse-jd').send({ description: 'Synthetic' })).status).toBe(200);
        expect((await post('/api/research').send({ companyName: 'Synthetic' })).status).toBe(200);
        expect((await post('/api/extract-job').send({})).status).toBe(400);
    });
    it('blocks SSRF on both routes without exposing upstream details', async () => {
        for (const endpoint of ['/api/extract-job', '/api/research']) {
            const result = await post(endpoint).send({ companyName: 'Test', url: 'http://169.254.169.254/latest/meta-data/' });
            // extract-job strict validation rejects the unrelated companyName too.
            expect([400, 500]).toContain(result.status);
            expect(JSON.stringify(result.body)).not.toContain('meta-data');
        }
        expect((await post('/api/extract-job').send({ url: 'http://127.0.0.1:3002/health' })).status).toBe(500);
    });
    it('stores queue/resume only in explicit safe directory and serializes concurrent jobs', async () => {
        expect((await get('/api/jobs')).body.count).toBe(0);
        await Promise.all(Array.from({ length: 4 }, (_, i) => post('/api/jobs').send({ title: `Synthetic ${i}`, company: 'Example', description: 'Fixture' }).expect(200)));
        const queued = await get('/api/jobs'); expect(queued.body.count).toBe(4);
        expect((await post('/api/jobs').send({ title: 'Synthetic 0', company: 'Example' })).body.isDuplicate).toBe(true);
        expect((await post('/api/resume').send({ text: 'Synthetic fixture only' })).status).toBe(200);
        expect((await get('/api/resume')).body.text).toBe('Synthetic fixture only');
        expect((await stat(path.join(directory, 'resume.txt'))).mode & 0o777).toBe(0o600);
        const deleted = await request(app).delete(`/api/jobs/${queued.body.data[0].id}`).set('Host', HOST).set('Origin', ORIGIN).set('Cookie', cookie);
        expect(deleted.status).toBe(200); expect((await get('/api/jobs')).body.count).toBe(3);
        expect((await post('/api/profile').send({ rawText: 'Synthetic profile' })).status).toBe(200);
        expect((await get('/api/profile')).body.profile.name).toBe('Synthetic owner');
    });
    it('rejects persistence symlinks without touching target', async () => {
        const outside = path.join(directory, 'outside-fixture.txt');
        await import('node:fs/promises').then(fs => fs.writeFile(outside, 'unchanged', { mode: 0o600 }));
        await symlink(outside, path.join(directory, 'resume.txt'));
        expect((await post('/api/resume').send({ text: 'should not write' })).status).toBe(500);
        expect((await get('/api/resume')).status).toBe(500);
        expect(await readFile(outside, 'utf8')).toBe('unchanged');
    });
    it('rejects oversized and malformed JSON with generic errors', async () => {
        expect((await post('/api/jobs').send({ title: 'x', description: 'x'.repeat(600_000) })).status).toBe(413);
        expect((await post('/api/jobs').set('Content-Type', 'application/json').send('{bad')).status).toBe(400);
    });
});
