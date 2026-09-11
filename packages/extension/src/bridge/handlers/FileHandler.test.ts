import { describe, it, expect, vi, beforeEach } from 'vitest';

import { FileHandler } from './FileHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { SaveDialogAdapter } from '../../adapters/fs/SaveDialogAdapter.js';
import type { BaseMessage } from '@sandforge/shared';
import { inboundRequest } from '../../test/mockFactories.js';

/** The three deps FileHandler actually uses, with an observable broker. */
function createMockDeps(): Pick<HandlerDeps, 'nextId' | 'broker' | 'log'> {
  let idCounter = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    nextId: () => String(++idCounter),
  };
}

describe('FileHandler', () => {
  let deps: Pick<HandlerDeps, 'nextId' | 'broker' | 'log'>;
  let save: ReturnType<typeof vi.fn>;
  let handler: FileHandler;

  /** Everything posted to the webview, in order. */
  function posted(): Array<
    BaseMessage & { correlationId?: string; payload: Record<string, unknown> }
  > {
    return (deps.broker.postToWebview as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0]);
  }

  beforeEach(() => {
    deps = createMockDeps();
    save = vi.fn().mockResolvedValue({ status: 'saved', path: '/home/u/export.csv' });
    handler = new FileHandler(deps, { save } as unknown as SaveDialogAdapter);
  });

  it('returns false for a message it does not own', async () => {
    expect(
      await handler.handle(inboundRequest({ id: '1', type: 'other:thing', timestamp: Date.now() })),
    ).toBe(false);
  });

  it('answers a saved file with its path', async () => {
    await handler.handle(
      inboundRequest({
        id: 'req-ok',
        type: 'file:save',
        timestamp: Date.now(),
        payload: {
          suggestedName: 'export.csv',
          content: 'a,b',
          extensions: ['csv'],
        },
      } as BaseMessage),
    );

    expect(save).toHaveBeenCalledWith('export.csv', 'a,b', ['csv']);
    const [response] = posted();
    expect(response.type).toBe('file:save:response');
    expect(response.correlationId).toBe('req-ok');
    expect(response.payload).toEqual({
      status: 'saved',
      path: '/home/u/export.csv',
    });
  });

  /**
   * A refused payload used to leave on the SUCCESS channel: `validatePayload`
   * takes the ERROR channel as its 3rd argument and this handler passed
   * `file:save:response`, so the rejection arrived as
   * `{ message, code, retryable }` — no `status`, no `correlationId`. The
   * union `useFileSave` reads has no branch for that shape, so it fell through
   * to the success branch and toasted "Saved to undefined" for a file that was
   * never written. This is the only validation-failure path of this channel.
   */
  describe('a refused payload is an error, not a silent success', () => {
    /** A 33 MB export: over the 32 MB bound `content` declares. */
    const oversized = {
      suggestedName: 'dataops-backup.json',
      content: 'x'.repeat(33 * 1024 * 1024),
    };

    it('never opens the Save dialog', async () => {
      await handler.handle(
        inboundRequest({
          id: 'req-big',
          type: 'file:save',
          timestamp: Date.now(),
          payload: oversized,
        } as BaseMessage),
      );

      expect(save).not.toHaveBeenCalled();
    });

    it('answers with the error variant of the outcome, correlated to the request', async () => {
      await handler.handle(
        inboundRequest({
          id: 'req-big',
          type: 'file:save',
          timestamp: Date.now(),
          payload: oversized,
        } as BaseMessage),
      );

      expect(posted()).toHaveLength(1);
      const [response] = posted();
      expect(response.type).toBe('file:save:response');
      // Without this the webview cannot tell the rejection from a save.
      expect(response.payload.status).toBe('error');
      expect(response.payload.message).toEqual(expect.stringContaining('content'));
      // Uncorrelated, the answer settles whichever save happens to be in flight.
      expect(response.correlationId).toBe('req-big');
    });

    it('reports a missing content field the same way', async () => {
      await handler.handle(
        inboundRequest({
          id: 'req-empty',
          type: 'file:save',
          timestamp: Date.now(),
          payload: { suggestedName: 'export.csv' },
        } as BaseMessage),
      );

      expect(save).not.toHaveBeenCalled();
      expect(posted()[0].payload.status).toBe('error');
    });
  });
});
