import { describe, it, expect } from 'vitest';
import { recordPageUrl } from './recordPageUrl.js';

describe('recordPageUrl', () => {
  // The full address is spelled out: a change to its path has to show up here.
  it("builds the record's Lightning page on the org's own host", () => {
    expect(
      recordPageUrl('https://acme.my.salesforce.com', 'Account', '001000000000001AAA'),
    ).toEqual({
      ok: true,
      url: 'https://acme.my.salesforce.com/lightning/r/Account/001000000000001AAA/view',
    });
  });

  it('takes a fifteen-character id and a custom object as they are', () => {
    expect(
      recordPageUrl('https://acme.my.salesforce.com', 'Invoice__c', 'a01000000000001'),
    ).toEqual({
      ok: true,
      url: 'https://acme.my.salesforce.com/lightning/r/Invoice__c/a01000000000001/view',
    });
  });

  it('keeps only the origin of the stored instance URL', () => {
    expect(
      recordPageUrl(
        'https://user:pw@acme.my.salesforce.com/secur/x?y=1#z',
        'Contact',
        '003000000000001',
      ),
    ).toEqual({
      ok: true,
      url: 'https://acme.my.salesforce.com/lightning/r/Contact/003000000000001/view',
    });
  });

  it('builds nothing from an id that is not one, whatever it carries', () => {
    for (const recordId of [
      '001000000000001AA',
      '001000000000001AAAA',
      '../../setup/home',
      '001000000000001?x=1',
      '00100000000000/',
      '',
    ]) {
      expect(recordPageUrl('https://acme.my.salesforce.com', 'Account', recordId)).toEqual({
        ok: false,
        reason: 'not-a-record',
      });
    }
  });

  it('builds nothing for an object name that is not one', () => {
    for (const objectApiName of ['Account/../../setup', 'evil.com', '1Account', '', 'Account?x']) {
      expect(
        recordPageUrl('https://acme.my.salesforce.com', objectApiName, '001000000000001'),
      ).toEqual({ ok: false, reason: 'not-a-record' });
    }
  });

  it('builds nothing from an instance URL the HTTPS gate refuses', () => {
    expect(recordPageUrl('javascript:alert(1)', 'Account', '001000000000001')).toEqual({
      ok: false,
      reason: 'not-https',
      protocol: 'javascript:',
    });
    expect(recordPageUrl('not a url', 'Account', '001000000000001')).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });
});
