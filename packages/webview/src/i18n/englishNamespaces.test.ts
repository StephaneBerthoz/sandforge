import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { englishNamespaceLoaders } from 'virtual:english-catalogue';

import i18n from './index';
import en from './locales/en.json';
import panelCatalogue from './panelCatalogue';
import { loadEnglishNamespaces, withEnglish } from './englishNamespaces';

/**
 * The tests start with the whole English catalogue; a panel starts with its
 * shell's namespaces. Each test here starts as a panel does, and the
 * catalogue is put back after it.
 */
beforeEach(() => {
  i18n.removeResourceBundle('en', 'translation');
  i18n.addResourceBundle('en', 'translation', panelCatalogue, true, true);
});

afterEach(() => {
  vi.restoreAllMocks();
  i18n.removeResourceBundle('en', 'translation');
  i18n.addResourceBundle('en', 'translation', en, true, true);
});

describe('the English of a part of the panel, loaded with it', () => {
  it('has a loader for every namespace of the catalogue, each its own module', () => {
    expect(Object.keys(englishNamespaceLoaders).sort()).toEqual(Object.keys(en).sort());
  });

  it('adds a namespace the panel does not hold yet, as the catalogue has it', async () => {
    expect(i18n.t('grappe.subtitle')).toBe('grappe.subtitle');
    await loadEnglishNamespaces(['grappe']);
    expect(i18n.t('grappe.subtitle')).toBe(en.grappe.subtitle);
    expect(i18n.getResourceBundle('en', 'translation')).toMatchObject({ grappe: en.grappe });
    // What the panel held stays.
    expect(i18n.t('common.cancel')).toBe(en.common.cancel);
  });

  it('asks nothing for a namespace held, and each namespace once', async () => {
    const common = vi.spyOn(englishNamespaceLoaders, 'common');
    const ai = vi.spyOn(englishNamespaceLoaders, 'ai');
    await loadEnglishNamespaces(['common', 'ai']);
    await loadEnglishNamespaces(['ai']);
    expect(common).not.toHaveBeenCalled();
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('refuses a namespace the catalogue does not have, rather than rendering its keys', async () => {
    await expect(
      loadEnglishNamespaces(['noSuchNamespace' as unknown as keyof typeof en]),
    ).rejects.toThrow('The English catalogue has no namespace "noSuchNamespace"');
  });

  it('hands over what a part loaded once its English is in, and not before', async () => {
    let release: (() => void) | undefined;
    const held = new Promise<{ default: Record<string, unknown> }>((resolve) => {
      release = () => resolve({ default: en.reports });
    });
    vi.spyOn(englishNamespaceLoaders, 'reports').mockReturnValue(held);
    let loaded: string | undefined;
    const load = withEnglish(() => Promise.resolve('the reports page'), ['reports']);
    const done = load().then((value) => {
      loaded = value;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(loaded).toBeUndefined();
    release?.();
    await done;
    expect(loaded).toBe('the reports page');
    expect(i18n.t('reports.title')).toBe(en.reports.title);
  });
});
