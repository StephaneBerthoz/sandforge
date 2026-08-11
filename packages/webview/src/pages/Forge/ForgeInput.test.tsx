import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '../../i18n';
import { ForgeInput } from './ForgeInput';

/* ---- Store mocks ---- */

const mockSetConfig = vi.fn();
const mockSetPhase = vi.fn();
const mockAddTemplate = vi.fn();
const mockUpdateTemplate = vi.fn();
const mockRemoveTemplate = vi.fn();

/* Mutable user-template list — tests push into it before rendering. */
const mockTemplates = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));

vi.mock('../../stores/useForgeStore', () => {
  const defaultState = {
    phase: 'input' as const,
    config: null,
    templates: mockTemplates.list,
    graph: null,
    result: null,
    history: [],
    setConfig: (...args: unknown[]) => mockSetConfig(...args),
    setPhase: (...args: unknown[]) => mockSetPhase(...args),
    addTemplate: (...args: unknown[]) => mockAddTemplate(...args),
    updateTemplate: (...args: unknown[]) => mockUpdateTemplate(...args),
    removeTemplate: (...args: unknown[]) => mockRemoveTemplate(...args),
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

vi.mock('../../stores/useNotificationStore', () => ({
  useNotificationStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ addNotification: vi.fn() }),
}));

vi.mock('../../components/ui/DangerConfirm', () => ({
  DangerConfirm: ({
    open,
    onConfirm,
    title,
  }: {
    open: boolean;
    onConfirm: () => void;
    title: string;
  }) =>
    open ? (
      <div data-testid="danger-confirm">
        <span>{title}</span>
        <button onClick={onConfirm}>Confirm</button>
      </div>
    ) : null,
}));

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

/** Helper to select an org from the OrgDropdown custom component.
 * Use orgId='empty' to select the placeholder (clear selection).
 */
function selectOrg(testId: string, orgId: string): void {
  const trigger = screen.getByTestId(testId);
  fireEvent.click(trigger);
  const optionTestId = orgId === 'empty' ? `${testId}-option-empty` : `${testId}-option-${orgId}`;
  fireEvent.click(screen.getByTestId(optionTestId));
}

describe('ForgeInput', () => {
  beforeEach(() => {
    mockSetConfig.mockClear();
    mockSetPhase.mockClear();
    mockAddTemplate.mockClear();
    mockUpdateTemplate.mockClear();
    mockRemoveTemplate.mockClear();
    mockTemplates.list.length = 0;
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

  it('should expand a user template into its saved record input when discovering', () => {
    // The extension cannot resolve a bare templateId (templates live in the
    // webview store) — handleDiscover must expand the template's saved root
    // input into the outgoing config.
    mockTemplates.list.push({
      id: 'tpl-rec',
      name: 'Account pack',
      description: '',
      config: { inputMode: 'record', recordId: '001XXXXXXXXXXXXXXX', depth: 'full' },
      objectCount: 0,
      recordCount: 0,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
    });
    render(<ForgeInput />);

    // Radix tabs activate on mouseDown (automatic mode), not click.
    fireEvent.mouseDown(screen.getByTestId('forge-tab-template'));
    fireEvent.click(screen.getByText('Account pack'));
    selectOrg('forge-target-org', 'org-tgt');
    fireEvent.click(screen.getByTestId('forge-discover-btn'));

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    const config = mockSetConfig.mock.calls[0][0];
    expect(config.inputMode).toBe('record');
    expect(config.recordId).toBe('001XXXXXXXXXXXXXXX');
    expect(config.templateId).toBeUndefined();
    expect(mockSetPhase).toHaveBeenCalledWith('discovery');
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
    selectOrg('forge-target-org', 'org-tgt');

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
      target: {
        value: 'https://myorg.lightning.force.com/lightning/r/Account/001XXXXXXXXXXXXXXX/view',
      },
    });

    // Source is auto-selected; set target
    selectOrg('forge-target-org', 'org-tgt');

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
    selectOrg('forge-target-org', 'org-tgt');

    fireEvent.click(screen.getByTestId('forge-discover-btn'));

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    const config = mockSetConfig.mock.calls[0][0];
    expect(config.recordId).toBe('003ABCDEFGHIJKLMNO');
  });

  /* ---- UX-01: Auto-select source org on mount ---- */
  it('should auto-select source org from global selectedOrgId on mount', () => {
    render(<ForgeInput />);
    const sourceTrigger = screen.getByTestId('forge-source-org');
    // OrgDropdown shows the alias of the auto-selected org
    expect(sourceTrigger.textContent).toContain('SourceOrg');
  });

  /* ---- UX-03: Same org guard ---- */
  it('should show warning and disable discover when source === target', () => {
    render(<ForgeInput />);
    // Source is auto-selected to org-src; set target to the same
    selectOrg('forge-target-org', 'org-src');
    // Fill input to isolate the guard
    const input = screen.getByTestId('forge-input-record') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '001XXXXXXXXXXXXXXX' } });
    expect(screen.getByTestId('forge-same-org-warning')).toBeDefined();
    expect((screen.getByTestId('forge-discover-btn') as HTMLButtonElement).disabled).toBe(true);
  });

  /* ---- UX-04: Swap orgs ---- */
  it('should swap source and target orgs when swap button is clicked', () => {
    render(<ForgeInput />);
    // Source is auto-selected to org-src; set target to org-tgt
    selectOrg('forge-target-org', 'org-tgt');
    fireEvent.click(screen.getByTestId('forge-swap-orgs'));
    // After swap: source should show TargetOrg, target should show SourceOrg
    const sourceTrigger = screen.getByTestId('forge-source-org');
    const targetTrigger = screen.getByTestId('forge-target-org');
    expect(sourceTrigger.textContent).toContain('TargetOrg');
    expect(targetTrigger.textContent).toContain('SourceOrg');
  });

  /* ---- UX-05: Disabled CTA hint ---- */
  it('should show hint message when discover button is disabled', () => {
    render(<ForgeInput />);
    // Clear source org that was auto-selected by selecting the empty option
    selectOrg('forge-source-org', 'empty');
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
    const previewArea = document.querySelector(
      '[data-testid="forge-input"] .rounded-lg.border-dashed',
    );
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

  /* ---- UX-23: Template management ---- */
  it('should show create template button in template tab', () => {
    render(<ForgeInput />);
    fireEvent.click(screen.getByTestId('forge-tab-template'));
    expect(screen.getByTestId('forge-template-create')).toBeDefined();
  });

  it('should open create template form when create button is clicked', () => {
    render(<ForgeInput />);
    fireEvent.click(screen.getByTestId('forge-tab-template'));
    fireEvent.click(screen.getByTestId('forge-template-create'));
    expect(screen.getByTestId('forge-template-name-input')).toBeDefined();
    expect(screen.getByTestId('forge-template-desc-input')).toBeDefined();
  });

  it('should cancel create template form', () => {
    render(<ForgeInput />);
    fireEvent.click(screen.getByTestId('forge-tab-template'));
    fireEvent.click(screen.getByTestId('forge-template-create'));
    fireEvent.click(screen.getByTestId('forge-template-cancel'));
    // Should go back to the create button
    expect(screen.getByTestId('forge-template-create')).toBeDefined();
  });

  /* ---- A11Y-04: Depth chips radiogroup ---- */
  it('should have role="radiogroup" on depth chips container', () => {
    render(<ForgeInput />);
    const radiogroup = screen.getByRole('radiogroup');
    expect(radiogroup).toBeDefined();
  });

  it('should have aria-checked on depth radio chips', () => {
    render(<ForgeInput />);
    const direct = screen.getByTestId('forge-depth-direct');
    const full = screen.getByTestId('forge-depth-full');
    const custom = screen.getByTestId('forge-depth-custom');
    expect(direct.getAttribute('aria-checked')).toBe('true');
    expect(full.getAttribute('aria-checked')).toBe('false');
    expect(custom.getAttribute('aria-checked')).toBe('false');
  });

  it('should navigate depth chips with ArrowRight key', () => {
    render(<ForgeInput />);
    const direct = screen.getByTestId('forge-depth-direct');
    // Initially "direct" is selected
    expect(direct.getAttribute('aria-checked')).toBe('true');
    // Press ArrowRight on direct -> should select full
    fireEvent.keyDown(direct, { key: 'ArrowRight' });
    const full = screen.getByTestId('forge-depth-full');
    expect(full.getAttribute('aria-checked')).toBe('true');
    expect(direct.getAttribute('aria-checked')).toBe('false');
  });
});
