import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { cn } from '../../theme';
import {
  useNotificationStore,
  selectUnreadCount,
  selectFilteredNotifications,
} from '../../stores/useNotificationStore';
import type { NotificationLevel, NotificationCategory } from '../../stores/useNotificationStore';
import { Toast } from '../../components/ui/Toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';

/** NotificationCenter component props. */
export interface NotificationCenterProps {
  open: boolean;
  onClose: () => void;
}

/** Level filter tabs configuration. */
const LEVEL_TABS: Array<{ value: NotificationLevel | 'all'; labelKey: string; fallback: string }> =
  [
    { value: 'all', labelKey: 'notifications.filterAll', fallback: 'All' },
    { value: 'info', labelKey: 'notifications.filterInfo', fallback: 'Info' },
    { value: 'success', labelKey: 'notifications.filterSuccess', fallback: 'Success' },
    { value: 'warning', labelKey: 'notifications.filterWarning', fallback: 'Warning' },
    { value: 'error', labelKey: 'notifications.filterError', fallback: 'Error' },
  ];

/** Category filter options. */
const CATEGORY_OPTIONS: Array<{
  value: NotificationCategory | 'all';
  labelKey: string;
  fallback: string;
}> = [
  { value: 'all', labelKey: 'notifications.filterAll', fallback: 'All' },
  { value: 'sync', labelKey: 'notifications.categorySync', fallback: 'Sync' },
  { value: 'seed', labelKey: 'notifications.categorySeed', fallback: 'Seed' },
  { value: 'monitor', labelKey: 'notifications.categoryMonitor', fallback: 'Monitor' },
  { value: 'schedule', labelKey: 'notifications.categorySchedule', fallback: 'Schedule' },
  { value: 'system', labelKey: 'notifications.categorySystem', fallback: 'System' },
];

/** Checks if a timestamp is from today. */
function isToday(timestamp: number): boolean {
  const now = new Date();
  const date = new Date(timestamp);
  return (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  );
}

/** Slide-out notification center panel. */
export const NotificationCenter: React.FC<NotificationCenterProps> = ({ open, onClose }) => {
  const { t } = useTranslation();
  const notifications = useNotificationStore((s) => s.notifications);
  const filteredNotifications = useNotificationStore(selectFilteredNotifications);
  const removeNotification = useNotificationStore((s) => s.removeNotification);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const clearAll = useNotificationStore((s) => s.clearAll);
  const unreadCount = useNotificationStore(selectUnreadCount);
  const filterLevel = useNotificationStore((s) => s.filterLevel);
  const filterCategory = useNotificationStore((s) => s.filterCategory);
  const searchQuery = useNotificationStore((s) => s.searchQuery);
  const setFilterLevel = useNotificationStore((s) => s.setFilterLevel);
  const setFilterCategory = useNotificationStore((s) => s.setFilterCategory);
  const setSearchQuery = useNotificationStore((s) => s.setSearchQuery);

  const { todayNotifications, earlierNotifications } = useMemo(() => {
    const today: typeof filteredNotifications = [];
    const earlier: typeof filteredNotifications = [];
    for (const n of filteredNotifications) {
      if (isToday(n.timestamp)) {
        today.push(n);
      } else {
        earlier.push(n);
      }
    }
    return { todayNotifications: today, earlierNotifications: earlier };
  }, [filteredNotifications]);

  if (!open) return null;

  return (
    <div
      className={cn(
        'absolute top-0 right-0 h-full w-80 z-40',
        'glass-overlay',
        'border-l border-[var(--sf-border)]',
        'shadow-xl flex flex-col',
      )}
      role="region"
      aria-label={t('notifications.title', 'Notifications')}
      data-testid="notification-center"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--sf-border)]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-text-primary">
            {t('notifications.title')}
          </span>
          {unreadCount > 0 && <Badge variant="info">{unreadCount}</Badge>}
        </div>
        <button
          className="text-xs text-text-secondary hover:text-text-primary"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
        >
          {'\u2715'}
        </button>
      </div>

      {/* Mark all / Clear all */}
      {notifications.length > 0 && (
        <div className="flex gap-2 px-3 py-1.5 border-b border-[var(--sf-border)]">
          <Button variant="ghost" size="sm" onClick={markAllRead}>
            {t('notifications.markAllRead')}
          </Button>
          <Button variant="ghost" size="sm" onClick={clearAll}>
            {t('notifications.clearAll')}
          </Button>
        </div>
      )}

      {/* Level filter tabs */}
      <div
        className="flex gap-1 px-3 py-1.5 border-b border-[var(--sf-border)]"
        data-testid="notification-level-filters"
        role="tablist"
        aria-label={t('common.filter', 'Filter')}
      >
        {LEVEL_TABS.map((tab) => (
          <button
            key={tab.value}
            role="tab"
            aria-selected={filterLevel === tab.value}
            className={cn(
              'text-[10px] px-2 py-0.5 rounded-full transition-colors',
              filterLevel === tab.value
                ? 'bg-[var(--sf-accent,#E8A838)] text-[var(--sf-bg-card,#12121A)] font-semibold'
                : 'text-text-secondary hover:bg-[var(--sf-bg-hover)]',
            )}
            onClick={() => setFilterLevel(tab.value)}
            data-testid={`filter-level-${tab.value}`}
          >
            {t(tab.labelKey, tab.fallback)}
          </button>
        ))}
      </div>

      {/* Category filter */}
      <div
        className="flex gap-1 px-3 py-1.5 border-b border-[var(--sf-border)] flex-wrap"
        data-testid="notification-category-filters"
      >
        {CATEGORY_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            className={cn(
              'text-[10px] px-2 py-0.5 rounded-full transition-colors',
              filterCategory === opt.value
                ? 'bg-[var(--sf-accent,#E8A838)] text-[var(--sf-bg-card,#12121A)] font-semibold'
                : 'text-text-secondary hover:bg-[var(--sf-bg-hover)]',
            )}
            onClick={() => setFilterCategory(opt.value)}
            data-testid={`filter-category-${opt.value}`}
          >
            {t(opt.labelKey, opt.fallback)}
          </button>
        ))}
      </div>

      {/* Search */}
      <div className="px-3 py-1.5 border-b border-[var(--sf-border)]">
        <div className="flex items-center gap-1.5 rounded bg-[var(--sf-bg-input,#262635)] px-2 py-1">
          <Search className="w-3 h-3 text-text-secondary shrink-0" />
          <input
            type="text"
            className="flex-1 bg-transparent text-xs text-text-primary outline-none placeholder:text-text-secondary"
            placeholder={t('notifications.searchPlaceholder', 'Search notifications...')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            data-testid="notification-search"
          />
        </div>
      </div>

      {/* Notification list */}
      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-1">
        {filteredNotifications.length === 0 ? (
          <p
            className="text-xs text-center text-text-secondary py-8"
            data-testid="notification-empty-state"
          >
            {notifications.length === 0
              ? t('notifications.noNotifications')
              : t('notifications.noMatching', 'No matching notifications')}
          </p>
        ) : (
          <>
            {/* Today group */}
            {todayNotifications.length > 0 && (
              <>
                <div
                  className="text-[10px] font-semibold text-text-secondary px-1 py-1 uppercase tracking-wider"
                  data-testid="date-group-today"
                >
                  {t('notifications.today', 'Today')}
                </div>
                {todayNotifications.map((n) => (
                  <Toast
                    key={n.id}
                    id={n.id}
                    level={n.level}
                    title={n.title}
                    message={n.message}
                    onDismiss={removeNotification}
                  />
                ))}
              </>
            )}

            {/* Earlier group */}
            {earlierNotifications.length > 0 && (
              <>
                <div
                  className="text-[10px] font-semibold text-text-secondary px-1 py-1 uppercase tracking-wider"
                  data-testid="date-group-earlier"
                >
                  {t('notifications.earlier', 'Earlier')}
                </div>
                {earlierNotifications.map((n) => (
                  <Toast
                    key={n.id}
                    id={n.id}
                    level={n.level}
                    title={n.title}
                    message={n.message}
                    onDismiss={removeNotification}
                  />
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};
