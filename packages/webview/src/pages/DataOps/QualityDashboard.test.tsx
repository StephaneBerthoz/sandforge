import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { QualityDashboard } from './QualityDashboard';
import type { DataQualityScanResult } from '@sandforge/shared';

const results: DataQualityScanResult[] = [
  {
    orgId: 'org-1',
    objectApiName: 'Account',
    totalRecords: 500,
    score: 85,
    rules: [
      {
        ruleType: 'completeness',
        fieldApiName: 'Name',
        passed: 485,
        failed: 15,
        passRate: 97,
        sampleFailures: [],
      },
      {
        ruleType: 'uniqueness',
        fieldApiName: 'Email',
        passed: 450,
        failed: 50,
        passRate: 90,
        sampleFailures: ['dup@test.com'],
      },
    ],
    timestamp: '2026-01-01T00:00:00Z',
  },
  {
    orgId: 'org-1',
    objectApiName: 'Contact',
    totalRecords: 1000,
    score: 65,
    rules: [
      {
        ruleType: 'format',
        fieldApiName: 'Phone',
        passed: 600,
        failed: 400,
        passRate: 60,
        sampleFailures: ['bad-phone'],
      },
    ],
    timestamp: '2026-01-01T00:00:00Z',
  },
];

describe('QualityDashboard', () => {
  it('should render the dashboard', () => {
    render(<QualityDashboard />);
    expect(screen.getByTestId('quality-dashboard')).toBeDefined();
  });

  it('should show empty state when no results', () => {
    render(<QualityDashboard />);
    expect(screen.getByText('dataops.noResults')).toBeDefined();
  });

  it('should show quality summary', () => {
    render(<QualityDashboard results={results} />);
    expect(screen.getByTestId('quality-summary')).toBeDefined();
    expect(screen.getByText('75%')).toBeDefined();
  });

  it('should show object cards', () => {
    render(<QualityDashboard results={results} />);
    expect(screen.getByTestId('quality-Account')).toBeDefined();
    expect(screen.getByTestId('quality-Contact')).toBeDefined();
  });

  it('should show score badges', () => {
    render(<QualityDashboard results={results} />);
    expect(screen.getByText('85%')).toBeDefined();
    expect(screen.getByText('65%')).toBeDefined();
  });

  it('should show rule progress bars', () => {
    render(<QualityDashboard results={results} />);
    expect(screen.getAllByRole('progressbar').length).toBeGreaterThan(0);
  });

  it('should call onRunScan', () => {
    const onRunScan = vi.fn();
    render(<QualityDashboard onRunScan={onRunScan} />);
    fireEvent.click(screen.getByTestId('run-scan-btn'));
    expect(onRunScan).toHaveBeenCalled();
  });

  it('should show rule type labels', () => {
    render(<QualityDashboard results={results} />);
    expect(screen.getAllByText('dataops.qualityRules.completeness').length).toBeGreaterThan(0);
    expect(screen.getAllByText('dataops.qualityRules.uniqueness').length).toBeGreaterThan(0);
  });
});
