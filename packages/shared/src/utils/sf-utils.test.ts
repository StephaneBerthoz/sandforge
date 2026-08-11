import { describe, it, expect } from 'vitest';

import { sanitizeSoqlObjectName, orgTypeToGuardTier } from './sf-utils.js';

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
