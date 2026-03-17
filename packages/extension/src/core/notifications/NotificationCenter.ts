import { logger } from '../../logger.js';
import { extractErrorMessage } from '../common/extractErrorMessage.js';

/** Notification level */
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

/** Action that can be attached to a notification */
export interface NotificationAction {
  label: string;
  callback: () => void;
}

/** A single notification entry */
export interface Notification {
  id: string;
  level: NotificationLevel;
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
  actions?: NotificationAction[];
  autoDismissMs?: number;
}

/** Listener for notification events */
export type NotificationListener = (notification: Notification) => void;

/**
 * Central notification hub for the SandForge extension.
 * Manages notification lifecycle and dispatches to listeners (VSCode API, WebView).
 */
export class NotificationCenter {
  private notifications: Notification[] = [];
  private listeners: Set<NotificationListener> = new Set();
  private maxNotifications: number;
  private static idCounter = 0;

  constructor(maxNotifications: number = 100) {
    this.maxNotifications = maxNotifications;
  }

  /** Add a listener for new notifications */
  onNotification(listener: NotificationListener): void {
    this.listeners.add(listener);
  }

  /** Remove a listener */
  offNotification(listener: NotificationListener): void {
    this.listeners.delete(listener);
  }

  /** Send a notification with full options */
  notify(
    level: NotificationLevel,
    title: string,
    message: string,
    options?: {
      actions?: NotificationAction[];
      autoDismissMs?: number;
    }
  ): Notification {
    const notification: Notification = {
      id: `notif-${++NotificationCenter.idCounter}`,
      level,
      title,
      message,
      timestamp: Date.now(),
      read: false,
      actions: options?.actions,
      autoDismissMs: options?.autoDismissMs,
    };

    this.notifications.push(notification);
    this.trimNotifications();
    this.emit(notification);
    return notification;
  }

  /** Shorthand: info notification */
  info(title: string, message: string): Notification {
    return this.notify('info', title, message);
  }

  /** Shorthand: success notification with 5s auto-dismiss */
  success(title: string, message: string): Notification {
    return this.notify('success', title, message, { autoDismissMs: 5000 });
  }

  /** Shorthand: warning notification with 10s auto-dismiss */
  warning(title: string, message: string): Notification {
    return this.notify('warning', title, message, { autoDismissMs: 10000 });
  }

  /** Shorthand: error notification (no auto-dismiss) */
  error(title: string, message: string): Notification {
    return this.notify('error', title, message);
  }

  /** Mark a notification as read by its id */
  markAsRead(id: string): boolean {
    const notif = this.notifications.find((n) => n.id === id);
    if (!notif) return false;
    notif.read = true;
    return true;
  }

  /** Mark all notifications as read */
  markAllAsRead(): void {
    for (const notif of this.notifications) {
      notif.read = true;
    }
  }

  /** Get unread notification count */
  get unreadCount(): number {
    return this.notifications.filter((n) => !n.read).length;
  }

  /** Get a copy of all notifications */
  getAll(): Notification[] {
    return [...this.notifications];
  }

  /** Get the most recent N notifications */
  getRecent(count: number = 10): Notification[] {
    return this.notifications.slice(-count);
  }

  /** Get notifications filtered by level */
  getByLevel(level: NotificationLevel): Notification[] {
    return this.notifications.filter((n) => n.level === level);
  }

  /** Clear all notifications */
  clear(): void {
    this.notifications.length = 0;
  }

  /** Dispose the notification center, removing all listeners and notifications */
  dispose(): void {
    this.listeners.clear();
    this.notifications.length = 0;
  }

  private emit(notification: Notification): void {
    for (const listener of this.listeners) {
      try {
        listener(notification);
      } catch (err) {
        logger.warn('NotificationCenter listener threw', {
          error: extractErrorMessage(err),
        });
      }
    }
  }

  private trimNotifications(): void {
    while (this.notifications.length > this.maxNotifications) {
      this.notifications.shift();
    }
  }
}
