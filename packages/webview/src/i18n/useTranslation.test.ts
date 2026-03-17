import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { I18nEngine } from '@sandforge/shared';
import { useSfTranslation } from './useTranslation';

describe('useSfTranslation', () => {
  beforeEach(() => {
    I18nEngine.reset();
    const engine = I18nEngine.getInstance();
    engine.loadNamespace('common', 'en', { save: 'Save', cancel: 'Cancel' });
    engine.loadNamespace('common', 'fr', { save: 'Enregistrer', cancel: 'Annuler' });
    engine.loadNamespace('org', 'en', { connected: 'Connected to {{alias}}' });
    engine.loadNamespace('org', 'fr', { connected: 'Connecte a {{alias}}' });
  });

  it('should return the current locale', () => {
    const { result } = renderHook(() => useSfTranslation());
    expect(result.current.locale).toBe('en');
  });

  it('should translate a key', () => {
    const { result } = renderHook(() => useSfTranslation());
    expect(result.current.t('common.save')).toBe('Save');
  });

  it('should return key for missing translation', () => {
    const { result } = renderHook(() => useSfTranslation());
    expect(result.current.t('missing.key')).toBe('missing.key');
  });

  it('should return default value for missing translation', () => {
    const { result } = renderHook(() => useSfTranslation());
    expect(result.current.t('missing.key', 'Default')).toBe('Default');
  });

  it('should interpolate params', () => {
    const { result } = renderHook(() => useSfTranslation());
    expect(result.current.t('org.connected', { alias: 'MyOrg' })).toBe('Connected to MyOrg');
  });

  it('should switch locale via setLocale', () => {
    const { result } = renderHook(() => useSfTranslation());
    act(() => {
      result.current.setLocale('fr');
    });
    expect(result.current.locale).toBe('fr');
    expect(result.current.t('common.save')).toBe('Enregistrer');
  });

  it('should react to external locale changes', () => {
    const { result } = renderHook(() => useSfTranslation());
    act(() => {
      I18nEngine.getInstance().setLocale('fr');
    });
    expect(result.current.locale).toBe('fr');
    expect(result.current.t('common.cancel')).toBe('Annuler');
  });

  it('should fall back to English for missing French key', () => {
    const engine = I18nEngine.getInstance();
    engine.loadNamespace('seed', 'en', { title: 'Seed Data' });
    const { result } = renderHook(() => useSfTranslation());
    act(() => {
      result.current.setLocale('fr');
    });
    expect(result.current.t('seed.title')).toBe('Seed Data');
  });
});
