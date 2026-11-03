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
  'grappe',
]);

/**
 * Map the free-form `module` string sent by extension handlers
 * (SeedOpsHandler, SyncOpsHandler, ForgeHandler, DataOpsHandler,
 * AutomationHandler, FrozenDatasetHandler, GrappeHandler) to the store's
 * category union: the page a click on the operation opens. A Seed clone says
 * `clone`, and is Seed's: it collapsed to Automation with the unknown ids,
 * which was harmless while the field was never read.
 */
function toRecentOpType(module: string): RecentOp['type'] {
  if (module === 'clone') return 'seed';
  return KNOWN_MODULES.has(module) ? (module as RecentOp['type']) : 'automation';
}

/**
 * The words a run that ended with part of its work not done completes with:
 * a run's own, a pipeline's that carried on past a failed step, a Frozen
 * load's that the org refused part of, a rewind's that the org changed again
 * under its writes.
 */
const PARTIAL_STATUSES: ReadonlySet<unknown> = new Set([
  'partial',
  'completed_with_warnings',
  'completed-with-errors',
  'unstable',
]);

/**
 * The words a run that did not go through completes with: nothing written, or
 * a take, a rewind or an undo a gate held back, which completes `refused`.
 */
const FAILED_STATUSES: ReadonlySet<unknown> = new Set(['failure', 'refused']);

/**
 * The status an `operation:completed` result gives its operation.
 *
 * A completion is not always a success. A run that ends with a failure status
 * — nothing written, or refused — failed, however it ended. A run that was
 * stopped says so in one of two ways: `aborted: true` (a Forge discovery
 * cancelled or replaced, a snapshot cancelled) or a `cancelled` status (a
 * pipeline run). Both were listed as successes, and so was a run that wrote
 * part of what it was asked.
 */
function completedStatus(result: Record<string, unknown>): RecentOp['status'] {
  if (result['aborted'] === true || result['status'] === 'cancelled') return 'cancelled';
  if (FAILED_STATUSES.has(result['status'])) return 'failed';
  return PARTIAL_STATUSES.has(result['status']) ? 'partial' : 'success';
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
        status: completedStatus(msg.payload.result),
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
