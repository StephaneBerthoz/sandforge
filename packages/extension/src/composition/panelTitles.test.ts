import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SUPPORTED_LOCALE_CODES } from '../core/i18n/localeBundles.js';
import { MODULE_COMMANDS } from './moduleCommands';
import { panelTitle, panelTitleOf } from './panelTitles';

/**
 * The webview's own catalogues, which the packaged `webview-dist/locales`
 * copies: the panel's title is read from them as the navigation is.
 */
const LOCALES_DIR = join(__dirname, '..', '..', '..', 'webview', 'src', 'i18n', 'locales');

/** A locale's navigation labels, by module id. */
function navOf(locale: string): Record<string, string> {
  return (
    JSON.parse(readFileSync(join(LOCALES_DIR, `${locale}.json`), 'utf8')) as {
      nav: Record<string, string>;
    }
  ).nav;
}

describe('panelTitleOf', () => {
  it.each([
    ['fr', 'compare', 'SandForge: Comparaison'],
    ['de', 'frozen', 'SandForge: Eingefrorenes Dataset'],
    ['ja', 'compare', 'SandForge: 組織比較'],
  ] as const)('titles a panel in %s with its navigation label', async (locale, module, title) => {
    // "SandForge: Compare" in every language, beside a sidebar entry that
    // said Comparaison, Vergleich or 組織比較.
    expect(await panelTitleOf(LOCALES_DIR, locale, module)).toBe(title);
  });

  it.each(SUPPORTED_LOCALE_CODES)(
    'titles every module’s panel in %s as its navigation names it',
    async (locale) => {
      const nav = navOf(locale);
      for (const { moduleId } of MODULE_COMMANDS) {
        expect({ moduleId, title: await panelTitleOf(LOCALES_DIR, locale, moduleId) }).toEqual({
          moduleId,
          title: panelTitle(nav[moduleId]),
        });
      }
    },
  );

  it('opens each panel under its English navigation label until its language is read', () => {
    const nav = navOf('en');
    expect(
      MODULE_COMMANDS.filter(({ moduleId, title }) => nav[moduleId] !== title).map(
        ({ moduleId, title }) => `${moduleId}: ${title} (nav: ${nav[moduleId]})`,
      ),
    ).toEqual([]);
  });

  it('gives no title for a module the catalogue does not name, nor where it cannot be read', async () => {
    expect(await panelTitleOf(LOCALES_DIR, 'fr', 'nowhere')).toBeUndefined();
    expect(await panelTitleOf(join(LOCALES_DIR, 'missing'), 'fr', 'compare')).toBeUndefined();
  });
});
