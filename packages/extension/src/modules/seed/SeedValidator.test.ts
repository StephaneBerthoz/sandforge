import { describe, it, expect, beforeEach } from 'vitest';
import { SeedValidator } from './SeedValidator';
import { PREBUILT_SEED_TEMPLATES } from '@sandforge/shared';
import type { SeedRelation, SeedTemplate } from '@sandforge/shared';

function createValidTemplate(overrides?: Partial<SeedTemplate>): SeedTemplate {
  return {
    id: 'tpl-1',
    name: 'Valid Template',
    description: 'A valid seed template',
    version: 1,
    strategy: 'faker',
    objects: [
      {
        objectApiName: 'Account',
        recordCount: 10,
        fieldRules: [{ fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'Test' } }],
        excludedFields: [],
        insertOrder: 0,
        batchSize: 200,
      },
    ],
    tags: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('SeedValidator', () => {
  let validator: SeedValidator;

  beforeEach(() => {
    validator = new SeedValidator();
  });

  describe('validate', () => {
    it('should pass for a valid template', () => {
      const result = validator.validate(createValidTemplate());
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should fail when template name is empty', () => {
      const template = createValidTemplate({ name: '' });
      const result = validator.validate(template);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('name'))).toBe(true);
    });

    it('should fail when template name is whitespace only', () => {
      const template = createValidTemplate({ name: '   ' });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
    });

    it('should fail when objects array is empty', () => {
      const template = createValidTemplate({ objects: [] });
      const result = validator.validate(template);

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('at least one object'))).toBe(true);
    });

    it('should fail when record count is zero or negative', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 0,
            fieldRules: [],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
        ],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('positive'))).toBe(true);
    });

    it('should warn when record count exceeds 100,000', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 150000,
            fieldRules: [],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
        ],
      });
      const result = validator.validate(template);
      expect(result.warnings.some((w) => w.message.includes('grappe'))).toBe(true);
    });

    it('should fail when batch size is zero', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 10,
            fieldRules: [],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 0,
          },
        ],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
    });

    it('should fail when reference target is missing from template', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: 'Contact',
            recordCount: 10,
            fieldRules: [
              {
                fieldApiName: 'AccountId',
                ruleType: 'reference',
                config: { referenceObject: 'Account' },
              },
            ],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
        ],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('not in the template'))).toBe(true);
    });

    it('should pass when reference target exists in template', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 10,
            // A rule, because an object with none writes nothing: this test is
            // about the reference resolving, not about an empty object.
            fieldRules: [
              { fieldApiName: 'Name', ruleType: 'faker', config: { fakerMethod: 'company.name' } },
            ],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
          {
            objectApiName: 'Contact',
            recordCount: 10,
            fieldRules: [
              {
                fieldApiName: 'AccountId',
                ruleType: 'reference',
                config: { referenceObject: 'Account' },
              },
            ],
            excludedFields: [],
            insertOrder: 1,
            batchSize: 200,
          },
        ],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(true);
    });

    it('should detect circular dependencies', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: 'A',
            recordCount: 10,
            fieldRules: [
              { fieldApiName: 'BId', ruleType: 'reference', config: { referenceObject: 'B' } },
            ],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
          {
            objectApiName: 'B',
            recordCount: 10,
            fieldRules: [
              { fieldApiName: 'AId', ruleType: 'reference', config: { referenceObject: 'A' } },
            ],
            excludedFields: [],
            insertOrder: 1,
            batchSize: 200,
          },
        ],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('Circular'))).toBe(true);
    });

    it('should fail when reference rule lacks referenceObject', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: 'Contact',
            recordCount: 10,
            fieldRules: [{ fieldApiName: 'AccountId', ruleType: 'reference', config: {} }],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
        ],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes('referenceObject'))).toBe(true);
    });

    it('should fail when picklist rule has no values', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 10,
            fieldRules: [{ fieldApiName: 'Status', ruleType: 'picklist_random', config: {} }],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
        ],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
    });

    it('should fail when faker rule has no fakerMethod', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 10,
            fieldRules: [{ fieldApiName: 'Email', ruleType: 'faker', config: {} }],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
        ],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
    });

    it('fails a faker method the generator does not implement, on any object of the template', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 10,
            fieldRules: [
              { fieldApiName: 'Name', ruleType: 'faker', config: { fakerMethod: 'company' } },
            ],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
          {
            objectApiName: 'Contact',
            recordCount: 10,
            fieldRules: [
              {
                fieldApiName: 'Pet__c',
                ruleType: 'faker',
                config: { fakerMethod: 'animal.petName' },
              },
            ],
            excludedFields: [],
            insertOrder: 1,
            batchSize: 200,
          },
        ],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
      expect(result.errors).toEqual([
        {
          field: 'objects[Contact].fieldRules[Pet__c].config.fakerMethod',
          message: expect.stringContaining('"animal.petName"'),
        },
      ]);
    });

    it('accepts the faker.js spelling of a method the generator implements', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 10,
            fieldRules: [
              {
                fieldApiName: 'IBAN__c',
                ruleType: 'faker',
                config: { fakerMethod: 'finance.iban' },
              },
            ],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
        ],
      });
      expect(validator.validate(template).errors).toEqual([]);
    });

    it.each(['double', 'currency', 'date', 'boolean', 'email', 'picklist'])(
      'fails an AI rule on a %s field, where a generated sentence is not a valid value',
      (fieldType) => {
        const template = createValidTemplate({
          objects: [
            {
              objectApiName: 'Opportunity',
              recordCount: 10,
              fieldRules: [
                {
                  fieldApiName: 'Amount__c',
                  fieldType,
                  ruleType: 'ai_generate',
                  config: { aiPrompt: 'Deal size' },
                },
              ],
              excludedFields: [],
              insertOrder: 0,
              batchSize: 200,
            },
          ],
        });
        const result = validator.validate(template);
        expect(result.valid).toBe(false);
        expect(result.errors).toEqual([
          {
            field: 'objects[Opportunity].fieldRules[Amount__c].ruleType',
            message: expect.stringContaining(`"${fieldType}"`),
          },
        ]);
      },
    );

    it('accepts an AI rule on a text field, and on a rule that does not name its field type', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: 'Case',
            recordCount: 10,
            fieldRules: [
              {
                fieldApiName: 'Description',
                fieldType: 'textarea',
                ruleType: 'ai_generate',
                config: { aiPrompt: 'Customer complaint' },
              },
              { fieldApiName: 'Subject', ruleType: 'ai_generate', config: { aiPrompt: 'Title' } },
            ],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
        ],
      });
      expect(validator.validate(template).errors).toEqual([]);
    });

    it.each(PREBUILT_SEED_TEMPLATES.map((t) => [t.id, t] as const))(
      'passes the prebuilt template %s',
      (_id, template) => {
        expect(validator.validate(template).errors).toEqual([]);
      },
    );

    it('should fail when regex rule has no pattern', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 10,
            fieldRules: [{ fieldApiName: 'Code', ruleType: 'regex', config: {} }],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
        ],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
    });

    it('should fail when from_csv rule has no csvColumn', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 10,
            fieldRules: [{ fieldApiName: 'Data', ruleType: 'from_csv', config: {} }],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
        ],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
    });

    it('should fail when object API name is empty', () => {
      const template = createValidTemplate({
        objects: [
          {
            objectApiName: '',
            recordCount: 10,
            fieldRules: [],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
        ],
      });
      const result = validator.validate(template);
      expect(result.valid).toBe(false);
    });
  });
});

describe('SeedValidator — an object that can only write nothing', () => {
  it('refuses an object that asks for records and names no field', () => {
    // FieldMapper answers an empty list for it, so the run reported
    // "success, 0 created" — asking a real org for five accounts wrote
    // nothing and said it had worked.
    const result = new SeedValidator().validate(
      createValidTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 5,
            fieldRules: [],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
        ],
      }),
    );

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field.endsWith('.fieldRules'))).toBe(true);
    expect(result.errors.find((e) => e.field.endsWith('.fieldRules'))?.message).toContain(
      'Account',
    );
  });

  it('says nothing about an object that asks for no records', () => {
    // A zero count is already refused on its own terms; naming no field for
    // it as well would be two complaints about one mistake.
    const result = new SeedValidator().validate(
      createValidTemplate({
        objects: [
          {
            objectApiName: 'Account',
            recordCount: 0,
            fieldRules: [],
            excludedFields: [],
            insertOrder: 0,
            batchSize: 200,
          },
        ],
      }),
    );

    expect(result.errors.some((e) => e.field.endsWith('.fieldRules'))).toBe(false);
  });
});

describe('SeedValidator — relations', () => {
  /** Accounts, then contacts whose only rule is a last name. */
  function accountsAndContacts(relations: SeedRelation[]): SeedTemplate {
    return createValidTemplate({
      objects: [
        {
          objectApiName: 'Account',
          recordCount: 5,
          fieldRules: [{ fieldApiName: 'Name', ruleType: 'static', config: { staticValue: 'A' } }],
          excludedFields: [],
          insertOrder: 0,
          batchSize: 200,
        },
        {
          objectApiName: 'Contact',
          recordCount: 15,
          fieldRules: [
            { fieldApiName: 'LastName', ruleType: 'static', config: { staticValue: 'Doe' } },
          ],
          excludedFields: [],
          insertOrder: 1,
          batchSize: 200,
        },
      ],
      relations,
    });
  }

  /** Three contacts for each account this run writes. */
  const contactsPerAccount: SeedRelation = {
    childObject: 'Contact',
    lookupField: 'AccountId',
    parentObject: 'Account',
    parents: { kind: 'generated' },
    distribution: { mode: 'perParent', count: 3 },
  };

  it('accepts a relation between two objects of the template', () => {
    const result = new SeedValidator().validate(accountsAndContacts([contactsPerAccount]));
    expect(result.errors).toEqual([]);
  });

  it('refuses parents drawn from this run when the template writes none of them', () => {
    const result = new SeedValidator().validate(
      accountsAndContacts([{ ...contactsPerAccount, parentObject: 'Lead' }]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Lead');
  });

  it('refuses a relation whose parents are records written by the same insert', () => {
    // An account cannot point at an account the same insert writes: its id
    // does not exist yet.
    const result = new SeedValidator().validate(
      accountsAndContacts([
        { ...contactsPerAccount, childObject: 'Account', lookupField: 'ParentId' },
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => e.message).join(' ')).toContain('records already in the org');
  });

  it('accepts new records under records of their own object already in the org', () => {
    const result = new SeedValidator().validate(
      accountsAndContacts([
        {
          ...contactsPerAccount,
          childObject: 'Account',
          lookupField: 'ParentId',
          parents: { kind: 'existing', where: "Type = 'Customer'", limit: 3 },
        },
      ]),
    );
    expect(result.errors).toEqual([]);
  });

  it('refuses a relation on an object the template does not write', () => {
    const result = new SeedValidator().validate(
      accountsAndContacts([{ ...contactsPerAccount, childObject: 'Case' }]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('Case.AccountId');
  });

  it('refuses a second relation on the same child, which would claim its count twice', () => {
    const result = new SeedValidator().validate(
      accountsAndContacts([
        contactsPerAccount,
        {
          ...contactsPerAccount,
          lookupField: 'ReportsToId',
          parentObject: 'Contact',
          parents: { kind: 'existing', limit: 5 },
        },
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain('more than one relation');
  });

  it('refuses a spread that gives a parent a number of children it cannot use', () => {
    for (const distribution of [
      { mode: 'perParent' as const, count: 0 },
      { mode: 'perParent' as const, count: 1.5 },
      { mode: 'range' as const, min: 4, max: 2 },
      { mode: 'ratio' as const, ratio: 0 },
    ]) {
      const result = new SeedValidator().validate(
        accountsAndContacts([{ ...contactsPerAccount, distribution }]),
      );
      expect(result.errors.some((e) => e.field.endsWith('.distribution'))).toBe(true);
    }
  });

  it('refuses parents from the org read without a bound', () => {
    const result = new SeedValidator().validate(
      accountsAndContacts([{ ...contactsPerAccount, parents: { kind: 'existing', limit: 0 } }]),
    );
    expect(result.errors.some((e) => e.field.endsWith('.parents.limit'))).toBe(true);
  });

  it('lets the relation answer for the rule on the lookup it fills', () => {
    // The wizard describes AccountId as a reference rule to Account. With the
    // parents read from the org, Account need not be in the template at all.
    const template = accountsAndContacts([
      { ...contactsPerAccount, parents: { kind: 'existing', limit: 10 } },
    ]);
    template.objects = template.objects.filter((o) => o.objectApiName === 'Contact');
    template.objects[0].fieldRules.push({
      fieldApiName: 'AccountId',
      ruleType: 'reference',
      config: { referenceObject: 'Account' },
    });

    expect(new SeedValidator().validate(template).errors).toEqual([]);
  });

  it('counts the lookup a relation fills as a field to fill', () => {
    const template = accountsAndContacts([contactsPerAccount]);
    template.objects[1].fieldRules = [];

    expect(new SeedValidator().validate(template).errors).toEqual([]);
  });

  it('sees a cycle made of relations', () => {
    const template = accountsAndContacts([
      contactsPerAccount,
      {
        childObject: 'Account',
        lookupField: 'Primary_Contact__c',
        parentObject: 'Contact',
        parents: { kind: 'generated' },
        distribution: { mode: 'perParent', count: 1 },
      },
    ]);

    const result = new SeedValidator().validate(template);
    expect(result.errors.some((e) => e.message === 'Circular dependency detected')).toBe(true);
  });
});
