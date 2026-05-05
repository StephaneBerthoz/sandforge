import type {
  AIUsage,
  TokenBudgetState,
  AIBudgetStateMessage,
  AIBudgetWarnMessage,
  AIBudgetExceededMessage,
} from '@sandforge/shared';

import type { Logger } from '../../telemetry/TelemetryAdapter.js';

const SOFT_THRESHOLD = 80;
const HARD_THRESHOLD = 100;
const SETTINGS_KEY = 'sandforge.ai.tokenBudgetMaxPerSession' as const;

/**
 * Lightweight bridge subset — `SessionBudget` only needs to send envelopes.
 * The handler / panel that owns the budget passes a thin send() callback.
 * Keeps the class fully testable without the full MessageBroker.
 */
export interface BudgetBroker {
  send(message: AIBudgetStateMessage | AIBudgetWarnMessage | AIBudgetExceededMessage): void;
}

export interface SessionBudgetDeps {
  sessionId: string;
  budget: number;
  broker?: BudgetBroker;
  logger?: Logger;
}

/**
 * Per-panel-session token counter.
 *
 * Counts ALL four `AIUsage` fields (input + output + cacheRead + cacheCreate)
 * — RESEARCH P-04.6: output-only counters under-bill 5-20×.
 *
 * Lifecycle:
 *   - panel-open  → `new SessionBudget({ sessionId, budget, broker })`
 *   - per-call    → `preflight(predictedInput)` then (after SDK) `increment(usage)`
 *   - panel-close → `dispose()` (alias of `reset()` — clears state)
 *
 * Envelopes:
 *   - `ai:budget:state`     — every increment + reset (mini-bar live update)
 *   - `ai:budget:warn`      — exactly once per session at the first 80% crossing
 *   - `ai:budget:exceeded`  — every breach call AND every failing preflight
 */
export class SessionBudget {
  private readonly sessionId: string;
  private readonly budget: number;
  private readonly broker?: BudgetBroker;
  private readonly logger?: Logger;

  private used: AIUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 };
  private warnFired = false;

  constructor(deps: SessionBudgetDeps) {
    if (!Number.isFinite(deps.budget) || deps.budget <= 0) {
      throw new Error('Token budget must be positive');
    }
    this.sessionId = deps.sessionId;
    this.budget = deps.budget;
    this.broker = deps.broker;
    this.logger = deps.logger;
  }

  /**
   * Add the latest call's usage. Returns the new state. Always sends an
   * `ai:budget:state` envelope; sends `ai:budget:warn` ONCE at the first
   * 80% crossing; sends `ai:budget:exceeded` on every call past 100%.
   */
  increment(usage: AIUsage): TokenBudgetState {
    this.used = {
      input: safeAdd(this.used.input, usage.input),
      output: safeAdd(this.used.output, usage.output),
      cacheRead: safeAdd(this.used.cacheRead, usage.cacheRead),
      cacheCreate: safeAdd(this.used.cacheCreate, usage.cacheCreate),
      total: 0, // recomputed below
    };
    this.used.total = this.used.input + this.used.output + this.used.cacheRead + this.used.cacheCreate;
    const state = this.snapshot();
    this.broker?.send({
      id: `budget-${Date.now()}`,
      type: 'ai:budget:state',
      timestamp: Date.now(),
      payload: state,
    } as AIBudgetStateMessage);
    if (state.percent >= SOFT_THRESHOLD && !this.warnFired) {
      this.warnFired = true;
      this.broker?.send({
        id: `budget-warn-${Date.now()}`,
        type: 'ai:budget:warn',
        timestamp: Date.now(),
        payload: state,
      } as AIBudgetWarnMessage);
    }
    if (state.percent >= HARD_THRESHOLD) {
      this.broker?.send({
        id: `budget-exceeded-${Date.now()}`,
        type: 'ai:budget:exceeded',
        timestamp: Date.now(),
        payload: { ...state, settingsKey: SETTINGS_KEY },
      } as AIBudgetExceededMessage);
    }
    return state;
  }

  /**
   * Pre-flight check. Returns `{ allowed: false, state }` and sends
   * `ai:budget:exceeded` if `used.total + predictedInput > budget`.
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
      this.broker?.send({
        id: `budget-exceeded-${Date.now()}`,
        type: 'ai:budget:exceeded',
        timestamp: Date.now(),
        payload: { ...state, settingsKey: SETTINGS_KEY },
      } as AIBudgetExceededMessage);
      return { allowed: false, state };
    }
    return { allowed: true, state: this.snapshot() };
  }

  reset(): void {
    this.used = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 };
    this.warnFired = false;
    const state = this.snapshot();
    this.broker?.send({
      id: `budget-${Date.now()}`,
      type: 'ai:budget:state',
      timestamp: Date.now(),
      payload: state,
    } as AIBudgetStateMessage);
  }

  getState(): TokenBudgetState {
    return this.snapshot();
  }

  dispose(): void {
    this.reset();
  }

  // ── internals ──────────────────────────────────────────────────────────

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

function safeAdd(current: number, delta: number): number {
  if (!Number.isFinite(delta) || delta < 0) return current;
  return current + delta;
}

function clampPercent(p: number): number {
  if (!Number.isFinite(p) || p < 0) return 0;
  if (p > 200) return 200;
  return p;
}
