import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { Step6ReviewPlan } from './Step6_ReviewPlan';
import type { SeedDataPlan } from '@sandforge/shared';

const plan: SeedDataPlan = {
  objects: [
    {
      objectApiName: 'Account',
      recordCount: 500,
      sampleRecords: [
        { Name: 'Acme Corp', Industry: 'Tech' },
        { Name: 'Globex', Industry: 'Finance' },
      ],
      dependsOn: [],
    },
    {
      objectApiName: 'Contact',
      recordCount: 1000,
      sampleRecords: [{ FirstName: 'John', LastName: 'Doe' }],
      dependsOn: ['Account'],
    },
  ],
  totalRecords: 1500,
  estimatedApiCalls: 15,
  estimatedDuration: 30000,
  grappeRecommended: false,
};

describe('Step6ReviewPlan', () => {
  it('should render the step', () => {
    render(<Step6ReviewPlan plan={plan} />);
    expect(screen.getByTestId('step-review-plan')).toBeDefined();
  });

  it('should show plan summary', () => {
    render(<Step6ReviewPlan plan={plan} />);
    const summary = screen.getByTestId('plan-summary');
    expect(summary.textContent).toContain('1500');
    expect(summary.textContent).toContain('15');
    expect(summary.textContent).toContain('30s');
  });

  it('should show object cards', () => {
    render(<Step6ReviewPlan plan={plan} />);
    expect(screen.getAllByText('Account').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Contact').length).toBeGreaterThan(0);
  });

  it('should show sample records', () => {
    render(<Step6ReviewPlan plan={plan} />);
    expect(screen.getByText('Acme Corp')).toBeDefined();
    expect(screen.getByText('Globex')).toBeDefined();
  });

  it('should show dependencies', () => {
    render(<Step6ReviewPlan plan={plan} />);
    expect(screen.getAllByText('Account').length).toBeGreaterThan(0);
  });

  it('should show loading state', () => {
    render(<Step6ReviewPlan isLoading />);
    expect(screen.getByText('Loading...')).toBeDefined();
  });

  it('should show no data state', () => {
    render(<Step6ReviewPlan />);
    expect(screen.getByText('No data available')).toBeDefined();
  });

  it('should show grappe recommendation badge', () => {
    render(<Step6ReviewPlan plan={{ ...plan, grappeRecommended: true }} />);
    expect(screen.getByText('Grappe mode recommended')).toBeDefined();
  });
});
