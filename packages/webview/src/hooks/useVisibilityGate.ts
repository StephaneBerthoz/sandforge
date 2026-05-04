import { useEffect } from 'react';
import { useSendMessage } from './useMessageBus';

/**
 * Plan 03-07 audit M1 — listen to `document.visibilitychange` and post
 * `monitor:visibility` so the extension can pause polling when the panel
 * isn't visible. Posts the initial state on mount.
 */
export function useVisibilityGate(): void {
  const sendMessage = useSendMessage();
  useEffect(() => {
    const post = (): void => {
      sendMessage({
        id: `visibility-${Date.now()}`,
        type: 'monitor:visibility',
        timestamp: Date.now(),
        payload: { hidden: document.hidden },
      } as Parameters<typeof sendMessage>[0]);
    };
    document.addEventListener('visibilitychange', post);
    post();
    return () => {
      document.removeEventListener('visibilitychange', post);
    };
  }, [sendMessage]);
}
