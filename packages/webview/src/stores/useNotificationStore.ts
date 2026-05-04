import { create } from 'zustand';

/** Severity level for a notification */
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

/** Category for a notification */
export type NotificationCategory = 'sync' | 'seed' | 'monitor' | 'schedule' | 'system';

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
  /** Notification category. Defaults to 'system'. */
  category?: NotificationCategory;
  autoDismissMs?: number;
  actions?: NotificationAction[];
}

/** Input type for creating a new notification (auto-generated fields excluded) */
export type NotificationInput = Omit<Notification, 'id' | 'timestamp' | 'read'>;

/** State and actions for the notification system */
export interface NotificationState {
  notifications: Notification[];
  maxNotifications: number;
  filterLevel: NotificationLevel | 'all';
  filterCategory: NotificationCategory | 'all';
  searchQuery: string;
  addNotification: (notification: NotificationInput) => string;
  removeNotification: (id: string) => void;
  markRead: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
  unreadCount: () => number;
  setFilterLevel: (level: NotificationLevel | 'all') => void;
  setFilterCategory: (category: NotificationCategory | 'all') => void;
  setSearchQuery: (query: string) => void;
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
  filterLevel: 'all',
  filterCategory: 'all',
  searchQuery: '',

  addNotification(input: NotificationInput): string {
    const id = generateNotificationId();
    const notification: Notification = {
      ...input,
      id,
      timestamp: Date.now(),
      read: false,
      category: input.category ?? 'system',
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
      notifications: state.notifications.map((n) => (n.id === id ? { ...n, read: true } : n)),
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

  setFilterLevel(level: NotificationLevel | 'all'): void {
    set({ filterLevel: level });
  },

  setFilterCategory(category: NotificationCategory | 'all'): void {
    set({ filterCategory: category });
  },

  setSearchQuery(query: string): void {
    set({ searchQuery: query });
  },
}));

/** External selector for reactive unread count subscriptions */
export const selectUnreadCount = (state: NotificationState): number =>
  state.notifications.filter((n) => !n.read).length;

/** Selector that applies level, category, and search filters */
export const selectFilteredNotifications = (state: NotificationState): Notification[] => {
  let filtered = state.notifications;

  if (state.filterLevel !== 'all') {
    filtered = filtered.filter((n) => n.level === state.filterLevel);
  }

  if (state.filterCategory !== 'all') {
    filtered = filtered.filter((n) => (n.category ?? 'system') === state.filterCategory);
  }

  if (state.searchQuery.trim()) {
    const query = state.searchQuery.toLowerCase();
    filtered = filtered.filter(
      (n) => n.title.toLowerCase().includes(query) || n.message.toLowerCase().includes(query),
    );
  }

  return filtered;
};
