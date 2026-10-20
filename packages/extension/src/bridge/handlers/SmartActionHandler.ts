import type { SmartActionRecommendation } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import { buildResponse, sendHandlerError } from './HandlerTypes.js';
import { validatePayload, smartActionAnalyzePayloadSchema } from '../validatePayload.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { SmartActionAnalyzer } from '../../modules/ai/SmartActionAnalyzer.js';

/** Cache entry with TTL tracking. */
interface CacheEntry {
  recommendation: SmartActionRecommendation;
  fetchedAt: number;
  /** The orgs the recommendation was read from: the target, and the source when there was one. */
  orgIds: readonly string[];
}

/**
 * The key a recommendation is held under: every input that changes it, the
 * target and the source. Held by target alone, the "seed it" given before a
 * second org was connected was served for five minutes after, when the same
 * target with a source holding data is one to clone into.
 */
function cacheKeyOf(targetOrgId: string, sourceOrgId: string | undefined): string {
  return `smart-action:${targetOrgId}:${sourceOrgId ?? ''}`;
}

/** Cache TTL: 5 minutes. */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Message types handled by SmartActionHandler. */
const SMART_ACTION_TYPES = new Set(['smart-action:analyze']);

/**
 * Domain handler for Smart Action analysis bridge messages.
 *
 * Receives `smart-action:analyze` requests from the WebView, delegates
 * to SmartActionAnalyzer, caches results for 5 minutes per target and
 * source org, and returns the recommendation via `buildResponse()`.
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
  async handle(msg: InboundRequest): Promise<boolean> {
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
   * Drop the recommendation held for an org that is no longer the org it was.
   * It was read from record counts, and a refreshed sandbox holds a new copy
   * of production's records: "this org is empty, seed it" may no longer be so.
   *
   * Held as the target or as the source, the recommendation goes either way.
   *
   * @param orgId - The registered org.
   */
  forgetOrg(orgId: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.orgIds.includes(orgId)) this.cache.delete(key);
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
  private async handleAnalyze(msg: InboundRequest): Promise<void> {
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

      const cacheKey = cacheKeyOf(targetOrgId, sourceOrgId);
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

      this.cache.set(cacheKey, {
        recommendation,
        fetchedAt: Date.now(),
        orgIds: sourceOrgId ? [targetOrgId, sourceOrgId] : [targetOrgId],
      });

      const response = buildResponse(this.deps, msg, 'smart-action:analyze:response', {
        recommendation,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log('[TX] smart-action:analyze:response');
    } catch (err) {
      sendHandlerError(this.deps, 'smart-action:analyze', 'smart-action:error', msg, err);
    }
  }
}
