import { describe, it, expect } from 'vitest';

import {
  isValidSalesforceId,
  to18CharId,
  isValidApiName,
  isCustomObject,
  isCustomField,
  extractNamespace,
  formatRecordCount,
  estimateApiCalls,
  sanitizeSoqlObjectName,
  orgTypeToGuardTier,
} from './sf-utils.js';

describe('isValidSalesforceId', () => {
  it('should accept a valid 15-char ID', () => {
    expect(isValidSalesforceId('001000000000001')).toBe(true);
  });

  it('should accept a valid 18-char ID', () => {
    expect(isValidSalesforceId('001000000000001AAA')).toBe(true);
  });

  it('should accept IDs with mixed alphanumeric characters', () => {
    expect(isValidSalesforceId('0013000000aB1cD')).toBe(true);
    expect(isValidSalesforceId('0013000000aB1cDEFG')).toBe(true);
  });

  it('should reject IDs shorter than 15 chars', () => {
    expect(isValidSalesforceId('00100000')).toBe(false);
  });

  it('should reject IDs with 16 or 17 chars', () => {
    expect(isValidSalesforceId('0010000000000011')).toBe(false);
    expect(isValidSalesforceId('00100000000000111')).toBe(false);
  });

  it('should reject IDs longer than 18 chars', () => {
    expect(isValidSalesforceId('001000000000001AAAB')).toBe(false);
  });

  it('should reject IDs with special characters', () => {
    expect(isValidSalesforceId('001!00000000001')).toBe(false);
    expect(isValidSalesforceId('001 00000000001')).toBe(false);
  });

  it('should reject empty string', () => {
    expect(isValidSalesforceId('')).toBe(false);
  });
});

describe('to18CharId', () => {
  it('should return an 18-char ID unchanged', () => {
    const id18 = '001000000000001AAA';
    expect(to18CharId(id18)).toBe(id18);
  });

  it('should convert a valid 15-char ID to 18-char', () => {
    const result = to18CharId('001000000000001');
    expect(result).toHaveLength(18);
    expect(result.startsWith('001000000000001')).toBe(true);
  });

  it('should produce a deterministic result', () => {
    const id = '001A000001bCdEf';
    expect(to18CharId(id)).toBe(to18CharId(id));
  });

  it('should compute correct checksum for all-lowercase ID', () => {
    const id = '001a00000bc00de';
    const result = to18CharId(id);
    expect(result).toHaveLength(18);
    // All lowercase, so flags should be 0 for each chunk -> 'AAA'
    expect(result).toBe('001a00000bc00deAAA');
  });

  it('should compute correct checksum for uppercase characters', () => {
    // Known conversion: 001D000001bCdEf
    const id = '001D000001bCdEf';
    const result = to18CharId(id);
    expect(result).toHaveLength(18);
    expect(isValidSalesforceId(result)).toBe(true);
  });

  it('should throw for IDs with invalid length', () => {
    expect(() => to18CharId('001')).toThrow('Invalid Salesforce ID length: 3');
    expect(() => to18CharId('00100000000000011')).toThrow('Invalid Salesforce ID length: 17');
  });
});

describe('isValidApiName', () => {
  it('should accept standard object names', () => {
    expect(isValidApiName('Account')).toBe(true);
    expect(isValidApiName('Contact')).toBe(true);
    expect(isValidApiName('Opportunity')).toBe(true);
  });

  it('should accept custom object names', () => {
    expect(isValidApiName('Custom__c')).toBe(true);
    expect(isValidApiName('My_Object__c')).toBe(true);
  });

  it('should accept names with underscores', () => {
    expect(isValidApiName('My_Custom_Object')).toBe(true);
  });

  it('should reject names starting with numbers', () => {
    expect(isValidApiName('1Account')).toBe(false);
  });

  it('should reject names starting with underscores', () => {
    expect(isValidApiName('_Account')).toBe(false);
  });

  it('should reject empty string', () => {
    expect(isValidApiName('')).toBe(false);
  });

  it('should reject names with spaces', () => {
    expect(isValidApiName('My Object')).toBe(false);
  });
});

describe('isCustomObject', () => {
  it('should return true for custom object names', () => {
    expect(isCustomObject('Custom__c')).toBe(true);
    expect(isCustomObject('ns__MyObj__c')).toBe(true);
  });

  it('should return false for standard object names', () => {
    expect(isCustomObject('Account')).toBe(false);
    expect(isCustomObject('Contact')).toBe(false);
  });

  it('should return false for custom metadata types', () => {
    expect(isCustomObject('Custom__mdt')).toBe(false);
  });
});

describe('isCustomField', () => {
  it('should return true for custom field names', () => {
    expect(isCustomField('MyField__c')).toBe(true);
    expect(isCustomField('ns__Field__c')).toBe(true);
  });

  it('should return false for standard field names', () => {
    expect(isCustomField('Name')).toBe(false);
    expect(isCustomField('Id')).toBe(false);
    expect(isCustomField('CreatedDate')).toBe(false);
  });
});

describe('extractNamespace', () => {
  it('should extract namespace from namespaced custom object', () => {
    expect(extractNamespace('ns__MyObject__c')).toBe('ns');
    expect(extractNamespace('MyNs__Custom__c')).toBe('MyNs');
  });

  it('should return undefined for non-namespaced custom object', () => {
    expect(extractNamespace('Custom__c')).toBeUndefined();
  });

  it('should return undefined for standard objects', () => {
    expect(extractNamespace('Account')).toBeUndefined();
    expect(extractNamespace('Contact')).toBeUndefined();
  });

  it('should return undefined for objects not ending in __c', () => {
    expect(extractNamespace('ns__MyObject__mdt')).toBeUndefined();
  });
});

describe('formatRecordCount', () => {
  it('should format counts below 1000 as plain numbers', () => {
    expect(formatRecordCount(0)).toBe('0');
    expect(formatRecordCount(1)).toBe('1');
    expect(formatRecordCount(999)).toBe('999');
  });

  it('should format thousands with K suffix', () => {
    expect(formatRecordCount(1000)).toBe('1.0K');
    expect(formatRecordCount(1500)).toBe('1.5K');
    expect(formatRecordCount(999_999)).toBe('1000.0K');
  });

  it('should format millions with M suffix', () => {
    expect(formatRecordCount(1_000_000)).toBe('1.0M');
    expect(formatRecordCount(3_500_000)).toBe('3.5M');
    expect(formatRecordCount(150_000_000)).toBe('150.0M');
  });
});

describe('estimateApiCalls', () => {
  it('should return 1 when records fit in a single batch', () => {
    expect(estimateApiCalls(100, 200)).toBe(1);
  });

  it('should ceil to the next batch', () => {
    expect(estimateApiCalls(201, 200)).toBe(2);
    expect(estimateApiCalls(400, 200)).toBe(2);
    expect(estimateApiCalls(401, 200)).toBe(3);
  });

  it('should handle exact multiples', () => {
    expect(estimateApiCalls(1000, 200)).toBe(5);
  });

  it('should return 1 for a single record', () => {
    expect(estimateApiCalls(1, 200)).toBe(1);
  });

  it('should throw for Infinity recordCount', () => {
    expect(() => estimateApiCalls(Infinity, 200)).toThrow('recordCount must be a finite number');
  });

  it('should throw for NaN recordCount', () => {
    expect(() => estimateApiCalls(NaN, 200)).toThrow('recordCount must be a finite number');
  });

  it('should throw for Infinity batchSize', () => {
    expect(() => estimateApiCalls(100, Infinity)).toThrow(
      'batchSize must be a finite positive number',
    );
  });

  it('should throw for NaN batchSize', () => {
    expect(() => estimateApiCalls(100, NaN)).toThrow('batchSize must be a finite positive number');
  });
});

describe('isValidApiName extended', () => {
  it('should accept namespaced custom objects', () => {
    expect(isValidApiName('ns__MyObject__c')).toBe(true);
  });
  it('should accept custom metadata types', () => {
    expect(isValidApiName('Config__mdt')).toBe(true);
  });
  it('should accept platform events', () => {
    expect(isValidApiName('OrderEvent__e')).toBe(true);
  });
  it('should accept big objects', () => {
    expect(isValidApiName('Archive__b')).toBe(true);
  });
  it('should still reject invalid names', () => {
    expect(isValidApiName('')).toBe(false);
    expect(isValidApiName('123Invalid')).toBe(false);
    expect(isValidApiName('has spaces')).toBe(false);
  });
});

describe('estimateApiCalls edge cases', () => {
  it('should throw on batchSize = 0', () => {
    expect(() => estimateApiCalls(100, 0)).toThrow('batchSize must be a finite positive number');
  });
  it('should throw on negative batchSize', () => {
    expect(() => estimateApiCalls(100, -5)).toThrow('batchSize must be a finite positive number');
  });
  it('should return 0 for recordCount <= 0', () => {
    expect(estimateApiCalls(0, 200)).toBe(0);
    expect(estimateApiCalls(-10, 200)).toBe(0);
  });
});

describe('sanitizeSoqlObjectName', () => {
  it('should return valid standard object names unchanged', () => {
    expect(sanitizeSoqlObjectName('Account')).toBe('Account');
    expect(sanitizeSoqlObjectName('Contact')).toBe('Contact');
  });

  it('should return valid custom object names unchanged', () => {
    expect(sanitizeSoqlObjectName('Custom__c')).toBe('Custom__c');
    expect(sanitizeSoqlObjectName('ns__MyObject__c')).toBe('ns__MyObject__c');
  });

  it('should throw for empty string', () => {
    expect(() => sanitizeSoqlObjectName('')).toThrow('Invalid Salesforce object API name');
  });

  it('should throw for SOQL injection attempts', () => {
    expect(() => sanitizeSoqlObjectName('Account; DELETE')).toThrow(
      'Invalid Salesforce object API name',
    );
    expect(() => sanitizeSoqlObjectName("Account' OR 1=1--")).toThrow(
      'Invalid Salesforce object API name',
    );
    expect(() => sanitizeSoqlObjectName('<script>')).toThrow('Invalid Salesforce object API name');
  });

  it('should throw for names starting with numbers', () => {
    expect(() => sanitizeSoqlObjectName('123Object')).toThrow('Invalid Salesforce object API name');
  });

  it('should throw for names with spaces', () => {
    expect(() => sanitizeSoqlObjectName('My Object')).toThrow('Invalid Salesforce object API name');
  });
});

describe('orgTypeToGuardTier', () => {
  it('should map Production to production', () => {
    expect(orgTypeToGuardTier('Production')).toBe('production');
  });

  it('should map Sandbox to development', () => {
    expect(orgTypeToGuardTier('Sandbox')).toBe('development');
  });

  it('should map Scratch to scratch', () => {
    expect(orgTypeToGuardTier('Scratch')).toBe('scratch');
  });

  it('should map Developer to development', () => {
    expect(orgTypeToGuardTier('Developer')).toBe('development');
  });

  it('should default unknown types to development', () => {
    expect(orgTypeToGuardTier('Unknown')).toBe('development');
    expect(orgTypeToGuardTier('')).toBe('development');
  });
});
