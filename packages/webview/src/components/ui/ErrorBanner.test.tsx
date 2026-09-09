import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ErrorBanner } from './ErrorBanner';

/** Install a stub clipboard (jsdom ships none) and return its writeText spy. */
function stubClipboard(impl: (text: string) => Promise<void>): ReturnType<typeof vi.fn> {
  const writeText = vi.fn(impl);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

describe('ErrorBanner', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
    vi.useRealTimers();
  });

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
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  describe('copy to clipboard', () => {
    beforeEach(() => {
      stubClipboard(() => Promise.resolve());
    });

    it('should always offer a copy button, even without onDismiss', () => {
      render(<ErrorBanner message="INVALID_FIELD: Account.Foo__c" />);
      expect(screen.getByTestId('error-banner-copy')).toBeDefined();
      expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined();
    });

    it('should derive the copy testid from a custom data-testid', () => {
      render(<ErrorBanner message="Error" data-testid="sync-error" />);
      expect(screen.getByTestId('sync-error-copy')).toBeDefined();
    });

    it('should keep dismiss as the first button so existing callers still hit it', () => {
      const onDismiss = vi.fn();
      render(<ErrorBanner message="Error" onDismiss={onDismiss} data-testid="run-error" />);

      const first = screen.getByTestId('run-error').querySelector('button');
      expect(first?.getAttribute('aria-label')).toBe('Dismiss');
      fireEvent.click(first as HTMLButtonElement);
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('should copy the exact message to the clipboard', async () => {
      const writeText = stubClipboard(() => Promise.resolve());
      const message = 'DUPLICATE_VALUE: duplicate value found on record 001Ax000003AbCdEFG';
      render(<ErrorBanner message={message} />);

      fireEvent.click(screen.getByTestId('error-banner-copy'));

      await waitFor(() => {
        expect(writeText).toHaveBeenCalledWith(message);
      });
    });

    it('should confirm the copy on the button label', async () => {
      render(<ErrorBanner message="Error" />);
      fireEvent.click(screen.getByTestId('error-banner-copy'));
      expect(await screen.findByRole('button', { name: 'Copied!' })).toBeDefined();
    });

    it('should return to the copy label after the confirmation delay', async () => {
      render(<ErrorBanner message="Error" />);
      fireEvent.click(screen.getByTestId('error-banner-copy'));
      await screen.findByRole('button', { name: 'Copied!' });

      await waitFor(
        () => {
          expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined();
        },
        { timeout: 3000 },
      );
    });

    it('should not claim a copy when the clipboard rejects', async () => {
      stubClipboard(() => Promise.reject(new Error('denied')));
      render(<ErrorBanner message="Error" />);

      fireEvent.click(screen.getByTestId('error-banner-copy'));

      await Promise.resolve();
      expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Copy' })).toBeDefined();
    });
  });

  it('should not throw when the host exposes no clipboard', () => {
    Reflect.deleteProperty(navigator, 'clipboard');
    render(<ErrorBanner message="Error" />);
    expect(() => fireEvent.click(screen.getByTestId('error-banner-copy'))).not.toThrow();
    expect(screen.queryByRole('button', { name: 'Copied!' })).toBeNull();
  });

  it('should keep long unbroken text and line breaks inside the banner', () => {
    const message = 'Row 1 failed\nRow 2 failed on 001Ax000003AbCdEFGHIJKLMNOPQRSTUVWXYZ012345';
    render(<ErrorBanner message={message} />);
    const banner = screen.getByTestId('error-banner');
    const text = banner.querySelector('span');
    expect(text).not.toBeNull();
    expect(text?.textContent).toBe(message);
    expect(text?.className).toContain('whitespace-pre-wrap');
    expect(text?.className).toContain('break-words');
  });
});
