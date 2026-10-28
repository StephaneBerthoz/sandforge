import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import type { BaseMessage, CheckpointRewindListed } from '@sandforge/shared';

const mockPostMessage = vi.fn();

const stableApi = {
  postMessage: (...args: unknown[]) => mockPostMessage(...args),
  getState: () => undefined,
  setState: () => undefined,
};

vi.mock('./useVSCodeApi', () => ({
  useVSCodeApi: () => stableApi,
}));

import { useRewoundMarks } from './useRewoundMarks';

/** A rewind of `org-dev` to a checkpoint taken at 10:00, from 12:00 to 12:10, the clocks as one. */
const REWIND: CheckpointRewindListed = {
  kind: 'rewind',
  rewindId: 'rw-20261028-120000-aaaa',
  checkpointId: 'ck-20261028-100000-aaaa',
  checkpointName: 'Before UAT',
  organizationId: '00D000000000001AAA',
  mode: 'picked',
  objects: ['Account'],
  readFrom: '2026-10-28T10:00:00.000Z',
  takenAt: '2026-10-28T10:05:00.000Z',
  startedAt: '2026-10-28T12:00:00.000Z',
  endedAt: '2026-10-28T12:10:00.000Z',
  status: 'success',
  totals: { deleted: 1, restored: 0, undeleted: 0, recreated: 0 },
  orgIds: ['org-dev'],
};

const BETWEEN = {
  orgId: 'org-dev',
  startedAt: '2026-10-28T11:00:00.000Z',
  endedAt: '2026-10-28T11:05:00.000Z',
  objects: ['Account'],
};

function sent(): Array<BaseMessage & { payload?: unknown }> {
  return mockPostMessage.mock.calls.map(
    (call) => (call[0] as { payload: BaseMessage & { payload?: unknown } }).payload,
  );
}

function answer(type: string, payload: unknown): void {
  const request = sent().pop();
  if (!request) throw new Error('nothing was sent');
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { id: 'resp-1', type, timestamp: Date.now(), correlationId: request.id, payload },
      }),
    );
  });
}

describe('useRewoundMarks', () => {
  beforeEach(() => {
    mockPostMessage.mockClear();
  });

  it('reads the rewinds of every registered org once, and marks a run they took back', () => {
    const { result } = renderHook(() => useRewoundMarks());

    expect(sent().map(({ type, payload }) => [type, payload])).toEqual([
      ['checkpoint:rewinds', undefined],
    ]);
    // Nothing is marked before they are read.
    expect(result.current(BETWEEN)).toBeUndefined();

    answer('checkpoint:rewinds:response', { rewinds: [REWIND] });

    expect(result.current(BETWEEN)).toMatchObject({
      kind: 'rewound',
      checkpointName: 'Before UAT',
    });
    expect(result.current({ ...BETWEEN, orgId: 'org-other' })).toBeUndefined();
  });

  it('marks nothing when the rewinds cannot be read', () => {
    const { result } = renderHook(() => useRewoundMarks());

    answer('checkpoint:error', { code: 'STORE_REFUSED', message: 'refused', retryable: false });

    expect(result.current(BETWEEN)).toBeUndefined();
  });

  it('reads nothing for a history with no run to mark', () => {
    renderHook(() => useRewoundMarks(true));

    expect(sent()).toEqual([]);
  });
});
