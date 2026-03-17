import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgCard } from './OrgCard';
import { orgTypeLabel } from '../../utils/orgFormatters';

const mockOrg: SalesforceOrg = {
  id: 'org-1',
  alias: 'Dev Sandbox',
  username: 'dev@sandbox.com',
  instanceUrl: 'https://dev-sandbox.my.salesforce.com',
  orgId: '00Dxx0000001gEQ',
  orgType: 'Sandbox',
  sandboxType: 'Developer',
  authMethod: 'oauth_web',
  safetyTier: OrgSafetyTier.LOW,
  appearance: { color: '#10B981', icon: 'cloud', position: 0 },
  metadata: { apiVersion: '59.0', edition: 'Developer', features: [] },
  status: 'connected',
  lastConnected: '2024-01-01T00:00:00Z',
  tags: ['dev', 'team-a'],
};

describe('OrgCard', () => {
  const defaultProps = {
    org: mockOrg,
    onSelect: vi.fn(),
    onEdit: vi.fn(),
    onDisconnect: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render org alias and username', () => {
    render(<OrgCard {...defaultProps} />);
    expect(screen.getByText('Dev Sandbox')).toBeDefined();
    expect(screen.getByText('dev@sandbox.com')).toBeDefined();
  });

  it('should render status badge', () => {
    render(<OrgCard {...defaultProps} />);
    expect(screen.getByText(/Connected/)).toBeDefined();
  });

  it('should render env type badge', () => {
    render(<OrgCard {...defaultProps} />);
    // mockOrg has tag 'dev' which maps to 'DEV'
    expect(screen.getByTestId('org-type-badge-org-1')).toBeDefined();
    expect(screen.getByTestId('org-type-badge-org-1').textContent).toBe('DEV');
  });

  it('should render tags', () => {
    render(<OrgCard {...defaultProps} />);
    expect(screen.getByText('dev')).toBeDefined();
    expect(screen.getByText('team-a')).toBeDefined();
  });

  it('should call onSelect when card is clicked', () => {
    const onSelect = vi.fn();
    render(<OrgCard {...defaultProps} onSelect={onSelect} />);
    fireEvent.click(screen.getByTestId('org-card-org-1'));
    expect(onSelect).toHaveBeenCalledWith('org-1');
  });

  it('should highlight when selected', () => {
    render(<OrgCard {...defaultProps} selected />);
    const card = screen.getByTestId('org-card-org-1');
    expect(card.className).toContain('ring-1');
  });

  it('should call onEdit when Edit is clicked', () => {
    const onEdit = vi.fn();
    render(<OrgCard {...defaultProps} onEdit={onEdit} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(onEdit).toHaveBeenCalledWith(mockOrg);
  });

  it('should call onDisconnect when Disconnect is clicked', () => {
    const onDisconnect = vi.fn();
    render(<OrgCard {...defaultProps} onDisconnect={onDisconnect} />);
    fireEvent.click(screen.getByText('Disconnect'));
    expect(onDisconnect).toHaveBeenCalledWith('org-1');
  });

  it('should derive orgTypeLabel correctly', () => {
    expect(orgTypeLabel({ ...mockOrg, orgType: 'Production' })).toBe('PROD');
    expect(orgTypeLabel({ ...mockOrg, orgType: 'Scratch' })).toBe('SCRATCH');
    expect(orgTypeLabel({ ...mockOrg, tags: ['uat'] })).toBe('UAT');
    expect(orgTypeLabel({ ...mockOrg, tags: [], sandboxType: 'Full' })).toBe('FULL');
    expect(orgTypeLabel({ ...mockOrg, tags: [], sandboxType: undefined })).toBe('SANDBOX');
  });
});
