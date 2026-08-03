import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';

import { TokenBudgetIndicator, type TokenBudgetState } from './TokenBudgetIndicator';

const mkState = (
  overrides: Partial<TokenBudgetState> & { percent: number; state: TokenBudgetState['state'] },
): TokenBudgetState => ({
  sessionId: 's1',
  used: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0 },
  budget: 10_000,
  ...overrides,
});

describe('TokenBudgetIndicator', () => {
  it('renders nothing when state is null', () => {
    const { container } = render(<TokenBudgetIndicator state={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders green bar for ok state (< 80%)', () => {
    render(
      <TokenBudgetIndicator
        state={mkState({
          percent: 50,
          state: 'ok',
          used: { input: 5000, output: 0, cacheRead: 0, cacheCreate: 0, total: 5000 },
        })}
      />,
    );
    const indicator = screen.getByTestId('ai-token-budget-indicator');
    expect(indicator.getAttribute('data-state')).toBe('ok');
    expect(screen.getByTestId('ai-token-budget-label').textContent).toBe('5000/10000');
  });

  it('renders yellow bar for warn state (80%-99%)', () => {
    render(
      <TokenBudgetIndicator
        state={mkState({
          percent: 85,
          state: 'warn',
          used: { input: 8500, output: 0, cacheRead: 0, cacheCreate: 0, total: 8500 },
        })}
      />,
    );
    expect(screen.getByTestId('ai-token-budget-indicator').getAttribute('data-state')).toBe('warn');
  });

  it('renders red bar for exceeded state (>= 100%); bar visually clamped but raw total in label', () => {
    render(
      <TokenBudgetIndicator
        state={mkState({
          percent: 110,
          state: 'exceeded',
          used: { input: 11000, output: 0, cacheRead: 0, cacheCreate: 0, total: 11000 },
        })}
      />,
    );
    const indicator = screen.getByTestId('ai-token-budget-indicator');
    expect(indicator.getAttribute('data-state')).toBe('exceeded');
    expect(screen.getByTestId('ai-token-budget-label').textContent).toBe('11000/10000');
  });

  it('tooltip shows the 4-field breakdown', () => {
    render(
      <TokenBudgetIndicator
        state={mkState({
          percent: 50,
          state: 'ok',
          used: { input: 100, output: 50, cacheRead: 25, cacheCreate: 10, total: 185 },
        })}
      />,
    );
    const indicator = screen.getByTestId('ai-token-budget-indicator');
    expect(indicator.getAttribute('title')).toContain('input: 100');
    expect(indicator.getAttribute('title')).toContain('output: 50');
    expect(indicator.getAttribute('title')).toContain('cacheRead: 25');
    expect(indicator.getAttribute('title')).toContain('cacheCreate: 10');
  });

  it('uses aria-live=polite for screen-reader announcements', () => {
    render(<TokenBudgetIndicator state={mkState({ percent: 0, state: 'ok' })} />);
    expect(screen.getByTestId('ai-token-budget-indicator').getAttribute('aria-live')).toBe(
      'polite',
    );
  });
});
