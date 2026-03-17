import { describe, it, expect, beforeEach } from 'vitest';
import {
  useNotificationStore,
  resetNotificationCounter,
} from './useNotificationStore';
import type { NotificationInput } from './useNotificationStore';

function getState(): ReturnType<typeof useNotificationStore.getState> {
  return useNotificationStore.getState();
}

function createInput(overrides: Partial<NotificationInput> = {}): NotificationInput {
  return {
    level: 'info',
    title: 'Test notification',
    message: 'This is a test notification.',
    ...overrides,
  };
}

describe('useNotificationStore', () => {
  beforeEach(() => {
    resetNotificationCounter();
    useNotificationStore.setState({
      notifications: [],
      maxNotifications: 50,
    });
  });

  it('should have correct initial state', () => {
    const state = getState();
    expect(state.notifications).toEqual([]);
    expect(state.maxNotifications).toBe(50);
  });

  it('should add a notification and return its id', () => {
    const id = getState().addNotification(createInput({ title: 'Hello' }));
    expect(id).toBe('sf-notif-1');

    const notifications = getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('Hello');
    expect(notifications[0].read).toBe(false);
    expect(notifications[0].timestamp).toBeGreaterThan(0);
  });

  it('should assign sequential ids to notifications', () => {
    const id1 = getState().addNotification(createInput());
    const id2 = getState().addNotification(createInput());
    const id3 = getState().addNotification(createInput());

    expect(id1).toBe('sf-notif-1');
    expect(id2).toBe('sf-notif-2');
    expect(id3).toBe('sf-notif-3');
  });

  it('should prepend new notifications (newest first)', () => {
    getState().addNotification(createInput({ title: 'First' }));
    getState().addNotification(createInput({ title: 'Second' }));

    const notifications = getState().notifications;
    expect(notifications[0].title).toBe('Second');
    expect(notifications[1].title).toBe('First');
  });

  it('should enforce maxNotifications limit', () => {
    useNotificationStore.setState({ maxNotifications: 3 });

    getState().addNotification(createInput({ title: 'One' }));
    getState().addNotification(createInput({ title: 'Two' }));
    getState().addNotification(createInput({ title: 'Three' }));
    getState().addNotification(createInput({ title: 'Four' }));

    const notifications = getState().notifications;
    expect(notifications).toHaveLength(3);
    expect(notifications[0].title).toBe('Four');
    expect(notifications[2].title).toBe('Two');
  });

  it('should remove a notification by id', () => {
    const id = getState().addNotification(createInput({ title: 'To Remove' }));
    getState().addNotification(createInput({ title: 'To Keep' }));

    getState().removeNotification(id);

    const notifications = getState().notifications;
    expect(notifications).toHaveLength(1);
    expect(notifications[0].title).toBe('To Keep');
  });

  it('should mark a single notification as read', () => {
    const id = getState().addNotification(createInput());
    expect(getState().notifications[0].read).toBe(false);

    getState().markRead(id);
    expect(getState().notifications[0].read).toBe(true);
  });

  it('should mark all notifications as read', () => {
    getState().addNotification(createInput({ title: 'A' }));
    getState().addNotification(createInput({ title: 'B' }));
    getState().addNotification(createInput({ title: 'C' }));

    getState().markAllRead();

    const allRead = getState().notifications.every((n) => n.read);
    expect(allRead).toBe(true);
  });

  it('should clear all notifications', () => {
    getState().addNotification(createInput());
    getState().addNotification(createInput());
    expect(getState().notifications).toHaveLength(2);

    getState().clearAll();
    expect(getState().notifications).toEqual([]);
  });

  it('should return correct unread count', () => {
    getState().addNotification(createInput());
    getState().addNotification(createInput());
    const id3 = getState().addNotification(createInput());

    expect(getState().unreadCount()).toBe(3);

    getState().markRead(id3);
    expect(getState().unreadCount()).toBe(2);

    getState().markAllRead();
    expect(getState().unreadCount()).toBe(0);
  });

  it('should preserve notification actions and autoDismissMs', () => {
    const actions = [
      { label: 'Retry', command: 'sandforge.retry' },
      { label: 'Dismiss', command: 'sandforge.dismiss' },
    ];
    getState().addNotification(
      createInput({
        level: 'error',
        title: 'Failed',
        autoDismissMs: 5000,
        actions,
      }),
    );

    const notification = getState().notifications[0];
    expect(notification.level).toBe('error');
    expect(notification.autoDismissMs).toBe(5000);
    expect(notification.actions).toEqual(actions);
  });
});
