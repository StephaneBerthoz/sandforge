import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BaseMessage } from '@sandforge/shared';
import { AIDiagnoseAdapter } from './AIDiagnoseAdapter.js';
import type { AIDiagnoseHandler } from './AIDiagnoseHandler.js';
import type { HandlerDeps, InboundRequest } from '../HandlerTypes.js';
import { createMockBroker, inboundRequest } from '../../../test/mockFactories.js';

/** Minimal deps: the adapter only uses log, broker and nextId. */
function createDeps(): HandlerDeps {
  return {
    log: vi.fn(),
    broker: createMockBroker(),
    nextId: vi.fn(() => 'test-id'),
  } as unknown as HandlerDeps;
}

/** Mock diagnose handler exposing its handleMessage spy. */
function createDiagnoseHandler(): {
  handler: AIDiagnoseHandler;
  handleMessage: ReturnType<typeof vi.fn>;
} {
  const handleMessage = vi.fn().mockResolvedValue(undefined);
  return {
    handler: { handleMessage } as unknown as AIDiagnoseHandler,
    handleMessage,
  };
}

/** Builds a valid ai:diagnose request message. */
function diagnoseMsg(payload: unknown): InboundRequest {
  return inboundRequest({
    id: 'm1',
    type: 'ai:diagnose',
    timestamp: Date.now(),
    payload,
  } as BaseMessage);
}

/** Builds a valid ai:approve-action request message. */
function approveMsg(payload: unknown): InboundRequest {
  return inboundRequest({
    id: 'm2',
    type: 'ai:approve-action',
    timestamp: Date.now(),
    payload,
  } as BaseMessage);
}

const VALID_DIAGNOSE_PAYLOAD = {
  runId: 'r1',
  orgId: 'org-1',
  errorContext: {
    kind: 'bulk-job',
    jobId: 'job-42',
    errorMessage: 'REQUIRED_FIELD_MISSING',
  },
};

const VALID_APPROVE_PAYLOAD = {
  runId: 'r1',
  actionIndex: 2,
  modifiedPayload: 'script',
};

/** Extracts all messages posted to the webview. */
function postedMessages(deps: HandlerDeps): Array<BaseMessage & { payload?: unknown }> {
  const postToWebview = deps.broker.postToWebview as ReturnType<typeof vi.fn>;
  return postToWebview.mock.calls.map((call) => call[0] as BaseMessage & { payload?: unknown });
}

describe('AIDiagnoseAdapter', () => {
  let deps: HandlerDeps;
  let adapter: AIDiagnoseAdapter;

  beforeEach(() => {
    deps = createDeps();
    adapter = new AIDiagnoseAdapter(deps);
  });

  it('returns false for unhandled message types', async () => {
    const handled = await adapter.handle(
      inboundRequest({ id: 'x', type: 'ai:chat', timestamp: Date.now() }),
    );
    expect(handled).toBe(false);
  });

  describe('handler not wired (AI disabled)', () => {
    it('answers ai:diagnose with AI_NOT_CONFIGURED and echoes runId', async () => {
      const handled = await adapter.handle(diagnoseMsg(VALID_DIAGNOSE_PAYLOAD));
      expect(handled).toBe(true);

      const responses = postedMessages(deps);
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        type: 'ai:diagnose:response',
        correlationId: 'm1',
        payload: {
          runId: 'r1',
          error: { code: 'AI_NOT_CONFIGURED' },
        },
      });
    });

    it('answers ai:approve-action with a failed status and echoes runId/actionIndex', async () => {
      const handled = await adapter.handle(approveMsg(VALID_APPROVE_PAYLOAD));
      expect(handled).toBe(true);

      const responses = postedMessages(deps);
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        type: 'ai:approve-action:response',
        correlationId: 'm2',
        payload: { runId: 'r1', actionIndex: 2, status: 'failed' },
      });
    });

    it('falls back to neutral echo values when the payload is malformed', async () => {
      await adapter.handle(diagnoseMsg('not-an-object'));
      await adapter.handle(approveMsg({ runId: 42, actionIndex: 'nope' }));

      const responses = postedMessages(deps);
      expect(responses[0]).toMatchObject({
        type: 'ai:diagnose:response',
        payload: { runId: 'unknown', error: { code: 'AI_NOT_CONFIGURED' } },
      });
      expect(responses[1]).toMatchObject({
        type: 'ai:approve-action:response',
        payload: { runId: 'unknown', actionIndex: 0, status: 'failed' },
      });
    });
  });

  describe('handler wired', () => {
    it('forwards a validated ai:diagnose message to the handler', async () => {
      const { handler, handleMessage } = createDiagnoseHandler();
      adapter.setHandler(handler);

      const handled = await adapter.handle(diagnoseMsg(VALID_DIAGNOSE_PAYLOAD));
      expect(handled).toBe(true);

      expect(handleMessage).toHaveBeenCalledTimes(1);
      const forwarded = handleMessage.mock.calls[0][0] as {
        type: string;
        id: string;
        payload: unknown;
      };
      expect(forwarded.type).toBe('ai:diagnose');
      expect(forwarded.id).toBe('m1');
      expect(forwarded.payload).toEqual(VALID_DIAGNOSE_PAYLOAD);
      // The adapter itself sends nothing on the happy path.
      expect(postedMessages(deps)).toHaveLength(0);
    });

    it('forwards a validated ai:approve-action message to the handler', async () => {
      const { handler, handleMessage } = createDiagnoseHandler();
      adapter.setHandler(handler);

      await adapter.handle(approveMsg(VALID_APPROVE_PAYLOAD));

      expect(handleMessage).toHaveBeenCalledTimes(1);
      const forwarded = handleMessage.mock.calls[0][0] as {
        type: string;
        payload: unknown;
      };
      expect(forwarded.type).toBe('ai:approve-action');
      expect(forwarded.payload).toEqual(VALID_APPROVE_PAYLOAD);
    });

    it('rejects an invalid ai:diagnose payload on the diagnose channel without calling the handler', async () => {
      const { handler, handleMessage } = createDiagnoseHandler();
      adapter.setHandler(handler);

      // Missing errorContext — runId is still well-typed and must be echoed.
      const handled = await adapter.handle(diagnoseMsg({ runId: 'r9', orgId: 'org-1' }));
      expect(handled).toBe(true);
      expect(handleMessage).not.toHaveBeenCalled();

      const responses = postedMessages(deps);
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        type: 'ai:diagnose:response',
        correlationId: 'm1',
        payload: { runId: 'r9', error: { code: 'INVALID_PAYLOAD' } },
      });
    });

    it('rejects an invalid ai:approve-action payload on the approve channel without calling the handler', async () => {
      const { handler, handleMessage } = createDiagnoseHandler();
      adapter.setHandler(handler);

      const handled = await adapter.handle(approveMsg({ runId: 'r1', actionIndex: 'two' }));
      expect(handled).toBe(true);
      expect(handleMessage).not.toHaveBeenCalled();

      const responses = postedMessages(deps);
      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        type: 'ai:approve-action:response',
        correlationId: 'm2',
        payload: { runId: 'r1', actionIndex: 0, status: 'failed' },
      });
      const payload = responses[0].payload as { resultMessage: string };
      expect(payload.resultMessage).toContain('Invalid payload');
    });
  });
});
