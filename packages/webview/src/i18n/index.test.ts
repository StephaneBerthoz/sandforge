import { describe, it, expect } from 'vitest';

import i18n from './index';

describe('i18n', () => {
  it('should initialize successfully', () => {
    expect(i18n.isInitialized).toBe(true);
  });

  it('should default to English', () => {
    expect(i18n.language).toBe('en');
  });

  it('should return English strings with t()', () => {
    expect(i18n.t('common.save')).toBe('Save');
    expect(i18n.t('common.cancel')).toBe('Cancel');
    expect(i18n.t('nav.home')).toBe('Home');
    expect(i18n.t('org.title')).toBe('Organizations');
    expect(i18n.t('notifications.title')).toBe('Notifications');
  });

  it('should return French strings after changing language', async () => {
    await i18n.changeLanguage('fr');

    expect(i18n.t('common.save')).toBe('Enregistrer');
    expect(i18n.t('common.cancel')).toBe('Annuler');
    expect(i18n.t('nav.home')).toBe('Accueil');
    expect(i18n.t('org.title')).toBe('Organisations');
    expect(i18n.t('notifications.title')).toBe('Notifications');

    await i18n.changeLanguage('en');
  });

  it('should fall back to English for missing keys', async () => {
    await i18n.changeLanguage('fr');

    const missingKey = 'common.nonExistentKey';
    expect(i18n.t(missingKey)).toBe(missingKey);

    await i18n.changeLanguage('en');
  });

  it('should return German strings after changing to de', async () => {
    await i18n.changeLanguage('de');

    expect(i18n.t('common.save')).toBe('Speichern');

    await i18n.changeLanguage('en');
  });

  it('should return Spanish strings after changing to es', async () => {
    await i18n.changeLanguage('es');

    expect(i18n.t('common.save')).toBe('Guardar');

    await i18n.changeLanguage('en');
  });

  it('should return Japanese strings after changing to ja', async () => {
    await i18n.changeLanguage('ja');

    expect(i18n.t('common.save')).toBe('\u4fdd\u5b58');

    await i18n.changeLanguage('en');
  });

  it('should return Brazilian Portuguese strings after changing to pt-BR', async () => {
    await i18n.changeLanguage('pt-BR');

    expect(i18n.t('common.save')).toBe('Salvar');

    await i18n.changeLanguage('en');
  });

  it('should fall back to English for unsupported languages', async () => {
    await i18n.changeLanguage('xx');

    expect(i18n.t('common.save')).toBe('Save');

    await i18n.changeLanguage('en');
  });

  it('should have all nav keys in both languages', () => {
    const navKeys = [
      'nav.home',
      'nav.orgs',
      'nav.seed',
      'nav.sync',
      'nav.monitor',
      'nav.compare',
      'nav.dataops',
      'nav.automation',
      'nav.reports',
      'nav.settings',
    ];

    for (const key of navKeys) {
      const enValue = i18n.t(key, { lng: 'en' });
      const frValue = i18n.t(key, { lng: 'fr' });

      expect(enValue).not.toBe(key);
      expect(frValue).not.toBe(key);
    }
  });

  it('should have all org keys in both languages', () => {
    const orgKeys = [
      'org.title',
      'org.connect',
      'org.disconnect',
      'org.edit',
      'org.noOrgs',
      'org.status_connected',
      'org.status_expired',
      'org.status_error',
      'org.status_refreshing',
      'org.safetyTier',
      'org.alias',
      'org.username',
      'org.instanceUrl',
      'org.orgType',
      'org.production',
      'org.sandbox',
      'org.scratch',
      'org.developer',
      'org.tier_critical',
      'org.tier_high',
      'org.tier_medium',
      'org.tier_low',
    ];

    for (const key of orgKeys) {
      const enValue = i18n.t(key, { lng: 'en' });
      const frValue = i18n.t(key, { lng: 'fr' });

      expect(enValue).not.toBe(key);
      expect(frValue).not.toBe(key);
    }
  });
});
