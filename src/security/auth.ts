import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Router, type RequestHandler } from 'express';

const COOKIE = 'poki_session';
const SESSION_MS = 8 * 60 * 60 * 1000;
const hash = (value: string) => createHash('sha256').update(value).digest();
export interface AuthOptions {
    password?: string;
    appOrigin?: string;
    now?: () => number;
}

/** Local single-owner bootstrap. Only verified identities may issue sessions later. */
export function createAuth(options: AuthOptions = {}) {
    const password = options.password ?? process.env.POKI_BOOTSTRAP_PASSWORD ?? '';
    const origin = options.appOrigin ?? process.env.APP_ORIGIN ?? 'http://127.0.0.1:8080';
    const parsed = new URL(origin);
    const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname);
    if (parsed.origin !== origin || parsed.username || parsed.password ||
        !['http:', 'https:'].includes(parsed.protocol) || (!loopback && parsed.protocol !== 'https:')) {
        throw new Error('APP_ORIGIN must be an exact HTTPS origin or a loopback HTTP origin');
    }
    const now = options.now ?? Date.now;
    const sessions = new Map<string, number>();
    const attempts = new Map<string, { count: number; expires: number }>();
    const cookieOptions = { httpOnly: true, sameSite: 'strict' as const,
        secure: parsed.protocol === 'https:', path: '/api', maxAge: SESSION_MS };
    const tokenFrom = (cookie: string | undefined) => {
        const values = (cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
        if (values.length !== 1) return '';
        const value = values[0].slice(COOKIE.length + 1);
        return /^[a-f0-9]{64}$/.test(value) ? value : '';
    };
    const revoke = (cookie: string | undefined) => {
        const token = tokenFrom(cookie);
        if (token) sessions.delete(hash(token).toString('hex'));
    };
    const authenticated = (cookie: string | undefined) => {
        const token = tokenFrom(cookie);
        const expires = token ? sessions.get(hash(token).toString('hex')) : undefined;
        return expires !== undefined && expires > now();
    };
    const prune = () => {
        for (const [key, expires] of sessions) if (expires <= now()) sessions.delete(key);
        for (const [key, attempt] of attempts) if (attempt.expires <= now()) attempts.delete(key);
    };
    // CORS is not authorization: reject cross-origin requests before route handlers.
    const protectOrigin: RequestHandler = (req, res, next) => {
        res.setHeader('Cache-Control', 'no-store');
        const requestOrigin = req.get('Origin');
        if ((requestOrigin && requestOrigin !== origin) ||
            (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && requestOrigin !== origin)) {
            res.status(403).json({ error: 'Request origin is not allowed' });
            return;
        }
        if (req.get('Sec-Fetch-Site') === 'cross-site') {
            res.status(403).json({ error: 'Cross-site requests are not allowed' });
            return;
        }
        next();
    };
    const requireSession: RequestHandler = (req, res, next) => {
        prune();
        if (!authenticated(req.get('Cookie'))) {
            res.status(401).json({ error: 'Authentication required' });
            return;
        }
        next();
    };
    const router = Router();
    router.use(protectOrigin);
    router.post('/login', (req, res) => {
        prune();
        if (password.length < 32 || password.length > 1024) {
            res.status(503).json({ error: 'Local sign-in is not configured' });
            return;
        }
        const key = req.ip ?? 'local';
        const attempt = attempts.get(key) ?? { count: 0, expires: now() + 15 * 60 * 1000 };
        if (attempt.count >= 5 || attempts.size >= 1024 && !attempts.has(key)) {
            res.setHeader('Retry-After', '900');
            res.status(429).json({ error: 'Too many sign-in attempts' });
            return;
        }
        attempt.count++;
        attempts.set(key, attempt);
        const candidate = req.body?.password;
        if (typeof candidate !== 'string' || candidate.length > 1024 || !timingSafeEqual(hash(candidate), hash(password))) {
            res.status(401).json({ error: 'Sign-in failed' });
            return;
        }
        // Keep successful attempts counted too: no unbounded session minting.
        revoke(req.get('Cookie'));
        if (sessions.size >= 128) {
            res.status(429).json({ error: 'Session capacity reached' });
            return;
        }
        const token = randomBytes(32).toString('hex');
        sessions.set(hash(token).toString('hex'), now() + SESSION_MS);
        res.cookie(COOKIE, token, cookieOptions);
        res.json({ authenticated: true, user: { id: 'local-owner', name: 'Local owner' } });
    });
    router.get('/session', requireSession, (_req, res) => {
        res.json({ authenticated: true, user: { id: 'local-owner', name: 'Local owner' } });
    });
    router.post('/logout', requireSession, (req, res) => {
        revoke(req.get('Cookie'));
        res.clearCookie(COOKIE, { ...cookieOptions, maxAge: undefined });
        res.json({ success: true });
    });
    return { router, requireSession, protectOrigin, origin };
}
