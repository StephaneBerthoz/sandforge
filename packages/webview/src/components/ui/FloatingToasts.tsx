import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../theme';
import { useNotificationStore } from '../../stores/useNotificationStore';
import type { Notification } from '../../stores/useNotificationStore';

const MAX_VISIBLE_TOASTS = 3;

const levelStyles: Record<Notification['level'], string> = {
  info: 'border-l-[var(--vscode-notificationsInfoIcon-foreground,#75beff)]',
  success: 'border-l-[#10b981]',
  warning: 'border-l-[var(--vscode-notificationsWarningIcon-foreground,#cca700)]',
  error: 'border-l-[var(--vscode-notificationsErrorIcon-foreground,#f14c4c)]',
};

/** Floating toast notifications that auto-appear on new notifications. */
export const FloatingToasts: React.FC = () => {
  const { t } = useTranslation();
  const notifications = useNotificationStore((s) => s.notifications);
  const removeNotification = useNotificationStore((s) => s.removeNotification);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const visible = notifications.slice(0, MAX_VISIBLE_TOASTS);

  // Effect 1: Set up timers for new notifications + clean orphans
  useEffect(() => {
    for (const n of visible) {
      if (n.autoDismissMs && !timersRef.current.has(n.id)) {
        const timer = setTimeout(() => {
          removeNotification(n.id);
          timersRef.current.delete(n.id);
        }, n.autoDismissMs);
        timersRef.current.set(n.id, timer);
      }
    }
    // Clean up timers for notifications no longer visible
    const visibleIds = new Set(visible.map((n) => n.id));
    for (const [id, timer] of timersRef.current.entries()) {
      if (!visibleIds.has(id)) {
        clearTimeout(timer);
        timersRef.current.delete(id);
      }
    }
  }, [visible, removeNotification]);

  // Effect 2: Unmount-only cleanup
  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  return (
    <div
      className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 w-72 pointer-events-none"
      data-testid="floating-toasts"
      aria-live="polite"
      aria-atomic="true"
    >
      {visible.map((n) => (
        <div
          key={n.id}
          role="status"
          className={cn(
            'pointer-events-auto rounded px-3 py-2 border-l-4 shadow-lg',
            'bg-[var(--vscode-notifications-background,#252526)]',
            'text-[var(--vscode-notifications-foreground,#cccccc)]',
            'border border-[var(--vscode-notifications-border,#3c3c3c)]',
            levelStyles[n.level],
          )}
          data-testid={`floating-toast-${n.id}`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold truncate">{n.title}</p>
              <p className="text-xs opacity-80 mt-0.5 line-clamp-2">{n.message}</p>
              {n.actions && n.actions.length > 0 && (
                <div className="flex gap-2 mt-1.5">
                  {n.actions.map((action) => (
                    <button
                      key={action.command}
                      className="text-[10px] font-semibold px-2 py-0.5 rounded bg-[var(--vscode-button-background,#0e639c)] text-[var(--vscode-button-foreground,#ffffff)] hover:opacity-90 transition-opacity"
                      onClick={() => {
                        action.onAction?.();
                        removeNotification(n.id);
                      }}
                      data-testid={`toast-action-${action.command}`}
                    >
                      {action.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              className="text-xs opacity-60 hover:opacity-100 shrink-0"
              onClick={() => removeNotification(n.id)}
              aria-label={t('common.dismiss', 'Dismiss')}
            >
              {'\u2715'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
