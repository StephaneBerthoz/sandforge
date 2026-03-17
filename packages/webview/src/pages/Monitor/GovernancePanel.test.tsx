import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { GovernancePanel } from './GovernancePanel';
import type { GovernancePolicySummary, GovernanceRuleDisplay } from './GovernancePanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue: string) => defaultValue,
  }),
}));

function makePolicy(overrides: Partial<GovernancePolicySummary> = {}): GovernancePolicySummary {
  return {
    id: 'pol-1',
    name: 'Security Policy',
    description: 'Default security governance',
    ruleCount: 3,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeRuleResult(overrides: Partial<GovernanceRuleDisplay> = {}): GovernanceRuleDisplay {
  return {
    ruleId: 'rule-1',
    ruleName: 'MFA Enabled',
    category: 'security',
    status: 'pass',
    actualValue: 100,
    threshold: 100,
    message: 'MFA: compliant',
    remediation: '',
    ...overrides,
  };
}

describe('GovernancePanel', () => {
  it('renders the panel', () => {
    render(<GovernancePanel />);
    expect(screen.getByTestId('governance-panel')).toBeTruthy();
  });

  it('shows no-policies message when empty', () => {
    render(<GovernancePanel policies={[]} />);
    expect(screen.getByTestId('no-policies')).toBeTruthy();
  });

  it('renders policy list', () => {
    const policies = [
      makePolicy({ id: 'pol-1' }),
      makePolicy({ id: 'pol-2', name: 'Performance Policy' }),
    ];
    render(<GovernancePanel policies={policies} />);
    expect(screen.getByTestId('policy-pol-1')).toBeTruthy();
    expect(screen.getByTestId('policy-pol-2')).toBeTruthy();
  });

  it('selects a policy on click', () => {
    const policies = [makePolicy()];
    render(<GovernancePanel policies={policies} />);
    fireEvent.click(screen.getByTestId('policy-pol-1'));
    const policyEl = screen.getByTestId('policy-pol-1');
    expect(policyEl.className).toContain('focusBorder');
  });

  it('shows compliance score', () => {
    render(<GovernancePanel complianceScore={85} />);
    expect(screen.getByTestId('compliance-score')).toBeTruthy();
    expect(screen.getByText('85%')).toBeTruthy();
  });

  it('renders rule results', () => {
    const results = [
      makeRuleResult({ ruleId: 'r1', status: 'pass' }),
      makeRuleResult({ ruleId: 'r2', status: 'fail', ruleName: 'API Usage' }),
    ];
    render(<GovernancePanel ruleResults={results} />);
    expect(screen.getByTestId('rule-results')).toBeTruthy();
    expect(screen.getByTestId('rule-result-r1')).toBeTruthy();
    expect(screen.getByTestId('rule-result-r2')).toBeTruthy();
  });

  it('renders remediations checklist', () => {
    const remediations = ['Enable MFA', 'Reduce API calls'];
    render(<GovernancePanel remediations={remediations} />);
    expect(screen.getByTestId('remediations')).toBeTruthy();
    expect(screen.getByText('Enable MFA')).toBeTruthy();
    expect(screen.getByText('Reduce API calls')).toBeTruthy();
  });

  it('calls onEvaluate with selected policy', () => {
    const onEvaluate = vi.fn();
    const policies = [makePolicy()];
    render(<GovernancePanel policies={policies} onEvaluate={onEvaluate} />);
    fireEvent.click(screen.getByTestId('policy-pol-1'));
    fireEvent.click(screen.getByTestId('evaluate-btn'));
    expect(onEvaluate).toHaveBeenCalledWith('pol-1');
  });

  it('disables evaluate when no policy selected', () => {
    render(<GovernancePanel policies={[makePolicy()]} />);
    const btn = screen.getByTestId('evaluate-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('calls onDeletePolicy', () => {
    const onDeletePolicy = vi.fn();
    render(<GovernancePanel policies={[makePolicy()]} onDeletePolicy={onDeletePolicy} />);
    fireEvent.click(screen.getByTestId('delete-policy-pol-1'));
    expect(onDeletePolicy).toHaveBeenCalledWith('pol-1');
  });

  it('calls onAddPolicy', () => {
    const onAddPolicy = vi.fn();
    render(<GovernancePanel onAddPolicy={onAddPolicy} />);
    fireEvent.click(screen.getByTestId('add-policy-btn'));
    expect(onAddPolicy).toHaveBeenCalled();
  });

  it('shows loading state', () => {
    render(<GovernancePanel loading={true} />);
    const btn = screen.getByTestId('evaluate-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
