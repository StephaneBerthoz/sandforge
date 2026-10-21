import { catalogueTextOf } from '../core/i18n/catalogueText.js';
import type { SupportedLocaleCode } from '../core/i18n/localeBundles.js';

/** A module panel's title, around the module's name. */
export function panelTitle(moduleName: string): string {
  return `SandForge: ${moduleName}`;
}

/**
 * The title of a module's panel tab: the module's navigation label (`nav.*`)
 * in the language the panels speak, read from their own catalogue. Undefined
 * when the catalogue cannot be read or names no such module.
 *
 * The tab read "SandForge: Compare" in every language, beside a sidebar entry
 * that says Compare Org, Vergleich or 組織比較. Read from the panels' catalogue
 * rather than translated again in the host's bundles, the tab says what the
 * navigation says, in the language SandForge's settings choose for the panels
 * when it is not the editor's.
 *
 * @param localesDir - The packaged `webview-dist/locales` directory.
 */
export async function panelTitleOf(
  localesDir: string,
  locale: SupportedLocaleCode,
  moduleId: string,
): Promise<string | undefined> {
  const label = await catalogueTextOf(localesDir, locale, `nav.${moduleId}`);
  return label === undefined ? undefined : panelTitle(label);
}
