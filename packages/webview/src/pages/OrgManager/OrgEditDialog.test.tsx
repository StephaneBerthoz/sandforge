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
