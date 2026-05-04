import { describe, it, expect, vi } from 'vitest';
import { NoOpHandler } from './NoOpHandler';
import type { BaseMessage } from '@sandforge/shared';

function createMockDeps() {
  let idCounter = 0;
  return {
    broker: { postToWebview: vi.fn() },
    nextId: () => `noop-${++idCounter}`,
  };
}

describe('NoOpHandler', () => {
  it('returns false for unhandled types', async () => {
    const deps = createMockDeps();
    const handler = new NoOpHandler(deps);
    const msg: BaseMessage = { id: 'req-1', type: 'org:list', timestamp: Date.now() };

    expect(await handler.handle(msg)).toBe(false);
    expect(deps.broker.postToWebview).not.toHaveBeenCalled();
  });

  it('returns true for scheduler:list', async () => {
    const deps = createMockDeps();
    const handler = new NoOpHandler(deps);
    const msg: BaseMessage = { id: 'req-2', type: 'scheduler:list', timestamp: Date.now() };

    expect(await handler.handle(msg)).toBe(true);
  });

  it('returns true for all scheduler types', async () => {
    const deps = createMockDeps();
    const handler = new NoOpHandler(deps);

    for (const type of [
      'scheduler:list',
      'scheduler:upsert',
      'scheduler:delete',
      'scheduler:toggle',
    ]) {
      const msg: BaseMessage = { id: `req-${type}`, type, timestamp: Date.now() };
      expect(await handler.handle(msg)).toBe(true);
    }
  });

  it('returns true for all realtime types', async () => {
    const deps = createMockDeps();
    const handler = new NoOpHandler(deps);

    for (const type of ['realtime:start', 'realtime:stop', 'realtime:status', 'realtime:metrics']) {
      const msg: BaseMessage = { id: `req-${type}`, type, timestamp: Date.now() };
      expect(await handler.handle(msg)).toBe(true);
    }
  });

  it('response includes correlationId matching the request id', async () => {
    const deps = createMockDeps();
    const handler = new NoOpHandler(deps);
    const msg: BaseMessage = { id: 'req-42', type: 'scheduler:list', timestamp: 1000 };

    await handler.handle(msg);

    expect(deps.broker.postToWebview).toHaveBeenCalledTimes(1);
    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: Record<string, unknown>;
    };
    expect(posted.correlationId).toBe('req-42');
    expect(posted.id).toBeDefined();
    expect(posted.id).not.toBe('req-42');
  });

  it('response payload has success: false and comingSoon: true', async () => {
    const deps = createMockDeps();
    const handler = new NoOpHandler(deps);
    const msg: BaseMessage = { id: 'req-99', type: 'realtime:start', timestamp: 2000 };

    await handler.handle(msg);

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { success: boolean; comingSoon: boolean; error: string };
    };
    expect(posted.payload.success).toBe(false);
    expect(posted.payload.comingSoon).toBe(true);
    expect(posted.payload.error).toBe('Feature not yet available');
  });

  it('response type follows the pattern type:response', async () => {
    const deps = createMockDeps();
    const handler = new NoOpHandler(deps);
    const msg: BaseMessage = { id: 'req-50', type: 'scheduler:upsert', timestamp: 3000 };

    await handler.handle(msg);

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage;
    expect(posted.type).toBe('scheduler:upsert:response');
  });
});
