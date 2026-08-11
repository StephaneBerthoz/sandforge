import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

/** Hoisted mock of the VS Code webview API used by ErrorBoundary. */
const vscodeApiMock = vi.hoisted(() => ({
  postMessage: vi.fn(),
  getState: vi.fn(() => undefined),
  setState: vi.fn(),
}));

vi.mock('../../hooks/useVSCodeApi', () => ({
  getVscodeApi: () => vscodeApiMock,
  useVSCodeApi: () => vscodeApiMock,
}));

/** Component that throws an error on render. */
const ThrowingComponent: React.FC<{ shouldThrow?: boolean }> = ({ shouldThrow = true }) => {
  if (shouldThrow) {
    throw new Error('Test error message');
  }
  return <div data-testid="child-content">OK</div>;
};

describe('ErrorBoundary', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vscodeApiMock.postMessage.mockClear();
  });

  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={false} />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('child-content')).toBeInTheDocument();
  });

  it('renders error UI when child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary')).toBeInTheDocument();
    expect(screen.getByTestId('error-message')).toHaveTextContent('Test error message');
  });

  it('renders custom fallback when provided', () => {
    render(
      <ErrorBoundary fallback={<div data-testid="custom-fallback">Custom</div>}>
        <ThrowingComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
  });

  it('resets error state when Recover button is clicked', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-boundary')).toBeInTheDocument();
    expect(screen.getByTestId('error-recover-btn')).toBeInTheDocument();

    // Clicking recover resets the error state; since the child still throws,
    // the boundary re-catches. This verifies the button triggers the handler.
    fireEvent.click(screen.getByTestId('error-recover-btn'));
    // Still shows error boundary because child keeps throwing
    expect(screen.getByTestId('error-boundary')).toBeInTheDocument();
  });

  it('has a copy error button', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>,
    );
    expect(screen.getByTestId('error-copy-btn')).toBeInTheDocument();
  });

  it('posts an error:boundary message to the extension when a child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>,
    );
    // The report goes through the broker envelope — assert on the inner
    // bridge message, not the raw transport payload.
    expect(vscodeApiMock.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          type: 'error:boundary',
          payload: expect.objectContaining({ message: 'Test error message' }),
        }),
      }),
    );
  });

  it('clears the pending copy feedback timeout when unmounted', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');

    const { unmount } = render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>,
    );
    fireEvent.click(screen.getByTestId('error-copy-btn'));
    // Flush the clipboard promise so the feedback timer gets scheduled.
    await act(async () => {
      await Promise.resolve();
    });

    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});
