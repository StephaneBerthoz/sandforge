import { describe, it, expect } from 'vitest';
import { translateForgeError } from './forgeErrorTranslator';

describe('translateForgeError', () => {
  it('returns null on empty input', () => {
    expect(translateForgeError('')).toBeNull();
    expect(translateForgeError('   ')).toBeNull();
  });

  it('translates DUPLICATE_VALUE with warning severity', () => {
    const result = translateForgeError('DUPLICATE_VALUE: duplicate value found: ExternalId__c');
    expect(result?.code).toBe('DUPLICATE_VALUE');
    expect(result?.severity).toBe('warning');
    expect(result?.explanation).toMatch(/existe déjà/);
  });

  it('translates INVALID_CROSS_REFERENCE_KEY as info (auto-handled)', () => {
    const result = translateForgeError('INVALID_CROSS_REFERENCE_KEY: Owner ID: cannot be blank');
    expect(result?.code).toBe('INVALID_CROSS_REFERENCE_KEY');
    expect(result?.severity).toBe('info');
    expect(result?.action).toMatch(/User courant/);
  });

  it('translates REQUIRED_FIELD_MISSING with the field name', () => {
    const result = translateForgeError('REQUIRED_FIELD_MISSING: Required fields are missing: [NameInsuredId]');
    expect(result?.code).toBe('REQUIRED_FIELD_MISSING');
    expect(result?.severity).toBe('error');
    expect(result?.explanation).toContain('NameInsuredId');
  });

  it('translates INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST with picklist context', () => {
    const result = translateForgeError(
      'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: UncertainContract',
    );
    expect(result?.code).toBe('INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST');
    expect(result?.severity).toBe('warning');
  });

  it('translates FIELD_INTEGRITY_EXCEPTION with detail', () => {
    const result = translateForgeError(
      'FIELD_INTEGRITY_EXCEPTION: Every asset needs an account, a contact, or both.: Account ID, Contact ID',
    );
    expect(result?.code).toBe('FIELD_INTEGRITY_EXCEPTION');
    expect(result?.severity).toBe('error');
    expect(result?.explanation).toContain('Every asset needs an account');
  });

  it('translates CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY as info', () => {
    const result = translateForgeError(
      'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: entity type cannot be inserted: Case History',
    );
    expect(result?.code).toBe('CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY');
    expect(result?.severity).toBe('info');
    expect(result?.action).toMatch(/skipped automatiquement/);
  });

  it('translates Cycle FK unresolved errors', () => {
    const result = translateForgeError(
      "Cycle FK 'PrimaryContactId' could not be resolved — referenced parent (source 003ABC) was not cloned",
    );
    expect(result?.code).toBe('CYCLE_FK_UNRESOLVED');
    expect(result?.severity).toBe('warning');
    expect(result?.explanation).toContain('PrimaryContactId');
  });

  it('translates out-of-scope messages as info', () => {
    const result = translateForgeError('no parent in cache and not the root');
    expect(result?.code).toBe('OUT_OF_SCOPE');
    expect(result?.severity).toBe('info');
  });

  it('falls back to default for unknown codes with the raw detail', () => {
    const result = translateForgeError('SOMETHING_NEW: details about the new error');
    expect(result?.code).toBe('SOMETHING_NEW');
    expect(result?.severity).toBe('error');
    expect(result?.explanation).toContain('details about the new error');
  });

  it('returns null when message has no recognizable format', () => {
    expect(translateForgeError('not a salesforce error')).toBeNull();
  });
});
