import { describe, it, expect } from 'vitest';
import { buildWebviewHtml, generateNonce } from './webviewHtml';

function build(overrides?: Partial<Parameters<typeof buildWebviewHtml>[0]>): string {
  return buildWebviewHtml({
    cspSource: 'https://test.csp.source',
    scriptUri: { toString: () => 'vscode-webview://test/index.js' },
    styleUri: { toString: () => 'vscode-webview://test/style.css' },
    title: 'SandForge: monitor',
    moduleId: 'monitor',
    ...overrides,
  });
}

describe('generateNonce', () => {
  it('returns 32 base64url characters (24 random bytes)', () => {
    expect(generateNonce()).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  it('produces distinct nonces on successive calls', () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
});

describe('buildWebviewHtml', () => {
  it('enforces a strict CSP with a nonce-only script-src', () => {
    const html = build();
    expect(html).toContain("default-src 'none'");
    expect(html).toMatch(/script-src 'nonce-[A-Za-z0-9_-]{32}'/);
    expect(html).toContain("style-src https://test.csp.source 'unsafe-inline'");
    expect(html).toContain('font-src https://test.csp.source');
    expect(html).toContain('img-src https://test.csp.source data:;');
  });

  it('uses the same nonce in the CSP and both script tags', () => {
    const html = build();
    const cspNonce = /script-src 'nonce-([A-Za-z0-9_-]{32})'/.exec(html)?.[1];
    expect(cspNonce).toBeDefined();
    const tagNonces = [...html.matchAll(/<script nonce="([A-Za-z0-9_-]{32})"/g)].map((m) => m[1]);
    expect(tagNonces).toHaveLength(2);
    expect(tagNonces[0]).toBe(cspNonce);
    expect(tagNonces[1]).toBe(cspNonce);
  });

  it('injects the module id before the bundle script', () => {
    const html = build({ moduleId: 'forge' });
    expect(html).toContain('window.__SANDFORGE_MODULE__="forge"');
    const injectIdx = html.indexOf('__SANDFORGE_MODULE__');
    const bundleIdx = html.indexOf('src="vscode-webview://test/index.js"');
    expect(injectIdx).toBeGreaterThan(-1);
    expect(bundleIdx).toBeGreaterThan(injectIdx);
  });

  it('renders title, stylesheet link and root container', () => {
    const html = build({ title: 'SandForge Sidebar', moduleId: 'sidepanel' });
    expect(html).toContain('<title>SandForge Sidebar</title>');
    expect(html).toContain('<link href="vscode-webview://test/style.css" rel="stylesheet">');
    expect(html).toContain('<div id="root"></div>');
    expect(html).toContain('window.__SANDFORGE_MODULE__="sidepanel"');
  });
});
