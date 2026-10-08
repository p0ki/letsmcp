import express, { type ErrorRequestHandler } from 'express';
import cors from 'cors';
import { createAPIRoutes } from './api/routes.js';
import { createAuth, type AuthOptions } from './security/auth.js';
import { requestLimits, type LimitOptions } from './security/limits.js';

export interface AppOptions extends AuthOptions { allowedHosts?: string[]; limits?: LimitOptions }
export function createApp(options: AppOptions = {}) {
    const app = express();
    const auth = createAuth(options);
    const port = process.env.PORT ?? '3002';
    const hosts = options.allowedHosts ?? [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, new URL(auth.origin).host];
    app.disable('x-powered-by');
    app.set('trust proxy', false);
    app.use((req, res, next) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
        if (!hosts.includes(req.get('Host') ?? '')) {
            res.status(403).json({ error: 'Request host is not allowed' });
            return;
        }
        next();
    });
    app.use(requestLimits(options.limits));
    app.use(auth.protectOrigin);
    app.use(cors({ origin: auth.origin, credentials: true,
        methods: ['GET', 'POST', 'DELETE', 'OPTIONS'], allowedHeaders: ['Content-Type'] }));
    app.use(express.json({ limit: '512kb', strict: true }));
    app.get('/health', (_req, res) => res.json({ status: 'ok', server: 'letsmcp', version: '2.0.0' }));
    app.use('/api', createAPIRoutes(auth));
    const errors: ErrorRequestHandler = (error, _req, res, _next) => {
        const status = error?.type === 'entity.too.large' ? 413 : error instanceof SyntaxError ? 400 : 500;
        res.status(status).json({ error: status === 500 ? 'Request failed' : 'Invalid request body' });
    };
    app.use(errors);
    return app;
}
