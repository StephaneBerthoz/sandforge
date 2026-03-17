import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import '@testing-library/jest-dom';
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

  it('should have aria-live="polite" on the toast container', () => {
    const { container } = render(<FloatingToasts />);
    const toastContainer = container.querySelector('[data-testid="floating-toasts"]');
    expect(toastContainer?.getAttribute('aria-live')).toBe('polite');
  });

  it('should have aria-atomic="true" on the toast container', () => {
    const { container } = render(<FloatingToasts />);
    const toastContainer = container.querySelector('[data-testid="floating-toasts"]');
    expect(toastContainer?.getAttribute('aria-atomic')).toBe('true');
  });

  it('should have role="status" on individual toast items', () => {
    render(<FloatingToasts />);

    act(() => {
      useNotificationStore.getState().addNotification({
        level: 'info',
        title: 'Test',
        message: 'A notification',
      });
    });

    const statusElements = screen.getAllByRole('status');
    expect(statusElements.length).toBeGreaterThanOrEqual(1);
  });
});
