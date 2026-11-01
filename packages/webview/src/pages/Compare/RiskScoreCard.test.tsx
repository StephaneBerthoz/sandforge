import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { RiskScoreCard } from './RiskScoreCard';
import type { CompareReport } from '@sandforge/shared';

const lowRiskReport: CompareReport = {
  diffs: [
    {
      category: 'CustomLabel',
      changeType: 'removed',
      name: 'MyLabel',
      riskLevel: 'low',
      riskReasons: ['sourceOnly'],
      group: 'Configuration',
      dependencies: [],
    },
  ],
  summary: {
    total: 1,
    added: 0,
    removed: 1,
    modified: 0,
    byRisk: { none: 0, low: 1, medium: 0, high: 0, critical: 0 },
  },
  riskScore: 5,
  deploymentAdvice: [{ kind: 'lowRisk' }],
};

const highRiskReport: CompareReport = {
  diffs: [
    {
      category: 'ApexClass',
      changeType: 'added',
      name: 'AccountController',
      riskLevel: 'none',
      riskReasons: ['targetOnlyApex', 'breaking'],
      group: 'Apex Code',
      dependencies: ['ApexTrigger', 'Flow'],
    },
    {
      category: 'CustomField',
      changeType: 'modified',
      name: 'Account.Status__c',
      riskLevel: 'medium',
      riskReasons: ['breaking'],
      group: 'Data Model',
      dependencies: ['ValidationRule', 'Layout'],
    },
    {
      category: 'CustomObject',
      changeType: 'modified',
      name: 'Invoice__c',
      riskLevel: 'high',
      riskReasons: [],
      group: 'Data Model',
      dependencies: [],
    },
  ],
  summary: {
    total: 3,
    added: 1,
    removed: 0,
    modified: 2,
    byRisk: { none: 0, low: 0, medium: 1, high: 1, critical: 0 },
  },
  riskScore: 72,
  deploymentAdvice: [{ kind: 'high', count: 1 }],
};

/** What the comparison of the audit found: a low sum, over a high-risk change and a component only the target holds. */
const lowSumHighChange: CompareReport = {
  diffs: [
    {
      category: 'CustomField',
      changeType: 'added',
      name: 'Account.Legacy__c',
      riskLevel: 'none',
      riskReasons: ['targetOnlyDataModel', 'breaking'],
      group: 'Data Model',
      dependencies: [],
    },
    {
      category: 'ApexClass',
      changeType: 'modified',
      name: 'AccountService',
      riskLevel: 'high',
      riskReasons: ['breaking'],
      group: 'Apex Code',
      dependencies: [],
    },
  ],
  summary: {
    total: 2,
    added: 1,
    removed: 0,
    modified: 1,
    byRisk: { none: 0, low: 0, medium: 0, high: 1, critical: 0 },
  },
  riskScore: 5,
  deploymentAdvice: [{ kind: 'high', count: 1 }, { kind: 'apexTests' }],
};

describe('RiskScoreCard', () => {
  it('should render the risk gauge', () => {
    render(<RiskScoreCard report={lowRiskReport} />);
    expect(screen.getByTestId('risk-gauge')).toBeDefined();
    expect(screen.getByTestId('risk-score-value')).toBeDefined();
    expect(screen.getByTestId('risk-score-value').textContent).toBe('5');
  });

  it('should show Low label for low risk', () => {
    render(<RiskScoreCard report={lowRiskReport} />);
    expect(screen.getByTestId('risk-score-label').textContent).toBe('Low risk');
  });

  it('should show High label for high risk', () => {
    render(<RiskScoreCard report={highRiskReport} />);
    expect(screen.getByTestId('risk-score-label').textContent).toBe('High risk');
  });

  it('names the risk under the gauge in the language of the page', async () => {
    // It was written in English under the gauge whatever the language.
    i18n.addResourceBundle('fr', 'translation', fr);
    await i18n.changeLanguage('fr');
    try {
      render(<RiskScoreCard report={highRiskReport} />);
      expect(screen.getByTestId('risk-score-label').textContent).toBe('Risque élevé');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('counts what a deployment changes, what only the source holds as additions, in green', () => {
    // It counted "added" in green over what only the target holds, which a
    // deployment does not add; that is now on a line of its own.
    render(<RiskScoreCard report={highRiskReport} />);
    const badges = Array.from(screen.getByTestId('risk-summary-counts').children).map((badge) => [
      badge.textContent,
      badge.className.match(/bg-status-(\w+)/)?.[1],
    ]);
    expect(badges).toEqual([
      ['0 only in the source', 'success'],
      ['2 modified', 'warning'],
    ]);
  });

  it('says what only the target holds on a line of its own, with no risk level', () => {
    render(<RiskScoreCard report={lowSumHighChange} />);
    const line = screen.getByTestId('risk-target-only');
    expect(line.textContent).toBe(
      '1 component only in the target: a deployment leaves it; removing it by hand may lose data.',
    );
    expect(screen.getByTestId('risk-breakdown').textContent).toBe('1 high');
  });

  it('draws no target-only line when the target holds nothing the source lacks', () => {
    render(<RiskScoreCard report={lowRiskReport} />);
    expect(screen.queryByTestId('risk-target-only')).toBeNull();
  });

  it('names the heaviest change it deploys under the gauge when the sum reads lower', () => {
    // The gauge read "10 Low risk" beside "1 high-risk change. Deploy to a
    // sandbox first."
    render(<RiskScoreCard report={lowSumHighChange} />);
    const label = screen.getByTestId('risk-score-label');
    expect(screen.getByTestId('risk-score-value').textContent).toBe('5');
    expect(label.textContent).toBe('High risk');
    expect(label.className).toContain('text-status-warning');
    expect(screen.getByTestId('deployment-advice').textContent).not.toMatch(/Low risk/);
  });

  it('should display summary counts', () => {
    render(<RiskScoreCard report={highRiskReport} />);
    const countsEl = screen.getByTestId('risk-summary-counts');
    expect(countsEl).toBeDefined();
    // Badge text includes count + i18n label
    expect(countsEl.textContent).toContain('0');
    expect(countsEl.textContent).toContain('2');
  });

  it('should display risk breakdown badges', () => {
    render(<RiskScoreCard report={highRiskReport} />);
    const breakdownEl = screen.getByTestId('risk-breakdown');
    expect(breakdownEl).toBeDefined();
    expect(breakdownEl.textContent).toContain('1 high');
    expect(breakdownEl.textContent).toContain('1 medium');
  });

  it('should not show zero-count risk levels', () => {
    render(<RiskScoreCard report={highRiskReport} />);
    expect(screen.queryByText(/0 none/)).toBeNull();
    expect(screen.queryByText(/0 low/)).toBeNull();
  });

  it('should display deployment advice', () => {
    render(<RiskScoreCard report={highRiskReport} />);
    expect(screen.getByTestId('deployment-advice')).toBeDefined();
    expect(screen.getByText(/Deploy to a sandbox first/)).toBeDefined();
  });

  it('should display safe to deploy for low risk', () => {
    render(<RiskScoreCard report={lowRiskReport} />);
    expect(screen.getByText(/Safe to deploy/)).toBeDefined();
  });
});
