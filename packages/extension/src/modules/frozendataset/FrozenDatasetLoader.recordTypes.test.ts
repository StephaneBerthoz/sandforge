import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GuardDecision } from '@sandforge/shared';
import { ProductionGuard, withGivenAnswer } from '../../core/precheck/ProductionGuard.js';
import { writePathOrderDefects, type WritePathStep } from '../checkpoint/beforeRunCheckpoint.js';
import { LoadGuardError } from './LoadGuards.js';
import { SasPathGuard, findRepoRoot } from './SasPathGuard.js';
import { SasReferenceIdMappingStore } from './SasReferenceIdMappingStore.js';
import { TargetRecordTypeIdResolver } from './TargetRecordTypeIdResolver.js';
import {
  FrozenDatasetLoader,
  type FrozenDatasetLoaderDeps,
  type FrozenLoadOptions,
} from './FrozenDatasetLoader.js';
import type { FrozenDataset, FrozenRecord } from './types.js';
import type {
  FrozenDmlWriter,
  FrozenLoadProgressEvent,
  TargetObjectDescribe,
} from './loadTypes.js';

/*
 * What a load says of the record type the target gave what it created without
 * one, read from the describe of the user it writes as before it writes, and
 * from the records once written; and the order of its write path around them.
 * The org below answers as a scratch org's Opportunity did for its admin: Master
 * the describe's default, one other type open, and a record sent without a type
 * goes in with that one.
 */

const repoRoot = findRepoRoot(process.cwd());
const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-recordtypes-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) fs.rmSync(tmpDirs.pop() as string, { recursive: true, force: true });
});

const MASTER_ID = '012000000000000AAA';
const RETAIL_ID = '012C1000000000AAAA';
const HIDDEN_ID = '012C1000000000BAAA';
const OTHER_ID = '012C1000000000CAAA';
const USER_ID = '005C1000000000AAAA';

/** The record types of the object as the fixture's describe gives them to its admin. */
const FIXTURE_INFOS = [
  {
    developerName: 'SFX_Hidden',
    name: 'SFX Hidden',
    recordTypeId: HIDDEN_ID,
    available: false,
    active: true,
    master: false,
    defaultRecordTypeMapping: false,
  },
  {
    developerName: 'SFX_Retail',
    name: 'SFX Retail',
    recordTypeId: RETAIL_ID,
    available: true,
    active: true,
    master: false,
    defaultRecordTypeMapping: false,
  },
  {
    developerName: 'Master',
    name: 'Master',
    recordTypeId: MASTER_ID,
    available: true,
    active: true,
    master: true,
    defaultRecordTypeMapping: true,
  },
];

const OPPORTUNITY: TargetObjectDescribe = {
  name: 'Opportunity',
  fields: [
    {
      name: 'Name',
      type: 'string',
      createable: true,
      nillable: false,
      defaultedOnCreate: false,
    },
    {
      name: 'RecordTypeId',
      type: 'reference',
      createable: true,
      nillable: true,
      defaultedOnCreate: true,
      referenceTo: ['RecordType'],
    },
  ],
  recordTypeInfos: FIXTURE_INFOS,
};

function opportunity(n: number, recordTypeId?: string | null): FrozenRecord {
  return {
    referenceId: `Opportunity-${String(n).padStart(6, '0')}`,
    fields: {
      Name: `Deal ${n}`,
      ...(recordTypeId === undefined ? {} : { RecordTypeId: recordTypeId }),
    },
  };
}

function dataset(records: FrozenRecord[]): FrozenDataset {
  return {
    datasetVersion: '1.0.0',
    objects: [{ objectApiName: 'Opportunity', records }],
    recordTypes: {
      Opportunity: [
        { developerName: 'SFX_Hidden', name: 'SFX Hidden' },
        { developerName: 'SFX_Retail', name: 'SFX Retail' },
      ],
    },
    personContactSidecar: [],
  };
}

/** Ids shaped as the org's: a read back keeps only what could be one. */
function recordId(n: number): string {
  return `006C10${String(n).padStart(9, '0')}AAA`;
}

interface OrgOptions {
  describes?: Record<string, TargetObjectDescribe>;
  /** What a read back of the record types answers, by the ids it was asked about. */
  readBack?: (ids: string[]) => Array<Record<string, unknown>> | Promise<never>;
  log?: string[];
  guard?: ProductionGuard;
  /** The rows the identity keys find, by SOQL. */
  query?: (soql: string) => Array<Record<string, unknown>> | undefined;
  userId?: string;
}

const READ_BACK = /SELECT RecordTypeId, COUNT\(Id\) n FROM (\w+) WHERE Id IN \(([^)]*)\)/;

/** The target: it creates what it is sent, and reads back the type a record sent without one got. */
function orgOf(options: OrgOptions = {}) {
  const sasDir = makeTmpDir();
  const log = options.log ?? [];
  const readBacks: string[][] = [];
  let created = 0;
  const writer: FrozenDmlWriter = {
    insert: vi.fn(async (_org, _object, records: Array<Record<string, unknown>>) => {
      log.push('write');
      return records.map(() => ({ id: recordId(++created), success: true, errors: [] }));
    }),
    update: vi.fn(async (_org, _object, records: Array<Record<string, unknown>>) => {
      log.push('write');
      return records.map((r) => ({ id: String(r.Id), success: true, errors: [] }));
    }),
    delete: vi.fn(async (_org, _object, ids: string[]) => {
      log.push('write');
      return ids.map((id) => ({ id, success: true, errors: [] }));
    }),
  };
  const describes = options.describes ?? { Opportunity: OPPORTUNITY };
  const orgAccess = {
    query: vi.fn(async (_org: string, soql: string) => {
      const asked = READ_BACK.exec(soql);
      if (asked) {
        log.push('recordTypeReadBack');
        const ids = (asked[2] ?? '').split(', ').map((id) => id.replaceAll("'", ''));
        readBacks.push(ids);
        return options.readBack
          ? options.readBack(ids)
          : [{ RecordTypeId: RETAIL_ID, n: ids.length }];
      }
      return options.query?.(soql) ?? [];
    }),
    describe: vi.fn(async (_org: string, objectApiName: string) => {
      log.push(`describe ${objectApiName}`);
      const describe = describes[objectApiName];
      if (!describe) throw new Error(`sObject ${objectApiName} not found`);
      return describe;
    }),
    picklistValues: vi.fn(async () => []),
    ...(options.userId ? { userId: vi.fn(async () => options.userId as string) } : {}),
  };
  const mappingStore = new SasReferenceIdMappingStore(sasDir, {
    guard: new SasPathGuard(repoRoot),
  });
  const deps: FrozenDatasetLoaderDeps = {
    orgAccess,
    writer,
    guard: options.guard ?? new ProductionGuard(),
    mockDetector: { areCalloutsMocked: vi.fn(async () => true) },
    recordTypeResolver: new TargetRecordTypeIdResolver({
      query: async (_org, soql) => {
        const name = /DeveloperName = '(\w+)'/.exec(soql)?.[1];
        const found = FIXTURE_INFOS.find((info) => info.developerName === name);
        return found
          ? [{ Id: found.recordTypeId, DeveloperName: name, NamespacePrefix: null }]
          : [];
      },
      describe: orgAccess.describe,
    }),
    mappingStore,
    sasGuard: new SasPathGuard(repoRoot),
  };
  return { deps, sasDir, writer, orgAccess, readBacks, mappingStore, log };
}

function optionsOf(
  org: ReturnType<typeof orgOf>,
  data: FrozenDataset,
  overrides?: Partial<FrozenLoadOptions>,
): FrozenLoadOptions {
  return {
    orgId: '00D-target',
    orgTier: 'development',
    dataset: data,
    sasDir: org.sasDir,
    ...overrides,
  };
}

function loadOf(
  org: ReturnType<typeof orgOf>,
  data: FrozenDataset,
  overrides?: Partial<FrozenLoadOptions>,
) {
  return new FrozenDatasetLoader(org.deps).load(optionsOf(org, data, overrides));
}

function planOf(org: ReturnType<typeof orgOf>, data: FrozenDataset) {
  return new FrozenDatasetLoader(org.deps).planLoad(optionsOf(org, data));
}

const RETAIL_PREDICTED = {
  developerName: 'SFX_Retail',
  label: 'SFX Retail',
  basis: 'onlyOneOpen',
} as const;

describe('FrozenDatasetLoader — the record type the target gave what it created without one', () => {
  describe('in the preview', () => {
    it('predicts it from the describe of the user the load writes as, with no request of its own', async () => {
      const org = orgOf();

      const plan = await planOf(org, dataset([opportunity(1, null), opportunity(2, '')]));

      expect(plan.recordTypesGiven).toEqual([
        {
          objectApiName: 'Opportunity',
          rows: 2,
          why: { masterInSource: 2 },
          predicted: RETAIL_PREDICTED,
        },
      ]);
      // The describe of the alignment: nothing more is read, and nothing back.
      expect(org.orgAccess.describe).toHaveBeenCalledTimes(1);
      expect(org.readBacks).toEqual([]);
    });

    it('tells a record on Master from one whose type went, and from one that names none', async () => {
      const org = orgOf();

      const plan = await planOf(
        org,
        dataset([
          opportunity(1, null),
          // Named in the source, and closed to the user in the target.
          opportunity(2, 'SFX Hidden'),
          // Not there at all: the source's object had no type to read.
          opportunity(3),
          opportunity(4, 'SFX Retail'),
        ]),
      );

      expect(plan.recordTypesGiven?.[0]).toMatchObject({
        rows: 3,
        why: { masterInSource: 1, dropped: 1, notRead: 1 },
      });
    });

    it('says nothing of an object the target has no type for but Master', async () => {
      const master = FIXTURE_INFOS.filter((info) => info.master);
      const org = orgOf({
        describes: { Opportunity: { ...OPPORTUNITY, recordTypeInfos: master } },
      });

      const plan = await planOf(org, dataset([opportunity(1, null)]));

      expect(plan.recordTypesGiven).toBeUndefined();
    });

    it('says nothing of records that go with their type', async () => {
      const plan = await planOf(orgOf(), dataset([opportunity(1, 'SFX Retail')]));

      expect(plan.recordTypesGiven).toBeUndefined();
    });

    it('counts only what the load would insert: a record it links keeps its type', async () => {
      const org = orgOf({
        query: (soql) =>
          soql.includes('FROM Opportunity') && soql.includes('Name')
            ? [{ Id: '006C10000000099AAA', Name: 'Deal 1' }]
            : undefined,
      });
      org.deps.config = { identityKeys: { Opportunity: ['Name'] } };

      const plan = await new FrozenDatasetLoader(org.deps).planLoad(
        optionsOf(org, dataset([opportunity(1, null), opportunity(2, null)]), { reload: true }),
      );

      expect(plan.perObject[0]).toMatchObject({ toInsert: 1, reusedByKeys: 1 });
      expect(plan.recordTypesGiven?.[0]).toMatchObject({ rows: 1 });
    });

    it('gives no prediction where the org keeps Master, and counts the records all the same', async () => {
      // Two or more open under a Master default: what an insert gave with three.
      const twoOpen = FIXTURE_INFOS.map((info) =>
        info.developerName === 'SFX_Hidden' ? { ...info, available: true } : info,
      );
      const org = orgOf({
        describes: { Opportunity: { ...OPPORTUNITY, recordTypeInfos: twoOpen } },
      });

      const plan = await planOf(org, dataset([opportunity(1, null)]));

      expect(plan.recordTypesGiven).toEqual([
        { objectApiName: 'Opportunity', rows: 1, why: { masterInSource: 1 } },
      ]);
    });
  });

  describe('once written', () => {
    it('reads back what the records hold, once an object, and says it beside the prediction', async () => {
      const org = orgOf();

      const report = await loadOf(
        org,
        dataset([opportunity(1, null), opportunity(2, 'SFX Retail')]),
      );

      expect(report.recordTypesGiven).toEqual([
        {
          objectApiName: 'Opportunity',
          rows: 1,
          why: { masterInSource: 1 },
          predicted: RETAIL_PREDICTED,
          readBack: {
            read: 1,
            types: [{ developerName: 'SFX_Retail', label: 'SFX Retail', rows: 1 }],
          },
        },
      ]);
      // Only the record sent without a type is asked about.
      expect(org.readBacks).toEqual([[recordId(1)]]);
      const [sent] = vi.mocked(org.writer.insert).mock.calls[0]?.[2] ?? [];
      expect(sent).not.toHaveProperty('RecordTypeId');
    });

    it('asks about the first 200 in one request, and says how many there were', async () => {
      const org = orgOf();
      const records = Array.from({ length: 250 }, (_, n) => opportunity(n + 1, null));

      const report = await loadOf(org, dataset(records));

      expect(org.readBacks).toHaveLength(1);
      expect(org.readBacks[0]).toHaveLength(200);
      expect(report.recordTypesGiven?.[0]).toMatchObject({
        rows: 250,
        readBack: { read: 200 },
      });
    });

    it('says what the target holds where it differs: the read back, never the prediction', async () => {
      // An automation of the target set another on some of them.
      const org = orgOf({
        readBack: () => [
          { RecordTypeId: OTHER_ID, n: 2 },
          { RecordTypeId: RETAIL_ID, n: 1 },
          { RecordTypeId: null, n: 1 },
        ],
      });

      const report = await loadOf(org, dataset([1, 2, 3, 4].map((n) => opportunity(n, null))));

      expect(report.recordTypesGiven?.[0]?.readBack).toEqual({
        read: 4,
        types: [
          { developerName: OTHER_ID, label: OTHER_ID, rows: 2 },
          { developerName: 'SFX_Retail', label: 'SFX Retail', rows: 1 },
          { developerName: 'Master', label: 'Master', rows: 1 },
        ],
      });
      expect(report.recordTypesGiven?.[0]?.predicted).toEqual(RETAIL_PREDICTED);
    });

    it('fails nothing when the read is refused: the records are in, and the org words it', async () => {
      const org = orgOf({
        readBack: () => Promise.reject(new Error('REQUEST_LIMIT_EXCEEDED: TotalRequests Limit')),
      });

      const report = await loadOf(org, dataset([opportunity(1, null)]));

      expect(report.status).toBe('completed');
      expect(report.perObject[0]).toMatchObject({ inserted: 1 });
      expect(report.recordTypesGiven?.[0]?.readBack).toEqual({
        read: 0,
        types: [],
        unread: 'REQUEST_LIMIT_EXCEEDED: TotalRequests Limit',
      });
    });

    it('says nothing of a record the target refused, and reads nothing for it', async () => {
      const org = orgOf();
      vi.mocked(org.writer.insert).mockResolvedValueOnce([
        { success: false, errors: ['FIELD_CUSTOM_VALIDATION_EXCEPTION: refused'] },
      ] as never);

      const report = await loadOf(org, dataset([opportunity(1, null)]));

      expect(report.recordTypesGiven).toBeUndefined();
      expect(org.readBacks).toEqual([]);
    });
  });

  describe('of a record whose type the user cannot use', () => {
    it('names the type the target gives it in the issue, rather than a default', async () => {
      const org = orgOf();

      const report = await loadOf(org, dataset([opportunity(1, 'SFX Hidden')]));

      const [issue] = report.alignment.recordTypeIssues;
      expect(issue?.detail).toContain(
        'RecordTypeId dropped, the target gives it SFX_Retail, the only other record type open to the user.',
      );
      expect(report.recordTypesGiven?.[0]).toMatchObject({ rows: 1, why: { dropped: 1 } });
    });

    it("names the user's default where the describe names one", async () => {
      const profileDefault = FIXTURE_INFOS.map((info) => ({
        ...info,
        defaultRecordTypeMapping: info.developerName === 'SFX_Retail',
      }));
      const org = orgOf({
        describes: { Opportunity: { ...OPPORTUNITY, recordTypeInfos: profileDefault } },
      });

      const report = await loadOf(org, dataset([opportunity(1, 'SFX Hidden')]));

      expect(report.alignment.recordTypeIssues[0]?.detail).toContain(
        "the target gives it SFX_Retail, the user's default record type.",
      );
    });

    it('says the record stays on Master where the user has no other type open', async () => {
      const closed = FIXTURE_INFOS.map((info) =>
        info.master ? info : { ...info, available: false },
      );
      const org = orgOf({
        describes: { Opportunity: { ...OPPORTUNITY, recordTypeInfos: closed } },
      });

      const report = await loadOf(org, dataset([opportunity(1, 'SFX Hidden')]));

      expect(report.alignment.recordTypeIssues[0]?.detail).toContain(
        'the target leaves it on Master for that user.',
      );
    });
  });

  describe('its order around the lease', () => {
    /** The steps of a write path, in the order they happened. */
    function stepsOf(log: readonly string[]): WritePathStep[] {
      return log.flatMap((line): WritePathStep[] =>
        line === 'write' || line === 'leaseRelease' || line === 'recordTypeReadBack'
          ? [line as WritePathStep]
          : [],
      );
    }

    it('gives the lease back after its last write and reads the record types after that', async () => {
      const log: string[] = [];
      const org = orgOf({ log });
      const giveBack = vi.fn(async () => {
        log.push('leaseRelease');
      });

      await loadOf(org, dataset([opportunity(1, null)]), { lease: { giveBack } });

      const steps = stepsOf(log);
      expect(steps).toEqual(['write', 'leaseRelease', 'recordTypeReadBack']);
      expect(writePathOrderDefects(['leaseAcquire', ...steps, 'result'])).toEqual([]);
      expect(giveBack).toHaveBeenCalledTimes(1);
    });

    it('reads the describe it predicts from under the lease a load is given', async () => {
      // A set assigned before the load opened a type: read after it, the
      // describe says so, and nothing is held from before.
      const log: string[] = ['leaseAcquire'];
      const org = orgOf({ log });

      await loadOf(org, dataset([opportunity(1, null)]));

      expect(log.indexOf('leaseAcquire')).toBeLessThan(log.indexOf('describe Opportunity'));
      expect(log.indexOf('describe Opportunity')).toBeLessThan(log.indexOf('write'));
    });

    it('keeps the lease to its caller when the load stops before its last write', async () => {
      const stop = new AbortController();
      const org = orgOf();
      vi.mocked(org.writer.insert).mockImplementationOnce(async () => {
        stop.abort();
        return [{ id: recordId(1), success: true, errors: [] }];
      });
      const giveBack = vi.fn(async () => undefined);

      await expect(
        loadOf(org, dataset([opportunity(1, null)]), {
          lease: { giveBack },
          signal: stop.signal,
        }),
      ).rejects.toThrow();

      expect(giveBack).not.toHaveBeenCalled();
    });

    it('stands by its writes when a lease throws as it is given back', async () => {
      const org = orgOf();

      const report = await loadOf(org, dataset([opportunity(1, null)]), {
        lease: { giveBack: () => Promise.reject(new Error('the org did not answer')) },
      });

      expect(report.status).toBe('completed');
      expect(report.recordTypesGiven?.[0]?.readBack).toMatchObject({ read: 1 });
    });
  });

  describe('the user it wrote as', () => {
    it('keeps it with its mapping, in its report, and only once it knows it', async () => {
      const org = orgOf({ userId: USER_ID });

      const report = await loadOf(org, dataset([opportunity(1, null)]));

      expect(report.runUserId).toBe(USER_ID);
      expect((await org.mappingStore.recorded())?.runUserId).toBe(USER_ID);
    });

    it('asks it before the first write, so that a load killed part way names it too', async () => {
      const org = orgOf({ userId: USER_ID });
      vi.mocked(org.writer.insert).mockImplementationOnce(async () => {
        throw new Error('the host stopped');
      });

      await expect(loadOf(org, dataset([opportunity(1, null)]))).rejects.toThrow(
        'the host stopped',
      );

      expect(org.orgAccess.userId).toHaveBeenCalledTimes(1);
      const asked = vi.mocked(org.orgAccess.userId as () => Promise<string>).mock
        .invocationCallOrder[0] as number;
      const wrote = vi.mocked(org.writer.insert).mock.invocationCallOrder[0] as number;
      expect(asked).toBeLessThan(wrote);
    });

    it('goes on without it when the target does not say', async () => {
      const org = orgOf({ userId: USER_ID });
      vi.mocked(org.orgAccess.userId as () => Promise<string>).mockRejectedValue(
        new Error('getUserInfo failed'),
      );

      const report = await loadOf(org, dataset([opportunity(1, null)]));

      expect(report.status).toBe('completed');
      expect(report.runUserId).toBeUndefined();
      expect((await org.mappingStore.recorded())?.runUserId).toBeUndefined();
    });
  });
});

describe('FrozenDatasetLoader.gateLoad', () => {
  /** A guard that asks about every write, as a host's own may, and counts its questions. */
  function askingGuard(answer: boolean) {
    const requestConfirmation = vi.fn(async () => answer);
    const guard = new ProductionGuard({ requestConfirmation });
    vi.spyOn(guard, 'check').mockReturnValue({
      allowed: true,
      requiresConfirmation: true,
      warnings: [],
      impactSummary: 'INSERT on Opportunity',
    });
    return { guard, requestConfirmation };
  }

  it('lets a load through a stock guard without a question, on the tiers the entry guards pass', async () => {
    const requestConfirmation = vi.fn(async () => true);
    const org = orgOf({ guard: new ProductionGuard({ requestConfirmation }) });
    const decisions: GuardDecision[] = [];

    const decision = await new FrozenDatasetLoader(org.deps).gateLoad({
      ...optionsOf(org, dataset([opportunity(1, null)])),
      onGuardDecision: (d) => decisions.push(d),
    });

    expect(decision).toBe('allowed');
    expect(decisions).toEqual(['allowed']);
    expect(requestConfirmation).not.toHaveBeenCalled();
  });

  it('refuses a sandbox marked Staging at its entry guards, on their line, before any question', async () => {
    const requestConfirmation = vi.fn(async () => true);
    const org = orgOf({ guard: new ProductionGuard({ requestConfirmation }) });
    const lines: FrozenLoadProgressEvent[] = [];

    const error: unknown = await new FrozenDatasetLoader(org.deps)
      .gateLoad({
        ...optionsOf(org, dataset([opportunity(1, null)]), { orgTier: 'staging' }),
        onProgress: (event) => lines.push(event),
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LoadGuardError);
    expect((error as LoadGuardError).code).toBe('non-sandbox');
    // The stock guard would ask about a delete at this tier: the refusal comes first.
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(lines.map((line) => [line.phase, line.status])).toEqual([
      ['guards', 'started'],
      ['guards', 'error'],
    ]);
    expect(lines[1]?.message).toContain('Entry guards not passed');
  });

  it('says nothing of the guards when they pass: the load says them as it starts', async () => {
    const org = orgOf();
    const lines: FrozenLoadProgressEvent[] = [];

    await new FrozenDatasetLoader(org.deps).gateLoad({
      ...optionsOf(org, dataset([opportunity(1, null)])),
      onProgress: (event) => lines.push(event),
    });

    expect(lines).toEqual([]);
  });

  it('puts the question of the whole load, as a delete on a reload', async () => {
    const { guard } = askingGuard(true);
    const org = orgOf({ guard });
    const data = dataset([opportunity(1, null), opportunity(2, null)]);

    await new FrozenDatasetLoader(org.deps).gateLoad(optionsOf(org, data));
    await new FrozenDatasetLoader(org.deps).gateLoad(optionsOf(org, data, { reload: true }));
    await new FrozenDatasetLoader(org.deps).gateLoad(
      optionsOf(org, data, { reload: true, pilot: {} }),
    );

    expect(vi.mocked(guard.check).mock.calls.map(([request]) => request)).toMatchObject([
      { operation: 'insert', objectName: 'Opportunity', recordCount: { atMost: 2 } },
      { operation: 'delete', recordCount: { atMost: 2 } },
      // A pilot's reload purges nothing.
      { operation: 'insert' },
    ]);
  });

  it('stops on a declined question, saying so to whom records it, before anything is written', async () => {
    const { guard } = askingGuard(false);
    const org = orgOf({ guard });
    const decisions: GuardDecision[] = [];

    const error: unknown = await new FrozenDatasetLoader(org.deps)
      .gateLoad({
        ...optionsOf(org, dataset([opportunity(1, null)])),
        onGuardDecision: (d) => decisions.push(d),
      })
      .catch((e: unknown) => e);

    expect((error as LoadGuardError).code).toBe('guard-refused');
    expect(decisions).toEqual(['declined']);
    expect(org.writer.insert).not.toHaveBeenCalled();
  });

  it('asks once: the answer it took stands for every batch of the load', async () => {
    const { guard, requestConfirmation } = askingGuard(true);
    const org = orgOf({ guard });
    const data = dataset(Array.from({ length: 3 }, (_, n) => opportunity(n + 1, null)));
    const loader = new FrozenDatasetLoader(org.deps);

    const decision = await loader.gateLoad(optionsOf(org, data));
    const decisions: GuardDecision[] = [];
    await withGivenAnswer({ approved: true }, () =>
      loader.load(optionsOf(org, data, { onGuardDecision: (d) => decisions.push(d) })),
    );

    expect(decision).toBe('confirmed');
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    // The batches are judged still, and recorded as the person's answer.
    expect(decisions.length).toBeGreaterThan(0);
    expect(new Set(decisions)).toEqual(new Set(['confirmed']));
  });
});
