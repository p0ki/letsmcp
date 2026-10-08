import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AIService } from './service.js';
import { GroqProvider, ClaudeProvider, GeminiProvider } from './providers/index.js';
import { AI_REQUEST_TIMEOUT_MS, MAX_AI_RESPONSE_BYTES, MAX_AI_PROMPT_BYTES, requestAIJson } from './providers/request.js';

const mockFetch = vi.fn();
const groqResponse = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));

beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    mockFetch.mockReset();
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('AIService provider selection', () => {
    it('has no providers with an empty configuration', () => {
        const service = new AIService({});
        expect(service.hasProvider()).toBe(false);
        expect(service.getConfiguredProviders()).toEqual([]);
    });
    it('generates text with the configured default', async () => {
        mockFetch.mockResolvedValue(groqResponse('Generated text'));
        const service = new AIService({ groq: { apiKey: 'fake-test-key' } });
        await expect(service.generateText('synthetic prompt')).resolves.toEqual({ text: 'Generated text', provider: 'groq' });
    });
    it('never sends data to a second provider after a failure', async () => {
        mockFetch.mockRejectedValue(new Error('fake-secret prompt and request details'));
        const service = new AIService({ groq: { apiKey: 'fake-groq' }, gemini: { apiKey: 'fake-gemini' } });
        await expect(service.generateText('synthetic sensitive text')).rejects.toThrow('AI provider request failed');
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(mockFetch.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions');
    });
    it('fails before network access for an unconfigured selected provider', async () => {
        const service = new AIService({ gemini: { apiKey: 'fake-key' } });
        expect(service.getProvider()).toBeUndefined();
        await expect(service.generateText('synthetic prompt')).rejects.toThrow('Selected AI provider is not configured');
        await expect(service.generateText('synthetic prompt', 'missing')).rejects.toThrow('Selected AI provider is not configured');
        expect(mockFetch).not.toHaveBeenCalled();
    });
    it('honors an explicit provider selection', async () => {
        mockFetch.mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini synthetic result' }] } }] })));
        const service = new AIService({ groq: { apiKey: 'fake-groq' }, gemini: { apiKey: 'fake-gemini' } });
        expect(service.getConfiguredProviders()).toEqual(['groq', 'gemini']);
        await expect(service.generateText('synthetic prompt', 'gemini')).resolves.toEqual({ text: 'Gemini synthetic result', provider: 'gemini' });
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });
});

describe('structured AI operations', () => {
    it('extracts a job from a response wrapped in markdown', async () => {
        const job = { title: 'Engineer', company: 'Synthetic Corp', location: 'Remote', description: 'Synthetic position' };
        mockFetch.mockResolvedValue(groqResponse('```json\n' + JSON.stringify(job) + '\n```'));
        const service = new AIService({ groq: { apiKey: 'fake-key' } });
        await expect(service.extractJobDetails('synthetic job')).resolves.toEqual({ data: job, provider: 'groq' });
    });
    it('analyzes a synthetic resume', async () => {
        const analysis = { matchScore: 75, strengths: ['TypeScript'], gaps: [], recommendations: [], keywords: { matched: ['TypeScript'], missing: [] } };
        mockFetch.mockResolvedValue(groqResponse(JSON.stringify(analysis)));
        const service = new AIService({ groq: { apiKey: 'fake-key' } });
        expect((await service.analyzeResume('synthetic job', 'synthetic resume')).data).toEqual(analysis);
    });
    it('drafts an email without logging malformed private generated content', async () => {
        const error = vi.spyOn(console, 'error');
        const log = vi.spyOn(console, 'log');
        mockFetch.mockResolvedValue(groqResponse('synthetic private output that is not JSON'));
        const service = new AIService({ groq: { apiKey: 'fake-key' } });
        const result = await service.draftEmail({ recipientName: 'Synthetic Person', recipientRole: 'Manager', companyName: 'Synthetic Corp', jobTitle: 'Engineer', tone: 'Professional', intent: 'Connect' });
        expect(result.data.confidence).toBe(0);
        expect(error).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
    });
    it('preserves a valid generated email', async () => {
        const email = { subject: 'Synthetic subject', body: 'Synthetic email body', confidence: 85 };
        mockFetch.mockResolvedValue(groqResponse(JSON.stringify(email)));
        const provider = new GroqProvider('fake-key');
        await expect(provider.draftEmail({ recipientName: 'Test Person', recipientRole: 'Manager', companyName: 'Test Corp', jobTitle: 'Engineer', tone: 'Professional', intent: 'Connect' })).resolves.toEqual(email);
    });
});

describe('AI transport safety', () => {
    it.each(['http://api.groq.com/openai/v1/chat/completions', 'https://attacker.example/collect', 'https://api.groq.com/openai/v1/chat/completions?key=fake-key', 'https://localhost/'])('rejects unapproved endpoint %s', async (url) => {
        await expect(requestAIJson(url, {}, {}, 'synthetic')).rejects.toThrow('Invalid AI provider endpoint');
        expect(mockFetch).not.toHaveBeenCalled();
    });
    it.each([
        ['groq', () => new GroqProvider('fake-key')],
        ['claude', () => new ClaudeProvider('fake-key')],
        ['gemini', () => new GeminiProvider('fake-key')],
    ] as const)('%s sanitizes upstream error responses and uses redirect rejection', async (_name, create) => {
        const error = vi.spyOn(console, 'error');
        mockFetch.mockResolvedValue(new Response('fake-secret synthetic private prompt', { status: 403 }));
        await expect(create().generateText('synthetic input')).rejects.toThrow(/^AI provider request failed$/);
        const [url, options] = mockFetch.mock.calls[0];
        expect(url).toMatch(/^https:\/\//);
        expect(url).not.toContain('fake-key');
        expect(options.redirect).toBe('error');
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(error).not.toHaveBeenCalled();
    });
    it('puts the Gemini API key in a header, never the query string', async () => {
        mockFetch.mockResolvedValue(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'synthetic result' }] } }] })));
        await new GeminiProvider('fake-key').generateText('synthetic input');
        const [url, options] = mockFetch.mock.calls[0];
        expect(new URL(url).search).toBe('');
        expect(options.headers['x-goog-api-key']).toBe('fake-key');
    });
    it.each(['../path', 'model?key=injection', 'model\nvalue', 'model/path', 'model#fragment'])('rejects unsafe model identifier %s', (model) => {
        expect(() => new GeminiProvider('fake-key', model)).toThrow('Invalid AI model identifier');
        expect(mockFetch).not.toHaveBeenCalled();
    });
    it('rejects header injection in a configured key', () => {
        expect(() => new GroqProvider('fake-key\r\nInjected: header')).toThrow('Invalid AI provider configuration');
    });
    it('rejects excessive input before making a request', async () => {
        await expect(new GroqProvider('fake-key').generateText('x'.repeat(MAX_AI_PROMPT_BYTES + 1))).rejects.toThrow('AI input exceeds size limit');
        expect(mockFetch).not.toHaveBeenCalled();
    });
    it('rejects responses that exceed the size cap even without Content-Length', async () => {
        mockFetch.mockResolvedValue(new Response('x'.repeat(MAX_AI_RESPONSE_BYTES + 1)));
        await expect(new GroqProvider('fake-key').generateText('synthetic input')).rejects.toThrow(/^AI provider request failed$/);
    });
    it('rejects excessive declared Content-Length', async () => {
        mockFetch.mockResolvedValue(new Response('{}', { headers: { 'Content-Length': String(MAX_AI_RESPONSE_BYTES + 1) } }));
        await expect(new GroqProvider('fake-key').generateText('synthetic input')).rejects.toThrow(/^AI provider request failed$/);
    });
    it('sanitizes malformed JSON without exposing the response', async () => {
        mockFetch.mockResolvedValue(new Response('synthetic private body invalid JSON'));
        await expect(new GroqProvider('fake-key').generateText('synthetic input')).rejects.toThrow(/^AI provider request failed$/);
    });
    it.each(['null', '[]', '"synthetic private response"'])('rejects an invalid provider envelope', async (body) => {
        mockFetch.mockResolvedValue(new Response(body));
        await expect(new GroqProvider('fake-key').generateText('synthetic input')).rejects.toThrow(/^AI provider request failed$/);
    });
    it('aborts a stalled request within the deadline', async () => {
        vi.useFakeTimers();
        mockFetch.mockImplementation((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('fake-secret aborted request')))));
        const request = new GroqProvider('fake-key').generateText('synthetic input');
        const rejection = expect(request).rejects.toThrow(/^AI provider request failed$/);
        await vi.advanceTimersByTimeAsync(AI_REQUEST_TIMEOUT_MS);
        await rejection;
        expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
    });
    it('keeps the timeout active while receiving a stalled response body', async () => {
        vi.useFakeTimers();
        mockFetch.mockImplementation((_url, options) => Promise.resolve(new Response(new ReadableStream({ start(controller) {
            options.signal.addEventListener('abort', () => controller.error(new Error('synthetic stalled body')));
        } }))));
        const request = new GroqProvider('fake-key').generateText('synthetic input');
        const rejection = expect(request).rejects.toThrow(/^AI provider request failed$/);
        await vi.advanceTimersByTimeAsync(AI_REQUEST_TIMEOUT_MS);
        await rejection;
    });
});

describe('environment-only AI singleton', () => {
    beforeEach(() => { vi.resetModules(); });
    it('stays disabled even when provider keys are present without an explicit opt-in', async () => {
        vi.stubEnv('POKI_ENABLE_AI', '');
        vi.stubEnv('DEFAULT_AI_PROVIDER', 'groq');
        vi.stubEnv('GROQ_API_KEY', 'fake-key');
        const { getAIService } = await import('./service.js');
        expect(getAIService().hasProvider()).toBe(false);
        await expect(getAIService().generateText('synthetic input')).rejects.toThrow('Selected AI provider is not configured');
        expect(mockFetch).not.toHaveBeenCalled();
    });
    it('loads only the explicitly selected environment provider', async () => {
        vi.stubEnv('POKI_ENABLE_AI', 'true');
        vi.stubEnv('DEFAULT_AI_PROVIDER', 'gemini');
        vi.stubEnv('GROQ_API_KEY', 'fake-groq');
        vi.stubEnv('GEMINI_API_KEY', 'fake-gemini');
        const { getAIService } = await import('./service.js');
        expect(getAIService().getConfiguredProviders()).toEqual(['gemini']);
        expect(getAIService().getProvider()?.name).toBe('gemini');
    });
    it.each(['', 'unknown'])('does not guess a provider when selection is %s', async (selected) => {
        vi.stubEnv('POKI_ENABLE_AI', 'true');
        vi.stubEnv('DEFAULT_AI_PROVIDER', selected);
        vi.stubEnv('GROQ_API_KEY', 'fake-groq');
        const { getAIService } = await import('./service.js');
        expect(getAIService().hasProvider()).toBe(false);
    });
    it('does not expose a runtime credential configuration entrypoint', async () => {
        const exports = await import('./service.js');
        expect(exports).not.toHaveProperty('configureAIService');
        expect(new AIService({})).not.toHaveProperty('updateConfig');
    });
});
