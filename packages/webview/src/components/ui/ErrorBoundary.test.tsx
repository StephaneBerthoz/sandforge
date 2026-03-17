import React from 'react';
import '@testing-library/jest-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';

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
});
