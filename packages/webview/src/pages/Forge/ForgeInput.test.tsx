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

    // Select source org
    const sourceSelect = screen.getByTestId('forge-source-org') as HTMLSelectElement;
    fireEvent.change(sourceSelect, { target: { value: 'org-src' } });

    // Select target org
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

    const sourceSelect = screen.getByTestId('forge-source-org') as HTMLSelectElement;
    fireEvent.change(sourceSelect, { target: { value: 'org-src' } });

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

    const sourceSelect = screen.getByTestId('forge-source-org') as HTMLSelectElement;
    fireEvent.change(sourceSelect, { target: { value: 'org-src' } });

    const targetSelect = screen.getByTestId('forge-target-org') as HTMLSelectElement;
    fireEvent.change(targetSelect, { target: { value: 'org-tgt' } });

    fireEvent.click(screen.getByTestId('forge-discover-btn'));

    expect(mockSetConfig).toHaveBeenCalledTimes(1);
    const config = mockSetConfig.mock.calls[0][0];
    expect(config.recordId).toBe('003ABCDEFGHIJKLMNO');
  });
});
