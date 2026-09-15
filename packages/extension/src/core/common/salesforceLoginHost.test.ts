import { describe, it, expect } from 'vitest';
import { isSalesforceLoginHost, parseSalesforceLoginUrl } from './salesforceLoginHost.js';

/**
 * The gate a login URL crosses before credentials are sent to it or it is
 * written into an `sf org login web` command line. Which URLs it accepts and
 * refuses is pinned here; OrgHandler.test.ts and SfdxBridge.test.ts prove each
 * caller stops on a refusal before anything leaves the extension.
 */
describe('isSalesforceLoginHost', () => {
  it.each([
    'login.salesforce.com',
    'test.salesforce.com',
    'acme.my.salesforce.com',
    'acme--uat.sandbox.my.salesforce.com',
    'acme.lightning.force.com',
    'acme.cloudforce.com',
  ])('accepts %s', (host) => {
    expect(isSalesforceLoginHost(host)).toBe(true);
  });

  it.each([
    ['an unrelated host', 'evil.example.com'],
    ['a Salesforce name used as a prefix', 'login.salesforce.com.evil.io'],
    ['a suffix without a label boundary', 'evilmy.salesforce.com'],
    ['a bare suffix with no My Domain label', 'my.salesforce.com'],
    ['a trailing dot', 'login.salesforce.com.'],
    ['a shell metacharacter in a label', 'a&calc.my.salesforce.com'],
    ['a double quote in a label', 'a"b.my.salesforce.com'],
    ['an empty label', 'acme..my.salesforce.com'],
    ['another salesforce.com host that does not log in', 'www.salesforce.com'],
  ])('refuses %s', (_label, host) => {
    expect(isSalesforceLoginHost(host)).toBe(false);
  });
});

describe('parseSalesforceLoginUrl', () => {
  it('reduces an accepted URL to its origin', () => {
    expect(parseSalesforceLoginUrl('https://login.salesforce.com')).toEqual({
      ok: true,
      origin: 'https://login.salesforce.com',
    });
    expect(parseSalesforceLoginUrl('https://Acme.My.Salesforce.com/')).toEqual({
      ok: true,
      origin: 'https://acme.my.salesforce.com',
    });
  });

  it('refuses a URL that does not parse', () => {
    expect(parseSalesforceLoginUrl('not a url')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a URL that is not https', () => {
    expect(parseSalesforceLoginUrl('http://login.salesforce.com')).toEqual({
      ok: false,
      reason: 'not-https',
    });
  });

  it.each([
    'https://evil.example.com',
    'https://login.salesforce.com.evil.io',
    'https://a&b.my.salesforce.com',
  ])('refuses %s as a host that is not a Salesforce login host', (raw) => {
    expect(parseSalesforceLoginUrl(raw)).toEqual({ ok: false, reason: 'not-salesforce' });
  });

  // Everything after the host used to reach the Windows shell string verbatim.
  it.each([
    ['a quoted command in the path', 'https://login.salesforce.com/"&calc&"'],
    ['an environment variable in the path', 'https://login.salesforce.com/%PATH%'],
    ['a query string', 'https://login.salesforce.com/?x=1'],
    ['a fragment', 'https://login.salesforce.com/#x'],
    ['credentials', 'https://user:pass@login.salesforce.com'],
    ['a non-default port', 'https://login.salesforce.com:8443'],
  ])('refuses %s', (_label, raw) => {
    expect(parseSalesforceLoginUrl(raw)).toEqual({ ok: false, reason: 'not-origin' });
  });
});
