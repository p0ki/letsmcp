import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { requestLimits, trackRequestWork } from './limits.js';

describe('API concurrency limits', () => {
    it('rejects work over capacity and releases a completed request only once', () => {
        const middleware = requestLimits({ maxConcurrent: 1 });
        const response = () => Object.assign(new EventEmitter(), { locals: {}, status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() });
        const first = response(), second = response(), third = response();
        const next = vi.fn();
        middleware({ ip: 'synthetic' } as never, first as never, next);
        middleware({ ip: 'synthetic' } as never, second as never, next);
        expect(second.status).toHaveBeenCalledWith(429); expect(next).toHaveBeenCalledOnce();
        first.emit('finish'); first.emit('close');
        middleware({ ip: 'synthetic' } as never, third as never, next);
        expect(next).toHaveBeenCalledTimes(2); expect(third.status).not.toHaveBeenCalled();
    });
});

describe('disconnected clients', () => {
    it('keeps real work counted after socket close until that work settles', async () => {
        const middleware = requestLimits({ maxConcurrent: 1 });
        const response = () => Object.assign(new EventEmitter(), { locals: {}, status: vi.fn().mockReturnThis(), json: vi.fn(), setHeader: vi.fn() });
        const first = response(), second = response(), third = response();
        middleware({ ip: 'synthetic' } as never, first as never, vi.fn());
        let finish!: () => void;
        const unfinished = new Promise<void>(resolve => { finish = resolve; });
        const work = trackRequestWork(first as never, () => unfinished);
        first.emit('close');
        const next = vi.fn(); middleware({ ip: 'synthetic' } as never, second as never, next);
        expect(second.status).toHaveBeenCalledWith(429); expect(next).not.toHaveBeenCalled();
        finish(); await work;
        middleware({ ip: 'synthetic' } as never, third as never, next);
        expect(next).toHaveBeenCalledOnce(); expect(third.status).not.toHaveBeenCalled();
    });
});
