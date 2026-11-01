import { describe, it, expect, vi } from 'vitest';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';
import { ForgeExecutor } from './ForgeExecutor.js';
import type {
  ExecuteOptions,
  FieldInfo,
  ForgeExecutorDeps,
  ForgeWriteBoundary,
  ForgeWriteGateAnswer,
  InsertResult,
  TargetObjectInfo,
} from './ForgeExecutor.js';
import { finishedRunStatus } from './runResult.js';
import {
  RECORD_TYPE_READ_BACK_IDS,
  recordTypeGivenOf,
} from '../../core/metadata/recordTypeGiven.js';
import type { RecordTypeAvailability } from '../../core/metadata/recordTypeAvailability.js';
import { RECORD_TYPE_NAMES_SOQL } from '../../core/metadata/recordTypeNames.js';
import { selectRows, type FakeRow } from '../../test/fakeSoql.js';
import { writePathOrderDefects, type WritePathStep } from '../checkpoint/beforeRunCheckpoint.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * A record on Master in the source goes to the target without a record type,
 * and the target gives it the one it gives the user the run writes as. On a
 * scratch org whose admin's describe of Opportunity named Master the default,
 * with SFX_Retail open to the admin and SFX_Hidden kept from them, an
 * opportunity sent so went in as SFX_Retail: the describe's default alone
 * said Master, and nothing to say.
 */

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const ACCOUNT_ID = id('001', 1);
const MASTER_ID = '012000000000000AAA';
const SOURCE_RETAIL = id('012', 1);
const SOURCE_TRADE = id('012', 2);
const TARGET_RETAIL = id('012', 101);
const TARGET_HIDDEN = id('012', 102);

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  isReference: false,
  ...overrides,
});

const FIELDS: Record<string, FieldInfo[]> = {
  Account: [field('Id'), field('Name')],
  Opportunity: [
    field('Id'),
    field('Name'),
    field('AccountId', { isReference: true, referenceTo: ['Account'], nillable: true }),
    field('RecordTypeId', { isReference: true, referenceTo: ['RecordType'], nillable: true }),
  ],
};

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

/** An account and its opportunities. */
const GRAPH: ForgeGraph = {
  nodes: [node('Account', 0), node('Opportunity', 1)],
  edges: [
    {
      sourceObject: 'Account',
      targetObject: 'Opportunity',
      relationshipName: 'Opportunities',
      type: 'lookup',
    },
  ],
  totalRecords: 2,
  estimatedSizeMB: 0,
  estimatedDurationSeconds: 0,
};

/** A record type as the describe of the user the run writes as reads it: open and not the default unless told. */
const recordType = (
  recordTypeId: string,
  developerName: string,
  over: Partial<RecordTypeAvailability> = {},
): RecordTypeAvailability => ({
  recordTypeId,
  developerName,
  name: developerName.replace(/_/g, ' '),
  available: true,
  active: true,
  master: false,
  defaultRecordTypeMapping: false,
  ...over,
});

const MASTER = recordType(MASTER_ID, 'Master', { master: true, defaultRecordTypeMapping: true });

/** The target's Opportunity for its admin, as the scratch org's describe gave it (ids made up). */
const TARGET_OPPORTUNITY: RecordTypeAvailability[] = [
  recordType(TARGET_HIDDEN, 'SFX_Hidden', { available: false }),
  recordType(TARGET_RETAIL, 'SFX_Retail'),
  MASTER,
];

/** The same once a permission set opened SFX_Hidden as well: two open, Master the default. */
const TARGET_OPPORTUNITY_TWO_OPEN: RecordTypeAvailability[] = [
  recordType(TARGET_HIDDEN, 'SFX_Hidden'),
  recordType(TARGET_RETAIL, 'SFX_Retail'),
  MASTER,
];

const SOURCE_OPPORTUNITY: RecordTypeAvailability[] = [
  recordType(SOURCE_RETAIL, 'Retail'),
  recordType(SOURCE_TRADE, 'Trade'),
  MASTER,
];

const opportunity = (n: number, recordTypeId: string | null): FakeRow => ({
  Id: id('006', n),
  Name: `SFX-OPP-${n}`,
  AccountId: ACCOUNT_ID,
  RecordTypeId: recordTypeId,
});

/** Retail mapped onto SFX_Retail; Master and Trade go without one. */
const ROOTED: ExecuteOptions = {
  rootRecordId: ACCOUNT_ID,
  rootObjectApiName: 'Account',
  recordTypeMappings: [
    { sourceId: SOURCE_RETAIL, targetId: TARGET_RETAIL, developerName: 'Retail' },
  ],
};

/** Trade sent to the target's default by the user's decision. */
const TRADE_TO_THE_DEFAULT: ExecuteOptions['decisions'] = {
  recordTypeMappings: [{ object: 'Opportunity', from: 'Trade', to: null }],
};

/** The record types statement the read back sends, its ids taken out. */
const READ_BACK =
  /^SELECT RecordTypeId, COUNT\(Id\) n FROM (\w+) WHERE Id IN \((.*)\) GROUP BY RecordTypeId$/;

/**
 * A source holding an account and `opportunities`, and a target that gives
 * an opportunity created without a record type the one the platform gives
 * the user the run writes as for its describe (`recordTypeGivenOf`), unless
 * its automation sets another, and answers the read back of the types its
 * records hold. Every read, write and describe it is asked is logged in
 * `calls`, in order.
 */
function orgs(
  opportunities: FakeRow[],
  {
    targetTypes = TARGET_OPPORTUNITY,
    describedAgain = TARGET_OPPORTUNITY,
    automation,
    readBackRefused,
  }: {
    targetTypes?: RecordTypeAvailability[];
    /** What a describe read again gives, once a lease assigned a permission set. */
    describedAgain?: RecordTypeAvailability[];
    /** The record type the target's automation sets on an opportunity created without one. */
    automation?: string;
    readBackRefused?: Error;
  } = {},
) {
  const calls: string[] = [];
  const source: Record<string, FakeRow[]> = {
    Account: [{ Id: ACCOUNT_ID, Name: 'Acme' }],
    Opportunity: opportunities,
  };
  /** The record type each record the target holds went in with, by its id. */
  const held = new Map<string, string | null>();
  let next = 0;
  const deps = {
    describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? []),
    queryRecords: vi.fn(async (org: string, soql: string) => {
      if (org === 'src') {
        calls.push(`read ${/FROM (\w+)/.exec(soql)?.[1] ?? ''}`);
        return soql === RECORD_TYPE_NAMES_SOQL ? [] : selectRows(source, soql);
      }
      const readBack = READ_BACK.exec(soql);
      if (readBack) {
        calls.push(`read back ${readBack[1]}`);
        if (readBackRefused) throw readBackRefused;
        const counts = new Map<string | null, number>();
        for (const [, asked] of readBack[2].matchAll(/'([^']+)'/g)) {
          const type = held.get(asked);
          if (type !== undefined) counts.set(type, (counts.get(type) ?? 0) + 1);
        }
        return [...counts].map(([RecordTypeId, n]) => ({ RecordTypeId, n }));
      }
      if (soql === RECORD_TYPE_NAMES_SOQL) calls.push('read names');
      return [];
    }),
    insertRecords: vi.fn(async (_org: string, object: string, rows: Record<string, unknown>[]) => {
      calls.push(`insert ${object}`);
      return rows.map((row): InsertResult => {
        const newId = id(object === 'Account' ? '001' : '006', 900 + ++next);
        const sent = row['RecordTypeId'];
        const given = recordTypeGivenOf(targetTypes);
        held.set(
          newId,
          typeof sent === 'string'
            ? sent
            : (automation ?? (given.kind === 'given' ? given.info.recordTypeId : null)),
        );
        return { id: newId, success: true, errors: [] };
      });
    }),
    updateRecords: vi.fn(async (_org: string, _object: string, rows: Record<string, unknown>[]) => {
      calls.push('update');
      return rows.map((row) => ({ id: String(row['Id']), success: true, errors: [] }));
    }),
    describeObject: vi.fn(async (org: string, object: string): Promise<TargetObjectInfo> => {
      if (object !== 'Opportunity') return { keyPrefix: '001', recordTypes: [] };
      return { keyPrefix: '006', recordTypes: org === 'tgt' ? targetTypes : SOURCE_OPPORTUNITY };
    }),
    describeObjectAgain: vi.fn(async (_org: string, object: string): Promise<TargetObjectInfo> => {
      calls.push(`describe again ${object}`);
      return object === 'Opportunity'
        ? { keyPrefix: '006', recordTypes: describedAgain }
        : { keyPrefix: '001', recordTypes: [] };
    }),
  } satisfies ForgeExecutorDeps;
  return { deps, calls, held };
}

/** What the run's summary says of the opportunities created without a record type. */
const opportunitiesGiven = (summary: { recordTypesGiven?: Array<{ objectApiName: string }> }) =>
  summary.recordTypesGiven?.find((entry) => entry.objectApiName === 'Opportunity');

describe('ForgeExecutor, the record type the target gives a record sent without one', () => {
  it('says on a dry run that the opportunities sent without one would go in as the only type open to the user, and why each went without one', async () => {
    const { deps, calls } = orgs([
      opportunity(1, null),
      opportunity(2, SOURCE_RETAIL),
      opportunity(3, SOURCE_TRADE),
    ]);

    const summary = await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
      ...ROOTED,
      decisions: TRADE_TO_THE_DEFAULT,
      dryRun: true,
    });

    expect(deps.insertRecords).not.toHaveBeenCalled();
    // Master in the source, and Trade sent to the default, told apart; the
    // one mapped onto SFX_Retail goes with its type, and is not counted.
    expect(summary.recordTypesGiven).toEqual([
      {
        objectApiName: 'Opportunity',
        rows: 2,
        why: { masterInSource: 1, decidedDefault: 1 },
        predicted: { developerName: 'SFX_Retail', label: 'SFX Retail', basis: 'onlyOneOpen' },
      },
    ]);
    // A simulation created nothing, and reads nothing back.
    expect(calls.some((call) => call.startsWith('read back'))).toBe(false);
  });

  it('reads back once written what the target gave them, in one request after the last write, and keeps the prediction beside it', async () => {
    const { deps, calls } = orgs([
      opportunity(1, null),
      opportunity(2, SOURCE_RETAIL),
      opportunity(3, SOURCE_TRADE),
    ]);

    const summary = await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
      ...ROOTED,
      decisions: TRADE_TO_THE_DEFAULT,
    });

    expect(opportunitiesGiven(summary)).toEqual({
      objectApiName: 'Opportunity',
      rows: 2,
      why: { masterInSource: 1, decidedDefault: 1 },
      predicted: { developerName: 'SFX_Retail', label: 'SFX Retail', basis: 'onlyOneOpen' },
      readBack: { read: 2, types: [{ developerName: 'SFX_Retail', label: 'SFX Retail', rows: 2 }] },
    });
    // The account's target has no type besides Master: nothing to say, nothing read back.
    expect(summary.recordTypesGiven).toHaveLength(1);
    expect(calls.filter((call) => call.startsWith('read back'))).toEqual(['read back Opportunity']);
    expect(calls.indexOf('read back Opportunity')).toBeGreaterThan(
      calls.lastIndexOf('insert Opportunity'),
    );
  });

  it('says what the target holds when its automation set another type, and never takes the prediction for what was read back', async () => {
    const { deps } = orgs([opportunity(1, null), opportunity(4, null)], {
      automation: TARGET_HIDDEN,
    });

    const summary = await new ForgeExecutor(deps).execute(
      GRAPH,
      'src',
      'tgt',
      () => undefined,
      ROOTED,
    );

    expect(opportunitiesGiven(summary)).toMatchObject({
      rows: 2,
      predicted: { developerName: 'SFX_Retail', basis: 'onlyOneOpen' },
      readBack: { read: 2, types: [{ developerName: 'SFX_Hidden', label: 'SFX Hidden', rows: 2 }] },
    });
  });

  it('reads back the first 200 of 250 created in one request, and says it read 200 of them', async () => {
    const many = Array.from({ length: 250 }, (_, i) => opportunity(i + 1, null));
    const { deps } = orgs(many);

    const summary = await new ForgeExecutor(deps).execute(
      GRAPH,
      'src',
      'tgt',
      () => undefined,
      ROOTED,
    );

    const readBacks = deps.queryRecords.mock.calls.filter(([org, soql]) => {
      return org === 'tgt' && READ_BACK.test(soql);
    });
    expect(readBacks).toHaveLength(1);
    expect([...String(readBacks[0]?.[1]).matchAll(/'([^']+)'/g)]).toHaveLength(
      RECORD_TYPE_READ_BACK_IDS,
    );
    expect(opportunitiesGiven(summary)).toMatchObject({
      rows: 250,
      why: { masterInSource: 250 },
      readBack: { read: 200, types: [{ developerName: 'SFX_Retail', rows: 200 }] },
    });
  });

  it("says the org's words when the read back is refused, and the run is a success all the same", async () => {
    const { deps } = orgs([opportunity(1, null)], {
      readBackRefused: new Error('INVALID_TYPE: sObject type is not supported.'),
    });

    const summary = await new ForgeExecutor(deps).execute(
      GRAPH,
      'src',
      'tgt',
      () => undefined,
      ROOTED,
    );

    expect(opportunitiesGiven(summary)).toMatchObject({
      rows: 1,
      readBack: { read: 0, types: [], unread: 'INVALID_TYPE: sObject type is not supported.' },
    });
    expect(summary.successCount).toBe(2);
    expect(finishedRunStatus(summary)).toBe('success');
  });

  it('says nothing of rows that go with their record type, nor of an object whose target has none but Master', async () => {
    const typed = orgs([opportunity(2, SOURCE_RETAIL)]);
    const masterOnly = orgs([opportunity(1, null)], { targetTypes: [MASTER] });

    const withTheirType = await new ForgeExecutor(typed.deps).execute(
      GRAPH,
      'src',
      'tgt',
      () => undefined,
      ROOTED,
    );
    const onMasterAlone = await new ForgeExecutor(masterOnly.deps).execute(
      GRAPH,
      'src',
      'tgt',
      () => undefined,
      ROOTED,
    );

    expect(withTheirType.recordTypesGiven).toBeUndefined();
    expect(onMasterAlone.recordTypesGiven).toBeUndefined();
    expect([...typed.calls, ...masterOnly.calls].some((call) => call.startsWith('read back'))).toBe(
      false,
    );
  });

  it('says the opportunities stay on Master where two types are open to the user and the describe names Master', async () => {
    const { deps } = orgs([opportunity(1, null)], { targetTypes: TARGET_OPPORTUNITY_TWO_OPEN });

    const summary = await new ForgeExecutor(deps).execute(
      GRAPH,
      'src',
      'tgt',
      () => undefined,
      ROOTED,
    );

    expect(opportunitiesGiven(summary)).toEqual({
      objectApiName: 'Opportunity',
      rows: 1,
      why: { masterInSource: 1 },
      readBack: { read: 1, types: [{ developerName: 'Master', label: 'Master', rows: 1 }] },
    });
  });

  it('counts as not written the rows of an object whose record type the user excluded', async () => {
    const { deps } = orgs([opportunity(2, SOURCE_RETAIL)]);

    const summary = await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
      ...ROOTED,
      fieldExclusions: { Opportunity: ['RecordTypeId'] },
      dryRun: true,
    });

    expect(opportunitiesGiven(summary)).toMatchObject({ rows: 1, why: { notRead: 1 } });
  });

  describe('under the lease of the automation mute', () => {
    /** A gate that takes a lease which assigned `assigned` sets, and notes when it is given back. */
    function gate(calls: string[], assigned: number) {
      const seen: ForgeWriteBoundary[] = [];
      const giveBack = vi.fn(async () => {
        calls.push('lease given back');
      });
      const beforeWrite = vi.fn(async (boundary: ForgeWriteBoundary) => {
        calls.push('gate');
        seen.push(boundary);
        if (boundary.dryRun) return undefined;
        calls.push('lease taken');
        const answer: ForgeWriteGateAnswer = { lease: { assigned, giveBack } };
        return answer;
      });
      return { seen, giveBack, beforeWrite };
    }

    it('reads the describe of the object again once the lease assigned a permission set, and predicts from it', async () => {
      // The set assigned opened SFX_Hidden too: two open, and the platform
      // keeps a record sent without one on Master.
      const { deps, calls } = orgs([opportunity(1, null)], {
        describedAgain: TARGET_OPPORTUNITY_TWO_OPEN,
      });
      const { beforeWrite } = gate(calls, 1);

      const summary = await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
        ...ROOTED,
        beforeWrite,
      });

      // One describe again, of the object whose rows go without a type.
      expect(calls.filter((call) => call.startsWith('describe again'))).toEqual([
        'describe again Opportunity',
      ]);
      expect(opportunitiesGiven(summary)).not.toHaveProperty('predicted');
    });

    it('reads no describe again when the lease assigned none', async () => {
      const { deps, calls } = orgs([opportunity(1, null)], {
        describedAgain: TARGET_OPPORTUNITY_TWO_OPEN,
      });
      const { beforeWrite } = gate(calls, 0);

      const summary = await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
        ...ROOTED,
        beforeWrite,
      });

      expect(deps.describeObjectAgain).not.toHaveBeenCalled();
      expect(opportunitiesGiven(summary)).toMatchObject({
        predicted: { developerName: 'SFX_Retail', basis: 'onlyOneOpen' },
      });
    });

    it('keeps the write path in its order: the gate, the lease, the describes read again, the writes, the lease given back, the read back, the result', async () => {
      const { deps, calls } = orgs([opportunity(1, null)]);
      const { beforeWrite, giveBack } = gate(calls, 1);

      const summary = await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
        ...ROOTED,
        beforeWrite,
      });
      calls.push('result');

      const steps = calls.flatMap((call): WritePathStep[] => {
        if (call.startsWith('read ') && !call.startsWith('read back')) return ['reads'];
        if (call === 'gate') return ['question'];
        if (call === 'lease taken') return ['leaseAcquire'];
        if (call.startsWith('describe again')) return ['afterLeaseCheck'];
        if (call.startsWith('insert') || call === 'update') return ['write'];
        if (call === 'lease given back') return ['leaseRelease'];
        if (call.startsWith('read back')) return ['recordTypeReadBack'];
        return call === 'result' ? ['result'] : [];
      });
      expect(writePathOrderDefects(steps)).toEqual([]);
      // Counted: one gate, one lease taken and given back once, a write per
      // object, one describe again, one read back.
      expect(steps.filter((step) => step === 'question')).toHaveLength(1);
      expect(steps.filter((step) => step === 'leaseAcquire')).toHaveLength(1);
      expect(giveBack).toHaveBeenCalledTimes(1);
      expect(steps.filter((step) => step === 'write')).toHaveLength(2);
      expect(steps.filter((step) => step === 'afterLeaseCheck')).toHaveLength(1);
      expect(steps.filter((step) => step === 'recordTypeReadBack')).toHaveLength(1);
      expect(opportunitiesGiven(summary)).toHaveProperty('readBack.read', 1);
    });

    it('tells the gate the requests the read back takes: one for the object written without a type, and one for the names', async () => {
      const { deps, calls } = orgs([opportunity(1, null), opportunity(2, SOURCE_RETAIL)]);
      const { beforeWrite, seen } = gate(calls, 0);

      await new ForgeExecutor(deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
        ...ROOTED,
        beforeWrite,
      });

      expect(seen[0]?.readBack).toBe(2);
      // What it said is what the run sent past the gate for it.
      const past = calls.slice(calls.indexOf('gate'));
      expect(past.filter((call) => call === 'read names' || call.startsWith('read back'))).toEqual([
        'read names',
        'read back Opportunity',
      ]);
    });

    it('tells the gate of no read back when every row goes with its type, nor on a dry run', async () => {
      const typed = orgs([opportunity(2, SOURCE_RETAIL)]);
      const dry = orgs([opportunity(1, null)]);
      const typedGate = gate(typed.calls, 0);
      const dryGate = gate(dry.calls, 0);

      await new ForgeExecutor(typed.deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
        ...ROOTED,
        beforeWrite: typedGate.beforeWrite,
      });
      await new ForgeExecutor(dry.deps).execute(GRAPH, 'src', 'tgt', () => undefined, {
        ...ROOTED,
        beforeWrite: dryGate.beforeWrite,
        dryRun: true,
      });

      expect(typedGate.seen[0]).not.toHaveProperty('readBack');
      expect(dryGate.seen[0]).not.toHaveProperty('readBack');
    });
  });
});
