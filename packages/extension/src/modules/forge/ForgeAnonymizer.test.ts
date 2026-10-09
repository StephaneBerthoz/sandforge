import { describe, it, expect } from 'vitest';
import { ForgeAnonymizer, runAnonymization } from './ForgeAnonymizer.js';
import type { PIIFieldInfo } from './ForgeAnonymizer.js';
import type { ForgeAnonymizationCategory, ForgeGraph, ForgeGraphNode } from '@sandforge/shared';

describe('ForgeAnonymizer', () => {
  const anonymizer = new ForgeAnonymizer();

  describe('categorizeField', () => {
    it('should categorize email type fields', () => {
      expect(anonymizer.categorizeField('Email', 'email')).toBe('email');
    });

    it('should categorize email by field name', () => {
      expect(anonymizer.categorizeField('PersonEmail', 'string')).toBe('email');
    });

    it('should categorize phone type fields', () => {
      expect(anonymizer.categorizeField('Phone', 'phone')).toBe('phone');
    });

    it('should categorize phone by field name patterns', () => {
      expect(anonymizer.categorizeField('MobilePhone', 'string')).toBe('phone');
      expect(anonymizer.categorizeField('Fax', 'string')).toBe('phone');
    });

    it('puts a text its API name gives to a phone number or an address in that category', () => {
      expect(anonymizer.categorizeField('SMS_Number__c', 'string')).toBe('phone');
      expect(anonymizer.categorizeField('Tel_Portable__c', 'string')).toBe('phone');
      expect(anonymizer.categorizeField('Courriel__c', 'string')).toBe('email');
    });

    it('should categorize name fields', () => {
      expect(anonymizer.categorizeField('FirstName', 'string')).toBe('name');
      expect(anonymizer.categorizeField('LastName', 'string')).toBe('name');
      expect(anonymizer.categorizeField('Name', 'string')).toBe('name');
    });

    it('puts every field the detector calls a name in the name category', () => {
      expect(anonymizer.categorizeField('MiddleName', 'string')).toBe('name');
      expect(anonymizer.categorizeField('Last_Name__c', 'string')).toBe('name');
      expect(anonymizer.categorizeField('SuppliedName', 'string')).toBe('name');
    });

    it('should categorize address fields', () => {
      expect(anonymizer.categorizeField('MailingStreet', 'string')).toBe('address');
      expect(anonymizer.categorizeField('BillingCity', 'string')).toBe('address');
      expect(anonymizer.categorizeField('ShippingPostalCode', 'string')).toBe('address');
      expect(anonymizer.categorizeField('Country', 'string')).toBe('address');
      expect(anonymizer.categorizeField('MailingState', 'string')).toBe('address');
      expect(anonymizer.categorizeField('BillingAddress', 'string')).toBe('address');
      expect(anonymizer.categorizeField('ZipCode__c', 'string')).toBe('address');
    });

    it('should categorize SSN/ID fields', () => {
      expect(anonymizer.categorizeField('SSN__c', 'string')).toBe('ssn_id');
      expect(anonymizer.categorizeField('National_Id__c', 'string')).toBe('ssn_id');
      expect(anonymizer.categorizeField('Passport_Number__c', 'string')).toBe('ssn_id');
      expect(anonymizer.categorizeField('DriverLicense__c', 'string')).toBe('ssn_id');
    });

    it('should categorize financial fields', () => {
      expect(anonymizer.categorizeField('CreditCardNumber__c', 'string')).toBe('financial');
      expect(anonymizer.categorizeField('CVV__c', 'string')).toBe('financial');
      expect(anonymizer.categorizeField('IBAN__c', 'string')).toBe('financial');
      expect(anonymizer.categorizeField('RoutingNumber__c', 'string')).toBe('financial');
      expect(anonymizer.categorizeField('BankAccount__c', 'string')).toBe('financial');
    });

    it('should categorize unknown fields as other', () => {
      expect(anonymizer.categorizeField('Amount', 'currency')).toBe('other');
      expect(anonymizer.categorizeField('Description', 'textarea')).toBe('other');
      expect(anonymizer.categorizeField('Custom__c', 'string')).toBe('other');
    });
  });

  describe('getDefaultMethod', () => {
    it('should return fake for email', () => {
      expect(anonymizer.getDefaultMethod('email')).toBe('fake');
    });

    it('should return mask for phone', () => {
      expect(anonymizer.getDefaultMethod('phone')).toBe('mask');
    });

    it('should return fake for name', () => {
      expect(anonymizer.getDefaultMethod('name')).toBe('fake');
    });

    it('should return fake for address', () => {
      expect(anonymizer.getDefaultMethod('address')).toBe('fake');
    });

    it('should return redact for ssn_id', () => {
      expect(anonymizer.getDefaultMethod('ssn_id')).toBe('redact');
    });

    it('should return hash for financial', () => {
      expect(anonymizer.getDefaultMethod('financial')).toBe('hash');
    });

    it('should return nullify for other', () => {
      expect(anonymizer.getDefaultMethod('other')).toBe('nullify');
    });
  });

  describe('getDefaults', () => {
    it('should return a complete map of all categories', () => {
      const defaults = anonymizer.getDefaults();
      const categories: ForgeAnonymizationCategory[] = [
        'email',
        'phone',
        'name',
        'address',
        'ssn_id',
        'financial',
        'other',
      ];
      for (const cat of categories) {
        expect(defaults[cat]).toBeDefined();
      }
    });

    it('should match individual getDefaultMethod results', () => {
      const defaults = anonymizer.getDefaults();
      const categories: ForgeAnonymizationCategory[] = [
        'email',
        'phone',
        'name',
        'address',
        'ssn_id',
        'financial',
        'other',
      ];
      for (const cat of categories) {
        expect(defaults[cat]).toBe(anonymizer.getDefaultMethod(cat));
      }
    });
  });

  describe('anonymizeRecords', () => {
    it('should anonymize PII fields while keeping non-PII unchanged', () => {
      const records = [{ Id: '001A', Email: 'john@test.com', Name: 'Acme Corp', Amount: 500 }];
      const piiFields: PIIFieldInfo[] = [{ name: 'Email', type: 'email' }];
      const categoryRules = anonymizer.getDefaults();

      const result = anonymizer.anonymizeRecords(records, piiFields, categoryRules, 'Account');

      // Email should be anonymized (fake method)
      expect(result[0]['Email']).not.toBe('john@test.com');
      // Non-PII fields should be unchanged
      expect(result[0]['Name']).toBe('Acme Corp');
      expect(result[0]['Amount']).toBe(500);
    });

    it('should not mutate original records', () => {
      const records = [{ Id: '001B', Email: 'jane@test.com' }];
      const piiFields: PIIFieldInfo[] = [{ name: 'Email', type: 'email' }];
      const categoryRules = anonymizer.getDefaults();

      anonymizer.anonymizeRecords(records, piiFields, categoryRules, 'Contact');

      expect(records[0]['Email']).toBe('jane@test.com');
    });

    it('should apply different methods based on category', () => {
      const records = [
        { Id: '001C', Email: 'test@example.com', SSN__c: '123-45-6789', Notes: 'Some text' },
      ];
      const piiFields: PIIFieldInfo[] = [
        { name: 'Email', type: 'email' },
        { name: 'SSN__c', type: 'string' },
        { name: 'Notes', type: 'string' },
      ];
      const categoryRules = anonymizer.getDefaults();

      const result = anonymizer.anonymizeRecords(records, piiFields, categoryRules, 'Contact');

      // Email -> fake (should be different from original)
      expect(result[0]['Email']).not.toBe('test@example.com');
      // SSN -> redact
      expect(result[0]['SSN__c']).toBe('[REDACTED]');
      // Notes -> other -> nullify
      expect(result[0]['Notes']).toBeNull();
    });

    it('should handle empty records array', () => {
      const piiFields: PIIFieldInfo[] = [{ name: 'Email', type: 'email' }];
      const categoryRules = anonymizer.getDefaults();

      const result = anonymizer.anonymizeRecords([], piiFields, categoryRules, 'Account');
      expect(result).toEqual([]);
    });

    it('should handle empty piiFields array', () => {
      const records = [{ Id: '001D', Name: 'Test' }];
      const categoryRules = anonymizer.getDefaults();

      const result = anonymizer.anonymizeRecords(records, [], categoryRules, 'Account');
      expect(result[0]['Name']).toBe('Test');
    });

    it('should handle multiple records', () => {
      const records = [
        { Id: '001E', Phone: '555-1234' },
        { Id: '001F', Phone: '555-5678' },
      ];
      const piiFields: PIIFieldInfo[] = [{ name: 'Phone', type: 'phone' }];
      const categoryRules = anonymizer.getDefaults();

      const result = anonymizer.anonymizeRecords(records, piiFields, categoryRules, 'Contact');

      // Phone -> mask (last 4 visible)
      expect(result[0]['Phone']).not.toBe('555-1234');
      expect(result[1]['Phone']).not.toBe('555-5678');
      expect(result).toHaveLength(2);
    });
  });

  describe('anonymize', () => {
    it('anonymizes each field with the method of its category, the default where none is given', () => {
      const [row] = anonymizer.anonymize({
        objectApiName: 'Contact',
        records: [{ Email: 'one@source.test', Phone: '0102030405', LastName: 'Source' }],
        sourceIds: ['003000000000001'],
        fields: [
          { name: 'Email', type: 'email' },
          { name: 'Phone', type: 'phone' },
        ],
        methods: { email: 'redact' },
      });

      // Redacted, and still an address the email field takes, delivered nowhere.
      expect(row['Email']).toBe('REDACTED@example.invalid');
      // No method given for phones: their default, a mask, which kept the last
      // four digits of the real number; a fictional one instead.
      expect(String(row['Phone'])).toMatch(/^\+3363998\d{4}$/);
      expect(String(row['Phone'])).not.toContain('0405');
      expect(row['LastName']).toBe('Source');
    });

    it('writes a persona’s address under example.invalid, and keeps another domain under .invalid', () => {
      const [persona] = anonymizer.anonymize({
        objectApiName: 'Contact',
        records: [{ Email: 'one@source.test' }],
        sourceIds: ['003000000000001'],
        fields: [{ name: 'Email', type: 'email' }],
        methods: { email: 'fake' },
      });
      const [generalized] = anonymizer.anonymize({
        objectApiName: 'Contact',
        records: [{ Email: 'one@source.test' }],
        sourceIds: ['003000000000001'],
        fields: [{ name: 'Email', type: 'email' }],
        methods: { email: 'generalize' },
      });

      expect(String(persona['Email'])).toMatch(/^[a-z]+\.[a-z]+\.[0-9a-f]{4}@example\.invalid$/);
      expect(generalized['Email']).toBe('***@source.test.invalid');
    });

    it('puts every address a method left in a text field of the category under .invalid', () => {
      const [generalized] = anonymizer.anonymize({
        objectApiName: 'Contact',
        records: [{ Backup_Email__c: 'Ops <ops@source.test>' }],
        sourceIds: ['003000000000001'],
        fields: [{ name: 'Backup_Email__c', type: 'string', length: 255 }],
        methods: { email: 'generalize' },
      });
      const [faked] = anonymizer.anonymize({
        objectApiName: 'Contact',
        records: [{ Backup_Email__c: 'ops@source.test' }],
        sourceIds: ['003000000000001'],
        fields: [{ name: 'Backup_Email__c', type: 'string', length: 255 }],
        methods: { email: 'fake' },
      });

      // `generalize` keeps what follows the `@`: the domain, delivered nowhere now.
      expect(generalized['Backup_Email__c']).toBe('***@source.test.invalid>');
      // A token is no address: left as the method wrote it.
      expect(String(faked['Backup_Email__c'])).toMatch(/^fake_[0-9a-f]{8}$/);
    });

    it('writes a fictional number for every method that leaves one, the same for the same number', () => {
      for (const method of ['fake', 'mask', 'preserve_format', 'shuffle'] as const) {
        const anonymizerOfRun = new ForgeAnonymizer(undefined, 'run key');
        const rows = anonymizerOfRun.anonymize({
          objectApiName: 'Contact',
          records: [
            { Phone: '06 12 34 56 78', MobilePhone: '0612345678' },
            { Phone: '', MobilePhone: null },
          ],
          sourceIds: ['003000000000001', '003000000000002'],
          fields: [
            { name: 'Phone', type: 'phone' },
            { name: 'MobilePhone', type: 'phone' },
          ],
          methods: { phone: method },
        });

        expect(String(rows[0]['Phone'])).toMatch(/^\+3363998\d{4}$/);
        expect(rows[0]['MobilePhone']).toBe(rows[0]['Phone']);
        // Nothing held, nothing written: `fake` gave an empty field a number.
        expect(rows[1]).toEqual({ Phone: '', MobilePhone: null });
      }
    });

    it('fits the fictional number to a short text field, and leaves a method that writes no number to it', () => {
      const [national] = anonymizer.anonymize({
        objectApiName: 'Contact',
        records: [{ SMS_Number__c: '0612345678' }],
        sourceIds: ['003000000000001'],
        fields: [{ name: 'SMS_Number__c', type: 'string', length: 10 }],
        methods: {},
      });
      const [hashed] = anonymizer.anonymize({
        objectApiName: 'Contact',
        records: [{ Phone: '0612345678' }],
        sourceIds: ['003000000000001'],
        fields: [{ name: 'Phone', type: 'phone' }],
        methods: { phone: 'hash' },
      });

      expect(String(national['SMS_Number__c'])).toMatch(/^063998\d{4}$/);
      expect(String(hashed['Phone'])).toMatch(/^[0-9a-f]{32}$/);
    });

    it('writes an address into every email field, whatever the method made of it', () => {
      const rows = anonymizer.anonymize({
        objectApiName: 'Account',
        records: [
          { PersonEmail: 'one@source.test', Backup_Email__c: 'b@source.test', Other__c: 'x' },
        ],
        sourceIds: ['001000000000001'],
        fields: [
          { name: 'PersonEmail', type: 'email' },
          { name: 'Backup_Email__c', type: 'email' },
        ],
        methods: { email: 'hash' },
      });

      // A hash alone is refused by the email field; kept as the local part, it is not.
      for (const field of ['PersonEmail', 'Backup_Email__c']) {
        expect(String(rows[0][field])).toMatch(/^[0-9a-f]{32}@example\.invalid$/);
      }
      expect(rows[0]['Other__c']).toBe('x');

      const [redacted] = anonymizer.anonymize({
        objectApiName: 'Account',
        records: [{ PersonEmail: 'one@source.test' }],
        sourceIds: ['001000000000001'],
        fields: [{ name: 'PersonEmail', type: 'email' }],
        methods: { email: 'fake' },
      });
      // `fake` knows Email's persona address, not PersonEmail's.
      expect(String(redacted['PersonEmail'])).toMatch(/^fake_[0-9a-f]{8}@example\.invalid$/);
    });

    it('leaves an email field empty when the method empties it', () => {
      const [row] = anonymizer.anonymize({
        objectApiName: 'Contact',
        records: [{ Email: 'one@source.test' }],
        sourceIds: ['003000000000001'],
        fields: [{ name: 'Email', type: 'email' }],
        methods: { email: 'nullify' },
      });

      expect(row['Email']).toBeNull();
    });

    it('keys each row to its source record, and gives it no Id it did not have', () => {
      const records = [{ FirstName: 'Ann' }, { FirstName: 'Bob' }];
      const request = {
        objectApiName: 'Contact',
        records,
        sourceIds: ['003000000000001', '003000000000002'],
        fields: [{ name: 'FirstName', type: 'string' }],
        methods: {},
      };

      const first = anonymizer.anonymize(request);
      const again = anonymizer.anonymize(request);

      // The same record draws the same persona, whichever call it comes in.
      expect(again).toEqual(first);
      expect(first.every((row) => !('Id' in row))).toBe(true);
      expect(records).toEqual([{ FirstName: 'Ann' }, { FirstName: 'Bob' }]);
    });
  });

  describe('runAnonymization', () => {
    const node = (objectApiName: string, overrides: Partial<ForgeGraphNode>): ForgeGraphNode => ({
      objectApiName,
      recordCount: 1,
      fieldCount: 3,
      status: 'idle',
      progress: 0,
      included: true,
      piiFields: [],
      anonymizeFields: [],
      level: 0,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 2,
      estimatedSizeMB: 0,
      estimatedApiCalls: 1,
      batchStrategy: 'auto',
      ...overrides,
    });
    const graph: ForgeGraph = {
      nodes: [
        node('Contact', { piiFields: ['Email', 'Phone'], anonymizeFields: ['Email'] }),
        node('Lead', { anonymizeFields: ['Email'], included: false }),
        node('Account', {}),
      ],
      edges: [],
      totalRecords: 3,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    };

    it('takes the fields selected on each node, copied or not, and the methods sent', () => {
      // A node left out of the copy can still have a required parent fetched.
      // A node with nothing selected says so: the user deselected its fields.
      expect(runAnonymization(true, graph, { email: 'hash' })).toEqual({
        fields: { Contact: ['Email'], Lead: ['Email'], Account: [] },
        methods: { email: 'hash' },
      });
    });

    it('anonymizes nothing with the toggle off, whatever the nodes select', () => {
      expect(runAnonymization(false, graph, { email: 'hash' })).toBeUndefined();
    });

    it('leaves a node never described to what the detector names at the write', () => {
      // A starter template's graph: no field of any object is known yet.
      const personalFieldsOf = (fields: Array<{ name: string; type: string }>): string[] =>
        fields.filter((f) => f.type === 'email').map((f) => f.name);
      const starter: ForgeGraph = {
        ...graph,
        nodes: [node('Contact', { fieldCount: 0 }), node('Account', {})],
      };

      const run = runAnonymization(true, starter, {}, personalFieldsOf);

      expect(run?.fields).toEqual({ Account: [] });
      expect(run?.personalFieldsOf).toBe(personalFieldsOf);
    });
  });
});
