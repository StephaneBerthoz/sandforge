import {
  SUPPORTED_LOCALE_CODES,
  readLocaleBundle,
  type SupportedLocaleCode,
} from './localeBundles.js';

/**
 * The words of the error catalogue the host shows outside the panels: a VS
 * Code notification about a failed operation, read from the webview's own
 * locale bundles.
 *
 * The host kept a table of its own, in English, translated through the
 * extension's l10n bundles: the notification and the hint under the same
 * failure said different things in different words. The catalogue lives in
 * `@sandforge/shared` and its texts in the six webview locales; the host
 * reads the same text the panel shows.
 */

/**
 * The shipped locale for a language: the one configured in SandForge's
 * settings, else the editor's display language — exact code first, `pt-br`
 * finding `pt-BR`, then its primary subtag, as the panels match it — else
 * English.
 *
 * @param configured - The UI language the settings hold, when one is set.
 * @param editorLanguage - `vscode.env.language`.
 */
export function uiLocaleOf(
  configured: SupportedLocaleCode | undefined,
  editorLanguage: string | undefined,
): SupportedLocaleCode {
  if (configured) return configured;
  const lower = (editorLanguage ?? '').toLowerCase();
  const exact = SUPPORTED_LOCALE_CODES.find((code) => code.toLowerCase() === lower);
  if (exact) return exact;
  const base = lower.split('-')[0];
  return SUPPORTED_LOCALE_CODES.find((code) => code.toLowerCase().split('-')[0] === base) ?? 'en';
}

/** A dotted key's text in a parsed bundle, or undefined. */
function textAt(bundle: Record<string, unknown>, key: string): string | undefined {
  let node: unknown = bundle;
  for (const part of key.split('.')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' && node.trim() !== '' ? node : undefined;
}

/**
 * The text of a catalogue key in a locale, English when the locale's bundle
 * lacks it or cannot be read, or undefined when neither has it — a build
 * without its webview, a test.
 *
 * @param localesDir - The packaged `webview-dist/locales` directory.
 */
export async function catalogueTextOf(
  localesDir: string,
  locale: SupportedLocaleCode,
  key: string,
): Promise<string | undefined> {
  for (const candidate of locale === 'en' ? ['en' as const] : [locale, 'en' as const]) {
    try {
      const text = textAt(await readLocaleBundle(localesDir, candidate), key);
      if (text !== undefined) return text;
    } catch {
      // Unreadable: the next candidate, or nothing.
    }
  }
  return undefined;
}
