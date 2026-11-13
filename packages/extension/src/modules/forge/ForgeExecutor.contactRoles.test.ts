import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { ForgeAbortedError, ForgeExecutor } from './ForgeExecutor.js';
import type {
  ExecuteOptions,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  ForgeWriteBoundary,
} from './ForgeExecutor.js';
import { leftOutLines, storageCheckOf, writePlanLines, writePlanOf } from './ForgeRunGate.js';
import { ForgeRunStore, memoryRunFile } from './ForgeRunStore.js';
import { partialSummaryOf } from './interruptedRun.js';
import { RehearsalWriter, rehearsalExecutorDeps } from './rehearsal/RehearsalWriter.js';
import { finishedRunStatus } from './runResult.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';
import {
  MADE_BY_THE_RUN,
  RUN_USER,
  answerContactRoles,
  secondsAfterItWentIn,
} from '../../test/contactRoleReads.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The clone of an opportunity with its contact and its one contact role,
 * primary, of the role Decision Maker. Run for real into a scratch org, the
 * target held two contact roles for the opportunity's copy: one the platform
 * wrote the second the opportunity went in — its contact the opportunity's
 * `ContactId`, primary, with no role, created by the user the run writes as —
 * and the run's, two seconds later. The run counted one, linked none, and its
 * removal took the platform's away with the opportunity. The target here
 * answers as that org did.
 */

const idField: FieldInfo = { name: 'Id', queryable: true, createable: false, isReference: false };
const text = (name: string): FieldInfo => ({
  name,
  queryable: true,
  createable: true,
  updateable: true,
  isReference: false,
});
const lookup = (
  name: string,
  target: string,
  { required = false, updateable = true }: { required?: boolean; updateable?: boolean } = {},
): FieldInfo => ({
  name,
  queryable: true,
  createable: true,
  updateable,
  isReference: true,
  referenceTo: [target],
  nillable: !required,
});

/** The fields of each object, as both orgs describe them. */
const FIELDS: Record<string, FieldInfo[]> = {
  Account: [idField, text('Name')],
  Contact: [idField, text('LastName'), lookup('AccountId', 'Account')],
  Opportunity: [
    idField,
    text('Name'),
    text('StageName'),
    lookup('AccountId', 'Account'),
    // The opportunity's primary contact, derived from its primary contact
    // role: createable, never updateable, as both orgs describe it.
    lookup('ContactId', 'Contact', { updateable: false }),
  ],
  OpportunityContactRole: [
    idField,
    lookup('OpportunityId', 'Opportunity', { required: true, updateable: false }),
    lookup('ContactId', 'Contact', { required: true }),
    text('Role'),
    text('IsPrimary'),
  ],
};

const ACCOUNT = '001SRC000000001AAA';
const BUYER = '003SRC000000001AAA';
const ADVISER = '003SRC000000002AAA';
const DEAL = '006SRC000000001AAA';
const BUYERS_ROLE = '00KSRC000000001AAA';
const ADVISERS_ROLE = '00KSRC000000002AAA';

/** The deal of the real run: its account, its contact, and the contact's role on it, primary. */
function sourceRows(): Record<string, FakeRow[]> {
  return {
    Account: [{ Id: ACCOUNT, Name: 'Customer' }],
    Contact: [{ Id: BUYER, LastName: 'Buyer', AccountId: ACCOUNT }],
    Opportunity: [
      {
        Id: DEAL,
        Name: 'Deal 01',
        StageName: 'Proposal/Price Quote',
        AccountId: ACCOUNT,
        ContactId: BUYER,
      },
    ],
    OpportunityContactRole: [
      {
        Id: BUYERS_ROLE,
        OpportunityId: DEAL,
        ContactId: BUYER,
        Role: 'Decision Maker',
        IsPrimary: true,
      },
    ],
  };
}

/** The same deal with a second contact, an adviser, on it with a role of its own. */
function withAnAdviser(tables = sourceRows()): Record<string, FakeRow[]> {
  tables['Contact'].push({ Id: ADVISER, LastName: 'Adviser', AccountId: ACCOUNT });
  tables['OpportunityContactRole'].push({
    Id: ADVISERS_ROLE,
    OpportunityId: DEAL,
    ContactId: ADVISER,
    Role: 'Technical Buyer',
    IsPrimary: false,
  });
  return tables;
}

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 1,
    fieldCount: 4,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 3,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'rest',
  };
}

const edge = (
  parent: string,
  child: string,
  { required = false, insertOnly = false }: { required?: boolean; insertOnly?: boolean } = {},
): ForgeGraphEdge => ({
  sourceObject: parent,
  targetObject: child,
  relationshipName: `${parent}To${child}`,
  type: 'lookup',
  ...(required ? { required: true } : {}),
  ...(insertOnly ? { insertOnly: true } : {}),
});

/** The graph discovery built around the opportunity. */
function dealGraph(): ForgeGraph {
  return {
    nodes: [
      node('Opportunity', 0),
      node('Account', 1),
      node('Contact', 1),
      node('OpportunityContactRole', 1),
    ],
    edges: [
      edge('Account', 'Opportunity'),
      edge('Account', 'Contact'),
      edge('Contact', 'Opportunity', { insertOnly: true }),
      edge('Opportunity', 'OpportunityContactRole', { required: true }),
      edge('Contact', 'OpportunityContactRole', { required: true }),
    ],
    totalRecords: 0,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };
}

const ROOTED_AT_THE_DEAL = { rootRecordId: DEAL, rootObjectApiName: 'Opportunity' };

/**
 * A target that writes, as it takes an opportunity sent with its `ContactId`,
 * a contact role of that contact, primary, with no role; and takes a contact
 * role sent beside it as a second one, as the real org did.
 */
class ContactRoleOrg {
  readonly tables: Record<string, FakeRow[]> = {
    Account: [],
    Contact: [],
    Opportunity: [],
    OpportunityContactRole: [],
  };
  /** What each insert call was sent, by object, in order. */
  readonly sent: Record<string, Array<Record<string, unknown>>> = {};
  /** What each update call was sent, by object, in order. */
  readonly updated: Record<string, Array<Record<string, unknown>>> = {};
  private issued = 0;

  /**
   * @param automationRole - The role of the opportunity's contact the
   *   target's automation writes in the same save as the platform's, if any:
   *   made the same second, by the same user, answered first.
   */
  constructor(private readonly automationRole?: string) {}

  query(soql: string): Array<Record<string, unknown>> {
    return (
      answerContactRoles(soql, this.tables['OpportunityContactRole'], (id) =>
        this.tables['Opportunity'].find((row) => row['Id'] === id),
      ) ?? selectRows(this.tables, soql)
    );
  }

  insert(objectApiName: string, rows: readonly Record<string, unknown>[]) {
    (this.sent[objectApiName] ??= []).push(...rows.map((row) => ({ ...row })));
    return rows.map((row) => {
      const id = this.idFor(objectApiName);
      const record: FakeRow = { Id: id, ...copied(row) };
      if (objectApiName === 'Opportunity') Object.assign(record, MADE_BY_THE_RUN);
      (this.tables[objectApiName] ??= []).push(record);
      const contact = row['ContactId'];
      if (objectApiName === 'Opportunity' && typeof contact === 'string' && contact !== '') {
        this.tables['OpportunityContactRole'].push({
          Id: this.idFor('OpportunityContactRole'),
          OpportunityId: id,
          ContactId: contact,
          Role: null,
          IsPrimary: true,
          ...MADE_BY_THE_RUN,
        });
        if (this.automationRole !== undefined) {
          this.tables['OpportunityContactRole'].unshift({
            Id: this.idFor('OpportunityContactRole'),
            OpportunityId: id,
            ContactId: contact,
            Role: this.automationRole,
            IsPrimary: true,
            ...MADE_BY_THE_RUN,
          });
        }
      }
      return { id, success: true, errors: [] as string[] };
    });
  }

  /**
   * A contact role made by hand under `opportunityId`, `seconds` after the
   * run wrote it, as the run's user: answered first, as the org answered it
   * once in five reads that asked no order.
   */
  byHand(opportunityId: string, contactId: string, role: string, seconds: number): string {
    const id = this.idFor('OpportunityContactRole');
    this.tables['OpportunityContactRole'].unshift({
      Id: id,
      OpportunityId: opportunityId,
      ContactId: contactId,
      Role: role,
      IsPrimary: true,
      CreatedDate: secondsAfterItWentIn(seconds),
      CreatedById: RUN_USER,
    });
    return id;
  }

  update(objectApiName: string, rows: readonly Record<string, unknown>[]) {
    (this.updated[objectApiName] ??= []).push(...rows.map((row) => ({ ...row })));
    return rows.map((row) => {
      const record = (this.tables[objectApiName] ?? []).find((r) => r['Id'] === row['Id']);
      if (!record) {
        return {
          id: String(row['Id']),
          success: false,
          errors: ['ENTITY_IS_DELETED: entity is deleted'],
        };
      }
      const fields = copied(row);
      delete fields['Id'];
      Object.assign(record, fields);
      return { id: String(row['Id']), success: true, errors: [] as string[] };
    });
  }

  /** The contact roles of an opportunity. */
  rolesOf(opportunityId: string): FakeRow[] {
    return this.tables['OpportunityContactRole'].filter(
      (role) => role['OpportunityId'] === opportunityId,
    );
  }

  private idFor(objectApiName: string): string {
    this.issued++;
    const prefix: Record<string, string> = {
      Account: '001',
      Contact: '003',
      Opportunity: '006',
      OpportunityContactRole: '00K',
    };
    return `${prefix[objectApiName] ?? 'a00'}TGT${String(this.issued).padStart(9, '0')}AAA`;
  }
}

/** A row's values as a fake org keeps them. */
function copied(row: Readonly<Record<string, unknown>>): FakeRow {
  const record: FakeRow = {};
  for (const [field, value] of Object.entries(row)) {
    if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
      record[field] = value;
    } else if (typeof value === 'number') {
      record[field] = String(value);
    }
  }
  return record;
}

/** The objects the target answers statements on. */
const TARGET_READS = /\bFROM (Account|Contact|Opportunity|OpportunityContactRole)\b/;

/** The source holding `tables`, and a target that writes a contact role with an opportunity. */
function orgs(tables: Record<string, FakeRow[]> = sourceRows(), automationRole?: string) {
  const target = new ContactRoleOrg(automationRole);
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? [idField]),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org === 'src') return selectRows(tables, soql);
      return TARGET_READS.test(soql) ? target.query(soql) : [];
    }),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) =>
      target.insert(object, rows),
    ),
    updateRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) =>
      target.update(object, rows),
    ),
  } satisfies ForgeExecutorDeps;
  return { deps, target };
}

/**
 * {@link orgs} holding `tables`, the source read as a run of whole tables
 * reads it: a table at a time in the order of its ids, a row a page, and
 * counted.
 */
function pagedOrgs(tables: Record<string, FakeRow[]> = sourceRows()) {
  const { deps, target } = orgs(tables);
  /** A whole table's read, as a run of whole tables asks it, in the order of the ids. */
  const whole = (soql: string): FakeRow[] | undefined => {
    const match =
      /^SELECT .+? FROM (\w+)(?: WHERE Id > '(\w+)')?(?: ORDER BY Id)?(?: LIMIT (\d+))?$/.exec(
        soql,
      );
    if (!match) return undefined;
    const [, object, after, limit] = match;
    return [...(tables[object] ?? [])]
      .sort((a, b) => String(a['Id']).localeCompare(String(b['Id'])))
      .filter((row) => after === undefined || String(row['Id']) > after)
      .slice(0, limit === undefined ? undefined : Number(limit));
  };
  /**
   * The roles' read of a run's gate, each role with its opportunity's
   * contact, as the org answers a relationship field: the roles whose
   * opportunity names one, in the order of their ids.
   */
  const rolesWithTheirOpportunity = (soql: string): Array<Record<string, unknown>> | undefined => {
    if (!/ FROM OpportunityContactRole WHERE .*Opportunity\.ContactId != null/.test(soql)) {
      return undefined;
    }
    const contactOf = new Map(
      (tables['Opportunity'] ?? []).map((row) => [row['Id'], row['ContactId'] ?? null]),
    );
    return [...(tables['OpportunityContactRole'] ?? [])]
      .filter((role) => contactOf.get(role['OpportunityId']))
      .sort((a, b) => String(a['Id']).localeCompare(String(b['Id'])))
      .map((role) => ({
        ...role,
        Opportunity: { ContactId: contactOf.get(role['OpportunityId']) ?? null },
      }));
  };
  const read = (soql: string): FakeRow[] => whole(soql) ?? selectRows(tables, soql);
  const paged = {
    ...deps,
    queryRecords: vi.fn(
      async (org: string, soql: string): Promise<Array<Record<string, unknown>>> =>
        org === 'src'
          ? (rolesWithTheirOpportunity(soql) ?? read(soql))
          : deps.queryRecords(org, soql),
    ),
    queryPages: (org: string, soql: string) =>
      (async function* pages(): AsyncGenerator<FakeRow[]> {
        if (org !== 'src') return;
        const rows = read(soql);
        if (rows.length === 0) yield [];
        for (let at = 0; at < rows.length; at += 1) yield rows.slice(at, at + 1);
      })(),
    countRecords: vi.fn(
      async (_org: string, soql: string) => tables[/FROM (\w+)/.exec(soql)?.[1] ?? '']?.length ?? 0,
    ),
  } satisfies ForgeExecutorDeps;
  return { deps: paged, target };
}

/** The deal's copy in the target. */
const copyOf = (target: ContactRoleOrg): string => String(target.tables['Opportunity'][0]['Id']);

describe('ForgeExecutor, an opportunity sent with its primary contact', () => {
  it("links the primary contact role to the one the platform writes with the opportunity, and gives it the source's role", async () => {
    const { deps, target } = orgs();
    const said: ForgeProgressEvent[] = [];

    const summary = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      (event) => said.push(event),
      ROOTED_AT_THE_DEAL,
    );

    const deal = copyOf(target);
    // One contact role, as the source holds one: the platform's, its role given.
    expect(target.sent['OpportunityContactRole']).toBeUndefined();
    expect(target.rolesOf(deal)).toEqual([
      expect.objectContaining({
        ContactId: String(target.tables['Contact'][0]['Id']),
        Role: 'Decision Maker',
        IsPrimary: true,
      }),
    ]);
    expect(target.updated['OpportunityContactRole']).toEqual([
      { Id: target.rolesOf(deal)[0]['Id'], Role: 'Decision Maker' },
    ]);
    expect(summary.errors).toEqual([]);
    expect(summary.failedCount).toBe(0);
    expect(finishedRunStatus(summary)).toBe('success');
    expect(summary.linkedCount).toBe(1);
    expect(summary.writtenByThePlatform).toEqual([
      { objectApiName: 'OpportunityContactRole', rows: 1 },
    ]);
    // Linked, never inserted, and deleted by the platform with the opportunity.
    expect(summary.existingSourceIds).toContain(BUYERS_ROLE);
    expect(summary.withTheirRecordSourceIds).toContain(BUYERS_ROLE);
    expect(summary.existingRecords).toEqual([]);
    expect(said.map((event) => event.message)).toContain(
      'Completed OpportunityContactRole: 0 succeeded, 1 written by the platform with their ' +
        "opportunity, for its contact, 1 given the source's fields it lacked, 0 failed",
    );
  });

  it("writes the source's role as read, and says why, where the target's automation writes a second role of the contact with the opportunity", async () => {
    // Two roles of the contact made the same second as the opportunity, by
    // the run's user: nothing tells which the platform wrote, and linking
    // either could give the source's role to the automation's.
    const { deps, target } = orgs(sourceRows(), 'Business User');

    const summary = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_DEAL,
    );

    const deal = copyOf(target);
    expect(target.updated['OpportunityContactRole']).toBeUndefined();
    expect(target.sent['OpportunityContactRole']).toEqual([
      expect.objectContaining({ OpportunityId: deal, Role: 'Decision Maker' }),
    ]);
    expect(target.rolesOf(deal).map((role) => role['Role'])).toEqual([
      'Business User',
      null,
      'Decision Maker',
    ]);
    // The source's role maps to the record the run inserted, the third.
    expect(summary.remapTable[BUYERS_ROLE]).toBe(target.rolesOf(deal)[2]['Id']);
    expect(summary.linkedCount).toBe(0);
    expect(summary.writtenByThePlatform ?? []).toEqual([]);
    expect(summary.errors).toEqual([
      expect.objectContaining({
        objectApiName: 'OpportunityContactRole',
        failedCount: 0,
        samples: [
          {
            recordSummary: '(contact roles the platform wrote with their opportunities)',
            messages: [
              '1 contact role(s) not linked to the one the platform wrote with their ' +
                'opportunity, so written as read: the target holds more than one role of their ' +
                'contact under it made with it, within a second, by the same user, and nothing ' +
                'tells which the platform wrote. The opportunity holds the role of its contact ' +
                'more than once.',
            ],
          },
        ],
      }),
    ]);
    expect(finishedRunStatus(summary)).toBe('success');
  });

  it('writes the role of another contact as read, beside the one the platform writes', async () => {
    const { deps, target } = orgs(withAnAdviser());

    const summary = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_DEAL,
    );

    const deal = copyOf(target);
    /** The copy of a contact in the target, by its last name. */
    const copyOfContact = (lastName: string): string =>
      String(target.tables['Contact'].find((contact) => contact['LastName'] === lastName)?.['Id']);
    expect(target.sent['OpportunityContactRole']).toEqual([
      expect.objectContaining({
        OpportunityId: deal,
        ContactId: copyOfContact('Adviser'),
        Role: 'Technical Buyer',
      }),
    ]);
    expect(
      target.rolesOf(deal).map((role) => [role['ContactId'], role['Role'], role['IsPrimary']]),
    ).toEqual([
      [copyOfContact('Buyer'), 'Decision Maker', true],
      [copyOfContact('Adviser'), 'Technical Buyer', false],
    ]);
    expect(summary.linkedCount).toBe(1);
    expect(finishedRunStatus(summary)).toBe('success');
  });

  it('writes the contact role as read when the opportunity goes in without its contact, the field left out', async () => {
    const { deps, target } = orgs();

    const summary = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      () => undefined,
      { ...ROOTED_AT_THE_DEAL, fieldExclusions: { Opportunity: ['ContactId'] } },
    );

    const deal = copyOf(target);
    expect(target.sent['OpportunityContactRole']).toHaveLength(1);
    expect(target.rolesOf(deal).map((role) => role['Role'])).toEqual(['Decision Maker']);
    expect(summary.linkedCount).toBe(0);
    expect(summary.writtenByThePlatform).toBeUndefined();
  });

  it('says in a dry run that the platform would write it with the opportunity, on the line of its read and on the line that ends it', async () => {
    // From the deal, and over whole tables, which write each object as they read it.
    for (const scoped of [true, false]) {
      const { deps } = scoped ? orgs() : pagedOrgs();
      const said: ForgeProgressEvent[] = [];

      const summary = await new ForgeExecutor(deps).execute(
        dealGraph(),
        'src',
        'tgt',
        (event) => said.push(event),
        scoped
          ? { ...ROOTED_AT_THE_DEAL, dryRun: true }
          : { stream: { pageSize: 1 }, dryRun: true },
      );

      expect(deps.insertRecords).not.toHaveBeenCalled();
      expect(deps.updateRecords).not.toHaveBeenCalled();
      expect(summary.errors).toEqual([]);
      expect(summary.wouldInsertCount).toBe(1 /* deal */ + 1 /* account */ + 1 /* contact */);
      expect(summary.linkedCount).toBe(1);
      expect(summary.writtenByThePlatform).toEqual([
        { objectApiName: 'OpportunityContactRole', rows: 1 },
      ]);
      const messages = said.map((event) => event.message);
      expect(messages).toContain(
        '[dry-run] OpportunityContactRole: 0 record(s) would be inserted, 1 would be written by ' +
          'the platform with their opportunity, for its contact',
      );
      expect(messages).toContainEqual(
        expect.stringMatching(
          /^Simulated OpportunityContactRole: 0 would be inserted, 1 written by the platform with their opportunity, for its contact, 0 failed/,
        ),
      );
    }
  });

  it('counts it nowhere at its gate, which holds --max-total and the storage to what the run writes, in a run or in a dry run', async () => {
    for (const dryRun of [false, true]) {
      const { deps, target } = orgs();
      let shown: ForgeWriteBoundary | undefined;

      const summary = await new ForgeExecutor(deps).execute(
        dealGraph(),
        'src',
        'tgt',
        () => undefined,
        {
          ...ROOTED_AT_THE_DEAL,
          dryRun,
          beforeWrite: async (boundary) => {
            shown = boundary;
          },
        },
      );

      const plan = writePlanOf(shown?.objects ?? []);
      const written = dryRun
        ? summary.wouldInsertCount
        : Object.values(target.sent).reduce((sum, rows) => sum + rows.length, 0);
      expect(written).toBe(3);
      expect(plan.totalRows).toBe(written);
      expect(plan.leftOut?.byThePlatform).toEqual([
        { objectApiName: 'OpportunityContactRole', rows: 1 },
      ]);
      expect(leftOutLines(plan.leftOut)).toEqual([
        '  not counted: OpportunityContactRole, 1 record(s) written by the platform with their ' +
          'opportunity, for its contact, which the run links to and does not send',
      ]);
    }
  });

  it('links it in a run of whole tables read page by page, and says it on the line that ends the roles', async () => {
    const { deps, target } = pagedOrgs(withAnAdviser());
    const said: ForgeProgressEvent[] = [];

    const summary = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      (event) => said.push(event),
      { stream: { pageSize: 1 } },
    );

    const deal = copyOf(target);
    expect(target.rolesOf(deal).map((role) => [role['Role'], role['IsPrimary']])).toEqual([
      ['Decision Maker', true],
      ['Technical Buyer', false],
    ]);
    expect(target.sent['OpportunityContactRole']).toHaveLength(1);
    expect(finishedRunStatus(summary)).toBe('success');
    expect(said.map((event) => event.message)).toContainEqual(
      expect.stringMatching(
        /^Completed OpportunityContactRole: 1 succeeded, 1 written by the platform with their opportunity, for its contact, 1 given the source's fields it lacked, 0 failed/,
      ),
    );
  });

  it('counts at the gate of a run read page by page what the run writes, the role the platform writes said apart', async () => {
    // On a scratch org the gate of a run of whole tables said "write gate: 4
    // record(s) … counted in: up to 1 OpportunityContactRole", and the run
    // wrote 3 and linked the role.
    const { deps, target } = pagedOrgs();
    let shown: ForgeWriteBoundary | undefined;

    await new ForgeExecutor(deps).execute(dealGraph(), 'src', 'tgt', () => undefined, {
      stream: { pageSize: 1 },
      beforeWrite: async (boundary) => {
        shown = boundary;
      },
    });

    const plan = writePlanOf(shown?.objects ?? []);
    expect(plan.totalRows).toBe(3);
    const sent = Object.values(target.sent).reduce((sum, rows) => sum + rows.length, 0);
    expect(sent).toBe(plan.totalRows);
    const lines = writePlanLines(plan, storageCheckOf(plan, { maxMB: 5, remainingMB: 5 }), 'TGT');
    expect(lines).toContain(
      '  not counted: OpportunityContactRole, 1 record(s) written by the platform with their ' +
        'opportunity, for its contact, which the run links to and does not send',
    );
    expect(lines.some((line) => line.includes('counted in: up to'))).toBe(false);
    // Sent without its contact, the opportunity gets no role of the platform's.
    const without = pagedOrgs();
    let alone: ForgeWriteBoundary | undefined;
    await new ForgeExecutor(without.deps).execute(dealGraph(), 'src', 'tgt', () => undefined, {
      stream: { pageSize: 1 },
      fieldExclusions: { Opportunity: ['ContactId'] },
      beforeWrite: async (boundary) => {
        alone = boundary;
      },
    });
    expect(writePlanOf(alone?.objects ?? []).objects.some((o) => o.mayBeByThePlatform)).toBe(false);
    expect(writePlanOf(alone?.objects ?? []).leftOut?.byThePlatform).toBeUndefined();
  });

  it('says at the gate of a run read page by page how many roles the platform may write, counted in, where the roles could not be read', async () => {
    const { deps } = pagedOrgs();
    const reading = deps.queryRecords.getMockImplementation();
    deps.queryRecords.mockImplementation(async (org: string, soql: string) => {
      if (soql.includes('Opportunity.ContactId != null')) {
        throw new Error(
          'INVALID_FIELD: semi join sub-selects are not allowed with the OR operator',
        );
      }
      return (await reading?.(org, soql)) ?? [];
    });
    let shown: ForgeWriteBoundary | undefined;

    await new ForgeExecutor(deps).execute(dealGraph(), 'src', 'tgt', () => undefined, {
      stream: { pageSize: 1 },
      beforeWrite: async (boundary) => {
        shown = boundary;
      },
    });

    const plan = writePlanOf(shown?.objects ?? []);
    expect(plan.totalRows).toBe(4);
    expect(
      writePlanLines(plan, storageCheckOf(plan, { maxMB: 5, remainingMB: 5 }), 'TGT'),
    ).toContain(
      '  counted in: up to 1 OpportunityContactRole record(s) the platform may write itself with ' +
        'their opportunity, for its contact, which the run then links to and does not send',
    );
  });

  it('links it all the same when the target refuses the update, and says the fields it went without', async () => {
    const { deps, target } = orgs();
    deps.updateRecords.mockImplementation(async (_org, _object, rows) =>
      rows.map((row) => ({
        id: String(row['Id']),
        success: false,
        errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: A role needs a reason'],
      })),
    );

    const summary = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      () => undefined,
      ROOTED_AT_THE_DEAL,
    );

    const deal = copyOf(target);
    expect(target.sent['OpportunityContactRole']).toBeUndefined();
    expect(target.rolesOf(deal)).toHaveLength(1);
    expect(summary.linkedCount).toBe(1);
    expect(summary.errors).toEqual([
      {
        objectApiName: 'OpportunityContactRole',
        stage: 'insert',
        failedCount: 0,
        attemptedCount: 1,
        samples: [
          {
            recordSummary: '(contact roles the platform wrote with their opportunities)',
            messages: [
              "Linked, and left as the platform wrote them, without the fields of the source's " +
                `roles: ${String(target.rolesOf(deal)[0]['Id'])}: FIELD_CUSTOM_VALIDATION_EXCEPTION: ` +
                'A role needs a reason',
            ],
          },
        ],
      },
    ]);
  });

  it('counts it at its gate when the opportunity goes in without its contact', async () => {
    const { deps } = orgs();
    let shown: ForgeWriteBoundary | undefined;

    await new ForgeExecutor(deps).execute(dealGraph(), 'src', 'tgt', () => undefined, {
      ...ROOTED_AT_THE_DEAL,
      fieldExclusions: { Opportunity: ['ContactId'] },
      beforeWrite: async (boundary) => {
        shown = boundary;
      },
    });

    const plan = writePlanOf(shown?.objects ?? []);
    expect(plan.totalRows).toBe(4);
    expect(plan.leftOut?.byThePlatform).toBeUndefined();
  });
});

/**
 * The deal's clone stopped once the target took the opportunity: the account,
 * the contact and the opportunity in, the platform's role written with it,
 * and none of the source's roles sent. What the run threw, the target as it
 * stands, and the journal it kept when it was given one.
 */
async function stoppedAfterTheOpportunity(journaled = false, tables = sourceRows()) {
  const { deps, target } = orgs(tables);
  const executor = new ForgeExecutor(deps);
  deps.insertRecords.mockImplementation(
    async (_org: string, object: string, rows: Record<string, unknown>[]) => {
      const answered = target.insert(object, rows);
      if (object === 'Opportunity') executor.abort();
      return answered;
    },
  );
  const disk = memoryRunFile();
  const store = journaled ? ForgeRunStore.open(disk) : undefined;
  const stopped = await executor
    .execute(dealGraph(), 'src', 'tgt', () => undefined, {
      ...ROOTED_AT_THE_DEAL,
      ...(store ? { stream: { store } } : {}),
    })
    .then(
      () => undefined,
      (err: unknown) => err,
    );
  store?.close();
  deps.insertRecords.mockImplementation(
    async (_org: string, object: string, rows: Record<string, unknown>[]) =>
      target.insert(object, rows),
  );
  return { deps, target, stopped, disk };
}

describe('ForgeExecutor, a run that writes the roles of an opportunity a run before it wrote', () => {
  it('links the role to the one the platform wrote with the opportunity of the run it retries, and sends none', async () => {
    const { deps, target, stopped } = await stoppedAfterTheOpportunity();
    expect(stopped).toBeInstanceOf(ForgeAbortedError);
    const deal = copyOf(target);
    // The platform's role is in the target, the run's is not.
    expect(target.rolesOf(deal)).toHaveLength(1);
    const said: ForgeProgressEvent[] = [];

    const retried = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      (event) => said.push(event),
      { ...ROOTED_AT_THE_DEAL, writtenBefore: partialSummaryOf(stopped)?.remapTable },
    );

    // One role, as the source holds one: the platform's, its role given.
    expect(target.sent['OpportunityContactRole']).toBeUndefined();
    expect(target.rolesOf(deal)).toEqual([
      expect.objectContaining({ Role: 'Decision Maker', IsPrimary: true }),
    ]);
    expect(retried.remapTable[BUYERS_ROLE]).toBe(target.rolesOf(deal)[0]['Id']);
    expect(retried.failedCount).toBe(0);
    expect(finishedRunStatus(retried)).toBe('success');
    expect(said.map((event) => event.message)).toContain(
      'Completed OpportunityContactRole: 0 succeeded, 1 written by the platform with their ' +
        "opportunity, for its contact, 1 given the source's fields it lacked, 0 failed",
    );
    // In the target before this run, written with the opportunity of the run
    // it retries, which a removal of that run takes with it: none of this
    // run's to take.
    expect(retried.withTheirRecordSourceIds ?? []).not.toContain(BUYERS_ROLE);
    expect(retried.existingRecords).toEqual([
      { objectApiName: 'OpportunityContactRole', linked: 1, unidentified: 0 },
    ]);
  });

  it('links it when the run is taken up from its journal, and leaves it to go with the opportunity', async () => {
    const { deps, target, stopped, disk } = await stoppedAfterTheOpportunity(true);
    expect(stopped).toBeInstanceOf(ForgeAbortedError);
    const deal = copyOf(target);
    const store = ForgeRunStore.open(memoryRunFile(disk.text()));

    const resumed = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      () => undefined,
      { ...ROOTED_AT_THE_DEAL, stream: { store } },
    );
    store.close();

    expect(target.sent['OpportunityContactRole']).toBeUndefined();
    expect(target.rolesOf(deal)).toEqual([
      expect.objectContaining({ Role: 'Decision Maker', IsPrimary: true }),
    ]);
    expect(resumed.failedCount).toBe(0);
    expect(finishedRunStatus(resumed)).toBe('success');
    // The opportunity is the run's, written by the part that stopped: the
    // platform deletes the role with it.
    expect(resumed.withTheirRecordSourceIds).toContain(BUYERS_ROLE);
    expect(resumed.writtenByThePlatform).toEqual([
      { objectApiName: 'OpportunityContactRole', rows: 1 },
    ]);
  });

  it('links, taken up from its journal, the role the platform wrote with the opportunity, never one made by hand under it for the same contact after the part that stopped, which the target reads first', async () => {
    // On a scratch org: a role of the same contact, Influencer, made by hand
    // under the copy four seconds after the part that stopped; the resume
    // linked that one, gave it Decision Maker, and left the platform's with
    // no role, while its line said "1 written by the platform".
    const { deps, target, stopped, disk } = await stoppedAfterTheOpportunity(true);
    expect(stopped).toBeInstanceOf(ForgeAbortedError);
    const deal = copyOf(target);
    const [platforms] = target.rolesOf(deal);
    const buyer = String(target.tables['Contact'][0]['Id']);
    const byHand = target.byHand(deal, buyer, 'Influencer', 4);
    const store = ForgeRunStore.open(memoryRunFile(disk.text()));
    const said: ForgeProgressEvent[] = [];

    const resumed = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      (event) => said.push(event),
      { ...ROOTED_AT_THE_DEAL, stream: { store } },
    );
    store.close();

    expect(resumed.remapTable[BUYERS_ROLE]).toBe(platforms['Id']);
    const roleOf = (id: unknown) => target.rolesOf(deal).find((role) => role['Id'] === id);
    expect(roleOf(platforms['Id'])).toMatchObject({ Role: 'Decision Maker', IsPrimary: true });
    expect(roleOf(byHand)).toMatchObject({ Role: 'Influencer' });
    expect(target.updated['OpportunityContactRole']).toEqual([
      { Id: platforms['Id'], Role: 'Decision Maker' },
    ]);
    expect(target.sent['OpportunityContactRole']).toBeUndefined();
    expect(resumed.withTheirRecordSourceIds).toContain(BUYERS_ROLE);
    expect(said.map((event) => event.message)).toContain(
      'Completed OpportunityContactRole: 0 succeeded, 1 written by the platform with their ' +
        "opportunity, for its contact, 1 given the source's fields it lacked, 0 failed",
    );
  });

  it('counts at the gate of the run taken up what it writes, the role the platform wrote with the opportunity before said apart', async () => {
    // On a scratch org the resume's gate read "write gate: 6 record(s) …
    // OpportunityContactRole 1 … counted in: up to 1", and the resume linked
    // the role, sending none. The opportunity is in the target, which says
    // whether its role is before anything is written.
    const { deps, target, stopped, disk } = await stoppedAfterTheOpportunity(true);
    expect(stopped).toBeInstanceOf(ForgeAbortedError);
    const store = ForgeRunStore.open(memoryRunFile(disk.text()));
    let shown: ForgeWriteBoundary | undefined;

    await new ForgeExecutor(deps).execute(dealGraph(), 'src', 'tgt', () => undefined, {
      ...ROOTED_AT_THE_DEAL,
      stream: { store },
      beforeWrite: async (boundary) => {
        shown = boundary;
      },
    });
    store.close();

    const plan = writePlanOf(shown?.objects ?? []);
    expect(plan.totalRows).toBe(0);
    expect(plan.leftOut?.byThePlatform).toEqual([
      { objectApiName: 'OpportunityContactRole', rows: 1 },
    ]);
    const lines = writePlanLines(plan, storageCheckOf(plan, { maxMB: 5, remainingMB: 5 }), 'TGT');
    expect(lines).toContain(
      '  not counted: OpportunityContactRole, 1 record(s) written by the platform with their ' +
        'opportunity, for its contact, which the run links to and does not send',
    );
    expect(lines.some((line) => line.includes('counted in: up to'))).toBe(false);
    expect(target.sent['OpportunityContactRole']).toBeUndefined();
  });

  it('says at the gate of the run taken up how many roles the platform may have written, counted in, when the target would not say', async () => {
    const { deps, stopped, disk } = await stoppedAfterTheOpportunity(true);
    expect(stopped).toBeInstanceOf(ForgeAbortedError);
    const store = ForgeRunStore.open(memoryRunFile(disk.text()));
    const reading = deps.queryRecords.getMockImplementation();
    deps.queryRecords.mockImplementation(async (org: string, soql: string) => {
      if (org === 'tgt' && soql.includes('FROM OpportunityContactRole')) {
        throw new Error('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit exceeded.');
      }
      return (await reading?.(org, soql)) ?? [];
    });
    let shown: ForgeWriteBoundary | undefined;

    await new ForgeExecutor(deps).execute(dealGraph(), 'src', 'tgt', () => undefined, {
      ...ROOTED_AT_THE_DEAL,
      stream: { store },
      beforeWrite: async (boundary) => {
        shown = boundary;
      },
    });
    store.close();

    const plan = writePlanOf(shown?.objects ?? []);
    expect(plan.objects).toEqual([
      expect.objectContaining({
        objectApiName: 'OpportunityContactRole',
        rows: 1,
        mayBeByThePlatform: { rows: 1, before: true },
      }),
    ]);
    expect(
      writePlanLines(plan, storageCheckOf(plan, { maxMB: 5, remainingMB: 5 }), 'TGT'),
    ).toContain(
      '  counted in: up to 1 OpportunityContactRole record(s) the platform may have written with ' +
        'their opportunity, for its contact, in the run this one takes up, which the run then ' +
        'links to and does not send',
    );
  });

  it('simulates a retry linking the role the platform wrote with the opportunity before, as the retry links it', async () => {
    // The simulation of the run that retries read nothing of the target and
    // said the role "would be inserted", where the retry linked it.
    const { deps, target, stopped } = await stoppedAfterTheOpportunity();
    const said: ForgeProgressEvent[] = [];

    const simulated = await new ForgeExecutor(deps).execute(
      dealGraph(),
      'src',
      'tgt',
      (event) => said.push(event),
      { ...ROOTED_AT_THE_DEAL, dryRun: true, writtenBefore: partialSummaryOf(stopped)?.remapTable },
    );

    expect(said.map((event) => event.message)).toContainEqual(
      expect.stringMatching(
        /^Simulated OpportunityContactRole: 0 would be inserted, 1 written by the platform with their opportunity, for its contact/,
      ),
    );
    expect(simulated.wouldInsertCount).toBe(0);
    expect(target.sent['OpportunityContactRole']).toBeUndefined();
  });

  it('writes the role of another contact as read beside it, on a retry as in a run', async () => {
    const { deps, target, stopped } = await stoppedAfterTheOpportunity(false, withAnAdviser());
    const deal = copyOf(target);

    await new ForgeExecutor(deps).execute(dealGraph(), 'src', 'tgt', () => undefined, {
      ...ROOTED_AT_THE_DEAL,
      writtenBefore: partialSummaryOf(stopped)?.remapTable,
    });

    expect(target.sent['OpportunityContactRole']).toEqual([
      expect.objectContaining({ OpportunityId: deal, Role: 'Technical Buyer' }),
    ]);
    expect(target.rolesOf(deal).map((role) => [role['Role'], role['IsPrimary']])).toEqual([
      ['Decision Maker', true],
      ['Technical Buyer', false],
    ]);
  });
});

describe('ForgeExecutor, the opportunity of a role copied from outside the graph', () => {
  it('goes in without its contact, the platform writes no role with it, and the role goes in as read', async () => {
    // From the buyer, whose role names a deal the graph does not reach: the
    // expansion copies the deal without the lookups it holds, its ContactId
    // among them, so the target writes no role with it.
    const { deps, target } = orgs();
    const graph: ForgeGraph = {
      nodes: [node('Contact', 0), node('Account', 1), node('OpportunityContactRole', 1)],
      edges: [
        edge('Account', 'Contact'),
        edge('Contact', 'OpportunityContactRole', { required: true }),
      ],
      totalRecords: 0,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    };

    const summary = await new ForgeExecutor(deps).execute(graph, 'src', 'tgt', () => undefined, {
      rootRecordId: BUYER,
      rootObjectApiName: 'Contact',
      expandOrphanParents: true,
    });

    const deal = copyOf(target);
    expect(target.sent['Opportunity']).toHaveLength(1);
    expect(target.sent['Opportunity']?.[0]).not.toHaveProperty('ContactId');
    expect(target.rolesOf(deal).map((role) => role['Role'])).toEqual(['Decision Maker']);
    expect(summary.failedCount).toBe(0);
  });
});

describe('ForgeExecutor, a rehearsal of an opportunity sent with its primary contact', () => {
  const KEY_PREFIXES: Record<string, string> = {
    Account: '001',
    Contact: '003',
    Opportunity: '006',
    OpportunityContactRole: '00K',
  };

  /** The rows the rehearsal's writer keeps, prepared as the CLI's `--rehearse` prepares them. */
  async function rehearsed(tables = sourceRows(), options: ExecuteOptions = ROOTED_AT_THE_DEAL) {
    const { deps, target } = orgs(tables);
    const writer = new RehearsalWriter(async (object) => KEY_PREFIXES[object] ?? null);
    await new ForgeExecutor(rehearsalExecutorDeps(deps, writer)).execute(
      dealGraph(),
      'src',
      'tgt',
      () => undefined,
      options,
    );
    return { writer, target };
  }

  it('hands its writer none of the role the platform writes with the opportunity, as the run sends none', async () => {
    const { writer, target } = await rehearsed();

    expect(writer.rows.map((row) => row.objectApiName)).toEqual([
      'Account',
      'Contact',
      'Opportunity',
    ]);
    // Nothing reached the target.
    expect(target.tables['Opportunity']).toEqual([]);
  });

  it("hands it the role of another contact, under the opportunity's placeholder", async () => {
    const { writer } = await rehearsed(withAnAdviser());

    const deal = writer.rows.find((row) => row.objectApiName === 'Opportunity');
    const adviser = writer.rows.find(
      (row) => row.objectApiName === 'Contact' && row.fields['LastName'] === 'Adviser',
    );
    expect(writer.rows.filter((row) => row.objectApiName === 'OpportunityContactRole')).toEqual([
      expect.objectContaining({
        fields: expect.objectContaining({
          OpportunityId: deal?.placeholderId,
          ContactId: adviser?.placeholderId,
          Role: 'Technical Buyer',
        }),
      }),
    ]);
  });

  it('hands it the role as read when the opportunity goes in without its contact', async () => {
    const { writer } = await rehearsed(sourceRows(), {
      ...ROOTED_AT_THE_DEAL,
      fieldExclusions: { Opportunity: ['ContactId'] },
    });

    expect(writer.rows.filter((row) => row.objectApiName === 'OpportunityContactRole')).toEqual([
      expect.objectContaining({ fields: expect.objectContaining({ Role: 'Decision Maker' }) }),
    ]);
  });
});
