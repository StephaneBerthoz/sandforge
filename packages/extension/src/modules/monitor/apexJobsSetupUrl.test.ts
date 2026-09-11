import { describe, it, expect } from 'vitest';
import { apexJobsSetupUrl } from './apexJobsSetupUrl.js';

describe('apexJobsSetupUrl', () => {
  // The full address is spelled out, not rebuilt from the constant: a change
  // to the path has to show up here as a failing assertion.
  it("builds the Lightning Setup > Apex Jobs address on the org's own host", () => {
    expect(apexJobsSetupUrl('https://acme.my.salesforce.com')).toEqual({
      ok: true,
      url: 'https://acme.my.salesforce.com/lightning/setup/AsyncApexJobs/home',
    });
  });

  it('keeps only the origin of the stored instance URL', () => {
    // Credentials, a path, a query or a fragment in stored state never travel
    // into the address that is opened.
    expect(apexJobsSetupUrl('https://user:pw@acme.my.salesforce.com/secur/x?y=1#z')).toEqual({
      ok: true,
      url: 'https://acme.my.salesforce.com/lightning/setup/AsyncApexJobs/home',
    });
  });

  it('builds nothing from an instance URL the HTTPS gate refuses', () => {
    expect(apexJobsSetupUrl('javascript:alert(1)')).toEqual({
      ok: false,
      reason: 'not-https',
      protocol: 'javascript:',
    });
  });
});
