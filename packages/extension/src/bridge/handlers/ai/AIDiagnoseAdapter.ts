import type {
  AIDiagnoseRequestMessage,
  AIApproveActionRequestMessage,
  BaseMessage,
} from '@sandforge/shared';
import { z } from 'zod';
import type { HandlerDeps, DomainHandler } from '../HandlerTypes.js';
import { buildResponse } from '../HandlerTypes.js';
import { aiDiagnosePayloadSchema, aiApproveActionPayloadSchema } from '../../validatePayload.js';
import type { AIDiagnoseHandler } from './AIDiagnoseHandler.js';

/** Message types handled by AIDiagnoseAdapter. */
const AI_DIAGNOSE_TYPES = new Set(['ai:diagnose', 'ai:approve-action']);

/** Error code sent when the diagnose handler has not been wired (AI disabled). */
const NOT_CONFIGURED_CODE = 'AI_NOT_CONFIGURED';
const NOT_CONFIGURED_MESSAGE = 'AI is not configured. Set your API key in Settings > AI.';

/** Error code sent when the incoming payload fails schema validation. */
const INVALID_PAYLOAD_CODE = 'INVALID_PAYLOAD';

/**
 * Best-effort echo shape for error envelopes. When a payload is malformed the
 * adapter still answers on the flow's own response channel, echoing
 * runId/actionIndex when they happen to be present and well-typed (the
 * webview correlates responses on them). Each field falls back independently
 * (`.catch`), and a non-object payload falls back wholesale.
 */
const errorEchoSchema = z
  .object({
    runId: z.string().min(1).max(200).catch('unknown'),
    actionIndex: z.number().int().nonnegative().catch(0),
  })
  .catch({ runId: 'unknown', actionIndex: 0 });

/** Format the first zod issues into a compact, log-safe summary. */
function formatIssues(error: z.ZodError): string {
  const summary = error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
  return `Invalid payload — ${summary}`;
}

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
 *     the message when no handler is wired;
 *   - validates payloads with the diagnose flow's Zod schemas before
 *     forwarding, reporting failures through the flow's own specialised
 *     error envelopes (never the generic sendHandlerError channel).
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

    const parsed = this.parseMessage(msg);
    if (!parsed) return true; // Specialised INVALID_PAYLOAD response already sent.
    await this.handler.handleMessage(parsed);
    return true;
  }

  /**
   * Validate the payload against the flow's Zod schemas and rebuild a fully
   * typed request message. On failure, answers with the flow's specialised
   * error envelope and returns null.
   */
  private parseMessage(
    msg: BaseMessage,
  ): AIDiagnoseRequestMessage | AIApproveActionRequestMessage | null {
    const rawPayload = (msg as { payload?: unknown }).payload;
    if (msg.type === 'ai:diagnose') {
      const result = aiDiagnosePayloadSchema.safeParse(rawPayload);
      if (!result.success) {
        this.sendDiagnoseError(msg, INVALID_PAYLOAD_CODE, formatIssues(result.error));
        return null;
      }
      return { ...msg, type: 'ai:diagnose', payload: result.data };
    }
    const result = aiApproveActionPayloadSchema.safeParse(rawPayload);
    if (!result.success) {
      this.sendApproveError(msg, formatIssues(result.error));
      return null;
    }
    return { ...msg, type: 'ai:approve-action', payload: result.data };
  }

  /** Reply with an explicit not-configured error on the matching response channel. */
  private sendNotConfigured(msg: BaseMessage): void {
    if (msg.type === 'ai:diagnose') {
      this.sendDiagnoseError(msg, NOT_CONFIGURED_CODE, NOT_CONFIGURED_MESSAGE);
      return;
    }
    this.sendApproveError(msg, NOT_CONFIGURED_MESSAGE, NOT_CONFIGURED_CODE);
  }

  /** Reply with an error envelope on the ai:diagnose:response channel. */
  private sendDiagnoseError(msg: BaseMessage, code: string, message: string): void {
    const response = buildResponse(this.deps, msg, 'ai:diagnose:response', {
      runId: this.extractEcho(msg).runId,
      error: { code, message },
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ai:diagnose:response id=${response.id} (${code})`);
  }

  /** Reply with a failed-status envelope on the ai:approve-action:response channel. */
  private sendApproveError(
    msg: BaseMessage,
    resultMessage: string,
    logCode: string = INVALID_PAYLOAD_CODE,
  ): void {
    const echo = this.extractEcho(msg);
    const response = buildResponse(this.deps, msg, 'ai:approve-action:response', {
      runId: echo.runId,
      actionIndex: echo.actionIndex,
      status: 'failed',
      resultMessage,
    });
    this.deps.broker.postToWebview(response);
    this.deps.log(`[TX] ai:approve-action:response id=${response.id} (${logCode})`);
  }

  /**
   * Best-effort extraction of runId/actionIndex from a raw payload, used only
   * to correlate error envelopes. Never throws: each field falls back to a
   * neutral default independently — the error envelope must still go out.
   */
  private extractEcho(msg: BaseMessage): { runId: string; actionIndex: number } {
    return errorEchoSchema.parse((msg as { payload?: unknown }).payload);
  }
}
