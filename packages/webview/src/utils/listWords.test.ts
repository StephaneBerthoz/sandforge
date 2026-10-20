import { afterEach, describe, expect, it } from 'vitest';
import i18n from '../i18n';
import fr from '../i18n/locales/fr.json';
import ja from '../i18n/locales/ja.json';
import { listWords } from './listWords';

describe('listWords', () => {
  const t = (key: string): string => i18n.t(key);

  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('joins the words as English lists them', () => {
    expect(listWords([], t)).toBe('');
    expect(listWords(['Contact'], t)).toBe('Contact');
    expect(listWords(['Contact', 'Case'], t)).toBe('Contact and Case');
    expect(listWords(['Account', 'Contact', 'Case'], t)).toBe('Account, Contact and Case');
  });

  it('joins them with the separators of the language the panel is set to', async () => {
    i18n.addResourceBundle('fr', 'translation', fr, true, true);
    await i18n.changeLanguage('fr');
    expect(listWords(['Account', 'Contact', 'Case'], t)).toBe('Account, Contact et Case');

    i18n.addResourceBundle('ja', 'translation', ja, true, true);
    await i18n.changeLanguage('ja');
    expect(listWords(['Account', 'Contact', 'Case'], t)).toBe('Account、Contact、Case');
  });
});
