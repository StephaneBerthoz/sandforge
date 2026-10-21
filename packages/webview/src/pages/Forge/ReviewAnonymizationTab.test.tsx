import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ReviewAnonymizationTab } from './ReviewAnonymizationTab';
import type { ForgeAnonymizationCategory, AnonymizationMethod } from '@sandforge/shared';
import { findForgeAnonymizationPreset } from '@sandforge/shared';

/* ---- Mocks ---- */

const mockSetAnonymizationRule = vi.fn();
const mockSetPresetId = vi.fn();
const mockApplyPreset = vi.fn();
/** The preset the store holds; a template may have brought it back. */
const mockPreset = vi.hoisted(() => ({ id: '' }));
/** Whether the run anonymizes, as its config says. */
const mockAnonymize = vi.hoisted(() => ({ on: true }));
const mockSetAnonymizePII = vi.fn();

const defaultRules: Record<ForgeAnonymizationCategory, AnonymizationMethod> = {
  email: 'fake',
  phone: 'mask',
  name: 'fake',
  address: 'fake',
  ssn_id: 'redact',
  financial: 'hash',
  other: 'nullify',
};

const mockGraph = {
  nodes: [
    {
      objectApiName: 'Account',
      recordCount: 100,
      fieldCount: 20,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: ['Email', 'Phone'],
      anonymizeFields: [],
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 0,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto' as const,
    },
    {
      objectApiName: 'Contact',
      recordCount: 200,
      fieldCount: 15,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: ['FirstName'],
      anonymizeFields: [],
      level: 1,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 0,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto' as const,
    },
  ],
  edges: [],
  totalRecords: 300,
  estimatedSizeMB: 2,
  estimatedDurationSeconds: 10,
};

vi.mock('../../stores/useForgeStore', () => {
  const store = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        anonymizationRules: defaultRules,
        setAnonymizationRule: mockSetAnonymizationRule,
        graph: mockGraph,
        anonymizationPresetId: mockPreset.id,
        setAnonymizationPresetId: mockSetPresetId,
        applyAnonymizationPreset: mockApplyPreset,
        config: { anonymizePII: mockAnonymize.on },
        setAnonymizePII: mockSetAnonymizePII,
      }),
    {
      getState: () => ({
        anonymizationRules: defaultRules,
        setAnonymizationRule: mockSetAnonymizationRule,
        graph: mockGraph,
      }),
    },
  );
  return { useForgeStore: store };
});

/* ---- Tests ---- */

describe('ReviewAnonymizationTab', () => {
  it('opens on the switch, and says of a run that does not anonymize that its fields go as read', () => {
    mockAnonymize.on = false;
    try {
      render(<ReviewAnonymizationTab />);

      const toggle = screen.getByTestId('anonymization-switch');
      expect(toggle).toHaveProperty('checked', false);
      expect(screen.getByTestId('anonymization-off').textContent).toBe(
        'Off: the run writes these fields as the source holds them. Email addresses and phone numbers are neutralized all the same, unless the form keeps them.',
      );
      expect(screen.queryByTestId('anonymization-preset-select')).toBeNull();
      fireEvent.click(toggle);
      expect(mockSetAnonymizePII).toHaveBeenCalledWith(true);
    } finally {
      mockAnonymize.on = true;
    }
  });

  it('shows the methods of a run that anonymizes, and turns it off from the switch', () => {
    render(<ReviewAnonymizationTab />);

    expect(screen.queryByTestId('anonymization-off')).toBeNull();
    expect(screen.getByTestId('anonymization-preset-select')).toBeDefined();
    fireEvent.click(screen.getByTestId('anonymization-switch'));
    expect(mockSetAnonymizePII).toHaveBeenCalledWith(false);
  });

  it('shows the preset the store holds, which a template may have brought back', () => {
    mockPreset.id = 'preset:gdpr-default';
    render(<ReviewAnonymizationTab />);

    const select = screen.getByTestId('anonymization-preset-select') as HTMLSelectElement;
    expect(select.value).toBe('preset:gdpr-default');
    expect(screen.getByTestId('anonymization-preset-description').textContent).toBe(
      findForgeAnonymizationPreset('preset:gdpr-default')?.description,
    );
    mockPreset.id = '';
  });

  it("keeps the preset picked in the store, so the run's results can save it", () => {
    render(<ReviewAnonymizationTab />);

    fireEvent.change(screen.getByTestId('anonymization-preset-select'), {
      target: { value: 'preset:gdpr-default' },
    });

    expect(mockSetPresetId).toHaveBeenCalledWith('preset:gdpr-default');
    expect(mockApplyPreset).toHaveBeenCalledWith(
      findForgeAnonymizationPreset('preset:gdpr-default')?.rules,
    );
  });

  it('should render with data-testid', () => {
    render(<ReviewAnonymizationTab />);
    expect(screen.getByTestId('review-anonymization-tab')).toBeDefined();
  });

  it('should render 7 category rows', () => {
    render(<ReviewAnonymizationTab />);
    const categories = ['email', 'phone', 'name', 'address', 'ssn_id', 'financial', 'other'];
    for (const cat of categories) {
      expect(screen.getByTestId(`anon-row-${cat}`)).toBeDefined();
    }
  });

  it('should render a select dropdown for each category', () => {
    render(<ReviewAnonymizationTab />);
    expect(screen.getByTestId('anon-select-email')).toBeDefined();
    expect(screen.getByTestId('anon-select-phone')).toBeDefined();
    expect(screen.getByTestId('anon-select-name')).toBeDefined();
  });

  it('should show default values matching store rules', () => {
    render(<ReviewAnonymizationTab />);
    const emailSelect = screen.getByTestId('anon-select-email') as HTMLSelectElement;
    expect(emailSelect.value).toBe('fake');
    const phoneSelect = screen.getByTestId('anon-select-phone') as HTMLSelectElement;
    expect(phoneSelect.value).toBe('mask');
    const ssnSelect = screen.getByTestId('anon-select-ssn_id') as HTMLSelectElement;
    expect(ssnSelect.value).toBe('redact');
  });

  it('should call setAnonymizationRule when dropdown changes', () => {
    render(<ReviewAnonymizationTab />);
    const emailSelect = screen.getByTestId('anon-select-email');
    fireEvent.change(emailSelect, { target: { value: 'hash' } });
    expect(mockSetAnonymizationRule).toHaveBeenCalledWith('email', 'hash');
  });

  it('names each method select after the category of its row', () => {
    // Seven identical selects in a table, each named only by the cell to its
    // left, which a screen reader does not read as a label.
    render(<ReviewAnonymizationTab />);
    expect(screen.getByTestId('anon-select-email').getAttribute('aria-label')).toContain('Email');
  });

  it('should display PII field count from graph', () => {
    render(<ReviewAnonymizationTab />);
    const tab = screen.getByTestId('review-anonymization-tab');
    // 2 PII fields from Account + 1 from Contact = 3
    expect(tab.textContent).toContain('3');
  });
});
