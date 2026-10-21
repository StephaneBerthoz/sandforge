import { englishNamespaceLoaders } from 'virtual:english-catalogue';
import i18n from './index';

/** A namespace of the English catalogue: one of its top-level sections. */
export type EnglishNamespace = keyof typeof import('./locales/en.json');

/** Whether i18next holds `namespace` of the English catalogue yet. */
function holdsEnglish(namespace: string): boolean {
  const english = i18n.getResourceBundle('en', 'translation') as
    Record<string, unknown> | undefined;
  return english !== undefined && namespace in english;
}

/**
 * Load the English of `namespaces` that i18next does not hold yet, each from
 * its own chunk, and add it to the catalogue.
 *
 * A panel starts with the namespaces its shell renders (panelCatalogue.ts):
 * a page brings its own when it loads (PanelRouter), and an overlay its own
 * when it opens. Another language comes whole over the bridge; English is the
 * fallback under it, so a page's English is loaded whatever the language.
 * Loaded once: a namespace held is never asked again, and in the tests, which
 * start with the whole catalogue, nothing is.
 */
export async function loadEnglishNamespaces(
  namespaces: readonly EnglishNamespace[],
): Promise<void> {
  const loaders = englishNamespaceLoaders as Readonly<
    Record<string, (() => Promise<{ default: Record<string, unknown> }>) | undefined>
  >;
  await Promise.all(
    namespaces
      .filter((namespace) => !holdsEnglish(namespace))
      .map(async (namespace) => {
        const load = loaders[namespace];
        if (!load) throw new Error(`The English catalogue has no namespace "${namespace}"`);
        const { default: strings } = await load();
        i18n.addResourceBundle('en', 'translation', { [namespace]: strings }, true, false);
      }),
  );
}

/**
 * `load`, which loads a part of the panel, with the English that part
 * renders: what it resolves to is ready to render once both are in.
 *
 * src/PanelRouter.english.test.ts reads the namespaces each loader names
 * against the keys the part it loads spells.
 */
export function withEnglish<T>(
  load: () => Promise<T>,
  namespaces: readonly EnglishNamespace[],
): () => Promise<T> {
  return () => Promise.all([load(), loadEnglishNamespaces(namespaces)]).then(([loaded]) => loaded);
}
