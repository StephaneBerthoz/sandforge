import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '../../../i18n';
import type { PersonaMsg } from '@sandforge/shared';
import { PersonaCustomizePanel } from './PersonaCustomizePanel';

const mockPersona: PersonaMsg = {
  id: 'banque-eu',
  name: 'Banque europeenne',
  description: 'European bank with accounts and transactions.',
  industry: 'Banking',
  locale: 'fr-FR',
  dataPatterns: {
    IBAN__c: {
      fieldType: 'string',
      generator: 'faker',
      params: { method: 'finance.iban', locale: 'fr' },
      examples: ['FR7630006000011234567890189', 'DE89370400440532013000'],
    },
    Transaction_Amount__c: {
      fieldType: 'currency',
      generator: 'range',
      params: { min: -10000, max: 50000, currency: 'EUR' },
      examples: ['1250.00', '-450.75', '15000.00'],
    },
    Transaction_Type__c: {
      fieldType: 'picklist',
      generator: 'random_pick',
      params: { values: ['Virement', 'Prelevement', 'Carte'] },
      examples: ['Virement', 'Carte', 'Prelevement'],
    },
    DPE__c: {
      fieldType: 'picklist',
      generator: 'weighted_pick',
      params: { values: { A: 0.05, B: 0.1, C: 0.2 } },
      examples: ['C', 'B', 'A'],
    },
  },
};

describe('PersonaCustomizePanel', () => {
  it('renders all field rows from the persona', () => {
    render(<PersonaCustomizePanel persona={mockPersona} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByTestId('persona-customize-panel')).toBeDefined();
    expect(screen.getByTestId('field-row-IBAN__c')).toBeDefined();
    expect(screen.getByTestId('field-row-Transaction_Amount__c')).toBeDefined();
    expect(screen.getByTestId('field-row-Transaction_Type__c')).toBeDefined();
  });

  it('shows min/max inputs for range generator fields', () => {
    render(<PersonaCustomizePanel persona={mockPersona} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    const minInput = screen.getByTestId('field-min-Transaction_Amount__c');
    const maxInput = screen.getByTestId('field-max-Transaction_Amount__c');
    expect(minInput).toBeDefined();
    expect(maxInput).toBeDefined();
    expect((minInput as HTMLInputElement).value).toBe('-10000');
    expect((maxInput as HTMLInputElement).value).toBe('50000');
  });

  it('shows comma-separated values input for random_pick fields', () => {
    render(<PersonaCustomizePanel persona={mockPersona} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    const valuesInput = screen.getByTestId('field-values-Transaction_Type__c');
    expect(valuesInput).toBeDefined();
    expect((valuesInput as HTMLInputElement).value).toBe('Virement, Prelevement, Carte');
  });

  it('shows read-only example badges for faker fields', () => {
    render(<PersonaCustomizePanel persona={mockPersona} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    // Faker field IBAN__c should show example values as badges, not editable inputs
    const fieldRow = screen.getByTestId('field-row-IBAN__c');
    expect(fieldRow.textContent).toContain('FR7630006000011234567890189');
  });

  it('calls onConfirm with modified range min/max on confirm', () => {
    const onConfirm = vi.fn();
    render(
      <PersonaCustomizePanel persona={mockPersona} onConfirm={onConfirm} onCancel={vi.fn()} />,
    );

    // Modify the min value for Transaction_Amount__c
    const minInput = screen.getByTestId('field-min-Transaction_Amount__c');
    fireEvent.change(minInput, { target: { value: '0' } });

    fireEvent.click(screen.getByTestId('customize-confirm-btn'));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    const customized = onConfirm.mock.calls[0][0] as PersonaMsg;
    expect(customized.id).toBe('banque-eu');
    const amountParams = customized.dataPatterns['Transaction_Amount__c'].params as Record<
      string,
      unknown
    >;
    expect(amountParams['min']).toBe(0);
    expect(amountParams['max']).toBe(50000);
  });

  it('calls onCancel when Cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<PersonaCustomizePanel persona={mockPersona} onConfirm={vi.fn()} onCancel={onCancel} />);

    fireEvent.click(screen.getByTestId('customize-cancel-btn'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('handles weighted_pick values display', () => {
    render(<PersonaCustomizePanel persona={mockPersona} onConfirm={vi.fn()} onCancel={vi.fn()} />);

    const valuesInput = screen.getByTestId('field-values-DPE__c');
    expect(valuesInput).toBeDefined();
    expect((valuesInput as HTMLInputElement).value).toBe('A, B, C');
  });
});
