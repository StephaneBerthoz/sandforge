import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import '../../i18n';
import { fakeHost } from './testing/checkpointFixtures';
import type { FakeHost } from './testing/checkpointFixtures';

const host = vi.hoisted(() => ({ current: null as null | FakeHost }));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import { useReplayBridge } from './useReplayBridge';

/** Send a message as the extension does, correlated to `correlationId`. */
function deliver(type: string, payload: unknown, correlationId: string): void {
  act(() => {
    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          id: `host-${type}-${correlationId}`,
          type,
          timestamp: Date.now(),
          payload,
          correlationId,
        },
      }),
    );
  });
}

describe('useReplayBridge', () => {
  beforeEach(() => {
    host.current = fakeHost();
  });

  it('keeps a refusal of its own simulation whole, what it names beside its code, and no other panel’s', () => {
    const { result } = renderHook(() => useReplayBridge());
    act(() => result.current.preview.run({ targetOrgId: 'org-qa' }));
    const id = host.current?.sent('frozen:load:preview')[0]?.id ?? '';

    deliver(
      'frozen:load:preview:error',
      { code: 'REPLAY_SAME_ORG', message: 'other', retryable: false, params: { target: 'X' } },
      'another-panel',
    );
    expect(result.current.preview.errorPayload).toBeNull();

    deliver(
      'frozen:load:preview:error',
      { code: 'REPLAY_REAL_DATA', message: 'host words', retryable: false, params: { mb: 5120 } },
      id,
    );
    expect(result.current.preview.error).toBe('host words');
    expect(result.current.preview.errorPayload).toMatchObject({
      code: 'REPLAY_REAL_DATA',
      params: { mb: 5120 },
    });

    act(() => result.current.preview.run({ targetOrgId: 'org-qa' }));
    expect(result.current.preview.errorPayload).toBeNull();
  });

  it('follows its own replay’s progress and the verification chained after it, under the replay’s id', () => {
    const { result } = renderHook(() => useReplayBridge());
    act(() => result.current.load.run({ targetOrgId: 'org-qa' }));
    const id = host.current?.sent('frozen:load')[0]?.id ?? '';

    deliver(
      'frozen:load:progress',
      { phase: 'insert', status: 'started', progress: 10, message: 'x' },
      'other',
    );
    expect(result.current.progress).toBeNull();
    deliver(
      'frozen:load:progress',
      { phase: 'insert', objectName: 'Account', status: 'started', progress: 40, message: 'x' },
      id,
    );
    expect(result.current.progress).toMatchObject({ objectName: 'Account', progress: 40 });

    deliver(
      'frozen:verify:result',
      { verdict: { status: 'failed', checks: [], attempts: 1, measuredAt: 'x' } },
      'other',
    );
    expect(result.current.verdict).toBeNull();
    deliver(
      'frozen:verify:result',
      { verdict: { status: 'passed', checks: [], attempts: 2, measuredAt: 'x' } },
      id,
    );
    expect(result.current.verdict?.status).toBe('passed');
  });

  it('says the verdict Verify asked over the one a replay chained', () => {
    const { result } = renderHook(() => useReplayBridge());
    act(() => result.current.load.run({ targetOrgId: 'org-qa' }));
    const loadId = host.current?.sent('frozen:load')[0]?.id ?? '';
    deliver(
      'frozen:verify:result',
      { verdict: { status: 'partial', checks: [], attempts: 1, measuredAt: 'x' } },
      loadId,
    );
    act(() => result.current.verify.run({ targetOrgId: 'org-qa' }));
    const verifyId = host.current?.sent('frozen:verify')[0]?.id ?? '';
    deliver(
      'frozen:verify:result',
      { verdict: { status: 'passed', checks: [], attempts: 1, measuredAt: 'x' } },
      verifyId,
    );
    expect(result.current.verdict?.status).toBe('passed');
  });
});
