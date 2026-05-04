import { describe, it, expect, beforeEach } from 'vitest';
import { I18nManager } from './I18nManager';

describe('I18nManager', () => {
  let i18n: I18nManager;

  const enTranslations = {
    'app.name': 'SandForge',
    'org.connected': 'Connected to {{alias}}',
    'seed.completed': 'Seed completed: {{count}} records created in {{duration}}',
    'common.loading': 'Loading...',
    'common.cancel': 'Cancel',
  };

  const frTranslations = {
    'app.name': 'SandForge',
    'org.connected': 'Connect\u00e9 \u00e0 {{alias}}',
    'seed.completed':
      'Seed termin\u00e9 : {{count}} enregistrements cr\u00e9\u00e9s en {{duration}}',
    'common.loading': 'Chargement...',
  };

  beforeEach(() => {
    i18n = new I18nManager('en', 'en');
    i18n.registerLocale('en', enTranslations);
    i18n.registerLocale('fr', frTranslations);
  });

  describe('basic translation', () => {
    it('should return the translation for an existing key', () => {
      expect(i18n.t('app.name')).toBe('SandForge');
    });

    it('should return a translated string without interpolation', () => {
      expect(i18n.t('common.loading')).toBe('Loading...');
    });
  });

  describe('fallback to default locale', () => {
    it('should fall back to fallback locale when key is missing in current locale', () => {
      i18n.setLocale('fr');
      expect(i18n.t('common.cancel')).toBe('Cancel');
    });

    it('should prefer current locale when key exists in both', () => {
      i18n.setLocale('fr');
      expect(i18n.t('common.loading')).toBe('Chargement...');
    });
  });

  describe('missing key returns key itself', () => {
    it('should return the key when no translation exists in any locale', () => {
      expect(i18n.t('nonexistent.key')).toBe('nonexistent.key');
    });

    it('should return the key when current locale has no translations and fallback misses it', () => {
      i18n.setLocale('de');
      expect(i18n.t('nonexistent.key')).toBe('nonexistent.key');
    });
  });

  describe('interpolation with params', () => {
    it('should replace a single parameter', () => {
      expect(i18n.t('org.connected', { alias: 'MyOrg' })).toBe('Connected to MyOrg');
    });

    it('should replace multiple parameters', () => {
      expect(i18n.t('seed.completed', { count: 42, duration: '3s' })).toBe(
        'Seed completed: 42 records created in 3s',
      );
    });

    it('should leave unmatched placeholders intact', () => {
      expect(i18n.t('seed.completed', { count: 10 })).toBe(
        'Seed completed: 10 records created in {{duration}}',
      );
    });

    it('should handle numeric parameter values', () => {
      expect(i18n.t('org.connected', { alias: 123 })).toBe('Connected to 123');
    });
  });

  describe('hasKey', () => {
    it('should return true for a key that exists in the current locale', () => {
      expect(i18n.hasKey('app.name')).toBe(true);
    });

    it('should return true for a key that exists only in the fallback locale', () => {
      i18n.setLocale('fr');
      expect(i18n.hasKey('common.cancel')).toBe(true);
    });

    it('should return false for a key that does not exist anywhere', () => {
      expect(i18n.hasKey('totally.missing')).toBe(false);
    });
  });

  describe('setLocale and getLocale', () => {
    it('should return the default locale initially', () => {
      expect(i18n.getLocale()).toBe('en');
    });

    it('should update the current locale via setLocale', () => {
      i18n.setLocale('fr');
      expect(i18n.getLocale()).toBe('fr');
    });
  });

  describe('getAvailableLocales', () => {
    it('should return all registered locale codes', () => {
      const locales = i18n.getAvailableLocales();
      expect(locales).toContain('en');
      expect(locales).toContain('fr');
      expect(locales).toHaveLength(2);
    });

    it('should merge translations when registering a locale that already exists', () => {
      // 'en' already has 5 keys from beforeEach
      i18n.registerLocale('en', { 'new.key': 'New Value' });

      // Old keys still present
      expect(i18n.t('app.name')).toBe('SandForge');
      expect(i18n.t('common.cancel')).toBe('Cancel');
      // New key available
      expect(i18n.t('new.key')).toBe('New Value');
    });

    it('should overwrite individual keys on merge without losing others', () => {
      i18n.registerLocale('en', { 'app.name': 'SandForge Pro' });

      expect(i18n.t('app.name')).toBe('SandForge Pro');
      expect(i18n.t('common.loading')).toBe('Loading...');
    });

    it('should include newly registered locales', () => {
      i18n.registerLocale('de', { 'app.name': 'SandForge' });
      expect(i18n.getAvailableLocales()).toContain('de');
      expect(i18n.getAvailableLocales()).toHaveLength(3);
    });
  });

  describe('getMissingKeys', () => {
    it('should return keys present in fallback but missing in the target locale', () => {
      const missing = i18n.getMissingKeys('fr');
      expect(missing).toContain('common.cancel');
      expect(missing).not.toContain('app.name');
    });

    it('should return all fallback keys when locale is not registered', () => {
      const missing = i18n.getMissingKeys('de');
      expect(missing).toEqual(Object.keys(enTranslations));
    });

    it('should return an empty array when locale has all keys', () => {
      const missing = i18n.getMissingKeys('en');
      expect(missing).toHaveLength(0);
    });
  });
});
