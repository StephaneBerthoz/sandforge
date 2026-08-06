import type { BaseMessage, SyncHistoryEntry } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse, sendHandlerError } from './HandlerTypes.js';
import {
  validatePayload,
  executionAbortPayloadSchema,
  executionStatusPayloadSchema,
  executionManualRetryPayloadSchema,
} from '../validatePayload.js';
import type { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import type { SyncHistoryStore } from '../../modules/sync/SyncHistoryStore.js';
import type { SyncOpsHandler } from './SyncOpsHandler.js';

/** Message types handled by ExecutionHandler. */
const EXECUTION_TYPES = new Set([
  'execution:abort',
  'execution:status',
  'execution:list',
  'execution:manual-retry',
]);

/**
 * Domain handler for execution lifecycle messages.
 *
 * Routes execution:abort, execution:status, and execution:list messages
 * to the BackgroundOperationRegistry for operation control and introspection.
 */
export class ExecutionHandler implements DomainHandler {
  /** @param deps - Injected handler dependencies. */
  /** @param registry - Background operation registry for tracking operations. */
  /** @param syncHistoryStore - Sync execution history (replay source for manual retry). */
  /** @param syncOps - Sync handler owning the rerun execution engine. */
  constructor(
    private readonly deps: HandlerDeps,
    private readonly registry: BackgroundOperationRegistry,
    private readonly syncHistoryStore?: SyncHistoryStore,
    private readonly syncOps?: SyncOpsHandler,
  ) {}

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!EXECUTION_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'execution:abort':
        await this.handleAbort(msg);
        return true;
      case 'execution:status':
        await this.handleStatus(msg);
        return true;
      case 'execution:list':
        await this.handleList(msg);
        return true;
      case 'execution:manual-retry':
        await this.handleManualRetry(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * Handle a manual retry request from the ErrorRecoveryPanel.
   *
   * Sync executions are replayable: their config snapshot is persisted in
   * {@link SyncHistoryStore} (written by SyncExecutionLogger on every completed
   * run). When the failed execution is found there, it is relaunched through
   * {@link SyncOpsHandler.rerunFromSnapshot} — same guards as `sync:history:rerun`
   * (Zod re-validation, ProductionGuard) and the usual `operation:*` lifecycle
   * events. Every other module keeps the honest `canRetry: false` answer:
   * its configuration was never persisted for replay.
   *
   * Both outcomes answer on the exact channel the webview consumes —
   * `execution:retry-status` — so the panel leaves its pending state.
   */
  private async handleManualRetry(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(
      executionManualRetryPayloadSchema,
      msg,
      'execution:error',
      this.deps,
    );
    if (!parsed) return;
    const payload = parsed;
    const operation = this.registry.get(payload.executionId);

    const replayEntry = this.findReplayableSyncEntry(payload.executionId, operation?.module);
    if (replayEntry && this.syncOps) {
      // Acknowledge before relaunching: the retry-status row is replaced
      // (useRetryManager merges on executionId+objectName), which disables the
      // retry button and clears the stale error. `canAbort: false` is honest —
      // the rerun gets its own operation id (msg.id), so the panel's abort
      // button (bound to the old executionId) cannot reach it.
      const response = buildResponse(this.deps, msg, 'execution:retry-status', {
        executionId: payload.executionId,
        objectName: payload.objectName,
        attemptNumber: 1,
        maxAttempts: 1,
        nextRetryAt: null,
        lastError: '',
        canRetry: false,
        canAbort: false,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(
        `[TX] ${response.type} id=${response.id} (replay of history entry ${replayEntry.id})`,
      );
      await this.syncOps.rerunFromSnapshot(msg, replayEntry.configSnapshot);
      return;
    }

    const response = buildResponse(this.deps, msg, 'execution:retry-status', {
      executionId: payload.executionId,
      objectName: payload.objectName,
      attemptNumber: 0,
      maxAttempts: 0,
      nextRetryAt: null,
      lastError: this.nonReplayableReason(payload.executionId, operation?.module),
      canRetry: false,
      canAbort: operation?.status === 'running',
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id} (not replayable)`);
  }

  /**
   * Locate the failed sync execution to replay for a manual retry.
   *
   * An entry is replayable when its status is not `'success'` (`'failure'` and
   * `'partial'` both carry failed objects). An exact `result.operationId` match
   * wins; otherwise — the orchestrator mints its own operation id, so exact
   * matches are rare — the most recent failed sync run is used, but only when
   * the registry still tracks the operation as a sync one. Foreign or unknown
   * modules stay honestly non-replayable.
   *
   * @param executionId - The failed execution id sent by the webview.
   * @param module - The operation module from the registry, when still tracked.
   * @returns The newest replayable history entry, or `undefined`.
   */
  private findReplayableSyncEntry(
    executionId: string,
    module: string | undefined,
  ): SyncHistoryEntry | undefined {
    if (!this.syncHistoryStore) return undefined;
    const failedEntries = this.syncHistoryStore
      .list()
      .filter((entry) => entry.result.status !== 'success');
    if (failedEntries.length === 0) return undefined;
    const exact = failedEntries.find((entry) => entry.result.operationId === executionId);
    if (exact) return exact;
    // list() is newest-first: failedEntries[0] is the latest failed sync run.
    if (module === 'sync') return failedEntries[0];
    return undefined;
  }

  /**
   * Honest explanation for a non-replayable manual retry, surfaced as the
   * retry-status `lastError` so the panel can display why nothing happened.
   */
  private nonReplayableReason(executionId: string, module: string | undefined): string {
    if (module === 'sync') {
      return `No failed sync execution found in history for ${executionId}. Manual retry is unavailable.`;
    }
    if (module !== undefined) {
      return 'Manual retry is not supported for this operation: its configuration was not persisted for replay.';
    }
    return `Operation not found: ${executionId}. Manual retry is unavailable.`;
  }

  /**
   * Abort a running background operation.
   *
   * Triggers the AbortController for the specified operation and sends
   * a response indicating success or failure.
   */
  private async handleAbort(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const parsed = validatePayload(
        executionAbortPayloadSchema,
        msg,
        'execution:error',
        this.deps,
      );
      if (!parsed) return;
      // NOTE: the current webview (useRetryManager) sends `executionId`; the
      // historical contract is `operationId`. Both are accepted by the schema.
      const operationId = parsed.operationId ?? parsed.executionId ?? '';

      if (!this.registry.has(operationId)) {
        const response = buildResponse(this.deps, msg, 'execution:abort:response', {
          success: false,
          error: `Operation not found: ${operationId}`,
        });
        this.deps.broker.postToWebview(response);
        this.deps.log(`[TX] ${response.type} id=${response.id} (not found)`);
        return;
      }

      this.registry.abort(operationId);
      const response = buildResponse(this.deps, msg, 'execution:abort:response', {
        success: true,
        operationId,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'execution:abort', 'execution:error', err);
    }
  }

  /**
   * Get the status of a specific background operation.
   *
   * Returns the ActiveOperation shape for the specified operation,
   * or an error if the operation is not found.
   */
  private async handleStatus(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const parsed = validatePayload(
        executionStatusPayloadSchema,
        msg,
        'execution:error',
        this.deps,
      );
      if (!parsed) return;
      const operationId = parsed.operationId;
      const operation = this.registry.get(operationId);

      if (!operation) {
        const response = buildResponse(this.deps, msg, 'execution:status:response', {
          found: false,
          error: `Operation not found: ${operationId}`,
        });
        this.deps.broker.postToWebview(response);
        this.deps.log(`[TX] ${response.type} id=${response.id} (not found)`);
        return;
      }

      const response = buildResponse(this.deps, msg, 'execution:status:response', {
        found: true,
        operation: {
          operationId: operation.operationId,
          module: operation.module,
          description: operation.description,
          status: operation.status,
          progressPercent: operation.progressPercent,
          startedAt: operation.startedAt,
          completedAt: operation.completedAt,
          resultSummary: operation.resultSummary,
        },
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'execution:status', 'execution:error', err);
    }
  }

  /**
   * List all active and recently completed background operations.
   *
   * Returns an array of ActiveOperation objects sorted by start time (newest first).
   */
  private async handleList(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const operations = this.registry.getActiveOperations();
      const response = buildResponse(this.deps, msg, 'execution:list:response', {
        operations,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ${response.type} id=${response.id}`);
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'execution:list', 'execution:error', err);
    }
  }
}
