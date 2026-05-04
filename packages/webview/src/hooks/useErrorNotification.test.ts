import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useErrorNotification } from './useErrorNotification';
import { useNotificationStore, resetNotificationCounter } from '../stores/useNotificationStore';

describe('useErrorNotification', () => {
  beforeEach(() => {
    useNotificationStore.setState({ notifications: [] });
    resetNotificationCounter();
  });

  it('should add an error notification when error is a non-empty string', () => {
    renderHook(() => useErrorNotification('Something went wrong', 'Seed'));

    const { notifications } = useNotificationStore.getState();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].level).toBe('error');
    expect(notifications[0].title).toBe('Seed');
    expect(notifications[0].message).toBe('Something went wrong');
    expect(notifications[0].autoDismissMs).toBe(5000);
  });

  it('should not add a notification when error is null', () => {
    renderHook(() => useErrorNotification(null, 'Seed'));

    const { notifications } = useNotificationStore.getState();
    expect(notifications).toHaveLength(0);
  });

  it('should not add a notification when error is undefined', () => {
    renderHook(() => useErrorNotification(undefined, 'Seed'));

    const { notifications } = useNotificationStore.getState();
    expect(notifications).toHaveLength(0);
  });

  it('should use custom autoDismissMs', () => {
    renderHook(() => useErrorNotification('Oops', 'Monitor', 10000));

    const { notifications } = useNotificationStore.getState();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].autoDismissMs).toBe(10000);
  });

  it('should add a new notification when error changes', () => {
    const { rerender } = renderHook(({ error }) => useErrorNotification(error, 'Seed'), {
      initialProps: { error: 'Error 1' as string | null },
    });

    rerender({ error: 'Error 2' });

    const { notifications } = useNotificationStore.getState();
    expect(notifications).toHaveLength(2);
  });

  it('should not re-add notification when error stays the same', () => {
    const { rerender } = renderHook(({ error }) => useErrorNotification(error, 'Seed'), {
      initialProps: { error: 'Same error' as string | null },
    });

    rerender({ error: 'Same error' });

    const { notifications } = useNotificationStore.getState();
    expect(notifications).toHaveLength(1);
  });
});
