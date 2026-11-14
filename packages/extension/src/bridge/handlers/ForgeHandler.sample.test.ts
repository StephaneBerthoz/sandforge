import path from 'node:path';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BaseMessage,
  ForgeConfig,
  ForgeExecutionResult,
  ForgeGraph,
  ForgeGraphNode,
  ForgeSampleBudget,
  ForgeTargetAutomation,
  WholeOrgSample,
} from '@sandforge/shared';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import type { ForgeOrchestratorDeps } from '../../modules/forge/ForgeOrchestrator.js';
import {
  ForgeExecutor,
  type FieldInfo,
  type ForgeExecutorDeps,
} from '../../modules/forge/ForgeExecutor.js';
import { ForgeRunJournal } from '../../modules/forge/ForgeRunJournal.js';
import { cursorPages } from '../../modules/forge/queryAllPages.js';
import { SamplePlan } from '../../modules/forge/sample/samplePlanStore.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import type { RunConfirmation, WriteConfirmation } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { SampleSourceOrg } from '../../test/sampleSourceOrg.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const mockGetConn = vi.mocked(getJsforceConnection);

/*
 * A sample of the whole org, from the panel's message to the executor and
 * back: the real handler, orchestrator and executor, over a source in memory
 * that answers a sample's reads as the org does (`test/sampleSourceOrg.ts`),
 * a target that creates what it is sent, and the plans kept on a disk of
 * their own. The Simulate draws and keeps a plan; the run takes it up, or
 * draws its own and says why; the gate holds it to what the target has left.
 */

type Row = Record<string, unknown>;

const MB = 1024 * 1024;

/** A fake id: the object's prefix, a letter for the org, a counter; the length of a real one. */
const fakeId = (prefix: string, org: 'S' | 'T', n: number): string =>
  `${prefix}${org}${String(n).padStart(11, '0')}AAA`;

const field = (name: string, overrides: Partial<FieldInfo> = {}): FieldInfo => ({
  name,
  queryable: true,
  createable: name !== 'Id',
  updateable: name !== 'Id',
  isReference: false,
  ...overrides,
});

/** Accounts naming a parent account, and contacts that cannot be written without theirs. */
const FIELDS: Record<string, FieldInfo[]> = {
  Account: [
    field('Id'),
    field('Name'),
    field('ParentId', { isReference: true, referenceTo: ['Account'], nillable: true }),
  ],
  Contact: [
    field('Id'),
    field('LastName'),
    field('AccountId', { isReference: true, referenceTo: ['Account'], nillable: false }),
  ],
};

const PREFIX: Record<string, string> = { Account: '001', Contact: '003' };

/** Accounts and contacts of the source. */
const RECORDS = 200;

function node(objectApiName: string, recordCount: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount,
    fieldCount: 3,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 2,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  };
}

function wholeOrgGraph(): ForgeGraph {
  return {
    nodes: [node('Account', RECORDS), node('Contact', RECORDS)],
    edges: [
      {
        sourceObject: 'Account',
        targetObject: 'Contact',
        relationshipName: 'Contacts',
        type: 'lookup',
        required: true,
      },
      {
        sourceObject: 'Account',
        targetObject: 'Account',
        relationshipName: 'ChildAccounts',
        type: 'lookup',
      },
    ],
    totalRecords: 2 * RECORDS,
    estimatedSizeMB: 1,
    estimatedDurationSeconds: 4,
  };
}

const EVERY_RECORD: ForgeConfig = {
  inputMode: 'org',
  depth: 'all',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  anonymizePII: false,
  skipEmpty: true,
  batchSize: 'auto',
};

const SAMPLE: ForgeConfig = { ...EVERY_RECORD, sample: {} };

/** A source of `RECORDS` accounts, each with one contact. */
function sourceOrg(): SampleSourceOrg {
  const org = new SampleSourceOrg();
  org.columns.set('Account', ['Id', 'Name', 'ParentId', 'CreatedDate', 'IsDeleted']);
  org.columns.set('Contact', ['Id', 'LastName', 'AccountId', 'CreatedDate', 'IsDeleted']);
  for (let n = 1; n <= RECORDS; n++) {
    org.add('Account', {
      Id: fakeId('001', 'S', n),
      Name: `A${n}`,
      ParentId: null,
      IsDeleted: false,
    });
    org.add('Contact', {
      Id: fakeId('003', 'S', n),
      LastName: `C${n}`,
      AccountId: fakeId('001', 'S', n),
      IsDeleted: false,
    });
  }
  return org;
}

/** A target that runs nothing on the run's objects, all of it read. */
const QUIET: ForgeTargetAutomation = {
  objectsRead: ['Account', 'Contact'],
  objects: [],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 1,
  bypassGrants: [],
};

/** A disk in memory under a real journal, the extension's storage named `storagePath`. */
function journalOnMemory(storagePath: string): ForgeRunJournal {
  const files = new Map<string, string>();
  const key = (filePath: string): string => path.normalize(filePath);
  return new ForgeRunJournal({
    storagePath,
    appendFile: async (filePath, content) => {
      files.set(key(filePath), (files.get(key(filePath)) ?? '') + content);
    },
    readLines: (filePath) =>
      (async function* lines(): AsyncGenerator<string> {
        for (const line of (files.get(key(filePath)) ?? '').split('\n')) yield line;
      })(),
    mkdir: async () => {},
    rm: async (filePath) => void files.delete(key(filePath)),
    listFiles: async (dirPath) =>
      [...files.keys()]
        .filter((filePath) => path.dirname(filePath) === key(dirPath))
        .map((filePath) => path.basename(filePath)),
    openRunFile: (filePath) => ({
      size: () => Buffer.byteLength(files.get(key(filePath)) ?? ''),
      append: (text) => void files.set(key(filePath), (files.get(key(filePath)) ?? '') + text),
      read: (offset, length) =>
        Buffer.from(files.get(key(filePath)) ?? '').subarray(offset, offset + length),
      close: () => {},
    }),
  });
}

describe('forge:execute of a sample of the whole org', () => {
  let handler: ForgeHandler;
  let deps: HandlerDeps;
  let store: ConfigStore;
  let questions: RunConfirmation[];
  /** What each org's `/limits` answer, by org; an error refuses the request. */
  let limits: Record<string, unknown>;
  let source: SampleSourceOrg;
  /** What the target holds, by object: each record with the source id it was written for. */
  let written: Map<string, Row[]>;
  let storage: string;
  /** Stop the run once the target has taken this many records; none when undefined. */
  let stopAfter: number | undefined;

  beforeEach(() => {
    stopAfter = undefined;
    mockGetConn.mockReset();
    questions = [];
    written = new Map();
    limits = {
      'tgt-org': {
        DataStorageMB: { Max: 5, Remaining: 1 },
        DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
        DailyBulkApiBatches: { Max: 15_000, Remaining: 14_000 },
        FileStorageMB: { Max: 20, Remaining: 20 },
      },
      'src-org': {
        DataStorageMB: { Max: 2_000, Remaining: 1_000 },
        DailyApiRequests: { Max: 100_000, Remaining: 80_000 },
      },
    };
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn((id: string) => ({
          orgType: 'Sandbox',
          alias: id === 'tgt-org' ? 'DEV' : 'SRC',
        })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      services: {
        getSandforgeSetting: <T>(_key: string, fallback: T): T => fallback,
      } as unknown as HandlerDeps['services'],
      infraServices: {
        productionGuard: new ProductionGuard({
          requestRunConfirmation: async (question) => {
            questions.push(question);
            return true;
          },
        }),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    // Both orgs answer their limits, and no record type; any other request
    // fails: a fake org that refuses what the run did not ask of it.
    mockGetConn.mockImplementation(async (orgId: string) => {
      return {
        query: vi.fn().mockResolvedValue({ records: [], done: true, totalSize: 0 }),
        queryMore: vi.fn(),
        request: vi.fn(async ({ method, url }: { method: string; url: string }) => {
          if (method !== 'GET' || url !== '/limits') throw new Error(`unexpected ${url}`);
          const answer = limits[orgId];
          if (answer instanceof Error) throw answer;
          return answer;
        }),
      } as never;
    });
    source = sourceOrg();
    storage = mkdtempSync(path.join(tmpdir(), 'forge-sample-handler-'));
    handler = new ForgeHandler(deps);
    handler.setForgeOrchestrator(orchestratorOver(source), {
      targetAutomation: {
        readForGraph: vi.fn(async () => QUIET),
      } as unknown as TargetAutomationReader,
      runJournal: journalOnMemory(storage),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(storage, { recursive: true, force: true });
  });

  /** The real orchestrator and executor, reading `org` as the source and writing to a target in memory. */
  function orchestratorOver(org: SampleSourceOrg): ForgeOrchestrator {
    let created = 0;
    const holder: { executor?: ForgeExecutor } = {};
    const gather = async (soql: string): Promise<Row[]> => {
      const rows: Row[] = [];
      for await (const page of cursorPages(org, soql)) rows.push(...page);
      return rows;
    };
    const executorDeps = {
      describeFields: vi.fn(async (_org: string, object: string) => FIELDS[object] ?? []),
      queryRecords: vi.fn(async (orgId: string, soql: string) =>
        orgId === 'src-org' ? gather(soql) : [],
      ),
      queryPages: (orgId: string, soql: string, read?: { all?: true }) =>
        orgId === 'src-org'
          ? cursorPages(org, soql, read)
          : (async function* none(): AsyncGenerator<Row[]> {
              yield [];
            })(),
      countRecords: vi.fn(async (orgId: string, soql: string) =>
        orgId === 'src-org' ? (await org.query(soql)).totalSize : 0,
      ),
      insertRecords: vi.fn(async (_org: string, object: string, rows: Row[]) => {
        const answers = rows.map((row) => {
          written.set(object, [...(written.get(object) ?? []), row]);
          return { id: fakeId(PREFIX[object] ?? 'a00', 'T', ++created), success: true, errors: [] };
        });
        // A Stop taken as a call is answered: the window closed, the user stopped.
        if (stopAfter !== undefined && rowsWritten() >= stopAfter) holder.executor?.abort();
        return answers;
      }),
      updateRecords: vi.fn(async (_org: string, _object: string, rows: Row[]) =>
        rows.map((row) => ({ id: String(row['Id']), success: true, errors: [] })),
      ),
      isObjectCreatable: async () => true,
      duplicateRuleObjects: async () => new Set<string>(),
    } satisfies ForgeExecutorDeps;
    holder.executor = new ForgeExecutor(executorDeps);
    return new ForgeOrchestrator({
      discoveryService: {
        personalFields: () => [],
      } as unknown as ForgeOrchestratorDeps['discoveryService'],
      executor: holder.executor,
    });
  }

  function resumeRun(forgeId: string): Promise<boolean> {
    return handler.handle(
      inboundRequest({
        id: 'wv-resume',
        type: 'forge:resume-run',
        timestamp: Date.now(),
        payload: { forgeId },
      } as BaseMessage),
    );
  }

  /** The plans kept beside the runs' journals. */
  const runPlans = (): string[] =>
    existsSync(path.join(storage, 'forge-runs'))
      ? readdirSync(path.join(storage, 'forge-runs')).filter((name) => name.endsWith('.sample'))
      : [];

  function execute(payload: Record<string, unknown> = {}): Promise<boolean> {
    return handler.handle(
      inboundRequest({
        id: 'wv-execute',
        type: 'forge:execute',
        timestamp: Date.now(),
        payload: { graph: wholeOrgGraph(), config: SAMPLE, ...payload },
      } as BaseMessage),
    );
  }

  const simulate = (config: ForgeConfig = SAMPLE): Promise<boolean> =>
    execute({ config: { ...config, dryRun: true } });

  function posted(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  }

  /** The last answer of a run, its result and what its dry run said. */
  function lastAnswer(): {
    result: ForgeExecutionResult;
    wholeOrgDryRun?: { sample?: WholeOrgSample };
    sampleOffer?: unknown;
  } {
    const answers = posted('forge:execute:response');
    expect(answers.length).toBeGreaterThan(0);
    return answers[answers.length - 1].payload as never;
  }

  function lastError(): Record<string, unknown> {
    const errors = posted('forge:execute:error');
    expect(errors.length).toBeGreaterThan(0);
    return errors[errors.length - 1].payload;
  }

  const writeQuestions = (): WriteConfirmation[] =>
    questions.filter((q): q is WriteConfirmation => q.stage === 'write');
  const runs = () =>
    new AuditTrailStore(store).list().entries.filter((e) => e.action === 'forge_execute');
  const rowsWritten = (): number =>
    [...written.values()].reduce((sum, rows) => sum + rows.length, 0);
  /** The statements sent the source that count or read the roots: what drawing a plan sends. */
  const draws = (): number =>
    source.sent.filter(({ soql }) => /^SELECT COUNT\(\)/.test(soql)).length;

  describe('what the page sends', () => {
    it('refuses a plan named by the page, before anything is read', async () => {
      await execute({ config: { ...SAMPLE, sample: { plan: '/home/someone/plans' } } });

      expect(lastError()).toMatchObject({ code: 'INVALID_PAYLOAD' });
      expect(String(lastError().message)).toMatch(/plan must be left out/);
      expect(mockGetConn).not.toHaveBeenCalled();
      expect(source.requests).toBe(0);
    });

    it('refuses a bound on the records of a sample, the command line’s', async () => {
      await execute({ config: { ...SAMPLE, sample: { maxTotal: 500 } } });

      expect(lastError()).toMatchObject({ code: 'INVALID_PAYLOAD' });
      expect(String(lastError().message)).toMatch(/maxTotal must be left out/);
      expect(source.requests).toBe(0);
    });

    it('refuses a sample with a config walked from a record, as the whole org’s rules say', async () => {
      // Parsed past, the run walked the record's graph and said a sample.
      await execute({
        config: {
          ...EVERY_RECORD,
          inputMode: 'record',
          depth: 'direct',
          recordId: fakeId('001', 'S', 1),
          sample: { seed: 2 },
        },
      });

      expect(lastError()).toMatchObject({ code: 'INVALID_PAYLOAD' });
      expect(String(lastError().message)).toMatch(/sample must be left out/);
      expect(source.requests).toBe(0);
    });

    it('refuses the files of the records with a sample, which copies none yet', async () => {
      await execute({ files: { maxFileSizeMB: 10, acceptedAsIs: false } });

      expect(lastError()).toMatchObject({ code: 'INVALID_PAYLOAD' });
      expect(String(lastError().message)).toMatch(/copies no files yet/);
      expect(source.requests).toBe(0);
    });
  });

  describe('a simulation', () => {
    it('draws the plan, keeps it on disk, says it and writes nothing', async () => {
      await simulate();

      const { wholeOrgDryRun } = lastAnswer();
      const sample = wholeOrgDryRun?.sample;
      expect(sample?.plan.drawnBy).toBe('dryRun');
      expect(sample?.plan.path.startsWith(path.join(storage, 'forge-samples'))).toBe(true);
      // About half the org fits: 0.4 MB of 2 KB records.
      expect(sample?.rows).toBeGreaterThan(150);
      expect(sample?.rows).toBeLessThan(2 * RECORDS);
      const plan = await SamplePlan.open(sample?.plan.path ?? '', { sourceOrgId: 'src-org' });
      expect(plan.sha256).toBe(sample?.plan.sha256);
      expect(rowsWritten()).toBe(0);
      expect(runs()).toEqual([]);
    });

    it('tells the page where the drawing stands, under the request it answers', async () => {
      await simulate();

      const progress = posted('forge:sampling:progress');
      expect(progress.length).toBeGreaterThan(0);
      expect(progress.every((m) => m.correlationId === 'wv-execute')).toBe(true);
      expect(progress[0].payload).toMatchObject({
        step: expect.any(String),
        rows: expect.any(Number),
      });
      // Said before the answer, never after it.
      const all = vi.mocked(deps.broker.postToWebview).mock.calls.map(([m]) => m.type);
      expect(all.lastIndexOf('forge:sampling:progress')).toBeLessThan(
        all.indexOf('forge:execute:response'),
      );
    });

    it('refuses a sample whose target would not say its storage, with no MB asked, under its code', async () => {
      limits['tgt-org'] = new Error('INSUFFICIENT_ACCESS: no limits');

      await simulate();

      expect(lastError()).toMatchObject({
        code: 'SAMPLE_STORAGE_UNREAD',
        gate: { code: 'SAMPLE_STORAGE_UNREAD' },
      });
      expect(posted('forge:execute:response')).toEqual([]);
    });

    it('refuses a sample that cannot fit, naming the heaviest, under its code', async () => {
      // 2 KB asked: an account the floor keeps, and the contact that comes
      // with it, take 4. The target's room, 0.4 MB, sets no root aside as too
      // heavy for it.
      await simulate({ ...SAMPLE, sample: { withinMB: 2 / 1024 } });

      const error = lastError();
      expect(error).toMatchObject({
        code: 'SAMPLE_CANNOT_FIT',
        gate: { code: 'SAMPLE_CANNOT_FIT' },
      });
      expect((error.gate as { sample?: { heaviest?: string[] } }).sample?.heaviest).toContain(
        'Account',
      );
    });
  });

  describe('the run after it', () => {
    it('takes the simulation’s plan up — the same ids — and says so in its question, its result and its audit', async () => {
      await simulate();
      const simulated = lastAnswer().wholeOrgDryRun?.sample;
      const counted = draws();

      await execute();

      // No root counted again: the run read the plan's ids alone.
      expect(draws()).toBe(counted);
      const [question] = writeQuestions();
      expect(question.wholeOrg?.sample).toMatchObject({
        drawnBy: 'dryRun',
        rows: simulated?.rows,
        minutesBefore: 1,
      });
      expect(question.wholeOrg?.sample).not.toHaveProperty('drawnAgain');
      const { result } = lastAnswer();
      expect(result.status).toBe('success');
      expect(result.sample?.sha256).toBe(simulated?.plan.sha256);
      expect(rowsWritten()).toBe(simulated?.rows);
      // Taken up, the plan left the simulation's folder for the run's.
      expect(existsSync(simulated?.plan.path ?? '')).toBe(false);
      const [entry] = runs();
      expect(entry.fit).toMatchObject({
        module: 'forge',
        seed: 1,
        draw: 'uniform',
        kept: simulated?.rows,
        inSource: 2 * RECORDS,
      });
    });

    it('draws its own when the simulation’s plan is a day old, and says why', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-14T08:00:00.000Z'));
      await simulate();
      vi.setSystemTime(new Date('2026-11-15T08:30:00.000Z'));

      await execute();

      expect(writeQuestions()[0].wholeOrg?.sample).toMatchObject({
        drawnBy: 'run',
        drawnAgain: 'tooOld',
      });
      expect(lastAnswer().result.status).toBe('success');
    });

    it('draws its own when the simulation was set up otherwise, and says why', async () => {
      await simulate({ ...SAMPLE, sample: { seed: 1 } });

      await execute({ config: { ...SAMPLE, sample: { seed: 2 } } });

      expect(writeQuestions()[0].wholeOrg?.sample).toMatchObject({
        drawnBy: 'run',
        seed: 2,
        drawnAgain: 'setUpOtherwise',
      });
    });

    it('draws its own once a run took the simulation’s plan up, and says why', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-11-14T08:00:00.000Z'));
      await simulate();
      await execute();
      written.clear();
      // Past the minute an identical run that wrote is refused for.
      vi.setSystemTime(new Date('2026-11-14T08:05:00.000Z'));

      await execute();

      expect(writeQuestions()[1].wholeOrg?.sample).toMatchObject({
        drawnBy: 'run',
        drawnAgain: 'planGone',
      });
    });

    it('is refused, nothing written, when the target has less room than its plan was fitted to, and the page is told by how much', async () => {
      await simulate();
      const simulated = lastAnswer().wholeOrgDryRun?.sample;
      // Another load took most of what was left meanwhile.
      limits['tgt-org'] = {
        ...(limits['tgt-org'] as object),
        DataStorageMB: { Max: 5, Remaining: 0.7 },
      };

      await execute();

      const error = lastError();
      expect(error.code).toBe('STORAGE_EXCEEDED');
      expect(String(error.message)).toMatch(/Simulate again/);
      expect(error.gate).toMatchObject({
        code: 'STORAGE_EXCEEDED',
        sample: { fittedMB: expect.any(Number), holdsMB: expect.any(Number) },
      });
      const said = (error.gate as { sample: { fittedMB: number; holdsMB: number } }).sample;
      expect(said.holdsMB).toBeLessThan(said.fittedMB);
      expect(simulated?.storageBytes).toBeGreaterThan(said.holdsMB * MB);
      expect(rowsWritten()).toBe(0);
      expect(writeQuestions()).toEqual([]);
      // Stopped, its entry keeps the sample it would have written.
      const [entry] = runs();
      expect(entry).toMatchObject({ outcome: 'stopped', details: { code: 'STORAGE_EXCEEDED' } });
      expect(entry.fit).toMatchObject({ module: 'forge', kept: simulated?.rows });
    });
  });

  describe('a run stopped part way', () => {
    /** A simulation, then its run stopped once it wrote some of the plan: the run's entry. */
    async function stoppedRun(): Promise<{ forgeId: string; planned: number }> {
      await simulate();
      const planned = lastAnswer().wholeOrgDryRun?.sample?.rows ?? 0;
      stopAfter = 20;
      await execute();
      stopAfter = undefined;
      const stopped = lastError().result as ForgeExecutionResult & { resumable?: true };
      expect(stopped).toMatchObject({ resumable: true });
      expect(rowsWritten()).toBeGreaterThan(0);
      expect(rowsWritten()).toBeLessThan(planned);
      return { forgeId: stopped.forgeId, planned };
    }

    it('is taken up with the plan its journal names, drawing none, until every record of it is written', async () => {
      const { forgeId, planned } = await stoppedRun();
      const counted = draws();
      expect(runPlans()).toHaveLength(1);

      await resumeRun(forgeId);

      expect(draws()).toBe(counted);
      expect(lastAnswer().result).toMatchObject({ status: 'success', resumed: true });
      expect(rowsWritten()).toBe(planned);
    });

    it('is refused, nothing more written, when the plan its journal names is gone', async () => {
      const { forgeId } = await stoppedRun();
      const before = rowsWritten();
      for (const name of runPlans()) {
        rmSync(path.join(storage, 'forge-runs', name), { recursive: true, force: true });
      }

      await resumeRun(forgeId);

      expect(lastError()).toMatchObject({
        code: 'SAMPLE_PLAN_GONE',
        gate: { code: 'SAMPLE_PLAN_GONE' },
      });
      expect(rowsWritten()).toBe(before);
    });
  });

  describe('every record of a whole org past the target’s storage', () => {
    // 400 records of 2 KB take 0.8 MB; 0.6 MB left.
    const tight = (): void => {
      limits['tgt-org'] = {
        ...(limits['tgt-org'] as object),
        DataStorageMB: { Max: 5, Remaining: 0.6 },
      };
    };

    it('is refused with the offer of a sample that fits', async () => {
      tight();

      await execute({ config: EVERY_RECORD });

      const error = lastError();
      expect(error.code).toBe('STORAGE_EXCEEDED');
      expect(error.sampleOffer).toEqual({
        bytes: Math.floor(0.8 * 0.1 * MB),
        remainingMB: 0.6,
        maxMB: 5,
        share: 0.8,
        roundingMB: 0.5,
        limitedBy: 'storage',
      });
      expect(rowsWritten()).toBe(0);
    });

    it('is simulated with the same offer beside the refusal its run would meet', async () => {
      tight();

      await simulate(EVERY_RECORD);

      const answer = lastAnswer();
      expect(answer.sampleOffer).toMatchObject({ remainingMB: 0.6, limitedBy: 'storage' });
    });

    it('is offered nothing when it fits', async () => {
      await execute({ config: EVERY_RECORD });

      expect(lastAnswer()).not.toHaveProperty('sampleOffer');
    });
  });
});

describe('forge:sample-budget:request', () => {
  let handler: ForgeHandler;
  let deps: HandlerDeps;

  beforeEach(() => {
    mockGetConn.mockReset();
    mockGetConn.mockImplementation(async (orgId: string) => {
      return {
        request: vi.fn(async () =>
          orgId === 'tgt-org'
            ? {
                DataStorageMB: { Max: 5, Remaining: 4.5 },
                DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
              }
            : { DailyApiRequests: { Max: 100_000, Remaining: 80_000 } },
        ),
      } as never;
    });
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      orgManager: { getOrg: vi.fn(() => ({ orgType: 'Sandbox' })) },
      orgRegistry: {},
      services: { getSandforgeSetting: <T>(_key: string, fallback: T): T => fallback },
      nextId: () => String(++n),
    } as unknown as HandlerDeps;
    handler = new ForgeHandler(deps);
  });

  function ask(config: ForgeConfig): Promise<boolean> {
    return handler.handle(
      inboundRequest({
        id: 'wv-budget',
        type: 'forge:sample-budget:request',
        timestamp: Date.now(),
        payload: { graph: wholeOrgGraph(), config },
      } as BaseMessage),
    );
  }

  const answers = () =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> });

  it('says what every record takes, what a sample may take and what drawing it reads, for the target it was asked of', async () => {
    expect(await ask(EVERY_RECORD)).toBe(true);

    const [answer] = answers();
    expect(answer).toMatchObject({
      type: 'forge:sample-budget:response',
      correlationId: 'wv-budget',
    });
    const { targetOrgId, budget } = answer.payload as {
      targetOrgId: string;
      budget: ForgeSampleBudget;
    };
    expect(targetOrgId).toBe('tgt-org');
    expect(budget.wholeOrg).toMatchObject({ verdict: 'fits', remainingMB: 4.5 });
    expect(budget.budget).toMatchObject({ bytes: Math.floor(0.8 * 4 * MB), limitedBy: 'storage' });
    // A count of each object's roots, and a page of the accounts' ids; a
    // contact cannot go without its account, and none is a root.
    expect(budget.planReads.source).toMatchObject({
      verdict: 'fits',
      estimate: 3,
      remaining: 80_000,
    });
  });

  it('holds the sample to the MB asked', async () => {
    await ask({ ...SAMPLE, sample: { withinMB: 1 } });

    const { budget } = answers()[0].payload as { budget: ForgeSampleBudget };
    expect(budget.budget).toMatchObject({ bytes: MB, withinMB: 1, limitedBy: 'within' });
  });

  it('is refused of a config walked from a record', async () => {
    await ask({
      ...EVERY_RECORD,
      inputMode: 'record',
      depth: 'direct',
      recordId: fakeId('001', 'S', 1),
    });

    expect(answers()[0]).toMatchObject({
      type: 'forge:sample-budget:error',
      payload: { code: 'INVALID_PAYLOAD' },
    });
  });
});
