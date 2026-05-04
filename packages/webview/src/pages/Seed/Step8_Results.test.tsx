import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { Step8Results } from './Step8_Results';
import type { SeedExecutionResult } from '@sandforge/shared';

const result: SeedExecutionResult = {
  templateId: 'tpl-1',
  operationId: 'op-1',
  status: 'success',
  objectResults: [
    {
      objectApiName: 'Account',
      recordsCreated: 500,
      recordsFailed: 0,
      createdIds: ['001-1'],
      errors: [],
    },
    {
      objectApiName: 'Contact',
      recordsCreated: 990,
      recordsFailed: 10,
      createdIds: ['003-1'],
      errors: ['FIELD_ERROR: Required field missing'],
    },
  ],
  totalRecordsCreated: 1490,
  totalRecordsFailed: 10,
  duration: 15000,
  timestamp: '2024-01-01T00:00:00Z',
};

describe('Step8Results', () => {
  it('should render the step', () => {
    render(<Step8Results result={result} />);
    expect(screen.getByTestId('step-results')).toBeDefined();
  });

  it('should show result summary', () => {
    render(<Step8Results result={result} />);
    const summary = screen.getByTestId('result-summary');
    expect(summary.textContent).toContain('1490');
    expect(summary.textContent).toContain('10');
    expect(summary.textContent).toContain('15.0s');
  });

  it('should show success badge', () => {
    render(<Step8Results result={result} />);
    expect(screen.getByText('Seed Complete')).toBeDefined();
  });

  it('should show partial badge', () => {
    render(<Step8Results result={{ ...result, status: 'partial' }} />);
    expect(screen.getByText('Partially Complete')).toBeDefined();
  });

  it('should show failure badge', () => {
    render(<Step8Results result={{ ...result, status: 'failure' }} />);
    expect(screen.getByText('Seed Failed')).toBeDefined();
  });

  it('should show object results', () => {
    render(<Step8Results result={result} />);
    expect(screen.getByText('Account')).toBeDefined();
    expect(screen.getByText('Contact')).toBeDefined();
  });

  it('should show errors for objects with failures', () => {
    render(<Step8Results result={result} />);
    expect(screen.getByText('FIELD_ERROR: Required field missing')).toBeDefined();
  });

  it('should show no data when result is undefined', () => {
    render(<Step8Results />);
    expect(screen.getByText('No data available')).toBeDefined();
  });

  it('should show record count badges', () => {
    render(<Step8Results result={result} />);
    expect(screen.getByText('500/500')).toBeDefined();
    expect(screen.getByText('990/1000')).toBeDefined();
  });
});
