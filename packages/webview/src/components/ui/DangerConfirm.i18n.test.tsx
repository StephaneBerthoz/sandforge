import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen } from '@testing-library/react';
import { createInstance, type i18n as I18n } from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';

import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import { DangerConfirm } from './DangerConfirm';

/*
 * The confirm prompt is the one place where a translated sentence has to wrap a
 * runtime value in markup. Rendering it under a real i18next instance (not a
 * key-echoing stub) is the only way to prove the <code> lands inside the
 * translated sentence rather than being glued to English fragments.
 */
let instance: I18n;

beforeAll(async () => {
  instance = createInstance();
  await instance.use(initReactI18next).init({
    resources: { en: { translation: en }, fr: { translation: fr } },
    lng: 'en',
    fallbackLng: 'en',
    interpolation: { escapeValue: false },
  });
});

const baseProps = {
  open: true,
  onClose: vi.fn(),
  onConfirm: vi.fn(),
  title: 'Delete All Data',
  description: 'This will permanently delete all records.',
  confirmText: 'DELETE',
};

function renderIn(lng: string): void {
  instance.changeLanguage(lng);
  render(
    <I18nextProvider i18n={instance}>
      <DangerConfirm {...baseProps} />
    </I18nextProvider>,
  );
}

describe('DangerConfirm — translated confirm prompt', () => {
  it('renders the English prompt with the literal inside a <code>', () => {
    renderIn('en');
    const code = screen.getByText('DELETE', { selector: 'code' });
    expect(code.tagName).toBe('CODE');
    expect(code.parentElement?.textContent).toBe('Type DELETE to confirm:');
  });

  it('renders the French prompt, keeping the literal in its <code>', () => {
    renderIn('fr');
    const code = screen.getByText('DELETE', { selector: 'code' });
    expect(code.parentElement?.textContent).toBe('Saisissez DELETE pour confirmer :');
  });

  it('keeps the interpolation placeholder in every locale', () => {
    for (const locale of ['en', 'fr']) {
      const value = instance.getResource(locale, 'translation', 'common.typeToConfirm') as string;
      expect(value, locale).toContain('{{text}}');
      expect(value, locale).toContain('<code>');
    }
  });
});
