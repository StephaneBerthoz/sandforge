import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import type { QuickSyncPreview, SyncExecutionResult } from '@sandforge/shared';
import { QuickSyncPreviewStep } from './QuickSyncPreviewStep';

const mockPreview: QuickSyncPreview = {
  objects: [
    { objectApiName: 'Account', recordCount: 500, estimatedApiCalls: 3, isParentDependency: false },
    { objectApiName: 'Contact', recordCount: 1200, estimatedApiCalls: 7, isParentDependency: true },
  ],
  totalRecords: 1700,
  totalApiCalls: 10,
  estimatedDurationSec: 15,
};

const mockResult: SyncExecutionResult = {
  configId: 'cfg-1',
  operationId: 'op-1',
  status: 'success',
  objectResults: [
    { objectApiName: 'Account', operation: 'upsert', processed: 500, success: 500, failed: 0, skipped: 0, conflictCount: 0, errors: [] },
    { objectApiName: 'Contact', operation: 'upsert', processed: 1200, success: 1195, failed: 5, skipped: 0, conflictCount: 0, errors: ['Some error'] },
  ],
  totalProcessed: 1700,
  totalSuccess: 1695,
  totalFailed: 5,
  totalSkipped: 0,
  duration: 14500,
  timestamp: '2024-01-01T00:00:00Z',
};

describe('QuickSyncPreviewStep', () => {
  const defaultProps = {
    preview: mockPreview,
    result: null as SyncExecutionResult | null,
    isExecuting: false,
    onExecute: vi.fn(),
    onReset: vi.fn(),
    onBack: vi.fn(),
  };

  it('renders preview data with object count and record totals', () => {
    render(<QuickSyncPreviewStep {...defaultProps} />);

    const summary = screen.getByTestId('quick-sync-preview-summary');
    expect(summary).toBeDefined();
    expect(summary.textContent).toContain('1700');
    expect(summary.textContent).toContain('10');
  });

  it('shows Sync Now button when not executing', () => {
    render(<QuickSyncPreviewStep {...defaultProps} />);

    const btn = screen.getByTestId('quick-sync-go-btn');
    expect(btn).toBeDefined();
    expect(btn.textContent).toContain('Sync Now');
  });

  it('shows progress bar during execution', () => {
    render(<QuickSyncPreviewStep {...defaultProps} isExecuting={true} />);

    expect(screen.getByTestId('quick-sync-executing')).toBeDefined();
    expect(screen.getByRole('progressbar')).toBeDefined();
  });

  it('shows results after execution completes', () => {
    render(<QuickSyncPreviewStep {...defaultProps} result={mockResult} />);

    expect(screen.getByTestId('quick-sync-results')).toBeDefined();
    expect(screen.getByTestId('quick-sync-result-summary')).toBeDefined();
    expect(screen.getByTestId('quick-sync-new-btn')).toBeDefined();
  });

  it('calls onExecute when Sync Now button is clicked', () => {
    const onExecute = vi.fn();
    render(<QuickSyncPreviewStep {...defaultProps} onExecute={onExecute} />);

    fireEvent.click(screen.getByTestId('quick-sync-go-btn'));
    expect(onExecute).toHaveBeenCalledTimes(1);
  });

  it('calls onReset when New Quick Sync button is clicked', () => {
    const onReset = vi.fn();
    render(<QuickSyncPreviewStep {...defaultProps} result={mockResult} onReset={onReset} />);

    fireEvent.click(screen.getByTestId('quick-sync-new-btn'));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
