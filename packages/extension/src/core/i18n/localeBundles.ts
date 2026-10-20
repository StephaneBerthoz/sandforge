import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Packaged webview locale bundles, served to webviews over the bridge
 * (`i18n:locale` / `i18n:locale:response`).
 *
 * The webview ships only English in its bundles (the 6 locale JSONs cost
 * ~443 KB minified) and its CSP (`default-src 'none'`) forbids fetch, which
 * is how a JSON module would be loaded — so the other locales are packaged
 * loose under `webview-dist/locales/` (copied from the webview build output)
 * and read here on demand.
 */

/** Locale codes a webview may request. Doubles as the path-traversal guard:
 * `readLocaleBundle` joins `<lng>.json` onto the locales directory, which is
 * only safe because this whitelist contains no separators. */
export const SUPPORTED_LOCALE_CODES = ['en', 'fr', 'de', 'es', 'ja', 'pt-BR'] as const;

/** Union of {@link SUPPORTED_LOCALE_CODES}. */
export type SupportedLocaleCode = (typeof SUPPORTED_LOCALE_CODES)[number];

/** Type guard for {@link SupportedLocaleCode}. */
export function isSupportedLocaleCode(lng: unknown): lng is SupportedLocaleCode {
  return typeof lng === 'string' && (SUPPORTED_LOCALE_CODES as readonly string[]).includes(lng);
}

/**
 * The catalogues read so far, by file. They are packaged with the extension
 * and do not change while it runs.
 */
const parsedBundles = new Map<string, Promise<Record<string, unknown>>>();

/**
 * Read and parse the packaged locale JSON for `lng` (`<localesDir>/<lng>.json`).
 * Rejects on IO or parse failure — callers turn that into an `error` payload.
 *
 * Read once per file. Every panel opened in a language other than English
 * asks for its catalogue, about 320 kB, and so does the sidebar each time VS
 * Code recreates it, at every reveal: each request used to read and parse the
 * file again. A failed read is not kept, so the next request tries again.
 * Callers must not change what they are given: the next caller gets it too.
 */
export function readLocaleBundle(
  localesDir: string,
  lng: SupportedLocaleCode,
): Promise<Record<string, unknown>> {
  const file = join(localesDir, `${lng}.json`);
  const known = parsedBundles.get(file);
  if (known) return known;
  const reading = readFile(file, 'utf-8').then((raw) => JSON.parse(raw) as Record<string, unknown>);
  parsedBundles.set(file, reading);
  reading.catch(() => parsedBundles.delete(file));
  return reading;
}
