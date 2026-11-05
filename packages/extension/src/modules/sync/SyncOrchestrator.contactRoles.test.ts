import { describe, it, expect } from 'vitest';
import type { SyncConfig, SyncObjectConfig } from '@sandforge/shared';
import { SyncOrchestrator } from './SyncOrchestrator.js';
import { DataSync, type OperationOutcome } from './DataSync.js';
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
