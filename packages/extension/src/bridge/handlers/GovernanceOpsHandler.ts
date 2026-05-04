import type { BaseMessage } from '@sandforge/shared';
import { SF_API_VERSION } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import { buildResponse, sendHandlerError } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { GovernancePolicyStore } from '../../modules/monitor/GovernancePolicyStore.js';
import {
  GovernanceEngine,
  GovernancePolicySchema,
} from '../../modules/monitor/GovernanceEngine.js';
import type {
  GovernancePolicy,
  GovernanceEvaluationResult,
  MetricValues,
} from '../../modules/monitor/GovernanceEngine.js';
import type { RawLimitsResponse } from '../../modules/monitor/transformLimitsResponse.js';
import type { AlertEngine } from '../../modules/monitor/AlertEngine.js';

/** Summary shape returned by governance:policies:list for the webview. */
interface GovernancePolicySummary {
  id: string;
  name: string;
  description: string;
  ruleCount: number;
  createdAt: string;
  updatedAt: string;
}

/** Message types handled by GovernanceOpsHandler. */
const GOVERNANCE_TYPES = new Set([
  'governance:policies:list',
  'governance:policy:get',
  'governance:policy:save',
  'governance:policy:delete',
  'governance:policies:export',
  'governance:policies:import',
  'governance:evaluate',
  'governance:templates',
]);

/**
 * Domain handler for governance-related webview-to-extension messages.
 *
 * Routes governance:* message types to GovernancePolicyStore CRUD operations
 * and GovernanceEngine evaluation. When evaluation produces failing rules,
 * they are fed into the AlertEngine (GOV-03 pipeline) if one is provided.
 */
export class GovernanceOpsHandler implements DomainHandler {
  private readonly store: GovernancePolicyStore;
  private readonly engine: GovernanceEngine;
  private readonly alertEngine?: AlertEngine;

  /**
   * @param deps - Injected handler dependencies.
   * @param alertEngine - Optional AlertEngine for GOV-03 governance-to-alert pipeline.
   */
  constructor(
    private readonly deps: HandlerDeps,
    alertEngine?: AlertEngine,
  ) {
    this.store = new GovernancePolicyStore(deps.configStore);
    this.engine = new GovernanceEngine();
    this.alertEngine = alertEngine;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!GOVERNANCE_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'governance:policies:list':
        this.handlePoliciesList(msg);
        return true;
      case 'governance:policy:get':
        this.handlePolicyGet(msg);
        return true;
      case 'governance:policy:save':
        this.handlePolicySave(msg);
        return true;
      case 'governance:policy:delete':
        this.handlePolicyDelete(msg);
        return true;
      case 'governance:policies:export':
        this.handlePoliciesExport(msg);
        return true;
      case 'governance:policies:import':
        this.handlePoliciesImport(msg);
        return true;
      case 'governance:evaluate':
        await this.handleEvaluate(msg);
        return true;
      case 'governance:templates':
        this.handleTemplates(msg);
        return true;
      default:
        return false;
    }
  }

  /**
   * List all governance policies as summaries.
   * @param msg - The incoming request message.
   */
  private handlePoliciesList(msg: BaseMessage): void {
    try {
      const policies = this.store.getAll();
      const summaries: GovernancePolicySummary[] = policies.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description,
        ruleCount: p.rules.length,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
      }));
      const response = buildResponse(this.deps, msg, 'governance:policies:result', {
        policies: summaries,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log('[TX] governance:policies:result');
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'governance:policies:list', 'governance:error', err);
    }
  }

  /**
   * Get a single governance policy by ID.
   * @param msg - The incoming request message with policyId payload.
   */
  private handlePolicyGet(msg: BaseMessage): void {
    try {
      const payload = msg as BaseMessage & { payload: { policyId: string } };
      const policy = this.store.getById(payload.payload.policyId) ?? null;
      const response = buildResponse(this.deps, msg, 'governance:policy:result', { policy });
      this.deps.broker.postToWebview(response);
      this.deps.log('[TX] governance:policy:result');
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'governance:policy:get', 'governance:error', err);
    }
  }

  /**
   * Save (create or update) a governance policy with Zod validation.
   * @param msg - The incoming request message with policy payload.
   */
  private handlePolicySave(msg: BaseMessage): void {
    try {
      const payload = msg as BaseMessage & { payload: { policy: GovernancePolicy } };
      const parsed = GovernancePolicySchema.safeParse(payload.payload.policy);
      if (!parsed.success) {
        sendHandlerError(
          this.deps,
          'governance:policy:save',
          'governance:policy:save:response',
          new Error(`Validation failed: ${parsed.error.message}`),
          'VALIDATION_ERROR',
        );
        return;
      }
      this.store.save(parsed.data);
      const response = buildResponse(this.deps, msg, 'governance:policy:save:response', {
        success: true,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log('[TX] governance:policy:save:response');
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'governance:policy:save', 'governance:error', err);
    }
  }

  /**
   * Delete a governance policy by ID.
   * @param msg - The incoming request message with policyId payload.
   */
  private handlePolicyDelete(msg: BaseMessage): void {
    try {
      const payload = msg as BaseMessage & { payload: { policyId: string } };
      const success = this.store.delete(payload.payload.policyId);
      const response = buildResponse(this.deps, msg, 'governance:policy:delete:response', {
        success,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log('[TX] governance:policy:delete:response');
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'governance:policy:delete', 'governance:error', err);
    }
  }

  /**
   * Export all policies as a JSON string.
   * @param msg - The incoming request message.
   */
  private handlePoliciesExport(msg: BaseMessage): void {
    try {
      const json = this.store.exportPolicies();
      const response = buildResponse(this.deps, msg, 'governance:policies:export:response', {
        json,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log('[TX] governance:policies:export:response');
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'governance:policies:export', 'governance:error', err);
    }
  }

  /**
   * Import policies from a JSON string.
   * @param msg - The incoming request message with json payload.
   */
  private handlePoliciesImport(msg: BaseMessage): void {
    try {
      const payload = msg as BaseMessage & { payload: { json: string } };
      const count = this.store.importPolicies(payload.payload.json);
      const response = buildResponse(this.deps, msg, 'governance:policies:import:response', {
        success: true,
        count,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log('[TX] governance:policies:import:response');
    } catch (err: unknown) {
      sendHandlerError(
        this.deps,
        'governance:policies:import',
        'governance:policies:import:response',
        err,
      );
    }
  }

  /**
   * Evaluate a governance policy against live org limits.
   *
   * Fetches /limits from Salesforce, builds MetricValues (usedPercent per limit),
   * runs GovernanceEngine.evaluatePolicy, and feeds failing rules into AlertEngine
   * (GOV-03 pipeline) when an AlertEngine is available.
   *
   * @param msg - The incoming request message with policyId and orgId payload.
   */
  private async handleEvaluate(msg: BaseMessage): Promise<void> {
    try {
      const payload = msg as BaseMessage & { payload: { policyId: string; orgId: string } };

      const policy = this.store.getById(payload.payload.policyId);
      if (!policy) {
        sendHandlerError(
          this.deps,
          'governance:evaluate',
          'governance:evaluate:response',
          new Error(`Policy not found: ${payload.payload.policyId}`),
          'NOT_FOUND',
        );
        return;
      }

      const conn = await getJsforceConnection(
        payload.payload.orgId,
        this.deps.orgRegistry,
        this.deps.orgManager,
      );
      const limitsRaw = (await conn.request(
        `/services/data/${SF_API_VERSION}/limits`,
      )) as RawLimitsResponse;

      const metrics: MetricValues = {};
      for (const [key, { Max, Remaining }] of Object.entries(limitsRaw)) {
        metrics[key] = Max > 0 ? Math.round(((Max - Remaining) / Max) * 100) : 0;
      }

      const result: GovernanceEvaluationResult = this.engine.evaluatePolicy(policy, metrics);

      if (this.alertEngine) {
        for (const ruleResult of result.ruleResults) {
          if (ruleResult.status === 'fail') {
            this.alertEngine.evaluate(
              `governance:${ruleResult.ruleId}`,
              ruleResult.actualValue,
              payload.payload.orgId,
            );
          }
        }
      }

      const response = buildResponse(this.deps, msg, 'governance:evaluate:response', {
        success: true,
        result,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log('[TX] governance:evaluate:response');
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'governance:evaluate', 'governance:error', err);
    }
  }

  /**
   * Return default governance policy templates.
   * @param msg - The incoming request message.
   */
  private handleTemplates(msg: BaseMessage): void {
    try {
      const templates = GovernancePolicyStore.getDefaultTemplates();
      const response = buildResponse(this.deps, msg, 'governance:templates:response', {
        templates,
      });
      this.deps.broker.postToWebview(response);
      this.deps.log('[TX] governance:templates:response');
    } catch (err: unknown) {
      sendHandlerError(this.deps, 'governance:templates', 'governance:error', err);
    }
  }
}
