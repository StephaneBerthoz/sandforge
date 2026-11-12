import { describe, it, expect, vi } from 'vitest';
import type {
  FieldRule,
  SeedObjectConfig,
  SeedRelation,
  SeedRow,
  SeedTemplate,
} from '@sandforge/shared';
import { SeedOrchestrator } from './SeedOrchestrator';
import type {
  InsertFn,
  InsertResult,
  InsertedRow,
  SeedOrchestratorDependencies,
  UpdateFn,
} from './SeedOrchestrator';
import { SeedValidator } from './SeedValidator';
import { DataPlanBuilder } from './DataPlanBuilder';
import { FieldMapper } from './FieldMapper';
import { FakerFallback } from './FakerFallback';
import { AIDataGenerator } from './AIDataGenerator';
import { ReferenceLinker } from './ReferenceLinker';
import { SeedGrappeAdapter } from './SeedGrappeAdapter';
import { contactRolesOfSoql, rolesMadeAlikeWords } from '../../core/common/platformRecords.js';
import {
  MADE_BY_THE_RUN,
  RUN_USER,
  WENT_IN,
  secondsAfterItWentIn,
} from '../../test/contactRoleReads.js';

/*
 * A seed that writes opportunities with their contact, then contact roles. Run
 * against a real org, an opportunity inserted with its `ContactId` is given by
 * the platform, as it is taken, a contact role of that contact: primary, with
 * no role, written by the user the run writes as. A role the seed generated
 * for that contact on that opportunity then stood beside it: the opportunity
 * held the role of its contact twice. The target here answers as that org did.
 */

const ID_PREFIX: Record<string, string> = {
  Account: '001',
  Contact: '003',
  Opportunity: '006',
  OpportunityContactRole: '00K',
};

/** The columns a real org's contact role answers a query of. */
const ROLE_COLUMNS = new Set(['Id', 'OpportunityId', 'ContactId', 'Role', 'IsPrimary']);

type Row = Record<string, unknown> & { Id: string };

/**
 * A target that answers record by record, as the REST path does, and writes
 * a contact role of an opportunity's contact as it takes the opportunity. A
 * role inserted primary takes the flag from the opportunity's other roles.
 * Its reads answer the query of an opportunity's contact roles alone, and
 * refuse a column a contact role lacks with the org's words; its updates
 * refuse what a contact role does not let be changed.
 */
function roleWritingTarget(
  options: {
    perRow?: boolean;
    unreadable?: string;
    /** Roles of its contact someone else makes under each opportunity, answered first. */
    alsoMade?: ReadonlyArray<{ role: string; at: string }>;
  } = {},
) {
  const held = new Map<string, { objectApiName: string; record: Row }>();
  const sent: Array<{ objectApiName: string; records: Record<string, unknown>[] }> = [];
  /** The roles the target answers before the others. */
  const answeredFirst = new Set<string>();
  let next = 0;
  const idOf = (objectApiName: string): string =>
    `${ID_PREFIX[objectApiName] ?? 'a0X'}${String(++next).padStart(15, '0')}`;
  const rolesOf = (opportunity: unknown): Row[] =>
    [...held.values()]
      .filter(
        (h) =>
          h.objectApiName === 'OpportunityContactRole' && h.record.OpportunityId === opportunity,
      )
      .map((h) => h.record);

  const insert = vi.fn<InsertFn>(async (_orgId, objectApiName, records): Promise<InsertResult> => {
    sent.push({ objectApiName, records: records.map((r) => ({ ...r })) });
    const rows = records.map((record): InsertedRow => {
      const id = idOf(objectApiName);
      if (objectApiName === 'OpportunityContactRole' && record.IsPrimary === true) {
        for (const role of rolesOf(record.OpportunityId)) role.IsPrimary = false;
      }
      held.set(id, {
        objectApiName,
        record: {
          ...(objectApiName === 'OpportunityContactRole' ? { IsPrimary: false, Role: null } : {}),
          ...record,
          Id: id,
          // The run's own roles went in after the platform's, two seconds later in the real run.
          ...(objectApiName === 'OpportunityContactRole'
            ? { CreatedDate: secondsAfterItWentIn(2), CreatedById: RUN_USER }
            : MADE_BY_THE_RUN),
        },
      });
      if (objectApiName === 'Opportunity' && typeof record.ContactId === 'string') {
        const role = idOf('OpportunityContactRole');
        held.set(role, {
          objectApiName: 'OpportunityContactRole',
          record: {
            Id: role,
            OpportunityId: id,
            ContactId: record.ContactId,
            IsPrimary: true,
            Role: null,
            ...MADE_BY_THE_RUN,
          },
        });
        for (const made of options.alsoMade ?? []) {
          const other = idOf('OpportunityContactRole');
          held.set(other, {
            objectApiName: 'OpportunityContactRole',
            record: {
              Id: other,
              OpportunityId: id,
              ContactId: record.ContactId,
              IsPrimary: true,
              Role: made.role,
              CreatedDate: made.at,
              CreatedById: RUN_USER,
            },
          });
          answeredFirst.add(other);
        }
      }
      return { id };
    });
    const lists = { successIds: rows.flatMap((r) => (r.id ? [r.id] : [])), errors: [] };
    return options.perRow === false ? lists : { ...lists, rows };
  });

  const readTarget = vi.fn(async (soql: string): Promise<Array<Record<string, unknown>>> => {
    if (options.unreadable) throw new Error(options.unreadable);
    const asked = contactRolesOfSoql(soql);
    if (!asked) throw new Error(`Not a statement the fake org reads: ${soql}`);
    const unknown = asked.fields.find((field) => !ROLE_COLUMNS.has(field));
    if (unknown) {
      throw new Error(
        `INVALID_FIELD: No such column '${unknown}' on entity 'OpportunityContactRole'.`,
      );
    }
    const columns = [
      'Id',
      'OpportunityId',
      'ContactId',
      'CreatedDate',
      'CreatedById',
      ...asked.fields,
    ];
    return asked.opportunities.flatMap((opportunity) => {
      const itsRecord = held.get(opportunity)?.record;
      const roles = rolesOf(opportunity);
      return [
        ...roles.filter((role) => answeredFirst.has(role.Id)),
        ...roles.filter((role) => !answeredFirst.has(role.Id)),
      ].map((role) => ({
        ...Object.fromEntries(columns.map((column) => [column, role[column] ?? null])),
        Opportunity: itsRecord
          ? { CreatedDate: itsRecord.CreatedDate, CreatedById: itsRecord.CreatedById }
          : null,
      }));
    });
  });

  const update = vi.fn<UpdateFn>(async (_orgId, objectApiName, records) =>
    records.map((record) => {
      const found = held.get(record.Id);
      if (!found || found.objectApiName !== objectApiName) {
        return { success: false, error: 'ENTITY_IS_DELETED: entity is deleted' };
      }
      if ('OpportunityId' in record) {
        return {
          success: false,
          error:
            'INVALID_FIELD_FOR_INSERT_UPDATE: Unable to create/update fields: OpportunityId. ' +
            'Please check the security settings of this field and verify that it is read/write ' +
            'for your profile or permission set.',
        };
      }
      Object.assign(found.record, record);
      return { success: true };
    }),
  );

  /** The contact roles the target holds, as COUNT() would find them. */
  const roles = (): Row[] =>
    [...held.values()]
      .filter((h) => h.objectApiName === 'OpportunityContactRole')
      .map((h) => h.record);
  /** The roles of `contact` on `opportunity`. */
  const rolesOfThePair = (opportunity: unknown, contact: unknown): Row[] =>
    roles().filter((r) => r.OpportunityId === opportunity && r.ContactId === contact);
  const recordsOf = (objectApiName: string): Row[] =>
    [...held.values()].filter((h) => h.objectApiName === objectApiName).map((h) => h.record);
  return { insert, readTarget, update, held, sent, roles, rolesOfThePair, recordsOf };
}

function deps(
  target: ReturnType<typeof roleWritingTarget>,
  extra: Partial<SeedOrchestratorDependencies> = {},
): SeedOrchestratorDependencies {
  return {
    validator: new SeedValidator(),
    planBuilder: new DataPlanBuilder(),
    fieldMapper: new FieldMapper({
      aiGenerator: new AIDataGenerator(() => {
        throw new Error('no AI here');
      }),
      fakerFallback: new FakerFallback('en_US'),
      // A reference rule takes the first record it can: each role's contact
      // is the first contact written.
      random: () => 0,
    }),
    referenceLinker: new ReferenceLinker(),
    insert: target.insert,
    readTarget: target.readTarget,
    update: target.update,
    generateId: () => 'op-1',
    now: () => '2026-11-05T00:00:00.000Z',
    ...extra,
  };
}

const rule = (fieldApiName: string, config: FieldRule['config'], ruleType: FieldRule['ruleType']) =>
  ({ fieldApiName, ruleType, config }) as FieldRule;

function object(
  objectApiName: string,
  recordCount: number,
  insertOrder: number,
  fieldRules: FieldRule[],
  rows?: SeedRow[],
): SeedObjectConfig {
  return {
    objectApiName,
    recordCount,
    fieldRules,
    excludedFields: [],
    insertOrder,
    batchSize: 200,
    ...(rows ? { rows } : {}),
  };
}

const onePerParent = (
  childObject: string,
  lookupField: string,
  parentObject: string,
): SeedRelation => ({
  childObject,
  lookupField,
  parentObject,
  parents: { kind: 'generated' },
  distribution: { mode: 'perParent', count: 1 },
});

/**
 * Two contacts, an opportunity for each with that contact, then a role for
 * each opportunity, of the first contact, Decision Maker, its primary flag as
 * `isPrimary` gives it: the first opportunity's role is of the contact it
 * went in with, the second's of another.
 */
function rolesTemplate(isPrimary: boolean | undefined = true): SeedTemplate {
  return {
    id: 'tpl',
    name: 'opportunities and their roles',
    description: '',
    version: 1,
    strategy: 'template',
    objects: [
      object('Account', 1, 0, [rule('Name', { staticValue: 'Acme' }, 'static')]),
      object('Contact', 2, 1, [
        rule('LastName', { sequencePrefix: 'Contact ', sequenceStart: 1 }, 'sequence'),
        rule('AccountId', { referenceObject: 'Account' }, 'reference'),
      ]),
      object('Opportunity', 2, 2, [
        rule('Name', { sequencePrefix: 'Deal ', sequenceStart: 1 }, 'sequence'),
        rule('StageName', { staticValue: 'Prospecting' }, 'static'),
        rule('CloseDate', { staticValue: '2026-12-31' }, 'static'),
      ]),
      object('OpportunityContactRole', 2, 3, [
        rule('ContactId', { referenceObject: 'Contact' }, 'reference'),
        rule('Role', { staticValue: 'Decision Maker' }, 'static'),
        ...(isPrimary === undefined
          ? []
          : [rule('IsPrimary', { staticValue: isPrimary }, 'static')]),
      ]),
    ],
    relations: [
      onePerParent('Opportunity', 'ContactId', 'Contact'),
      onePerParent('OpportunityContactRole', 'OpportunityId', 'Opportunity'),
    ],
    tags: [],
    createdAt: '2026-11-05T00:00:00.000Z',
    updatedAt: '2026-11-05T00:00:00.000Z',
  };
}

describe('SeedOrchestrator — the contact role the platform writes with an opportunity', () => {
  it('keeps one role of an opportunity’s contact: the platform’s, given the role generated for it, and sends the others', async () => {
    const target = roleWritingTarget();
    const result = await new SeedOrchestrator(deps(target)).execute(rolesTemplate(), 'org');

    const [first, second] = target.recordsOf('Opportunity');
    const [c1, c2] = target.recordsOf('Contact');
    expect(first.ContactId).toBe(c1.Id);
    expect(second.ContactId).toBe(c2.Id);
    // One role of the first contact on the first opportunity, where the seed
    // left two: the platform's, holding the role the seed generated.
    const linked = target.rolesOfThePair(first.Id, c1.Id);
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({ Role: 'Decision Maker', IsPrimary: true });
    // The second opportunity holds the platform's role of its own contact,
    // and the role generated for the first contact, sent.
    expect(target.rolesOfThePair(second.Id, c2.Id)).toHaveLength(1);
    expect(target.rolesOfThePair(second.Id, c1.Id)).toHaveLength(1);
    expect(target.roles()).toHaveLength(3);
    const sentRoles = target.sent
      .filter((s) => s.objectApiName === 'OpportunityContactRole')
      .flatMap((s) => s.records);
    expect(sentRoles).toEqual([expect.objectContaining({ OpportunityId: second.Id })]);

    const roles = result.objectResults.find((r) => r.objectApiName === 'OpportunityContactRole');
    expect(roles).toMatchObject({
      recordsCreated: 1,
      recordsFailed: 0,
      errors: [],
      writtenByThePlatform: { records: 1, given: 1 },
    });
    expect(roles?.createdIds).toEqual(target.rolesOfThePair(second.Id, c1.Id).map((r) => r.Id));
    expect(result.status).toBe('success');
    expect(result.totalRecordsCreated).toBe(1 + 2 + 2 + 1);
  });

  it('leaves the platform’s role primary when the role generated for its contact is not: the opportunity keeps the contact it went in with', async () => {
    const target = roleWritingTarget();
    await new SeedOrchestrator(deps(target)).execute(rolesTemplate(false), 'org');

    const [first] = target.recordsOf('Opportunity');
    const linked = target.rolesOfThePair(first.Id, first.ContactId);
    expect(linked).toEqual([expect.objectContaining({ Role: 'Decision Maker', IsPrimary: true })]);
    for (const call of target.update.mock.calls) {
      for (const record of call[2]) expect(record).not.toHaveProperty('IsPrimary');
    }
  });

  it('counts a role linked with nothing to give it as written by the platform, and updates nothing', async () => {
    const template = rolesTemplate(undefined);
    const roles = template.objects[3];
    roles.fieldRules = roles.fieldRules.filter((r) => r.fieldApiName !== 'Role');
    const target = roleWritingTarget();
    const result = await new SeedOrchestrator(deps(target)).execute(template, 'org');

    expect(target.update).not.toHaveBeenCalled();
    expect(
      result.objectResults.find((r) => r.objectApiName === 'OpportunityContactRole'),
    ).toMatchObject({ recordsCreated: 1, writtenByThePlatform: { records: 1, given: 0 } });
  });

  it('keeps the platform’s role linked, as it wrote it, when the target refuses it the generated fields, and says what it answered', async () => {
    const target = roleWritingTarget();
    target.update.mockImplementation(async (_orgId, _objectApiName, records) =>
      records.map(() => ({
        success: false,
        error: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: A role is set by the account team.',
      })),
    );
    const result = await new SeedOrchestrator(deps(target)).execute(rolesTemplate(), 'org');

    const [first] = target.recordsOf('Opportunity');
    expect(target.rolesOfThePair(first.Id, first.ContactId)).toEqual([
      expect.objectContaining({ Role: null }),
    ]);
    const roles = result.objectResults.find((r) => r.objectApiName === 'OpportunityContactRole');
    expect(roles).toMatchObject({
      recordsCreated: 1,
      recordsFailed: 0,
      writtenByThePlatform: {
        records: 1,
        given: 0,
        refusal: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: A role is set by the account team.',
      },
    });
    expect(result.status).toBe('success');
  });

  it('links the platform’s role, never one of the same contact made under the opportunity after it, which the target answers first', async () => {
    const target = roleWritingTarget({
      alsoMade: [{ role: 'Influencer', at: secondsAfterItWentIn(4) }],
    });
    const result = await new SeedOrchestrator(deps(target)).execute(rolesTemplate(), 'org');

    const [first] = target.recordsOf('Opportunity');
    expect(
      target.rolesOfThePair(first.Id, first.ContactId).map((r) => [r.Role, r.CreatedDate]),
    ).toEqual([
      ['Decision Maker', WENT_IN],
      ['Influencer', secondsAfterItWentIn(4)],
    ]);
    expect(
      result.objectResults.find((r) => r.objectApiName === 'OpportunityContactRole'),
    ).toMatchObject({
      recordsCreated: 1,
      errors: [],
      writtenByThePlatform: { records: 1, given: 1 },
    });
  });

  it('sends the role as generated, and says why, where the opportunity holds a second role of its contact made with it', async () => {
    // The target's automation writing a role for the opportunity's contact in the same save.
    const target = roleWritingTarget({ alsoMade: [{ role: 'Business User', at: WENT_IN }] });
    const result = await new SeedOrchestrator(deps(target)).execute(rolesTemplate(), 'org');

    const [first] = target.recordsOf('Opportunity');
    expect(target.rolesOfThePair(first.Id, first.ContactId).map((r) => r.Role)).toEqual([
      null,
      'Business User',
      'Decision Maker',
    ]);
    expect(target.update).not.toHaveBeenCalled();
    const roles = result.objectResults.find((r) => r.objectApiName === 'OpportunityContactRole');
    expect(roles?.recordsCreated).toBe(2);
    expect(roles?.writtenByThePlatform).toBeUndefined();
    expect(roles?.errors).toEqual([rolesMadeAlikeWords(1, 'generated')]);
  });

  it('sends the roles as generated when the target cannot be read, and says an opportunity may hold the role of its contact twice', async () => {
    const target = roleWritingTarget({ unreadable: 'INVALID_SESSION_ID: Session expired' });
    const result = await new SeedOrchestrator(deps(target)).execute(rolesTemplate(), 'org');

    expect(target.roles()).toHaveLength(4);
    const roles = result.objectResults.find((r) => r.objectApiName === 'OpportunityContactRole');
    expect(roles?.recordsCreated).toBe(2);
    expect(roles?.writtenByThePlatform).toBeUndefined();
    expect(roles?.errors).toEqual([
      "The contact roles the platform wrote with the run's opportunities were not looked up, " +
        'so written as generated: an opportunity may hold the role of its contact twice. ' +
        'INVALID_SESSION_ID: Session expired',
    ]);
  });

  it('says the same when the opportunities’ insert did not say which record each id is', async () => {
    // A Bulk API job whose answer cannot be laid on its records.
    const target = roleWritingTarget({ perRow: false });
    const result = await new SeedOrchestrator(deps(target)).execute(rolesTemplate(), 'org');

    expect(target.readTarget).not.toHaveBeenCalled();
    const roles = result.objectResults.find((r) => r.objectApiName === 'OpportunityContactRole');
    expect(roles?.recordsCreated).toBe(2);
    expect(roles?.errors).toEqual([
      "The contact roles the platform wrote with the run's opportunities were not looked up, " +
        'so written as generated: an opportunity may hold the role of its contact twice. ' +
        "The opportunities' insert did not say which record each id it answered is.",
    ]);
  });

  it('links on the partitioned path too', async () => {
    const target = roleWritingTarget();
    const result = await new SeedOrchestrator(
      deps(target, {
        // A partition a record: the opportunities and the roles each go in two.
        grappeAdapter: new SeedGrappeAdapter(() => 'gid', 1),
        grappeConfig: {
          enabled: true,
          autoActivateThreshold: 1,
          grappeSize: 1,
        } as SeedOrchestratorDependencies['grappeConfig'],
      }),
    ).execute(rolesTemplate(), 'org');

    const [first] = target.recordsOf('Opportunity');
    expect(target.rolesOfThePair(first.Id, first.ContactId)).toEqual([
      expect.objectContaining({ Role: 'Decision Maker' }),
    ]);
    expect(target.roles()).toHaveLength(3);
    expect(
      result.objectResults.find((r) => r.objectApiName === 'OpportunityContactRole'),
    ).toMatchObject({ recordsCreated: 1, writtenByThePlatform: { records: 1, given: 1 } });
  });

  it('gives a role of rows placed by key the id of the platform’s record it was linked to', async () => {
    const template = rolesTemplate();
    const byKey = (childObject: string, lookupField: string, parentObject: string) =>
      ({
        childObject,
        lookupField,
        parentObject,
        parents: { kind: 'generated' },
        distribution: { mode: 'byKey' },
      }) satisfies SeedRelation;
    template.objects[1] = object(
      'Contact',
      1,
      1,
      [rule('AccountId', { referenceObject: 'Account' }, 'reference')],
      [{ key: 'c1', values: { LastName: 'Contact 1' } }],
    );
    template.objects[2] = object(
      'Opportunity',
      1,
      2,
      [],
      [
        {
          key: 'o1',
          parentKey: 'c1',
          values: { Name: 'Deal 1', StageName: 'Prospecting', CloseDate: '2026-12-31' },
        },
      ],
    );
    template.objects[3] = object(
      'OpportunityContactRole',
      1,
      3,
      [rule('ContactId', { referenceObject: 'Contact' }, 'reference')],
      [{ key: 'r1', parentKey: 'o1', values: { Role: 'Economic Buyer' } }],
    );
    template.relations = [
      byKey('Opportunity', 'ContactId', 'Contact'),
      byKey('OpportunityContactRole', 'OpportunityId', 'Opportunity'),
    ];
    const told: Record<string, Readonly<Record<string, string>>> = {};
    const target = roleWritingTarget();
    await new SeedOrchestrator(
      deps(target, {
        onRowIds: (objectApiName, ids) => {
          told[objectApiName] = ids;
        },
      }),
    ).execute(template, 'org');

    const [role] = target.roles();
    expect(target.roles()).toHaveLength(1);
    expect(role).toMatchObject({ Role: 'Economic Buyer', IsPrimary: true });
    expect(told['OpportunityContactRole']).toEqual({ r1: role.Id });
  });
});
