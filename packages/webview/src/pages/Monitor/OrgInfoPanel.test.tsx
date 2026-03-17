import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { OrgInfoPanel } from './OrgInfoPanel';
import type { OrgInfo } from '@sandforge/shared';

const sampleOrg: OrgInfo = {
  name: 'Acme Corp',
  orgId: '00D000000000001',
  type: 'Sandbox',
  edition: 'Enterprise Edition',
  instanceName: 'NA100',
  apiVersion: '60.0',
  userCount: 150,
  customObjectCount: 45,
  apexClassCount: 230,
  flowCount: 18,
  lastLoginDate: '2026-02-24T09:00:00Z',
};

describe('OrgInfoPanel', () => {
  it('should render nothing when orgInfo is undefined', () => {
    const { container } = render(<OrgInfoPanel />);
    expect(container.innerHTML).toBe('');
  });

  it('should render the panel with org info', () => {
    render(<OrgInfoPanel orgInfo={sampleOrg} />);
    expect(screen.getByTestId('org-info-panel')).toBeDefined();
  });

  it('should display org name', () => {
    render(<OrgInfoPanel orgInfo={sampleOrg} />);
    expect(screen.getByTestId('org-info-name').textContent).toBe('Acme Corp');
  });

  it('should display org type badge', () => {
    render(<OrgInfoPanel orgInfo={sampleOrg} />);
    expect(screen.getByTestId('org-info-type').textContent).toBe('Sandbox');
  });

  it('should display edition', () => {
    render(<OrgInfoPanel orgInfo={sampleOrg} />);
    expect(screen.getByTestId('org-info-edition').textContent).toBe('Enterprise Edition');
  });

  it('should display instance name', () => {
    render(<OrgInfoPanel orgInfo={sampleOrg} />);
    expect(screen.getByTestId('org-info-instance').textContent).toContain('NA100');
  });

  it('should display API version', () => {
    render(<OrgInfoPanel orgInfo={sampleOrg} />);
    expect(screen.getByTestId('org-info-api-version').textContent).toContain('60.0');
  });

  it('should display org ID', () => {
    render(<OrgInfoPanel orgInfo={sampleOrg} />);
    expect(screen.getByTestId('org-info-id').textContent).toBe('00D000000000001');
  });

  it('should display component stats', () => {
    render(<OrgInfoPanel orgInfo={sampleOrg} />);
    expect(screen.getByTestId('org-info-stats')).toBeDefined();
    expect(screen.getByTestId('org-stat-users').textContent).toContain('150');
    expect(screen.getByTestId('org-stat-objects').textContent).toContain('45');
    expect(screen.getByTestId('org-stat-apex').textContent).toContain('230');
    expect(screen.getByTestId('org-stat-flows').textContent).toContain('18');
  });

  it('should display Production type with correct badge', () => {
    render(<OrgInfoPanel orgInfo={{ ...sampleOrg, type: 'Production' }} />);
    expect(screen.getByTestId('org-info-type').textContent).toBe('Production');
  });

  it('should accept custom className', () => {
    render(<OrgInfoPanel orgInfo={sampleOrg} className="custom-class" />);
    expect(screen.getByTestId('org-info-panel').className).toContain('custom-class');
  });
});
