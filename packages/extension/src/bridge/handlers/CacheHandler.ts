import type { BaseMessage } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse } from './HandlerTypes.js';
import { CacheManager } from '../../core/cache/CacheManager.js';

/** Message types handled by CacheHandler. */
const CACHE_TYPES = new Set([
  'cache:invalidate-all',
  'cache:get-stats',
]);

/**
 * Domain handler for cache management messages.
 *
 * Handles cache invalidation (org-switch) and diagnostics (stats retrieval).
 */
export class CacheHandler implements DomainHandler {
  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: Pick<HandlerDeps, 'nextId' | 'broker' | 'log'>) {}

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!CACHE_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'cache:invalidate-all':
        this.handleInvalidateAll(msg);
        return true;
      case 'cache:get-stats':
        this.handleGetStats(msg);
        return true;
      default:
        return false;
    }
  }

  /** Invalidate all registered caches. */
  private handleInvalidateAll(msg: BaseMessage): void {
    const manager = CacheManager.getInstance();
    manager.invalidateAll();
    this.deps.log('[CacheHandler] Invalidated all caches');
    this.deps.broker.postToWebview(
      buildResponse(this.deps, msg, 'cache:invalidate-all:response', {
        success: true,
      }),
    );
  }

  /** Return cache statistics. */
  private handleGetStats(msg: BaseMessage): void {
    const manager = CacheManager.getInstance();
    const stats = manager.getStats();
    this.deps.broker.postToWebview(
      buildResponse(this.deps, msg, 'cache:stats-response', { stats }),
    );
  }
}
