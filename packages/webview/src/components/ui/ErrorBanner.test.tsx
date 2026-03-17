import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBanner } from './ErrorBanner';

describe('ErrorBanner', () => {
  it('should render error message', () => {
    render(<ErrorBanner message="Something went wrong" />);
    expect(screen.getByText('Something went wrong')).toBeDefined();
  });

  it('should have role alert', () => {
    render(<ErrorBanner message="Error" />);
    expect(screen.getByRole('alert')).toBeDefined();
  });

  it('should use default data-testid', () => {
    render(<ErrorBanner message="Error" />);
    expect(screen.getByTestId('error-banner')).toBeDefined();
  });

  it('should use custom data-testid', () => {
    render(<ErrorBanner message="Error" data-testid="custom-error" />);
    expect(screen.getByTestId('custom-error')).toBeDefined();
  });

  it('should show dismiss button when onDismiss provided', () => {
    const onDismiss = vi.fn();
    render(<ErrorBanner message="Error" onDismiss={onDismiss} />);
    const btn = screen.getByRole('button', { name: 'Dismiss' });
    expect(btn).toBeDefined();
    fireEvent.click(btn);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('should not show dismiss button when onDismiss not provided', () => {
    render(<ErrorBanner message="Error" />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
