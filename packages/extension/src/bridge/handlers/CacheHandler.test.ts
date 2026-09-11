import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CacheHandler } from './CacheHandler';
import { CacheManager } from '../../core/cache/CacheManager';
import { createMockBroker, inboundRequest } from '../../test/mockFactories.js';
import type { InboundRequest } from './HandlerTypes.js';

function createDeps() {
  return {
    nextId: vi.fn(() => 'test-id'),
    broker: createMockBroker(),
    log: vi.fn(),
  };
}

function buildMsg(type: string): InboundRequest {
  return inboundRequest({ id: 'req-1', type, timestamp: Date.now() });
}

describe('CacheHandler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    CacheManager.resetInstance();
  });

  afterEach(() => {
    CacheManager.resetInstance();
    vi.useRealTimers();
  });

  it('should return false for unknown message types', async () => {
    const deps = createDeps();
    const handler = new CacheHandler(deps);

    const handled = await handler.handle(buildMsg('unknown:type'));
    expect(handled).toBe(false);
  });

  it('should handle cache:invalidate-all and call invalidateAll()', async () => {
    const deps = createDeps();
    const handler = new CacheHandler(deps);

    const manager = CacheManager.getInstance();
    const mockCache = { clear: vi.fn(), size: 0 };
    manager.register('test', mockCache);

    const handled = await handler.handle(buildMsg('cache:invalidate-all'));

    expect(handled).toBe(true);
    expect(mockCache.clear).toHaveBeenCalledOnce();
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'cache:invalidate-all:response',
        payload: { success: true },
      }),
    );
  });

  it('should handle cache:get-stats and return stats', async () => {
    const deps = createDeps();
    const handler = new CacheHandler(deps);

    const manager = CacheManager.getInstance();
    manager.register('schema', { clear: vi.fn(), size: 10 });
    manager.register('limits', { clear: vi.fn(), size: 3 });

    const handled = await handler.handle(buildMsg('cache:get-stats'));

    expect(handled).toBe(true);
    expect(deps.broker.postToWebview).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'cache:stats-response',
        payload: {
          stats: [
            { name: 'schema', size: 10 },
            { name: 'limits', size: 3 },
          ],
        },
      }),
    );
  });

  it('should log when invalidating all caches', async () => {
    const deps = createDeps();
    const handler = new CacheHandler(deps);

    await handler.handle(buildMsg('cache:invalidate-all'));

    expect(deps.log).toHaveBeenCalledWith('[CacheHandler] Invalidated all caches');
  });
});
