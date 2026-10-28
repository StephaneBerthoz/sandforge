import { describe, expect, it } from 'vitest';
import {
  ambiguousRecordTypeReason,
  findRecordTypeByName,
  findRecordTypeByParts,
  parseNamespacedRecordTypes,
  partsOfRecordTypeName,
  partsOfRow,
  qualifiedRecordTypeName,
  recordTypeMatchKey,
  recordTypeNameOf,
  type NamespacedRecordType,
} from './recordTypeNames.js';

const ORG_OWN: NamespacedRecordType = {
  id: '012000000000001AAA',
  developerName: 'Retail',
  namespacePrefix: null,
  sobjectType: 'Account',
};
const PACKAGED: NamespacedRecordType = {
  id: '012000000000002AAA',
  developerName: 'Retail',
  namespacePrefix: 'ns',
  sobjectType: 'Account',
};

describe('record type names', () => {
  it('names a package’s record type with its namespace and the org’s own by its DeveloperName', () => {
    expect(qualifiedRecordTypeName('ns', 'Retail')).toBe('ns__Retail');
    expect(qualifiedRecordTypeName(null, 'Retail')).toBe('Retail');
    expect(qualifiedRecordTypeName(undefined, 'Retail')).toBe('Retail');
    expect(recordTypeNameOf(PACKAGED)).toBe('ns__Retail');
    expect(recordTypeNameOf(ORG_OWN)).toBe('Retail');
  });

  it('keys a package’s record type apart from the org’s own of the same object and DeveloperName', () => {
    expect(recordTypeMatchKey(PACKAGED)).not.toBe(recordTypeMatchKey(ORG_OWN));
    // A row read without its namespace keys as the org's own.
    expect(recordTypeMatchKey({ id: 'x', developerName: 'Retail', sobjectType: 'Account' })).toBe(
      recordTypeMatchKey(ORG_OWN),
    );
  });

  it('reads the namespace off a name at its first double underscore, and says nothing of a bare one', () => {
    expect(partsOfRecordTypeName('ns__Retail')).toEqual({
      namespacePrefix: 'ns',
      developerName: 'Retail',
    });
    expect(partsOfRecordTypeName('Retail')).toEqual({
      namespacePrefix: undefined,
      developerName: 'Retail',
    });
    // No namespace before it, or nothing after it: no namespace at all.
    expect(partsOfRecordTypeName('__Retail').namespacePrefix).toBeUndefined();
    expect(partsOfRecordTypeName('Retail__').namespacePrefix).toBeUndefined();
  });

  describe('findRecordTypeByName', () => {
    const both = [ORG_OWN, PACKAGED];

    it('finds a package’s record type by its namespaced name, and never the org’s own', () => {
      expect(findRecordTypeByName('ns__Retail', both, partsOfRow)).toEqual({ found: PACKAGED });
      expect(findRecordTypeByName('ns__Retail', [ORG_OWN], partsOfRow)).toEqual({ none: true });
    });

    it('finds by a bare name the one record type that carries it, packaged or not', () => {
      expect(findRecordTypeByName('Retail', [PACKAGED], partsOfRow)).toEqual({ found: PACKAGED });
      expect(findRecordTypeByName('Retail', [ORG_OWN], partsOfRow)).toEqual({ found: ORG_OWN });
    });

    it('takes a bare name a package’s and the org’s own both carry for the org’s own', () => {
      // Refused, the org's own record type had no name a decision could give it.
      expect(findRecordTypeByName('Retail', both, partsOfRow)).toEqual({ found: ORG_OWN });
    });

    it('takes a bare name two packages carry, and not the org, for neither', () => {
      const other = { ...PACKAGED, namespacePrefix: 'other' };
      expect(findRecordTypeByName('Retail', [PACKAGED, other], partsOfRow)).toEqual({
        ambiguous: [PACKAGED, other],
      });
    });

    it('finds by parts the very namespace asked, the org’s own for null', () => {
      const own = { namespacePrefix: null, developerName: 'Retail' };
      expect(findRecordTypeByParts(own, both, partsOfRow)).toEqual({ found: ORG_OWN });
      expect(findRecordTypeByParts(own, [PACKAGED], partsOfRow)).toEqual({ none: true });
    });
  });

  it('names both record types a bare name could be, each with whose it is', () => {
    expect(
      ambiguousRecordTypeReason('Account', 'Retail', 'the source', [
        partsOfRow(ORG_OWN),
        partsOfRow(PACKAGED),
      ]),
    ).toBe(
      "Retail names 2 Account record types in the source: Retail, the org's own and " +
        'ns__Retail, of package ns',
    );
  });

  it('reads the rows of the names query, an empty namespace as none, and leaves out a row of the wrong shape', () => {
    expect(
      parseNamespacedRecordTypes([
        { Id: ORG_OWN.id, DeveloperName: 'Retail', NamespacePrefix: '', SobjectType: 'Account' },
        { Id: PACKAGED.id, DeveloperName: 'Retail', NamespacePrefix: 'ns', SobjectType: 'Account' },
        { Id: 'short', DeveloperName: 'Retail' },
        { Id: '012000000000003AAA' },
      ]),
    ).toEqual([ORG_OWN, PACKAGED]);
    expect(parseNamespacedRecordTypes('not rows')).toEqual([]);
  });
});
