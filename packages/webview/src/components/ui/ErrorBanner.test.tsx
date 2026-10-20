import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import i18n from '../../i18n';
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
    expect(text?.className).toContain('wrap-break-word');
  });
  describe('what the error means and what to do', () => {
    it('says it under a handler error, from its message, in the wording every module shares', () => {
      render(
        <ErrorBanner message="ENTITY_IS_LOCKED: entity is locked for editing" code="UNKNOWN" />,
      );

      const hint = screen.getByTestId('error-hint');
      expect(hint.textContent).toContain(i18n.t('errors.entityLocked.explanation'));
      expect(hint.textContent).toContain(i18n.t('errors.entityLocked.action'));
      // The raw line stays as it came, and is what the copy button copies.
      expect(screen.getByTestId('error-banner').querySelector('span')?.textContent).toBe(
        'ENTITY_IS_LOCKED: entity is locked for editing',
      );
      expect(screen.getByRole('alert').contains(hint)).toBe(true);
    });

    it('says it by the code the host sent when the message names none', () => {
      render(
        <ErrorBanner
          message="FLS violation on 'Account': fields [Rating] are not updateable."
          code="CRUD_FLS_DENIED"
        />,
      );
      expect(screen.getByTestId('error-hint').textContent).toContain(
        i18n.t('errors.permissionDenied.action'),
      );
    });

    it('reads the message of an error that came with no code', () => {
      render(
        <ErrorBanner message="UNABLE_TO_LOCK_ROW: unable to obtain exclusive access" code={null} />,
      );
      expect(screen.getByTestId('error-hint').textContent).toContain(
        i18n.t('errors.rowLocked.explanation'),
      );
    });

    it('takes the wording of the module it is in', () => {
      render(
        <ErrorBanner
          message="REQUIRED_FIELD_MISSING: Required fields are missing: [Name]"
          code={null}
          module="seed"
        />,
      );
      expect(screen.getByTestId('error-hint').textContent).toContain(
        i18n.t('errors.requiredFieldMissing.seed.action'),
      );
    });

    it('says nothing more of a message no code was asked for, as a check of the page’s own', () => {
      render(<ErrorBanner message="ENTITY_IS_LOCKED: entity is locked" />);
      expect(screen.queryByTestId('error-hint')).toBeNull();
    });

    it('says nothing more of an error the panel already worded by its code', () => {
      render(
        <ErrorBanner
          message={i18n.t('errors.orgAuthExpired.explanation')}
          code="ORG_AUTH_EXPIRED"
        />,
      );
      expect(screen.queryByTestId('error-hint')).toBeNull();
    });

    it('says nothing more of a message it knows nothing of', () => {
      render(<ErrorBanner message="Bridge query timed out" code="UNKNOWN" />);
      expect(screen.queryByTestId('error-hint')).toBeNull();
    });
  });
});
