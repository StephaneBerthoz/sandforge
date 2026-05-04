import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  FIELD_ALLOWLIST,
  NOISE_FIELDS,
  canonicalizeField,
  canonicalizePermissionSet,
  stripNoiseFields,
} from './drift-canonical';

describe('drift-canonical', () => {
  describe('canonicalizeField', () => {
    it('strips noise fields and non-allowlisted keys', () => {
      const raw = {
        type: 'Email',
        length: 80,
        lastModifiedDate: '2026-05-02T10:00:00Z',
        lastModifiedById: '005000000000001',
        systemModstamp: '2026-05-02T10:00:00Z',
        compoundFieldName: 'Foo',
        digits: 0,
      };
      const out = canonicalizeField(raw);
      expect(out).toEqual({ type: 'Email', length: 80 });
      // None of the noise keys leaked through.
      for (const noise of NOISE_FIELDS) {
        expect(out).not.toHaveProperty(noise);
      }
      expect(out).not.toHaveProperty('compoundFieldName');
      expect(out).not.toHaveProperty('digits');
    });

    it('sorts picklistValues by `value` deterministically', () => {
      const raw = {
        type: 'Picklist',
        picklistValues: [
          { value: 'Z', label: 'Z' },
          { value: 'A', label: 'A' },
          { value: 'M', label: 'M' },
        ],
      };
      const out = canonicalizeField(raw);
      expect(out?.picklistValues).toEqual([
        { value: 'A', label: 'A' },
        { value: 'M', label: 'M' },
        { value: 'Z', label: 'Z' },
      ]);
    });

    it('returns `null` and `undefined` verbatim', () => {
      expect(canonicalizeField(null)).toBe(null);
      expect(canonicalizeField(undefined)).toBe(undefined);
    });

    it('returns an empty object when raw has no allowlist keys', () => {
      const raw = { junk: 1, lastModifiedDate: 'x' };
      const out = canonicalizeField(raw);
      expect(out).toEqual({});
    });
  });

  describe('canonicalizePermissionSet', () => {
    it('sorts fieldPermissions by field name', () => {
      const raw = {
        fieldPermissions: [
          { field: 'Account.Phone__c', read: true, edit: false },
          { field: 'Account.Email__c', read: true, edit: true },
          { field: 'Account.Region__c', read: false, edit: false },
        ],
      };
      const out = canonicalizePermissionSet(raw);
      expect(out?.fieldPermissions?.map((p) => p.field)).toEqual([
        'Account.Email__c',
        'Account.Phone__c',
        'Account.Region__c',
      ]);
    });

    it('sorts objectPermissions by object name', () => {
      const raw = {
        objectPermissions: [
          { object: 'Opportunity', read: true },
          { object: 'Account', read: true },
          { object: 'Contact', read: false },
        ],
      };
      const out = canonicalizePermissionSet(raw);
      expect(out?.objectPermissions?.map((p) => p.object)).toEqual([
        'Account',
        'Contact',
        'Opportunity',
      ]);
    });

    it('returns `null` and `undefined` verbatim', () => {
      expect(canonicalizePermissionSet(null)).toBe(null);
      expect(canonicalizePermissionSet(undefined)).toBe(undefined);
    });
  });

  describe('stripNoiseFields', () => {
    it('removes every key listed in NOISE_FIELDS', () => {
      const raw = {
        name: 'X',
        lastModifiedDate: 'a',
        lastModifiedById: 'b',
        systemModstamp: 'c',
        urls: { x: 1 },
        attributes: { y: 2 },
        keep: 42,
      };
      const out = stripNoiseFields(raw);
      expect(out).toEqual({ name: 'X', keep: 42 });
    });

    it('leaves a clean record untouched', () => {
      const raw = { name: 'X', value: 1 };
      expect(stripNoiseFields(raw)).toEqual(raw);
    });
  });

  describe('FIELD_ALLOWLIST', () => {
    it('exposes the documented per-type allowlists', () => {
      expect(FIELD_ALLOWLIST.CustomField).toContain('type');
      expect(FIELD_ALLOWLIST.CustomField).toContain('picklistValues');
      expect(FIELD_ALLOWLIST.PermissionSet).toContain('fieldPermissions');
      expect(FIELD_ALLOWLIST.Profile).toContain('objectPermissions');
    });
  });

  describe('property: canonicalizeField is idempotent', () => {
    it('canonicalizeField(canonicalizeField(x)) deep-equals canonicalizeField(x)', () => {
      // Build a record arbitrary that may contain allowlist + noise keys.
      const allowlistKey = fc.constantFrom(
        ...FIELD_ALLOWLIST.CustomField,
      );
      const noiseKey = fc.constantFrom(
        'lastModifiedDate',
        'lastModifiedById',
        'systemModstamp',
        'urls',
        'attributes',
      );
      const junkKey = fc.string({ minLength: 1, maxLength: 12 });
      const valueArb = fc.oneof(
        fc.string({ maxLength: 20 }),
        fc.integer({ min: 0, max: 1000 }),
        fc.boolean(),
        fc
          .array(fc.record({ value: fc.string({ maxLength: 5 }) }), { maxLength: 5 })
          .map((arr) => arr as unknown),
      );
      const recordArb = fc.dictionary(
        fc.oneof(allowlistKey, noiseKey, junkKey),
        valueArb,
        { maxKeys: 12 },
      );

      fc.assert(
        fc.property(recordArb, (raw) => {
          const once = canonicalizeField(raw as Record<string, unknown>);
          const twice = canonicalizeField(once as Record<string, unknown>);
          expect(twice).toEqual(once);
        }),
        { numRuns: 100 },
      );
    });
  });
});
