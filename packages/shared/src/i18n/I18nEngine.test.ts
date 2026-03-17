import { describe, it, expect, beforeEach, vi } from 'vitest';
import { I18nEngine } from './I18nEngine';

describe('I18nEngine', () => {
  beforeEach(() => {
    I18nEngine.reset();
  });

  it('should be a singleton', () => {
    const a = I18nEngine.getInstance();
    const b = I18nEngine.getInstance();
    expect(a).toBe(b);
  });

  it('should default to English locale', () => {
    const engine = I18nEngine.getInstance();
    expect(engine.getLocale()).toBe('en');
  });

  describe('loadNamespace and t()', () => {
    it('should translate a simple key', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('common', 'en', { save: 'Save', cancel: 'Cancel' });
      expect(engine.t('common.save')).toBe('Save');
    });

    it('should translate a nested key', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('seed', 'en', {
        strategies: { ai: 'AI Generate', faker: 'Faker' },
      });
      expect(engine.t('seed.strategies.ai')).toBe('AI Generate');
    });

    it('should return the key when no translation exists', () => {
      const engine = I18nEngine.getInstance();
      expect(engine.t('missing.key')).toBe('missing.key');
    });

    it('should return the key for a namespace-less key', () => {
      const engine = I18nEngine.getInstance();
      expect(engine.t('noNamespace')).toBe('noNamespace');
    });

    it('should return default value when key is missing', () => {
      const engine = I18nEngine.getInstance();
      expect(engine.t('missing.key', 'Default Value')).toBe('Default Value');
    });

    it('should return default value for a namespace-less key', () => {
      const engine = I18nEngine.getInstance();
      expect(engine.t('noNamespace', 'Default')).toBe('Default');
    });

    it('should prefer translation over default value', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('common', 'en', { save: 'Save' });
      expect(engine.t('common.save', 'Backup Default')).toBe('Save');
    });

    it('should return undefined path gracefully', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('common', 'en', { save: 'Save' });
      expect(engine.t('common.nonexistent')).toBe('common.nonexistent');
    });

    it('should handle deeply nested missing path', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('seed', 'en', { strategies: { ai: 'AI' } });
      expect(engine.t('seed.strategies.missing.deep')).toBe('seed.strategies.missing.deep');
    });

    it('should return key when namespace has no translations for path ending in object', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('seed', 'en', { strategies: { ai: 'AI', faker: 'Faker' } });
      expect(engine.t('seed.strategies')).toBe('seed.strategies');
    });
  });

  describe('interpolation', () => {
    it('should replace a single parameter', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('org', 'en', { connected: 'Connected to {{alias}}' });
      expect(engine.t('org.connected', { alias: 'MyOrg' })).toBe('Connected to MyOrg');
    });

    it('should replace multiple parameters', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('seed', 'en', {
        completed: '{{count}} records in {{duration}}',
      });
      expect(engine.t('seed.completed', { count: 42, duration: '3s' })).toBe(
        '42 records in 3s'
      );
    });

    it('should leave unmatched placeholders intact', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('seed', 'en', {
        completed: '{{count}} records in {{duration}}',
      });
      expect(engine.t('seed.completed', { count: 10 })).toBe('10 records in {{duration}}');
    });

    it('should handle numeric parameter values', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('org', 'en', { connected: 'Connected to {{alias}}' });
      expect(engine.t('org.connected', { alias: 123 })).toBe('Connected to 123');
    });
  });

  describe('locale switching', () => {
    it('should switch locale and return correct translation', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('common', 'en', { save: 'Save' });
      engine.loadNamespace('common', 'fr', { save: 'Enregistrer' });
      expect(engine.t('common.save')).toBe('Save');
      engine.setLocale('fr');
      expect(engine.t('common.save')).toBe('Enregistrer');
    });

    it('should fall back to English when key missing in current locale', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('common', 'en', { save: 'Save', cancel: 'Cancel' });
      engine.loadNamespace('common', 'fr', { save: 'Enregistrer' });
      engine.setLocale('fr');
      expect(engine.t('common.cancel')).toBe('Cancel');
    });

    it('should fall back to English for nested keys', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('seed', 'en', { strategies: { ai: 'AI Generate' } });
      engine.setLocale('fr');
      expect(engine.t('seed.strategies.ai')).toBe('AI Generate');
    });
  });

  describe('onLocaleChange', () => {
    it('should notify listeners on locale change', () => {
      const engine = I18nEngine.getInstance();
      const callback = vi.fn();
      engine.onLocaleChange(callback);
      engine.setLocale('fr');
      expect(callback).toHaveBeenCalledWith('fr');
    });

    it('should not notify after unsubscribe', () => {
      const engine = I18nEngine.getInstance();
      const callback = vi.fn();
      const unsubscribe = engine.onLocaleChange(callback);
      unsubscribe();
      engine.setLocale('fr');
      expect(callback).not.toHaveBeenCalled();
    });

    it('should not notify if locale does not change', () => {
      const engine = I18nEngine.getInstance();
      const callback = vi.fn();
      engine.onLocaleChange(callback);
      engine.setLocale('en');
      expect(callback).not.toHaveBeenCalled();
    });

    it('should notify multiple listeners', () => {
      const engine = I18nEngine.getInstance();
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      engine.onLocaleChange(cb1);
      engine.onLocaleChange(cb2);
      engine.setLocale('fr');
      expect(cb1).toHaveBeenCalledWith('fr');
      expect(cb2).toHaveBeenCalledWith('fr');
    });
  });

  describe('hasKey', () => {
    it('should return true for existing key', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('common', 'en', { save: 'Save' });
      expect(engine.hasKey('common.save')).toBe(true);
    });

    it('should return false for missing key', () => {
      const engine = I18nEngine.getInstance();
      expect(engine.hasKey('missing.key')).toBe(false);
    });

    it('should return true for key only in fallback', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('common', 'en', { save: 'Save' });
      engine.setLocale('fr');
      expect(engine.hasKey('common.save')).toBe(true);
    });

    it('should return false for namespace-less key', () => {
      const engine = I18nEngine.getInstance();
      expect(engine.hasKey('noNamespace')).toBe(false);
    });

    it('should return true for nested key', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('seed', 'en', { strategies: { ai: 'AI' } });
      expect(engine.hasKey('seed.strategies.ai')).toBe(true);
    });
  });

  describe('getLoadedNamespaces', () => {
    it('should return empty array initially', () => {
      const engine = I18nEngine.getInstance();
      expect(engine.getLoadedNamespaces()).toEqual([]);
    });

    it('should return loaded namespace names', () => {
      const engine = I18nEngine.getInstance();
      engine.loadNamespace('common', 'en', { save: 'Save' });
      engine.loadNamespace('seed', 'en', { title: 'Seed' });
      const ns = engine.getLoadedNamespaces();
      expect(ns).toContain('common');
      expect(ns).toContain('seed');
      expect(ns).toHaveLength(2);
    });
  });
});
