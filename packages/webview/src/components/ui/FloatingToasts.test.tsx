import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '../../i18n';
import '@testing-library/jest-dom/vitest';
import { FloatingToasts } from './FloatingToasts';
import { useNotificationStore, resetNotificationCounter } from '../../stores/useNotificationStore';

beforeEach(() => {
  useNotificationStore.setState({ notifications: [], maxNotifications: 50 });
  resetNotificationCounter();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('FloatingToasts', () => {
  it('should render the container when there are no notifications', () => {
    const { container } = render(<FloatingToasts />);
    expect(container.querySelector('[data-testid="floating-toasts"]')).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid^="floating-toast-"]')).toHaveLength(0);
  });

  it('should display a new notification as a toast', () => {
    render(<FloatingToasts />);

    act(() => {
      useNotificationStore.getState().addNotification({
        level: 'success',
        title: 'Connected',
        message: 'Org connected successfully',
      });
    });

    expect(screen.getByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Org connected successfully')).toBeInTheDocument();
  });

  it('should show at most 3 toasts', () => {
    render(<FloatingToasts />);

    act(() => {
      for (let i = 0; i < 5; i++) {
        useNotificationStore.getState().addNotification({
          level: 'info',
          title: `Toast ${i}`,
          message: `Message ${i}`,
        });
      }
    });

    const toastElements = document.querySelectorAll('[data-testid^="floating-toast-"]');
    expect(toastElements.length).toBeLessThanOrEqual(3);
  });

  it('should auto-dismiss toasts after autoDismissMs', () => {
    render(<FloatingToasts />);

    act(() => {
      useNotificationStore.getState().addNotification({
        level: 'success',
        title: 'Temp',
        message: 'Goes away',
        autoDismissMs: 3000,
      });
    });

    expect(screen.getByText('Temp')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3100);
    });

    expect(screen.queryByText('Temp')).not.toBeInTheDocument();
  });

  it('keeps an error up until it is dismissed, whatever time it was given', () => {
    // An error is something to act on. Pages hand theirs 5 s like any other
    // toast, and a message longer than two lines was cut at the second.
    render(<FloatingToasts />);
    const message =
      'The org rejected the batch: FIELD_CUSTOM_VALIDATION_EXCEPTION on Account.Industry__c, ' +
      'on three records of the first chunk, and the run stopped before the second one.';

    act(() => {
      useNotificationStore.getState().addNotification({
        level: 'error',
        title: 'Seed',
        message,
        autoDismissMs: 5000,
      });
      useNotificationStore.getState().addNotification({
        level: 'success',
        title: 'Saved',
        message: 'Template saved',
        autoDismissMs: 5000,
      });
    });
    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    const error = screen.getByText(message);
    expect(error.className).not.toMatch(/line-clamp/);

    act(() => {
      screen.getByRole('button', { name: 'Dismiss' }).click();
    });
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });

  it('should render error toasts', () => {
    render(<FloatingToasts />);

    act(() => {
      useNotificationStore.getState().addNotification({
        level: 'error',
        title: 'Failed',
        message: 'Something broke',
      });
    });

    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Something broke')).toBeInTheDocument();
  });

  it('keeps the toasts out of any live region: each new one is said once, apart from them', () => {
    // An atomic polite container around status toasts: every new toast read
    // out again the errors still on screen.
    const { container } = render(<FloatingToasts />);
    const toastContainer = container.querySelector('[data-testid="floating-toasts"]');
    expect(toastContainer?.hasAttribute('aria-live')).toBe(false);
    expect(toastContainer?.hasAttribute('aria-atomic')).toBe(false);
  });

  it('says an error assertively, once, and a later toast without reading the error again', () => {
    render(<FloatingToasts />);
    act(() => {
      useNotificationStore.getState().addNotification({
        level: 'error',
        title: 'Forge failed',
        message: 'The target refused the run.',
      });
    });
    const errors = screen.getByTestId('toasts-said-errors');
    expect(errors.getAttribute('aria-live')).toBe('assertive');
    expect(errors.textContent).toBe(
      'Forge failed. The target refused the run. Press Alt+N to reach it.',
    );

    act(() => {
      useNotificationStore.getState().addNotification({
        level: 'success',
        title: 'Saved',
        message: 'Template saved',
        autoDismissMs: 5000,
      });
    });
    const polite = screen.getByTestId('toasts-said');
    expect(polite.getAttribute('aria-live')).toBe('polite');
    expect(polite.textContent).toBe('Saved. Template saved.');
    // The error still on screen is not said again with it.
    expect(polite.textContent).not.toContain('Forge failed');
    expect(errors.textContent).toBe(
      'Forge failed. The target refused the run. Press Alt+N to reach it.',
    );
  });

  it('takes the focus to the newest toast that stays up on Alt+N, and gives it back on dismiss', () => {
    render(
      <>
        <button data-testid="page-control">page</button>
        <FloatingToasts />
      </>,
    );
    act(() => {
      useNotificationStore.getState().addNotification({
        level: 'error',
        title: 'Sync failed',
        message: 'Session expired',
      });
    });
    const pageControl = screen.getByTestId('page-control');
    pageControl.focus();

    fireEvent.keyDown(window, { key: 'n', altKey: true });
    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    expect(document.activeElement).toBe(dismiss);

    act(() => {
      fireEvent.click(dismiss);
    });
    expect(screen.queryByText('Sync failed')).not.toBeInTheDocument();
    expect(document.activeElement).toBe(pageControl);
  });

  it('renders an action that carries a URL as a link to that page', () => {
    // A host notification cannot hand the webview a callback, so its action
    // button used to dismiss the toast and do nothing else.
    render(<FloatingToasts />);

    act(() => {
      useNotificationStore.getState().addNotification({
        level: 'error',
        title: 'Salesforce CLI',
        message: 'Salesforce CLI (sf) not found on PATH.',
        actions: [
          {
            label: 'Install the CLI',
            command: 'sf-cli-install',
            url: 'https://developer.salesforce.com/tools/salesforcecli',
          },
        ],
      });
    });

    const action = screen.getByTestId('toast-action-sf-cli-install');
    expect(action.tagName).toBe('A');
    expect(action.getAttribute('href')).toBe(
      'https://developer.salesforce.com/tools/salesforcecli',
    );
  });

  it('gives no toast a live role of its own, nor the regions that say them a role of the page', () => {
    // An always-mounted role="alert" read as an alert of the page that was
    // empty, and stood beside the page's own alerts.
    render(<FloatingToasts />);

    act(() => {
      useNotificationStore.getState().addNotification({
        level: 'info',
        title: 'Test',
        message: 'A notification',
      });
    });

    const toast = screen.getByText('A notification').closest('[data-toast-id]');
    expect(toast?.hasAttribute('role')).toBe(false);
    expect(screen.queryAllByRole('status')).toEqual([]);
    expect(screen.queryAllByRole('alert')).toEqual([]);
    expect(screen.getByTestId('toasts-said').textContent).toBe(
      'Test. A notification. Press Alt+N to reach it.',
    );
  });
});
