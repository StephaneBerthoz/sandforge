import type { AIUsage } from './callResult.js';

/**
 * Token budget snapshot: one counter for the window session, shared by every
 * AI feature. Rebuilding the AI stack keeps it; a window reload starts anew.
 *
 * `state` discriminator:
 *   - 'ok'        — percent < 80
 *   - 'warn'      — 80 <= percent < 100 (the host shows a notice at the first crossing)
 *   - 'exceeded'  — percent >= 100 (AI calls are refused; the host says so once)
 */
export type TokenBudgetState = {
  /** Non-empty id of the window session the counter belongs to. */
  sessionId: string;
  used: AIUsage;
  /** Positive integer: the session ceiling in tokens. */
  budget: number;
  /** 0 to 200: usage past twice the budget is reported as 200. */
  percent: number;
  state: 'ok' | 'warn' | 'exceeded';
};
