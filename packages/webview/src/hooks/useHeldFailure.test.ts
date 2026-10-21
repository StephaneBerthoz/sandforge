import { describe, it, expect } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useHeldFailure } from './useHeldFailure';

describe('useHeldFailure', () => {
  it('shows nothing while the first read is on its way', () => {
    const { result } = renderHook(() => useHeldFailure<string>(null, true));
    expect(result.current).toBeNull();
  });

  it('holds what failed while it is read again, then shows the new answer', () => {
    const { result, rerender } = renderHook(
      ({ failure, reading }: { failure: string | null; reading: boolean }) =>
        useHeldFailure(failure, reading),
      { initialProps: { failure: null as string | null, reading: true } },
    );

    rerender({ failure: 'INVALID_SESSION_ID', reading: false });
    expect(result.current).toBe('INVALID_SESSION_ID');

    // Read again: the read clears its error as it starts.
    rerender({ failure: null, reading: true });
    expect(result.current).toBe('INVALID_SESSION_ID');

    rerender({ failure: 'REQUEST_LIMIT_EXCEEDED', reading: false });
    expect(result.current).toBe('REQUEST_LIMIT_EXCEEDED');

    rerender({ failure: null, reading: true });
    rerender({ failure: null, reading: false });
    expect(result.current).toBeNull();

    // What was answered is not shown again by a later read.
    rerender({ failure: null, reading: true });
    expect(result.current).toBeNull();
  });
});
