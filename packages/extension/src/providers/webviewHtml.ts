import { randomBytes } from 'node:crypto';

/**
 * Assets needed to render a SandForge webview HTML shell. URIs are expected
 * to be already resolved through `webview.asWebviewUri(...)` by the caller
 * (the panel manager and the sidebar provider resolve them differently,
 * which is why this helper takes the resolved values).
 */
export interface WebviewHtmlAssets {
  /** `webview.cspSource` of the target webview. */
  cspSource: string;
  /** Resolved URI of the React bundle (`webview-dist/assets/index.js`). */
  scriptUri: { toString(): string };
  /** Resolved URI of the stylesheet (`webview-dist/assets/style.css`). */
  styleUri: { toString(): string };
  /** Content of the HTML `<title>` tag. */
  title: string;
  /** Module id injected as `window.__SANDFORGE_MODULE__` for routing. */
  moduleId: string;
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
  const { cspSource, scriptUri, styleUri, title, moduleId } = assets;
  const nonce = generateNonce();

  return `<!DOCTYPE html>
<html lang="en">
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
