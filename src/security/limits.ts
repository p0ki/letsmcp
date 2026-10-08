import type { RequestHandler } from 'express';
export interface LimitOptions { maxRequests?: number; windowMs?: number; maxConcurrent?: number; now?: () => number }
/** Finite per-source request budget and total in-flight work for the local API. */
export function requestLimits(options: LimitOptions = {}): RequestHandler {
    const maxRequests = options.maxRequests ?? 120;
    const windowMs = options.windowMs ?? 60_000;
    const maxConcurrent = options.maxConcurrent ?? 8;
    const now = options.now ?? Date.now;
    const buckets = new Map<string, { count: number; until: number }>();
    let active = 0;
    return (req, res, next) => {
        for (const [key, bucket] of buckets) if (bucket.until <= now()) buckets.delete(key);
        const key = req.ip ?? 'local';
        let bucket = buckets.get(key);
        if (!bucket) {
            if (buckets.size >= 1024) { res.status(429).json({ error: 'Request capacity reached' }); return; }
            bucket = { count: 0, until: now() + windowMs }; buckets.set(key, bucket);
        }
        if (++bucket.count > maxRequests || active >= maxConcurrent) {
            res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.until - now()) / 1000))));
            res.status(429).json({ error: 'Request limit reached' }); return;
        }
        active++;
        let released = false;
        const release = () => { if (!released) { released = true; active--; } };
        res.locals.pokiReleaseWork = release;
        const responseEnded = () => { if (!res.locals.pokiWorkPending) release(); };
        res.once('finish', responseEnded); res.once('close', responseEnded);
        next();
    };
}

/** Keep the semaphore until actual handler work settles, including disconnected clients. */
export async function trackRequestWork<T>(res: import('express').Response, operation: () => Promise<T>): Promise<T> {
    res.locals.pokiWorkPending = true;
    try { return await operation(); }
    finally { res.locals.pokiWorkPending = false; res.locals.pokiReleaseWork?.(); }
}
