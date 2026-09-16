import { useMessageListener } from '../../hooks/useMessageBus';
import { useSyncHistoryStore } from '../../stores/useSyncHistoryStore';

/**
 * Subscribe the sync history store to the channels the extension answers on:
 * the list, detail and export responses, the history error channel, and the
 * answer of the save dialog an export opens.
 *
 * These listeners belong to the page rather than to `SyncHistoryPanel`. An
 * export's content and its save answer come back long after the request, and
 * with the panel as subscriber they were dropped as soon as the user left the
 * History tab: the file was written and nothing said where. The page stays
 * mounted for as long as Sync is open, so the answer always finds a listener.
 */
export function useSyncHistoryMessages(): void {
  const handleMessage = useSyncHistoryStore((s) => s.handleMessage);

  useMessageListener('sync:history:list:response', handleMessage);
  useMessageListener('sync:history:detail:response', handleMessage);
  useMessageListener('sync:history:export:response', handleMessage);
  useMessageListener('sync:history:error', handleMessage);
  useMessageListener('file:save:response', handleMessage);
}
