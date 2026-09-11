import { describe, it, expect } from 'vitest';
import { parseHttpsUrl } from './parseHttpsUrl.js';

/**
 * The HTTPS gate that stands between stored org state and the system browser.
 * Which URLs it accepts and refuses is pinned here. Each caller then proves the
 * refusal really stops it before anything opens — `sandforge.openOrgInBrowser`
 * in extension.test.ts, `monitor:open-apex-jobs` in MonitorOpsHandler.test.ts:
 * a shared check that one caller skips protects nothing, and the command's
 * check could be bypassed with every test still green until its own test
 * existed.
 */
describe('parseHttpsUrl', () => {
  it('accepts an https instance URL and hands back the parsed URL', () => {
    const result = parseHttpsUrl('https://acme.my.salesforce.com');

    expect(result.ok).toBe(true);
    expect(result.ok && result.url.origin).toBe('https://acme.my.salesforce.com');
  });

  // `vscode.Uri.parse` accepts every one of these without throwing, which is
  // why a try/catch around it caught almost nothing.
  it.each([
    ['javascript:', 'javascript:alert(document.cookie)'],
    ['file:', 'file:///etc/passwd'],
    ['http:', 'http://acme.my.salesforce.com'],
  ])('refuses a %s URL and names the scheme it got', (protocol, raw) => {
    expect(parseHttpsUrl(raw)).toEqual({ ok: false, reason: 'not-https', protocol });
  });

  it.each([[''], ['acme.my.salesforce.com'], ['not a url']])(
    'refuses %j as invalid rather than guessing a scheme',
    (raw) => {
      expect(parseHttpsUrl(raw)).toEqual({ ok: false, reason: 'invalid' });
    },
  );
});
