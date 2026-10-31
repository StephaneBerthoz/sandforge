/**
 * What a transform rule makes a run send, field by field: through the
 * bridge's parse of the configuration, the real orchestrator, mapping,
 * transforms and DataSync, against a target that answers as an org does — it
 * takes the fields its describe lets the user create, gives each record an
 * Id, and an upsert finds its record by the External ID whatever its case.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import type { SyncConfig, SyncObjectConfig, TransformRule } from '@sandforge/shared';
import { SyncOrchestrator } from './SyncOrchestrator';
import { DataSync, type OperationOutcome } from './DataSync';
import { FieldMappingService } from './FieldMapping';
import { TransformPipeline } from './TransformPipeline';
import { ConflictResolver } from './ConflictResolver';
import { targetWriteFieldsOf, type TargetWriteFields } from './targetWriteFields';
import { SfdmuImporter } from '../migration/SfdmuImporter';
import { syncConfigPayloadSchema } from '../../bridge/validatePayload';

type Row = Record<string, unknown>;

/** A fake id: the object's prefix and a counter, the length of a real one. */
const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** The target's describes, as jsforce returns them, reduced to what a write reads. */
const DESCRIBES: Record<string, Parameters<typeof targetWriteFieldsOf>[0]> = {
  Account: {
    name: 'Account',
    createable: true,
    updateable: true,
    fields: [
      { name: 'Id', type: 'id', createable: false },
      { name: 'Name', type: 'string', createable: true, length: 255 },
      { name: 'Description', type: 'textarea', createable: true, nillable: true },
      { name: 'Industry', type: 'picklist', createable: true, nillable: true },
      { name: 'NumberOfEmployees', type: 'int', createable: true, nillable: true, digits: 8 },
      { name: 'Phone', type: 'phone', createable: true, nillable: true },
      { name: 'Founded__c', type: 'date', createable: true, nillable: true },
      { name: 'CreatedDate', type: 'datetime', createable: false },
    ],
  },
  Case: {
    name: 'Case',
    createable: true,
    updateable: true,
    fields: [
      { name: 'Id', type: 'id', createable: false },
      { name: 'Subject', type: 'string', createable: true, nillable: true, length: 255 },
      { name: 'Status', type: 'picklist', createable: true },
      { name: 'Origin', type: 'picklist', createable: true, nillable: true },
      { name: 'Description', type: 'textarea', createable: true, nillable: true },
      { name: 'Legacy_Key__c', type: 'string', createable: true, nillable: true, length: 40 },
    ],
  },
};

/** The source's rows, as a query returns them: the envelope, the Id, the system fields. */
const SOURCE: Record<string, Row[]> = {
  Account: [
    {
      attributes: { type: 'Account' },
      Id: fakeId('001', 1),
      Name: 'acme',
      Description: 'kept as typed',
      Industry: 'Technology',
      NumberOfEmployees: 250,
      Phone: null,
      Founded__c: null,
      CreatedDate: '2026-10-01T09:00:00.000+0000',
    },
    {
      attributes: { type: 'Account' },
      Id: fakeId('001', 2),
      Name: 'globex',
      Description: null,
      Industry: null,
      NumberOfEmployees: null,
      Phone: null,
      Founded__c: '2001-04-02',
      CreatedDate: '2026-10-01T09:00:00.000+0000',
    },
  ],
  Case: [
    {
      attributes: { type: 'Case' },
      Id: fakeId('500', 1),
      Subject: 'New',
      Status: 'New',
      Origin: 'Web',
      Description: 'Escalated',
      Legacy_Key__c: 'C-1',
    },
    {
      attributes: { type: 'Case' },
      Id: fakeId('500', 2),
      Subject: 'Printer jammed',
      Status: 'Escalated',
      Origin: 'Phone',
      Description: 'New',
      Legacy_Key__c: 'C-2',
    },
  ],
};

/** The fields of a source row the target lets a write carry, as read. */
function writable(object: string, row: Row): Row {
  const creatable = targetWriteFieldsOf(DESCRIBES[object]).creatable;
  return Object.fromEntries(Object.entries(row).filter(([field]) => creatable.has(field)));
}

/** A target org: records by Id, and every record each write sent it, in order. */
class MemoryTarget {
  readonly records = new Map<string, Row>();
  readonly sent: Array<{ object: string; record: Row }> = [];
  private next = 1;

  describe = async (object: string): Promise<TargetWriteFields> =>
    targetWriteFieldsOf(DESCRIBES[object]);

  private create(object: string, fields: Row): string {
    const id = fakeId(object === 'Case' ? '500' : '001', 100 + this.next++);
    this.records.set(id, { ...fields, Id: id });
    return id;
  }

  /** What the target holds of each record it created or updated, without its Id. */
  held(): Row[] {
    return [...this.records.values()].map(({ Id: _id, ...fields }) => fields);
  }

  dataSync(): DataSync {
    const unused = async (): Promise<never> => {
      throw new Error('not used');
    };
    return new DataSync({
      describeTargetFields: this.describe,
      insert: async (object, records) =>
        records.map((record): OperationOutcome => {
          this.sent.push({ object, record: { ...record } });
          return { id: this.create(object, record), success: true, errors: [] };
        }),
      upsert: async (object, keyField, records) =>
        records.map((record): OperationOutcome => {
          this.sent.push({ object, record: { ...record } });
          const key = String(record[keyField]).toLowerCase();
          const held = [...this.records.values()].find(
            (row) => String(row[keyField]).toLowerCase() === key,
          );
          if (held) {
            Object.assign(held, record);
            return { id: String(held.Id), success: true, errors: [], created: false };
          }
          return { id: this.create(object, record), success: true, errors: [], created: true };
        }),
      update: unused,
      delete: unused,
    });
  }
}

function orchestrator(target: MemoryTarget): SyncOrchestrator {
  return new SyncOrchestrator({
    dataSync: target.dataSync(),
    conflictResolver: new ConflictResolver(),
    fieldMapping: new FieldMappingService(),
    transformPipeline: new TransformPipeline(),
    querySource: vi.fn(async (_org: string, oc: SyncObjectConfig) =>
      (SOURCE[oc.objectApiName] ?? []).map((row) => ({ ...row })),
    ),
    queryTarget: vi.fn(async () => []),
    describeTargetFields: target.describe,
  });
}

/** A configuration as the bridge takes it from the page, and parses it before the run. */
function throughTheBridge(config: Record<string, unknown>): SyncConfig {
  return syncConfigPayloadSchema.parse(config) as unknown as SyncConfig;
}

/** The Sync page's configuration of one insert of Account, with the rules given. */
function accountsWith(transformRules: TransformRule[]): Record<string, unknown> {
  return {
    id: 'cfg-transforms',
    name: 'sync-from-ui',
    description: 'Sync from SandForge UI',
    sourceOrgId: 'src-org',
    targetOrgId: 'tgt-org',
    direction: 'source_to_target',
    mode: 'full',
    // Emails and phone numbers as read: what is checked here is the rules alone.
    keepContactPoints: true,
    objects: [
      {
        objectApiName: 'Account',
        operation: 'insert',
        externalIdField: '',
        batchSize: 200,
        fieldMappings: [],
        transformRules,
        excludedFields: [],
        addOnFields: [],
        insertOrder: 0,
      },
    ],
    conflictStrategy: 'source_wins',
    enableRollback: false,
    createdAt: '2026-10-31T09:00:00.000Z',
    updatedAt: '2026-10-31T09:00:00.000Z',
  };
}

describe('SyncOrchestrator — what a transform rule makes a run send', () => {
  it('changes the one field a rule names, and sends every other field as the source holds it', async () => {
    // Each rule ran on every field of every record: an Uppercase meant for
    // Name sent Description and Industry in capitals, and "" for every field
    // the source had left empty.
    const target = new MemoryTarget();

    const result = await orchestrator(target).execute(
      throughTheBridge(accountsWith([{ type: 'uppercase', field: 'Name', config: {} }])),
    );

    expect(result.status).toBe('success');
    expect(target.sent.map(({ record }) => record)).toEqual([
      { ...writable('Account', SOURCE.Account[0]), Name: 'ACME' },
      { ...writable('Account', SOURCE.Account[1]), Name: 'GLOBEX' },
    ]);
    // Field by field: the empty ones are still null, the number still a number.
    expect(target.held()[1]).toEqual({
      Name: 'GLOBEX',
      Description: null,
      Industry: null,
      NumberOfEmployees: null,
      Phone: null,
      Founded__c: '2001-04-02',
    });
  });

  it('runs a rule saved before rules named a field on every text field, and leaves the empty ones empty', async () => {
    const target = new MemoryTarget();

    await orchestrator(target).execute(
      throughTheBridge(accountsWith([{ type: 'uppercase', config: {} }])),
    );

    expect(target.held()).toEqual([
      {
        Name: 'ACME',
        Description: 'KEPT AS TYPED',
        Industry: 'TECHNOLOGY',
        NumberOfEmployees: 250,
        Phone: null,
        Founded__c: null,
      },
      {
        Name: 'GLOBEX',
        Description: null,
        Industry: null,
        NumberOfEmployees: null,
        Phone: null,
        Founded__c: '2001-04-02',
      },
    ]);
  });

  it('writes the value mapping of an SFDMU export on Status into Status alone', async () => {
    // Each field's mapping became a rule for every field: "New" meant for
    // Status became "Open" in the Subject and the Description too.
    const reader = { readFile: async (path: string) => readFileSync(path, 'utf8') };
    const imported = await new SfdmuImporter(reader).import(
      join(__dirname, '..', 'migration', 'fixtures', 'export.json'),
    );
    const target = new MemoryTarget();

    const result = await orchestrator(target).execute(
      throughTheBridge({
        ...imported,
        sourceOrgId: 'src-org',
        targetOrgId: 'tgt-org',
        keepContactPoints: true,
      }),
    );

    expect(result.status).toBe('success');
    expect(target.sent.map(({ record }) => record)).toEqual([
      { ...writable('Case', SOURCE.Case[0]), Status: 'Open' },
      { ...writable('Case', SOURCE.Case[1]), Status: 'Working' },
    ]);
    expect(target.held()).toEqual([
      {
        Subject: 'New',
        Status: 'Open',
        Origin: 'Web',
        Description: 'Escalated',
        Legacy_Key__c: 'C-1',
      },
      {
        Subject: 'Printer jammed',
        Status: 'Working',
        Origin: 'Phone',
        Description: 'New',
        Legacy_Key__c: 'C-2',
      },
    ]);
  });

  it('refuses, before anything is read, a rule whose field is not one the bridge knows how to name', () => {
    const parsed = syncConfigPayloadSchema.safeParse(
      accountsWith([{ type: 'uppercase', field: 'Name, Description', config: {} }]),
    );

    expect(parsed.success).toBe(false);
  });
});
