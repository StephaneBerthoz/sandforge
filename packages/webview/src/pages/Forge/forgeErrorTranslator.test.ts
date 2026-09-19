import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import en from '../../i18n/locales/en.json';
import fr from '../../i18n/locales/fr.json';
import de from '../../i18n/locales/de.json';
import es from '../../i18n/locales/es.json';
import ja from '../../i18n/locales/ja.json';
import ptBR from '../../i18n/locales/pt-BR.json';
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
    const result = translateForgeError(
      'REQUIRED_FIELD_MISSING: Required fields are missing: [NameInsuredId]',
    );
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

/*
 * ForgeResults renders `t(explanationKey)` and `t(actionKey)` with no default,
 * so a key missing from a locale shows up in the Errors panel as the raw
 * `forge.error.…` path instead of a hint.
 */
describe('forge.error hint keys', () => {
  const LOCALES: Record<string, unknown> = { en, fr, de, es, ja, 'pt-BR': ptBR };

  /** One raw Salesforce or executor message per translator branch. */
  const SAMPLES: readonly string[] = [
    'DUPLICATE_VALUE: duplicate value found: ExternalId__c',
    'INVALID_CROSS_REFERENCE_KEY: Owner ID: cannot be blank',
    'REQUIRED_FIELD_MISSING: Required fields are missing: [AccountId]',
    'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: X',
    'INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: Name',
    'FIELD_INTEGRITY_EXCEPTION: Every asset needs an account, a contact, or both.',
    'CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY: entity type cannot be inserted: Case History',
    'INSUFFICIENT_ACCESS_OR_READONLY: insufficient access rights on object id',
    'INSUFFICIENT_ACCESS: insufficient access rights',
    'STORAGE_LIMIT_EXCEEDED: storage limit exceeded',
    'INVALID_TYPE: sObject type is not supported',
    'NOT_FOUND: The requested resource does not exist',
    'STRING_TOO_LONG: Name: data value too large',
    'SOMETHING_NEW: details about the new error',
    "Cycle FK 'PrimaryContactId' could not be resolved — referenced parent (source 003ABC123) was not cloned",
    "Cycle FK 'ParentId' could not be resolved",
    'no parent in cache and not the root',
    'STANDARD_PRICE_NOT_DEFINED: Before creating a custom price, create a standard price.',
    "INVALID_CROSS_REFERENCE_KEY: Record Type ID: this ID value isn't valid for the user",
  ];

  /** Walk a dotted key through a locale object. */
  const lookup = (bundle: unknown, key: string): unknown =>
    key
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          node !== null && typeof node === 'object'
            ? (node as Record<string, unknown>)[part]
            : undefined,
        bundle,
      );

  /** The `{{name}}` placeholders a value interpolates, sorted. */
  const placeholders = (value: unknown): string[] =>
    typeof value === 'string' ? [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]) : [];

  const translated = SAMPLES.map((raw) => {
    const result = translateForgeError(raw);
    if (!result) throw new Error(`no translation for sample: ${raw}`);
    return result;
  });
  const keys = [...new Set(translated.flatMap((r) => [r.explanationKey, r.actionKey]))].sort();

  it('samples every key the translator can produce', () => {
    // Vitest runs from the package or from the repository root.
    const path = ['src/pages/Forge', 'packages/webview/src/pages/Forge']
      .map((dir) => resolve(process.cwd(), dir, 'forgeErrorTranslator.ts'))
      .find((candidate) => existsSync(candidate));
    if (!path) throw new Error('forgeErrorTranslator.ts not found from ' + process.cwd());
    const written = new Set(
      [
        ...readFileSync(path, 'utf8').matchAll(/'(forge\.error\.\w+\.(?:explanation|action))'/g),
      ].map((m) => m[1]),
    );
    expect(keys).toEqual([...written].sort());
  });

  for (const [locale, bundle] of Object.entries(LOCALES)) {
    it(`resolves every generated key to text in ${locale}`, () => {
      const missing = keys.filter((key) => {
        const value = lookup(bundle, key);
        return typeof value !== 'string' || value.trim() === '';
      });
      expect(missing).toEqual([]);
    });
  }

  it('interpolates, in every locale, exactly the variables the translator passes', () => {
    for (const result of translated) {
      const expected = Object.keys(result.vars ?? {}).sort();
      for (const [locale, bundle] of Object.entries(LOCALES)) {
        const used = [
          ...new Set([
            ...placeholders(lookup(bundle, result.explanationKey)),
            ...placeholders(lookup(bundle, result.actionKey)),
          ]),
        ].sort();
        expect({ locale, key: result.explanationKey, used }).toEqual({
          locale,
          key: result.explanationKey,
          used: expected,
        });
      }
    }
  });
});
