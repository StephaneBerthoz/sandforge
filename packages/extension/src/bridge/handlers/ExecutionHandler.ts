import type { BaseMessage } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse, sendHandlerError } from './HandlerTypes.js';
import {
  validatePayload,
  executionAbortPayloadSchema,
  executionStatusPayloadSchema,
  executionManualRetryPayloadSchema,
} from '../validatePayload.js';
import type { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';

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
  constructor(
    private readonly deps: HandlerDeps,
    private readonly registry: BackgroundOperationRegistry,
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
        this.handleManualRetry(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * Handle a manual retry request from the ErrorRecoveryPanel.
   *
   * Honest minimal behaviour: the extension does not persist failed-operation
   * configs for replay (only sync executions are replayable, via
   * `sync:history:rerun`), so a manual retry cannot actually re-run the
   * operation. Instead of dropping the message silently, answer on the exact
   * channel the webview consumes — `execution:retry-status` — with
   * `canRetry: false` so the panel disables the retry button and surfaces the
   * "retries exhausted" state instead of waiting forever.
   */
  private handleManualRetry(msg: BaseMessage): void {
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
    const response = buildResponse(this.deps, msg, 'execution:retry-status', {
      executionId: payload.executionId,
      objectName: payload.objectName,
      attemptNumber: 0,
      maxAttempts: 0,
      nextRetryAt: null,
      lastError: operation
        ? 'Manual retry is not supported for this operation: its configuration was not persisted for replay.'
        : `Operation not found: ${payload.executionId}. Manual retry is unavailable.`,
      canRetry: false,
      canAbort: operation?.status === 'running',
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ${response.type} id=${response.id} (not replayable)`);
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
