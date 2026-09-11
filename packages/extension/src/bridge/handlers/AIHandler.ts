import type { HandlerDeps, DomainHandler, InboundRequest } from './HandlerTypes.js';
import type { AIAssistant } from '../../modules/ai/AIAssistant.js';
import type { NL2SOQL } from '../../modules/ai/NL2SOQL.js';
import type { ErrorResolver } from '../../modules/ai/ErrorResolver.js';
import type { PipelineGenerator } from '../../modules/ai/PipelineGenerator.js';
import type { AnomalyDetector } from '../../modules/ai/AnomalyDetector.js';
import type { SchemaAdvisor } from '../../modules/ai/SchemaAdvisor.js';
import { AIChatHandler } from './ai/AIChatHandler.js';
import { AIAnalysisHandler } from './ai/AIAnalysisHandler.js';
import { AIToolsHandler } from './ai/AIToolsHandler.js';

/**
 * Model-backed modules bundle. Present only while AI is enabled and a key is
 * stored; `undefined` tears the bundle down so nothing reaches a provider.
 */
export interface AIModules {
  nl2soql: NL2SOQL;
  errorResolver: ErrorResolver;
  pipelineGenerator: PipelineGenerator;
}

/**
 * Rule-based analysis bundle. These two run on local heuristics — no provider,
 * no key, no network — so they are wired once at activation and never torn
 * down when AI is switched off.
 */
export interface RuleModules {
  anomalyDetector: AnomalyDetector;
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
  'ai:anomaly-scan',
  'ai:generate-pipeline',
  'ai:schema-advice',
]);

/**
 * Domain handler for AI-related webview-to-extension messages.
 *
 * Delegates to focused sub-handlers:
 * - {@link AIChatHandler} — chat, conversations, status, key management
 * - {@link AIAnalysisHandler} — anomaly scan, schema advice (rule-based)
 * - {@link AIToolsHandler} — NL2SOQL, error resolution, pipeline generation
 */
export class AIHandler implements DomainHandler {
  private readonly chatHandler: AIChatHandler;
  private readonly analysisHandler: AIAnalysisHandler;
  private readonly toolsHandler: AIToolsHandler;
  private readonly subHandlers: DomainHandler[];

  /** @param deps - Injected handler dependencies. */
  constructor(deps: HandlerDeps) {
    this.chatHandler = new AIChatHandler(deps);
    this.analysisHandler = new AIAnalysisHandler(deps);
    this.toolsHandler = new AIToolsHandler(deps);
    this.subHandlers = [this.chatHandler, this.analysisHandler, this.toolsHandler];
  }

  /** Inject the AI assistant service, or `undefined` to take it away. */
  setAIAssistant(ai: AIAssistant | undefined): void {
    this.chatHandler.setAIAssistant(ai);
  }

  /** Inject the model-backed modules, or `undefined` to take them away. */
  setAIModules(modules: AIModules | undefined): void {
    this.toolsHandler.setAIModules(modules);
  }

  /** Inject the rule-based analysis modules. Independent of the AI switch. */
  setRuleModules(modules: RuleModules): void {
    this.analysisHandler.setRuleModules(modules);
  }

  /**
   * Handle an incoming bridge message.
   *
   * Routes to the appropriate sub-handler based on message type.
   *
   * @param msg - The typed base message from the webview.
   * @returns `true` if the message was handled, `false` otherwise.
   */
  async handle(msg: InboundRequest): Promise<boolean> {
    if (!AI_TYPES.has(msg.type)) return false;

    for (const handler of this.subHandlers) {
      const handled = await handler.handle(msg);
      if (handled) return true;
    }

    return false;
  }
}
