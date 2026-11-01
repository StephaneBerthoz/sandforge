import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { RunCheckpointTaken } from '@sandforge/shared';
import { useStoppedRunCheckpoint } from './useStoppedRunCheckpoint';

const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-20261101-101540-a1b2',
  name: 'Before Sync run 2026-11-01 10:15 UTC',
  takenAt: '2026-11-01T10:15:40.000Z',
  expiresAt: '2026-11-08T10:15:40.000Z',
  objects: ['Account'],
  records: 38,
  bytes: 2_100_000,
  requests: 66,
  added: [],
  notHeld: [],
};

const stopped = (type: string, correlationId: string, payload: Record<string, unknown>) =>
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', { data: { id: 'e1', type, correlationId, payload } }),
    );
  });

describe('useStoppedRunCheckpoint', () => {
  it('says a checkpoint its request’s error says was deleted, or kept, until another request goes', () => {
    const { result, rerender } = renderHook(({ id }) => useStoppedRunCheckpoint('sync:error', id), {
      initialProps: { id: 'run-1' as string | null },
    });
    expect(result.current).toBeUndefined();

    stopped('sync:error', 'run-1', { checkpoint: { state: 'deleted', deleted: 'nothingWritten' } });
    expect(result.current).toEqual({ state: 'deleted', deleted: 'nothingWritten' });

    rerender({ id: 'run-2' });
    expect(result.current).toBeUndefined();

    stopped('sync:error', 'run-2', { checkpoint: TAKEN });
    expect(result.current).toEqual(TAKEN);
  });

  it('leaves another request’s error, another channel, and an error that names none', () => {
    const { result } = renderHook(() => useStoppedRunCheckpoint('seed:error', 'run-1'));

    stopped('seed:error', 'run-2', { checkpoint: TAKEN });
    stopped('sync:error', 'run-1', { checkpoint: TAKEN });
    stopped('seed:error', 'run-1', { code: 'SEED_WRITE_DECLINED' });
    stopped('seed:error', 'run-1', { checkpoint: { state: 'taken' } });
    expect(result.current).toBeUndefined();
  });

  it('names nothing before a request was sent', () => {
    const { result } = renderHook(() => useStoppedRunCheckpoint('seed:error', null));

    stopped('seed:error', 'run-1', { checkpoint: TAKEN });
    expect(result.current).toBeUndefined();
  });
});
