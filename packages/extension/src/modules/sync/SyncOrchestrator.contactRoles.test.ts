import { describe, it, expect } from 'vitest';
import type { SyncConfig, SyncObjectConfig, SyncWriteCheck } from '@sandforge/shared';
import { SyncOrchestrator } from './SyncOrchestrator.js';
import { DataSync, type OperationOutcome } from './DataSync.js';
import type { SyncCountedWrite, SyncWriteGate } from './SyncRunGate.js';
import { targetWriteFieldsOf, type TargetWriteFields } from './targetWriteFields.js';
import { FieldMappingService } from './FieldMapping.js';
import { TransformPipeline } from './TransformPipeline.js';
import { ConflictResolver } from './ConflictResolver.js';

/*
 * A Sync of a contact, the deal it is the primary contact of, and its role
 * on the deal, Decision Maker. Run for real, an opportunity inserted with its
 * `ContactId` is given by the platform, as it is taken, a role of that
 * contact, primary, with no role; a role sent beside it is taken as a second
 * one. The target here answers as that org did.
 */

const BUYER = '003000000000001AAA';
const DEAL = '006000000000001AAA';
const ROLE = '00K000000000001AAA';
const ADVISER = '003000000000002AAA';
const ADVISERS_ROLE = '00K000000000002AAA';

const DESCRIBES: Record<string, TargetWriteFields> = {
  Contact: targetWriteFieldsOf({
    name: 'Contact',
    fields: [{ name: 'LastName', createable: true, type: 'string', nillable: false }],
  }),
  Opportunity: targetWriteFieldsOf({
    name: 'Opportunity',
    fields: [
      { name: 'Name', createable: true, type: 'string', nillable: false },
      { name: 'ContactId', createable: true, type: 'reference', nillable: true },
    ],
  }),
  OpportunityContactRole: targetWriteFieldsOf({
    name: 'OpportunityContactRole',
    fields: [
      { name: 'OpportunityId', createable: true, type: 'reference', nillable: false },
      { name: 'ContactId', createable: true, type: 'reference', nillable: false },
      { name: 'Role', createable: true, type: 'picklist', nillable: true },
      { name: 'IsPrimary', createable: true, type: 'boolean', nillable: false },
    ],
  }),
};

function sourceRows(adviser = false): Record<string, Array<Record<string, unknown>>> {
  return {
    Contact: [
      { Id: BUYER, LastName: 'Buyer' },
      ...(adviser ? [{ Id: ADVISER, LastName: 'Adviser' }] : []),
    ],
    Opportunity: [{ Id: DEAL, Name: 'Deal', ContactId: BUYER }],
    OpportunityContactRole: [
      { Id: ROLE, OpportunityId: DEAL, ContactId: BUYER, Role: 'Decision Maker', IsPrimary: true },
      ...(adviser
        ? [
            {
              Id: ADVISERS_ROLE,
              OpportunityId: DEAL,
              ContactId: ADVISER,
              Role: 'Technical Buyer',
              IsPrimary: false,
            },
          ]
        : []),
    ],
  };
}

/** The target: what it holds, and an insert that writes a role with an opportunity sent with its contact. */
function targetOrg() {
  const held = new Map<string, Record<string, unknown>>();
  let next = 100;
  const prefix: Record<string, string> = {
    Contact: '003',
    Opportunity: '006',
    OpportunityContactRole: '00K',
  };
  const idFor = (object: string): string => `${prefix[object]}TGT000000${next++}AAA`;
  const insert = async (
    object: string,
    records: Record<string, unknown>[],
  ): Promise<OperationOutcome[]> =>
    records.map((record) => {
      const id = idFor(object);
      held.set(id, { ...record, object });
      const contact = record['ContactId'];
      if (object === 'Opportunity' && typeof contact === 'string' && contact !== '') {
        held.set(idFor('OpportunityContactRole'), {
          object: 'OpportunityContactRole',
          OpportunityId: id,
          ContactId: contact,
          Role: null,
          IsPrimary: true,
        });
      }
      return { id, success: true, errors: [] };
    });
  const update = async (
    _object: string,
    records: Record<string, unknown>[],
  ): Promise<OperationOutcome[]> =>
    records.map((record) => {
      const id = String(record['Id']);
      const found = held.get(id);
      if (!found) return { success: false, errors: ['ENTITY_IS_DELETED: entity is deleted'] };
      const fields = { ...record };
      delete fields['Id'];
      Object.assign(found, fields);
      return { id, success: true, errors: [] };
    });
  /** The roles the target holds of the opportunities a statement names, as it answers it. */
  const query = async (soql: string): Promise<Array<Record<string, unknown>>> => {
    const asked = /FROM OpportunityContactRole WHERE OpportunityId IN \((.*)\)$/.exec(soql);
    if (!asked) return [];
    const ids = [...asked[1].matchAll(/'([^']*)'/g)].map(([, id]) => id);
    return [...held]
      .filter(
        ([, r]) => r.object === 'OpportunityContactRole' && ids.includes(String(r.OpportunityId)),
      )
      .map(([Id, r]) => ({ ...r, Id }));
  };
  /** The roles of an opportunity in the target. */
  const rolesOf = (opportunity: string): Array<Record<string, unknown>> =>
    [...held]
      .filter(([, r]) => r.object === 'OpportunityContactRole' && r.OpportunityId === opportunity)
      .map(([Id, r]) => ({ ...r, Id }));
  const deal = (): string => [...held].find(([, r]) => r.object === 'Opportunity')?.[0] ?? '';
  const inserted = (object: string): number =>
    [...held.values()].filter((r) => r.object === object).length;
  return { held, insert, update, query, rolesOf, deal, inserted };
}

function objectConfig(objectApiName: string, insertOrder: number): SyncObjectConfig {
  return {
    objectApiName,
    operation: 'insert',
    fieldMappings: [],
    transformRules: [],
    excludedFields: [],
    addOnFields: [],
    batchSize: 200,
    insertOrder,
  };
}

const CONFIG: SyncConfig = {
  id: 'config-roles',
  name: 'Contacts, deals, their roles',
  description: '',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  direction: 'source_to_target',
  mode: 'full',
  objects: [
    objectConfig('Contact', 0),
    objectConfig('Opportunity', 1),
    objectConfig('OpportunityContactRole', 2),
  ],
  conflictStrategy: 'source_wins',
  enableRollback: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

function orchestrator(target: ReturnType<typeof targetOrg>, rows = sourceRows()) {
  const unused = async (): Promise<OperationOutcome[]> => [];
  const describeTargetFields = async (object: string) => DESCRIBES[object];
  return new SyncOrchestrator({
    dataSync: new DataSync({
      insert: (object, records) => target.insert(object, records),
      update: (object, records) => target.update(object, records),
      upsert: unused,
      delete: unused,
      describeTargetFields,
    }),
    conflictResolver: new ConflictResolver(),
    fieldMapping: new FieldMappingService(),
    transformPipeline: new TransformPipeline(),
    querySource: async (_org, config) => rows[config.objectApiName],
    queryTarget: async () => [],
    queryTargetRows: (soql) => target.query(soql),
    describeTargetFields,
  });
}

describe('SyncOrchestrator — an opportunity written with its primary contact, and its roles', () => {
  it("links the source's role to the one the platform wrote with the opportunity, gives it the source's role, and says so", async () => {
    const target = targetOrg();

    const result = await orchestrator(target).execute(CONFIG);

    // One role of the buyer on the deal's copy, as the source holds one.
    expect(target.rolesOf(target.deal())).toEqual([
      expect.objectContaining({ Role: 'Decision Maker', IsPrimary: true }),
    ]);
    const roles = result.objectResults.find((r) => r.objectApiName === 'OpportunityContactRole');
    expect(roles).toMatchObject({ success: 0, failed: 0, skipped: 1 });
    expect(roles?.writtenByThePlatform).toEqual({ records: 1, given: 1 });
    expect(result.status).toBe('success');
  });

  it('writes the role of another contact as read beside it', async () => {
    const target = targetOrg();

    const result = await orchestrator(target, sourceRows(true)).execute(CONFIG);

    expect(target.rolesOf(target.deal()).map((role) => [role['Role'], role['IsPrimary']])).toEqual([
      ['Decision Maker', true],
      ['Technical Buyer', false],
    ]);
    const roles = result.objectResults.find((r) => r.objectApiName === 'OpportunityContactRole');
    expect(roles).toMatchObject({ success: 1, skipped: 1 });
  });

  it('writes the role as read when the opportunity goes in without its contact', async () => {
    const target = targetOrg();
    const withoutTheContact: SyncConfig = {
      ...CONFIG,
      objects: CONFIG.objects.map((o) =>
        o.objectApiName === 'Opportunity' ? { ...o, excludedFields: ['ContactId'] } : o,
      ),
    };

    const result = await orchestrator(target).execute(withoutTheContact);

    expect(target.rolesOf(target.deal()).map((role) => role['Role'])).toEqual(['Decision Maker']);
    const roles = result.objectResults.find((r) => r.objectApiName === 'OpportunityContactRole');
    expect(roles?.writtenByThePlatform).toBeUndefined();
  });
});

/**
 * An orchestrator that simulates, and counts and measures as a run's gate
 * does: each object's rows as the source counts them, the gate handed what
 * was counted, and its check written back as a measure of it.
 */
function gatedOrchestrator(target: ReturnType<typeof targetOrg>, rows = sourceRows()) {
  const counted: SyncCountedWrite[] = [];
  const check = (write: SyncCountedWrite): SyncWriteCheck => {
    const objects = write.objects
      .filter((object) => object.rows > 0)
      .map(({ objectApiName, rows: n }) => ({ objectApiName, rows: n }));
    return {
      objects,
      total: objects.reduce((sum, object) => sum + object.rows, 0),
      alreadyCopied: write.alreadyCopied,
      ...(write.rolesByThePlatform !== undefined
        ? { rolesByThePlatform: write.rolesByThePlatform }
        : {}),
      storage: { verdict: 'fits', estimateMB: 0 },
      emails: [],
      verdict: 'writes',
    };
  };
  const gate: SyncWriteGate = {
    measure: async (write) => {
      counted.push(write);
      return check(write);
    },
    hold: async (write) => {
      counted.push(write);
      return { check: check(write), answer: { go: true, asked: false } };
    },
  };
  const unused = async (): Promise<OperationOutcome[]> => [];
  const describeTargetFields = async (object: string) => DESCRIBES[object];
  return {
    counted,
    sync: new SyncOrchestrator({
      dataSync: new DataSync({
        insert: (object, records) => target.insert(object, records),
        update: (object, records) => target.update(object, records),
        upsert: unused,
        delete: unused,
        describeTargetFields,
      }),
      conflictResolver: new ConflictResolver(),
      fieldMapping: new FieldMappingService(),
      transformPipeline: new TransformPipeline(),
      querySource: async (_org, config) => rows[config.objectApiName],
      queryTarget: async () => [],
      queryTargetRows: (soql) => target.query(soql),
      describeTargetFields,
      countSource: async (_org, config) => rows[config.objectApiName]?.length ?? 0,
      findInTarget: async () => new Map(),
      writeGate: gate,
    }),
  };
}

describe('SyncOrchestrator — what its gate and its simulation count of the role the platform writes', () => {
  it('has its gate say the role the platform may write with the opportunity, which it counts from the source alone', async () => {
    // On a scratch org, the gate read "write gate: 4 record(s) …
    // OpportunityContactRole 1", and the run linked that role and wrote none.
    const target = targetOrg();
    const { sync, counted } = gatedOrchestrator(target);

    await sync.execute(CONFIG);

    expect(counted[0]?.rolesByThePlatform).toBe(1);
    // An opportunity sent without its contact gets none of the platform's.
    const without = gatedOrchestrator(targetOrg());
    await without.sync.execute({
      ...CONFIG,
      objects: CONFIG.objects.map((o) =>
        o.objectApiName === 'Opportunity' ? { ...o, excludedFields: ['ContactId'] } : o,
      ),
    });
    expect(without.counted[0]?.rolesByThePlatform).toBeUndefined();
  });

  it('simulates the role linked to the one the platform writes with the opportunity, not inserted, as the run links it', async () => {
    // The same scratch org: "OpportunityContactRole (insert): 1 read, would
    // insert 1", and the run wrote none.
    const { sync } = gatedOrchestrator(targetOrg());

    const simulation = await sync.simulate(CONFIG);

    const roles = simulation.objects.find((o) => o.objectApiName === 'OpportunityContactRole');
    expect(roles).toMatchObject({ read: 1, insert: 0, skipped: 1, writtenByThePlatform: 1 });
    expect(roles?.notes).toContain(
      '1 record(s) would be linked to the contact role the platform writes with their ' +
        'opportunity, for its contact, not written.',
    );
    // Said by the gate as the reading found it, and not among what it would
    // hold back or refuse.
    expect(simulation.writeCheck).toMatchObject({ total: 3, rolesByThePlatform: 1 });
    expect(simulation.writeCheck?.notWritten).toBeUndefined();
  });

  it('simulates the role of another contact inserted beside it, and a role of an opportunity sent without its contact inserted', async () => {
    const { sync } = gatedOrchestrator(targetOrg(), sourceRows(true));

    const simulation = await sync.simulate(CONFIG);

    expect(
      simulation.objects.find((o) => o.objectApiName === 'OpportunityContactRole'),
    ).toMatchObject({ read: 2, insert: 1, skipped: 1, writtenByThePlatform: 1 });

    const without = gatedOrchestrator(targetOrg());
    const alone = await without.sync.simulate({
      ...CONFIG,
      objects: CONFIG.objects.map((o) =>
        o.objectApiName === 'Opportunity' ? { ...o, excludedFields: ['ContactId'] } : o,
      ),
    });
    const role = alone.objects.find((o) => o.objectApiName === 'OpportunityContactRole');
    expect(role).toMatchObject({ insert: 1, skipped: 0 });
    expect(role?.writtenByThePlatform).toBeUndefined();
  });
});
