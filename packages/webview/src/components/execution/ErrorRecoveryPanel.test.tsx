import { describe, it, expect, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import type { RetryStatus } from '@sandforge/shared';
import { ErrorRecoveryPanel } from './ErrorRecoveryPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown> | string) => {
      if (typeof opts === 'string') return opts;
      if (opts?.defaultValue) return String(opts.defaultValue)
        .replace('{{current}}', String(opts.current ?? ''))
        .replace('{{max}}', String(opts.max ?? ''))
        .replace('{{seconds}}', String(opts.seconds ?? ''));
      return key;
    },
  }),
}));

const mockPostMessage = vi.fn();

vi.mock('../../hooks/useVSCodeApi', () => ({
  useVSCodeApi: () => ({
    postMessage: mockPostMessage,
    getState: () => undefined,
    setState: () => undefined,
  }),
}));

function dispatchRetryStatus(status: RetryStatus): void {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: {
        id: 'msg-' + Date.now(),
        type: 'execution:retry-status',
        timestamp: Date.now(),
        payload: status,
      },
    }),
  );
}

describe('ErrorRecoveryPanel', () => {
  it('should show empty state when no failures', () => {
    render(<ErrorRecoveryPanel executionId="exec-1" />);
    expect(screen.getByTestId('no-failures')).toBeDefined();
    expect(screen.getByText('No failed operations')).toBeDefined();
  });

  it('should show title', () => {
    render(<ErrorRecoveryPanel executionId="exec-1" />);
    expect(screen.getByText('Error Recovery')).toBeDefined();
  });

  it('should render retry status rows', () => {
    const { rerender } = render(<ErrorRecoveryPanel executionId="exec-1" />);

    act(() => {
      dispatchRetryStatus({
        executionId: 'exec-1',
        objectName: 'Account',
        attemptNumber: 2,
        maxAttempts: 5,
        nextRetryAt: Date.now() + 10000,
        lastError: 'UNABLE_TO_LOCK_ROW: cannot lock row',
        canRetry: true,
        canAbort: true,
      });
    });

    rerender(<ErrorRecoveryPanel executionId="exec-1" />);

    const rows = screen.getAllByTestId('retry-row');
    expect(rows).toHaveLength(1);
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('Attempt 2 of 5')).toBeDefined();
  });

  it('should show countdown timer', () => {
    const { rerender } = render(<ErrorRecoveryPanel executionId="exec-1" />);

    act(() => {
      dispatchRetryStatus({
        executionId: 'exec-1',
        objectName: 'Account',
        attemptNumber: 1,
        maxAttempts: 3,
        nextRetryAt: Date.now() + 15000,
        lastError: 'Test error',
        canRetry: true,
        canAbort: true,
      });
    });

    rerender(<ErrorRecoveryPanel executionId="exec-1" />);

    const countdown = screen.getByTestId('countdown');
    expect(countdown).toBeDefined();
    expect(countdown.textContent).toMatch(/Retrying in \d+s/);
  });

  it('should show exhausted message when canRetry is false', () => {
    const { rerender } = render(<ErrorRecoveryPanel executionId="exec-1" />);

    act(() => {
      dispatchRetryStatus({
        executionId: 'exec-1',
        objectName: 'Account',
        attemptNumber: 5,
        maxAttempts: 5,
        nextRetryAt: null,
        lastError: 'Fatal error',
        canRetry: false,
        canAbort: true,
      });
    });

    rerender(<ErrorRecoveryPanel executionId="exec-1" />);

    expect(screen.getByTestId('exhausted')).toBeDefined();
    expect(screen.getByText('All retries exhausted')).toBeDefined();
  });

  it('should fire manual retry when retry button is clicked', () => {
    const { rerender } = render(<ErrorRecoveryPanel executionId="exec-1" />);

    act(() => {
      dispatchRetryStatus({
        executionId: 'exec-1',
        objectName: 'Account',
        attemptNumber: 1,
        maxAttempts: 3,
        nextRetryAt: null,
        lastError: 'Test error',
        canRetry: true,
        canAbort: true,
      });
    });

    rerender(<ErrorRecoveryPanel executionId="exec-1" />);
    mockPostMessage.mockClear();

    fireEvent.click(screen.getByTestId('retry-button'));

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const msg = mockPostMessage.mock.calls[0][0];
    expect(msg.type).toBe('execution:manual-retry');
    expect(msg.payload.objectName).toBe('Account');
  });

  it('should fire abort when abort button is clicked', () => {
    const { rerender } = render(<ErrorRecoveryPanel executionId="exec-1" />);

    act(() => {
      dispatchRetryStatus({
        executionId: 'exec-1',
        objectName: 'Account',
        attemptNumber: 1,
        maxAttempts: 3,
        nextRetryAt: null,
        lastError: 'Test error',
        canRetry: true,
        canAbort: true,
      });
    });

    rerender(<ErrorRecoveryPanel executionId="exec-1" />);
    mockPostMessage.mockClear();

    fireEvent.click(screen.getByTestId('abort-button'));

    expect(mockPostMessage).toHaveBeenCalledOnce();
    const msg = mockPostMessage.mock.calls[0][0];
    expect(msg.type).toBe('execution:abort');
    expect(msg.payload.objectName).toBe('Account');
  });

  it('should disable retry button when canRetry is false', () => {
    const { rerender } = render(<ErrorRecoveryPanel executionId="exec-1" />);

    act(() => {
      dispatchRetryStatus({
        executionId: 'exec-1',
        objectName: 'Account',
        attemptNumber: 5,
        maxAttempts: 5,
        nextRetryAt: null,
        lastError: 'Fatal error',
        canRetry: false,
        canAbort: true,
      });
    });

    rerender(<ErrorRecoveryPanel executionId="exec-1" />);

    const retryBtn = screen.getByTestId('retry-button');
    expect(retryBtn.hasAttribute('disabled')).toBe(true);
  });

  it('should disable abort button when canAbort is false', () => {
    const { rerender } = render(<ErrorRecoveryPanel executionId="exec-1" />);

    act(() => {
      dispatchRetryStatus({
        executionId: 'exec-1',
        objectName: 'Account',
        attemptNumber: 5,
        maxAttempts: 5,
        nextRetryAt: null,
        lastError: 'Fatal error',
        canRetry: false,
        canAbort: false,
      });
    });

    rerender(<ErrorRecoveryPanel executionId="exec-1" />);

    const abortBtn = screen.getByTestId('abort-button');
    expect(abortBtn.hasAttribute('disabled')).toBe(true);
  });

  it('should expand and collapse error details', () => {
    const { rerender } = render(<ErrorRecoveryPanel executionId="exec-1" />);

    act(() => {
      dispatchRetryStatus({
        executionId: 'exec-1',
        objectName: 'Account',
        attemptNumber: 1,
        maxAttempts: 3,
        nextRetryAt: null,
        lastError: 'This is a long error message that provides detailed information about what went wrong during the operation',
        canRetry: true,
        canAbort: true,
      });
    });

    rerender(<ErrorRecoveryPanel executionId="exec-1" />);

    // Initially collapsed
    expect(screen.queryByTestId('error-details')).toBeNull();

    // Click to expand
    fireEvent.click(screen.getByTestId('error-toggle'));
    rerender(<ErrorRecoveryPanel executionId="exec-1" />);
    expect(screen.getByTestId('error-details')).toBeDefined();

    // Click to collapse
    fireEvent.click(screen.getByTestId('error-toggle'));
    rerender(<ErrorRecoveryPanel executionId="exec-1" />);
    expect(screen.queryByTestId('error-details')).toBeNull();
  });
});
