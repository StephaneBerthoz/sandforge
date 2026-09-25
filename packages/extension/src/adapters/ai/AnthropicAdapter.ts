import { EventEmitter } from 'node:events';

// Type-only import: the SDK (~104 KB minified, ~1 MB on disk) is loaded
// lazily via dynamic import() in getClient() so extension activation never
// pays its require cost. esbuild marks it external and the build vendors a
// pruned copy into dist/node_modules (scripts/vendor-ai-sdk.mjs).
// `resolution-mode: import` pins the types to the SDK's ESM entrypoint (.d.mts)
// so the class identity matches the value-side dynamic import() below — under
// Node16 a plain `import type` resolves to the .d.ts twin whose #private field
// is nominal-incompatible with it.
import type Anthropic from '@anthropic-ai/sdk' with { 'resolution-mode': 'import' };
import { AI_CONFIG, resolveAIModel, type AIUsage, type TokenBudgetState } from '@sandforge/shared';

import type { SessionBudget } from './tokenBudget/SessionBudget.js';

import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { TelemetryAdapter, Logger } from '../telemetry/TelemetryAdapter.js';
import { CircuitBreaker } from '../../core/connection/CircuitBreaker.js';
import {
  classifyAnswer,
  classifyAnthropicError,
  type AIAnswerProblem,
  type AIAnswerVerdict,
  type AIErrorVerdict,
} from './errorClassifier.js';
import type { AIChatOpts, AIChatResult, AIClient, AIProviderType } from './AIClient.js';

// Re-exported for backward compatibility — the canonical declarations live in
// AIClient.ts (the AIClient interface exposes the optional feed).
export type { BreakerState, BreakerStateChangeEvent } from './AIClient.js';
import type { BreakerState, BreakerStateChangeEvent } from './AIClient.js';

const SECRET_KEY = 'sandforge.ai.anthropic.key';

/**
 * The models documented to accept `thinking: {type: "disabled"}`, from the
 * table of thinking support by model at
 * https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
 *
 * Claude Sonnet 5 thinks unless told not to, and its thinking counts against
 * `max_tokens`: the 4 096 tokens every feature was sized for under Claude
 * Sonnet 4.5 could be spent before the answer was written. Its migration guide
 * gives `disabled` as the way to keep Sonnet 4.5's behaviour, and the models
 * listed here take it without complaint.
 *
 * Every other model is sent no `thinking` at all. Claude Opus 5.5 and the Fable
 * and Mythos models always think and answer `disabled` with a 400; Claude Opus
 * 5 takes it only below effort `xhigh`, and the same page reports it sometimes
 * writing XML tags into its text with thinking off, in replies these features
 * parse as JSON. A model released after this list may think always: leaving
 * the parameter out is the one request no model refuses.
 */
const THINKING_OFF_MODELS: ReadonlySet<string> = new Set([
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-opus-4-5',
  'claude-opus-4-5-20251101',
  'claude-sonnet-4-5',
  'claude-sonnet-4-5-20250929',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
]);

const THINKING_OFF: Anthropic.ThinkingConfigDisabled = { type: 'disabled' };

/** English text of an answer the adapter does not hand on, when the host supplies none. */
const ANSWER_PROBLEM_MESSAGES: Record<AIAnswerProblem, string> = {
  refused:
    'The model declined to answer this request. Rephrase it, or choose another model in sandforge.ai.model.',
  truncated:
    'The model stopped at its length limit before the answer was complete, so SandForge did not use it. Ask for less in one request.',
  empty: 'The model returned an empty answer. Try again.',
};

export interface AnthropicAdapterDeps {
  storage: StorageAdapter;
  telemetry?: TelemetryAdapter;
  logger?: Logger;
  model?: string;
  breaker?: CircuitBreaker;
  budget?: SessionBudget;
  /**
   * The error text of a call the budget refuses, in the UI language. The host
   * supplies it; left undefined, the text is English.
   */
  budgetRefusalMessage?: (state: TokenBudgetState) => string;
  /**
   * The error text of an answer that came back refused, cut off or empty, in
   * the UI language. The host supplies it; left undefined, the text is English.
   */
  answerProblemMessage?: (problem: AIAnswerProblem) => string;
}

/**
 * Map the underlying CircuitBreaker's snake_case state to the camel/dash form
 * the bridge envelope (`ai:provider:status`) uses.
 */
function mapBreakerState(internal: string): BreakerState {
  switch (internal) {
    case 'closed':
      return 'closed';
    case 'open':
      return 'open';
    case 'half_open':
      return 'half-open';
    default:
      return 'closed';
  }
}

/**
 * AnthropicAdapter — happy-path implementation of AIClient with a per-provider
 * CircuitBreaker (3 consecutive failures → open for 5 min) and a per-AI-request
 * AbortController so a single user-cancel does not affect siblings.
 *
 * Lazy: SecretStorage is read on first call, never at construction.
 *
 * A 529 / `overloaded_error` trips the breaker; a cancel does not. Each call
 * allocates its own AbortController; the caller's signal is mirrored via a
 * one-way listener so cancelling the caller aborts only that request.
 */
export class AnthropicAdapter implements AIClient {
  public readonly provider: AIProviderType = 'anthropic';
  public readonly breaker: CircuitBreaker;
  public readonly breakerEvents = new EventEmitter();
  /**
   * Token budget for the window, shared by every AI feature. The AI client
   * factory builds each adapter with the same instance, so a rebuilt adapter
   * keeps the count. Left undefined (tests), the adapter is unmetered.
   */
  public budget?: SessionBudget;

  private client: Anthropic | null = null;
  /**
   * In-flight client construction, shared by every concurrent caller.
   *
   * Without it two concurrent AI calls each ran the whole of `getClient()`:
   * two `SecretStorage` round-trips, two SDK module loads, two `Anthropic`
   * instances, and `this.client` left holding whichever finished last. The
   * "construction is cached" invariant only held for sequential callers.
   */
  private clientPromise: Promise<Anthropic> | null = null;
  private readonly storage: StorageAdapter;
  private readonly telemetry?: TelemetryAdapter;
  private readonly logger?: Logger;
  private readonly model: string;
  private readonly budgetRefusalMessage?: (state: TokenBudgetState) => string;
  private readonly answerProblemMessage?: (problem: AIAnswerProblem) => string;
  private readonly inFlight = new Set<AbortController>();

  /** Last reported state — used to debounce state-change events. */
  private lastReportedState: BreakerState = 'closed';

  constructor(deps: AnthropicAdapterDeps) {
    this.storage = deps.storage;
    this.telemetry = deps.telemetry;
    this.logger = deps.logger;
    this.model = resolveAIModel(deps.model);
    this.breaker =
      deps.breaker ??
      new CircuitBreaker({
        failureThreshold: 3,
        resetTimeout: 300_000,
        halfOpenRequests: 1,
      });
    this.budget = deps.budget;
    this.budgetRefusalMessage = deps.budgetRefusalMessage;
    this.answerProblemMessage = deps.answerProblemMessage;
  }

  /**
   * Cheap input-token estimate for the preflight: chars/4, the ratio for
   * English prose. It under-estimates code, JSON and non-Latin text such as
   * Japanese, which take more tokens per character, so a call the budget
   * cannot afford can still be let through. What the counter adds is the usage
   * the SDK reports after the call, so the overshoot is bounded to that one
   * call. `messages.countTokens` would be exact, at a network round-trip per
   * call.
   */
  private estimateInputTokens(payload: {
    messages?: { content: string }[];
    system?: string;
  }): number {
    const messagesChars =
      payload.messages?.reduce((sum, m) => sum + (m.content?.length ?? 0), 0) ?? 0;
    const systemChars = payload.system?.length ?? 0;
    return Math.ceil((messagesChars + systemChars) / 4);
  }

  // ── public AIClient surface ──────────────────────────────────────────────

  /**
   * Ask the model, and resolve with an answer a feature can use.
   *
   * The request carries the model, its token cap, the system prompt and the
   * messages, plus `thinking: {type: "disabled"}` for the models documented to
   * take it (see {@link THINKING_OFF_MODELS}). It carries no `temperature`,
   * `top_p` or `top_k`: every model from Claude Opus 4.7 on, Claude Sonnet 5
   * among them, answers a non-default value of any of them with a 400.
   *
   * An answer the model declined, one cut off before it was complete, and one
   * with no text are rejected here rather than handed on (see
   * {@link classifyAnswer}). Their tokens were spent, so the budget counts
   * them; the provider answered, so the breaker counts a success.
   */
  async chat(opts: AIChatOpts): Promise<AIChatResult> {
    this.budgetPreflight({ messages: opts.messages, system: opts.system });
    const result = await this.runWithBreaker(
      'chat',
      async (signal) => {
        const client = await this.getClient();
        const resp = await client.messages.create(
          {
            model: this.model,
            max_tokens: opts.maxTokens ?? AI_CONFIG.MAX_TOKENS,
            system: opts.system,
            messages: opts.messages,
            ...(THINKING_OFF_MODELS.has(this.model) ? { thinking: THINKING_OFF } : {}),
          },
          { signal },
        );
        const text = resp.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('');
        const usage = this.buildUsage(resp.usage);
        this.budget?.increment(usage);
        this.breadcrumb('chat', usage);
        return {
          text,
          usage,
          model: resp.model,
          stopReason: resp.stop_reason,
        };
      },
      opts.signal,
    );
    const problem = classifyAnswer(result.stopReason, result.text);
    if (problem) throw this.answerProblemError(problem, result);
    return result;
  }

  /**
   * The error an unusable answer fails its call with. Its message is written
   * for the user and shown as it is by the page that asked, so it carries no
   * `[ai:kind]` prefix; the kind travels on `aiErrorVerdict`.
   */
  private answerProblemError(verdict: AIAnswerVerdict, result: AIChatResult): Error {
    this.logger?.warn(
      { model: result.model, stopReason: result.stopReason, problem: verdict.kind },
      'anthropic answer not used',
    );
    const err = new Error(
      this.answerProblemMessage?.(verdict.kind) ?? ANSWER_PROBLEM_MESSAGES[verdict.kind],
    );
    (err as Error & { aiErrorVerdict?: AIErrorVerdict }).aiErrorVerdict = verdict;
    return err;
  }

  /**
   * Pre-flight budget check. Throws an AI_BUDGET_EXCEEDED error BEFORE
   * any SDK call when the projected total would breach the budget.
   * Does NOT affect the breaker (budget rejection is a user-facing limit,
   * not a provider failure).
   */
  private budgetPreflight(payload: Parameters<typeof this.estimateInputTokens>[0]): void {
    if (!this.budget) return;
    const predicted = this.estimateInputTokens(payload);
    const result = this.budget.preflight(predicted);
    if (!result.allowed) {
      const err = new Error(
        this.budgetRefusalMessage?.(result.state) ??
          `AI token budget exceeded for this session (${result.state.used.total}/${result.state.budget} tokens used). ` +
            'Raise sandforge.ai.tokenBudgetMaxPerSession in Settings, or run SandForge: Reset AI Token Budget, to continue.',
      );
      (err as Error & { code?: string }).code = 'AI_BUDGET_EXCEEDED';
      (err as Error & { budgetState?: typeof result.state }).budgetState = result.state;
      throw err;
    }
  }

  /**
   * Abort every in-flight request. Returns the count cancelled. Used by panel-
   * close cleanup so a closed AI panel does not leak running SDK calls.
   */
  cancelAll(): number {
    const count = this.inFlight.size;
    for (const ctrl of this.inFlight) {
      try {
        ctrl.abort();
      } catch {
        // best-effort
      }
    }
    this.inFlight.clear();
    return count;
  }

  dispose(): void {
    this.cancelAll();
    this.breakerEvents.removeAllListeners();
    this.client = null;
    this.clientPromise = null;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private async runWithBreaker<R>(
    method: 'chat',
    runner: (signal: AbortSignal) => Promise<R>,
    externalSignal?: AbortSignal,
  ): Promise<R> {
    // Fast-fail when the breaker is open and not yet ready for half-open.
    if (!this.breaker.acquirePermit()) {
      this.maybeEmitStateChange();
      throw new Error('AI provider circuit breaker open. Try again in ~5 min.');
    }

    const ctrl = new AbortController();
    this.inFlight.add(ctrl);
    let abortListener: (() => void) | undefined;
    if (externalSignal) {
      if (externalSignal.aborted) {
        ctrl.abort(externalSignal.reason);
      } else {
        abortListener = () => ctrl.abort(externalSignal.reason);
        externalSignal.addEventListener('abort', abortListener);
      }
    }

    try {
      const result = await runner(ctrl.signal);
      this.breaker.recordSuccess();
      this.maybeEmitStateChange();
      this.breaker.releasePermit();
      return result;
    } catch (err) {
      const verdict = classifyAnthropicError(err);
      if (verdict.shouldTripBreaker) {
        this.breaker.recordFailure();
        this.telemetryBreakerFailure(verdict);
      } else if (verdict.kind !== 'cancelled') {
        // Non-trip failure (auth / invalid-request / transient): record success
        // so the consecutive-failure counter does not accumulate against us.
        this.breaker.recordSuccess();
      }
      this.breaker.releasePermit();
      this.maybeEmitStateChange(verdict);
      throw this.rewrap(err, verdict, method);
    } finally {
      if (abortListener && externalSignal) {
        externalSignal.removeEventListener('abort', abortListener);
      }
      this.inFlight.delete(ctrl);
    }
  }

  private getClient(): Promise<Anthropic> {
    if (this.client) return Promise.resolve(this.client);
    // Concurrent callers share one construction. A failure clears the slot so
    // the next call retries instead of replaying a rejected promise forever.
    this.clientPromise ??= this.createClient().catch((err: unknown) => {
      this.clientPromise = null;
      throw err;
    });
    return this.clientPromise;
  }

  private async createClient(): Promise<Anthropic> {
    const apiKey = await this.storage.getSecret(SECRET_KEY);
    if (!apiKey) {
      throw new Error(
        // No command sets the key: the only place that stores one is the
        // Settings page of the webview.
        'Anthropic API key not configured. Add it in SandForge Settings > AI > API key.',
      );
    }
    // Lazy SDK load: the require only happens on the first actual AI call,
    // never at activation (the SDK is external to the bundle).
    const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
    // The breaker counts one failure per call. The SDK's own two retries
    // would make each counted failure up to three requests to the provider.
    const client: Anthropic = new AnthropicClient({ apiKey, maxRetries: 0 });
    this.client = client;
    return client;
  }

  private buildUsage(raw: Anthropic.Usage | undefined | null): AIUsage {
    const input = raw?.input_tokens ?? 0;
    const output = raw?.output_tokens ?? 0;
    const cacheRead = raw?.cache_read_input_tokens ?? 0;
    const cacheCreate = raw?.cache_creation_input_tokens ?? 0;
    return {
      input,
      output,
      cacheRead,
      cacheCreate,
      total: input + output + cacheRead + cacheCreate,
    };
  }

  private maybeEmitStateChange(verdict?: AIErrorVerdict): void {
    const current = mapBreakerState(this.breaker.getState());
    if (current === this.lastReportedState && verdict?.kind !== 'overloaded') {
      // No state change AND no overloaded incident worth surfacing again.
      return;
    }
    this.lastReportedState = current;
    const event: BreakerStateChangeEvent = {
      state: current,
      lastErrorVerdict: verdict,
      cooldownEndsAt: current === 'open' ? new Date(Date.now() + 300_000).toISOString() : undefined,
    };
    try {
      this.breakerEvents.emit('state-change', event);
    } catch {
      // listener errors must not crash the adapter
    }
    if (current === 'open' && this.logger) {
      this.logger.warn(
        { provider: this.provider, lastErrorKind: verdict?.kind },
        'AI provider circuit breaker OPEN',
      );
    }
  }

  private rewrap(err: unknown, verdict: AIErrorVerdict, _method: string): Error {
    if (verdict.kind === 'cancelled') {
      // Preserve the original APIUserAbortError reference so callers can do
      // `if (err instanceof APIUserAbortError)`. Duck-typed by name (same
      // rationale as errorClassifier): the SDK class is not statically
      // importable here now that the SDK loads lazily.
      if (
        err &&
        typeof err === 'object' &&
        (err as { name?: string }).name === 'APIUserAbortError'
      ) {
        return err as Error;
      }
      // External-signal-driven abort surfaces as DOMException 'AbortError' in
      // Node — also pass through unwrapped for the same reason.
      if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') {
        return err as Error;
      }
    }
    const msg = `[ai:${verdict.kind}] ${this.extractAndRedactErrorMessage(err)}`;
    const wrapped = new Error(msg);
    (wrapped as Error & { aiErrorVerdict?: AIErrorVerdict }).aiErrorVerdict = verdict;
    (wrapped as Error & { cause?: unknown }).cause = err;
    return wrapped;
  }

  /**
   * Strip API-key-shaped substrings from an SDK error message before
   * surfacing it to logs / handlers.
   */
  private extractAndRedactErrorMessage(err: unknown): string {
    const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : String(err);
    return raw.replace(/[A-Za-z0-9_-]{32,}/g, '***REDACTED***');
  }

  private telemetryBreakerFailure(verdict: AIErrorVerdict): void {
    if (!this.telemetry) return;
    try {
      this.telemetry.addBreadcrumb(
        `breaker_failure kind=${verdict.kind} status=${verdict.rawStatus ?? '?'}`,
        'ai',
        'warning',
      );
    } catch {
      // best-effort
    }
  }

  private breadcrumb(method: 'chat', usage: AIUsage): void {
    if (!this.telemetry) return;
    try {
      this.telemetry.addBreadcrumb(
        `anthropic_call method=${method} model=${this.model} total=${usage.total}`,
        'ai',
        'info',
      );
    } catch {
      // telemetry is best-effort
    }
    if (this.logger) {
      this.logger.debug({ method, model: this.model, totalTokens: usage.total }, 'anthropic call');
    }
  }
}
