import { describe, it, expect, vi } from 'vitest';
import { sendHandlerError, sendNotification, buildResponse } from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';

/**
 * Creates a minimal mock of the handler deps required by sendHandlerError.
 */
function createMockDeps() {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() },
    nextId: () => String(++idCounter),
  };
}

describe('sendHandlerError', () => {
  it('logs the error with the context prefix', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'sync:describe-global', 'sync:error', new Error('connection timeout'));

    expect(deps.log).toHaveBeenCalledWith('[ERR] sync:describe-global: connection timeout');
  });

  it('posts an error message to the webview with the correct type and payload', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'seed:execute', 'seed:error', new Error('invalid template'));

    expect(deps.broker.postToWebview).toHaveBeenCalledTimes(1);
    const posted = deps.broker.postToWebview.mock.calls[0][0] as {
      type: string;
      id: string;
      payload: { message: string };
    };
    expect(posted.type).toBe('seed:error');
    expect(posted.payload.message).toBe('invalid template');
    expect(posted.id).toBeDefined();
  });

  it('logs the TX line after posting', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'compare:start', 'compare:error', new Error('oops'));

    expect(deps.log).toHaveBeenCalledWith('[TX] compare:error: oops');
  });

  it('handles non-Error values by converting to string', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'monitor:refresh', 'monitor:error', 'raw string error');

    expect(deps.log).toHaveBeenCalledWith('[ERR] monitor:refresh: raw string error');
    const posted = deps.broker.postToWebview.mock.calls[0][0] as {
      payload: { message: string };
    };
    expect(posted.payload.message).toBe('raw string error');
  });

  it('handles null/undefined error values', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'ctx', 'type:error', null);

    expect(deps.log).toHaveBeenCalledWith('[ERR] ctx: null');
  });

  it('generates a unique message id via nextId', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'a', 'a:error', 'x');
    sendHandlerError(deps, 'b', 'b:error', 'y');

    const id1 = (deps.broker.postToWebview.mock.calls[0][0] as { id: string }).id;
    const id2 = (deps.broker.postToWebview.mock.calls[1][0] as { id: string }).id;
    expect(id1).not.toBe(id2);
  });
});

describe('buildResponse', () => {
  it('copies request id as correlationId on the response', () => {
    const deps = createMockDeps();
    const request: BaseMessage = { id: 'req-42', type: 'seed:execute', timestamp: 1000 };
    const response = buildResponse(deps, request, 'seed:execute:response', { total: 10 });

    expect(response.correlationId).toBe('req-42');
    expect(response.type).toBe('seed:execute:response');
    expect(response.payload).toEqual({ total: 10 });
    expect(response.id).toBeDefined();
    expect(response.id).not.toBe('req-42');
  });

  it('generates a unique id for the response via nextId', () => {
    const deps = createMockDeps();
    const request: BaseMessage = { id: 'req-1', type: 'org:list', timestamp: 1000 };
    const r1 = buildResponse(deps, request, 'org:list:response', {});
    const r2 = buildResponse(deps, request, 'org:list:response', {});

    expect(r1.id).not.toBe(r2.id);
  });
});

describe('sendNotification', () => {
  it('posts a notification message to the webview', () => {
    const deps = { ...createMockDeps() };
    sendNotification(deps, 'error', 'Test', 'Something went wrong');

    expect(deps.broker.postToWebview).toHaveBeenCalledTimes(1);
    const posted = deps.broker.postToWebview.mock.calls[0][0] as {
      type: string;
      payload: { level: string; title: string; message: string };
    };
    expect(posted.type).toBe('notification');
    expect(posted.payload.level).toBe('error');
    expect(posted.payload.title).toBe('Test');
    expect(posted.payload.message).toBe('Something went wrong');
  });
});
