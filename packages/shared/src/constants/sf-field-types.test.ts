import { describe, it, expect } from 'vitest';

import {
  SF_FIELD_TYPES,
  SF_AUTO_FIELDS,
  SF_EXTERNAL_ID_COMPATIBLE_TYPES,
  SF_FIELD_MAX_LENGTHS,
} from './sf-field-types.js';
import type { SfFieldType } from './sf-field-types.js';

describe('SF_FIELD_TYPES', () => {
  it('should be a non-empty array', () => {
    expect(SF_FIELD_TYPES.length).toBeGreaterThan(0);
  });

  it('should contain core field types', () => {
    const coreTypes: SfFieldType[] = [
      'id',
      'string',
      'boolean',
      'int',
      'double',
      'date',
      'datetime',
      'reference',
    ];

    for (const fieldType of coreTypes) {
      expect(SF_FIELD_TYPES).toContain(fieldType);
    }
  });

  it('should contain no duplicate entries', () => {
    const unique = new Set(SF_FIELD_TYPES);
    expect(unique.size).toBe(SF_FIELD_TYPES.length);
  });
});

describe('SF_AUTO_FIELDS', () => {
  it('should be a non-empty array', () => {
    expect(SF_AUTO_FIELDS.length).toBeGreaterThan(0);
  });

  it('should contain Id field', () => {
    expect(SF_AUTO_FIELDS).toContain('Id');
  });

  it('should contain audit fields', () => {
    expect(SF_AUTO_FIELDS).toContain('CreatedDate');
    expect(SF_AUTO_FIELDS).toContain('CreatedById');
    expect(SF_AUTO_FIELDS).toContain('LastModifiedDate');
    expect(SF_AUTO_FIELDS).toContain('LastModifiedById');
  });

  it('should contain system fields', () => {
    expect(SF_AUTO_FIELDS).toContain('SystemModstamp');
    expect(SF_AUTO_FIELDS).toContain('IsDeleted');
  });

  it('should contain no duplicate entries', () => {
    const unique = new Set(SF_AUTO_FIELDS);
    expect(unique.size).toBe(SF_AUTO_FIELDS.length);
  });
});

describe('SF_EXTERNAL_ID_COMPATIBLE_TYPES', () => {
  it('should be a non-empty array', () => {
    expect(SF_EXTERNAL_ID_COMPATIBLE_TYPES.length).toBeGreaterThan(0);
  });

  it('should be a subset of SF_FIELD_TYPES', () => {
    for (const fieldType of SF_EXTERNAL_ID_COMPATIBLE_TYPES) {
      expect(
        SF_FIELD_TYPES as readonly string[],
        `${fieldType} should be in SF_FIELD_TYPES`,
      ).toContain(fieldType);
    }
  });

  it('should contain string and email types', () => {
    expect(SF_EXTERNAL_ID_COMPATIBLE_TYPES).toContain('string');
    expect(SF_EXTERNAL_ID_COMPATIBLE_TYPES).toContain('email');
  });
});

describe('SF_FIELD_MAX_LENGTHS', () => {
  it('should have all keys as valid SfFieldType values', () => {
    for (const key of Object.keys(SF_FIELD_MAX_LENGTHS)) {
      expect(SF_FIELD_TYPES as readonly string[], `${key} should be a valid SfFieldType`).toContain(
        key,
      );
    }
  });

  it('should have all values as positive numbers', () => {
    for (const [key, value] of Object.entries(SF_FIELD_MAX_LENGTHS)) {
      expect(typeof value, `${key} max length should be a number`).toBe('number');
      expect(value, `${key} max length should be positive`).toBeGreaterThan(0);
    }
  });
});
