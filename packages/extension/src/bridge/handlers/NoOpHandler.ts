import type { BaseMessage } from '@sandforge/shared';
import { buildResponse } from './HandlerTypes.js';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';

/**
 * Message types for features that are planned but not yet implemented.
 *
 * Scheduler types are targeted for v1.2, RealTime CDC types for v2.0.
 * This handler ensures the extension returns a clean "feature not available"
 * response instead of causing unhandled-message warnings in the MessageBroker.
 */
const NOOP_TYPES = new Set([
  'scheduler:list',
  'scheduler:upsert',
  'scheduler:delete',
  'scheduler:toggle',
  'realtime:start',
  'realtime:stop',
  'realtime:status',
  'realtime:metrics',
]);

/**
 * No-op handler for ghost features (Scheduler, RealTime CDC).
 *
 * Returns a standardised `{ success: false, comingSoon: true }` response
 * for any message type in the NOOP_TYPES set, preventing unhandled message
 * warnings and giving the webview a clean error state to display.
 */
export class NoOpHandler implements DomainHandler {
  /** @param deps - Handler dependencies (needs nextId and broker). */
  constructor(private readonly deps: Pick<HandlerDeps, 'nextId' | 'broker'>) {}

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled (no-op response sent), `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!NOOP_TYPES.has(msg.type)) return false;

    const responseType = `${msg.type}:response`;
    this.deps.broker.postToWebview(
      buildResponse(this.deps, msg, responseType, {
        success: false,
        error: 'Feature not yet available',
        comingSoon: true,
      }),
    );
    return true;
  }
}
