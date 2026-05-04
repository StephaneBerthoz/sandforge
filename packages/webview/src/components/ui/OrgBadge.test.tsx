import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OrgBadge } from './OrgBadge';

describe('OrgBadge', () => {
  const defaultProps = {
    alias: 'my-sandbox',
    orgType: 'Sandbox',
    status: 'connected',
  };

  it('should render with data-testid on root', () => {
    render(<OrgBadge {...defaultProps} />);
    expect(screen.getByTestId('org-badge')).toBeDefined();
  });

  it('should display the alias text', () => {
    render(<OrgBadge {...defaultProps} />);
    expect(screen.getByTestId('org-badge-alias').textContent).toBe('my-sandbox');
  });

  it('should display the org type as SBX for Sandbox', () => {
    render(<OrgBadge {...defaultProps} />);
    expect(screen.getByTestId('org-badge-type').textContent).toBe('SBX');
  });

  it('should display PROD for Production type', () => {
    render(<OrgBadge {...defaultProps} orgType="Production" />);
    expect(screen.getByTestId('org-badge-type').textContent).toBe('PROD');
  });

  it('should display SCR for Scratch type', () => {
    render(<OrgBadge {...defaultProps} orgType="Scratch" />);
    expect(screen.getByTestId('org-badge-type').textContent).toBe('SCR');
  });

  it('should apply connected status color on dot', () => {
    render(<OrgBadge {...defaultProps} status="connected" />);
    const dot = screen.getByTestId('org-badge-status-dot');
    expect(dot.className).toContain('bg-[var(--sf-success)]');
  });

  it('should apply expired status color on dot', () => {
    render(<OrgBadge {...defaultProps} status="expired" />);
    const dot = screen.getByTestId('org-badge-status-dot');
    expect(dot.className).toContain('bg-[var(--sf-warning)]');
  });

  it('should apply error status color on dot', () => {
    render(<OrgBadge {...defaultProps} status="error" />);
    const dot = screen.getByTestId('org-badge-status-dot');
    expect(dot.className).toContain('bg-[var(--sf-error)]');
  });

  it('should render truncated instanceUrl when provided', () => {
    render(<OrgBadge {...defaultProps} instanceUrl="https://my-sandbox.salesforce.com/" />);
    const urlEl = screen.getByTestId('org-badge-url');
    expect(urlEl.textContent).toBe('my-sandbox.salesforce.com');
  });

  it('should not render URL element when instanceUrl is not provided', () => {
    render(<OrgBadge {...defaultProps} />);
    expect(screen.queryByTestId('org-badge-url')).toBeNull();
  });

  it('should merge custom className', () => {
    render(<OrgBadge {...defaultProps} className="ml-4" />);
    expect(screen.getByTestId('org-badge').className).toContain('ml-4');
  });

  it('should handle unknown orgType gracefully', () => {
    render(<OrgBadge {...defaultProps} orgType="Developer" />);
    expect(screen.getByTestId('org-badge-type').textContent).toBe('DEV');
  });

  it('should fallback to error color for unknown status', () => {
    render(<OrgBadge {...defaultProps} status="unknown" />);
    const dot = screen.getByTestId('org-badge-status-dot');
    expect(dot.className).toContain('bg-[var(--sf-error)]');
  });

  it('should have Production badge with error background', () => {
    render(<OrgBadge {...defaultProps} orgType="Production" />);
    const badge = screen.getByTestId('org-badge-type');
    expect(badge.className).toContain('bg-[var(--sf-error)]');
  });

  it('should have Sandbox badge with info background', () => {
    render(<OrgBadge {...defaultProps} orgType="Sandbox" />);
    const badge = screen.getByTestId('org-badge-type');
    expect(badge.className).toContain('bg-[var(--sf-info)]');
  });

  it('should have Scratch badge with success background', () => {
    render(<OrgBadge {...defaultProps} orgType="Scratch" />);
    const badge = screen.getByTestId('org-badge-type');
    expect(badge.className).toContain('bg-[var(--sf-success)]');
  });
});
