import { describe, it, expect } from 'vitest';
import { LocaleDetector } from './LocaleDetector';

describe('LocaleDetector', () => {
  describe('mapToSupported', () => {
    it('should map "en" to "en"', () => {
      expect(LocaleDetector.mapToSupported('en')).toBe('en');
    });

    it('should map "en-US" to "en"', () => {
      expect(LocaleDetector.mapToSupported('en-US')).toBe('en');
    });

    it('should map "en-GB" to "en"', () => {
      expect(LocaleDetector.mapToSupported('en-GB')).toBe('en');
    });

    it('should map "fr" to "fr"', () => {
      expect(LocaleDetector.mapToSupported('fr')).toBe('fr');
    });

    it('should map "fr-FR" to "fr"', () => {
      expect(LocaleDetector.mapToSupported('fr-FR')).toBe('fr');
    });

    it('should map "fr-CA" to "fr"', () => {
      expect(LocaleDetector.mapToSupported('fr-CA')).toBe('fr');
    });

    it('should map newly supported languages correctly', () => {
      expect(LocaleDetector.mapToSupported('de')).toBe('de');
      expect(LocaleDetector.mapToSupported('ja')).toBe('ja');
      expect(LocaleDetector.mapToSupported('es')).toBe('es');
      expect(LocaleDetector.mapToSupported('pt-BR')).toBe('pt-BR');
    });

    it('should fall back to "en" for unsupported languages', () => {
      expect(LocaleDetector.mapToSupported('zh')).toBe('en');
      expect(LocaleDetector.mapToSupported('ko')).toBe('en');
      expect(LocaleDetector.mapToSupported('ru')).toBe('en');
    });

    it('should handle case-insensitive input', () => {
      expect(LocaleDetector.mapToSupported('FR')).toBe('fr');
      expect(LocaleDetector.mapToSupported('FR-FR')).toBe('fr');
      expect(LocaleDetector.mapToSupported('En-Us')).toBe('en');
    });
  });

  describe('constructor', () => {
    it('should detect locale from VSCode language', () => {
      const detector = new LocaleDetector('fr-FR');
      expect(detector.getLocale()).toBe('fr');
    });

    it('should default to English when no language provided', () => {
      const detector = new LocaleDetector();
      expect(detector.getLocale()).toBe('en');
    });

    it('should default to English for empty string', () => {
      const detector = new LocaleDetector('');
      expect(detector.getLocale()).toBe('en');
    });
  });

  describe('setLocale', () => {
    it('should allow overriding the locale', () => {
      const detector = new LocaleDetector('en');
      detector.setLocale('fr');
      expect(detector.getLocale()).toBe('fr');
    });
  });

  describe('resolve', () => {
    it('should use VSCode language when setting is "auto"', () => {
      const detector = new LocaleDetector('en');
      const result = detector.resolve('auto', 'fr-FR');
      expect(result).toBe('fr');
      expect(detector.getLocale()).toBe('fr');
    });

    it('should use VSCode language when setting is undefined', () => {
      const detector = new LocaleDetector('en');
      const result = detector.resolve(undefined, 'fr');
      expect(result).toBe('fr');
    });

    it('should use explicit setting over VSCode language', () => {
      const detector = new LocaleDetector('en');
      const result = detector.resolve('fr', 'en-US');
      expect(result).toBe('fr');
    });

    it('should map explicit setting to supported locale', () => {
      const detector = new LocaleDetector('en');
      const result = detector.resolve('de', 'fr');
      expect(result).toBe('de');
    });
  });
});
