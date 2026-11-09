import { describe, it, expect } from 'vitest';
import type { SyncConfig, SyncObjectConfig, SyncWriteCheck } from '@sandforge/shared';
import { SyncOrchestrator } from './SyncOrchestrator.js';
import { DataSync, type OperationOutcome } from './DataSync.js';
import type { SyncCountedWrite, SyncWriteGate } from './SyncRunGate.js';
import { targetWriteFieldsOf, type TargetWriteFields } from './targetWriteFields.js';
import { FieldMappingService } from './FieldMapping.js';
import { TransformPipeline } from './TransformPipeline.js';
import { ConflictResolver } from './ConflictResolver.js';
import {
  MADE_BY_THE_RUN,
  RUN_USER,
  WENT_IN,
  answerContactRoles,
  secondsAfterItWentIn,
} from '../../test/contactRoleReads.js';

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

/**
 * The target: what it holds, and an insert that writes a role with an
 * opportunity sent with its contact. `alsoMade`: roles of that contact
 * someone else makes under the opportunity once it is in — by hand, or by
 * the target's automation — each answered before the platform's.
 */
function targetOrg(alsoMade: ReadonlyArray<{ role: string; at: string }> = []) {
  const held = new Map<string, Record<string, unknown>>();
  let next = 100;
  const prefix: Record<string, string> = {
    Contact: '003',
    Opportunity: '006',
    OpportunityContactRole: '00K',
  };
  const idFor = (object: string): string => `${prefix[object]}TGT000000${next++}AAA`;
  /** The ids of the roles the target answers first. */
  const first: string[] = [];
  const insert = async (
    object: string,
    records: Record<string, unknown>[],
  ): Promise<OperationOutcome[]> =>
    records.map((record) => {
      const id = idFor(object);
      held.set(id, { ...record, object, ...(object === 'Opportunity' ? MADE_BY_THE_RUN : {}) });
      const contact = record['ContactId'];
      if (object === 'Opportunity' && typeof contact === 'string' && contact !== '') {
        held.set(idFor('OpportunityContactRole'), {
          object: 'OpportunityContactRole',
          OpportunityId: id,
          ContactId: contact,
          Role: null,
          IsPrimary: true,
          ...MADE_BY_THE_RUN,
        });
        for (const { role, at } of alsoMade) {
          const made = idFor('OpportunityContactRole');
          first.push(made);
          held.set(made, {
            object: 'OpportunityContactRole',
            OpportunityId: id,
            ContactId: contact,
            Role: role,
            IsPrimary: true,
            CreatedDate: at,
            CreatedById: RUN_USER,
          });
        }
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
  /** The roles of an opportunity in the target, as it holds them. */
  const roles = (): Array<Record<string, unknown>> =>
    [...held]
      .filter(([, r]) => r.object === 'OpportunityContactRole')
      .map(([Id, r]) => ({ ...r, Id }));
  /** The roles the target holds of the opportunities a statement names, as it answers it. */
  const query = async (soql: string): Promise<Array<Record<string, unknown>>> => {
    const answered = [
      ...roles().filter((r) => first.includes(String(r['Id']))),
      ...roles().filter((r) => !first.includes(String(r['Id']))),
    ];
    return answerContactRoles(soql, answered, (id) => held.get(id)) ?? [];
  };
  /** The roles of an opportunity in the target. */
  const rolesOf = (opportunity: string): Array<Record<string, unknown>> =>
    roles().filter((r) => r['OpportunityId'] === opportunity);
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

  it("links the source's role to the platform's, never to one of the same contact made under the opportunity after it, which the target answers first", async () => {
    // A resumed clone on a scratch org linked such a role, made by hand four
    // seconds after the opportunity, and gave it the source's role.
    const target = targetOrg([{ role: 'Influencer', at: secondsAfterItWentIn(4) }]);

    const result = await orchestrator(target).execute(CONFIG);

    expect(
      target.rolesOf(target.deal()).map((role) => [role['Role'], role['CreatedDate']]),
    ).toEqual([
      ['Decision Maker', WENT_IN],
      ['Influencer', secondsAfterItWentIn(4)],
    ]);
    const roles = result.objectResults.find((r) => r.objectApiName === 'OpportunityContactRole');
    expect(roles).toMatchObject({ success: 0, failed: 0, skipped: 1 });
    expect(roles?.writtenByThePlatform).toEqual({ records: 1, given: 1 });
    expect(roles?.errors).toEqual([]);
  });

  it("writes the source's role as read, and says why, where the opportunity holds a second role of its contact made with it", async () => {
    // The target's automation writing a role for the opportunity's contact
    // in the same save: two made the same second by the same user, and
    // nothing tells which the platform wrote.
    const target = targetOrg([{ role: 'Business User', at: WENT_IN }]);

    const result = await orchestrator(target).execute(CONFIG);

    expect(target.rolesOf(target.deal()).map((role) => role['Role'])).toEqual([
      null,
      'Business User',
      'Decision Maker',
    ]);
    const roles = result.objectResults.find((r) => r.objectApiName === 'OpportunityContactRole');
    expect(roles).toMatchObject({ success: 1, failed: 0, skipped: 0 });
    expect(roles?.writtenByThePlatform).toBeUndefined();
    expect(roles?.errors).toEqual([
      '1 contact role(s) not linked to the one the platform wrote with their opportunity, so ' +
        'written as read: the target holds more than one role of their contact under it made ' +
        'with it, the same second, by the same user, and nothing tells which the platform ' +
        'wrote. The opportunity holds the role of its contact more than once.',
    ]);
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
      ...(write.rolesLinked !== undefined ? { rolesLinked: write.rolesLinked } : {}),
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
  it('has its gate count to write what the run writes, the role it links to the platform’s said apart', async () => {
    // On a scratch org, the gate read "write gate: 4 record(s) …
    // OpportunityContactRole 1 … of them, up to 1 OpportunityContactRole
    // record(s) the platform writes itself", and the run wrote 3 and linked
    // the role.
    const target = targetOrg();
    const { sync, counted } = gatedOrchestrator(target);

    const result = await sync.execute(CONFIG);

    const gate = counted[0];
    expect(gate?.objects.map(({ objectApiName, rows }) => [objectApiName, rows])).toEqual([
      ['Contact', 1],
      ['Opportunity', 1],
      ['OpportunityContactRole', 0],
    ]);
    expect(gate?.rolesLinked).toBe(1);
    expect(gate?.rolesByThePlatform).toBeUndefined();
    // As many to write as the run created, the role among the linked.
    const toWrite = (gate?.objects ?? []).reduce((sum, object) => sum + object.rows, 0);
    expect(result.objectResults.reduce((sum, r) => sum + r.success, 0)).toBe(toWrite);
    expect(
      result.objectResults.find((r) => r.objectApiName === 'OpportunityContactRole')
        ?.writtenByThePlatform,
    ).toEqual({ records: 1, given: 1 });
  });

  it('has its gate count to write the role of another contact, and every role of an opportunity sent without its contact', async () => {
    const beside = gatedOrchestrator(targetOrg(), sourceRows(true));
    await beside.sync.execute(CONFIG);
    expect(
      beside.counted[0]?.objects.find((o) => o.objectApiName === 'OpportunityContactRole')?.rows,
    ).toBe(1);
    expect(beside.counted[0]?.rolesLinked).toBe(1);

    // An opportunity sent without its contact gets none of the platform's.
    const without = gatedOrchestrator(targetOrg());
    await without.sync.execute({
      ...CONFIG,
      objects: CONFIG.objects.map((o) =>
        o.objectApiName === 'Opportunity' ? { ...o, excludedFields: ['ContactId'] } : o,
      ),
    });
    expect(
      without.counted[0]?.objects.find((o) => o.objectApiName === 'OpportunityContactRole')?.rows,
    ).toBe(1);
    expect(without.counted[0]?.rolesLinked).toBeUndefined();
    expect(without.counted[0]?.rolesByThePlatform).toBeUndefined();

    // Nor does one whose contact the run does not write and no earlier run wrote.
    const noContact = gatedOrchestrator(targetOrg());
    await noContact.sync.execute({
      ...CONFIG,
      objects: CONFIG.objects.filter((o) => o.objectApiName !== 'Contact'),
    });
    expect(noContact.counted[0]?.rolesLinked).toBeUndefined();
    expect(
      noContact.counted[0]?.objects.find((o) => o.objectApiName === 'OpportunityContactRole')?.rows,
    ).toBe(1);
  });

  it('has its gate say how many at most, counted in, where an upsert may update the opportunity', async () => {
    const { sync, counted } = gatedOrchestrator(targetOrg());

    await sync.simulate({
      ...CONFIG,
      objects: CONFIG.objects.map((o) =>
        o.objectApiName === 'Opportunity'
          ? { ...o, operation: 'upsert' as const, externalIdField: 'Id' }
          : o,
      ),
    });

    expect(counted[0]?.rolesByThePlatform).toBe(1);
    expect(counted[0]?.rolesLinked).toBeUndefined();
    expect(
      counted[0]?.objects.find((o) => o.objectApiName === 'OpportunityContactRole')?.rows,
    ).toBe(1);
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
    // Said by the gate as the reading found it, out of what the run writes,
    // and not among what it would hold back or refuse.
    expect(simulation.writeCheck).toMatchObject({ total: 2, rolesLinked: 1 });
    expect(simulation.writeCheck?.rolesByThePlatform).toBeUndefined();
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
