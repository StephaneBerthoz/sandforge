import type { BaseMessage } from '@sandforge/shared';
import type {
  AINL2SOQLRequest, AIResolveErrorRequest, AIPersonasRequest,
  AIGeneratePipelineRequest,
} from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from '../HandlerTypes.js';
import type { AIModules } from '../AIHandler.js';
import type { AIAssistant } from '../../../modules/ai/AIAssistant.js';
import { extractErrorMessage } from '../../../core/common/extractErrorMessage.js';
import { getJsforceConnection } from '../../../core/connection/ConnectionHelper.js';

/** Message types handled by AIToolsHandler. */
export const AI_TOOLS_TYPES = new Set([
  'ai:nl2soql',
  'ai:resolve-error',
  'ai:personas',
  'ai:generate-pipeline',
]);

/**
 * Sub-handler for AI tool messages.
 *
 * Handles NL2SOQL translation, error resolution, persona management,
 * and pipeline generation.
 */
export class AIToolsHandler implements DomainHandler {
  private aiModules?: AIModules;
  private getAIAssistant: () => AIAssistant | undefined;

  /**
   * @param deps - Injected handler dependencies.
   * @param getAIAssistant - Accessor for the AIAssistant instance (owned by AIChatHandler).
   */
  constructor(
    private readonly deps: HandlerDeps,
    getAIAssistant: () => AIAssistant | undefined,
  ) {
    this.getAIAssistant = getAIAssistant;
  }

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
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!AI_TOOLS_TYPES.has(msg.type)) return false;

    switch (msg.type) {
      case 'ai:nl2soql':
        await this.handleNL2SOQL(msg);
        return true;
      case 'ai:resolve-error':
        await this.handleResolveError(msg);
        return true;
      case 'ai:personas':
        await this.handlePersonas(msg);
        return true;
      case 'ai:generate-pipeline':
        await this.handleGeneratePipeline(msg);
        return true;
      default:
        return false;
    }
  }

  private async handleNL2SOQL(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const { query, orgId } = (msg as AINL2SOQLRequest).payload;
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
      const response: BaseMessage & { payload: Record<string, unknown> } = {
        type: 'ai:nl2soql:response', id: this.deps.nextId(), timestamp: Date.now(),
        payload: { success: true, soql: result.soql, explanation: result.explanation },
      };
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] ai:nl2soql: ${extractErrorMessage(err)}`);
      const errResp: BaseMessage & { payload: Record<string, unknown> } = {
        type: 'ai:nl2soql:response', id: this.deps.nextId(), timestamp: Date.now(),
        payload: { success: false, error: extractErrorMessage(err) },
      };
      this.deps.broker.postToWebview(errResp);
    }
  }

  private async handleResolveError(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const { errorMessage, errorCode, module, context } = (msg as AIResolveErrorRequest).payload;
    try {
      if (!this.aiModules?.errorResolver) {
        throw new Error('AI not configured. Set your API key in Settings > AI to enable this feature.');
      }
      const result = await this.aiModules.errorResolver.resolveError(
        { errorCode: errorCode ?? 'UNKNOWN', message: errorMessage },
        { module, operation: 'unknown', orgId: '', ...context },
      );
      const suggestedFix = result.suggestions[0]?.description ?? result.explanation;
      const response: BaseMessage & { payload: Record<string, unknown> } = {
        type: 'ai:resolve-error:response', id: this.deps.nextId(), timestamp: Date.now(),
        payload: { success: true, resolution: { explanation: result.explanation, suggestedFix, confidence: result.confidence } },
      };
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] ai:resolve-error: ${extractErrorMessage(err)}`);
      const errResp: BaseMessage & { payload: Record<string, unknown> } = {
        type: 'ai:resolve-error:response', id: this.deps.nextId(), timestamp: Date.now(),
        payload: { success: false, error: extractErrorMessage(err) },
      };
      this.deps.broker.postToWebview(errResp);
    }
  }

  private async handlePersonas(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const { action, description } = (msg as AIPersonasRequest).payload;
    try {
      if (!this.aiModules?.personaManager) {
        throw new Error('AI not configured. Set your API key in Settings > AI to enable this feature.');
      }
      if (action === 'list') {
        const builtIn = this.aiModules.personaManager.getBuiltInPersonas();
        const custom = this.aiModules.personaManager.getCustomPersonas();
        const personas = [...builtIn, ...custom].map((p: { id: string; name: string; description: string }) => ({ id: p.id, name: p.name, description: p.description }));
        const response: BaseMessage & { payload: Record<string, unknown> } = {
          type: 'ai:personas:response', id: this.deps.nextId(), timestamp: Date.now(),
          payload: { success: true, personas },
        };
        this.deps.broker.postToWebview(response);
      } else if (action === 'create' && description) {
        const aiAssistant = this.getAIAssistant();
        const aiProvider = async (prompt: string): Promise<string> => {
          if (!aiAssistant) throw new Error('AI not configured. Set your API key in Settings > AI to enable this feature.');
          const conv = aiAssistant.createConversation('persona-gen');
          const result = await aiAssistant.chat(conv.id, prompt);
          aiAssistant.deleteConversation(conv.id);
          return result.content;
        };
        const persona = await this.aiModules.personaManager.createCustomPersona(description, aiProvider);
        const response: BaseMessage & { payload: Record<string, unknown> } = {
          type: 'ai:personas:response', id: this.deps.nextId(), timestamp: Date.now(),
          payload: { success: true, personas: [{ id: persona.id, name: persona.name, description: persona.description }] },
        };
        this.deps.broker.postToWebview(response);
      } else {
        throw new Error('Invalid action or missing description. Provide a valid action ("list" or "create") and a description when creating a persona.');
      }
    } catch (err: unknown) {
      this.deps.log(`[ERR] ai:personas: ${extractErrorMessage(err)}`);
      const errResp: BaseMessage & { payload: Record<string, unknown> } = {
        type: 'ai:personas:response', id: this.deps.nextId(), timestamp: Date.now(),
        payload: { success: false, error: extractErrorMessage(err) },
      };
      this.deps.broker.postToWebview(errResp);
    }
  }

  private async handleGeneratePipeline(msg: BaseMessage): Promise<void> {
    this.deps.log(`[RX] ${msg.type} id=${msg.id}`);
    const { description, orgIds } = (msg as AIGeneratePipelineRequest).payload;
    try {
      if (!this.aiModules?.pipelineGenerator) {
        throw new Error('AI not configured. Set your API key in Settings > AI to enable this feature.');
      }
      const availableOrgs = (orgIds ?? []).map((id: string) => {
        const org = this.deps.orgManager.getOrg(id);
        return { orgId: id, alias: org?.alias ?? id, type: (org?.orgType ?? 'sandbox') as 'production' | 'sandbox' | 'developer' | 'scratch' };
      });
      const result = await this.aiModules.pipelineGenerator.generatePipeline(description, availableOrgs);
      const response: BaseMessage & { payload: Record<string, unknown> } = {
        type: 'ai:generate-pipeline:response', id: this.deps.nextId(), timestamp: Date.now(),
        payload: { success: true, pipeline: result as unknown as Record<string, unknown> },
      };
      this.deps.broker.postToWebview(response);
    } catch (err: unknown) {
      this.deps.log(`[ERR] ai:generate-pipeline: ${extractErrorMessage(err)}`);
      const errResp: BaseMessage & { payload: Record<string, unknown> } = {
        type: 'ai:generate-pipeline:response', id: this.deps.nextId(), timestamp: Date.now(),
        payload: { success: false, error: extractErrorMessage(err) },
      };
      this.deps.broker.postToWebview(errResp);
    }
  }
}
