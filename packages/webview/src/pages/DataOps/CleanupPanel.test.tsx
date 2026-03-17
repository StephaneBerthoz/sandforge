import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { CleanupPanel } from './CleanupPanel';
import type { StorageRecommendation } from '@sandforge/shared';

const recommendations: StorageRecommendation[] = [
  {
    objectApiName: 'OldLogs__c',
    currentRecords: 50000,
    currentSize: 10485760,
    recommendation: 'archive',
    estimatedSaving: 8388608,
    reason: 'Records older than 1 year',
  },
  {
    objectApiName: 'TempData__c',
    currentRecords: 1000,
    currentSize: 204800,
    recommendation: 'delete',
    estimatedSaving: 204800,
    reason: 'Temporary data no longer needed',
  },
];

describe('CleanupPanel', () => {
  it('should render the panel', () => {
    render(<CleanupPanel />);
    expect(screen.getByTestId('cleanup-panel')).toBeDefined();
  });

  it('should show empty state when no recommendations', () => {
    render(<CleanupPanel />);
    expect(screen.getByText('dataops.cleanupDesc')).toBeDefined();
  });

  it('should show recommendation cards', () => {
    render(<CleanupPanel recommendations={recommendations} />);
    expect(screen.getByTestId('rec-OldLogs__c')).toBeDefined();
    expect(screen.getByTestId('rec-TempData__c')).toBeDefined();
  });

  it('should show recommendation badges', () => {
    render(<CleanupPanel recommendations={recommendations} />);
    expect(screen.getByText('archive')).toBeDefined();
    expect(screen.getByText('delete')).toBeDefined();
  });

  it('should show savings summary', () => {
    render(<CleanupPanel recommendations={recommendations} />);
    expect(screen.getByTestId('savings-summary')).toBeDefined();
  });

  it('should call onCleanup when confirm clicked', () => {
    const onCleanup = vi.fn();
    render(<CleanupPanel recommendations={recommendations} onCleanup={onCleanup} />);
    fireEvent.click(screen.getByTestId('cleanup-OldLogs__c'));
    expect(onCleanup).toHaveBeenCalledWith('OldLogs__c', 'archive');
  });

  it('should call onMassDelete', () => {
    const onMassDelete = vi.fn();
    render(<CleanupPanel onMassDelete={onMassDelete} />);
    fireEvent.click(screen.getByTestId('mass-delete-btn'));
    expect(onMassDelete).toHaveBeenCalled();
  });

  it('should call onArchive', () => {
    const onArchive = vi.fn();
    render(<CleanupPanel onArchive={onArchive} />);
    fireEvent.click(screen.getByTestId('archive-btn'));
    expect(onArchive).toHaveBeenCalled();
  });
});
