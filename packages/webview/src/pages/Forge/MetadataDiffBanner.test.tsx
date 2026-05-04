import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { MetadataDiffBanner } from './MetadataDiffBanner';
import type { MetadataDiff } from './MetadataDiffBanner';

const sampleDiffs: MetadataDiff[] = [
  { type: 'field', name: 'Account.Custom_Field__c', severity: 'warning' },
  { type: 'recordType', name: 'Contact.VIP', severity: 'error' },
];

describe('MetadataDiffBanner', () => {
  it('should render diffs when provided', () => {
    render(<MetadataDiffBanner diffs={sampleDiffs} />);
    expect(screen.getByTestId('metadata-diff-banner')).toBeDefined();
    expect(screen.getByTestId('diff-list')).toBeDefined();
    expect(screen.getByText('Account.Custom_Field__c')).toBeDefined();
    expect(screen.getByText('Contact.VIP')).toBeDefined();
  });

  it('should render nothing when diffs array is empty', () => {
    const { container } = render(<MetadataDiffBanner diffs={[]} />);
    expect(container.innerHTML).toBe('');
  });

  it('should call onSyncMetadata when sync button is clicked', () => {
    const onSync = vi.fn();
    render(<MetadataDiffBanner diffs={sampleDiffs} onSyncMetadata={onSync} />);
    fireEvent.click(screen.getByTestId('sync-metadata-btn'));
    expect(onSync).toHaveBeenCalledTimes(1);
  });

  it('should call onSkip when skip button is clicked', () => {
    const onSkip = vi.fn();
    render(<MetadataDiffBanner diffs={sampleDiffs} onSkip={onSkip} />);
    fireEvent.click(screen.getByTestId('skip-metadata-btn'));
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('should not render sync button when onSyncMetadata is not provided', () => {
    render(<MetadataDiffBanner diffs={sampleDiffs} />);
    expect(screen.queryByTestId('sync-metadata-btn')).toBeNull();
  });

  it('should not render skip button when onSkip is not provided', () => {
    render(<MetadataDiffBanner diffs={sampleDiffs} />);
    expect(screen.queryByTestId('skip-metadata-btn')).toBeNull();
  });

  it('should show both buttons when both callbacks are provided', () => {
    render(<MetadataDiffBanner diffs={sampleDiffs} onSyncMetadata={vi.fn()} onSkip={vi.fn()} />);
    expect(screen.getByTestId('sync-metadata-btn')).toBeDefined();
    expect(screen.getByTestId('skip-metadata-btn')).toBeDefined();
  });
});
