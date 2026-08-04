import { describe, it, expect } from 'vitest';
import { NoOpHandler } from './NoOpHandler';
import type { BaseMessage } from '@sandforge/shared';
import { createMockBroker } from '../../test/mockFactories.js';

function createMockDeps() {
  let idCounter = 0;
  return {
    broker: createMockBroker(),
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

    for (const type of [
      'realtime:start',
      'realtime:stop',
      'realtime:status',
      'realtime:metrics',
      'realtime:resolve-conflict',
    ]) {
      const msg: BaseMessage = { id: `req-${type}`, type, timestamp: Date.now() };
      expect(await handler.handle(msg)).toBe(true);
    }
  });

  it('maps realtime:resolve-conflict to the webview contract type realtime:conflict-resolved', async () => {
    const deps = createMockDeps();
    const handler = new NoOpHandler(deps);
    const msg: BaseMessage = { id: 'req-rt-1', type: 'realtime:resolve-conflict', timestamp: 4000 };

    expect(await handler.handle(msg)).toBe(true);

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { success: boolean; comingSoon: boolean };
    };
    expect(posted.type).toBe('realtime:conflict-resolved');
    expect(posted.correlationId).toBe('req-rt-1');
    expect(posted.payload.success).toBe(false);
    expect(posted.payload.comingSoon).toBe(true);
  });

  it('maps realtime:start to realtime:started (webview contract)', async () => {
    const deps = createMockDeps();
    const handler = new NoOpHandler(deps);
    const msg: BaseMessage = { id: 'req-rt-2', type: 'realtime:start', timestamp: 5000 };

    await handler.handle(msg);

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage;
    expect(posted.type).toBe('realtime:started');
  });

  it('maps realtime:stop to realtime:stopped (webview contract)', async () => {
    const deps = createMockDeps();
    const handler = new NoOpHandler(deps);
    const msg: BaseMessage = { id: 'req-rt-3', type: 'realtime:stop', timestamp: 6000 };

    await handler.handle(msg);

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage;
    expect(posted.type).toBe('realtime:stopped');
  });

  it('realtime:status responds with realtime:status:response and a truthful disconnected status', async () => {
    const deps = createMockDeps();
    const handler = new NoOpHandler(deps);
    const msg: BaseMessage = { id: 'req-rt-4', type: 'realtime:status', timestamp: 7000 };

    await handler.handle(msg);

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { status: string; success: boolean };
    };
    expect(posted.type).toBe('realtime:status:response');
    expect(posted.payload.status).toBe('disconnected');
    expect(posted.payload.success).toBe(false);
  });

  it('realtime:metrics keeps the :response suffix (matches useCDCMetricsStore)', async () => {
    const deps = createMockDeps();
    const handler = new NoOpHandler(deps);
    const msg: BaseMessage = { id: 'req-rt-5', type: 'realtime:metrics', timestamp: 8000 };

    await handler.handle(msg);

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage;
    expect(posted.type).toBe('realtime:metrics:response');
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
