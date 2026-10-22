/**
 * What a browser throws when a file the panel imports on demand cannot be
 * fetched: Chromium (VS Code's webviews) says "Failed to fetch dynamically
 * imported module: <url>", Firefox "error loading dynamically imported
 * module: <url>", WebKit "Importing a module script failed.".
 */
const CHUNK_LOAD_FAILURE =
  /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i;

/**
 * Whether `error` is a file of the panel that could not be fetched, rather
 * than a page that broke while it rendered.
 *
 * Every page, step, tab and chart past the panel's base is a file fetched the
 * first time it is shown, minutes or hours after the panel opened: while a
 * remote window reconnects, or after a reinstall replaced the files, that
 * fetch fails. React keeps such a part failed for as long as the document
 * lives and never asks for the file again, so the only way back is a new
 * document: the panel's shell set again (`panel:reload`).
 */
export function isChunkLoadError(error: unknown): boolean {
  return error instanceof Error && CHUNK_LOAD_FAILURE.test(error.message);
}

/**
 * `text` with each URL cut to its last path segment.
 *
 * A webview's files are served from the extension's folder, so a URL in an
 * error or a stack spells the user's home folder
 * (`https://file+.vscode-resource.vscode-cdn.net/home/<user>/…/ForgeReview-x.js`).
 * Copy Error pasted it whole into a bug report; the file name is what says
 * which part failed.
 */
export function withoutFileUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)'"]*/gi, (url) => {
    const segments = url.split(/[/\\]/).filter((segment) => segment !== '');
    const last = segments[segments.length - 1] ?? '';
    return `…/${last}`;
  });
}
