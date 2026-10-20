import { describe, it, expect, afterEach } from 'vitest';
import i18n from '../../../i18n';
import de from '../../../i18n/locales/de.json';
import { personaDescription, personaName } from './personaText';

const builtIn = {
  id: 'assureur-fr',
  name: 'Assureur français',
  description: "Compagnie d'assurance française avec contrats, sinistres et assurés.",
};
const custom = { id: 'custom-1', name: 'Mon persona', description: 'Fait main.' };

describe('persona text', () => {
  afterEach(async () => {
    await i18n.changeLanguage('en');
  });

  it('names a built-in persona in the interface language, whatever language it came in', async () => {
    // The cards showed eight names in French and seven descriptions in
    // English, side by side, whatever the interface was in.
    await i18n.changeLanguage('en');
    expect(personaName(builtIn, i18n.t, i18n)).toBe('French insurer');
    expect(personaDescription(builtIn, i18n.t, i18n)).toBe(
      'French insurance company with policies, claims and policyholders.',
    );
    i18n.addResourceBundle('de', 'translation', de, true, true);
    await i18n.changeLanguage('de');
    expect(personaName(builtIn, i18n.t, i18n)).toBe('Französischer Versicherer');
  });

  it('keeps the words a created persona came with', () => {
    expect(personaName(custom, i18n.t, i18n)).toBe('Mon persona');
    expect(personaDescription(custom, i18n.t, i18n)).toBe('Fait main.');
  });
});
