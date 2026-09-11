import type { HandlerDeps, DomainHandler, InboundRequest } from '../HandlerTypes.js';
import { buildResponse } from '../HandlerTypes.js';
import {
  validatePayload,
  aiNl2SoqlPayloadSchema,
  aiResolveErrorPayloadSchema,
  aiGeneratePipelinePayloadSchema,
} from '../../validatePayload.js';
import type { AIModules } from '../AIHandler.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { getJsforceConnection } from '../../../core/connection/ConnectionHelper.js';

/** Message types handled by AIToolsHandler. */
const AI_TOOLS_TYPES = new Set(['ai:nl2soql', 'ai:resolve-error', 'ai:generate-pipeline']);

/**
 * Sub-handler for AI tool messages.
 *
 * Handles NL2SOQL translation, error resolution, and pipeline generation.
 */
export class AIToolsHandler implements DomainHandler {
  private aiModules?: AIModules;

  /** @param deps - Injected handler dependencies. */
  constructor(private readonly deps: HandlerDeps) {}

  /** Inject AI modules (Tier 2). */
  setAIModules(modules: AIModules): void {
    this.aiModules = modules;
  }

  /**
   * Handle an incoming bridge message.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!AI_TOOLS_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'ai:nl2soql':
        await this.handleNL2SOQL(msg);
        return true;
      case 'ai:resolve-error':
        await this.handleResolveError(msg);
        return true;
      case 'ai:generate-pipeline':
        await this.handleGeneratePipeline(msg);
        return true;
      default:
        return false;
    }
  }

  private async handleNL2SOQL(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiNl2SoqlPayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    const { query, orgId } = parsed;
    try {
      if (!this.aiModules?.nl2soql) {
        throw new Error('AI not configured. Set your API key in Settings > AI.');
      }
      const conn = await getJsforceConnection(orgId, this.deps.orgRegistry, this.deps.orgManager);
      const globalDesc = await conn.describeGlobal();
      const schemaContext = {
        objects: globalDesc.sobjects.map((s: { name: string; label: string }) => ({
          apiName: s.name,
          label: s.label,
          fields: [] as Array<{ apiName: string; label: string; type: string }>,
        })),
      };
      const result = await this.aiModules.nl2soql.generateSOQL(query, schemaContext);
      const response = buildResponse(this.deps, msg, 'ai:nl2soql:response', {
        success: true,
        soql: result.soql,
        explanation: result.explanation,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] ai:nl2soql: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'ai:nl2soql:response', {
        success: false,
        error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(errResp);
    }
  }

  private async handleResolveError(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiResolveErrorPayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    const { errorMessage, errorCode, module, context } = parsed;
    try {
      if (!this.aiModules?.errorResolver) {
        throw new Error(
          'AI not configured. Set your API key in Settings > AI to enable this feature.',
        );
      }
      const result = await this.aiModules.errorResolver.resolveError(
        { errorCode: errorCode ?? 'UNKNOWN', message: errorMessage },
        { module, operation: 'unknown', orgId: '', ...context },
      );
      const suggestedFix = result.suggestions[0]?.description ?? result.explanation;
      const response = buildResponse(this.deps, msg, 'ai:resolve-error:response', {
        success: true,
        resolution: {
          explanation: result.explanation,
          suggestedFix,
          confidence: result.confidence,
        },
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] ai:resolve-error: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'ai:resolve-error:response', {
        success: false,
        error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(errResp);
    }
  }

  private async handleGeneratePipeline(msg: InboundRequest): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const parsed = validatePayload(aiGeneratePipelinePayloadSchema, msg, 'ai:error', this.deps);
    if (!parsed) return;
    const { description, orgIds } = parsed;
    try {
      if (!this.aiModules?.pipelineGenerator) {
        throw new Error(
          'AI not configured. Set your API key in Settings > AI to enable this feature.',
        );
      }
      const availableOrgs = (orgIds ?? []).map((id: string) => {
        const org = this.deps.orgManager.getOrg(id);
        return {
          orgId: id,
          alias: org?.alias ?? id,
          type: (org?.orgType ?? 'sandbox') as 'production' | 'sandbox' | 'developer' | 'scratch',
        };
      });
      const result = await this.aiModules.pipelineGenerator.generatePipeline(
        description,
        availableOrgs,
      );
      const response = buildResponse(this.deps, msg, 'ai:generate-pipeline:response', {
        success: true,
        pipeline: result as unknown as Record<string, unknown>,
      });
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] ai:generate-pipeline: ${extractErrorMessage(err)}`);
      const errResp = buildResponse(this.deps, msg, 'ai:generate-pipeline:response', {
        success: false,
        error: extractErrorMessage(err),
      });
      this.deps.broker.postToWebview(errResp);
    }
  }
}
