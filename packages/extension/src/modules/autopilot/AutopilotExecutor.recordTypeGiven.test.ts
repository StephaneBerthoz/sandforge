import { describe, it, expect, vi } from 'vitest';
import type { ApiName, AutopilotAnonymizationRule, ExecutionPlan } from '@sandforge/shared';
import {
  AutopilotExecutor,
  type AutopilotExecutorDeps,
  type AutopilotRunOptions,
  type ExecutionResult,
  type InsertFn,
  type QueryFn,
} from './AutopilotExecutor.js';
import { RecordIdRemapper } from './RecordIdRemapper.js';
import type { SmartAnonymizer } from './SmartAnonymizer.js';
import type { SoqlQuery } from '../../core/common/platformRecords.js';
import type { DescribedLookup } from '../../core/metadata/describedLookups.js';
import {
  parseRecordTypeCountsWithMaster,
  type RecordTypeAvailability,
} from '../../core/metadata/recordTypeAvailability.js';
import {
  RECORD_TYPE_READ_BACK_IDS,
  recordTypeGivenOf,
} from '../../core/metadata/recordTypeGiven.js';
import { RECORD_TYPES_SOQL } from '../sync/RecordTypeMapper.js';
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
 * said Master, and nothing to say. An Autopilot run said nothing of it at all.
 */

/** A fake id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const MASTER_ID = '012000000000000AAA';
const SOURCE_RETAIL = id('012', 1);
const TARGET_RETAIL = id('012', 101);
const TARGET_HIDDEN = id('012', 102);
const TARGET_PERSON = id('012', 201);

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

/** The record types statement the read back sends, its ids taken out. */
const READ_BACK =
  /^SELECT RecordTypeId, COUNT\(Id\) n FROM (\w+) WHERE Id IN \((.*)\) GROUP BY RecordTypeId$/;

/** The record types of both orgs by name, as `RECORD_TYPES_SOQL` reads them: Retail is SFX_Retail. */
const recordTypeRows = (org: 'source' | 'target') =>
  org === 'source'
    ? [
        {
          Id: SOURCE_RETAIL,
          Name: 'SFX Retail',
          DeveloperName: 'SFX_Retail',
          SobjectType: 'Opportunity',
        },
      ]
    : [
        {
          Id: TARGET_RETAIL,
          Name: 'SFX Retail',
          DeveloperName: 'SFX_Retail',
          SobjectType: 'Opportunity',
        },
        {
          Id: TARGET_HIDDEN,
          Name: 'SFX Hidden',
          DeveloperName: 'SFX_Hidden',
          SobjectType: 'Opportunity',
        },
      ];

/** An opportunity of the source, on `recordTypeId`. */
const opportunity = (n: number, recordTypeId: string | null): Record<string, unknown> => ({
  Id: id('006', n),
  Name: `SFX-OPP-${n}`,
  RecordTypeId: recordTypeId,
});

/** A plan of one object per wave, in the order given. */
function wavesOf(...objects: string[]): ExecutionPlan {
  return {
    waves: objects.map((name, order) => ({ order, objects: [name as ApiName], dependsOn: [] })),
    totalRecords: 0,
    estimatedDurationSec: 1,
    estimatedApiCalls: 1,
    complianceFramework: 'none',
    anonymizationSummary: {
      totalPiiFields: 0,
      totalFieldsToAnonymize: 0,
      methodBreakdown: {
        fake: 0,
        mask: 0,
        hash: 0,
        nullify: 0,
        redact: 0,
        shuffle: 0,
        truncate: 0,
        preserve_format: 0,
        age_band: 0,
        generalize: 0,
        constant: 0,
      },
      objectsWithPii: [],
    },
    cycleResolutions: [],
  };
}

/** An anonymizer that leaves every record as read. */
const asRead = {
  anonymize: (records: Record<string, unknown>[]) => records,
} as unknown as SmartAnonymizer;

/**
 * A source holding `rows`, and a target that gives a record created without a
 * record type the one the platform gives the user the run writes as for its
 * describe (`recordTypeGivenOf`), unless its automation sets another, and
 * answers the read back of the types its records hold. Every write, describe
 * read again and read back it is asked, and the lease given back, is logged
 * in `calls`, in order.
 */
function orgs(
  rows: Record<string, Record<string, unknown>[]>,
  {
    targetTypes = { Opportunity: TARGET_OPPORTUNITY },
    describedAgain = TARGET_OPPORTUNITY,
    automation,
    readBackRefused,
    creatable = new Set(['Name', 'RecordTypeId']),
  }: {
    targetTypes?: Record<string, RecordTypeAvailability[]>;
    /** What a describe read again gives, once a lease assigned a permission set. */
    describedAgain?: RecordTypeAvailability[];
    /** The record type the target's automation sets on a record created without one. */
    automation?: string;
    readBackRefused?: Error;
    creatable?: ReadonlySet<string>;
  } = {},
) {
  const calls: string[] = [];
  /** The record type each record the target holds went in with, by its id. */
  const held = new Map<string, string | null>();
  let next = 0;
  const query: QueryFn = async (objectApiName, afterId, limit) => {
    const list = rows[objectApiName] ?? [];
    const start = afterId === undefined ? 0 : list.findIndex((row) => row['Id'] === afterId) + 1;
    return list.slice(start, start + limit).map((row) => ({ ...row }));
  };
  const insert = vi.fn<InsertFn>(async (objectApiName, records) => {
    calls.push(`insert ${objectApiName}`);
    const given = recordTypeGivenOf(targetTypes[objectApiName] ?? []);
    return records.map((record) => {
      const newId = id(objectApiName === 'Account' ? '001' : '006', 900 + ++next);
      const sent = record['RecordTypeId'];
      held.set(
        newId,
        typeof sent === 'string'
          ? sent
          : (automation ?? (given.kind === 'given' ? given.info.recordTypeId : null)),
      );
      return { id: newId, success: true, errors: [] };
    });
  });
  const queryTarget = vi.fn<SoqlQuery>(async (soql) => {
    if (soql.startsWith(RECORD_TYPES_SOQL)) return recordTypeRows('target');
    const readBack = READ_BACK.exec(soql);
    if (!readBack) return [];
    calls.push(`read back ${readBack[1]}`);
    if (readBackRefused) throw readBackRefused;
    const counts = new Map<string | null, number>();
    for (const [, asked] of readBack[2].matchAll(/'([^']+)'/g)) {
      const type = held.get(asked);
      if (type !== undefined) counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return [...counts].map(([RecordTypeId, n]) => ({ RecordTypeId, n }));
  });
  /** The source's count of an object's records per record type, as the org answers it. */
  const countRecordTypes = vi.fn(async (objectApiName: string) => {
    const counted = new Map<unknown, number>();
    for (const row of rows[objectApiName] ?? []) {
      const type = row['RecordTypeId'] ?? null;
      counted.set(type, (counted.get(type) ?? 0) + 1);
    }
    return parseRecordTypeCountsWithMaster(
      [...counted].map(([RecordTypeId, n]) => ({ RecordTypeId, n })),
    );
  });
  /** The source by id: a count per record type of the ids asked, as the read back counts the target's. */
  const querySource = vi.fn<SoqlQuery>(async (soql) => {
    if (soql.startsWith(RECORD_TYPES_SOQL)) return recordTypeRows('source');
    const byIds = READ_BACK.exec(soql);
    if (!byIds) return [];
    const asked = new Set([...byIds[2].matchAll(/'([^']+)'/g)].map(([, value]) => value));
    const counted = new Map<unknown, number>();
    for (const row of rows[byIds[1]] ?? []) {
      if (!asked.has(String(row['Id']))) continue;
      const type = row['RecordTypeId'] ?? null;
      counted.set(type, (counted.get(type) ?? 0) + 1);
    }
    return [...counted].map(([RecordTypeId, n]) => ({ RecordTypeId, n }));
  });
  const deps: AutopilotExecutorDeps = {
    query,
    insert,
    anonymizer: asRead,
    remapper: new RecordIdRemapper(),
    batchSize: 200,
    querySource,
    queryTarget,
    describeCreateableFields: async () => creatable,
    describeRecordTypes: async (objectApiName) => targetTypes[objectApiName] ?? [],
    describeRecordTypesAgain: vi.fn(async (objectApiName: string) => {
      calls.push(`describe again ${objectApiName}`);
      return objectApiName === 'Opportunity' ? describedAgain : (targetTypes[objectApiName] ?? []);
    }),
    countRecordTypes,
  };
  return { deps, calls, held, insert, queryTarget, querySource, countRecordTypes };
}

/** Run the plan of `rows`' objects, one a wave, in the order given. */
function run(
  deps: AutopilotExecutorDeps,
  rows: Record<string, Record<string, unknown>[]>,
  options: AutopilotRunOptions = {},
): Promise<ExecutionResult> {
  const rules: AutopilotAnonymizationRule[] = [];
  return new AutopilotExecutor(deps).execute(
    wavesOf(...Object.keys(rows)),
    [],
    rules,
    new Map(Object.entries(rows).map(([name, list]) => [name, list.length])),
    undefined,
    new Map(),
    { keepContactPoints: true, ...options },
  );
}

/** A lease that assigned `assigned` permission sets, its giving back logged in `calls`. */
function leaseOf(calls: string[], assigned: number) {
  const giveBack = vi.fn(async () => {
    calls.push('lease given back');
  });
  return { lease: { assigned, giveBack }, giveBack };
}

describe('AutopilotExecutor — the record type the target gave the records created without one', () => {
  it('says how many went without one, the type the describe gives them, and what the first were read back holding', async () => {
    const rows = {
      Opportunity: [opportunity(1, null), opportunity(2, MASTER_ID), opportunity(3, SOURCE_RETAIL)],
    };
    const { deps, insert } = orgs(rows);

    const result = await run(deps, rows);

    // The two on Master go without one; the third on the target's type of its name.
    const sent = insert.mock.calls[0]?.[1] ?? [];
    expect(sent.map((record) => record['RecordTypeId'])).toEqual([
      undefined,
      undefined,
      TARGET_RETAIL,
    ]);
    expect(result.objectOutcomes?.['Opportunity']?.recordTypeGiven).toEqual({
      objectApiName: 'Opportunity',
      rows: 2,
      why: { masterInSource: 2 },
      predicted: { developerName: 'SFX_Retail', label: 'SFX Retail', basis: 'onlyOneOpen' },
      readBack: {
        read: 2,
        types: [{ developerName: 'SFX_Retail', label: 'SFX Retail', rows: 2 }],
      },
    });
  });

  it("says what the read back found, not the prediction, when the target's automation set another type", async () => {
    const rows = { Opportunity: [opportunity(1, null)] };
    const { deps } = orgs(rows, { automation: TARGET_HIDDEN });

    const result = await run(deps, rows);

    expect(result.objectOutcomes?.['Opportunity']?.recordTypeGiven).toMatchObject({
      predicted: { developerName: 'SFX_Retail' },
      readBack: { read: 1, types: [{ developerName: 'SFX_Hidden', rows: 1 }] },
    });
  });

  it('reads back one request an object, of the first 200 created, and says on how many', async () => {
    const many = Array.from({ length: 250 }, (_, i) => opportunity(i + 1, null));
    const rows = { Opportunity: many };
    const { deps, calls, queryTarget } = orgs(rows);

    const result = await run(deps, rows);

    expect(calls.filter((call) => call.startsWith('read back'))).toEqual(['read back Opportunity']);
    const asked = queryTarget.mock.calls
      .map(([soql]) => READ_BACK.exec(soql))
      .find((match) => match !== null);
    expect([...(asked?.[2] ?? '').matchAll(/'([^']+)'/g)]).toHaveLength(RECORD_TYPE_READ_BACK_IDS);
    expect(result.objectOutcomes?.['Opportunity']?.recordTypeGiven).toMatchObject({
      rows: 250,
      readBack: { read: 200 },
    });
  });

  it("says a read back the org refused in the org's words, and the run stays whole", async () => {
    const rows = { Opportunity: [opportunity(1, null)] };
    const { deps } = orgs(rows, {
      readBackRefused: new Error('INVALID_TYPE: sObject type Opportunity is not supported'),
    });

    const result = await run(deps, rows);

    expect(result.completedObjects).toEqual(['Opportunity']);
    expect(result.failedObjects).toEqual([]);
    expect(result.objectOutcomes?.['Opportunity']?.recordTypeGiven?.readBack).toEqual({
      read: 0,
      types: [],
      unread: 'INVALID_TYPE: sObject type Opportunity is not supported',
    });
  });

  it('counts apart the records whose record type the run does not write', async () => {
    const rows = {
      Opportunity: [opportunity(1, SOURCE_RETAIL), { Id: id('006', 2), Name: 'No type read' }],
    };
    const { deps } = orgs(rows, { creatable: new Set(['Name']) });

    const result = await run(deps, rows);

    expect(result.objectOutcomes?.['Opportunity']?.recordTypeGiven).toMatchObject({
      rows: 2,
      why: { notRead: 2 },
    });
  });

  it('says nothing of records sent with their type, nor of an object whose target has no type besides Master', async () => {
    const typed = { Opportunity: [opportunity(1, SOURCE_RETAIL)] };
    const typedOrgs = orgs(typed);
    const masterOnly = { Opportunity: [opportunity(1, null)] };
    const masterOnlyOrgs = orgs(masterOnly, { targetTypes: { Opportunity: [MASTER] } });

    const typedResult = await run(typedOrgs.deps, typed);
    const masterOnlyResult = await run(masterOnlyOrgs.deps, masterOnly);

    expect(typedResult.objectOutcomes?.['Opportunity']).not.toHaveProperty('recordTypeGiven');
    expect(masterOnlyResult.objectOutcomes?.['Opportunity']).not.toHaveProperty('recordTypeGiven');
    expect(typedOrgs.calls.concat(masterOnlyOrgs.calls)).not.toContain('read back Opportunity');
  });

  it('says Master, with nothing predicted, where two other types are open to the user', async () => {
    const rows = { Opportunity: [opportunity(1, null)] };
    const { deps } = orgs(rows, { targetTypes: { Opportunity: TARGET_OPPORTUNITY_TWO_OPEN } });

    const result = await run(deps, rows);

    const given = result.objectOutcomes?.['Opportunity']?.recordTypeGiven;
    expect(given).not.toHaveProperty('predicted');
    expect(given?.readBack?.types).toEqual([{ developerName: 'Master', label: 'Master', rows: 1 }]);
  });

  describe('under the lease of the mute', () => {
    it('reads the record types again before the first write once the lease assigned a set, and predicts from what that describe gives', async () => {
      const rows = { Opportunity: [opportunity(1, null)] };
      const { deps, calls } = orgs(rows, { describedAgain: TARGET_OPPORTUNITY_TWO_OPEN });
      const { lease } = leaseOf(calls, 1);

      const result = await run(deps, rows, { lease });

      expect(calls.indexOf('describe again Opportunity')).toBeLessThan(
        calls.indexOf('insert Opportunity'),
      );
      // Two open once the set was assigned: Master, nothing predicted.
      expect(result.objectOutcomes?.['Opportunity']?.recordTypeGiven).not.toHaveProperty(
        'predicted',
      );
    });

    it('reads no describe again when the lease assigned none', async () => {
      const rows = { Opportunity: [opportunity(1, null)] };
      const { deps, calls } = orgs(rows, { describedAgain: TARGET_OPPORTUNITY_TWO_OPEN });
      const { lease } = leaseOf(calls, 0);

      const result = await run(deps, rows, { lease });

      expect(deps.describeRecordTypesAgain).not.toHaveBeenCalled();
      expect(result.objectOutcomes?.['Opportunity']?.recordTypeGiven).toMatchObject({
        predicted: { developerName: 'SFX_Retail', basis: 'onlyOneOpen' },
      });
    });

    it('keeps the write path in its order: the describes read again, the writes, the lease given back, the read back, the result', async () => {
      // Two waves: the read back of the accounts waits for the opportunities,
      // the run's last write.
      const rows = {
        Account: [{ Id: id('001', 1), Name: 'Acme', RecordTypeId: null }],
        Opportunity: [opportunity(1, null)],
      };
      const { deps, calls } = orgs(rows, {
        targetTypes: {
          Account: [
            recordType(id('012', 301), 'Business', { defaultRecordTypeMapping: true }),
            MASTER,
          ],
          Opportunity: TARGET_OPPORTUNITY,
        },
      });
      calls.push('lease taken');
      const { lease, giveBack } = leaseOf(calls, 1);

      const result = await run(deps, rows, { lease });
      calls.push('result');

      const steps = calls.flatMap((call): WritePathStep[] => {
        if (call === 'lease taken') return ['leaseAcquire'];
        if (call.startsWith('describe again')) return ['afterLeaseCheck'];
        if (call.startsWith('insert')) return ['write'];
        if (call === 'lease given back') return ['leaseRelease'];
        if (call.startsWith('read back')) return ['recordTypeReadBack'];
        return call === 'result' ? ['result'] : [];
      });
      expect(writePathOrderDefects(['reads', 'leasePlan', 'question', ...steps])).toEqual([]);
      // Counted: the lease given back once; a describe again, a write and a
      // read back an object.
      expect(giveBack).toHaveBeenCalledTimes(1);
      expect(steps.filter((step) => step === 'write')).toHaveLength(2);
      expect(steps.filter((step) => step === 'afterLeaseCheck')).toHaveLength(2);
      expect(steps.filter((step) => step === 'recordTypeReadBack')).toHaveLength(2);
      expect(result.objectOutcomes?.['Account']?.recordTypeGiven).toMatchObject({
        predicted: { developerName: 'Business', basis: 'userDefault' },
        readBack: { read: 1 },
      });
    });

    it('gives the lease back and reads back what it created when it was stopped part way', async () => {
      const rows = {
        Opportunity: Array.from({ length: 3 }, (_, i) => opportunity(i + 1, null)),
      };
      const { deps, calls, insert } = orgs(rows);
      const stop = new AbortController();
      insert.mockImplementationOnce(async (_objectApiName, records) => {
        calls.push('insert Opportunity');
        stop.abort();
        return records.map((_, i) => ({ id: id('006', 900 + i), success: true, errors: [] }));
      });
      const { lease, giveBack } = leaseOf(calls, 1);

      const result = await new AutopilotExecutor({ ...deps, batchSize: 1 }).execute(
        wavesOf('Opportunity'),
        [],
        [],
        new Map([['Opportunity', 3]]),
        stop.signal,
        new Map(),
        { keepContactPoints: true, lease },
      );

      expect(result.stopped).toBe(true);
      expect(giveBack).toHaveBeenCalledTimes(1);
      expect(calls.indexOf('lease given back')).toBeLessThan(
        calls.indexOf('read back Opportunity'),
      );
      expect(result.objectOutcomes?.['Opportunity']?.recordTypeGiven).toMatchObject({ rows: 1 });
    });

    it('gives the lease back as a run that died ends', async () => {
      const rows = { Opportunity: [opportunity(1, null)] };
      const { deps, calls } = orgs(rows);
      const { lease, giveBack } = leaseOf(calls, 1);
      const recordCounts = new Map([['Opportunity', 1]]);
      // Fault injected outside the per-object guard, so the whole run dies
      // rather than a single node.
      recordCounts.get = () => {
        throw new Error('record counts unavailable');
      };

      await expect(
        new AutopilotExecutor(deps).execute(
          wavesOf('Opportunity'),
          [],
          [],
          recordCounts,
          undefined,
          new Map(),
          { lease },
        ),
      ).rejects.toThrow('record counts unavailable');

      expect(giveBack).toHaveBeenCalledTimes(1);
    });
  });
});

describe('AutopilotExecutor.recordTypesGivenOf — what a plan says before the run', () => {
  it('counts the records on Master by the count that keeps them, and names the type the describe gives', async () => {
    const rows = {
      Opportunity: [
        ...Array.from({ length: 23 }, (_, i) => opportunity(i + 1, null)),
        ...Array.from({ length: 4 }, (_, i) => opportunity(100 + i, SOURCE_RETAIL)),
      ],
    };
    const { deps, insert } = orgs(rows);

    const given = await new AutopilotExecutor(deps).recordTypesGivenOf(
      wavesOf('Opportunity'),
      new Map([['Opportunity', 27]]),
    );

    expect(given.get('Opportunity')).toEqual({
      objectApiName: 'Opportunity',
      rows: 23,
      why: { masterInSource: 23 },
      predicted: { developerName: 'SFX_Retail', label: 'SFX Retail', basis: 'onlyOneOpen' },
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('counts a parent read by id by its ids alone, never its table', async () => {
    const rows = {
      Opportunity: Array.from({ length: 10 }, (_, i) => opportunity(i + 1, null)),
    };
    const { deps, countRecordTypes } = orgs(rows);
    const parentIds = new Map([['Opportunity', [id('006', 2), id('006', 5), id('006', 7)]]]);

    const given = await new AutopilotExecutor(deps).recordTypesGivenOf(
      wavesOf('Opportunity'),
      new Map([['Opportunity', 3]]),
      parentIds,
    );

    expect(given.get('Opportunity')?.rows).toBe(3);
    expect(countRecordTypes).not.toHaveBeenCalled();
  });

  it('says no more than the run copies of a table cut to its first records', async () => {
    const rows = { Opportunity: Array.from({ length: 10 }, (_, i) => opportunity(i + 1, null)) };
    const { deps } = orgs(rows);

    const given = await new AutopilotExecutor(deps).recordTypesGivenOf(
      wavesOf('Opportunity'),
      new Map([['Opportunity', 4]]),
      new Map(),
      [{ objectApiName: 'Opportunity', copied: 4, total: 10 }],
    );

    expect(given.get('Opportunity')?.rows).toBe(4);
  });

  it('says every record goes without one when the target does not let the run send RecordTypeId', async () => {
    const rows = { Opportunity: [opportunity(1, SOURCE_RETAIL), opportunity(2, null)] };
    const { deps, countRecordTypes } = orgs(rows, { creatable: new Set(['Name']) });

    const given = await new AutopilotExecutor(deps).recordTypesGivenOf(
      wavesOf('Opportunity'),
      new Map([['Opportunity', 2]]),
    );

    expect(given.get('Opportunity')).toMatchObject({ rows: 2, why: { notRead: 2 } });
    expect(countRecordTypes).not.toHaveBeenCalled();
  });

  it('says nothing of an object whose target has no type besides Master, nor of one the source will not count', async () => {
    const rows = { Opportunity: [opportunity(1, null)], Lead: [{ Id: id('00Q', 1) }] };
    const { deps, countRecordTypes } = orgs(rows, {
      targetTypes: { Opportunity: TARGET_OPPORTUNITY, Lead: [MASTER] },
    });
    countRecordTypes.mockRejectedValue(new Error("No such column 'RecordTypeId' on entity"));

    const given = await new AutopilotExecutor(deps).recordTypesGivenOf(
      wavesOf('Opportunity', 'Lead'),
      new Map([
        ['Opportunity', 1],
        ['Lead', 1],
      ]),
    );

    expect(given.size).toBe(0);
    expect(countRecordTypes).toHaveBeenCalledTimes(1);
  });
});

describe('AutopilotExecutor — a person account sent without its record type', () => {
  /** What an org with person accounts lets an insert of an account carry. */
  const CREATABLE = new Set(['Name', 'FirstName', 'LastName', 'PersonEmail', 'RecordTypeId']);
  /** The target's Account for the user: Master the default, the person type the only one open. */
  const ONLY_PERSON_OPEN = [
    recordType(TARGET_PERSON, 'PersonAccount'),
    recordType(id('012', 202), 'Business', { available: false }),
    MASTER,
  ];
  const lookup = (name: string, referenceTo: string[]): DescribedLookup => ({
    name,
    referenceTo,
    createable: true,
    updateable: true,
  });

  it('goes in as a person account where the person type is the only one open, though the describe names Master', async () => {
    // Read from the default the describe names alone, the row was taken for
    // a business account and sent with its name, which the platform refuses
    // of a person account.
    const person = {
      Id: id('001', 1),
      Name: 'Ada Example',
      FirstName: 'Ada',
      LastName: 'Example',
      PersonEmail: 'ada@example.invalid',
      IsPersonAccount: true,
      RecordTypeId: null,
    };
    const rows = { Account: [person] };
    const { deps, insert } = orgs(rows, {
      targetTypes: { Account: ONLY_PERSON_OPEN },
      creatable: CREATABLE,
    });
    deps.describeLookups = async () => [
      lookup('OwnerId', ['User']),
      { ...lookup('PersonContactId', ['Contact']), createable: false, updateable: false },
    ];
    const queryTarget = deps.queryTarget!;
    deps.queryTarget = async (soql) =>
      soql.includes('IsPersonType = true') ? [{ Id: TARGET_PERSON }] : queryTarget(soql);

    await run(deps, rows);

    const sent = insert.mock.calls[0]?.[1][0] ?? {};
    expect(sent).not.toHaveProperty('Name');
    expect(sent['LastName']).toBe('Example');
  });
});
