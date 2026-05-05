import React from 'react';

export interface TokenBudgetState {
  sessionId: string;
  used: { input: number; output: number; cacheRead: number; cacheCreate: number; total: number };
  budget: number;
  percent: number;
  state: 'ok' | 'warn' | 'exceeded';
}

export interface TokenBudgetIndicatorProps {
  state: TokenBudgetState | null;
}

/**
 * Mini horizontal bar + numeric label showing the per-panel-session AI
 * token budget consumption. Renders nothing when `state` is null (panel
 * just opened, no calls yet). Bar colour: green / yellow / red.
 *
 * `aria-live='polite'` so screen readers announce major state transitions.
 */
export const TokenBudgetIndicator: React.FC<TokenBudgetIndicatorProps> = ({ state }) => {
  if (!state) return null;

  const colour =
    state.state === 'exceeded'
      ? 'bg-[var(--sf-color-bg-error,#dc2626)]'
      : state.state === 'warn'
        ? 'bg-[var(--sf-color-bg-warning,#eab308)]'
        : 'bg-[var(--sf-color-bg-ok,#16a34a)]';

  // Bar visual width clamped to 0..100; raw used.total still shown in label.
  const barWidth = Math.min(100, Math.max(0, state.percent));

  const tooltip =
    `input: ${state.used.input} | output: ${state.used.output} | ` +
    `cacheRead: ${state.used.cacheRead} | cacheCreate: ${state.used.cacheCreate}`;

  return (
    <div
      aria-live="polite"
      data-testid="ai-token-budget-indicator"
      data-state={state.state}
      className="inline-flex items-center gap-2 text-xs"
      title={tooltip}
    >
      <div className="relative w-[100px] h-2 bg-[var(--sf-color-bg-muted,#e5e7eb)] rounded">
        <div
          className={`absolute left-0 top-0 h-full rounded ${colour}`}
          style={{ width: `${barWidth}%` }}
        />
      </div>
      <span data-testid="ai-token-budget-label" className="font-mono">
        {state.used.total}/{state.budget}
      </span>
    </div>
  );
};
