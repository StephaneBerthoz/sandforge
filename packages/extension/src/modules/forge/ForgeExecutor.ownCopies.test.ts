import { describe, it, expect, vi } from 'vitest';
import { forgeRunCreatedRecords, forgeRunLinkedKept } from '@sandforge/shared';
import type { ForgeGraph, ForgeGraphEdge, ForgeGraphNode } from '@sandforge/shared';
import { canonicalRecordId } from '../../core/common/existingRecordMatch.js';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
  ExecutionSummary,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeProgressEvent,
  InsertResult,
} from './ForgeExecutor.js';
import { ForgeRunStore, memoryRunFile } from './ForgeRunStore.js';
import { JournalPart } from './journalRecords.js';
import { removeRunRecords, type RemovalOrg, type RunRecords } from './ForgeRunRemoval.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * Run for real on a whole org into a Developer Edition, the source held ten
 * pairs of accounts under one external id the target keeps unique. The run
 * wrote the first account of each pair; the target refused the second as a
 * copy of the record the run had just created, named that record, and the
 * second row was linked to it. That record is the run's own. Read as one the
 * target held before the run, the verification counted ten accounts more
 * than the run created, and the removal said success with the ten still in
 * the org, its line saying "13 record(s) the target already held … stay" of
 * the ten and the three the target did hold.
 */

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  updateable: name !== 'Id',
  isReference: false,
  ...overrides,
});

const FIELDS: Record<string, FieldInfo[]> = {
  Account: [field('Id'), field('Name'), field('Ext__c')],
  Contact: [
    field('Id'),
    field('LastName'),
    field('AccountId', { isReference: true, referenceTo: ['Account'], nillable: true }),
  ],
};

/** A source id: the object's prefix, then `n`. */
const src = (prefix: string, n: number): string => `${prefix}Sr${String(n).padStart(10, '0')}AAA`;

/** An id the target gives, with its true checksum: the org names it by its first fifteen. */
const targetId = (prefix: string, n: number): string =>
  canonicalRecordId(`${prefix}Tg${String(n).padStart(10, '0')}`) ?? '';

/** The account the target held before the run, under the external id of one source account. */
const HELD = targetId('001', 900);

/** Two pairs under one external id each, and one account the target already holds. */
const SOURCE: Record<string, Record<string, unknown>[]> = {
  Account: [
    { Id: src('001', 1), Name: 'Pair one', Ext__c: 'P1' },
    { Id: src('001', 2), Name: 'Pair one, again', Ext__c: 'P1' },
    { Id: src('001', 3), Name: 'Pair two', Ext__c: 'P2' },
    { Id: src('001', 4), Name: 'Pair two, again', Ext__c: 'P2' },
    { Id: src('001', 5), Name: 'Held', Ext__c: 'H1' },
  ],
  Contact: [
    { Id: src('003', 1), LastName: 'Under the second of a pair', AccountId: src('001', 2) },
    { Id: src('003', 2), LastName: 'Under the held one', AccountId: src('001', 5) },
  ],
};

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: SOURCE[objectApiName]?.length ?? 0,
    fieldCount: 3,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 2,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'rest',
  };
}

const CONTACTS: ForgeGraphEdge = {
  sourceObject: 'Account',
  targetObject: 'Contact',
  relationshipName: 'Contacts',
  type: 'lookup',
};

const GRAPH: ForgeGraph = {
  nodes: [node('Account', 0), node('Contact', 1)],
  edges: [CONTACTS],
  totalRecords: 0,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

const RUN_STARTED = '2026-11-14T04:58:00.000Z';
const BEFORE_THE_RUN = '2026-11-01T09:00:00.000Z';

/** A record of the target: its object, its fields, and when it was created. */
interface Held {
  object: string;
  row: Record<string, unknown>;
  created: string;
}

/**
 * A source holding {@link SOURCE}, and a target that keeps `Account.Ext__c`
 * unique: a row under an external id it holds already is refused with the
 * org's words, naming that record by its first fifteen characters, whether
 * the target held it before the run or the run has just written it. The
 * target is also the org a removal of the run deletes from.
 */
function orgs() {
  const records = new Map<string, Held>([
    [HELD, { object: 'Account', row: { Name: 'Held', Ext__c: 'H1' }, created: BEFORE_THE_RUN }],
  ]);
  let created = 0;
  const twinOf = (object: string, ext: unknown): string | undefined =>
    typeof ext === 'string'
      ? [...records].find(([, held]) => held.object === object && held.row['Ext__c'] === ext)?.[0]
      : undefined;
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? []),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org !== 'src') return [];
      const object = /FROM (\w+)/.exec(soql)?.[1] ?? '';
      return (SOURCE[object] ?? []).map((row) => ({ ...row }));
    }),
    insertRecords: vi.fn(async (_org: string, object: string, sent: Record<string, unknown>[]) =>
      sent.map((row): InsertResult => {
        const twin = twinOf(object, row['Ext__c']);
        if (twin) {
          return {
            id: '',
            success: false,
            errors: [
              `DUPLICATE_VALUE: duplicate value found: Ext__c duplicates value on record with id: ${twin.slice(0, 15)}`,
            ],
          };
        }
        const id = targetId(object.slice(0, 3), created++);
        records.set(id, { object, row: { ...row }, created: '2026-11-14T04:58:30.000Z' });
        return { id, success: true, errors: [] };
      }),
    ),
    updateRecords: vi.fn(async (_org: string, _object: string, sent: Record<string, unknown>[]) =>
      sent.map((row) => ({ id: String(row['Id']), success: true, errors: [] })),
    ),
  } satisfies ForgeExecutorDeps;

  const target: RemovalOrg = {
    query: async (soql: string) => {
      const list = /WHERE Id IN \((.*)\)$/.exec(soql)?.[1];
      if (!list) return { totalSize: 0, done: true, records: [] };
      const asked = new Set(list.split(', ').map((quoted) => quoted.slice(1, 16)));
      const found = [...records]
        .filter(([id]) => asked.has(id.slice(0, 15)))
        .map(([id, held]) => ({
          Id: id,
          CreatedDate: held.created,
          LastModifiedDate: held.created,
        }));
      return { totalSize: found.length, done: true, records: found };
    },
    destroy: async (_object: string, ids: string | string[]) => {
      const sent = Array.isArray(ids) ? ids : [ids];
      return sent.map((id) => {
        const key = [...records.keys()].find((held) => held.slice(0, 15) === id.slice(0, 15));
        if (key) records.delete(key);
        return { id, success: key !== undefined, errors: [] };
      });
    },
    update: async () => [],
    describe: async (name: string) => ({ name, label: name, fields: [], childRelationships: [] }),
    describeGlobal: async () => ({ sobjects: [] }),
    serverTime: async () => '2026-11-14T06:00:00.000Z',
    userId: async () => '005000000000001AAA',
    queryDeleted: async () => ({ records: [] }),
  } as unknown as RemovalOrg;

  return { executor: new ForgeExecutor(deps), records, target };
}

/** What the removal is handed of a summary that keeps its ids: what `--remove` plans from it. */
function planOf(summary: ExecutionSummary) {
  return forgeRunCreatedRecords({
    idRemapTable: summary.remapTable,
    idRemapExisting: [...summary.existingSourceIds, ...summary.updatedSourceIds],
    idRemapCreated: summary.createdByObject,
  });
}

/** Remove what `plan` names from the target, dated by the run, and say what is left there. */
async function removed(
  { records, target }: ReturnType<typeof orgs>,
  plan: Parameters<typeof removeRunRecords>[1],
): Promise<string[]> {
  const outcome = await removeRunRecords(target, plan, {
    runStartedAt: new Date(RUN_STARTED),
    runEndedAt: new Date('2026-11-14T05:00:00.000Z'),
    includeChanged: false,
  });
  expect(outcome.cancelled).toBe(false);
  return [...records.keys()];
}

describe('a record the run created, that a later row of the run is linked to', () => {
  it('is the run’s to remove, with its children, and only what the target held before stays', async () => {
    const orgsOfTheRun = orgs();

    const summary = await orgsOfTheRun.executor.execute(GRAPH, 'src', 'tgt', () => undefined);

    // Each second of a pair is linked to the first, which the run wrote; the
    // held one to the target's own; the contact under a second of a pair is
    // written under the record the run made for the first.
    expect(summary.linkedCount).toBe(3);
    expect(summary.remapTable[src('001', 2)].slice(0, 15)).toBe(
      summary.remapTable[src('001', 1)].slice(0, 15),
    );
    expect(summary.remapTable[src('001', 5)]).toBe(HELD);

    const plan = planOf(summary);
    expect(plan.map(({ objectApiName, ids }) => [objectApiName, ids.length])).toEqual([
      ['Contact', 2],
      ['Account', 2],
    ]);
    // Said to stay: the record the target held, and no account of the run.
    expect(
      forgeRunLinkedKept({
        idRemapTable: summary.remapTable,
        idRemapExisting: summary.existingSourceIds,
        idRemapCreated: summary.createdByObject,
      }),
    ).toEqual([src('001', 5)]);

    expect(await removed(orgsOfTheRun, plan)).toEqual([HELD]);
  });

  it('is the run’s to remove when the run keeps its ids in its journal, and counted apart from what stays', async () => {
    const orgsOfTheRun = orgs();
    const file = memoryRunFile(
      `${JSON.stringify({ run: { journalId: 'j', targetOrgId: 'tgt', startedAt: RUN_STARTED } })}\n`,
    );
    const store = ForgeRunStore.open(file);

    const summary = await orgsOfTheRun.executor.execute(GRAPH, 'src', 'tgt', () => undefined, {
      stream: { store, summaryBound: 0 },
    });
    store.close();

    expect(summary.remapInJournal).toBe(true);
    expect(summary.linkedCount).toBe(3);
    // Of the three rows linked, two to an account the run wrote: they go with it.
    expect(summary.linkedToCreatedCount).toBe(2);

    const records: RunRecords | undefined = JournalPart.read(file, 0)?.runRecords();
    if (!records) throw new Error('not read');
    expect(records.objects).toEqual([
      { objectApiName: 'Contact', count: 2 },
      { objectApiName: 'Account', count: 2 },
    ]);

    expect(await removed(orgsOfTheRun, records)).toEqual([HELD]);
  });
});

/** The line `objectName` ended on, as the run said it. */
function endedOn(events: readonly ForgeProgressEvent[], objectName: string): string {
  const ended = events.filter(
    (event) => event.objectName === objectName && event.status === 'done',
  );
  return ended[ended.length - 1]?.message ?? '';
}

describe('the line of an object whose rows were linked to records the run created', () => {
  const OWN = '2 linked to records the run created (the target refused them as copies of those)';

  it('says them apart from the record the target held, as the summary and its object do', async () => {
    const events: ForgeProgressEvent[] = [];
    const summary = await orgs().executor.execute(GRAPH, 'src', 'tgt', (event) => {
      events.push(event);
    });

    const line = endedOn(events, 'Account');
    expect(line).toContain('2 succeeded, 1 linked to records already in the target, ' + OWN);
    expect(line).not.toContain('3 linked to records already in the target');
    expect(summary.linkedCount).toBe(3);
    expect(summary.linkedToCreatedCount).toBe(2);
    expect(summary.existingRecords).toEqual([
      { objectApiName: 'Account', linked: 3, linkedToCreated: 2, unidentified: 0 },
    ]);
  });

  it('says them so of a run that keeps its ids in its journal', async () => {
    const events: ForgeProgressEvent[] = [];
    const file = memoryRunFile(
      `${JSON.stringify({ run: { journalId: 'j', targetOrgId: 'tgt', startedAt: RUN_STARTED } })}\n`,
    );
    const store = ForgeRunStore.open(file);

    const summary = await orgs().executor.execute(
      GRAPH,
      'src',
      'tgt',
      (event) => {
        events.push(event);
      },
      { stream: { store, summaryBound: 0 } },
    );
    store.close();

    expect(endedOn(events, 'Account')).toContain(
      '2 succeeded, 1 linked to records already in the target, ' + OWN,
    );
    expect(summary.linkedToCreatedCount).toBe(2);
  });

  it('says them so of an object read page by page, its pages added up', async () => {
    const events: ForgeProgressEvent[] = [];
    const summary = await orgs().executor.execute(
      GRAPH,
      'src',
      'tgt',
      (event) => {
        events.push(event);
      },
      { stream: { pageSize: 2 } },
    );

    expect(events.some((event) => event.message?.startsWith('Account, page 2:'))).toBe(true);
    expect(endedOn(events, 'Account')).toContain(
      '2 succeeded, 1 linked to records already in the target, ' + OWN,
    );
    expect(summary.existingRecords).toEqual([
      { objectApiName: 'Account', linked: 3, linkedToCreated: 2, unidentified: 0 },
    ]);
  });
});
