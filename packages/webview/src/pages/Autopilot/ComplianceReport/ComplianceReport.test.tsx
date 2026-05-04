import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../../i18n';
import { ComplianceReport } from './ComplianceReport';

vi.mock('../../../stores/useAutopilotStore', () => {
  const defaultState = {
    complianceFramework: 'gdpr' as const,
    rules: [],
    graph: null,
    executionStatus: 'completed' as const,
  };

  return {
    useAutopilotStore: (selector: (state: typeof defaultState) => unknown) =>
      selector(defaultState),
  };
});

describe('ComplianceReport', () => {
  it('should render without crashing', () => {
    render(<ComplianceReport />);
    expect(screen.getByTestId('compliance-report')).toBeDefined();
  });

  it('should show the report title', () => {
    render(<ComplianceReport />);
    expect(screen.getByText('Compliance Report')).toBeDefined();
  });

  it('should show export JSON button', () => {
    render(<ComplianceReport />);
    expect(screen.getByTestId('compliance-export-json')).toBeDefined();
  });

  it('should show framework badge', () => {
    render(<ComplianceReport />);
    expect(screen.getByTestId('report-framework')).toBeDefined();
  });

  it('should show rules table', () => {
    render(<ComplianceReport />);
    expect(screen.getByTestId('compliance-rules-table')).toBeDefined();
  });
});
