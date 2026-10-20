import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import i18n from '../../i18n';
import fr from '../../i18n/locales/fr.json';
import { SeedLocalePicker } from './SeedLocalePicker';

describe('SeedLocalePicker', () => {
  afterEach(async () => {
    await act(async () => {
      await i18n.changeLanguage('en');
    });
  });

  it('opens on the org’s own locale, said as the default, then the six the generator has names for', () => {
    render(<SeedLocalePicker value="" onChange={vi.fn()} testId="locale" />);

    const select = screen.getByTestId('locale') as HTMLSelectElement;
    expect(select.value).toBe('');
    const options = [...select.options].map((option) => [option.value, option.textContent]);
    expect(options).toEqual([
      ['', "The org's own locale (default)"],
      ['en_US', 'American English'],
      ['fr_FR', 'French (France)'],
      ['de_DE', 'German (Germany)'],
      ['es_ES', 'European Spanish'],
      ['ja_JP', 'Japanese (Japan)'],
      ['pt_BR', 'Brazilian Portuguese'],
    ]);
  });

  it('is labelled, and says what the locale draws', () => {
    render(<SeedLocalePicker value="" onChange={vi.fn()} testId="locale" />);

    const select = screen.getByLabelText('Names and addresses');
    expect(select).toBe(screen.getByTestId('locale'));
    const hint = document.getElementById(select.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toContain('people, companies, addresses and phone numbers');
  });

  it('hands back the locale chosen, as Salesforce writes it, and the empty choice for the org’s', () => {
    const onChange = vi.fn();
    render(<SeedLocalePicker value="" onChange={onChange} testId="locale" />);

    fireEvent.change(screen.getByTestId('locale'), { target: { value: 'fr_FR' } });
    fireEvent.change(screen.getByTestId('locale'), { target: { value: '' } });

    expect(onChange.mock.calls).toEqual([['fr_FR'], ['']]);
  });

  it('names the locales in the language of the panel', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await act(async () => {
      await i18n.changeLanguage('fr');
    });

    render(<SeedLocalePicker value="" onChange={vi.fn()} testId="locale" />);

    const select = screen.getByTestId('locale') as HTMLSelectElement;
    expect(select.options[0].textContent).toBe(fr.seed.locale.orgDefault);
    expect(select.options[2].textContent).toBe('français (France)');
  });
});
