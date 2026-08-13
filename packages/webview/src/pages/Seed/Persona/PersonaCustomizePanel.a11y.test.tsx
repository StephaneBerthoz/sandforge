import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import '../../../i18n';
import type { PersonaMsg } from '@sandforge/shared';
import { PersonaCustomizePanel } from './PersonaCustomizePanel';

/** Two range fields and two pick fields: the captions repeat across rows. */
const persona: PersonaMsg = {
  id: 'banque-eu',
  name: 'Banque europeenne',
  description: 'European bank with accounts and transactions.',
  industry: 'Banking',
  locale: 'fr-FR',
  dataPatterns: {
    Transaction_Amount__c: {
      fieldType: 'currency',
      generator: 'range',
      params: { min: -10000, max: 50000, currency: 'EUR' },
      examples: ['1250.00'],
    },
    Balance__c: {
      fieldType: 'currency',
      generator: 'range',
      params: { min: 0, max: 900 },
      examples: ['120.00'],
    },
    Transaction_Type__c: {
      fieldType: 'picklist',
      generator: 'random_pick',
      params: { values: ['Virement', 'Carte'] },
      examples: ['Virement'],
    },
  },
};

/** Accessible name of a form control: its own aria-label, else its labels. */
function accessibleName(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return aria.trim();
  const labels = (el as HTMLInputElement).labels;
  return Array.from(labels ?? [])
    .map((l) => l.textContent ?? '')
    .join(' ')
    .trim();
}

/** Labels that name nothing — the accessible name is lost for their control. */
function orphanLabels(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('label'))
    .filter((l) => l.control === null)
    .map((l) => (l.textContent ?? '').trim());
}

describe('PersonaCustomizePanel accessible names', () => {
  it('should name every editable field input', () => {
    render(<PersonaCustomizePanel persona={persona} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    for (const testId of [
      'field-min-Transaction_Amount__c',
      'field-max-Transaction_Amount__c',
      'field-min-Balance__c',
      'field-max-Balance__c',
      'field-values-Transaction_Type__c',
    ]) {
      expect(accessibleName(screen.getByTestId(testId)), testId).not.toBe('');
    }
  });

  it('should bind each repeated caption to its own row input', () => {
    render(<PersonaCustomizePanel persona={persona} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const first = screen.getByTestId('field-min-Transaction_Amount__c') as HTMLInputElement;
    const second = screen.getByTestId('field-min-Balance__c') as HTMLInputElement;
    expect(first.id).not.toBe(second.id);
    expect(first.labels?.[0]).not.toBe(second.labels?.[0]);
  });

  it('should leave no orphan label', () => {
    render(<PersonaCustomizePanel persona={persona} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(orphanLabels(screen.getByTestId('persona-customize-panel'))).toEqual([]);
  });
});
