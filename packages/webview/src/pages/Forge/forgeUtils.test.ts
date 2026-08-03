import { describe, it, expect } from 'vitest';
import {
  smartLimitForCount,
  extractRecordId,
  extractSalesforceDomain,
  isPiiField,
} from './forgeUtils';

describe('smartLimitForCount', () => {
  it('should return 50 for very large orgs (> 50,000 records)', () => {
    expect(smartLimitForCount(50_001)).toBe(50);
    expect(smartLimitForCount(1_000_000)).toBe(50);
  });

  it('should return 100 for large orgs (> 5,000 records)', () => {
    expect(smartLimitForCount(50_000)).toBe(100);
    expect(smartLimitForCount(5_001)).toBe(100);
  });

  it('should return 500 for medium orgs (> 500 records)', () => {
    expect(smartLimitForCount(5_000)).toBe(500);
    expect(smartLimitForCount(501)).toBe(500);
  });

  it('should return 1000 for small orgs (> 50 records)', () => {
    expect(smartLimitForCount(500)).toBe(1000);
    expect(smartLimitForCount(51)).toBe(1000);
  });

  it('should return 0 (no cap) for tiny orgs (<= 50 records)', () => {
    expect(smartLimitForCount(50)).toBe(0);
    expect(smartLimitForCount(1)).toBe(0);
    expect(smartLimitForCount(0)).toBe(0);
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
