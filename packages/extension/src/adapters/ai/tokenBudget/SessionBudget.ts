import type { AIUsage, TokenBudgetState, AIBudgetStateMessage } from '@sandforge/shared';

import type { Logger } from '../../telemetry/TelemetryAdapter.js';

const SOFT_THRESHOLD = 80;
const HARD_THRESHOLD = 100;

/** The two moments a budget tells its owner about. */
export type BudgetThreshold = 'warn' | 'exceeded';

/**
 * Where a budget reports. `send` feeds the gauge on the AI page; `notify` lets
 * the host tell the user wherever they are, since most AI calls (Seed personas,
 * NL2SOQL, error fixes) are made from pages that show no gauge. Kept this thin
 * so the class stays testable without the full MessageBroker.
 */
export interface BudgetBroker {
  send(message: AIBudgetStateMessage): void;
  /** Called once when the counter first reaches 80%, and once when calls start being refused. */
  notify?(threshold: BudgetThreshold, state: TokenBudgetState): void;
}

export interface SessionBudgetDeps {
  sessionId: string;
  budget: number;
  broker?: BudgetBroker;
  logger?: Logger;
}

/**
 * Token counter for one window session, shared by every AI feature: the AI
 * client factory builds each adapter with this one instance, and the adapter
 * is the chokepoint every AI call passes through. Rebuilding the AI stack
 * (any `sandforge.ai.*` change, a new key) keeps the count; only a window
 * reload or the `sandforge.ai.resetTokenBudget` command starts a new one.
 *
 * Counts ALL four `AIUsage` fields (input + output + cacheRead + cacheCreate)
 * — an output-only counter under-bills by 5-20×.
 *
 * Lifecycle:
 *   - activation → `new SessionBudget({ sessionId, budget })`, `connect(sink)` once the broker exists
 *   - per call   → `preflight(predictedInput)` then (after SDK) `increment(usage)`
 *   - setting    → `resize(budget)` when `tokenBudgetMaxPerSession` changes (count kept)
 *   - command    → `reset()` on `sandforge.ai.resetTokenBudget` (limit kept)
 *
 * Reports:
 *   - `ai:budget:state`    — every increment, reset and resize (the AI page gauge)
 *   - `notify('warn')`     — once, at the first 80% crossing
 *   - `notify('exceeded')` — once, when calls start being refused
 *   A resize that brings the count back under a threshold re-arms its notice.
 */
export class SessionBudget {
  private readonly sessionId: string;
  private budget: number;
  private broker?: BudgetBroker;
  private readonly logger?: Logger;

  private used: AIUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 };
  private warnFired = false;
  private exceededFired = false;

  constructor(deps: SessionBudgetDeps) {
    this.sessionId = deps.sessionId;
    this.budget = assertPositive(deps.budget);
    this.broker = deps.broker;
    this.logger = deps.logger;
  }

  /** Report to `broker` from now on (the broker is created after the budget). */
  connect(broker: BudgetBroker | undefined): void {
    this.broker = broker;
  }

  /**
   * Add the latest call's usage. Returns the new state. Always sends an
   * `ai:budget:state` envelope; gives the 80% notice ONCE at the first
   * crossing, and the refusal notice ONCE when the count reaches 100%.
   */
  increment(usage: AIUsage): TokenBudgetState {
    this.used = {
      input: safeAdd(this.used.input, usage.input),
      output: safeAdd(this.used.output, usage.output),
      cacheRead: safeAdd(this.used.cacheRead, usage.cacheRead),
      cacheCreate: safeAdd(this.used.cacheCreate, usage.cacheCreate),
      total: 0, // recomputed below
    };
    this.used.total =
      this.used.input + this.used.output + this.used.cacheRead + this.used.cacheCreate;
    const state = this.snapshot();
    this.sendState(state);
    // A call that jumps straight past 100% announces the refusal only: a
    // warning that more calls remain would already be false.
    if (state.percent >= HARD_THRESHOLD) this.announce('exceeded', state);
    else if (state.percent >= SOFT_THRESHOLD) this.announce('warn', state);
    return state;
  }

  /**
   * Pre-flight check. Returns `{ allowed: false, state }` if
   * `used.total + predictedInput > budget`, and gives the refusal notice the
   * first time that happens.
   */
  preflight(predictedInput: number): { allowed: boolean; state: TokenBudgetState } {
    const projected = this.used.total + Math.max(0, predictedInput);
    if (projected > this.budget) {
      const state: TokenBudgetState = {
        sessionId: this.sessionId,
        used: { ...this.used },
        budget: this.budget,
        percent: clampPercent((projected / this.budget) * 100),
        state: 'exceeded',
      };
      this.announce('exceeded', state);
      return { allowed: false, state };
    }
    return { allowed: true, state: this.snapshot() };
  }

  /**
   * Apply a new limit to the running count. Called when
   * `sandforge.ai.tokenBudgetMaxPerSession` changes; the count is kept, so
   * changing the setting is not a way to start over.
   */
  resize(budget: number): void {
    const next = assertPositive(budget);
    if (next === this.budget) return;
    this.budget = next;
    const state = this.snapshot();
    if (state.percent < SOFT_THRESHOLD) this.warnFired = false;
    if (state.percent < HARD_THRESHOLD) this.exceededFired = false;
    this.logger?.info(`AI token budget set to ${next} tokens, ${state.used.total} already used.`);
    this.sendState(state);
  }

  reset(): void {
    this.used = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 };
    this.warnFired = false;
    this.exceededFired = false;
    this.sendState(this.snapshot());
  }

  getState(): TokenBudgetState {
    return this.snapshot();
  }

  dispose(): void {
    this.reset();
  }

  // ── internals ──────────────────────────────────────────────────────────

  private announce(threshold: BudgetThreshold, state: TokenBudgetState): void {
    if (threshold === 'warn') {
      if (this.warnFired) return;
      this.warnFired = true;
    } else {
      if (this.exceededFired) return;
      this.exceededFired = true;
    }
    this.logger?.warn(
      `AI token budget ${threshold === 'warn' ? 'at 80%' : 'reached, calls refused'}: ` +
        `${state.used.total}/${state.budget} tokens.`,
    );
    this.broker?.notify?.(threshold, state);
  }

  private sendState(state: TokenBudgetState): void {
    this.broker?.send({
      id: `budget-${Date.now()}`,
      type: 'ai:budget:state',
      timestamp: Date.now(),
      payload: state,
    } as AIBudgetStateMessage);
  }

  private snapshot(): TokenBudgetState {
    const percent = clampPercent((this.used.total / this.budget) * 100);
    const state: TokenBudgetState['state'] =
      percent >= HARD_THRESHOLD ? 'exceeded' : percent >= SOFT_THRESHOLD ? 'warn' : 'ok';
    return {
      sessionId: this.sessionId,
      used: { ...this.used },
      budget: this.budget,
      percent,
      state,
    };
  }
}

function assertPositive(budget: number): number {
  if (!Number.isFinite(budget) || budget <= 0) {
    throw new Error('Token budget must be positive');
  }
  return budget;
}

function safeAdd(current: number, delta: number): number {
  if (!Number.isFinite(delta) || delta < 0) return current;
  return current + delta;
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p) || p < 0) return 0;
  if (p > 200) return 200;
  return p;
}
