import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationCenter } from './NotificationCenter';
import type { Notification, NotificationListener } from './NotificationCenter';

describe('NotificationCenter', () => {
  let center: NotificationCenter;

  beforeEach(() => {
    center = new NotificationCenter();
  });

  describe('notify', () => {
    it('should create a notification with correct properties', () => {
      const notif = center.notify('info', 'Title', 'Message');

      expect(notif.id).toMatch(/^notif-\d+$/);
      expect(notif.level).toBe('info');
      expect(notif.title).toBe('Title');
      expect(notif.message).toBe('Message');
      expect(notif.read).toBe(false);
      expect(notif.timestamp).toBeGreaterThan(0);
    });

    it('should assign unique ids to each notification', () => {
      const first = center.notify('info', 'A', 'a');
      const second = center.notify('info', 'B', 'b');

      expect(first.id).not.toBe(second.id);
    });

    it('should accept optional actions and autoDismissMs', () => {
      const callback = vi.fn();
      const notif = center.notify('warning', 'T', 'M', {
        actions: [{ label: 'Retry', callback }],
        autoDismissMs: 3000,
      });

      expect(notif.actions).toHaveLength(1);
      expect(notif.actions?.[0].label).toBe('Retry');
      expect(notif.autoDismissMs).toBe(3000);
    });
  });

  describe('shorthand methods', () => {
    it('should create an info notification', () => {
      const notif = center.info('Info', 'Info message');
      expect(notif.level).toBe('info');
      expect(notif.autoDismissMs).toBeUndefined();
    });

    it('should create a success notification with auto-dismiss', () => {
      const notif = center.success('Done', 'Success message');
      expect(notif.level).toBe('success');
      expect(notif.autoDismissMs).toBe(5000);
    });

    it('should create a warning notification with auto-dismiss', () => {
      const notif = center.warning('Warn', 'Warning message');
      expect(notif.level).toBe('warning');
      expect(notif.autoDismissMs).toBe(10000);
    });

    it('should create an error notification without auto-dismiss', () => {
      const notif = center.error('Err', 'Error message');
      expect(notif.level).toBe('error');
      expect(notif.autoDismissMs).toBeUndefined();
    });
  });

  describe('listener dispatch', () => {
    it('should call registered listeners when a notification is sent', () => {
      const listener = vi.fn<NotificationListener>();
      center.onNotification(listener);

      const notif = center.info('Test', 'Test message');

      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenCalledWith(notif);
    });

    it('should call multiple listeners', () => {
      const listener1 = vi.fn<NotificationListener>();
      const listener2 = vi.fn<NotificationListener>();
      center.onNotification(listener1);
      center.onNotification(listener2);

      center.info('Test', 'msg');

      expect(listener1).toHaveBeenCalledOnce();
      expect(listener2).toHaveBeenCalledOnce();
    });

    it('should continue notifying listeners even if one throws', () => {
      const throwing = vi.fn(() => {
        throw new Error('boom');
      });
      const safe = vi.fn();
      center.onNotification(throwing);
      center.onNotification(safe);

      center.info('Test', 'msg');

      expect(throwing).toHaveBeenCalledTimes(1);
      expect(safe).toHaveBeenCalledTimes(1);
    });

    it('should stop calling a listener after offNotification', () => {
      const listener = vi.fn<NotificationListener>();
      center.onNotification(listener);
      center.offNotification(listener);

      center.info('Test', 'msg');

      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('markAsRead', () => {
    it('should mark a notification as read and return true', () => {
      const notif = center.info('Test', 'msg');
      expect(notif.read).toBe(false);

      const result = center.markAsRead(notif.id);

      expect(result).toBe(true);
      expect(center.getAll().find((n) => n.id === notif.id)?.read).toBe(true);
    });

    it('should return false for a non-existent id', () => {
      const result = center.markAsRead('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('markAllAsRead', () => {
    it('should mark all notifications as read', () => {
      center.info('A', 'a');
      center.warning('B', 'b');
      center.error('C', 'c');

      center.markAllAsRead();

      const allNotifs = center.getAll();
      expect(allNotifs.every((n) => n.read)).toBe(true);
    });
  });

  describe('unreadCount', () => {
    it('should return the number of unread notifications', () => {
      center.info('A', 'a');
      center.info('B', 'b');
      center.info('C', 'c');

      expect(center.unreadCount).toBe(3);

      center.markAsRead(center.getAll()[0].id);
      expect(center.unreadCount).toBe(2);
    });

    it('should return 0 when no notifications exist', () => {
      expect(center.unreadCount).toBe(0);
    });
  });

  describe('getAll', () => {
    it('should return a copy of all notifications', () => {
      center.info('A', 'a');
      center.warning('B', 'b');

      const all = center.getAll();
      expect(all).toHaveLength(2);

      all.push({} as Notification);
      expect(center.getAll()).toHaveLength(2);
    });
  });

  describe('getRecent', () => {
    it('should return the last N notifications', () => {
      center.info('A', 'a');
      center.info('B', 'b');
      center.info('C', 'c');
      center.info('D', 'd');

      const recent = center.getRecent(2);
      expect(recent).toHaveLength(2);
      expect(recent[0].title).toBe('C');
      expect(recent[1].title).toBe('D');
    });

    it('should return all notifications when count exceeds total', () => {
      center.info('A', 'a');
      const recent = center.getRecent(50);
      expect(recent).toHaveLength(1);
    });
  });

  describe('getByLevel', () => {
    it('should filter notifications by level', () => {
      center.info('Info', 'msg');
      center.error('Error1', 'msg');
      center.error('Error2', 'msg');
      center.warning('Warn', 'msg');

      const errors = center.getByLevel('error');
      expect(errors).toHaveLength(2);
      expect(errors.every((n) => n.level === 'error')).toBe(true);
    });

    it('should return an empty array when no notifications match', () => {
      center.info('Info', 'msg');
      expect(center.getByLevel('success')).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('should remove all notifications', () => {
      center.info('A', 'a');
      center.error('B', 'b');

      center.clear();

      expect(center.getAll()).toHaveLength(0);
      expect(center.unreadCount).toBe(0);
    });
  });

  describe('dispose', () => {
    it('should remove all listeners and notifications', () => {
      const listener = vi.fn<NotificationListener>();
      center.onNotification(listener);
      center.info('A', 'a');

      center.dispose();

      expect(center.getAll()).toHaveLength(0);

      center.info('B', 'b');
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('max notifications trimming', () => {
    it('should trim oldest notifications when exceeding maxNotifications', () => {
      const small = new NotificationCenter(3);

      small.info('A', 'a');
      small.info('B', 'b');
      small.info('C', 'c');
      small.info('D', 'd');

      const all = small.getAll();
      expect(all).toHaveLength(3);
      expect(all[0].title).toBe('B');
      expect(all[1].title).toBe('C');
      expect(all[2].title).toBe('D');
    });

    it('should not trim when at the limit', () => {
      const small = new NotificationCenter(2);

      small.info('A', 'a');
      small.info('B', 'b');

      expect(small.getAll()).toHaveLength(2);
    });
  });
});
