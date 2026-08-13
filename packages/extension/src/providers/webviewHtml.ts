import { randomBytes } from 'node:crypto';
import { isSupportedLocaleCode, type SupportedLocaleCode } from '../core/i18n/localeBundles';

/**
 * Assets needed to render a SandForge webview HTML shell. URIs are expected
 * to be already resolved through `webview.asWebviewUri(...)` by the caller
 * (the panel manager and the sidebar provider resolve them differently,
 * which is why this helper takes the resolved values).
 */
export interface WebviewHtmlAssets {
  /** `webview.cspSource` of the target webview. */
  cspSource: string;
  /** Resolved URI of the React bundle (panels: `webview-dist/assets/index.js`, sidebar: `webview-dist/assets/sidepanel.js`). */
  scriptUri: { toString(): string };
  /** Resolved URI of the stylesheet (panels: `webview-dist/assets/style.css`, sidebar: `webview-dist/assets/sidepanel.css`). */
  styleUri: { toString(): string };
  /** Content of the HTML `<title>` tag. */
  title: string;
  /** Module id injected as `window.__SANDFORGE_MODULE__` for routing. */
  moduleId: string;
  /**
   * BCP-47 code for `<html lang>`, i.e. the configured UI language. Assistive
   * tech reads the attribute of the *first paint*, before the bundle has
   * restored its language — so a hardcoded "en" makes a screen reader announce
   * six locales in an English voice. Unknown values fall back to `en`.
   */
  lang?: string;
}

/**
 * Extract the configured UI language from the `settings` config category.
 *
 * Layout is historical baggage, same as the webview's `readLanguageCandidate`:
 * current builds save the whole settings object under a `settings` key
 * (`{settings: {language}}`), older builds wrote `language` as a flat category
 * key. Both shapes are read; anything else yields `undefined` so the caller
 * keeps the default.
 */
export function readConfiguredLanguage(settings: unknown): SupportedLocaleCode | undefined {
  const blob = settings as Record<string, unknown> | null | undefined;
  const nested = blob?.['settings'] as Record<string, unknown> | null | undefined;
  const candidate = blob?.['language'] ?? nested?.['language'];
  return isSupportedLocaleCode(candidate) ? candidate : undefined;
}

/**
 * Generate a cryptographically-random ~32-character nonce for CSP script tags.
 * Uses node:crypto so the nonce is unguessable — Math.random is a PRNG and
 * predictable enough that an adversary who derives the seed could bypass CSP.
 */
export function generateNonce(): string {
  return randomBytes(24).toString('base64url');
}

/**
 * Build the HTML shell shared by full-editor panels and the sidebar view.
 * Strict CSP: default-src 'none', scripts only via nonce, styles via the
 * webview origin + 'unsafe-inline' (the bundle injects inline styles).
 * Both script tags share one nonce; the module id is injected before the
 * bundle loads so the React app can route to the correct view.
 */
export function buildWebviewHtml(assets: WebviewHtmlAssets): string {
  const { cspSource, scriptUri, styleUri, title, moduleId, lang } = assets;
  const nonce = generateNonce();
  // Whitelisted, never interpolated raw: the value originates in a
  // hand-editable config store and lands inside an HTML attribute.
  const htmlLang = isSupportedLocaleCode(lang) ? lang : 'en';

  return `<!DOCTYPE html>
<html lang="${htmlLang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${cspSource}; img-src ${cspSource} data:;">
  <link href="${String(styleUri)}" rel="stylesheet">
  <title>${title}</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__SANDFORGE_MODULE__="${moduleId}";</script>
  <script nonce="${nonce}" src="${String(scriptUri)}"></script>
</body>
</html>`;
}
