/** All HTTP business routes require the application's own opaque session. */
import { randomUUID } from 'node:crypto';
import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { getAIService } from '../ai/service.js';
import { createAuth } from '../security/auth.js';
import { trackRequestWork } from '../security/limits.js';
import { fetchPublicText } from '../security/network.js';
import { sandboxReadText, sandboxWriteText } from '../security/filesystem.js';

const text = z.string().min(1).max(200_000);
const short = z.string().min(1).max(1000);
const provider = z.enum(['groq', 'claude', 'gemini']).optional();
const url = z.string().max(4096).url();
const jobSchema = z.object({
    id: z.string().max(128).optional(), title: short, company: z.string().max(1000).default(''),
    location: z.string().max(1000).default(''), description: z.string().max(200_000).default(''),
    url: url.optional(), originalLink: url.optional(), source: z.string().max(100).optional(),
    isRemote: z.boolean().optional(), dateAdded: z.string().max(64).optional(),
    scrapedAt: z.string().max(64).optional(), salaryRange: z.string().max(1000).optional(),
});
type QueuedJob = z.infer<typeof jobSchema>;
// Serialize local mutations. Phase 0 is one owner/one process; no multi-user claims.
let writeQueue: Promise<unknown> = Promise.resolve();
function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = writeQueue.then(operation);
    writeQueue = result.catch(() => undefined);
    return result;
}
async function readOptional(filename: string): Promise<string | undefined> {
    try { return await sandboxReadText(filename); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}
async function readJobs(): Promise<QueuedJob[]> {
    const stored = await readOptional('jobs.json');
    return stored === undefined ? [] : z.array(jobSchema).max(1000).parse(JSON.parse(stored));
}
function asyncRoute(handler: (req: Request, res: Response) => Promise<unknown>) {
    return (req: Request, res: Response, next: NextFunction) => { void trackRequestWork(res, () => handler(req, res)).catch(next); };
}
function body<T extends z.ZodTypeAny>(schema: T, req: Request): z.infer<T> { return schema.parse(req.body); }
function ai(res: Response) {
    const service = getAIService();
    if (!service.hasProvider()) { res.status(503).json({ error: 'AI is disabled or no provider is configured' }); return undefined; }
    return service;
}
function pageText(html: string) {
    return html.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function createAPIRoutes(auth = createAuth()): Router {
    const router = Router();
    router.use(auth.protectOrigin);
    router.use('/auth', auth.router);
    router.use(auth.requireSession);
    router.get('/status', (_req, res) => {
        const service = getAIService();
        res.json({ status: 'ok', version: '2.0.0', providers: service.getConfiguredProviders(), hasAI: service.hasProvider() });
    });
    router.post('/config', (_req, res) => res.status(403).json({ error: 'Runtime provider configuration is disabled' }));
    router.post('/scrape-linkedin', (_req, res) => res.status(410).json({ error: 'Browser scraping is disabled. Paste the job description instead.' }));
    router.post('/generate', asyncRoute(async (req, res) => {
        const input = body(z.object({ prompt: text, provider }).strict(), req);
        const service = ai(res); if (!service) return;
        res.json({ success: true, ...await service.generateText(input.prompt, input.provider) });
    }));
    router.post('/extract-job', asyncRoute(async (req, res) => {
        const input = body(z.object({ text: text.optional(), url: url.optional(), provider }).strict()
            .refine(value => !!value.text || !!value.url), req);
        let content = input.text ?? '';
        if (input.url) content = pageText((await fetchPublicText(input.url, { timeoutMs: 8000, maxBytes: 200_000 })).text);
        const service = ai(res); if (!service) return;
        res.json({ success: true, ...await service.extractJobDetails(content, input.provider) });
    }));
    router.post('/analyze-resume', asyncRoute(async (req, res) => {
        const input = body(z.object({ jobDescription: text, resumeText: text, provider }).strict(), req);
        const service = ai(res); if (!service) return;
        res.json({ success: true, ...await service.analyzeResume(input.jobDescription, input.resumeText, input.provider) });
    }));
    router.post('/draft-email', asyncRoute(async (req, res) => {
        const input = body(z.object({ recipientName: short, companyName: short, jobTitle: short,
            recipientRole: short.default('Team Member'), tone: z.enum(['Formal', 'Casual', 'Enthusiastic', 'Professional']).default('Professional'),
            intent: z.enum(['Connect', 'FollowUp', 'ReferralRequest', 'PeerOutreach']).default('Connect'),
            jobDescription: text.optional(), userBackground: text.optional(), provider }).strict(), req);
        const service = ai(res); if (!service) return;
        res.json({ success: true, ...await service.draftEmail(input, input.provider) });
    }));
    router.get('/resume', asyncRoute(async (_req, res) => {
        const stored = await readOptional('resume.txt') ?? '';
        res.json({ success: true, text: stored, hasResume: stored.length > 0 });
    }));
    router.post('/resume', asyncRoute(async (req, res) => {
        const input = body(z.object({ text: z.string().max(200_000) }).strict(), req);
        await serialize(() => sandboxWriteText('resume.txt', input.text, true));
        res.json({ success: true, message: 'Resume saved', length: input.text.length });
    }));
    router.post('/research', asyncRoute(async (req, res) => {
        const input = body(z.object({ companyName: short, url: url.optional(), provider }).strict(), req);
        const content = input.url ? pageText((await fetchPublicText(input.url, { timeoutMs: 8000, maxBytes: 200_000 })).text) : undefined;
        const service = ai(res); if (!service) return;
        res.json({ success: true, ...await service.researchCompany(input.companyName, content, input.provider),
            fetchedUrl: input.url && content ? input.url : null });
    }));
    router.post('/parse-jd', asyncRoute(async (req, res) => {
        const input = body(z.object({ description: text, provider }).strict(), req);
        const service = ai(res); if (!service) return;
        res.json({ success: true, ...await service.parseJobDescription(input.description, input.provider) });
    }));
    router.get('/profile', asyncRoute(async (_req, res) => {
        const stored = await readOptional('profile.json');
        res.json({ success: stored !== undefined, profile: stored ? JSON.parse(stored) : null });
    }));
    router.post('/profile', asyncRoute(async (req, res) => {
        const input = body(z.object({ rawText: text, provider }).strict(), req);
        const service = ai(res); if (!service) return;
        const result = await service.parseProfile(input.rawText, input.provider);
        await serialize(() => sandboxWriteText('profile.json', JSON.stringify(result.data), true));
        res.json({ success: true, profile: result.data, provider: result.provider });
    }));
    router.post('/jobs', asyncRoute(async (req, res) => {
        const job = body(jobSchema.strict(), req);
        const duplicate = await serialize(async () => {
            const jobs = await readJobs();
            if (jobs.some(other => (other.url && other.url === job.url) || other.title === job.title && other.company === job.company)) return true;
            if (jobs.length >= 1000) throw new Error('Queue limit');
            jobs.push({ ...job, id: randomUUID() });
            await sandboxWriteText('jobs.json', JSON.stringify(jobs), true);
            return false;
        });
        res.json({ success: true, message: duplicate ? 'Job already queued' : 'Job saved to queue', isDuplicate: duplicate });
    }));
    router.get('/jobs', asyncRoute(async (_req, res) => {
        const jobs = await readJobs();
        res.json({ success: true, count: jobs.length, data: jobs });
    }));
    router.delete('/jobs/:id', asyncRoute(async (req, res) => {
        const id = short.parse(req.params.id);
        await serialize(async () => {
            const jobs = await readJobs();
            await sandboxWriteText('jobs.json', JSON.stringify(jobs.filter(job => job.id !== id)), true);
        });
        res.json({ success: true, message: 'Job deleted' });
    }));
    router.delete('/jobs', asyncRoute(async (_req, res) => {
        await serialize(() => sandboxWriteText('jobs.json', '[]', true));
        res.json({ success: true, message: 'Job queue cleared' });
    }));
    router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
        res.status(error instanceof z.ZodError ? 400 : 500).json({ error: error instanceof z.ZodError ? 'Invalid request fields' : 'Request failed' });
    });
    return router;
}
