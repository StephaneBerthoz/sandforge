/**
 * The namespaces of the UI catalogue the sidebar renders keys from.
 *
 * The sidebar bundle carries these of the English catalogue and nothing else
 * (packages/webview/src/i18n/sidepanelCatalogue.ts), and the extension answers
 * its request for another language with the same ones: the whole catalogue of
 * a language is about 320 kB, read, parsed and sent each time VS Code
 * recreates the view, which it does at every reveal. The sidebar entry's test
 * checks that every key the sidebar renders falls in one of them.
 */
export const SIDEPANEL_LOCALE_NAMESPACES = [
  'common',
  'errorBoundary',
  'home',
  'nav',
  'sidePanel',
] as const;

/**
 * The part of a locale catalogue the sidebar renders: its namespaces, those
 * the catalogue has.
 *
 * @param catalogue - A whole locale catalogue, keyed by namespace.
 */
export function sidepanelLocaleSubset(
  catalogue: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    SIDEPANEL_LOCALE_NAMESPACES.filter((namespace) => namespace in catalogue).map((namespace) => [
      namespace,
      catalogue[namespace],
    ]),
  );
}
