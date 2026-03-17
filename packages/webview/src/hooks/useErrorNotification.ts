import { useEffect } from 'react';
import { useNotificationStore } from '../stores/useNotificationStore';

/**
 * Watch a bridge mutation error and auto-create an error notification.
 *
 * When `error` transitions to a truthy string value, a new error notification
 * is added to the global notification store.
 *
 * @param error - The error string to watch (typically from a bridge mutation).
 * @param title - The notification title (e.g. `t('seed.title')`).
 * @param autoDismissMs - Auto-dismiss delay in milliseconds (default 5000).
 */
export function useErrorNotification(
  error: string | null | undefined,
  title: string,
  autoDismissMs = 5000,
): void {
  const addNotification = useNotificationStore((s) => s.addNotification);

  useEffect(() => {
    if (error) {
      addNotification({ level: 'error', title, message: error, autoDismissMs });
    }
  }, [error, title, autoDismissMs, addNotification]);
}
