import { describe, it, expect, vi } from 'vitest';
import {
  sendHandlerError,
  sendNotification,
  sendOperationFailed,
  buildResponse,
  syntheticRequest,
  uncorrelated,
  type InboundRequest,
  type SyntheticRequestKind,
  type UncorrelatedReason,
} from './HandlerTypes.js';
import type { BaseMessage } from '@sandforge/shared';
import { ErrorResolver } from '../../modules/ai/ErrorResolver.js';
import { createMockBroker, inboundRequest } from '../../test/mockFactories.js';

/**
 * Creates a minimal mock of the handler deps required by sendHandlerError.
 */
function createMockDeps() {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: createMockBroker(),
    nextId: () => String(++idCounter),
  };
}

/** Stand-in for the bridge request a handler is answering. */
const REQUEST: InboundRequest = inboundRequest({
  id: 'req-7',
  type: 'sync:execute',
  timestamp: 1000,
});

describe('sendHandlerError', () => {
  it('logs the error with the context prefix', () => {
    const deps = createMockDeps();
    sendHandlerError(
      deps,
      'sync:describe-global',
      'sync:error',
      REQUEST,
      new Error('connection timeout'),
    );

    expect(deps.log).toHaveBeenCalledWith('[ERR] sync:describe-global: connection timeout');
  });

  it('posts an error message to the webview with the correct type and payload', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'seed:execute', 'seed:error', REQUEST, new Error('invalid template'));

    expect(deps.broker.postToWebview).toHaveBeenCalledTimes(1);
    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string; code: string; retryable: boolean };
    };
    expect(posted.type).toBe('seed:error');
    expect(posted.payload.message).toBe('invalid template');
    expect(posted.id).toBeDefined();
  });

  it('sends default code=UNKNOWN and retryable=false when no code/retryable provided', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'sync:error', 'sync:error', REQUEST, new Error('fail'));

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string; code: string; retryable: boolean };
    };
    expect(posted.payload.code).toBe('UNKNOWN');
    expect(posted.payload.retryable).toBe(false);
  });

  it('sends provided code and retryable values in payload', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'forge:plan', 'forge:plan:error', REQUEST, new Error('timed out'), {
      code: 'TIMEOUT',
      retryable: true,
    });

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string; code: string; retryable: boolean };
    };
    expect(posted.payload.code).toBe('TIMEOUT');
    expect(posted.payload.retryable).toBe(true);
  });

  it('sends retryable=false default when only code is provided', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'forge:execute', 'forge:execute:error', REQUEST, new Error('broken'), {
      code: 'EXECUTE_ERROR',
    });

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string; code: string; retryable: boolean };
    };
    expect(posted.payload.code).toBe('EXECUTE_ERROR');
    expect(posted.payload.retryable).toBe(false);
  });

  it('logs the TX line after posting', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'compare:start', 'compare:error', REQUEST, new Error('oops'));

    expect(deps.log).toHaveBeenCalledWith('[TX] compare:error: oops');
  });

  it('handles non-Error values by converting to string', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'monitor:refresh', 'monitor:error', REQUEST, 'raw string error');

    expect(deps.log).toHaveBeenCalledWith('[ERR] monitor:refresh: raw string error');
    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { message: string };
    };
    expect(posted.payload.message).toBe('raw string error');
  });

  it('handles null/undefined error values', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'ctx', 'type:error', REQUEST, null);

    expect(deps.log).toHaveBeenCalledWith('[ERR] ctx: null');
  });

  it('generates a unique message id via nextId', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'a', 'a:error', REQUEST, 'x');
    sendHandlerError(deps, 'b', 'b:error', REQUEST, 'y');

    const id1 = (deps.broker.postToWebview.mock.calls[0][0] as { id: string }).id;
    const id2 = (deps.broker.postToWebview.mock.calls[1][0] as { id: string }).id;
    expect(id1).not.toBe(id2);
  });

  it('stamps the origin request id as correlationId', () => {
    const deps = createMockDeps();
    sendHandlerError(deps, 'sync:execute', 'sync:error', REQUEST, new Error('boom'));

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage;
    expect(posted.correlationId).toBe('req-7');
  });

  it('omits correlationId and names the reason for an uncorrelated origin', () => {
    const deps = createMockDeps();
    sendHandlerError(
      deps,
      'sync:schedule:tick',
      'sync:error',
      // `UncorrelatedReason` is `never` today: only a test can name a reason, by cast.
      uncorrelated('schedule tick, no request' as never),
      new Error('boom'),
    );

    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage;
    expect(posted.correlationId).toBeUndefined();
    // The admission is not only in the source: it reaches the output channel,
    // so an uncorrelated error is visible while debugging, not just at review.
    expect(deps.log).toHaveBeenCalledWith(
      '[ERR] sync:schedule:tick: boom (uncorrelated: schedule tick, no request)',
    );
  });

  it('requires an origin at the type level', () => {
    // The guard is tsc, not the runtime assertion: `pnpm typecheck` covers this
    // file (tsconfig.test.json includes src/**/*). If `origin` becomes optional
    // or accepts `undefined`, the annotation below stops matching `false` and
    // typecheck fails with TS2322 — checked by mutating the signature both ways.
    //
    // Deliberately NOT a `@ts-expect-error` on a call that omits `origin`:
    // dropping an argument shifts `err` into the origin slot, an Error is not an
    // ErrorOrigin, and the directive stays satisfied even with `origin?` — a
    // guard that cannot fail.
    const acceptsUndefined: undefined extends Parameters<typeof sendHandlerError>[3]
      ? true
      : false = false;

    expect(acceptsUndefined).toBe(false);
  });
});

describe('correlation origins', () => {
  it('rejects every origin that did not come from a request, at the type level', () => {
    // The guard is tsc: `pnpm typecheck` covers this file. Each annotation
    // stops matching the moment its shape becomes an accepted origin again.
    // These are the reviewed bypasses, not hypotheticals.
    type Origin = Parameters<typeof sendHandlerError>[3];
    // P1, P2, P8: any message-shaped value — an id of '' (read as "no
    // correlation" by the webview), a fabricated UUID, `{} as BaseMessage`.
    const plainMessage: BaseMessage extends Origin ? true : false = false;
    // A real request whose id was rewritten through a spread: `{ ...msg, id: '' }`.
    const rewrittenId: {
      id: string;
      type: string;
      timestamp: number;
    } extends Origin
      ? true
      : false = false;
    // P6: a hand-built admission that skips the helper.
    const handBuiltOrphan: { uncorrelated: true; reason: string } extends Origin ? true : false =
      false;
    // P3, P4, P5: a free-form reason, whatever its quoting, variable or import alias.
    const freeFormReason: string extends Parameters<typeof uncorrelated>[0] ? true : false = false;
    // Positive controls: without them, `Origin = never` would satisfy every line above.
    const routed: InboundRequest extends Origin ? true : false = true;
    const synthetic: ReturnType<typeof syntheticRequest> extends Origin ? true : false = true;
    const admitted: ReturnType<typeof uncorrelated> extends Origin ? true : false = true;

    expect([plainMessage, rewrittenId, handBuiltOrphan, freeFormReason]).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect([routed, synthetic, admitted]).toEqual([true, true, true]);
  });

  it('keeps both escape hatches closed lists', () => {
    // Adding a reason or a synthetic kind is a reviewed edit of HandlerTypes.ts
    // and of this pin; widening either one (to `string`, say) fails typecheck.
    type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
    const reasons: Exactly<UncorrelatedReason, never> = true;
    const kinds: Exactly<SyntheticRequestKind, 'sync:schedule' | 'offline-replay'> = true;

    expect([reasons, kinds]).toEqual([true, true]);
  });

  it('prefixes a synthetic request id with its kind, so it is never empty nor a webview id', () => {
    const scheduled = syntheticRequest('sync:schedule', 'uuid-1', 'sync:execute');
    expect(scheduled).toMatchObject({
      id: 'sync:schedule:uuid-1',
      type: 'sync:execute',
    });
    expect(typeof scheduled.timestamp).toBe('number');
    expect(syntheticRequest('offline-replay', '', 'seed:execute').id).toBe('offline-replay-');
  });
});

describe('buildResponse', () => {
  it('copies request id as correlationId on the response', () => {
    const deps = createMockDeps();
    const request: InboundRequest = inboundRequest({
      id: 'req-42',
      type: 'seed:execute',
      timestamp: 1000,
    });
    const response = buildResponse(deps, request, 'seed:execute:response', {
      total: 10,
    });

    expect(response.correlationId).toBe('req-42');
    expect(response.type).toBe('seed:execute:response');
    expect(response.payload).toEqual({ total: 10 });
    expect(response.id).toBeDefined();
    expect(response.id).not.toBe('req-42');
  });

  it('generates a unique id for the response via nextId', () => {
    const deps = createMockDeps();
    const request: InboundRequest = inboundRequest({
      id: 'req-1',
      type: 'org:list',
      timestamp: 1000,
    });
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
    const posted = deps.broker.postToWebview.mock.calls[0][0] as BaseMessage & {
      payload: { level: string; title: string; message: string };
    };
    expect(posted.type).toBe('notification');
    expect(posted.payload.level).toBe('error');
    expect(posted.payload.title).toBe('Test');
    expect(posted.payload.message).toBe('Something went wrong');
  });
});

/**
 * Curated resolution of a failed operation.
 *
 * `sendOperationFailed` is the only emitter of `operation:failed`, and the
 * broker fans that message out to every open panel. Resolving the failure on
 * the receiving side multiplies the work by the number of panels, and a panel
 * has no error code to look up with — it only sees the rendered message. Both
 * properties are checked here: the resolution happens once, and it reaches the
 * built-in knowledge base whenever the code is in the text.
 */
describe('sendOperationFailed — curated error resolution', () => {
  /** Deps carrying a real ErrorResolver whose model provider is a spy. */
  function createResolvingDeps() {
    const provider = vi.fn(() =>
      Promise.resolve(
        JSON.stringify({
          explanation: 'model answer',
          suggestions: [{ title: 'ask', description: 'model fix', probability: 0.5 }],
          confidence: 0.4,
        }),
      ),
    );
    return { ...createMockDeps(), errorResolver: new ErrorResolver(provider), provider };
  }

  /** The `ai:resolve-error:response` messages posted to the webview. */
  function resolutions(deps: ReturnType<typeof createResolvingDeps>) {
    return deps.broker.postToWebview.mock.calls
      .map((c) => c[0] as BaseMessage & { payload: { resolution?: { explanation: string } } })
      .filter((m) => m.type === 'ai:resolve-error:response');
  }

  it('answers a known error code from the knowledge base, without calling the model', async () => {
    const deps = createResolvingDeps();

    sendOperationFailed(
      deps,
      'op-1',
      'UNABLE_TO_LOCK_ROW: unable to obtain exclusive access to this record',
      true,
    );
    await vi.waitFor(() => expect(resolutions(deps)).toHaveLength(1));

    expect(deps.provider).not.toHaveBeenCalled();
    expect(resolutions(deps)[0].payload.resolution?.explanation).toContain(
      'Another transaction is currently locking the record(s)',
    );
  });

  it('resolves a failure once, whatever the number of open panels', async () => {
    const deps = createResolvingDeps();

    sendOperationFailed(deps, 'op-2', 'SOMETHING_WE_HAVE_NEVER_SEEN: odd', false);
    await vi.waitFor(() => expect(resolutions(deps)).toHaveLength(1));

    // One call for the whole failure. Fanning the answer out to N panels is
    // the broker's job and costs nothing extra.
    expect(deps.provider).toHaveBeenCalledTimes(1);
  });

  it('still asks the model when the message carries no known code', async () => {
    const deps = createResolvingDeps();

    sendOperationFailed(deps, 'op-3', 'Network request failed after 3 attempts', true);
    await vi.waitFor(() => expect(resolutions(deps)).toHaveLength(1));

    expect(deps.provider).toHaveBeenCalledTimes(1);
    expect(resolutions(deps)[0].payload.resolution?.explanation).toBe('model answer');
  });

  it('stays silent when the AI stack is not wired', async () => {
    const deps = createMockDeps();

    sendOperationFailed(deps, 'op-4', 'UNABLE_TO_LOCK_ROW: locked', true);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const posted = deps.broker.postToWebview.mock.calls.map((c) => (c[0] as BaseMessage).type);
    expect(posted).toEqual(['operation:failed']);
  });
});
