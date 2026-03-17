import { create } from 'zustand';

/** Severity level for a notification */
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

/** Action button attached to a notification */
export interface NotificationAction {
  label: string;
  command: string;
  /** Optional callback invoked when the action is triggered (for undo actions). */
  onAction?: () => void;
}

/** A single notification entry */
export interface Notification {
  id: string;
  level: NotificationLevel;
  title: string;
  message: string;
  timestamp: number;
  read: boolean;
  autoDismissMs?: number;
  actions?: NotificationAction[];
}

/** Input type for creating a new notification (auto-generated fields excluded) */
export type NotificationInput = Omit<Notification, 'id' | 'timestamp' | 'read'>;

/** State and actions for the notification system */
export interface NotificationState {
  notifications: Notification[];
  maxNotifications: number;
  addNotification: (notification: NotificationInput) => string;
  removeNotification: (id: string) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
  unreadCount: () => number;
}

let notificationCounter = 0;

/** Generates a sequential notification ID */
function generateNotificationId(): string {
  return `sf-notif-${++notificationCounter}`;
}

/** Resets the notification counter (for testing purposes only) */
export function resetNotificationCounter(): void {
  notificationCounter = 0;
}

/** Zustand store for managing in-app notifications */
export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  maxNotifications: 50,

  addNotification(input: NotificationInput): string {
    const id = generateNotificationId();
    const notification: Notification = {
      ...input,
      id,
      timestamp: Date.now(),
      read: false,
    };

    set((state) => {
      const updated = [notification, ...state.notifications];
      if (updated.length > state.maxNotifications) {
        return { notifications: updated.slice(0, state.maxNotifications) };
      }
      return { notifications: updated };
    });

    return id;
  },

  removeNotification(id: string): void {
    set((state) => ({
      notifications: state.notifications.filter((n) => n.id !== id),
    }));
  },

  markRead(id: string): void {
    set((state) => ({
      notifications: state.notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n,
      ),
    }));
  },

  markAllRead(): void {
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, read: true })),
    }));
  },

  clearAll(): void {
    set({ notifications: [] });
  },

  unreadCount(): number {
    return get().notifications.filter((n) => !n.read).length;
  },
}));

/** External selector for reactive unread count subscriptions */
export const selectUnreadCount = (state: NotificationState): number =>
  state.notifications.filter((n) => !n.read).length;
