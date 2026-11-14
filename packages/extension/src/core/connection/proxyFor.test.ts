import { describe, expect, it } from 'vitest';
import { proxyFor } from './proxyFor.js';

describe('proxyFor', () => {
  it('takes HTTPS_PROXY for an https instance, HTTP_PROXY failing it, and none NO_PROXY names', () => {
    const at = 'https://acme.my.salesforce.com';
    expect(proxyFor(at, {})).toBeUndefined();
    expect(proxyFor(at, { HTTPS_PROXY: 'http://proxy:3128' })).toBe('http://proxy:3128');
    expect(proxyFor(at, { HTTP_PROXY: 'http://plain:3128' })).toBe('http://plain:3128');
    expect(proxyFor(at, { HTTPS_PROXY: 'http://proxy:3128', NO_PROXY: '.salesforce.com' })).toBe(
      undefined,
    );
    expect(proxyFor(at, { HTTPS_PROXY: 'http://proxy:3128', no_proxy: 'force.com' })).toBe(
      'http://proxy:3128',
    );
    expect(proxyFor('not a url', { HTTPS_PROXY: 'http://proxy:3128' })).toBeUndefined();
  });
});
