import * as vscode from 'vscode';
import { AI_CONFIG, AI_PROVIDER, resolveAIModel } from '@sandforge/shared';
import type { BaseMessage, TokenBudgetState } from '@sandforge/shared';
import type { Services } from '../services.js';
import type { SecretVault } from '../core/storage/SecretVault';
import type { ExtensionHandlers } from '../bridge/ExtensionHandlers';
import type { MessageBroker } from '../bridge/MessageBroker';
import type { BreakerStateChangeEvent } from '../adapters/ai/AIClient.js';
import type { BudgetThreshold } from '../adapters/ai/tokenBudget/index.js';

const BUDGET_SETTING = 'sandforge.ai.tokenBudgetMaxPerSession';

/** Starts the window's AI token count over; the limit is kept. */
const RESET_BUDGET_COMMAND = 'sandforge.ai.resetTokenBudget';

/** Read under the `sandforge` section, so without its prefix. */
const ERROR_RESOLUTION_SETTING = 'ai.errorResolution';

/**
 * Number of the latest {@link initAIComposition} run. Runs are not queued —
 * every `sandforge.ai.*` change starts one — so a run checks this after each
 * await and gives way to any run started meanwhile. Otherwise a turn-on still
 * waiting for the keychain could finish after a later turn-off and put the
 * assistant back.
 */
let latestRun = 0;

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
 *
 * @param model - The model AI answers with, or undefined when AI is off.
 */
function postAIStatus(broker: MessageBroker | undefined, model?: string): void {
  broker?.postToWebview({
    id: `ai-status-${Date.now()}`,
    type: 'ai:status:response',
    timestamp: Date.now(),
    payload: {
      enabled: model !== undefined,
      provider: model !== undefined ? AI_PROVIDER : 'none',
      model: model ?? '',
    },
  } as BaseMessage);
}

/**
 * The model `sandforge.ai.model` names, the one every AI call asks. The status
 * reported the default instead, so the Settings page named a model the user
 * had replaced; and a blank setting, which the adapter reads as the default,
 * was shown as it was.
 */
function configuredModel(services: Services): string {
  return resolveAIModel(services.getSandforgeSetting<unknown>('ai.model', AI_CONFIG.MODEL));
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
  postAIStatus(deps.broker);
  deps.log(reason);
}

/**
 * Wire up the AI stack — unified on services.aiClient (AnthropicAdapter
 * with circuit breaker, token budget and error redaction). The model-backed
 * half only initialises when `sandforge.ai.enabled` is true, an API key is
 * stored under the unified `sandforge.ai.anthropic.key` secret and the
 * provider is Anthropic; otherwise it is torn back down, because this function
 * re-runs on every `sandforge.ai.*` change (see {@link registerAIConfigListener}).
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
  const run = ++latestRun;
  const superseded = (): boolean => run !== latestRun;

  // Rule-based analysis: no provider, no key, no network. Wired on the way in
  // so the AI gate below can never take it away, and a failure to load it is
  // logged rather than allowed to stop that gate from running.
  try {
    const [{ AnomalyDetector }, { SchemaAdvisor }] = await Promise.all([
      import('../modules/ai/AnomalyDetector.js'),
      import('../modules/ai/SchemaAdvisor.js'),
    ]);
    handlers.setRuleModules({
      anomalyDetector: new AnomalyDetector(),
      schemaAdvisor: new SchemaAdvisor(),
    });
    log('Rule-based analysis modules initialized (anomaly scan, schema advice).');
  } catch (err) {
    log(`Rule-based analysis modules failed to load: ${String(err)}`);
  }
  if (superseded()) return;

  if (!services.isAIEnabled()) {
    teardownAI(deps, 'AI disabled (sandforge.ai.enabled=false) — skipping AI init.');
    return;
  }
  const apiKey = await secretVault.getSecret('ai.anthropic.key');
  if (superseded()) return;
  if (!apiKey) {
    teardownAI(
      deps,
      'AI enabled but no API key stored (sandforge.ai.anthropic.key) — skipping AI init.',
    );
    return;
  }
  // Only the Anthropic adapter reaches a model: the openai and custom ones
  // throw on every call. The setting no longer offers them, but a settings.json
  // can still name one, and AI must then be reported off, not available.
  const provider = services.getSandforgeSetting<string>('ai.provider', AI_PROVIDER);
  if (provider !== AI_PROVIDER) {
    teardownAI(
      deps,
      `AI provider "${provider}" is not implemented (only ${AI_PROVIDER} is) — skipping AI init.`,
    );
    return;
  }

  const { AIAssistant } = await import('../modules/ai/AIAssistant.js');
  if (superseded()) return;

  // Every AI feature — chat, NL2SOQL, pipeline generation, error resolution,
  // Seed personas and AI field rules — calls `services.aiClient().chat()`, and
  // the factory builds that adapter with the window's one token budget. They
  // are metered from the first call, including calls made while this runs.
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
    model: configuredModel(services),
    maxTokens: AI_CONFIG.MAX_TOKENS,
  });

  // Wire up the AI modules using the same unified client
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
  if (superseded()) return;

  // A failed run asks the model on its own, with nobody pressing anything, so
  // it has a switch of its own next to the AI one. Off, no resolver is
  // injected and the failure is answered from the built-in table of error
  // codes or not at all — the rest of the assistant is untouched.
  const resolveFailures = services.getSandforgeSetting(ERROR_RESOLUTION_SETTING, true);

  // Installed together after the last await, so a run that gives way never
  // leaves half a stack behind.
  handlers.setAIAssistant(aiAssistant);
  log('AI Assistant initialized (unified adapter stack).');
  handlers.setAIModules({
    nl2soql: new NL2SOQL(aiProvider),
    // The display language travels from here: the resolver builds the prompt,
    // and nothing under `modules/` reads the host.
    ...(resolveFailures
      ? { errorResolver: new ErrorResolver(aiProvider, vscode.env.language) }
      : {}),
    pipelineGenerator: new PipelineGenerator(aiProvider),
  });
  if (!resolveFailures) {
    log('Error resolution disabled (sandforge.ai.errorResolution=false) — no failure is sent.');
  }
  log('AI modules initialized.');
  postAIStatus(broker, configuredModel(services));

  // Forward breaker state changes to the webview as `ai:provider:status` —
  // the provider-status banner (cooldown countdown etc.) had been listening
  // for this channel from the start, but nothing ever emitted it. Subscribing
  // per init is safe: adapters are disposed on invalidate() (which removes
  // every listener), and the re-init subscribes on the fresh instance.
  const breakerFeed = services.aiClient().breakerEvents;
  if (breakerFeed) {
    const listener = (event: BreakerStateChangeEvent): void => {
      broker?.postToWebview({
        id: `ai-status-${Date.now()}`,
        type: 'ai:provider:status',
        timestamp: Date.now(),
        payload: {
          provider: AI_PROVIDER,
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

/**
 * Connect the window's token budget to the AI page gauge and to host notices.
 * Called once from activate(), after the broker exists. The notices come from
 * the host because most AI calls — Seed personas, NL2SOQL, error fixes — are
 * made from pages that show no gauge.
 */
export function wireBudgetReporting(
  services: Pick<Services, 'sessionBudget'>,
  broker: MessageBroker | undefined,
): void {
  services.sessionBudget.connect({
    send: (message) => broker?.postToWebview(message),
    notify: (threshold, state) => {
      void showBudgetNotice(threshold, state);
    },
  });
}

async function showBudgetNotice(
  threshold: BudgetThreshold,
  state: TokenBudgetState,
): Promise<void> {
  const openSettings = vscode.l10n.t('Open Settings');
  const used = `${state.used.total}/${state.budget}`;
  const message =
    threshold === 'warn'
      ? vscode.l10n.t(
          'SandForge: {0}% of the AI token budget for this window is used ({1} tokens). AI requests are refused at 100%.',
          Math.floor(state.percent),
          used,
        )
      : vscode.l10n.t(
          'SandForge: AI requests are refused — they would exceed the AI token budget for this window ({0} tokens used). Raise sandforge.ai.tokenBudgetMaxPerSession, or run SandForge: Reset AI Token Budget, to continue.',
          used,
        );
  // Once calls are refused, the reset is offered where the user reads why.
  const resetBudget = vscode.l10n.t('Reset Budget');
  const actions = threshold === 'exceeded' ? [openSettings, resetBudget] : [openSettings];
  const choice = await vscode.window.showWarningMessage(message, ...actions);
  if (choice === openSettings) {
    await vscode.commands.executeCommand('workbench.action.openSettings', BUDGET_SETTING);
  } else if (choice === resetBudget) {
    await vscode.commands.executeCommand(RESET_BUDGET_COMMAND);
  }
}

/** Inputs for the command that resets the AI token budget. */
export interface TokenBudgetResetDeps {
  services: Pick<Services, 'sessionBudget'>;
  log: (msg: string) => void;
}

/**
 * Register `sandforge.ai.resetTokenBudget`: start this window's AI token count
 * over without reloading the window. The limit stays what the setting says.
 * The budget reports the reset itself (`ai:budget:state`, so the AI page gauge
 * follows) and re-arms its 80% and refusal notices.
 *
 * @returns the Disposable — the caller MUST push it to context.subscriptions.
 */
export function registerTokenBudgetReset(deps: TokenBudgetResetDeps): vscode.Disposable {
  const { services, log } = deps;
  return vscode.commands.registerCommand(RESET_BUDGET_COMMAND, () => {
    const used = services.sessionBudget.getState().used.total;
    services.sessionBudget.reset();
    const { budget } = services.sessionBudget.getState();
    log(`AI token budget reset: ${used} tokens used before, ${budget} available.`);
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'SandForge: the AI token budget for this window is reset — {0} tokens available.',
        budget,
      ),
    );
  });
}

/** Inputs for the sandforge.ai.* configuration watcher. */
export interface AIConfigListenerDeps {
  services: Services;
  run: () => Promise<void>;
  log: (msg: string) => void;
}

/**
 * Build the rebuild step shared by the configuration watcher and the key-save
 * flow: drop the memoised adapters, so the next call builds an SDK client
 * from the current settings and key, then re-run the composition.
 */
export function createAIReinit(deps: AIConfigListenerDeps): () => Promise<void> {
  const { services, run } = deps;
  return () => {
    services.aiClient.invalidate();
    return run();
  };
}

/**
 * Re-initialise the AI stack when any sandforge.ai.* setting changes.
 * Memoised adapters are invalidated first so provider/model changes take
 * effect immediately (the API key is re-read lazily on the next call). The
 * token count survives the rebuild; only its limit follows the budget setting.
 *
 * @returns the Disposable — the caller MUST push it to context.subscriptions.
 */
export function registerAIConfigListener(deps: AIConfigListenerDeps): vscode.Disposable {
  const { services, log } = deps;
  const reinit = createAIReinit(deps);
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('sandforge.ai')) return;
    if (e.affectsConfiguration(BUDGET_SETTING)) {
      services.sessionBudget.resize(services.readTokenBudget());
    }
    reinit().catch((err) => log(`Failed to re-init AI: ${String(err)}`));
  });
}
