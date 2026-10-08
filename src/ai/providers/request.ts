/** Fixed provider transport. Never include upstream bodies, request data or keys in errors. */
export const AI_REQUEST_TIMEOUT_MS = 20_000;
export const MAX_AI_RESPONSE_BYTES = 1_048_576;
export const MAX_AI_PROMPT_BYTES = 131_072;

export function validateModel(model: string): string {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model)) {
        throw new Error('Invalid AI model identifier');
    }
    return model;
}

export function validateKey(key: string): string {
    if (key.length > 4096 || /[\r\n\x00]/.test(key)) {
        throw new Error('Invalid AI provider configuration');
    }
    return key;
}

export async function requestAIJson<T>(url: string, headers: Record<string, string>, body: unknown, prompt: string): Promise<T> {
    if (Buffer.byteLength(prompt, 'utf8') > MAX_AI_PROMPT_BYTES) {
        throw new Error('AI input exceeds size limit');
    }
    let endpoint: URL;
    try { endpoint = new URL(url); } catch { throw new Error('Invalid AI provider endpoint'); }
    const allowed = endpoint.protocol === 'https:' && !endpoint.username && !endpoint.password && !endpoint.port && !endpoint.search && (
        endpoint.href === 'https://api.groq.com/openai/v1/chat/completions' ||
        endpoint.href === 'https://api.anthropic.com/v1/messages' ||
        (endpoint.hostname === 'generativelanguage.googleapis.com' && /^\/v1beta\/models\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}:generateContent$/.test(endpoint.pathname))
    );
    if (!allowed) throw new Error('Invalid AI provider endpoint');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AI_REQUEST_TIMEOUT_MS);
    timer.unref();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        const response = await fetch(endpoint.href, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            redirect: 'error',
            signal: controller.signal,
        });
        if (!response.ok || response.redirected || !response.body) {
            if (response.body) await response.body.cancel();
            throw new Error('AI provider request failed');
        }
        const declaredSize = response.headers.get('content-length');
        if (declaredSize && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > MAX_AI_RESPONSE_BYTES)) {
            await response.body.cancel();
            throw new Error('AI provider request failed');
        }
        reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let bytes = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_AI_RESPONSE_BYTES) throw new Error('AI provider request failed');
            chunks.push(value);
        }
        const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('AI provider request failed');
        }
        return parsed as T;
    } catch {
        controller.abort();
        // Fetch errors can contain credentials, prompts and URLs; never propagate them.
        throw new Error('AI provider request failed');
    } finally {
        clearTimeout(timer);
        if (reader) {
            try { await reader.cancel(); } catch { /* No request details are logged. */ }
            reader.releaseLock();
        }
    }
}
