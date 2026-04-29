import { describe, it, expect } from 'vitest';
import { translateForgeError } from './forgeErrorTranslator';

describe('translateForgeError', () => {
  it('returns null on empty input', () => {
    expect(translateForgeError('')).toBeNull();
    expect(translateForgeError('   ')).toBeNull();
  });

  it('translates DUPLICATE_VALUE to its i18n keys (warning severity)', () => {
    const result = translateForgeError('DUPLICATE_VALUE: duplicate value found: ExternalId__c');
    expect(result?.code).toBe('DUPLICATE_VALUE');
    expect(result?.severity).toBe('warning');
    expect(result?.explanationKey).toBe('forge.error.duplicateValue.explanation');
    expect(result?.actionKey).toBe('forge.error.duplicateValue.action');
  });

  it('translates INVALID_CROSS_REFERENCE_KEY as info (auto-handled)', () => {
    const result = translateForgeError('INVALID_CROSS_REFERENCE_KEY: Owner ID: cannot be blank');
    expect(result?.code).toBe('INVALID_CROSS_REFERENCE_KEY');
    expect(result?.severity).toBe('info');
    expect(result?.explanationKey).toBe('forge.error.invalidCrossReferenceKey.explanation');
  });

  it('captures REQUIRED_FIELD_MISSING detail in vars', () => {
    const result = translateForgeError('REQUIRED_FIELD_MISSING: Required fields are missing: [NameInsuredId]');
    expect(result?.code).toBe('REQUIRED_FIELD_MISSING');
    expect(result?.severity).toBe('error');
    expect(result?.vars?.detail).toContain('Required fields');
  });

  it('translates INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST', () => {
    const result = translateForgeError(
      'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: UncertainContract',
    );
    expect(result?.code).toBe('INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST');
    expect(result?.severity).toBe('warning');
    expect(result?.explanationKey).toBe('forge.error.invalidPicklist.explanation');
  });

  it('captures FIELD_INTEGRITY_EXCEPTION detail', () => {
    const result = translateForgeError(
      'FIELD_INTEGRITY_EXCEPTION: Every asset needs an account, a contact, or both.: Account ID, Contact ID',
    );
    expect(result?.code).toBe('FIELD_INTEGRITY_EXCEPTION');
    expect(result?.severity).toBe('error');
    expect(result?.vars?.detail).toContain('Every asset needs');
  });

  it('translates CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY as info', () => {
    const result = translateForgeError(
      'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: entity type cannot be inserted: Case History',
    );
    expect(result?.code).toBe('CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY');
    expect(result?.severity).toBe('info');
    expect(result?.explanationKey).toBe('forge.error.cannotInsertEntity.explanation');
  });

  it('translates Cycle FK with field name + source ref', () => {
    const result = translateForgeError(
      "Cycle FK 'PrimaryContactId' could not be resolved — referenced parent (source 003ABC123) was not cloned",
    );
    expect(result?.code).toBe('CYCLE_FK_UNRESOLVED');
    expect(result?.severity).toBe('warning');
    expect(result?.vars?.fieldName).toBe('PrimaryContactId');
    expect(result?.vars?.sourceRefId).toBe('003ABC123');
  });

  it('translates out-of-scope messages as info', () => {
    const result = translateForgeError('no parent in cache and not the root');
    expect(result?.code).toBe('OUT_OF_SCOPE');
    expect(result?.severity).toBe('info');
    expect(result?.explanationKey).toBe('forge.error.outOfScope.explanation');
  });

  it('falls back to unknown keys with the raw detail', () => {
    const result = translateForgeError('SOMETHING_NEW: details about the new error');
    expect(result?.code).toBe('SOMETHING_NEW');
    expect(result?.severity).toBe('error');
    expect(result?.explanationKey).toBe('forge.error.unknown.explanation');
    expect(result?.vars?.detail).toContain('details about the new error');
  });

  it('returns null when message has no recognizable format', () => {
    expect(translateForgeError('not a salesforce error')).toBeNull();
  });
});
