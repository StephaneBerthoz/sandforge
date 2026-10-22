import { describe, expect, it } from 'vitest';
import { isChunkLoadError, withoutFileUrls } from './chunkLoadError';

const CHUNK_URL =
  'https://file+.vscode-resource.vscode-cdn.net/home/someone/.vscode-server/extensions/sandforge/webview-dist/assets/chunks/ForgeReview-Dm32KBlM.js';

describe('isChunkLoadError', () => {
  it('knows a file that could not be fetched, as Chromium, Firefox and WebKit say it', () => {
    expect(
      isChunkLoadError(new TypeError(`Failed to fetch dynamically imported module: ${CHUNK_URL}`)),
    ).toBe(true);
    expect(
      isChunkLoadError(new TypeError(`error loading dynamically imported module: ${CHUNK_URL}`)),
    ).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
  });

  it('takes a page that broke while it rendered, or anything not an error, for something else', () => {
    expect(
      isChunkLoadError(new TypeError("Cannot read properties of undefined (reading 'x')")),
    ).toBe(false);
    expect(isChunkLoadError(new Error('page render failed'))).toBe(false);
    expect(isChunkLoadError('Failed to fetch dynamically imported module')).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });
});

describe('withoutFileUrls', () => {
  it("cuts a URL to the file it names, so the user's home folder never reaches a bug report", () => {
    const text = withoutFileUrls(`Failed to fetch dynamically imported module: ${CHUNK_URL}`);

    expect(text).toBe('Failed to fetch dynamically imported module: …/ForgeReview-Dm32KBlM.js');
    expect(text).not.toContain('someone');
  });

  it('cuts every URL of a stack, its line and column kept', () => {
    const stack = [
      'TypeError: x is not a function',
      '    at render (https://file+.vscode-resource.vscode-cdn.net/home/someone/ext/assets/index.js:1:2345)',
      '    at http://localhost:5173/src/pages/Forge/ForgePage.tsx:40:7',
    ].join('\n');

    expect(withoutFileUrls(stack)).toBe(
      [
        'TypeError: x is not a function',
        '    at render (…/index.js:1:2345)',
        '    at …/ForgePage.tsx:40:7',
      ].join('\n'),
    );
  });

  it('leaves text with no URL as it is', () => {
    expect(withoutFileUrls('page render failed')).toBe('page render failed');
  });
});
