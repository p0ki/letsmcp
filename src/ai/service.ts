/**
 * Unified AI Service
 * Uses one explicitly selected AI provider without third-party fallback
 */

import type { AIProvider, AIServiceConfig, JobDetails, ResumeAnalysis, EmailDraftContext, EmailDraft, CompanyResearch, ParsedJobDescription, ParsedProfile } from './types.js';
import { GroqProvider, ClaudeProvider, GeminiProvider } from './providers/index.js';

export class AIService {
    private providers: Map<string, AIProvider> = new Map();
    private defaultProvider: string = 'groq';

    constructor(config: AIServiceConfig) {
        // Initialize providers based on config
        if (config.groq?.apiKey) {
            this.providers.set('groq', new GroqProvider(config.groq.apiKey, config.groq.model));
        }
        if (config.claude?.apiKey) {
            this.providers.set('claude', new ClaudeProvider(config.claude.apiKey, config.claude.model));
        }
        if (config.gemini?.apiKey) {
            this.providers.set('gemini', new GeminiProvider(config.gemini.apiKey, config.gemini.model));
        }

        if (config.defaultProvider) {
            this.defaultProvider = config.defaultProvider;
        }
    }

    /**
     * Get list of configured providers
     */
    getConfiguredProviders(): string[] {
        return Array.from(this.providers.keys());
    }

    /**
     * Check if any provider is configured
     */
    hasProvider(): boolean {
        return this.providers.size > 0;
    }

    /**
     * Get a specific provider
     */
    getProvider(name?: string): AIProvider | undefined {
        if (name) {
            return this.providers.get(name);
        }
        return this.providers.get(this.defaultProvider);
    }

    /** Never resend user data to a different provider after an upstream failure. */
    private async execute<T>(
        operation: (provider: AIProvider) => Promise<T>,
        preferredProvider?: string
    ): Promise<{ result: T; provider: string }> {
        const name = preferredProvider ?? this.defaultProvider;
        const provider = this.providers.get(name);
        if (!provider || !provider.isConfigured()) throw new Error('Selected AI provider is not configured');
        try {
            return { result: await operation(provider), provider: name };
        } catch {
            throw new Error('AI provider request failed');
        }
    }

    /**
     * Generate text using AI
     */
    async generateText(prompt: string, preferredProvider?: string): Promise<{ text: string; provider: string }> {
        const { result, provider } = await this.execute(
            (p) => p.generateText(prompt),
            preferredProvider
        );
        return { text: result, provider };
    }

    /**
     * Extract job details from text
     */
    async extractJobDetails(text: string, preferredProvider?: string): Promise<{ data: JobDetails; provider: string }> {
        const { result, provider } = await this.execute(
            (p) => p.extractJobDetails(text),
            preferredProvider
        );
        return { data: result, provider };
    }

    /**
     * Analyze resume against job description
     */
    async analyzeResume(
        jobDescription: string,
        resumeText: string,
        preferredProvider?: string
    ): Promise<{ data: ResumeAnalysis; provider: string }> {
        const { result, provider } = await this.execute(
            (p) => p.analyzeResume(jobDescription, resumeText),
            preferredProvider
        );
        return { data: result, provider };
    }

    /**
     * Draft outreach email
     */
    async draftEmail(
        context: EmailDraftContext,
        preferredProvider?: string
    ): Promise<{ data: EmailDraft; provider: string }> {
        const { result, provider } = await this.execute(
            (p) => p.draftEmail(context),
            preferredProvider
        );
        return { data: result, provider };
    }

    /**
     * Research a company using AI
     */
    async researchCompany(
        companyName: string,
        pageContent?: string,
        preferredProvider?: string
    ): Promise<{ data: CompanyResearch; provider: string }> {
        const { result, provider } = await this.execute(
            (p) => p.researchCompany(companyName, pageContent),
            preferredProvider
        );
        return { data: result, provider };
    }

    /**
     * Parse a job description into structured data
     */
    async parseJobDescription(
        text: string,
        preferredProvider?: string
    ): Promise<{ data: ParsedJobDescription; provider: string }> {
        const { result, provider } = await this.execute(
            (p) => p.parseJobDescription(text),
            preferredProvider
        );
        return { data: result, provider };
    }

    async parseProfile(
        rawText: string,
        preferredProvider?: string
    ): Promise<{ data: ParsedProfile; provider: string }> {
        const { result, provider } = await this.execute(
            (p) => p.parseProfile(rawText),
            preferredProvider
        );
        return { data: result, provider };
    }
}

// Environment-only configuration. No runtime HTTP credential mutation is supported.
let aiServiceInstance: AIService | null = null;

export function getAIService(): AIService {
    if (!aiServiceInstance) {
        const enabled = process.env.POKI_ENABLE_AI === 'true';
        const selected = process.env.DEFAULT_AI_PROVIDER;
        const config: AIServiceConfig = {};
        if (enabled && selected === 'groq' && process.env.GROQ_API_KEY) {
            config.groq = { apiKey: process.env.GROQ_API_KEY, model: process.env.GROQ_MODEL };
            config.defaultProvider = 'groq';
        } else if (enabled && selected === 'claude' && process.env.CLAUDE_API_KEY) {
            config.claude = { apiKey: process.env.CLAUDE_API_KEY, model: process.env.CLAUDE_MODEL };
            config.defaultProvider = 'claude';
        } else if (enabled && selected === 'gemini' && process.env.GEMINI_API_KEY) {
            config.gemini = { apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL };
            config.defaultProvider = 'gemini';
        }
        aiServiceInstance = new AIService(config);
    }
    return aiServiceInstance;
}
