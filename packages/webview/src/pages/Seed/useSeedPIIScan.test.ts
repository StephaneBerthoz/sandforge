import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { TFunction } from 'i18next';

import { useSeedPIIScan } from './useSeedPIIScan';

/* ------------------------------------------------------------------ */
/* Mock bridge hooks                                                   */
/* ------------------------------------------------------------------ */
const mockMutate = vi.fn();
let mockData: unknown = null;
let mockLoading = false;
let mockError: string | null = null;

vi.mock('../../hooks/useBridgeMutation', () => ({
  useBridgeMutation: () => ({
    mutate: mockMutate,
    data: mockData,
    loading: mockLoading,
    error: mockError,
    reset: vi.fn(),
  }),
}));

const mockAddNotification = vi.fn();

vi.mock('../../stores/useNotificationStore', () => ({
  useNotificationStore: () => mockAddNotification,
}));

const mockT: TFunction = ((key: string) => key) as unknown as TFunction;

describe('useSeedPIIScan', () => {
  beforeEach(() => {
    mockMutate.mockClear();
    mockAddNotification.mockClear();
    mockData = null;
    mockLoading = false;
    mockError = null;
  });

  it('should initialize with empty PII results and no warnings', () => {
    const { result } = renderHook(() => useSeedPIIScan('org-1', ['Account'], 0, mockT));

    expect(result.current.piiResults).toEqual([]);
    expect(result.current.hasPiiWarnings).toBe(false);
    expect(result.current.piiLoading).toBe(false);
    expect(result.current.piiError).toBeUndefined();
  });

  it('should trigger PII scan when entering step 1', () => {
    renderHook(() => useSeedPIIScan('org-1', ['Account', 'Contact'], 1, mockT));

    expect(mockMutate).toHaveBeenCalledWith({
      orgId: 'org-1',
      objectNames: ['Account', 'Contact'],
    });
  });

  it('should not trigger PII scan on step 0', () => {
    renderHook(() => useSeedPIIScan('org-1', ['Account'], 0, mockT));

    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('should not trigger PII scan without org', () => {
    renderHook(() => useSeedPIIScan('', ['Account'], 1, mockT));

    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('should not trigger PII scan without objects', () => {
    renderHook(() => useSeedPIIScan('org-1', [], 1, mockT));

    expect(mockMutate).not.toHaveBeenCalled();
  });

  it('should reflect loading state from mutation', () => {
    mockLoading = true;

    const { result } = renderHook(() => useSeedPIIScan('org-1', ['Account'], 0, mockT));

    expect(result.current.piiLoading).toBe(true);
  });

  it('should detect PII warnings when results contain PII fields', () => {
    mockData = {
      success: true,
      results: [
        {
          objectName: 'Contact',
          piiFields: [{ fieldName: 'Email', piiType: 'email', confidence: 0.95 }],
        },
      ],
    };

    const { result } = renderHook(() => useSeedPIIScan('org-1', ['Contact'], 0, mockT));

    expect(result.current.hasPiiWarnings).toBe(true);
    expect(result.current.piiResults).toHaveLength(1);
  });

  it('should not report PII warnings when no PII fields found', () => {
    mockData = {
      success: true,
      results: [{ objectName: 'Account', piiFields: [] }],
    };

    const { result } = renderHook(() => useSeedPIIScan('org-1', ['Account'], 0, mockT));

    expect(result.current.hasPiiWarnings).toBe(false);
  });

  it('should surface errors as notifications', () => {
    mockError = 'PII scan failed';

    renderHook(() => useSeedPIIScan('org-1', ['Account'], 0, mockT));

    expect(mockAddNotification).toHaveBeenCalledWith({
      level: 'error',
      title: 'seed.title',
      message: 'PII scan failed',
      autoDismissMs: 5000,
    });
  });

  it('should expose error via piiError property', () => {
    mockError = 'Network timeout';

    const { result } = renderHook(() => useSeedPIIScan('org-1', ['Account'], 0, mockT));

    expect(result.current.piiError).toBe('Network timeout');
  });
});
