import { create } from 'zustand';
import type { SyncHistoryEntry } from '@sandforge/shared';
import { sendBridgeMessage } from '../bridge/sendBridgeMessage';
import i18n from '../i18n';
import { useNotificationStore } from './useNotificationStore';

/** Export format for history data. */
export type SyncExportFormat = 'csv' | 'json';

/** State and actions for the sync history panel. */
export interface SyncHistoryState {
  /** List of history entries, newest first. */
  entries: SyncHistoryEntry[];
  /** Currently selected entry for the detail view. */
  selectedEntry: SyncHistoryEntry | null;
  /** Whether a fetch operation is in progress. */
  loading: boolean;
  /** Last error message, if any. */
  error: string | null;
  /** Id of the `file:save` request whose answer has not arrived yet, if any. */
  pendingSaveId: string | null;
  /** Fetch the full list of sync history entries. */
  fetchHistory: () => void;
  /** Fetch details for a single history entry. */
  fetchDetail: (entryId: string) => void;
  /** Clear the currently selected entry. */
  clearSelection: () => void;
  /** Re-run a sync from a history entry's config snapshot. */
  rerun: (entryId: string) => void;
  /** Export history data as CSV or JSON. */
  exportHistory: (format: SyncExportFormat, entryIds?: string[]) => void;
  /** Handle incoming messages from the extension host. */
  handleMessage: (message: unknown) => void;
}

/**
 * Ask the extension host to save an export.
 *
 * This used to build a Blob and click a detached anchor from module scope. A
 * webview is sandboxed without `allow-downloads`, so that frequently wrote
 * nothing, and a store cannot use the `useFileSave` hook the components use —
 * but it can send the same message, through the sender it already uses.
 *
 * @param data - The file content string.
 * @param filename - The suggested filename.
 * @param extension - Extension offered by the dialog filter, without the dot.
 * @returns The id of the request; the host's `file:save:response` carries it.
 */
function requestSave(data: string, filename: string, extension: string): string {
  return sendBridgeMessage('file:save', {
    suggestedName: filename,
    content: data,
    extensions: [extension],
  });
}

/**
 * Say what became of a save, the way `useFileSave` does for components: where
 * the file went, or why it was not written. A dismissed dialog is not news.
 *
 * This store used to rely on "whichever `useFileSave` is mounted" to announce
 * it, but a hook only takes answers to its own requests, so a history export
 * ended in silence — saved, refused or never written alike.
 */
function announceSave(outcome: Record<string, unknown> | undefined): void {
  const { addNotification } = useNotificationStore.getState();
  if (outcome?.status === 'saved' && typeof outcome.path === 'string') {
    addNotification({
      level: 'success',
      title: i18n.t('common.export'),
      message: i18n.t('common.exportSaved', { path: outcome.path }),
      autoDismissMs: 4000,
    });
    return;
  }
  if (outcome?.status === 'error') {
    addNotification({
      level: 'error',
      title: i18n.t('common.export'),
      message: typeof outcome.message === 'string' ? outcome.message : i18n.t('common.error'),
      autoDismissMs: 5000,
    });
  }
}

/** Type guard for messages with a type field. */
function isTypedMessage(
  msg: unknown,
): msg is { type: string; correlationId?: string; payload?: Record<string, unknown> } {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    typeof (msg as Record<string, unknown>).type === 'string'
  );
}

/** Zustand store for managing sync execution history. */
export const useSyncHistoryStore = create<SyncHistoryState>((set, get) => ({
  entries: [],
  selectedEntry: null,
  loading: false,
  error: null,
  pendingSaveId: null,

  fetchHistory(): void {
    set({ loading: true, error: null });
    sendBridgeMessage('sync:history:list');
  },

  fetchDetail(entryId: string): void {
    set({ loading: true, error: null });
    sendBridgeMessage('sync:history:detail', { entryId });
  },

  clearSelection(): void {
    set({ selectedEntry: null });
  },

  rerun(entryId: string): void {
    sendBridgeMessage('sync:history:rerun', { entryId });
  },

  exportHistory(format: SyncExportFormat, entryIds?: string[]): void {
    sendBridgeMessage('sync:history:export', { format, entryIds });
  },

  handleMessage(message: unknown): void {
    if (!isTypedMessage(message)) return;

    const payload = message.payload as Record<string, unknown> | undefined;

    switch (message.type) {
      case 'sync:history:list:response': {
        const entries = (payload?.entries ?? []) as SyncHistoryEntry[];
        set({ entries, loading: false, error: null });
        break;
      }
      case 'sync:history:detail:response': {
        const entry = (payload?.entry ?? null) as SyncHistoryEntry | null;
        set({ selectedEntry: entry, loading: false, error: null });
        break;
      }
      case 'sync:history:export:response': {
        const data = payload?.data as string | undefined;
        const format = payload?.format as SyncExportFormat | undefined;
        if (data && format) {
          const ext = format === 'csv' ? 'csv' : 'json';
          set({ pendingSaveId: requestSave(data, `sync-history.${ext}`, ext) });
        }
        break;
      }
      case 'file:save:response': {
        // Every save's answer reaches every listener: only the one answering
        // this store's own request is announced here, and only once.
        const pendingSaveId = get().pendingSaveId;
        if (pendingSaveId === null || message.correlationId !== pendingSaveId) break;
        set({ pendingSaveId: null });
        announceSave(payload);
        break;
      }
      case 'sync:history:error': {
        const errorMsg = (payload?.message ?? 'Unknown error') as string;
        set({ loading: false, error: errorMsg });
        break;
      }
      default:
        break;
    }
  },
}));
