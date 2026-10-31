import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import { QuickSyncFlow } from './QuickSyncFlow';
import type { QuickSyncFlowActions, QuickSyncFlowState } from './useQuickSyncFlow';

/**
 * How the flow moves between its screens and what it tells the page, its
 * state set by hand: the hook and the screens are tested on their own.
 */

let flowState: QuickSyncFlowState;
const goToOrgs = vi.fn();
const reset = vi.fn();

vi.mock('./useQuickSyncFlow', () => ({
  useQuickSyncFlow: (): QuickSyncFlowActions => ({
    state: flowState,
    setSourceOrg: vi.fn(),
    setTargetOrg: vi.fn(),
    addObject: vi.fn(),
    removeObject: vi.fn(),
    addParentObject: vi.fn(),
    goToOrgs,
    goToObjects: vi.fn(),
    goToPreview: vi.fn(),
    setMuteAutomation: vi.fn(),
    execute: vi.fn(),
    reset,
    canGoToObjects: true,
    canGoToPreview: true,
  }),
}));

vi.mock('./QuickSyncOrgStep', () => ({
  QuickSyncOrgStep: () => <div data-testid="quick-sync-org-step" />,
}));
vi.mock('./QuickSyncObjectStep', () => ({
  QuickSyncObjectStep: ({ onBack }: { onBack: () => void }) => (
    <button type="button" data-testid="quick-sync-object-back" onClick={onBack}>
      Back
    </button>
  ),
}));
vi.mock('./QuickSyncPreviewStep', () => ({
  QuickSyncPreviewStep: () => <div data-testid="quick-sync-preview-step" />,
}));

const OBJECTS: QuickSyncFlowState = {
  step: 'objects',
  sourceOrgId: 'org-1',
  targetOrgId: 'org-2',
  selectedObjects: ['Account'],
  parentObjects: [],
  preview: null,
  result: null,
  isExecuting: false,
  runOperationId: null,
  error: null,
  muteAutomation: false,
};

describe('QuickSyncFlow between its screens', () => {
  beforeEach(() => {
    flowState = { ...OBJECTS };
    goToOrgs.mockClear();
    reset.mockClear();
  });

  it('goes back from the objects to the orgs without starting over', () => {
    render(<QuickSyncFlow onBack={vi.fn()} />);

    fireEvent.click(screen.getByTestId('quick-sync-object-back'));

    expect(goToOrgs).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });

  it('tells the page the pair it copies between, and each pair picked after it', () => {
    const onPairChange = vi.fn();
    const { rerender } = render(<QuickSyncFlow onBack={vi.fn()} onPairChange={onPairChange} />);
    expect(onPairChange).toHaveBeenLastCalledWith('org-1', 'org-2');

    flowState = { ...OBJECTS, targetOrgId: 'org-3' };
    rerender(<QuickSyncFlow onBack={vi.fn()} onPairChange={onPairChange} />);
    expect(onPairChange).toHaveBeenLastCalledWith('org-1', 'org-3');

    // Told once per pair, however often the flow draws.
    rerender(<QuickSyncFlow onBack={vi.fn()} onPairChange={onPairChange} />);
    expect(onPairChange).toHaveBeenCalledTimes(2);
  });

  it('draws the arrow of its back link and the chevrons between its steps', () => {
    render(<QuickSyncFlow onBack={vi.fn()} />);

    const back = screen.getByTestId('quick-sync-back-to-wizard');
    expect(back.querySelector('svg[data-testid="icon-arrow-left"]')).not.toBeNull();
    expect(
      screen
        .getByTestId('quick-sync-step-indicator')
        .querySelectorAll('svg[data-testid="icon-chevron-right"]'),
    ).toHaveLength(2);
    expect(back.textContent).toBe('Back to full wizard');
  });
});
