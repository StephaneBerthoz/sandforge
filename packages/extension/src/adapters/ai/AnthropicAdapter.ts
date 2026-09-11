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
import type { AIUsage } from '@sandforge/shared';

import type { SessionBudget } from './tokenBudget/SessionBudget.js';

import type { StorageAdapter } from '../storage/StorageAdapter.js';
import type { TelemetryAdapter, Logger } from '../telemetry/TelemetryAdapter.js';
import { CircuitBreaker } from '../../core/connection/CircuitBreaker.js';
import { classifyAnthropicError, type AIErrorVerdict } from './errorClassifier.js';
import type {
  AIChatOpts,
  AIChatResult,
  AIClient,
  AICountTokensOpts,
  AICountTokensResult,
  AIProviderType,
} from './AIClient.js';

// Re-exported for backward compatibility — the canonical declarations live in
// AIClient.ts (the AIClient interface exposes the optional feed).
export type { BreakerState, BreakerStateChangeEvent } from './AIClient.js';
import type { BreakerState, BreakerStateChangeEvent } from './AIClient.js';

const DEFAULT_MODEL = 'claude-sonnet-4-5-20250929';
const SECRET_KEY = 'sandforge.ai.anthropic.key';

export interface AnthropicAdapterDeps {
  storage: StorageAdapter;
  telemetry?: TelemetryAdapter;
  logger?: Logger;
  model?: string;
  breaker?: CircuitBreaker;
  budget?: SessionBudget;
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
 * RESEARCH Pitfall #2: 529 / overloaded_error trips the breaker. Cancel does
 * not. RESEARCH Pitfall #3: each call allocates its own AbortController; the
 * caller's signal is mirrored via a one-way listener so cancelling the caller
 * aborts only that request.
 */
export class AnthropicAdapter implements AIClient {
  public readonly provider: AIProviderType = 'anthropic';
  public readonly breaker: CircuitBreaker;
  public readonly breakerEvents = new EventEmitter();
  /**
   * Per-panel-session budget (Plan 04-05). Mutable via field assignment so
   * the panel-open lifecycle can attach a fresh budget without re-creating
   * the adapter. Set to undefined on panel-close to disable budget logic.
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
  private readonly inFlight = new Set<AbortController>();

  /** Last reported state — used to debounce state-change events. */
  private lastReportedState: BreakerState = 'closed';

  constructor(deps: AnthropicAdapterDeps) {
    this.storage = deps.storage;
    this.telemetry = deps.telemetry;
    this.logger = deps.logger;
    this.model = deps.model ?? DEFAULT_MODEL;
    this.breaker =
      deps.breaker ??
      new CircuitBreaker({
        failureThreshold: 3,
        resetTimeout: 300_000,
        halfOpenRequests: 1,
      });
    this.budget = deps.budget;
  }

  /**
   * Cheap input-token estimator. The Anthropic SDK provides
   * `messages.countTokens` for an authoritative answer, but that's a network
   * round-trip per preflight — too expensive for the night-mode shipping
   * scope. Heuristic ≈ chars/4 (Claude's average tokenizer ratio for
   * English text); slightly over-estimates which is the safe direction
   * for budget refusal.
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

  async chat(opts: AIChatOpts): Promise<AIChatResult> {
    this.budgetPreflight({ messages: opts.messages, system: opts.system });
    return this.runWithBreaker(
      'chat',
      async (signal) => {
        const client = await this.getClient();
        const resp = await client.messages.create(
          {
            model: this.model,
            max_tokens: opts.maxTokens ?? 4096,
            system: opts.system,
            messages: opts.messages,
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
  }

  async countTokens(opts: AICountTokensOpts): Promise<AICountTokensResult> {
    return this.runWithBreaker('countTokens', async (_signal) => {
      const client = await this.getClient();
      const resp = await client.messages.countTokens({
        model: this.model,
        system: opts.system,
        messages: opts.messages,
      });
      return { inputTokens: resp.input_tokens };
    });
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
      const err = new Error('AI token budget exceeded for this panel session');
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
    method: 'chat' | 'countTokens',
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
        'Anthropic API key not configured. Set it in Command Palette → SandForge: Configure AI Key.',
      );
    }
    // Lazy SDK load: the require only happens on the first actual AI call,
    // never at activation (the SDK is external to the bundle).
    const { default: AnthropicClient } = await import('@anthropic-ai/sdk');
    const client: Anthropic = new AnthropicClient({ apiKey });
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
   * surfacing it to logs / handlers (P-04.7).
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

  private breadcrumb(method: 'chat' | 'countTokens', usage: AIUsage): void {
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
