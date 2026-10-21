import { describe, it, expect } from 'vitest';
import {
  SMART_SOQL_CAP,
  SOQL_UNSCOPED_RECORD_CAP,
  extractRecordId,
  extractSalesforceDomain,
  isPiiField,
} from './forgeUtils';

describe('SMART_SOQL_CAP', () => {
  it('stays under the cap a SOQL run is held to whatever is chosen', () => {
    expect(SMART_SOQL_CAP).toBeGreaterThan(0);
    expect(SMART_SOQL_CAP).toBeLessThanOrEqual(SOQL_UNSCOPED_RECORD_CAP);
  });
});

describe('extractRecordId', () => {
  it('should accept a plain 15-char ID', () => {
    expect(extractRecordId('001XXXXXXXXXXXX')).toBe('001XXXXXXXXXXXX');
  });

  it('should accept a plain 18-char ID', () => {
    expect(extractRecordId('001XXXXXXXXXXXXXXX')).toBe('001XXXXXXXXXXXXXXX');
  });

  it('should trim surrounding whitespace', () => {
    expect(extractRecordId('  001XXXXXXXXXXXXXXX  ')).toBe('001XXXXXXXXXXXXXXX');
  });

  it('should extract the ID from a Lightning URL', () => {
    expect(
      extractRecordId(
        'https://myorg.lightning.force.com/lightning/r/Account/001XXXXXXXXXXXXXXX/view',
      ),
    ).toBe('001XXXXXXXXXXXXXXX');
  });

  it('should extract the ID from a URL with a query string', () => {
    expect(extractRecordId('https://myorg.salesforce.com/001XXXXXXXXXXXXXXX?foo=bar')).toBe(
      '001XXXXXXXXXXXXXXX',
    );
  });

  it('should extract the ID from a URL ending with the ID', () => {
    expect(extractRecordId('https://myorg.salesforce.com/001XXXXXXXXXXXX')).toBe('001XXXXXXXXXXXX');
  });

  it('should return null for invalid input', () => {
    expect(extractRecordId('')).toBeNull();
    expect(extractRecordId('not-an-id')).toBeNull();
    expect(extractRecordId('001XX')).toBeNull();
  });
});

describe('extractSalesforceDomain', () => {
  it('should extract the pod/host prefix from a Salesforce URL', () => {
    expect(extractSalesforceDomain('https://myorg.salesforce.com/')).toBe('myorg');
    expect(extractSalesforceDomain('https://myorg.lightning.force.com/lightning/r/x')).toBe(
      'myorg',
    );
  });

  it('should lowercase the host', () => {
    expect(extractSalesforceDomain('https://MyOrg.Salesforce.com')).toBe('myorg');
  });

  it('should return null for invalid URLs', () => {
    expect(extractSalesforceDomain('not a url')).toBeNull();
    expect(extractSalesforceDomain('')).toBeNull();
  });
});

describe('isPiiField', () => {
  it('should detect common PII field names', () => {
    expect(isPiiField('Email')).toBe(true);
    expect(isPiiField('Phone')).toBe(true);
    expect(isPiiField('MobilePhone__c')).toBe(true);
    expect(isPiiField('BillingStreet')).toBe(true);
    expect(isPiiField('SSN__c')).toBe(true);
    expect(isPiiField('Birthdate')).toBe(true);
  });

  it('should not flag non-PII field names', () => {
    expect(isPiiField('Name')).toBe(false);
    expect(isPiiField('Industry')).toBe(false);
    expect(isPiiField('AnnualRevenue')).toBe(false);
  });
});
