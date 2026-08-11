import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Packaged webview locale bundles, served to webviews over the bridge
 * (`i18n:locale` / `i18n:locale:response`).
 *
 * The webview ships only English in its IIFE bundle (the 6 locale JSONs cost
 * ~443 KB minified) and its CSP (`default-src 'none'`) forbids fetch and
 * dynamic import — so the other locales are packaged loose under
 * `webview-dist/locales/` (copied from the webview build output) and read
 * here on demand.
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
 * Read and parse the packaged locale JSON for `lng` (`<localesDir>/<lng>.json`).
 * Throws on IO or parse failure — callers turn that into an `error` payload.
 */
export async function readLocaleBundle(
  localesDir: string,
  lng: SupportedLocaleCode,
): Promise<Record<string, unknown>> {
  const raw = await readFile(join(localesDir, `${lng}.json`), 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}
