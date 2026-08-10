import { useCallback } from 'react';
import type { OperationCompleted, OperationFailed, OperationStarted } from '@sandforge/shared';
import { useMessageListener } from './useMessageBus';
import { useRecentOpsStore } from '../stores/useRecentOpsStore';
import type { RecentOp } from '../stores/useRecentOpsStore';

/** Extension module ids that map 1:1 onto a recent-op category. */
const KNOWN_MODULES: ReadonlySet<string> = new Set([
  'forge',
  'seed',
  'sync',
  'compare',
  'dataops',
  'automation',
  'frozen',
]);

/**
 * Map the free-form `module` string sent by extension handlers
 * (SeedOpsHandler, SyncOpsHandler, ForgeHandler, DataOpsHandler,
 * AutomationHandler, FrozenDatasetHandler) to the store's category union.
 * Unknown/future module ids collapse to 'automation': the field is a coarse
 * tag that is never rendered — the description carries the visible label.
 */
function toRecentOpType(module: string): RecentOp['type'] {
  return KNOWN_MODULES.has(module) ? (module as RecentOp['type']) : 'automation';
}

/** Extract a record count from the loose operation:completed result bag. */
function extractRecordCount(result: Record<string, unknown>): number | undefined {
  for (const key of ['totalRecords', 'totalProcessed', 'totalSuccess', 'totalRestored']) {
    const value = result[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

/**
 * Feeds {@link useRecentOpsStore} from the real operation lifecycle messages
 * (`operation:started` / `operation:completed` / `operation:failed`)
 * broadcast by the extension through the shared message dispatcher.
 *
 * Until now the store had consumers (Sidebar, StatusFooter, HomePage,
 * SidePanel) but no producer, so every "Running / Last operation" block was
 * permanently empty. Mount once per webview root: BridgeProvider (full app)
 * and SidePanel (standalone sidebar view) both call it.
 */
export function useRecentOpsFeed(): void {
  useMessageListener<OperationStarted>(
    'operation:started',
    useCallback((msg) => {
      const { operationId, module, description } = msg.payload;
      const store = useRecentOpsStore.getState();
      const op: RecentOp = {
        id: operationId,
        type: toRecentOpType(module),
        label: description,
        status: 'running',
        timestamp: typeof msg.timestamp === 'number' ? msg.timestamp : Date.now(),
      };
      // Upsert: a retried operation re-sends operation:started with the same
      // id — update it in place instead of prepending a duplicate row.
      if (store.ops.some((o) => o.id === operationId)) {
        store.updateOp(operationId, op);
      } else {
        store.addOp(op);
      }
    }, []),
  );

  useMessageListener<OperationCompleted>(
    'operation:completed',
    useCallback((msg) => {
      const recordCount = extractRecordCount(msg.payload.result);
      useRecentOpsStore.getState().updateOp(msg.payload.operationId, {
        status: 'success',
        timestamp: Date.now(),
        ...(recordCount !== undefined ? { recordCount } : {}),
      });
    }, []),
  );

  useMessageListener<OperationFailed>(
    'operation:failed',
    useCallback((msg) => {
      useRecentOpsStore.getState().updateOp(msg.payload.operationId, {
        status: 'failed',
        timestamp: Date.now(),
      });
    }, []),
  );
}
