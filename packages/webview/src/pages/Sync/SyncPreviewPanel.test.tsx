import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../i18n';
import { SyncPreviewPanel } from './SyncPreviewPanel';
import type { SyncPreviewData } from './SyncPreviewPanel';

const preview: SyncPreviewData = {
  objects: [
    {
      objectApiName: 'Account',
      operation: 'upsert',
      newRecords: 50,
      modifiedRecords: 200,
      deletedRecords: 0,
      conflictCount: 3,
      estimatedApiCalls: 2,
      riskLevel: 'medium',
      riskReasons: ['3 conflicts detected'],
    },
    {
      objectApiName: 'Contact',
      operation: 'insert',
      newRecords: 500,
      modifiedRecords: 0,
      deletedRecords: 0,
      conflictCount: 0,
      estimatedApiCalls: 3,
      riskLevel: 'low',
      riskReasons: [],
    },
  ],
  totalNewRecords: 550,
  totalModifiedRecords: 200,
  totalDeletedRecords: 0,
  totalConflicts: 3,
  estimatedDuration: 4,
  estimatedApiCalls: 5,
  overallRisk: 'medium',
  warnings: ['3 conflicts detected — review conflict strategy'],
};

describe('SyncPreviewPanel', () => {
  it('should render the panel', () => {
    render(<SyncPreviewPanel preview={preview} />);
    expect(screen.getByTestId('sync-preview-panel')).toBeDefined();
  });

  it('should return null when no preview', () => {
    const { container } = render(<SyncPreviewPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('should show loading state', () => {
    render(<SyncPreviewPanel isLoading />);
    expect(screen.getByTestId('sync-preview-loading')).toBeDefined();
  });

  it('should display overall risk badge', () => {
    render(<SyncPreviewPanel preview={preview} />);
    expect(screen.getByTestId('preview-overall-risk')).toBeDefined();
    expect(screen.getByTestId('preview-overall-risk').textContent).toContain('MEDIUM');
  });

  it('should display summary stats', () => {
    render(<SyncPreviewPanel preview={preview} />);
    expect(screen.getByTestId('preview-stats')).toBeDefined();
    expect(screen.getByTestId('preview-new')).toBeDefined();
    expect(screen.getByTestId('preview-modified')).toBeDefined();
    expect(screen.getByTestId('preview-deleted')).toBeDefined();
    expect(screen.getByTestId('preview-conflicts')).toBeDefined();
  });

  it('should show correct stat values', () => {
    render(<SyncPreviewPanel preview={preview} />);
    expect(screen.getByTestId('preview-new').textContent).toContain('550');
    expect(screen.getByTestId('preview-modified').textContent).toContain('200');
    expect(screen.getByTestId('preview-conflicts').textContent).toContain('3');
  });

  it('should show estimates', () => {
    render(<SyncPreviewPanel preview={preview} />);
    expect(screen.getByTestId('preview-estimates')).toBeDefined();
    expect(screen.getByTestId('preview-estimates').textContent).toContain('5');
    expect(screen.getByTestId('preview-estimates').textContent).toContain('4s');
  });

  it('should show warnings', () => {
    render(<SyncPreviewPanel preview={preview} />);
    expect(screen.getByTestId('preview-warnings')).toBeDefined();
    expect(screen.getByTestId('preview-warning-0')).toBeDefined();
  });

  it('should show per-object breakdown', () => {
    render(<SyncPreviewPanel preview={preview} />);
    expect(screen.getByTestId('preview-objects')).toBeDefined();
    expect(screen.getByTestId('preview-obj-Account')).toBeDefined();
    expect(screen.getByTestId('preview-obj-Contact')).toBeDefined();
  });

  it('should show conflict count on objects with conflicts', () => {
    render(<SyncPreviewPanel preview={preview} />);
    const accountRow = screen.getByTestId('preview-obj-Account');
    expect(accountRow.textContent).toContain('3');
    expect(accountRow.textContent).toContain('conflicts');
  });

  it('should show risk level per object', () => {
    render(<SyncPreviewPanel preview={preview} />);
    const accountRow = screen.getByTestId('preview-obj-Account');
    expect(accountRow.textContent).toContain('medium');
  });

  it('should show HIGH risk with error badge for high risk', () => {
    const highRiskPreview: SyncPreviewData = {
      ...preview,
      overallRisk: 'high',
      totalDeletedRecords: 100,
      warnings: ['100 records will be deleted'],
    };
    render(<SyncPreviewPanel preview={highRiskPreview} />);
    expect(screen.getByTestId('preview-overall-risk').textContent).toContain('HIGH');
  });

  it('should not show warnings section when no warnings', () => {
    const noWarnings: SyncPreviewData = { ...preview, warnings: [] };
    render(<SyncPreviewPanel preview={noWarnings} />);
    expect(screen.queryByTestId('preview-warnings')).toBeNull();
  });
});
