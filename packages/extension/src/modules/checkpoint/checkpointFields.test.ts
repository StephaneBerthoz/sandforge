import { describe, expect, it } from 'vitest';
import {
  SNAPSHOT_STAMPS,
  captureProjection,
  cascadeParentsOf,
  checkpointDescribeSchema,
  comparedFields,
  ignoredFieldsOf,
  isPersonContact,
  objectCapture,
  readModeOf,
  restoreAllowList,
  rowToWriteBack,
  type CheckpointDescribe,
  type CheckpointField,
} from './checkpointFields';

/** A field the user may create and edit. */
function writable(
  name: string,
  type = 'string',
  extra: Partial<CheckpointField> = {},
): CheckpointField {
  return {
    name,
    type,
    createable: true,
    updateable: true,
    nillable: true,
    permissionable: true,
    ...extra,
  };
}

/** A field no one writes: an audit stamp, which field-level security cannot be set on. */
function stamp(name: string, type = 'datetime'): CheckpointField {
  return { name, type, createable: false, updateable: false, permissionable: false };
}

/** The stamps every object of a checkpoint carries. */
const STAMPS: CheckpointField[] = [
  stamp('Id', 'id'),
  stamp('SystemModstamp'),
  stamp('CreatedDate'),
  stamp('CreatedById', 'reference'),
  stamp('LastModifiedDate'),
  stamp('LastModifiedById', 'reference'),
  stamp('IsDeleted', 'boolean'),
];

function described(
  name: string,
  fields: CheckpointField[],
  extra: Partial<CheckpointDescribe> = {},
): CheckpointDescribe {
  return {
    name,
    undeletable: true,
    fields: [...STAMPS, ...fields],
    childRelationships: [],
    ...extra,
  };
}

/** A case as an org describes it, with every shape of field a checkpoint must tell apart. */
const CASE = described('Case', [
  writable('Subject'),
  writable('Status', 'picklist'),
  writable('AccountId', 'reference', { referenceTo: ['Account'] }),
  { name: 'CaseNumber', type: 'string', autoNumber: true, permissionable: false },
  { name: 'Age__c', type: 'double', calculated: true, permissionable: true },
  {
    name: 'Internal_Score__c',
    type: 'double',
    createable: false,
    updateable: false,
    permissionable: true,
  },
  {
    name: 'Ssn__c',
    type: 'encryptedstring',
    createable: true,
    updateable: true,
    permissionable: true,
  },
  {
    name: 'Shield_Notes__c',
    type: 'textarea',
    createable: true,
    updateable: true,
    encrypted: true,
  },
  { name: 'Body__c', type: 'base64', createable: true, updateable: true, permissionable: true },
  {
    name: 'Site_Address__c',
    type: 'address',
    createable: false,
    updateable: false,
    permissionable: true,
  },
]);

describe('readModeOf', () => {
  it('reads tasks and events with queryAll, so that one archived since is never read as deleted', () => {
    expect(readModeOf('Task')).toBe('scanAllLive');
    expect(readModeOf('Event')).toBe('scanAllLive');
  });

  it('reads every other object with a plain query', () => {
    expect(readModeOf('Case')).toBe('query');
    expect(readModeOf('TaskRelation')).toBe('query');
    expect(readModeOf('Event__c')).toBe('query');
  });
});

describe('captureProjection', () => {
  it('keeps the stamps first, then the fields the user may create or edit, and never a formula, an auto-number or an audit field', async () => {
    const { fields } = await captureProjection(CASE, { viewsEncryptedData: true });

    expect(fields.slice(0, SNAPSHOT_STAMPS.length)).toEqual([...SNAPSHOT_STAMPS]);
    expect(fields).toEqual([
      ...SNAPSHOT_STAMPS,
      'Subject',
      'Status',
      'AccountId',
      'Ssn__c',
      'Shield_Notes__c',
    ]);
    expect(fields).not.toContain('CaseNumber');
    expect(fields).not.toContain('Age__c');
    expect(fields).not.toContain('IsDeleted');
  });

  it('names a field field-level security keeps the user from writing, and keeps no value of it', async () => {
    const { fields, leftOutFields } = await captureProjection(CASE, { viewsEncryptedData: true });

    expect(fields).not.toContain('Internal_Score__c');
    expect(leftOutFields).toContainEqual({ field: 'Internal_Score__c', reason: 'fls' });
  });

  it('keeps no classic encrypted field the user reads masked, names it, and keeps a Shield one', async () => {
    const masked = await captureProjection(CASE, { viewsEncryptedData: false });

    expect(masked.fields).not.toContain('Ssn__c');
    expect(masked.leftOutFields).toContainEqual({ field: 'Ssn__c', reason: 'encrypted' });
    expect(masked.fields).toContain('Shield_Notes__c');

    const clear = await captureProjection(CASE, { viewsEncryptedData: true });
    expect(clear.fields).toContain('Ssn__c');
    expect(clear.leftOutFields.map((f) => f.field)).not.toContain('Ssn__c');
  });

  it('names a file body and a compound field rather than keeping them', async () => {
    const { fields, leftOutFields } = await captureProjection(CASE, { viewsEncryptedData: true });

    expect(fields).not.toContain('Body__c');
    expect(fields).not.toContain('Site_Address__c');
    expect(leftOutFields).toEqual([
      { field: 'Internal_Score__c', reason: 'fls' },
      { field: 'Body__c', reason: 'base64' },
      { field: 'Site_Address__c', reason: 'compound' },
    ]);
  });

  it('keeps the person-account flag of an account and of a contact when the org has person accounts', async () => {
    const flag: CheckpointField = {
      name: 'IsPersonAccount',
      type: 'boolean',
      permissionable: false,
    };
    const account = await captureProjection(
      described('Account', [writable('Name'), writable('PersonEmail', 'email'), flag]),
      { viewsEncryptedData: true },
    );
    const contact = await captureProjection(described('Contact', [writable('LastName'), flag]), {
      viewsEncryptedData: true,
    });

    expect(account.fields).toEqual([...SNAPSHOT_STAMPS, 'IsPersonAccount', 'Name', 'PersonEmail']);
    expect(contact.fields).toEqual([...SNAPSHOT_STAMPS, 'IsPersonAccount', 'LastName']);
  });

  it('reads no person-account flag an org without person accounts does not describe', async () => {
    const { fields } = await captureProjection(described('Account', [writable('Name')]), {
      viewsEncryptedData: true,
    });

    expect(fields).toEqual([...SNAPSHOT_STAMPS, 'Name']);
  });

  it('reads only the stamps an object describes', async () => {
    const note = {
      name: 'Note__c',
      fields: [
        stamp('Id', 'id'),
        stamp('SystemModstamp'),
        stamp('CreatedDate'),
        writable('Text__c'),
      ],
    };

    expect((await captureProjection(note, { viewsEncryptedData: true })).fields).toEqual([
      'Id',
      'SystemModstamp',
      'CreatedDate',
      'Text__c',
    ]);
  });
});

describe('cascadeParentsOf', () => {
  const opportunity = described('Opportunity', [], {
    childRelationships: [
      { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
      { childSObject: 'Task', field: 'WhatId', cascadeDelete: true },
      { childSObject: 'Case', field: 'Opportunity__c', cascadeDelete: false },
    ],
  });
  const account = described('Account', [], {
    childRelationships: [
      { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
      { childSObject: 'Task', field: 'WhatId', cascadeDelete: true },
      { childSObject: 'Task', field: 'AccountId', cascadeDelete: false },
    ],
  });

  it('names the fields whose parent takes the record along, as the parents list them', () => {
    const lineItem = described('OpportunityLineItem', [
      writable('OpportunityId', 'reference', { updateable: false, permissionable: false }),
    ]);
    const task = described('Task', [
      writable('WhatId', 'reference'),
      writable('AccountId', 'reference'),
    ]);

    expect(cascadeParentsOf(lineItem, [opportunity, account])).toEqual(['OpportunityId']);
    expect(cascadeParentsOf(task, [opportunity, account])).toEqual(['WhatId']);
  });

  it('names no lookup that only clears or restricts, and none of a parent not described', () => {
    const kase = described('Case', [writable('Opportunity__c', 'reference')]);
    const contact = described('Contact', [writable('AccountId', 'reference')]);

    expect(cascadeParentsOf(kase, [opportunity, account])).toEqual([]);
    expect(cascadeParentsOf(contact, [opportunity])).toEqual([]);
  });

  it('names no field the child does not describe: one field-level security hides cannot be read', () => {
    const contact = described('Contact', []);

    expect(cascadeParentsOf(contact, [account])).toEqual([]);
  });
});

describe('objectCapture', () => {
  it('records the read mode, whether records come back on their own, the cascade parents and the projection', async () => {
    const opportunity = described('Opportunity', [], {
      childRelationships: [
        { childSObject: 'OpportunityLineItem', field: 'OpportunityId', cascadeDelete: true },
      ],
    });
    const lineItem = described(
      'OpportunityLineItem',
      [
        writable('OpportunityId', 'reference', { updateable: false, permissionable: false }),
        writable('Quantity', 'double'),
      ],
      { undeletable: false },
    );

    expect(
      await objectCapture(lineItem, [opportunity, lineItem], { viewsEncryptedData: true }),
    ).toEqual({
      objectApiName: 'OpportunityLineItem',
      readMode: 'query',
      undeletable: false,
      cascadeParents: ['OpportunityId'],
      fields: [...SNAPSHOT_STAMPS, 'OpportunityId', 'Quantity'],
      leftOutFields: [],
    });
  });

  it('takes an object whose describe does not say it undeletes for one that does not', async () => {
    const unsaid = { name: 'Thing__c', fields: [...STAMPS] };

    expect((await objectCapture(unsaid, [], { viewsEncryptedData: true })).undeletable).toBe(false);
  });
});

describe('ignoredFieldsOf', () => {
  it('reads the fields of one object out of Object.Field names, whatever their case', () => {
    const ignored = [
      'Case.Last_Touched__c',
      'case.Score__c',
      'Account.Rating',
      'Case.',
      '.Status',
      'Case',
    ];

    expect([...ignoredFieldsOf('Case', ignored)]).toEqual(['last_touched__c', 'score__c']);
    expect([...ignoredFieldsOf('Contact', ignored)]).toEqual([]);
  });
});

describe('comparedFields', () => {
  it('compares the values a snapshot holds, never its stamps or the person flag, and not the fields its owner stopped comparing', () => {
    const snapshot = [
      ...SNAPSHOT_STAMPS,
      'IsPersonAccount',
      'Subject',
      'Last_Touched__c',
      'Status',
    ];

    expect(comparedFields('Case', snapshot, ['Case.last_touched__c', 'Account.Subject'])).toEqual([
      'Subject',
      'Status',
    ]);
  });
});

describe('restoreAllowList', () => {
  const snapshotFields = [
    ...SNAPSHOT_STAMPS,
    'Subject',
    'Status',
    'Region__c',
    'Last_Touched__c',
    'Internal_Score__c',
    'Ssn__c',
    'OpportunityId',
  ];
  const now = described('Case', [
    writable('Subject'),
    writable('Status', 'picklist'),
    writable('Last_Touched__c', 'datetime'),
    {
      name: 'Internal_Score__c',
      type: 'double',
      createable: false,
      updateable: false,
      permissionable: true,
    },
    {
      name: 'Ssn__c',
      type: 'encryptedstring',
      createable: true,
      updateable: true,
      permissionable: true,
    },
    {
      name: 'OpportunityId',
      type: 'reference',
      createable: true,
      updateable: false,
      permissionable: true,
    },
  ]);

  it('writes back only what the org still has, the user may edit and its owner still compares, and names the rest with why', async () => {
    const allowed = await restoreAllowList({
      objectApiName: 'Case',
      snapshotFields,
      described: now,
      ignoredFields: ['Case.Last_Touched__c'],
      viewsEncryptedData: true,
    });

    expect(allowed.fields).toEqual(['Subject', 'Status', 'Ssn__c']);
    expect(allowed.notWritten).toEqual([
      { field: 'Region__c', reason: 'notPresent' },
      { field: 'Last_Touched__c', reason: 'ignored' },
      { field: 'Internal_Score__c', reason: 'fls' },
      { field: 'OpportunityId', reason: 'notUpdateable' },
    ]);
  });

  it('never writes a stamp, the person flag or an audit field back', async () => {
    const { fields, notWritten } = await restoreAllowList({
      objectApiName: 'Case',
      snapshotFields: [...SNAPSHOT_STAMPS, 'IsPersonAccount', 'Subject'],
      described: now,
      ignoredFields: [],
      viewsEncryptedData: true,
    });

    expect(fields).toEqual(['Subject']);
    expect(notWritten).toEqual([]);
  });

  it('never writes back a classic encrypted field the user now reads masked', async () => {
    const { fields, notWritten } = await restoreAllowList({
      objectApiName: 'Case',
      snapshotFields,
      described: now,
      ignoredFields: [],
      viewsEncryptedData: false,
    });

    expect(fields).not.toContain('Ssn__c');
    expect(notWritten).toContainEqual({ field: 'Ssn__c', reason: 'encrypted' });
  });

  it('matches the snapshot’s fields with the describe whatever their case', async () => {
    const { fields } = await restoreAllowList({
      objectApiName: 'Case',
      snapshotFields: ['Id', 'subject'],
      described: now,
      ignoredFields: [],
      viewsEncryptedData: true,
    });

    expect(fields).toEqual(['subject']);
  });
});

describe('rowToWriteBack', () => {
  it('sends a row shaped as a DataOps backup keeps one with nothing but its id and the allowed fields', async () => {
    const { fields } = await restoreAllowList({
      objectApiName: 'Case',
      snapshotFields: [...SNAPSHOT_STAMPS, 'Subject', 'Region__c', 'Internal_Score__c'],
      described: described('Case', [
        writable('Subject'),
        {
          name: 'Internal_Score__c',
          type: 'double',
          createable: false,
          updateable: false,
          permissionable: true,
        },
      ]),
      ignoredFields: [],
      viewsEncryptedData: true,
    });
    const row = {
      attributes: { type: 'Case', url: '/services/data/v62.0/sobjects/Case/500000000000001AAA' },
      Id: '500000000000001AAA',
      SystemModstamp: '2026-10-20T12:05:03.000+0000',
      CreatedDate: '2026-10-01T09:00:00.000+0000',
      CreatedById: '005000000000001AAA',
      LastModifiedDate: '2026-10-20T12:05:03.000+0000',
      LastModifiedById: '005000000000001AAA',
      Subject: 'Printer jam',
      Region__c: 'EMEA',
      Internal_Score__c: 7,
    };

    expect(rowToWriteBack('Case', row, fields)).toEqual({
      Id: '500000000000001AAA',
      Subject: 'Printer jam',
    });
  });

  it('gives a business account back without the fields only a person account holds', () => {
    const allowList = ['Name', 'FirstName', 'LastName', 'PersonEmail', 'Health__pc', 'Industry'];
    const business = {
      Id: '001000000000001AAA',
      IsPersonAccount: false,
      Name: 'Northwind',
      FirstName: null,
      LastName: null,
      PersonEmail: null,
      Health__pc: null,
      Industry: 'Retail',
    };

    expect(rowToWriteBack('Account', business, allowList)).toEqual({
      Id: '001000000000001AAA',
      Name: 'Northwind',
      Industry: 'Retail',
    });
  });

  it('gives a person account back its person fields, and not the name the org computes', () => {
    const allowList = ['Name', 'FirstName', 'LastName', 'PersonEmail'];
    const person = {
      Id: '001000000000002AAA',
      IsPersonAccount: true,
      Name: 'Ada Byron',
      FirstName: 'Ada',
      LastName: 'Byron',
      PersonEmail: 'ada@example.com',
    };

    expect(rowToWriteBack('Account', person, allowList)).toEqual({
      Id: '001000000000002AAA',
      FirstName: 'Ada',
      LastName: 'Byron',
      PersonEmail: 'ada@example.com',
    });
  });
});

describe('isPersonContact', () => {
  it('tells a person account’s contact, which goes and comes back with its account alone', () => {
    expect(isPersonContact('Contact', { Id: '003000000000001AAA', IsPersonAccount: true })).toBe(
      true,
    );
    expect(isPersonContact('Contact', { Id: '003000000000002AAA', IsPersonAccount: 'true' })).toBe(
      true,
    );
    expect(isPersonContact('Contact', { Id: '003000000000003AAA', IsPersonAccount: false })).toBe(
      false,
    );
    expect(isPersonContact('Contact', { Id: '003000000000004AAA' })).toBe(false);
    expect(isPersonContact('Account', { Id: '001000000000001AAA', IsPersonAccount: true })).toBe(
      false,
    );
  });
});

describe('checkpointDescribeSchema', () => {
  it('reads a describe as the org answers it, keeping what it does not name', () => {
    const parsed = checkpointDescribeSchema.parse({
      name: 'Case',
      undeletable: true,
      layoutable: true,
      fields: [
        { name: 'Subject', type: 'string', createable: true, updateable: true, length: 255 },
      ],
      childRelationships: [
        {
          childSObject: 'CaseComment',
          field: 'ParentId',
          cascadeDelete: true,
          relationshipName: 'CaseComments',
        },
      ],
    });

    expect(parsed.fields[0]).toMatchObject({ name: 'Subject', createable: true, length: 255 });
    expect(parsed.childRelationships?.[0]).toMatchObject({
      childSObject: 'CaseComment',
      cascadeDelete: true,
    });
  });

  it('refuses a describe without fields rather than reading it as an object with none', () => {
    expect(checkpointDescribeSchema.safeParse({ name: 'Case' }).success).toBe(false);
    expect(
      checkpointDescribeSchema.safeParse({ name: 'Case', fields: [{ name: 'Subject' }] }).success,
    ).toBe(false);
  });
});
