import type { BaseMessage, SmartActionRecommendation } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse, sendHandlerError } from './HandlerTypes.js';
import { validatePayload, smartActionAnalyzePayloadSchema } from '../validatePayload.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { SmartActionAnalyzer } from '../../modules/ai/SmartActionAnalyzer.js';

/** Cache entry with TTL tracking. */
interface CacheEntry {
  recommendation: SmartActionRecommendation;
  fetchedAt: number;
}

/** Cache TTL: 5 minutes. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Message types handled by SmartActionHandler. */
const SMART_ACTION_TYPES = new Set(['smart-action:analyze']);

/**
 * Domain handler for Smart Action analysis bridge messages.
 *
 * Receives `smart-action:analyze` requests from the WebView, delegates
 * to SmartActionAnalyzer, caches results for 5 minutes per target org,
 * and returns the recommendation via `buildResponse()`.
 */
export class SmartActionHandler implements DomainHandler {
  private readonly analyzer: SmartActionAnalyzer;
  private readonly cache = new Map<string, CacheEntry>();

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {
    this.analyzer = new SmartActionAnalyzer({
      getConnection: (orgId: string) =>
        getJsforceConnection(orgId, deps.orgRegistry, deps.orgManager),
    });
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!SMART_ACTION_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'smart-action:analyze':
        await this.handleAnalyze(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * Handle the smart-action:analyze request.
   *
   * Checks cache first, then delegates to SmartActionAnalyzer if cache
   * is stale or missing.
   *
   * @param msg - The analyze request message.
   */
  private async handleAnalyze(msg: BaseMessage): Promise<void> {
    const parsed = validatePayload(
      smartActionAnalyzePayloadSchema,
      msg,
      'smart-action:error',
      this.deps,
    );
    if (!parsed) return;
    try {
      const targetOrgId = parsed.targetOrgId;
      const sourceOrgId = parsed.sourceOrgId;

      const cacheKey = `smart-action:${targetOrgId}`;
      const cached = this.cache.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
        this.deps.log(`[SmartAction] Cache hit for ${targetOrgId}`);
        const response = buildResponse(this.deps, msg, 'smart-action:analyze:response', {
          recommendation: cached.recommendation,
        });
        this.deps.broker.postToWebview(response);
        this.deps.log('[TX] smart-action:analyze:response (cached)');
        return;
      }

      this.deps.log(`[SmartAction] Analyzing org ${targetOrgId}`);
      const recommendation = await this.analyzer.analyzeOrg(targetOrgId, sourceOrgId);

      this.cache.set(cacheKey, { recommendation, fetchedAt: Date.now() });

      const response = buildResponse(this.deps, msg, 'smart-action:analyze:response', {
        recommendation,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log('[TX] smart-action:analyze:response');
    } catch (err) {
      sendHandlerError(this.deps, 'smart-action:analyze', 'smart-action:error', err);
    }
  }
}
