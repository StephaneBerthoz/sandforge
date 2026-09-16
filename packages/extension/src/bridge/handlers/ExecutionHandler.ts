import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import { buildResponse, sendHandlerError } from './HandlerTypes.js';
import { validatePayload, executionAbortPayloadSchema } from '../validatePayload.js';
import type { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';

/** Message types handled by ExecutionHandler. */
const EXECUTION_TYPES = new Set(['execution:abort']);

/**
 * Domain handler for execution lifecycle messages.
 *
 * Routes execution:abort to the BackgroundOperationRegistry, which holds the
 * AbortController of every running background operation. The registry lives
 * in memory only, so an operation does not outlive the extension host.
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
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!EXECUTION_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'execution:abort':
        await this.handleAbort(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * Abort a running background operation.
   *
   * Triggers the AbortController for the specified operation and sends
   * a response indicating success or failure.
   */
  private async handleAbort(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    try {
      const parsed = validatePayload(
        executionAbortPayloadSchema,
        msg,
        'execution:error',
        this.deps,
      );
      if (!parsed) return;
      // NOTE: the contract is `operationId`; `executionId` is the alias the
      // retry surface used. Both stay accepted by the schema.
      const operationId = parsed.operationId ?? parsed.executionId ?? '';

      const operation = this.registry.get(operationId);
      if (!operation) {
        const response = buildResponse(this.deps, msg, 'execution:abort:response', {
          success: false,
          error: `Operation not found: ${operationId}`,
        });
        this.deps.broker.postToWebview(response);
        this.deps.log(`[TX] ${response.type} id=${response.id} (not found)`);
        return;
      }

      // The registry keeps finished runs for the Live Ops list, so a Cancel
      // clicked as a run ends still finds it. Answering success there told the
      // user a run that had already completed was stopped.
      if (operation.status !== 'running') {
        const response = buildResponse(this.deps, msg, 'execution:abort:response', {
          success: false,
          error: 'Operation already finished',
          status: operation.status,
        });
        this.deps.broker.postToWebview(response);
        this.deps.log(`[TX] ${response.type} id=${response.id} (already ${operation.status})`);
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
      sendHandlerError(this.deps, 'execution:abort', 'execution:error', msg, err);
    }
  }
}
