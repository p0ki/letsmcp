# Phase 0: AI provider boundary

AI requests are disabled by default. No real CV, LinkedIn profile, credentials, or personal data was used in the tests. All provider responses are mocked; no external inference calls were made.

## Findings and changes

- Original provider fallback silently resent the same input to Groq, Claude, and Gemini after failures. Each operation now uses exactly the selected provider, and failure stops the operation.
- Gemini originally placed its API key in the query string, where proxies and request logs could capture it. The key now uses `x-goog-api-key`.
- Provider errors originally included complete upstream error bodies; Groq also logged raw generated email content and parsing errors. The transport and service emit generic errors and never log prompts, responses, or keys.
- Original provider requests had neither timeouts nor input/response caps and followed redirects. Fixed HTTPS endpoints now reject redirects, enforce a 20-second deadline through response consumption, cap prompts at 128 KiB and responses at 1 MiB, and reject invalid model identifiers and header injection.
- HTTP runtime provider credential configuration was removed. The singleton reads only backend environment configuration once at startup. `POKI_ENABLE_AI=true`, a supported `DEFAULT_AI_PROVIDER` (`groq`, `claude`, or `gemini`), and that provider's backend environment key must all be deliberately configured. Other providers are not initialized even if their keys are present. No keys are required for Phase 0 validation.

## Later integration boundary

This is an opt-in adapter for existing provider code, not Sign in with ChatGPT support. ChatGPT plan entitlement, OAuth scopes, authentication endpoints, eligible models and billing remain separate work requiring current official documentation. No OAuth or inference capability is inferred from the prior conversation. Backend identity/session enforcement is separate from provider selection; provider keys must never be accepted as proof of user identity.

All AI output is untrusted. Parsing JSON establishes syntax only, not factual accuracy or complete output schema validation. Existing structured operation fallback placeholders remain; callers must not interpret a placeholder match score as completed analysis. There are no AI command-execution tools. A configured provider receives the supplied operation input after explicit opt-in, so private-data workflows remain out of Phase 0 scope.

Tests in `src/ai/service.test.ts` cover one-provider-only behavior, explicit selection, environment opt-in, no runtime key mutation, no raw logging, sanitized errors, fixed HTTPS endpoints, Gemini header credentials, model/header injection, size limits, and request/body deadlines. Their data is synthetic and `fetch` is mocked.
