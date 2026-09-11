import * as vscode from 'vscode';
import { AI_CONFIG, AI_PROVIDER } from '@sandforge/shared';
import type { BaseMessage } from '@sandforge/shared';
import type { Services } from '../services.js';
import type { SecretVault } from '../core/storage/SecretVault';
import type { ExtensionHandlers } from '../bridge/ExtensionHandlers';
import type { MessageBroker } from '../bridge/MessageBroker';
import type { BreakerStateChangeEvent } from '../adapters/ai/AIClient.js';

/** Inputs required to (re-)initialise the AI stack. */
export interface AICompositionDeps {
  services: Services;
  secretVault: SecretVault;
  handlers: ExtensionHandlers;
  /**
   * Broker the provider-status feed posts to. Typed as possibly-undefined to
   * mirror the module-level `broker` let in extension.ts (deactivate() clears
   * it); the feed guards with `?.`.
   */
  broker: MessageBroker | undefined;
  log: (msg: string) => void;
  /**
   * Optional disposable sink (pass `context.subscriptions`). The breaker
   * status-feed listener lands here so the disposable audit can track it —
   * the adapter's own dispose() also wipes it via removeAllListeners.
   */
  disposables?: vscode.Disposable[];
}

/**
 * Post an unsolicited `ai:status:response` so the webview learns about an AI
 * state change it never asked about. It tracks availability by message type,
 * not by correlation, so no request has to be behind this.
 */
function postAIStatus(broker: MessageBroker | undefined, enabled: boolean): void {
  broker?.postToWebview({
    id: `ai-status-${Date.now()}`,
    type: 'ai:status:response',
    timestamp: Date.now(),
    payload: {
      enabled,
      provider: enabled ? AI_PROVIDER : 'none',
      model: enabled ? AI_CONFIG.MODEL : '',
      // A fresh assistant is built on every (re-)init, so its counters start
      // at zero either way — the Settings tab re-probes for live figures.
      usage: { totalCalls: 0, totalOutputTokens: 0, averageLatencyMs: 0 },
    },
  } as BaseMessage);
}

/**
 * Take the model-backed stack away and tell the webview. Called on every path
 * that leaves AI unavailable, so unchecking `sandforge.ai.enabled` (or losing
 * the key) stops chat, NL2SOQL, pipeline drafts and automatic error
 * resolution at once instead of only after a window reload.
 */
function teardownAI(deps: AICompositionDeps, reason: string): void {
  deps.handlers.setAIAssistant(undefined);
  deps.handlers.setAIModules(undefined);
  postAIStatus(deps.broker, false);
  deps.log(reason);
}

/**
 * Wire up the AI stack — unified on services.aiClient (AnthropicAdapter
 * with circuit breaker, token budget and error redaction). The model-backed
 * half only initialises when `sandforge.ai.enabled` is true AND an API key is
 * stored under the unified `sandforge.ai.anthropic.key` secret; otherwise it
 * is torn back down, because this function re-runs on every `sandforge.ai.*`
 * change (see {@link registerAIConfigListener}).
 *
 * The rule-based analysis modules (anomaly scan, schema advice) are wired
 * before that gate: they run on local heuristics, so an org can be analysed
 * with AI off and no key stored.
 *
 * Runs via dynamic imports, so the injections land AFTER
 * `handlers.registerAll(router)` — see the late-injection contract in
 * `./lateServices.ts`.
 */
export async function initAIComposition(deps: AICompositionDeps): Promise<void> {
  const { services, secretVault, handlers, broker, log } = deps;

  // Rule-based analysis: no provider, no key, no network. Wired on the way in
  // so the AI gate below can never take it away.
  const [{ AnomalyDetector }, { SchemaAdvisor }] = await Promise.all([
    import('../modules/ai/AnomalyDetector.js'),
    import('../modules/ai/SchemaAdvisor.js'),
  ]);
  handlers.setRuleModules({
    anomalyDetector: new AnomalyDetector(),
    schemaAdvisor: new SchemaAdvisor(),
  });
  log('Rule-based analysis modules initialized (anomaly scan, schema advice).');

  if (!services.isAIEnabled()) {
    teardownAI(deps, 'AI disabled (sandforge.ai.enabled=false) — skipping AI init.');
    return;
  }
  const apiKey = await secretVault.getSecret('ai.anthropic.key');
  if (!apiKey) {
    teardownAI(
      deps,
      'AI enabled but no API key stored (sandforge.ai.anthropic.key) — skipping AI init.',
    );
    return;
  }

  // Meter the session BEFORE the first call can be made. The memoised adapter
  // is the single chokepoint every AI feature funnels through — chat, NL2SOQL,
  // pipeline generation, error resolution, Seed personas and AI field rules all
  // call `services.aiClient().chat()` — so one budget covers them all: it
  // soft-warns at 80% and refuses further requests at 100%. The counter belongs
  // to this initialisation: it restarts whenever the AI stack is rebuilt (window
  // reload, or any `sandforge.ai.*` setting change, which re-runs this function).
  const aiClient = services.aiClient();
  aiClient.budget = services.createSessionBudget(`ai-session-${Date.now()}`, {
    send: (message) => broker?.postToWebview(message),
  });
  log(`AI session token budget attached (max ${aiClient.budget.getState().budget} tokens).`);

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

  const [{ NL2SOQL }, { ErrorResolver }, { PipelineGenerator }] = await Promise.all([
    import('../modules/ai/NL2SOQL.js'),
    import('../modules/ai/ErrorResolver.js'),
    import('../modules/ai/PipelineGenerator.js'),
  ]);

  handlers.setAIModules({
    nl2soql: new NL2SOQL(aiProvider),
    errorResolver: new ErrorResolver(aiProvider),
    pipelineGenerator: new PipelineGenerator(aiProvider),
  });
  log('AI modules (Tier 2) initialized.');
  postAIStatus(broker, true);

  // Forward breaker state changes to the webview as `ai:provider:status` —
  // the provider-status banner (cooldown countdown etc.) has been listening
  // for this channel since 04-02, but nothing ever emitted it. Subscribing
  // per init is safe: adapters are disposed on invalidate() (which removes
  // every listener), and the re-init subscribes on the fresh instance.
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
