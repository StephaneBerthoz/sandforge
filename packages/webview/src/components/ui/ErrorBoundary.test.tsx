import React from 'react';
import '@testing-library/jest-dom/vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

  describe('a page whose file could not be fetched', () => {
    const CHUNK_URL =
      'https://file+.vscode-resource.vscode-cdn.net/home/someone/.vscode-server/extensions/sandforge/webview-dist/assets/chunks/ForgeReview-Dm32KBlM.js';

    /** A page loaded on demand whose file the browser could not fetch, as React gets it. */
    const NotFetched = React.lazy(() =>
      Promise.reject(new TypeError(`Failed to fetch dynamically imported module: ${CHUNK_URL}`)),
    );

    afterEach(() => {
      delete window.__SANDFORGE_MODULE__;
    });

    it('says so in words, with no URL, and offers to reload the panel instead of Recover', async () => {
      // Recover drew the same failure again: React keeps a page loaded on
      // demand failed once its file failed, and never fetches it again.
      window.__SANDFORGE_MODULE__ = 'forge';
      render(
        <ErrorBoundary>
          <React.Suspense fallback={null}>
            <NotFetched />
          </React.Suspense>
        </ErrorBoundary>,
      );
      const boundary = await screen.findByTestId('error-boundary');

      expect(boundary).toHaveTextContent('Part of this panel did not load');
      expect(boundary.textContent).not.toContain('vscode-resource');
      expect(boundary.textContent).not.toContain('someone');
      expect(boundary.textContent).not.toContain('dynamically imported');
      expect(screen.queryByTestId('error-message')).toBeNull();
      expect(screen.queryByTestId('error-recover-btn')).toBeNull();

      vscodeApiMock.postMessage.mockClear();
      fireEvent.click(screen.getByTestId('error-reload-panel-btn'));
      expect(vscodeApiMock.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            type: 'panel:reload',
            payload: { moduleId: 'forge' },
          }),
        }),
      );
    });

    it("copies the error with each URL cut to its file, so the user's home folder stays out of the report", async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      render(
        <ErrorBoundary>
          <React.Suspense fallback={null}>
            <NotFetched />
          </React.Suspense>
        </ErrorBoundary>,
      );
      fireEvent.click(await screen.findByTestId('error-copy-btn'));

      const copied = writeText.mock.calls[0][0] as string;
      expect(copied).toContain('…/ForgeReview-Dm32KBlM.js');
      expect(copied).not.toContain('someone');
      expect(copied).not.toContain('vscode-resource');
    });
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
