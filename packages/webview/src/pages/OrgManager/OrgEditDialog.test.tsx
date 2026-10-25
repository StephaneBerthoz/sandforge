import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { OrgSafetyTier } from '@sandforge/shared';
import type { SalesforceOrg } from '@sandforge/shared';
import { OrgEditDialog } from './OrgEditDialog';

const mockOrg: SalesforceOrg = {
  id: 'org-1',
  alias: 'Dev Sandbox',
  username: 'dev@sandbox.com',
  instanceUrl: 'https://dev.my.salesforce.com',
  orgId: '00Dxx0000001gEQ',
  orgType: 'Sandbox',
  authMethod: 'oauth_web',
  safetyTier: OrgSafetyTier.LOW,
  appearance: { color: '#10B981', icon: 'cloud', position: 0 },
  metadata: { apiVersion: '59.0', edition: 'Developer', features: [] },
  status: 'connected',
  lastConnected: '2024-01-01T00:00:00Z',
  tags: ['dev'],
};

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  });
});

describe('OrgEditDialog', () => {
  const defaultProps = {
    org: mockOrg,
    open: true,
    onClose: vi.fn(),
    onSave: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render when open with org data', () => {
    render(<OrgEditDialog {...defaultProps} />);
    expect(screen.getByText('Edit Org')).toBeDefined();
  });

  it('should populate alias field from org', () => {
    render(<OrgEditDialog {...defaultProps} />);
    const input = screen.getByTestId('edit-alias-input') as HTMLInputElement;
    expect(input.value).toBe('Dev Sandbox');
  });

  it('should display username as read-only', () => {
    render(<OrgEditDialog {...defaultProps} />);
    expect(screen.getByText('dev@sandbox.com')).toBeDefined();
  });

  it('should call onSave with updated values', () => {
    const onSave = vi.fn();
    render(<OrgEditDialog {...defaultProps} onSave={onSave} />);
    fireEvent.change(screen.getByTestId('edit-alias-input'), { target: { value: 'New Name' } });
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledWith(
      'org-1',
      expect.objectContaining({
        alias: 'New Name',
      }),
    );
  });

  it('should offer no safety tier, which the production guard never reads', () => {
    const onSave = vi.fn();
    render(<OrgEditDialog {...defaultProps} onSave={onSave} />);
    expect(screen.queryByText('Safety Tier')).toBeNull();
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenCalledWith('org-1', {
      alias: 'Dev Sandbox',
      color: '#10B981',
      tags: ['dev'],
      staging: false,
    });
  });

  it('marks a sandbox Staging, saved with the rest, and shows the mark it has', () => {
    const onSave = vi.fn();
    const { rerender } = render(<OrgEditDialog {...defaultProps} onSave={onSave} />);

    const mark = screen.getByRole('checkbox', { name: 'Staging' });
    expect(mark).toHaveProperty('checked', false);
    expect(mark.getAttribute('aria-describedby')).toBe('edit-staging-hint');
    expect(document.getElementById('edit-staging-hint')?.textContent).toContain(
      'Production Guard asks before every delete',
    );
    fireEvent.click(mark);
    fireEvent.click(screen.getByText('Save'));
    expect(onSave).toHaveBeenLastCalledWith('org-1', expect.objectContaining({ staging: true }));

    rerender(
      <OrgEditDialog {...defaultProps} org={{ ...mockOrg, staging: true }} onSave={onSave} />,
    );
    expect(screen.getByRole('checkbox', { name: 'Staging' })).toHaveProperty('checked', true);
  });

  it('offers no Staging mark to a scratch org, a Developer Edition org or a production org, and saves none', () => {
    const others: SalesforceOrg[] = [
      { ...mockOrg, orgType: 'Scratch' },
      {
        ...mockOrg,
        orgType: 'Developer',
        metadata: { ...mockOrg.metadata, edition: 'Developer Edition' },
      },
      {
        ...mockOrg,
        orgType: 'Production',
        metadata: { ...mockOrg.metadata, edition: 'Enterprise Edition' },
      },
    ];
    for (const org of others) {
      const onSave = vi.fn();
      const { unmount } = render(<OrgEditDialog {...defaultProps} org={org} onSave={onSave} />);

      expect(screen.queryByTestId('edit-staging-input')).toBeNull();
      fireEvent.click(screen.getByText('Save'));
      expect(onSave.mock.calls[0]?.[1]).not.toHaveProperty('staging');
      unmount();
    }
  });

  it('should call onClose when Cancel is clicked', () => {
    const onClose = vi.fn();
    render(<OrgEditDialog {...defaultProps} onClose={onClose} />);
    fireEvent.click(screen.getByText('Cancel'));
    expect(onClose).toHaveBeenCalled();
  });

  it('should render tags from org', () => {
    render(<OrgEditDialog {...defaultProps} />);
    const tagsInput = screen.getByTestId('edit-tags-input') as HTMLInputElement;
    expect(tagsInput.value).toBe('dev');
  });
});
