import type { BaseMessage } from '@sandforge/shared';
import type { HandlerDeps, DomainHandler } from './HandlerTypes.js';
import type { AIAssistant } from '../../modules/ai/AIAssistant.js';
import type { NL2SOQL } from '../../modules/ai/NL2SOQL.js';
import type { ErrorResolver } from '../../modules/ai/ErrorResolver.js';
import type { SmartSuggestions } from '../../modules/ai/SmartSuggestions.js';
import type { PipelineGenerator } from '../../modules/ai/PipelineGenerator.js';
import type { AnomalyDetector } from '../../modules/ai/AnomalyDetector.js';
import type { AIPersonaManager } from '../../modules/ai/AIPersonaManager.js';
import type { SchemaAdvisor } from '../../modules/ai/SchemaAdvisor.js';
import { AIChatHandler } from './ai/AIChatHandler.js';
import { AIAnalysisHandler } from './ai/AIAnalysisHandler.js';
import { AIToolsHandler } from './ai/AIToolsHandler.js';
import { AIDiagnoseAdapter } from './ai/AIDiagnoseAdapter.js';
import type { AIDiagnoseHandler } from './ai/AIDiagnoseHandler.js';

/** AI modules bundle. */
export interface AIModules {
  nl2soql: NL2SOQL;
  errorResolver: ErrorResolver;
  smartSuggestions: SmartSuggestions;
  pipelineGenerator: PipelineGenerator;
  anomalyDetector: AnomalyDetector;
  personaManager: AIPersonaManager;
  schemaAdvisor: SchemaAdvisor;
}

/** Message types handled by AIHandler. */
const AI_TYPES = new Set([
  'ai:chat',
  'ai:conversation:create',
  'ai:conversation:load',
  'ai:conversation:list',
  'ai:conversation:delete',
  'ai:status',
  'ai:save-key',
  'ai:nl2soql',
  'ai:resolve-error',
  'ai:personas',
  'ai:anomaly-scan',
  'ai:suggestions',
  'ai:generate-pipeline',
  'ai:schema-advice',
  'ai:diagnose',
  'ai:approve-action',
]);

/**
 * Domain handler for AI-related webview-to-extension messages.
 *
 * Delegates to focused sub-handlers:
 * - {@link AIChatHandler} — chat, conversations, status, key management
 * - {@link AIAnalysisHandler} — anomaly scan, suggestions, schema advice
 * - {@link AIToolsHandler} — NL2SOQL, error resolution, personas, pipeline generation
 * - {@link AIDiagnoseAdapter} — diagnose flow + per-action approve gate
 */
export class AIHandler implements DomainHandler {
  private readonly chatHandler: AIChatHandler;
  private readonly analysisHandler: AIAnalysisHandler;
  private readonly toolsHandler: AIToolsHandler;
  private readonly diagnoseAdapter: AIDiagnoseAdapter;
  private readonly subHandlers: DomainHandler[];

  /** @param deps - Injected handler dependencies. */
  constructor(deps: HandlerDeps) {
    this.chatHandler = new AIChatHandler(deps);
    this.analysisHandler = new AIAnalysisHandler(deps);
    this.toolsHandler = new AIToolsHandler(deps, () => this.chatHandler.getAIAssistant());
    this.diagnoseAdapter = new AIDiagnoseAdapter(deps);
    this.subHandlers = [
      this.chatHandler,
      this.analysisHandler,
      this.toolsHandler,
      this.diagnoseAdapter,
    ];
  }

  /** Inject AI assistant service. */
  setAIAssistant(ai: AIAssistant): void {
    this.chatHandler.setAIAssistant(ai);
  }

  /** Inject AI modules (Tier 2). */
  setAIModules(modules: AIModules): void {
    this.analysisHandler.setAIModules(modules);
    this.toolsHandler.setAIModules(modules);
  }

  /** Inject the concrete diagnose handler once the AI stack is enabled. */
  setDiagnoseHandler(handler: AIDiagnoseHandler): void {
    this.diagnoseAdapter.setHandler(handler);
  }

  /**
   * Handle an incoming bridge message.
   *
   * Routes to the appropriate sub-handler based on message type.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: BaseMessage): Promise<boolean> {
    if (!AI_TYPES.has(msg.type)) return false;

    for (const handler of this.subHandlers) {
      const handled = await handler.handle(msg);
      if (handled) return true;
    }

    return false;
  }
}
