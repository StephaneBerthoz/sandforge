import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import type { DriftResult } from './DriftDashboard';
import { DriftDashboard } from './DriftDashboard';

const mockDrift: DriftResult = {
  orgId: 'org-1',
  driftScore: 45,
  detectedAt: '2024-01-20T14:00:00Z',
  driftedComponents: [
    {
      componentType: 'ApexClass',
      fullName: 'AccountHandler',
      changeType: 'modified',
      detectedAt: '2024-01-20T14:00:00Z',
      lastModifiedBy: 'admin@test.com',
      lastModifiedDate: '2024-01-20',
    },
    {
      componentType: 'CustomField',
      fullName: 'Account.NewField__c',
      changeType: 'added',
      detectedAt: '2024-01-20T14:00:00Z',
      lastModifiedBy: 'dev@test.com',
      lastModifiedDate: '2024-01-19',
    },
    {
      componentType: 'Flow',
      fullName: 'OldFlow',
      changeType: 'removed',
      detectedAt: '2024-01-20T14:00:00Z',
    },
    {
      componentType: 'ApexClass',
      fullName: 'ContactHandler',
      changeType: 'modified',
      detectedAt: '2024-01-20T14:00:00Z',
      lastModifiedBy: 'admin@test.com',
      lastModifiedDate: '2024-01-18',
    },
  ],
};

describe('DriftDashboard', () => {
  it('should render the drift card', () => {
    render(<DriftDashboard drift={mockDrift} />);
    expect(screen.getByText('Drift Dashboard')).toBeDefined();
  });

  it('should show drift score', () => {
    render(<DriftDashboard drift={mockDrift} />);
    expect(screen.getByText('Drift Score')).toBeDefined();
    expect(screen.getByRole('progressbar')).toBeDefined();
  });

  it('should render drifted components', () => {
    render(<DriftDashboard drift={mockDrift} />);
    expect(screen.getByTestId('drift-item-AccountHandler')).toBeDefined();
    expect(screen.getByTestId('drift-item-Account.NewField__c')).toBeDefined();
    expect(screen.getByTestId('drift-item-OldFlow')).toBeDefined();
  });

  it('should show change type badges', () => {
    render(<DriftDashboard drift={mockDrift} />);
    expect(screen.getAllByText('modified').length).toBe(2);
    expect(screen.getByText('added')).toBeDefined();
    expect(screen.getByText('removed')).toBeDefined();
  });

  it('should show no drift message when empty', () => {
    render(<DriftDashboard />);
    expect(screen.getByText('No drift detected')).toBeDefined();
  });

  it('should show no drift when components array is empty', () => {
    const emptyDrift: DriftResult = { ...mockDrift, driftedComponents: [] };
    render(<DriftDashboard drift={emptyDrift} />);
    expect(screen.getByText('No drift detected')).toBeDefined();
  });

  it('should accept custom className', () => {
    const { container } = render(<DriftDashboard drift={mockDrift} className="custom" />);
    expect((container.firstChild as HTMLElement).className).toContain('custom');
  });

  it('should group components by componentType', () => {
    render(<DriftDashboard drift={mockDrift} />);
    expect(screen.getByTestId('drift-groups')).toBeDefined();
    expect(screen.getByTestId('drift-group-ApexClass')).toBeDefined();
    expect(screen.getByTestId('drift-group-CustomField')).toBeDefined();
    expect(screen.getByTestId('drift-group-Flow')).toBeDefined();
  });

  it('should show group counts', () => {
    render(<DriftDashboard drift={mockDrift} />);
    // ApexClass has 2 components
    expect(screen.getByTestId('drift-group-count-ApexClass').textContent).toBe('2');
    // CustomField has 1
    expect(screen.getByTestId('drift-group-count-CustomField').textContent).toBe('1');
    // Flow has 1
    expect(screen.getByTestId('drift-group-count-Flow').textContent).toBe('1');
  });

  it('should show lastModifiedBy when available', () => {
    render(<DriftDashboard drift={mockDrift} />);
    expect(screen.getByTestId('drift-modified-by-AccountHandler')).toBeDefined();
    expect(screen.getByTestId('drift-modified-by-AccountHandler').textContent).toBe('admin@test.com');
  });

  it('should show lastModifiedDate when available', () => {
    render(<DriftDashboard drift={mockDrift} />);
    expect(screen.getByTestId('drift-modified-date-AccountHandler')).toBeDefined();
    expect(screen.getByTestId('drift-modified-date-AccountHandler').textContent).toBe('2024-01-20');
  });

  it('should not show lastModifiedBy when not available', () => {
    render(<DriftDashboard drift={mockDrift} />);
    expect(screen.queryByTestId('drift-modified-by-OldFlow')).toBeNull();
  });
});
