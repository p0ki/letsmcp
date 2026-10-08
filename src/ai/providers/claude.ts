/**
 * Claude AI Provider (Anthropic)
 */

import type { AIProvider, JobDetails, ResumeAnalysis, EmailDraftContext, EmailDraft, CompanyResearch, ParsedJobDescription, ParsedProfile } from '../types.js';
import { PROMPTS, parseAIJson } from '../prompts.js';
import { requestAIJson, validateKey, validateModel } from './request.js';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';

export class ClaudeProvider implements AIProvider {
    name = 'claude';
    private apiKey: string;
    private model: string;

    constructor(apiKey: string, model: string = 'claude-3-5-sonnet-20241022') {
        this.apiKey = validateKey(apiKey);
        this.model = validateModel(model);
    }

    isConfigured(): boolean {
        return !!this.apiKey && this.apiKey.length > 0;
    }

    private async callAPI(prompt: string): Promise<string> {
        const data = await requestAIJson<{ content?: Array<{ type: string; text?: string }> }>(
            CLAUDE_API_URL, { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' }, {
                model: this.model,
                max_tokens: 4096,
                messages: [{ role: 'user', content: prompt }],
            }, prompt);
        const text = Array.isArray(data.content) ? data.content.find(c => c && c.type === 'text')?.text : undefined;
        if (typeof text !== 'string') throw new Error('AI provider returned an invalid response');
        return text;
    }

    async generateText(prompt: string): Promise<string> {
        return this.callAPI(prompt);
    }

    async extractJobDetails(text: string): Promise<JobDetails> {
        const prompt = PROMPTS.extractJobDetails(text);
        const response = await this.callAPI(prompt);

        try {
            return parseAIJson<JobDetails>(response);
        } catch {
            return {
                title: '',
                company: '',
                location: '',
                description: text.slice(0, 500),
            };
        }
    }

    async analyzeResume(jobDescription: string, resumeText: string): Promise<ResumeAnalysis> {
        const prompt = PROMPTS.analyzeResume(jobDescription, resumeText);
        const response = await this.callAPI(prompt);

        try {
            return parseAIJson<ResumeAnalysis>(response);
        } catch {
            return {
                matchScore: 50,
                strengths: [],
                gaps: [],
                recommendations: ['Unable to complete AI analysis'],
                keywords: { matched: [], missing: [] }
            };
        }
    }

    async draftEmail(context: EmailDraftContext): Promise<EmailDraft> {
        const prompt = PROMPTS.draftEmail(context);
        const response = await this.callAPI(prompt);

        try {
            return parseAIJson<EmailDraft>(response);
        } catch {
            return {
                subject: `Reaching out about ${context.jobTitle}`,
                body: 'Unable to generate email draft.',
                confidence: 0
            };
        }
    }

    async researchCompany(companyName: string, pageContent?: string): Promise<CompanyResearch> {
        const prompt = PROMPTS.researchCompany(companyName, pageContent);
        const response = await this.callAPI(prompt);

        try {
            return parseAIJson<CompanyResearch>(response);
        } catch {
            return {
                name: companyName,
                mission: '',
                size: '',
                industry: '',
                techStack: [],
                culture: [],
                recentNews: [],
                funding: '',
                competitors: [],
                whyJoin: []
            };
        }
    }

    async parseJobDescription(text: string): Promise<ParsedJobDescription> {
        const prompt = PROMPTS.parseJobDescription(text);
        const response = await this.callAPI(prompt);

        try {
            return parseAIJson<ParsedJobDescription>(response);
        } catch {
            return {
                requiredSkills: [],
                niceToHaveSkills: [],
                experienceLevel: 'Mid-level',
                responsibilities: [],
                techStack: [],
                redFlags: [],
                companyCulture: [],
                compensationHints: ''
            };
        }
    }

    async parseProfile(rawText: string): Promise<ParsedProfile> {
        const prompt = PROMPTS.parseProfile(rawText);
        const response = await this.callAPI(prompt);
        try {
            return parseAIJson<ParsedProfile>(response);
        } catch {
            return { name: '', headline: '', summary: '', skills: [], location: '' };
        }
    }
}
