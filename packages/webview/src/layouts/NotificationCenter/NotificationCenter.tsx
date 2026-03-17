import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import { useNotificationStore, selectUnreadCount } from '../../stores/useNotificationStore';
import { Toast } from '../../components/ui/Toast';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';

/** NotificationCenter component props. */
export interface NotificationCenterProps {
  open: boolean;
  onClose: () => void;
}

/** Slide-out notification center panel. */
export const NotificationCenter: React.FC<NotificationCenterProps> = ({ open, onClose }) => {
  const { t } = useTranslation();
  const notifications = useNotificationStore((s) => s.notifications);
  const removeNotification = useNotificationStore((s) => s.removeNotification);
  const markAllRead = useNotificationStore((s) => s.markAllRead);
  const clearAll = useNotificationStore((s) => s.clearAll);
  const unreadCount = useNotificationStore(selectUnreadCount);

  if (!open) return null;

  return (
    <div
      className={cn(
        'absolute top-0 right-0 h-full w-80 z-40',
        'glass-overlay',
        'border-l border-[var(--vscode-panel-border,#3c3c3c)]',
        'shadow-xl flex flex-col',
      )}
      role="region"
      aria-label={t('notifications.title', 'Notifications')}
      data-testid="notification-center"
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--vscode-panel-border,#3c3c3c)]">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-[var(--vscode-editor-foreground,#d4d4d4)]">
            {t('notifications.title')}
          </span>
          {unreadCount > 0 && <Badge variant="info">{unreadCount}</Badge>}
        </div>
        <button
          className="text-xs text-[var(--vscode-descriptionForeground,#868686)] hover:text-[var(--vscode-editor-foreground,#d4d4d4)]"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
        >
          \u2715
        </button>
      </div>

      {notifications.length > 0 && (
        <div className="flex gap-2 px-3 py-1.5 border-b border-[var(--vscode-panel-border,#3c3c3c)]">
          <Button variant="ghost" size="sm" onClick={markAllRead}>
            {t('notifications.markAllRead')}
          </Button>
          <Button variant="ghost" size="sm" onClick={clearAll}>
            {t('notifications.clearAll')}
          </Button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
        {notifications.length === 0 ? (
          <p className="text-xs text-center text-[var(--vscode-descriptionForeground,#868686)] py-8">
            {t('notifications.noNotifications')}
          </p>
        ) : (
          notifications.map((n) => (
            <Toast
              key={n.id}
              id={n.id}
              level={n.level}
              title={n.title}
              message={n.message}
              onDismiss={removeNotification}
            />
          ))
        )}
      </div>
    </div>
  );
};
