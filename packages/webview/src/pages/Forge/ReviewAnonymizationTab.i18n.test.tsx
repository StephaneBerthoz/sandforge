import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ForgeAnonymizationCategory, AnonymizationMethod } from '@sandforge/shared';
import en from '../../i18n/locales/en.json';
import { ReviewAnonymizationTab } from './ReviewAnonymizationTab';

/* `t` echoes its key, so any label still hardcoded in the component shows up
   as English prose instead of a key. */
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { changeLanguage: vi.fn(), language: 'en' },
  }),
}));

const rules: Record<ForgeAnonymizationCategory, AnonymizationMethod> = {
  email: 'fake',
  phone: 'mask',
  name: 'fake',
  address: 'fake',
  ssn_id: 'redact',
  financial: 'hash',
  other: 'nullify',
};

vi.mock('../../stores/useForgeStore', () => {
  /* Built lazily: the factory is hoisted above `rules`. */
  const state = (): Record<string, unknown> => ({
    anonymizationRules: rules,
    setAnonymizationRule: vi.fn(),
    applyAnonymizationPreset: vi.fn(),
    graph: null,
  });
  const store = Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) => selector(state()),
    { getState: state },
  );
  return { useForgeStore: store };
});

const CATEGORIES = ['email', 'phone', 'name', 'address', 'ssn_id', 'financial', 'other'] as const;
const METHODS = [
  'fake',
  'mask',
  'hash',
  'nullify',
  'redact',
  'shuffle',
  'truncate',
  'preserve_format',
  'age_band',
  'generalize',
] as const;

describe('ReviewAnonymizationTab — translated labels', () => {
  it('resolves every category label through i18n', () => {
    render(<ReviewAnonymizationTab />);
    for (const cat of CATEGORIES) {
      const cells = screen.getByTestId(`anon-row-${cat}`).querySelectorAll('td');
      expect(cells[0]?.textContent).toBe(`forge.anonCategory.${cat}`);
    }
  });

  it('resolves every method option through i18n instead of showing the raw enum', () => {
    render(<ReviewAnonymizationTab />);
    const options = screen.getByTestId('anon-select-email').querySelectorAll('option');
    expect(options.length).toBe(METHODS.length);
    for (const [i, method] of METHODS.entries()) {
      expect(options[i]?.value).toBe(method);
      expect(options[i]?.textContent).toBe(`forge.anonMethod.${method}`);
    }
  });

  it('backs every rendered key with an entry in the reference locale', () => {
    for (const cat of CATEGORIES) {
      expect(typeof en.forge.anonCategory[cat]).toBe('string');
    }
    for (const method of METHODS) {
      expect(typeof en.forge.anonMethod[method]).toBe('string');
    }
  });
});
