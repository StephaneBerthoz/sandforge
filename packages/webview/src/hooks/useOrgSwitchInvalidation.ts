import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useOrgStore } from '../stores/useOrgStore';
import { useNotificationStore } from '../stores/useNotificationStore';
import { useSendMessage } from './useMessageBus';
import { buildMessage } from '../bridge/messageHelpers';

/**
 * Hook that sends a `cache:invalidate-all` message to the extension
 * whenever the selected org changes, ensuring stale data from the
 * previous org does not leak into the new org context.
 *
 * Also shows a brief "Refreshing..." notification to inform the user.
 */
export function useOrgSwitchInvalidation(): void {
  const { t } = useTranslation();
  const sendMessage = useSendMessage();
  const addNotification = useNotificationStore((s) => s.addNotification);
  const selectedOrgId = useOrgStore((s) => s.selectedOrgId);
  const prevOrgIdRef = useRef<string | null>(null);

  useEffect(() => {
    const prevOrgId = prevOrgIdRef.current;
    prevOrgIdRef.current = selectedOrgId;

    // Only invalidate when switching away from a previously selected org
    if (prevOrgId !== null && prevOrgId !== undefined && selectedOrgId !== prevOrgId) {
      sendMessage(buildMessage('cache:invalidate-all'));

      addNotification({
        level: 'info',
        title: t('common.refresh', 'Refresh'),
        message: t('common.loading', 'Loading...'),
        autoDismissMs: 2000,
      });
    }
  }, [selectedOrgId, sendMessage, addNotification, t]);
}
