import * as vscode from 'vscode';
import { AI_CONFIG, AI_PROVIDER } from '@sandforge/shared';
import type { BaseMessage } from '@sandforge/shared';
import type { Services } from '../services.js';
import type { SecretVault } from '../core/storage/SecretVault';
import type { ExtensionHandlers } from '../bridge/ExtensionHandlers';
import type { MessageBroker } from '../bridge/MessageBroker';
import type { OrgRegistry } from '../core/connection/OrgRegistry';
import type { OrgManager } from '../core/connection/OrgManager';
import type { BreakerStateChangeEvent } from '../adapters/ai/AIClient.js';

/** Inputs required to (re-)initialise the AI stack. */
export interface AICompositionDeps {
  services: Services;
  secretVault: SecretVault;
  handlers: ExtensionHandlers;
  /**
   * Broker used by the diagnose handler to stream results to the webview.
   * Typed as possibly-undefined to mirror the module-level `broker` let in
   * extension.ts (deactivate() clears it); the handler guards with `?.`.
   */
  broker: MessageBroker | undefined;
  orgRegistry: OrgRegistry;
  orgManager: OrgManager;
  log: (msg: string) => void;
  /**
   * Optional disposable sink (pass `context.subscriptions`). The breaker
   * status-feed listener lands here so the disposable audit can track it —
   * the adapter's own dispose() also wipes it via removeAllListeners.
   */
  disposables?: vscode.Disposable[];
}

/**
 * Wire up the AI stack — unified on services.aiClient (AnthropicAdapter
 * with circuit breaker, token budget and error redaction). Initialisation
 * only happens when `sandforge.ai.enabled` is true AND an API key is stored
 * under the unified `sandforge.ai.anthropic.key` secret.
 *
 * Runs via dynamic imports, so the AI injection lands AFTER
 * `handlers.registerAll(router)` — see the late-injection contract in
 * `./lateServices.ts`.
 *
 * Extracted from `activate()` — behaviour unchanged.
 */
export async function initAIComposition(deps: AICompositionDeps): Promise<void> {
  const { services, secretVault, handlers, broker, orgRegistry, orgManager, log } = deps;

  if (!services.isAIEnabled()) {
    log('AI disabled (sandforge.ai.enabled=false) — skipping AI init.');
    return;
  }
  const apiKey = await secretVault.getSecret('ai.anthropic.key');
  if (!apiKey) {
    log('AI enabled but no API key stored (sandforge.ai.anthropic.key) — skipping AI init.');
    return;
  }

  const { AIAssistant } = await import('../modules/ai/AIAssistant.js');

  // Route AIAssistant through the unified adapter: breaker + budget + lazy
  // SecretStorage read all live in AnthropicAdapter.
  const aiCallFn: import('../modules/ai/AIAssistant').AICallFn = async (messages, callConfig) => {
    const start = Date.now();
    const result = await services.aiClient().chat({
      messages: messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
      system: messages.find((m) => m.role === 'system')?.content,
      maxTokens: callConfig.maxTokens,
    });
    return {
      content: result.text,
      tokenCount: result.usage.output,
      model: result.model,
      durationMs: Date.now() - start,
    };
  };

  const aiAssistant = new AIAssistant(aiCallFn, {
    provider: AI_PROVIDER,
    model: AI_CONFIG.MODEL,
    apiKey,
    maxTokens: AI_CONFIG.MAX_TOKENS,
    temperature: AI_CONFIG.TEMPERATURE,
  });
  handlers.setAIAssistant(aiAssistant);
  log('AI Assistant initialized (unified adapter stack).');

  // Wire up AI modules (Tier 2) using the same unified client
  const aiProvider = async (prompt: string, system?: string): Promise<string> => {
    const result = await services.aiClient().chat({
      messages: [{ role: 'user', content: prompt }],
      maxTokens: AI_CONFIG.MAX_TOKENS,
      system,
    });
    return result.text;
  };

  const [
    { NL2SOQL },
    { ErrorResolver },
    { SmartSuggestions },
    { PipelineGenerator },
    { AnomalyDetector },
    { AIPersonaManager },
    { SchemaAdvisor },
  ] = await Promise.all([
    import('../modules/ai/NL2SOQL.js'),
    import('../modules/ai/ErrorResolver.js'),
    import('../modules/ai/SmartSuggestions.js'),
    import('../modules/ai/PipelineGenerator.js'),
    import('../modules/ai/AnomalyDetector.js'),
    import('../modules/ai/AIPersonaManager.js'),
    import('../modules/ai/SchemaAdvisor.js'),
  ]);

  handlers.setAIModules({
    nl2soql: new NL2SOQL(aiProvider),
    errorResolver: new ErrorResolver(aiProvider),
    smartSuggestions: new SmartSuggestions(aiProvider),
    pipelineGenerator: new PipelineGenerator(aiProvider),
    anomalyDetector: new AnomalyDetector(),
    personaManager: new AIPersonaManager(),
    schemaAdvisor: new SchemaAdvisor(),
  });
  log('AI modules (Tier 2) initialized.');

  // Plan 04-04: wire the diagnose flow (failed-job → structured context →
  // diagnosis → per-action approve gate). run-anonymous actions execute
  // against the target org via the shared connection helper; apply-fix
  // stays unwired for now (the handler answers honestly that the
  // dispatcher is missing rather than pretending to apply edits).
  const { AIDiagnoseHandler } = await import('../bridge/handlers/ai/AIDiagnoseHandler.js');
  const diagnoseBroker = broker;
  handlers.setAIDiagnoseHandler(
    new AIDiagnoseHandler({
      aiClient: services.aiClient(),
      broker: {
        send: (message) => {
          diagnoseBroker?.postToWebview(message as unknown as BaseMessage);
        },
      },
      telemetry: services.telemetry,
      logger: services.telemetry.getLogger(),
      dispatcher: {
        runAnonymous: async (script, orgId) => {
          const { getJsforceConnection } = await import('../core/connection/ConnectionHelper.js');
          const conn = await getJsforceConnection(orgId, orgRegistry, orgManager);
          const res = (await conn.tooling.executeAnonymous(script)) as {
            compiled: boolean;
            success: boolean;
            compileProblem?: string;
            exceptionMessage?: string;
          };
          if (!res.compiled) {
            return {
              ok: false,
              resultMessage: `Compile error: ${res.compileProblem ?? 'unknown'}`,
            };
          }
          if (!res.success) {
            return {
              ok: false,
              resultMessage: `Execution error: ${res.exceptionMessage ?? 'unknown'}`,
            };
          }
          return { ok: true, resultMessage: 'Anonymous Apex executed successfully' };
        },
      },
    }),
  );
  log('AI diagnose handler initialized.');

  // Forward breaker state changes to the webview as `ai:provider:status` —
  // the provider-status banner (cooldown countdown etc.) has been listening
  // for this channel since 04-02, but nothing ever emitted it. Subscribing
  // per init is safe: adapters are disposed on invalidate() (which removes
  // every listener), and the re-init subscribes on the fresh instance.
  const aiClient = services.aiClient();
  const breakerFeed = aiClient.breakerEvents;
  if (breakerFeed) {
    const listener = (event: BreakerStateChangeEvent): void => {
      broker?.postToWebview({
        id: `ai-status-${Date.now()}`,
        type: 'ai:provider:status',
        timestamp: Date.now(),
        payload: {
          provider: 'anthropic',
          state: event.state,
          cooldownEndsAt: event.cooldownEndsAt,
          lastErrorKind: event.lastErrorVerdict?.kind,
          userMessageKey: event.lastErrorVerdict?.userMessageKey,
        },
      } as BaseMessage);
    };
    breakerFeed.on('state-change', listener);
    deps.disposables?.push({ dispose: () => breakerFeed.off('state-change', listener) });
  }
  log('AI provider status feed wired (breaker state-change → ai:provider:status).');
}

/** Inputs for the sandforge.ai.* configuration watcher. */
export interface AIConfigListenerDeps {
  services: Services;
  run: () => Promise<void>;
  log: (msg: string) => void;
}

/**
 * Re-initialise the AI stack when any sandforge.ai.* setting changes.
 * Memoised adapters are invalidated first so provider/model changes take
 * effect immediately (the API key is re-read lazily on the next call).
 *
 * @returns the Disposable — the caller MUST push it to context.subscriptions.
 */
export function registerAIConfigListener(deps: AIConfigListenerDeps): vscode.Disposable {
  const { services, run, log } = deps;
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('sandforge.ai')) return;
    services.aiClient.invalidate();
    run().catch((err) => log(`Failed to re-init AI: ${String(err)}`));
  });
}
