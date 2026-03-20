import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '../../i18n';
import { ForgeInput } from './ForgeInput';

/* ---- Store mocks ---- */

const mockSetConfig = vi.fn();
const mockSetPhase = vi.fn();

vi.mock('../../stores/useForgeStore', () => {
  const defaultState = {
    phase: 'input' as const,
    config: null,
    templates: [],
    graph: null,
    result: null,
    history: [],
    setConfig: (...args: unknown[]) => mockSetConfig(...args),
    setPhase: (...args: unknown[]) => mockSetPhase(...args),
    setGraph: vi.fn(),
    updateNodeStatus: vi.fn(),
    toggleNodeIncluded: vi.fn(),
    toggleAnonymizeField: vi.fn(),
    setResult: vi.fn(),
    reset: vi.fn(),
  };

  const store = Object.assign(
    (selector: (state: typeof defaultState) => unknown) => selector(defaultState),
    { getState: () => defaultState },
  );

  return { useForgeStore: store };
});

vi.mock('../../stores/useOrgStore', () => ({
  useOrgStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      orgs: [
        {
          id: 'org-src',
          alias: 'SourceOrg',
          username: 'src@test.com',
          instanceUrl: 'https://src.salesforce.com',
          status: 'connected',
          orgType: 'Sandbox',
          safetyTier: 'low',
        },
        {
          id: 'org-tgt',
          alias: 'TargetOrg',
          username: 'tgt@test.com',
          instanceUrl: 'https://tgt.salesforce.com',
          status: 'connected',
          orgType: 'Sandbox',
          safetyTier: 'low',
        },
      ],
      selectedOrgId: 'org-src',
    }),
}));

/* ---- Tests ---- */

describe('ForgeInput', () => {
  beforeEach(() => {
    mockSetConfig.mockClear();
    mockSetPhase.mockClear();
  });

  it('should render 4 tabs', () => {
    render(<ForgeInput />);
    expect(screen.getByTestId('forge-tab-record')).toBeDefined();
    expect(screen.getByTestId('forge-tab-soql')).toBeDefined();
    expect(screen.getByTestId('forge-tab-template')).toBeDefined();
    expect(screen.getByTestId('forge-tab-ai')).toBeDefined();
  });

  it('should have record tab active by default', () => {
    render(<ForgeInput />);
    const recordTab = screen.getByTestId('forge-tab-record');
    expect(recordTab.getAttribute('data-state')).toBe('active');
  });

  it('should render the record input field', () => {
    render(<ForgeInput />);
    expect(screen.getByTestId('forge-input-record')).toBeDefined();
  });

  it('should allow typing in record ID field', () => {
    render(<ForgeInput />);
    const input = screen.getByTestId('forge-input-record') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '001XXXXXXXXXXXXXXX' } });
    expect(input.value).toBe('001XXXXXXXXXXXXXXX');
  });

  it('should have SOQL tab as a clickable trigger', () => {
    render(<ForgeInput />);
    const soqlTab = screen.getByTestId('forge-tab-soql');
    // Verify it exists and has the correct role for accessibility
    expect(soqlTab.getAttribute('role')).toBe('tab');
    // Initially the record tab is active and SOQL is inactive
    expect(soqlTab.getAttribute('data-state')).toBe('inactive');
    expect(screen.getByTestId('forge-tab-record').getAttribute('data-state')).toBe('active');
  });

  it('should render depth selectors', () => {
    render(<ForgeInput />);
    expect(screen.getByTestId('forge-depth-direct')).toBeDefined();
    expect(screen.getByTestId('forge-depth-full')).toBeDefined();
    expect(screen.getByTestId('forge-depth-custom')).toBeDefined();
  });

  it('should render source and target org selectors', () => {
    render(<ForgeInput />);
    expect(screen.getByTestId('forge-source-org')).toBeDefined();
    expect(screen.getByTestId('forge-target-org')).toBeDefined();
  });

  it('should render option toggles', () => {
    render(<ForgeInput />);
    expect(screen.getByTestId('forge-anonymize-toggle')).toBeDefined();
    expect(screen.getByTestId('forge-skip-empty-toggle')).toBeDefined();
  });

  it('should disable discover button when no input is provided', () => {
    render(<ForgeInput />);
    const btn = screen.getByTestId('forge-discover-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('should call setConfig and setPhase when discover is clicked with valid input', () => {
    render(<ForgeInput />);

    // Fill in record ID
    const recordInput = screen.getByTestId('forge-input-record') as HTMLInputElement;
    fireEvent.change(recordInput, { target: { value: '001XXXXXXXXXXXXXXX' } });

    // Source org is auto-selected from selectedOrgId; just set target
    const targetSelect = screen.getByTestId('forge-target-org') as HTMLSelectElement;
    fireEvent.change(targetSelect, { target: { value: 'org-tgt' } });

    // Click discover
    const btn = screen.getByTestId('forge-discover-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    expect(mockSetPhase).toHaveBeenCalledWith('discovery');

    const config = mockSetConfig.mock.calls[0][0];
    expect(config.inputMode).toBe('record');
    expect(config.recordId).toBe('001XXXXXXXXXXXXXXX');
    expect(config.sourceOrgId).toBe('org-src');
    expect(config.targetOrgId).toBe('org-tgt');
  });

  it('should extract record ID from a full Salesforce URL when discovering', () => {
    render(<ForgeInput />);

    const recordInput = screen.getByTestId('forge-input-record') as HTMLInputElement;
    fireEvent.change(recordInput, {
      target: { value: 'https://myorg.lightning.force.com/lightning/r/Account/001XXXXXXXXXXXXXXX/view' },
    });

    // Source is auto-selected; set target
    const targetSelect = screen.getByTestId('forge-target-org') as HTMLSelectElement;
    fireEvent.change(targetSelect, { target: { value: 'org-tgt' } });

    fireEvent.click(screen.getByTestId('forge-discover-btn'));

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    const config = mockSetConfig.mock.calls[0][0];
    expect(config.recordId).toBe('001XXXXXXXXXXXXXXX');
  });

  it('should show em-dash for estimated objects when no preview is loaded', () => {
    render(<ForgeInput />);
    const estObjects = screen.getByTestId('est-objects');
    expect(estObjects.textContent).toBe('\u2014');
  });

  it('should show preview-derived data when preview is loaded', async () => {
    render(<ForgeInput />);

    // Simulate preview response
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            id: 'test-preview-1',
            type: 'forge:preview:response',
            timestamp: Date.now(),
            payload: {
              objectApiName: 'Account',
              objectLabel: 'Account',
              recordId: '001XXXXXXXXXXXXXXX',
              fields: [
                { name: 'Name', value: 'Test' },
                { name: 'Industry', value: 'Tech' },
                { name: 'Phone', value: '555-1234' },
              ],
            },
          },
        }),
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId('est-objects').textContent).toBe('1');
      expect(screen.getByTestId('est-fields').textContent).toBe('3');
    });
  });

  it('should pass plain 18-char ID as-is when discovering', () => {
    render(<ForgeInput />);

    const recordInput = screen.getByTestId('forge-input-record') as HTMLInputElement;
    fireEvent.change(recordInput, { target: { value: '003ABCDEFGHIJKLMNO' } });

    // Source is auto-selected; set target
    const targetSelect = screen.getByTestId('forge-target-org') as HTMLSelectElement;
    fireEvent.change(targetSelect, { target: { value: 'org-tgt' } });

    fireEvent.click(screen.getByTestId('forge-discover-btn'));

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    const config = mockSetConfig.mock.calls[0][0];
    expect(config.recordId).toBe('003ABCDEFGHIJKLMNO');
  });

  /* ---- UX-01: Auto-select source org on mount ---- */
  it('should auto-select source org from global selectedOrgId on mount', () => {
    render(<ForgeInput />);
    const sourceSelect = screen.getByTestId('forge-source-org') as HTMLSelectElement;
    expect(sourceSelect.value).toBe('org-src');
  });

  /* ---- UX-03: Same org guard ---- */
  it('should show warning and disable discover when source === target', () => {
    render(<ForgeInput />);
    const sourceSelect = screen.getByTestId('forge-source-org') as HTMLSelectElement;
    const targetSelect = screen.getByTestId('forge-target-org') as HTMLSelectElement;
    fireEvent.change(sourceSelect, { target: { value: 'org-src' } });
    fireEvent.change(targetSelect, { target: { value: 'org-src' } });
    // Fill input to isolate the guard
    const input = screen.getByTestId('forge-input-record') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '001XXXXXXXXXXXXXXX' } });
    expect(screen.getByTestId('forge-same-org-warning')).toBeDefined();
    expect((screen.getByTestId('forge-discover-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  /* ---- UX-04: Swap orgs ---- */
  it('should swap source and target orgs when swap button is clicked', () => {
    render(<ForgeInput />);
    const sourceSelect = screen.getByTestId('forge-source-org') as HTMLSelectElement;
    const targetSelect = screen.getByTestId('forge-target-org') as HTMLSelectElement;
    fireEvent.change(sourceSelect, { target: { value: 'org-src' } });
    fireEvent.change(targetSelect, { target: { value: 'org-tgt' } });
    fireEvent.click(screen.getByTestId('forge-swap-orgs'));
    expect(sourceSelect.value).toBe('org-tgt');
    expect(targetSelect.value).toBe('org-src');
  });

  /* ---- UX-05: Disabled CTA hint ---- */
  it('should show hint message when discover button is disabled', () => {
    render(<ForgeInput />);
    // Clear source org that was auto-selected
    const sourceSelect = screen.getByTestId('forge-source-org') as HTMLSelectElement;
    fireEvent.change(sourceSelect, { target: { value: '' } });
    expect(screen.getByTestId('forge-discover-hint')).toBeDefined();
  });

  /* ---- UX-07: Depth chip tooltips ---- */
  it('should render depth chips with title tooltips', () => {
    render(<ForgeInput />);
    const directChip = screen.getByTestId('forge-depth-direct');
    expect(directChip.getAttribute('title')).toBeTruthy();
    const fullChip = screen.getByTestId('forge-depth-full');
    expect(fullChip.getAttribute('title')).toBeTruthy();
  });

  /* ---- UX-08: Ctrl+Enter submit ---- */
  it('should not trigger discover on Ctrl+Enter when canDiscover is false', () => {
    render(<ForgeInput />);
    // Record input is visible by default; type something but do NOT set target org
    const input = screen.getByTestId('forge-input-record') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '001XXXXXXXXXXXXXXX' } });
    // Ctrl+Enter on the input should NOT trigger discover (no target org)
    fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true });
    expect(mockSetPhase).not.toHaveBeenCalled();
  });

  /* ---- UX-09: Preview panel shows record-mode text by default ---- */
  it('should show record-mode preview placeholder on record tab', () => {
    render(<ForgeInput />);
    // On the record tab with a source org auto-selected, the placeholder should show recordIdPlaceholder text
    const previewArea = document.querySelector('[data-testid="forge-input"] .rounded-lg.border-dashed');
    expect(previewArea).toBeDefined();
    // Should NOT show SOQL/AI/Template hints when on the record tab
    expect(previewArea?.textContent).not.toContain('SOQL');
    expect(previewArea?.textContent).not.toContain('AI');
  });

  /* ---- UX-10: Refresh button exists ---- */
  it('should render a refresh preview button', () => {
    render(<ForgeInput />);
    const previewBtn = screen.getByTestId('forge-preview-btn');
    expect(previewBtn.getAttribute('aria-label')).toContain('efresh');
  });
});
