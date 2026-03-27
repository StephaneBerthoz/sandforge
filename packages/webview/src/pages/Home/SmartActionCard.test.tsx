import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import type { SmartActionRecommendation } from '@sandforge/shared';
import { SmartActionCard } from './SmartActionCard';

function createRecommendation(
  overrides: Partial<SmartActionRecommendation> = {},
): SmartActionRecommendation {
  return {
    action: 'quick-seed',
    confidence: 0.9,
    reason: 'Your sandbox is empty — seed it with demo data',
    reasonKey: 'home.smartAction.reasonEmpty',
    details: {
      targetOrgId: 'org-1',
      recordCounts: { Account: 0, Contact: 0, Opportunity: 0, Case: 0, Lead: 0 },
    },
    ...overrides,
  };
}

describe('SmartActionCard', () => {
  it('should render recommendation with execute button', () => {
    const onExecute = vi.fn();
    render(
      <SmartActionCard
        recommendation={createRecommendation()}
        onExecute={onExecute}
        showConfirmation={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId('smart-action-card')).toBeDefined();
    expect(screen.getByTestId('smart-action-execute-btn')).toBeDefined();
    expect(screen.getByTestId('smart-action-why-btn')).toBeDefined();
  });

  it('should return null when action is none', () => {
    const { container } = render(
      <SmartActionCard
        recommendation={createRecommendation({ action: 'none', confidence: 0, reasonKey: '' })}
        onExecute={vi.fn()}
        showConfirmation={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(container.innerHTML).toBe('');
  });

  it('should show confirmation state with confirm and cancel buttons', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    render(
      <SmartActionCard
        recommendation={createRecommendation()}
        onExecute={vi.fn()}
        showConfirmation={true}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByTestId('smart-action-confirm-btn')).toBeDefined();
    expect(screen.getByTestId('smart-action-cancel-btn')).toBeDefined();

    fireEvent.click(screen.getByTestId('smart-action-confirm-btn'));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId('smart-action-cancel-btn'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('should call onExecute when Execute button is clicked', () => {
    const onExecute = vi.fn();

    render(
      <SmartActionCard
        recommendation={createRecommendation()}
        onExecute={onExecute}
        showConfirmation={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('smart-action-execute-btn'));
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('should show loading skeleton when loading', () => {
    render(
      <SmartActionCard
        recommendation={createRecommendation()}
        onExecute={vi.fn()}
        showConfirmation={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
        loading={true}
      />,
    );

    expect(screen.getByTestId('smart-action-loading')).toBeDefined();
  });

  it('should render clone recommendation with Copy icon', () => {
    render(
      <SmartActionCard
        recommendation={createRecommendation({
          action: 'clone',
          confidence: 0.85,
          reasonKey: 'home.smartAction.reasonClone',
        })}
        onExecute={vi.fn()}
        showConfirmation={false}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByTestId('smart-action-card')).toBeDefined();
  });
});
