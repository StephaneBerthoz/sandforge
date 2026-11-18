import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { RECOVERY_ERROR_CODES } from '@sandforge/shared';
import { fakeHost, refreshedStatus, type FakeHost } from './testing/recoveryFixtures';

const host = vi.hoisted(() => ({ current: null as null | FakeHost }));

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => host.current?.api,
  getVscodeApi: () => host.current?.api,
}));

import {
  recoveryErrorCodeOf,
  useRecoveryBridge,
  useRecoveryUsersBridge,
} from './useRecoveryBridge';

beforeEach(() => {
  host.current = fakeHost();
});

describe('recoveryErrorCodeOf', () => {
  it('knows every code of the domain, and no other', () => {
    for (const code of RECOVERY_ERROR_CODES) expect(recoveryErrorCodeOf(code)).toBe(code);
    expect(recoveryErrorCodeOf('ORG_AUTH_EXPIRED')).toBe(null);
    expect(recoveryErrorCodeOf(null)).toBe(null);
  });
});

describe('useRecoveryBridge', () => {
  it('asks the status and takes the answer correlated to it, and its error on the domain’s channel', () => {
    const { result } = renderHook(() => useRecoveryBridge());
    act(() => result.current.status.mutate({ orgId: 'org-uat' }));
    act(() =>
      host.current?.answer('recovery:status', 'recovery:status:response', {
        status: refreshedStatus(),
      }),
    );
    expect(result.current.status.data?.status.orgId).toBe('org-uat');

    act(() => result.current.ack.mutate({ orgId: 'org-uat', what: 'finish' }));
    act(() => host.current?.fail('recovery:ack', { code: 'NOT_CONNECTED', message: 'not' }));
    expect(result.current.ack.errorCode).toBe('NOT_CONNECTED');
  });
});

describe('useRecoveryUsersBridge', () => {
  it('follows the progress of its own run only, while it runs', () => {
    const { result } = renderHook(() => useRecoveryUsersBridge());
    act(() => result.current.apply.mutate({ orgId: 'org-uat' }));
    const id = host.current?.sent('recovery:users:apply')[0]?.id;

    act(() =>
      host.current?.push('recovery:users:progress', { orgId: 'org-uat', done: 5, total: 9 }, 'x'),
    );
    expect(result.current.progress).toBe(null);
    act(() =>
      host.current?.push('recovery:users:progress', { orgId: 'org-uat', done: 2, total: 9 }, id),
    );
    expect(result.current.progress).toEqual({ done: 2, total: 9 });

    act(() =>
      host.current?.fail('recovery:users:apply', { code: 'CANCELLED', message: 'stopped' }),
    );
    expect(result.current.progress).toBe(null);
  });
});
