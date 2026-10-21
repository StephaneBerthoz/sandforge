import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../../i18n';
import type { SyncExecutionResult } from '@sandforge/shared';
import { QuickSyncFlow } from './QuickSyncFlow';
import type { QuickSyncFlowActions, QuickSyncFlowState } from './useQuickSyncFlow';

/**
 * What Quick Sync tells a screen reader and hands the keyboard, the flow's
 * state set by hand: its screens are drawn by components tested on their own.
 */

let flowState: QuickSyncFlowState;

vi.mock('./useQuickSyncFlow', () => ({
  useQuickSyncFlow: (): QuickSyncFlowActions => ({
    state: flowState,
    setSourceOrg: vi.fn(),
    setTargetOrg: vi.fn(),
    addObject: vi.fn(),
    removeObject: vi.fn(),
    addParentObject: vi.fn(),
    goToObjects: vi.fn(),
    goToPreview: vi.fn(),
    execute: vi.fn(),
    reset: vi.fn(),
    canGoToObjects: true,
    canGoToPreview: true,
  }),
}));

vi.mock('./QuickSyncOrgStep', () => ({
  QuickSyncOrgStep: () => <div data-testid="quick-sync-org-step" />,
}));
vi.mock('./QuickSyncObjectStep', () => ({
  QuickSyncObjectStep: () => <div data-testid="quick-sync-object-step" />,
}));
vi.mock('./QuickSyncPreviewStep', () => ({
  QuickSyncPreviewStep: ({ isExecuting }: { isExecuting: boolean }) => (
    <button data-testid={isExecuting ? 'quick-sync-executing' : 'quick-sync-go'}>step</button>
  ),
}));

const INITIAL: QuickSyncFlowState = {
  step: 'preview',
  sourceOrgId: 'org-1',
  targetOrgId: 'org-2',
  selectedObjects: ['Account'],
  parentObjects: [],
  preview: null,
  result: null,
  isExecuting: false,
  runOperationId: null,
  error: null,
};

const RESULT: SyncExecutionResult = {
  configId: 'quick-sync',
  operationId: 'op-quick-sync',
  status: 'success',
  objectResults: [],
  totalProcessed: 12,
  totalSuccess: 12,
  totalFailed: 0,
  totalSkipped: 0,
  duration: 1000,
  timestamp: '2026-10-01T00:00:00Z',
};

describe('QuickSyncFlow for a screen reader', () => {
  beforeEach(() => {
    flowState = { ...INITIAL };
  });

  it('says the run started, its bar having no figure to read out', () => {
    flowState = { ...INITIAL, step: 'executing', isExecuting: true };
    render(<QuickSyncFlow onBack={vi.fn()} />);
    expect(screen.getByTestId('quick-sync-status').textContent).toBe('Syncing...');
  });

  it('says how the run ended once its results replace the bar', () => {
    flowState = { ...INITIAL, step: 'results', result: RESULT };
    render(<QuickSyncFlow onBack={vi.fn()} />);
    expect(screen.getByTestId('quick-sync-status').textContent).toBe(
      'Sync complete. Written: 12 of 12.',
    );
  });

  it('says a cancelled run was cancelled', () => {
    flowState = {
      ...INITIAL,
      step: 'results',
      result: { ...RESULT, status: 'partial', cancelled: true, totalSuccess: 5 },
    };
    render(<QuickSyncFlow onBack={vi.fn()} />);
    expect(screen.getByTestId('quick-sync-status').textContent).toBe(
      'Cancelled. Written: 5 of 12.',
    );
  });

  it('raises its error as an alert, heard wherever the focus is', () => {
    flowState = { ...INITIAL, error: 'Source org not connected' };
    render(<QuickSyncFlow onBack={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toBe('Source org not connected');
    expect(screen.getByRole('alert')).toBe(screen.getByTestId('quick-sync-error'));
  });

  it('hands the next screen the focus the button that moved on dropped', () => {
    const { rerender } = render(<QuickSyncFlow onBack={vi.fn()} />);
    screen.getByTestId('quick-sync-go').focus();
    flowState = { ...INITIAL, step: 'executing', isExecuting: true };
    rerender(<QuickSyncFlow onBack={vi.fn()} />);
    expect(document.activeElement).toBe(screen.getByRole('group', { name: 'Syncing...' }));
  });
});
