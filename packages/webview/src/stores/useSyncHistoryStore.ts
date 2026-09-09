import { create } from 'zustand';
import type { SyncHistoryEntry } from '@sandforge/shared';
import { sendBridgeMessage } from '../bridge/sendBridgeMessage';

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
 * The outcome is announced by whichever `useFileSave` instance is mounted:
 * `file:save:response` is correlated to this request, so a store-initiated
 * save reports through the normal channel rather than silently.
 *
 * @param data - The file content string.
 * @param filename - The suggested filename.
 * @param extension - Extension offered by the dialog filter, without the dot.
 */
function requestSave(data: string, filename: string, extension: string): void {
  sendBridgeMessage('file:save', {
    suggestedName: filename,
    content: data,
    extensions: [extension],
  });
}

/** Type guard for messages with a type field. */
function isTypedMessage(msg: unknown): msg is { type: string; payload?: Record<string, unknown> } {
  return (
    typeof msg === 'object' &&
    msg !== null &&
    'type' in msg &&
    typeof (msg as Record<string, unknown>).type === 'string'
  );
}

/** Zustand store for managing sync execution history. */
export const useSyncHistoryStore = create<SyncHistoryState>((set) => ({
  entries: [],
  selectedEntry: null,
  loading: false,
  error: null,

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
          requestSave(data, `sync-history.${ext}`, ext);
        }
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
