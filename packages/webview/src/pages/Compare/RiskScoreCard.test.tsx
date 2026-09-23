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
      riskLevel: 'critical',
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
  ],
  summary: {
    total: 2,
    added: 1,
    removed: 0,
    modified: 1,
    byRisk: { none: 0, low: 0, medium: 1, high: 0, critical: 1 },
  },
  riskScore: 72,
  deploymentAdvice: [{ kind: 'critical', count: 1 }],
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

  it('counts what only the source holds as additions, in green, and what only the target holds in red', () => {
    // It counted "added" in green over what only the target holds, which a
    // deployment does not add.
    render(<RiskScoreCard report={highRiskReport} />);
    const badges = Array.from(screen.getByTestId('risk-summary-counts').children).map((badge) => [
      badge.textContent,
      badge.className.match(/bg-status-(\w+)/)?.[1],
    ]);
    expect(badges).toEqual([
      ['0 only in the source', 'success'],
      ['1 only in the target', 'error'],
      ['1 modified', 'warning'],
    ]);
  });

  it('should display summary counts', () => {
    render(<RiskScoreCard report={highRiskReport} />);
    const countsEl = screen.getByTestId('risk-summary-counts');
    expect(countsEl).toBeDefined();
    // Badge text includes count + i18n label
    expect(countsEl.textContent).toContain('0');
    expect(countsEl.textContent).toContain('1');
  });

  it('should display risk breakdown badges', () => {
    render(<RiskScoreCard report={highRiskReport} />);
    const breakdownEl = screen.getByTestId('risk-breakdown');
    expect(breakdownEl).toBeDefined();
    expect(breakdownEl.textContent).toContain('1 critical');
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
    expect(screen.getByText(/Manual review required/)).toBeDefined();
  });

  it('should display safe to deploy for low risk', () => {
    render(<RiskScoreCard report={lowRiskReport} />);
    expect(screen.getByText(/Safe to deploy/)).toBeDefined();
  });
});
