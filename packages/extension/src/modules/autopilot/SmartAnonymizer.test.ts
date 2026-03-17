import { describe, it, expect, beforeEach } from 'vitest';

import type { AutopilotAnonymizationRule, ApiName } from '@sandforge/shared';

/** Local alias matching the autopilot domain name. */
type AnonymizationRule = AutopilotAnonymizationRule;

import { PersonaRegistry, SmartAnonymizer } from './SmartAnonymizer.js';

/** Helper to create an anonymization rule fixture. */
function makeRule(
  overrides: Partial<AnonymizationRule> = {},
): AnonymizationRule {
  return {
    objectApiName: 'Contact' as ApiName,
    fieldApiName: 'Email',
    method: 'fake',
    piiCategory: 'PII',
    aiConfidence: 0.95,
    userOverridden: false,
    ...overrides,
  };
}

describe('PersonaRegistry', () => {
  let registry: PersonaRegistry;

  beforeEach(() => {
    registry = new PersonaRegistry();
  });

  it('returns the same persona for the same ID', () => {
    const persona1 = registry.getPersona('003xx000001');
    const persona2 = registry.getPersona('003xx000001');
    expect(persona1).toStrictEqual(persona2);
  });

  it('returns different personas for different IDs', () => {
    const persona1 = registry.getPersona('003xx000001');
    const persona2 = registry.getPersona('003xx000002');
    expect(persona1.sourceRecordId).not.toBe(persona2.sourceRecordId);
    // Very unlikely all fields match for different IDs
    expect(
      persona1.firstName === persona2.firstName &&
      persona1.lastName === persona2.lastName &&
      persona1.email === persona2.email,
    ).toBe(false);
  });

  it('generates a valid email format', () => {
    const persona = registry.getPersona('003xx000001');
    expect(persona.email).toMatch(/^[a-z]+\.[a-z]+@example\.com$/);
  });

  it('tracks size correctly', () => {
    expect(registry.size).toBe(0);
    registry.getPersona('003xx000001');
    expect(registry.size).toBe(1);
    registry.getPersona('003xx000002');
    expect(registry.size).toBe(2);
    // Same ID does not increase count
    registry.getPersona('003xx000001');
    expect(registry.size).toBe(2);
  });

  it('clears all personas', () => {
    registry.getPersona('003xx000001');
    registry.getPersona('003xx000002');
    expect(registry.size).toBe(2);
    registry.clear();
    expect(registry.size).toBe(0);
  });
});

describe('SmartAnonymizer', () => {
  let anonymizer: SmartAnonymizer;
  let registry: PersonaRegistry;

  beforeEach(() => {
    registry = new PersonaRegistry();
    anonymizer = new SmartAnonymizer(registry);
  });

  describe('fake method', () => {
    it('uses persona for known fields (FirstName, Email, Phone)', () => {
      const records = [
        { Id: '003xx000001', FirstName: 'John', LastName: 'Doe', Email: 'john@real.com', Phone: '555-1234' },
      ];
      const rules = [
        makeRule({ fieldApiName: 'FirstName', method: 'fake' }),
        makeRule({ fieldApiName: 'LastName', method: 'fake' }),
        makeRule({ fieldApiName: 'Email', method: 'fake' }),
        makeRule({ fieldApiName: 'Phone', method: 'fake' }),
      ];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      const persona = registry.getPersona('003xx000001');

      expect(records[0].FirstName).toBe(persona.firstName);
      expect(records[0].LastName).toBe(persona.lastName);
      expect(records[0].Email).toBe(persona.email);
      expect(records[0].Phone).toBe(persona.phone);
    });

    it('uses persona for address fields', () => {
      const records = [
        { Id: '003xx000001', MailingStreet: '123 Real St', MailingCity: 'Realtown', MailingPostalCode: '12345' },
      ];
      const rules = [
        makeRule({ fieldApiName: 'MailingStreet', method: 'fake' }),
        makeRule({ fieldApiName: 'MailingCity', method: 'fake' }),
        makeRule({ fieldApiName: 'MailingPostalCode', method: 'fake' }),
      ];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      const persona = registry.getPersona('003xx000001');

      expect(records[0].MailingStreet).toBe(persona.address);
      expect(records[0].MailingCity).toBe(persona.city);
      expect(records[0].MailingPostalCode).toBe(persona.postalCode);
    });

    it('returns deterministic fallback for unmapped fields', () => {
      const records = [
        { Id: '003xx000001', CustomField__c: 'secret data' },
      ];
      const rules = [
        makeRule({ fieldApiName: 'CustomField__c', method: 'fake' }),
      ];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      expect(records[0].CustomField__c).toMatch(/^fake_[0-9a-f]+$/);
    });
  });

  describe('mask method', () => {
    it('masks all but last 4 characters', () => {
      const records = [{ Id: '001', Email: 'john@example.com' }];
      const rules = [makeRule({ fieldApiName: 'Email', method: 'mask' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      const result = records[0].Email;

      expect(result).toHaveLength('john@example.com'.length);
      expect(result.slice(-4)).toBe('.com');
      expect(result.slice(0, -4)).toBe('*'.repeat('john@example.com'.length - 4));
    });

    it('fully masks short values (<=4 chars)', () => {
      const records = [{ Id: '001', FirstName: 'Jo' }];
      const rules = [makeRule({ fieldApiName: 'FirstName', method: 'mask' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      expect(records[0].FirstName).toBe('**');
    });
  });

  describe('hash method', () => {
    it('returns a hex string', () => {
      const records = [{ Id: '001', Email: 'test@test.com' }];
      const rules = [makeRule({ fieldApiName: 'Email', method: 'hash' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      expect(records[0].Email).toMatch(/^[0-9a-f]{8,}$/);
    });

    it('produces same hash for same input', () => {
      const records1 = [{ Id: '001', Email: 'test@test.com' }];
      const records2 = [{ Id: '002', Email: 'test@test.com' }];
      const rules = [makeRule({ fieldApiName: 'Email', method: 'hash' })];

      anonymizer.anonymize(records1, rules, 'Contact' as ApiName);
      anonymizer.anonymize(records2, rules, 'Contact' as ApiName);
      expect(records1[0].Email).toBe(records2[0].Email);
    });
  });

  describe('nullify method', () => {
    it('returns null', () => {
      const records: Record<string, unknown>[] = [{ Id: '001', Email: 'test@test.com' }];
      const rules = [makeRule({ fieldApiName: 'Email', method: 'nullify' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      expect(records[0]['Email']).toBeNull();
    });
  });

  describe('redact method', () => {
    it('returns [REDACTED]', () => {
      const records: Record<string, unknown>[] = [{ Id: '001', Email: 'test@test.com' }];
      const rules = [makeRule({ fieldApiName: 'Email', method: 'redact' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      expect(records[0]['Email']).toBe('[REDACTED]');
    });
  });

  describe('shuffle method', () => {
    it('preserves the original length', () => {
      const original = 'Hello World 123';
      const records: Record<string, unknown>[] = [{ Id: '001', FirstName: original }];
      const rules = [makeRule({ fieldApiName: 'FirstName', method: 'shuffle' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      expect((records[0]['FirstName'] as string).length).toBe(original.length);
    });

    it('produces deterministic results for same input', () => {
      const records1: Record<string, unknown>[] = [{ Id: '001', FirstName: 'abcdef' }];
      const records2: Record<string, unknown>[] = [{ Id: '002', FirstName: 'abcdef' }];
      const rules = [makeRule({ fieldApiName: 'FirstName', method: 'shuffle' })];

      anonymizer.anonymize(records1, rules, 'Contact' as ApiName);
      anonymizer.anonymize(records2, rules, 'Contact' as ApiName);
      expect(records1[0]['FirstName']).toBe(records2[0]['FirstName']);
    });
  });

  describe('truncate method', () => {
    it('reduces to half length', () => {
      const records: Record<string, unknown>[] = [{ Id: '001', FirstName: 'Alexander' }];
      const rules = [makeRule({ fieldApiName: 'FirstName', method: 'truncate' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      // floor(9/2) = 4
      expect(records[0]['FirstName']).toBe('Alex');
    });

    it('keeps at least 1 character', () => {
      const records: Record<string, unknown>[] = [{ Id: '001', FirstName: 'A' }];
      const rules = [makeRule({ fieldApiName: 'FirstName', method: 'truncate' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      expect(records[0]['FirstName']).toBe('A');
    });
  });

  describe('preserve_format method', () => {
    it('preserves digit/letter/separator patterns', () => {
      const original = '(555) 123-4567';
      const records: Record<string, unknown>[] = [{ Id: '001', Phone: original }];
      const rules = [makeRule({ fieldApiName: 'Phone', method: 'preserve_format' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      const result = records[0]['Phone'] as string;

      expect(result).toHaveLength(original.length);
      // Check separators preserved at same positions
      expect(result[0]).toBe('(');
      expect(result[4]).toBe(')');
      expect(result[5]).toBe(' ');
      expect(result[9]).toBe('-');
      // Check digits replaced with digits
      expect(result[1]).toMatch(/[0-9]/);
      expect(result[2]).toMatch(/[0-9]/);
    });

    it('replaces uppercase with uppercase and lowercase with lowercase', () => {
      const original = 'Ab1';
      const records: Record<string, unknown>[] = [{ Id: '001', FirstName: original }];
      const rules = [makeRule({ fieldApiName: 'FirstName', method: 'preserve_format' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      const result = records[0]['FirstName'] as string;

      expect(result[0]).toMatch(/[A-Z]/);
      expect(result[1]).toMatch(/[a-z]/);
      expect(result[2]).toMatch(/[0-9]/);
    });
  });

  describe('age_band method', () => {
    it('returns decade range for a valid date', () => {
      const records: Record<string, unknown>[] = [{ Id: '001', Birthdate: '1985-06-15' }];
      const rules = [makeRule({ fieldApiName: 'Birthdate', method: 'age_band' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      expect(records[0]['Birthdate']).toBe('1980-1989');
    });

    it('returns Unknown for invalid date', () => {
      const records: Record<string, unknown>[] = [{ Id: '001', Birthdate: 'not-a-date' }];
      const rules = [makeRule({ fieldApiName: 'Birthdate', method: 'age_band' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      expect(records[0]['Birthdate']).toBe('Unknown');
    });

    it('handles year 2000 correctly', () => {
      const records: Record<string, unknown>[] = [{ Id: '001', Birthdate: '2003-01-01' }];
      const rules = [makeRule({ fieldApiName: 'Birthdate', method: 'age_band' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      expect(records[0]['Birthdate']).toBe('2000-2009');
    });
  });

  describe('generalize method', () => {
    it('keeps only domain for email values', () => {
      const records: Record<string, unknown>[] = [{ Id: '001', Email: 'john.doe@company.com' }];
      const rules = [makeRule({ fieldApiName: 'Email', method: 'generalize' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      expect(records[0]['Email']).toBe('***@company.com');
    });

    it('masks phone numbers keeping prefix', () => {
      const records: Record<string, unknown>[] = [{ Id: '001', Phone: '+1-555-123-4567' }];
      const rules = [makeRule({ fieldApiName: 'Phone', method: 'generalize' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      expect(records[0]['Phone']).toBe('+1--***');
    });

    it('reduces address to first word for street fields', () => {
      const records: Record<string, unknown>[] = [{ Id: '001', MailingStreet: '123 Main Street' }];
      const rules = [makeRule({ fieldApiName: 'MailingStreet', method: 'generalize' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      expect(records[0]['MailingStreet']).toBe('123');
    });

    it('truncates multi-word generic values', () => {
      const records: Record<string, unknown>[] = [{ Id: '001', Description: 'Some detailed description' }];
      const rules = [makeRule({ fieldApiName: 'Description', method: 'generalize' })];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);
      expect(records[0]['Description']).toBe('Some ...');
    });
  });

  describe('batch anonymization', () => {
    it('applies correct rules per object', () => {
      const records: Record<string, unknown>[] = [
        { Id: '001', Email: 'john@test.com', FirstName: 'John' },
        { Id: '002', Email: 'jane@test.com', FirstName: 'Jane' },
      ];
      const rules = [
        makeRule({ objectApiName: 'Contact' as ApiName, fieldApiName: 'Email', method: 'redact' }),
        makeRule({ objectApiName: 'Account' as ApiName, fieldApiName: 'Name', method: 'redact' }),
      ];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);

      expect(records[0]['Email']).toBe('[REDACTED]');
      expect(records[1]['Email']).toBe('[REDACTED]');
      // FirstName not targeted by any Contact rule
      expect(records[0]['FirstName']).toBe('John');
    });

    it('skips records with null/undefined values', () => {
      const records: Record<string, unknown>[] = [
        { Id: '001', Email: null, Phone: undefined, FirstName: 'John' },
      ];
      const rules = [
        makeRule({ fieldApiName: 'Email', method: 'redact' }),
        makeRule({ fieldApiName: 'Phone', method: 'redact' }),
        makeRule({ fieldApiName: 'FirstName', method: 'redact' }),
      ];

      anonymizer.anonymize(records, rules, 'Contact' as ApiName);

      expect(records[0]['Email']).toBeNull();
      expect(records[0]['Phone']).toBeUndefined();
      expect(records[0]['FirstName']).toBe('[REDACTED]');
    });

    it('returns records unchanged when no rules match the object', () => {
      const records: Record<string, unknown>[] = [
        { Id: '001', Email: 'john@test.com' },
      ];
      const rules = [
        makeRule({ objectApiName: 'Account' as ApiName, fieldApiName: 'Email', method: 'redact' }),
      ];

      const result = anonymizer.anonymize(records, rules, 'Contact' as ApiName);

      expect(result[0]['Email']).toBe('john@test.com');
    });

    it('returns records unchanged when rules array is empty', () => {
      const records: Record<string, unknown>[] = [
        { Id: '001', Email: 'john@test.com' },
      ];

      const result = anonymizer.anonymize(records, [], 'Contact' as ApiName);
      expect(result[0]['Email']).toBe('john@test.com');
    });
  });

  describe('constructor', () => {
    it('creates its own PersonaRegistry if none provided', () => {
      const anon = new SmartAnonymizer();
      expect(anon.getPersonaRegistry()).toBeInstanceOf(PersonaRegistry);
    });

    it('uses provided PersonaRegistry', () => {
      const reg = new PersonaRegistry();
      const anon = new SmartAnonymizer(reg);
      expect(anon.getPersonaRegistry()).toBe(reg);
    });
  });
});
