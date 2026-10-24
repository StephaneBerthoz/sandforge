import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type { ExecuteOptions, FieldInfo, ForgeExecutorDeps } from './ForgeExecutor.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A classic encrypted field (`encryptedstring`) the user the source is read
 * as reads without View Encrypted Data comes back masked. A clone wrote the
 * mask into the target as if it were the value.
 */

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const CONTACT = id('003', 1);
const ACCOUNT = id('001', 1);
const MASK = '***-**-1234';
const PERMISSION_SOQL = 'SELECT PermissionsViewEncryptedData FROM UserPermissionAccess';

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  isReference: false,
  ...overrides,
});

const FIELDS: Record<string, FieldInfo[]> = {
  Contact: [
    field('Id'),
    field('LastName'),
    field('SSN__c', { type: 'encryptedstring' }),
    field('AccountId', { isReference: true, referenceTo: ['Account'], nillable: false }),
  ],
  Account: [field('Id'), field('Name'), field('TaxId__c', { type: 'encryptedstring' })],
  Lead: [field('Id'), field('LastName')],
};

const SOURCE: Record<string, FakeRow[]> = {
  Contact: [{ Id: CONTACT, LastName: 'Example', SSN__c: MASK, AccountId: ACCOUNT }],
  Account: [{ Id: ACCOUNT, Name: 'Acme', TaxId__c: '****5678' }],
  Lead: [{ Id: id('00Q', 1), LastName: 'Lead' }],
};

function node(objectApiName: string): ForgeGraphNode {
  return {
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
  };
}

const graphOf = (...objects: string[]): ForgeGraph => ({
  nodes: objects.map(node),
  edges: [],
  totalRecords: objects.length,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
});

/**
 * A source holding the tables above, whose user views encrypted data in clear
 * or not, and a target that takes every record it is sent.
 */
function fakeOrgs(viewsEncrypted: boolean) {
  const sent: Record<string, Array<Record<string, unknown>>> = {};
  const asked: string[] = [];
  let next = 0;
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? [field('Id')]),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org !== 'src') return [];
      asked.push(soql);
      if (soql === PERMISSION_SOQL) return [{ PermissionsViewEncryptedData: viewsEncrypted }];
      return selectRows(SOURCE, soql);
    }),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) => {
      (sent[object] ??= []).push(...rows.map((row) => ({ ...row })));
      return rows.map(() => ({
        id: id(object === 'Account' ? '001' : '003', 900 + ++next),
        success: true,
        errors: [],
      }));
    }),
  } satisfies ForgeExecutorDeps;
  return { deps, sent, asked };
}

const OF_THE_CONTACT: ExecuteOptions = {
  rootRecordId: CONTACT,
  rootObjectApiName: 'Contact',
  expandOrphanParents: true,
};

describe('ForgeExecutor, encrypted fields the source reads masked', () => {
  it('leaves an encrypted field the source user reads masked out of every record, and names it', async () => {
    const { deps, sent } = fakeOrgs(false);

    const summary = await new ForgeExecutor(deps).execute(
      graphOf('Contact'),
      'src',
      'tgt',
      () => undefined,
      OF_THE_CONTACT,
    );

    expect(sent.Contact).toEqual([
      expect.objectContaining({ LastName: 'Example', AccountId: id('001', 901) }),
    ]);
    expect(sent.Contact?.[0]).not.toHaveProperty('SSN__c');
    // The parent fetched from outside the graph goes without its own too.
    expect(sent.Account).toEqual([{ Name: 'Acme' }]);
    expect(JSON.stringify(sent)).not.toContain('***');
    expect(summary.encryptedFieldsLeftOut).toEqual([
      { objectApiName: 'Account', fields: ['TaxId__c'] },
      { objectApiName: 'Contact', fields: ['SSN__c'] },
    ]);
  });

  it('says it on a dry run too, which writes nothing', async () => {
    const { deps, sent } = fakeOrgs(false);

    const summary = await new ForgeExecutor(deps).execute(
      graphOf('Contact'),
      'src',
      'tgt',
      () => undefined,
      { ...OF_THE_CONTACT, dryRun: true },
    );

    expect(sent).toEqual({});
    expect(summary.encryptedFieldsLeftOut).toEqual([
      { objectApiName: 'Account', fields: ['TaxId__c'] },
      { objectApiName: 'Contact', fields: ['SSN__c'] },
    ]);
  });

  it('writes the encrypted fields as before for a user who views encrypted data, and names none', async () => {
    const { deps, sent } = fakeOrgs(true);

    const summary = await new ForgeExecutor(deps).execute(
      graphOf('Contact'),
      'src',
      'tgt',
      () => undefined,
      OF_THE_CONTACT,
    );

    expect(sent.Contact?.[0]).toMatchObject({ SSN__c: MASK });
    expect(sent.Account).toEqual([{ Name: 'Acme', TaxId__c: '****5678' }]);
    expect(summary.encryptedFieldsLeftOut).toBeUndefined();
  });

  it('asks nothing of the permission for objects with no encrypted field', async () => {
    const { deps, asked } = fakeOrgs(false);

    const summary = await new ForgeExecutor(deps).execute(
      graphOf('Lead'),
      'src',
      'tgt',
      () => undefined,
      { rootRecordId: id('00Q', 1), rootObjectApiName: 'Lead' },
    );

    expect(asked).not.toContain(PERMISSION_SOQL);
    expect(summary.encryptedFieldsLeftOut).toBeUndefined();
  });
});
