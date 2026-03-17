import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../i18n';
import { ReviewAnonymizationTab } from './ReviewAnonymizationTab';
import type { ForgeAnonymizationCategory, AnonymizationMethod } from '@sandforge/shared';

/* ---- Mocks ---- */

const mockSetAnonymizationRule = vi.fn();

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
  it('should render with data-testid', () => {
    render(<ReviewAnonymizationTab />);
    expect(screen.getByTestId('review-anonymization-tab')).toBeDefined();
  });

  it('should render 7 category rows', () => {
    render(<ReviewAnonymizationTab />);
    const categories = [
      'email',
      'phone',
      'name',
      'address',
      'ssn_id',
      'financial',
      'other',
    ];
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

  it('should display PII field count from graph', () => {
    render(<ReviewAnonymizationTab />);
    const tab = screen.getByTestId('review-anonymization-tab');
    // 2 PII fields from Account + 1 from Contact = 3
    expect(tab.textContent).toContain('3');
  });
});
