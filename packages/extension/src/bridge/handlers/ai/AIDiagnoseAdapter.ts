import type {
  AIDiagnoseRequestMessage,
  AIApproveActionRequestMessage,
  BaseMessage,
} from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from '../HandlerTypes.js';
import { buildResponse } from '../HandlerTypes.js';
import type { AIDiagnoseHandler } from './AIDiagnoseHandler.js';

/** Message types handled by AIDiagnoseAdapter. */
const AI_DIAGNOSE_TYPES = new Set(['ai:diagnose', 'ai:approve-action']);

/** Error code sent when the diagnose handler has not been wired (AI disabled). */
const NOT_CONFIGURED_CODE = 'AI_NOT_CONFIGURED';
const NOT_CONFIGURED_MESSAGE = 'AI is not configured. Set your API key in Settings > AI.';

/**
 * DomainHandler bridge around {@link AIDiagnoseHandler}.
 *
 * AIDiagnoseHandler predates the DomainHandler composition used by AIHandler
 * (it exposes `handleMessage` and requires an AIClient at construction, which
 * only exists when the AI stack is enabled). This adapter:
 *   - conforms to DomainHandler so AIHandler can delegate to it uniformly;
 *   - accepts the concrete handler lazily via {@link setHandler} (wired from
 *     extension.ts once the AI stack is confirmed enabled);
 *   - answers with an explicit NOT_CONFIGURED response instead of dropping
 *     the message when no handler is wired.
 */
export class AIDiagnoseAdapter implements DomainHandler {
  private handler?: AIDiagnoseHandler;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /** Wire the concrete diagnose handler (called once AI init succeeds). */
  setHandler(handler: AIDiagnoseHandler): void {
    this.handler = handler;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!AI_DIAGNOSE_TYPES.has(msg.type)) return false;

    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);

    if (!this.handler) {
      this.sendNotConfigured(msg);
      return true;
    }

    await this.handler.handleMessage(
      msg as unknown as AIDiagnoseRequestMessage | AIApproveActionRequestMessage,
    );
    return true;
  }

  /** Reply with an explicit not-configured error on the matching response channel. */
  private sendNotConfigured(msg: BaseMessage): void {
    if (msg.type === 'ai:diagnose') {
      const runId = (msg as { payload?: { runId?: string } }).payload?.runId ?? 'unknown';
      const response = buildResponse(this.deps, msg, 'ai:diagnose:response', {
        runId,
        error: { code: NOT_CONFIGURED_CODE, message: NOT_CONFIGURED_MESSAGE },
      });
      this.deps.broker.postToWebview(response);
      this.deps.log(`[TX] ai:diagnose:response id=${response.id} (${NOT_CONFIGURED_CODE})`);
      return;
    }
    const payload = (msg as { payload?: { runId?: string; actionIndex?: number } }).payload;
    const response = buildResponse(this.deps, msg, 'ai:approve-action:response', {
      runId: payload?.runId ?? 'unknown',
      actionIndex: payload?.actionIndex ?? 0,
      status: 'failed',
      resultMessage: NOT_CONFIGURED_MESSAGE,
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ai:approve-action:response id=${response.id} (${NOT_CONFIGURED_CODE})`);
  }
}
