import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { GovernancePanel } from './GovernancePanel';
import type { GovernanceRuleDisplay } from './GovernancePanel';
import { LiveOperationsPanel } from './LiveOperationsPanel';
import type { LiveOperationSnapshot } from '@sandforge/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, defaultValue: string) => defaultValue,
  }),
}));

/**
 * The Monitor panels colour-code severity, which is the one place where a
 * washed-out hue costs the user information. Fixed palette shades (red-400 and
 * friends) only clear AA against a dark editor — around 2.8:1 on a light one —
 * so severity has to be expressed with the theme-resolved status utilities.
 */

/** Palette shades that cannot follow the VSCode theme. */
const FIXED_HUES = /\b(?:text|bg)-(?:red|amber|yellow|green|emerald|blue|cyan)-\d{3}\b/;

function makeRule(overrides: Partial<GovernanceRuleDisplay> = {}): GovernanceRuleDisplay {
  return {
    ruleId: 'rule-1',
    ruleName: 'API usage under 80%',
    category: 'limits',
    status: 'pass',
    actualValue: 40,
    threshold: 80,
    message: 'Within threshold',
    remediation: 'None',
    ...overrides,
  };
}

function makeOperation(overrides: Partial<LiveOperationSnapshot> = {}): LiveOperationSnapshot {
  return {
    operationId: 'op-1',
    module: 'sync',
    description: 'Syncing Account',
    status: 'running',
    percentage: 50,
    processedRecords: 250,
    totalRecords: 500,
    currentStep: 'Processing batch 3/6',
    startedAt: new Date().toISOString(),
    elapsedMs: 15000,
    recordsPerSecond: 17,
    ...overrides,
  };
}

/**
 * The assertions target the individual glyph or figure rather than its
 * container: a filled Badge sets its own background alongside its foreground,
 * so a palette pair there is not the standalone-text problem being guarded.
 */
function classOf(el: Element | null | undefined): string {
  return el?.getAttribute('class') ?? '';
}

describe('GovernancePanel severity colours', () => {
  it.each([
    { status: 'pass' as const, expected: 'text-status-success' },
    { status: 'warning' as const, expected: 'text-status-warning' },
    { status: 'fail' as const, expected: 'text-status-error' },
  ])('marks a $status rule with $expected', ({ status, expected }) => {
    render(<GovernancePanel ruleResults={[makeRule({ status })]} />);
    const classes = classOf(screen.getByTestId('rule-result-rule-1').querySelector('svg'));

    expect(classes).toContain(expected);
    expect(classes).not.toMatch(FIXED_HUES);
  });

  it.each([
    { score: 95, expected: 'text-status-success' },
    { score: 70, expected: 'text-status-warning' },
    { score: 20, expected: 'text-status-error' },
  ])('colours a score of $score with $expected', ({ score, expected }) => {
    render(<GovernancePanel complianceScore={score} />);
    const classes = classOf(screen.getByText(`${score}%`));

    expect(classes).toContain(expected);
    expect(classes).not.toMatch(FIXED_HUES);
  });
});

describe('LiveOperationsPanel severity colours', () => {
  it.each([
    { status: 'running' as const, expected: 'text-status-info' },
    { status: 'paused' as const, expected: 'text-status-warning' },
    { status: 'completed' as const, expected: 'text-status-success' },
    { status: 'failed' as const, expected: 'text-status-error' },
  ])('marks a $status operation with $expected', ({ status, expected }) => {
    render(<LiveOperationsPanel operations={[makeOperation({ status })]} />);
    const classes = classOf(screen.getByTestId('live-op-op-1').querySelector('svg'));

    expect(classes).toContain(expected);
    expect(classes).not.toMatch(FIXED_HUES);
  });

  it('renders the failure message in the theme-resolved error colour', () => {
    render(
      <LiveOperationsPanel
        operations={[makeOperation({ status: 'failed', error: 'Connection timeout' })]}
      />,
    );
    const classes = classOf(screen.getByText('Connection timeout'));

    expect(classes).toContain('text-status-error');
    expect(classes).not.toMatch(FIXED_HUES);
  });
});
