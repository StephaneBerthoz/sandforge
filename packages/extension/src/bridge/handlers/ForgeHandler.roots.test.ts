import path from 'node:path';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BaseMessage,
  ForgeConfig,
  ForgeExecutionResult,
  ForgeRootsPreview,
  ForgeTargetAutomation,
} from '@sandforge/shared';
import { ForgeHandler, type ForgeJournalLocks } from './ForgeHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import type { ForgeOrchestratorDeps } from '../../modules/forge/ForgeOrchestrator.js';
import { ForgeExecutor } from '../../modules/forge/ForgeExecutor.js';
import { ForgeRunJournal } from '../../modules/forge/ForgeRunJournal.js';
import { openRootPlan, rootsDirOf } from '../../modules/forge/roots/rootPlanStore.js';
import { rootsSha256 } from '../../modules/forge/stages/QueryRoots.js';
import {
  forgeRunWriting,
  forgeRunWritingWords,
  lockForgeRun,
  type ForgeRunLockHolder,
} from '../../modules/forge/ForgeRunLock.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import { ProductionGuard, type RunConfirmation } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { energyOrg, fakeId, queryRootsGraph, QueryRootsOrg } from '../../test/queryRootsOrg.js';

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
 * A clone from the records a query chooses, from the panel's messages to
 * the executor and back: the real handler, orchestrator and executor over
 * the accounts, contacts, opportunities and cases of `queryRootsOrg.ts`, a
 * target that creates what it is sent, and the extension's storage on a
 * disk of its own. Before Discover the page asks what the query chooses;
 * the Simulate keeps the records it read, and the run of the same setup
 * writes those, not what the query chooses by then.
 */

const ENERGY = "SELECT Id FROM Account WHERE Industry = 'Energy'";

const account = (n: number): string => fakeId('Account', 'S', n);

/** A config of the SOQL tab, as the panel sends it: the records its query chooses. */
function recordsConfig(soql: string = ENERGY, extra: Partial<ForgeConfig> = {}): ForgeConfig {
  return {
    sourceOrgId: 'src',
    targetOrgId: 'tgt',
    inputMode: 'soql',
    soqlQuery: soql,
    queryScope: 'records',
    depth: 'full',
    anonymizePII: false,
    skipEmpty: false,
    batchSize: 'auto',
    ...extra,
  };
}

/** A target that runs nothing on the run's objects, all of it read. */
const QUIET: ForgeTargetAutomation = {
  objectsRead: ['Account', 'Contact', 'Opportunity', 'Case'],
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

describe('a clone from the records a query chooses, from the Forge panel', () => {
  let handler: ForgeHandler;
  let deps: HandlerDeps;
  let org: QueryRootsOrg;
  let storage: string;
  /** What each org's `/limits` answer, by org. */
  let limits: Record<string, unknown>;
  /** The settings the extension reads, by key. */
  let settings: Record<string, unknown>;
  /** The statements the source was sent through a connection of the handler's own. */
  let handlerStatements: string[];
  /** The journal of the runs, its files in memory, its locks on the disk of `storage`. */
  let journal: ForgeRunJournal;
  /** The lock files found in the journals' folder while the target was written. */
  let locksWhileWriting: string[][];
  let store: ConfigStore;

  beforeEach(() => {
    mockGetConn.mockReset();
    org = energyOrg();
    settings = {};
    handlerStatements = [];
    limits = {
      tgt: {
        DataStorageMB: { Max: 200, Remaining: 150 },
        DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
        DailyBulkApiBatches: { Max: 15_000, Remaining: 14_000 },
        FileStorageMB: { Max: 20, Remaining: 20 },
      },
      src: {
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
          alias: id === 'tgt' ? 'TGT' : 'SRC',
        })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      services: {
        getSandforgeSetting: <T>(key: string, fallback: T): T =>
          key in settings ? (settings[key] as T) : fallback,
      } as unknown as HandlerDeps['services'],
      infraServices: {
        productionGuard: new ProductionGuard({ requestRunConfirmation: async () => true }),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    // The handler's own connections: the source answers its statements as
    // the org does, both orgs their limits; any other request fails.
    mockGetConn.mockImplementation(async (orgId: string) => {
      return {
        query: vi.fn(async (soql: string) => {
          if (orgId !== 'src') return { records: [], done: true, totalSize: 0 };
          handlerStatements.push(soql);
          return org.source.query(soql);
        }),
        queryMore: vi.fn(async (url: string) => org.source.queryMore(url)),
        request: vi.fn(async ({ method, url }: { method: string; url: string }) => {
          if (method !== 'GET' || url !== '/limits') throw new Error(`unexpected ${url}`);
          const answer = limits[orgId];
          if (answer instanceof Error) throw answer;
          return answer;
        }),
      } as never;
    });
    storage = mkdtempSync(path.join(tmpdir(), 'forge-roots-handler-'));
    journal = journalOnMemory(storage);
    locksWhileWriting = [];
    handler = new ForgeHandler(deps);
    handler.setForgeOrchestrator(orchestratorOver(org), {
      targetAutomation: {
        readForGraph: vi.fn(async () => QUIET),
      } as unknown as TargetAutomationReader,
      runJournal: journal,
    });
  });

  afterEach(() => {
    rmSync(storage, { recursive: true, force: true });
  });

  /** The real orchestrator and executor, reading the source and writing the target of `source`. */
  function orchestratorOver(source: QueryRootsOrg): ForgeOrchestrator {
    const deps = source.deps();
    return new ForgeOrchestrator({
      discoveryService: {
        personalFields: () => [],
      } as unknown as ForgeOrchestratorDeps['discoveryService'],
      executor: new ForgeExecutor({
        ...deps,
        // What locks the journals' folder holds as the target is written.
        insertRecords: async (...args) => {
          const dir = path.join(storage, 'forge-runs');
          locksWhileWriting.push(
            existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith('.lock')) : [],
          );
          return deps.insertRecords(...args);
        },
      }),
    });
  }

  const graph = () => queryRootsGraph(org, 'Account', ['Contact', 'Opportunity', 'Case']);

  function send(type: string, payload: Record<string, unknown>, id = `wv-${type}`) {
    return handler.handle(
      inboundRequest({ id, type, timestamp: Date.now(), payload } as BaseMessage),
    );
  }

  const preview = (payload: Record<string, unknown>) => send('forge:previewRoots', payload);
  const execute = (config: ForgeConfig) => send('forge:execute', { graph: graph(), config });
  const simulate = (config: ForgeConfig = recordsConfig()) => execute({ ...config, dryRun: true });

  function posted(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  }

  function lastResult(): ForgeExecutionResult {
    const answers = posted('forge:execute:response');
    expect(answers.length).toBeGreaterThan(0);
    return (answers[answers.length - 1].payload as { result: ForgeExecutionResult }).result;
  }

  function lastError(type = 'forge:execute:error'): Record<string, unknown> {
    const errors = posted(type);
    expect(errors.length).toBeGreaterThan(0);
    return errors[errors.length - 1].payload;
  }

  /** The source ids of `object` the target was sent. */
  const sentToTarget = (object: string): string[] =>
    (org.inserted.get(object) ?? []).map((row) => String(row['Id'] ?? row['Name']));

  /** The plans of roots the simulations kept. */
  const keptPlans = (): string[] =>
    existsSync(rootsDirOf(storage)) ? readdirSync(rootsDirOf(storage)) : [];

  describe('forge:previewRoots, before Discover', () => {
    it('reads the ids the query chooses by the run’s own statement, to one past the most it takes, and says how many', async () => {
      await preview({ sourceOrgId: 'src', soqlQuery: ENERGY });

      expect(handlerStatements).toEqual([
        "SELECT Id FROM Account WHERE (Industry = 'Energy') ORDER BY Id LIMIT 201",
      ]);
      expect(posted('forge:previewRoots:response')[0]?.payload).toEqual({
        sourceOrgId: 'src',
        soqlQuery: ENERGY,
        objectApiName: 'Account',
        cap: 200,
        chosen: 2,
        more: false,
        requests: 1,
      } satisfies ForgeRootsPreview);
    });

    it('says the query chooses more than the most sandforge.forge.maxRoots takes, when no LIMIT holds it', async () => {
      settings['forge.maxRoots'] = 1;

      await preview({ sourceOrgId: 'src', soqlQuery: ENERGY });

      expect(handlerStatements[0]).toMatch(/ LIMIT 2$/);
      expect(posted('forge:previewRoots:response')[0]?.payload).toMatchObject({
        cap: 1,
        chosen: 1,
        more: true,
      });
    });

    it('reads to the query’s own LIMIT and ORDER BY when the run takes that many, and the most the page names wins', async () => {
      await preview({
        sourceOrgId: 'src',
        soqlQuery: `${ENERGY} ORDER BY CreatedDate DESC LIMIT 1`,
        maxRoots: 5,
      });

      expect(handlerStatements).toEqual([
        "SELECT Id FROM Account WHERE (Industry = 'Energy') ORDER BY CreatedDate DESC LIMIT 1",
      ]);
      expect(posted('forge:previewRoots:response')[0]?.payload).toMatchObject({
        cap: 5,
        chosen: 1,
        more: false,
        limit: 1,
        orderBy: 'CreatedDate DESC',
      });
    });

    it('says a query that chooses none, without reading more than its ids', async () => {
      await preview({ sourceOrgId: 'src', soqlQuery: "SELECT Id FROM Account WHERE Name = 'Z'" });

      expect(posted('forge:previewRoots:response')[0]?.payload).toMatchObject({
        chosen: 0,
        more: false,
      });
    });

    it('refuses a query that cannot choose records before anything is read, in the words its run would be refused in', async () => {
      await preview({
        sourceOrgId: 'src',
        soqlQuery: 'SELECT Industry FROM Account GROUP BY Industry',
      });

      expect(mockGetConn).not.toHaveBeenCalled();
      expect(lastError('forge:previewRoots:error')).toMatchObject({
        code: 'ROOTS_QUERY_REFUSED',
        retryable: false,
        soqlQuery: 'SELECT Industry FROM Account GROUP BY Industry',
      });
      expect(String(lastError('forge:previewRoots:error')['message'])).toContain('GROUP BY');
    });

    it('says a read the source refused, with its words, and that it may be tried again', async () => {
      await preview({ sourceOrgId: 'src', soqlQuery: 'SELECT Id FROM Account WHERE Nope__c = 1' });

      expect(lastError('forge:previewRoots:error')).toMatchObject({
        code: 'ROOTS_PREVIEW_ERROR',
        retryable: true,
      });
      expect(String(lastError('forge:previewRoots:error')['message'])).toMatch(/Nope__c/);
    });
  });

  // Run for real on a trap org, the gate of a clone from records counted
  // its records alone, 2.58 MB of the 5 MB left, while a flow no mute
  // reaches opens a task under each of the 1 200 contacts: about 2.3 MB
  // more, which the gate of a clone of the whole org counts.
  describe('its records weighed at the gate with what the target creates under them', () => {
    /** 300 contacts more under the first account of Energy: the records take 0.6 MB of the 1 MB left. */
    const withManyContacts = (): void => {
      for (let n = 1; n <= 300; n++) {
        org.add('Contact', {
          Id: fakeId('Contact', 'S', 100 + n),
          LastName: `C${n}`,
          Department: 'Sales',
          AccountId: account(1),
          ReportsToId: null,
        });
      }
      limits['tgt'] = {
        ...(limits['tgt'] as object),
        DataStorageMB: { Max: 5, Remaining: 1 },
      };
    };
    /** The target runs a flow that opens a task under each contact it is sent. */
    const withATaskFlow = (): void => {
      handler.setForgeOrchestrator(orchestratorOver(org), {
        targetAutomation: {
          readForGraph: vi.fn(async (): Promise<ForgeTargetAutomation> => ({
            ...QUIET,
            objects: [
              {
                objectApiName: 'Contact',
                flows: [
                  {
                    apiName: 'Contact_Follow_Up_Task',
                    label: 'Contact follow-up task',
                    timing: 'afterSave',
                    startsOn: 'create',
                    condition: 'read',
                    permissions: [],
                    creates: ['Task'],
                  },
                ],
                triggers: [],
              },
            ],
          })),
        } as unknown as TargetAutomationReader,
        runJournal: journal,
      });
    };

    it('is refused the storage the tasks take with its records, with how many of its roots fit, nothing written', async () => {
      withManyContacts();
      withATaskFlow();

      await execute(recordsConfig());

      const error = lastError();
      expect(error).toMatchObject({
        code: 'STORAGE_EXCEEDED',
        gate: { code: 'STORAGE_EXCEEDED', roots: { objectApiName: 'Account', fits: 1 } },
      });
      expect(String(error['message'])).toContain(
        "of it for what the target's automation creates under them, and TGT has 1 MB left " +
          'of 5 MB: about 1 of the 2 Account records the query chooses fit, each with what its ' +
          'clone copies: a LIMIT of 1 in the query clones that many — after ORDER BY ' +
          'CreatedDate DESC, Id DESC, the newest',
      );
      expect(String(error['message'])).not.toContain('records per object');
      expect(org.inserted.size).toBe(0);
    });

    it('lets the same records through when nothing the target runs creates a record under them', async () => {
      withManyContacts();

      await execute(recordsConfig());

      expect(lastResult().roots).toMatchObject({ from: 'query', written: 2 });
      expect(sentToTarget('Contact').length).toBeGreaterThan(300);
    });
  });

  describe('the roots its simulation read, and its run', () => {
    it('keeps the roots the Simulate read, and the run of the same setup writes those, not a record the query chooses since', async () => {
      await simulate();
      expect(lastResult().roots).toMatchObject({ from: 'query', read: 2 });
      expect(keptPlans()).toHaveLength(1);
      const kept = await openRootPlan(path.join(rootsDirOf(storage), keptPlans()[0] ?? ''));
      expect(kept.ids).toEqual([account(1), account(2)]);

      // An account of Energy made between the simulation and the run.
      org.add('Account', { Id: account(9), Name: 'A9', Industry: 'Energy', ParentId: null });
      await execute(recordsConfig());

      const result = lastResult();
      expect(result.roots).toMatchObject({ from: 'plan', read: 2, written: 2 });
      expect(sentToTarget('Account')).not.toContain('A9');
      expect(sentToTarget('Account').sort()).toEqual(['A1', 'A2']);
    });

    it('reads the query when no simulation of the same setup kept its roots', async () => {
      await execute(recordsConfig());

      expect(lastResult().roots).toMatchObject({ from: 'query', read: 2, written: 2 });
      expect(keptPlans()).toEqual([]);
    });

    it('holds the run to the most roots sandforge.forge.maxRoots says, when the page named none', async () => {
      settings['forge.maxRoots'] = 1;

      await execute(recordsConfig());

      expect(lastError()).toMatchObject({ code: 'ROOTS_EXCEEDED' });
      expect(org.inserted.size).toBe(0);
      // The page sets the most in its setting: no flag of the command line.
      const message = String(lastError().message);
      expect(message).toContain('raise the sandforge.forge.maxRoots setting up to 2,000');
      expect(message).not.toMatch(/--[a-z]/);
    });

    it('holds the read of what the roots reach to a tenth of the requests the source has left', async () => {
      limits['src'] = { DailyApiRequests: { Max: 100_000, Remaining: 20 } };

      await execute(recordsConfig());

      expect(lastError()).toMatchObject({ code: 'API_BUDGET_EXCEEDED' });
      expect(org.inserted.size).toBe(0);
    });
  });

  describe('the question its run is asked', () => {
    /** The questions the guard put, in order. */
    function questionsAsked(): RunConfirmation[] {
      const asked: RunConfirmation[] = [];
      deps.infraServices = {
        productionGuard: new ProductionGuard({
          requestRunConfirmation: async (question) => {
            asked.push(question);
            return true;
          },
        }),
      } as unknown as HandlerDeps['infraServices'];
      return asked;
    }

    it('names the roots, the source, and that they are the simulation’s, read when it ran', async () => {
      settings['safety.confirmAboveRecords'] = 1;
      await simulate();
      const asked = questionsAsked();
      const kept = await openRootPlan(path.join(rootsDirOf(storage), keptPlans()[0] ?? ''));

      await execute(recordsConfig());

      const write = asked.find((question) => question.stage === 'write');
      expect(write).toMatchObject({
        roots: {
          objectApiName: 'Account',
          count: 2,
          from: 'simulation',
          readAt: kept.readAt,
          source: 'SRC',
        },
        org: 'TGT',
      });
    });

    it('says the roots were read by the query when no simulation kept them', async () => {
      settings['safety.confirmAboveRecords'] = 1;
      const asked = questionsAsked();

      await execute(recordsConfig());

      const write = asked.find((question) => question.stage === 'write');
      expect(write).toMatchObject({ roots: { count: 2, from: 'query', source: 'SRC' } });
    });
  });

  describe('a Retry of a clone from records, which writes the roots of the run it retries', () => {
    const retry = (forgeId: string) =>
      send(
        'forge:execute',
        { graph: graph(), config: recordsConfig(), retryOf: forgeId },
        'wv-retry',
      );

    /** The history entry of `forgeId`, changed by `change`. */
    function changeEntry(
      forgeId: string,
      change: (entry: ForgeExecutionResult) => ForgeExecutionResult,
    ): void {
      const history = store.get<ForgeExecutionResult[]>('forge:history') ?? [];
      store.set(
        'forge:history',
        history.map((e) => (e.forgeId === forgeId ? change(e) : e)),
        'forge',
      );
    }

    it('writes the roots its run wrote under, as its history entry names them, not a record its query chooses since', async () => {
      await execute(recordsConfig());
      const first = lastResult();
      expect(first.roots?.ids?.map((root) => root.source)).toEqual([account(1), account(2)]);
      // An account of Energy made since, and a simulation that read it.
      org.add('Account', { Id: account(9), Name: 'A9', Industry: 'Energy', ParentId: null });
      await simulate();
      expect(lastResult().roots).toMatchObject({ read: 3 });

      await retry(first.forgeId);

      const retried = lastResult();
      expect(retried.retryOf).toBe(first.forgeId);
      expect(retried.roots).toMatchObject({ from: 'plan', asked: 2, ofTheRunRetried: true });
      expect(sentToTarget('Account')).not.toContain('A9');
    });

    it('takes the roots from the journal of the run it retries while that journal is kept', async () => {
      await execute(recordsConfig());
      const first = lastResult();
      await journal.begin('forge-run-kept', 'tgt', new Date(), {
        sourceOrgId: 'src',
        fingerprint: 'f'.repeat(64),
        startedWith: { graph: graph(), config: recordsConfig() },
      });
      const kept = journal.open('forge-run-kept');
      kept.nameRoots({
        objectApiName: 'Account',
        ids: [account(2)],
        sha256: rootsSha256([account(2)]),
        readAt: '2026-11-14T14:02:00.000Z',
        query: { where: "Industry = 'Energy'" },
      });
      kept.close();
      changeEntry(first.forgeId, (e) => ({ ...e, journalId: 'forge-run-kept' }));

      await retry(first.forgeId);

      expect(lastResult().roots).toMatchObject({
        asked: 1,
        readAt: '2026-11-14T14:02:00.000Z',
        ofTheRunRetried: true,
      });
    });

    it('is refused, nothing read or written, when neither the journal nor the history keeps the roots', async () => {
      await execute(recordsConfig());
      const first = lastResult();
      // A history entry of a run that named no root one by one.
      changeEntry(first.forgeId, (e) => ({
        ...e,
        ...(e.roots ? { roots: { ...e.roots, ids: undefined } } : {}),
      }));
      const sentBefore = org.inserted.get('Account')?.length ?? 0;
      const statementsBefore = org.statements.length;

      await retry(first.forgeId);

      const refusal = lastError();
      expect(refusal['code']).toBe('RETRY_UNAVAILABLE');
      expect(String(refusal['message'])).toContain(
        'neither its journal nor its entry in the history keeps them any more',
      );
      expect(org.inserted.get('Account')?.length ?? 0).toBe(sentBefore);
      expect(org.statements.length).toBe(statementsBefore);
    });
  });

  describe('the lock of a run’s journal, which a run of another process holds while it writes it', () => {
    /** A run of the command line holding a journal's lock. */
    const CLI_RUN: ForgeRunLockHolder = {
      pid: 4242,
      host: 'elsewhere',
      hostStartedAt: '2026-11-14T08:00:00.000Z',
      acquiredAt: '2026-11-14T14:02:00.000Z',
      journalId: 'forge-run-kept',
      ranFrom: 'commandLine',
      target: 'TGT',
    };

    /** Locks held by nobody, recording what this window takes and lets go. */
    function freeLocks(): ForgeJournalLocks & { taken: string[]; released: string[] } {
      const taken: string[] = [];
      const released: string[] = [];
      return {
        taken,
        released,
        holder: vi.fn(() => undefined),
        take: vi.fn((path: string) => {
          taken.push(path);
          return { release: () => void released.push(path) };
        }),
      };
    }

    /**
     * Run the clone, and give the id of the run the history keeps, its
     * journal named as a run that stopped part way keeps it: a run that
     * ended forgets its journal.
     */
    async function ranOnce(): Promise<string> {
      await execute(recordsConfig());
      const { forgeId } = lastResult();
      const history = store.get<ForgeExecutionResult[]>('forge:history') ?? [];
      store.set(
        'forge:history',
        history.map((e) => (e.forgeId === forgeId ? { ...e, journalId: 'forge-run-kept' } : e)),
        'forge',
      );
      return forgeId;
    }

    it('is taken by a run of this window as it begins its journal, and let go once its part has ended', async () => {
      const locks = freeLocks();
      handler.setJournalLocks(locks);

      await execute(recordsConfig());

      expect(lastResult().status).toBe('success');
      expect(locks.taken).toHaveLength(1);
      expect(locks.taken[0]).toMatch(/forge-run-\d+/);
      expect(locks.released).toEqual(locks.taken);
      expect(vi.mocked(locks.take).mock.calls[0]?.[1]).toMatchObject({ target: 'TGT' });
    });

    it('is handed with the services the composition gives the handler', async () => {
      const locks = freeLocks();
      handler.setForgeOrchestrator(orchestratorOver(org), {
        targetAutomation: {
          readForGraph: vi.fn(async () => QUIET),
        } as unknown as TargetAutomationReader,
        runJournal: journalOnMemory(storage),
        journalLocks: locks,
      });

      await execute(recordsConfig());

      expect(locks.taken).toHaveLength(1);
      expect(locks.released).toEqual(locks.taken);
    });

    it('refuses a run whose journal a run of another process holds, nothing written', async () => {
      handler.setJournalLocks({
        holder: () => CLI_RUN,
        take: () => ({ busy: CLI_RUN }),
      });

      await execute(recordsConfig());

      expect(lastError()['code']).toBe('RUN_WRITING');
      expect(org.inserted.size).toBe(0);
    });

    it('refuses the removal of a run whose journal another process writes, naming that run and how to stop it', async () => {
      const forgeId = await ranOnce();
      const holder = vi.fn((_path: string) => CLI_RUN);
      handler.setJournalLocks({ holder, take: () => ({ busy: CLI_RUN }) });

      await send('forge:undo', { forgeId });

      const refusal = lastError('forge:undo:error');
      expect(refusal['code']).toBe('RUN_WRITING');
      expect(String(refusal['message'])).toBe(
        'The run forge-run-kept still writes this journal: started from the command line to TGT ' +
          'at 2026-11-14T14:02:00.000Z (process 4242 on elsewhere). Removing its records now ' +
          'would delete under it what it goes on writing; remove them once it has ended. Stop it ' +
          'with Ctrl-C in the terminal it runs in, or let it end. Nothing was read or written.',
      );
      expect(holder.mock.calls[0]?.[0]).toContain('forge-run-kept');
    });

    it('refuses the removal when the lock cannot be read: whether a run writes the journal is not known', async () => {
      const forgeId = await ranOnce();
      handler.setJournalLocks({
        holder: () => {
          throw new Error('EACCES: permission denied');
        },
        take: () => ({ release: () => {} }),
      });

      await send('forge:undo', { forgeId });

      const refusal = lastError('forge:undo:error');
      expect(refusal['code']).toBe('RUN_WRITING');
      expect(String(refusal['message'])).toContain('EACCES: permission denied');
    });

    it('goes on to the removal when nobody holds the lock', async () => {
      const forgeId = await ranOnce();
      const locks = freeLocks();
      handler.setJournalLocks(locks);

      await send('forge:undo', { forgeId });

      expect(locks.holder).toHaveBeenCalledTimes(1);
      expect(posted('forge:undo:error').map((e) => e.payload['code'])).not.toContain('RUN_WRITING');
    });

    it('is taken by the removal of a run, as a removal, and let go once the removal has ended', async () => {
      const forgeId = await ranOnce();
      const locks = freeLocks();
      handler.setJournalLocks(locks);

      await send('forge:undo', { forgeId });

      expect(locks.taken).toHaveLength(1);
      expect(locks.taken[0]).toContain('forge-run-kept');
      expect(vi.mocked(locks.take).mock.calls[0]?.[1]).toMatchObject({
        journalId: 'forge-run-kept',
        target: 'TGT',
        removes: true,
      });
      expect(locks.released).toEqual(locks.taken);
    });

    it('refuses the removal when a run took the lock after it was read, nothing read', async () => {
      const forgeId = await ranOnce();
      handler.setJournalLocks({ holder: () => undefined, take: () => ({ busy: CLI_RUN }) });
      const statementsBefore = org.statements.length;

      await send('forge:undo', { forgeId });

      const refusal = lastError('forge:undo:error');
      expect(refusal['code']).toBe('RUN_WRITING');
      expect(String(refusal['message'])).toContain(
        'The run forge-run-kept still writes this journal: started from the command line to TGT',
      );
      expect(org.statements.length).toBe(statementsBefore);
    });

    it('refuses a resume of a run whose journal another process writes', async () => {
      const forgeId = await ranOnce();
      handler.setJournalLocks({
        holder: () => ({ ...CLI_RUN, ranFrom: 'editor' as const, target: undefined }),
        take: () => ({ release: () => {} }),
      });

      await send('forge:resume-run', { forgeId });

      const refusal = lastError();
      expect(refusal['code']).toBe('RESUME_UNAVAILABLE');
      expect(String(refusal['message'])).toContain(
        'The run forge-run-kept still writes this journal: started in VS Code at ' +
          '2026-11-14T14:02:00.000Z (process 4242 on elsewhere). Taken up now, two runs would ' +
          'write the same journal; resume it once it has ended. Stop it on the Forge page that ' +
          'runs it, or let it end.',
      );
    });
  });
  describe('the journal’s lock, read and taken through the command line’s own lock file', () => {
    /** Hold the lock of the journal `journalId` as a run of the command line on another machine. */
    function heldByTheCommandLine(journalId: string) {
      const taken = lockForgeRun(
        journal.pathOf(journalId),
        { journalId, ranFrom: 'commandLine', target: 'TGT' },
        { self: { host: 'another-machine', pid: 4242, startedAt: new Date().toISOString() } },
      );
      if (!('lock' in taken)) throw new Error('The lock was held already.');
      return taken.lock;
    }

    /** A journal a run left without its end, one record created: as a closed window leaves it. */
    async function leftWithoutItsEnd(journalId: string): Promise<void> {
      await journal.begin(journalId, 'tgt', new Date('2026-11-14T14:02:00.000Z'), {
        sourceOrgId: 'src',
        fingerprint: 'f'.repeat(64),
        startedWith: { graph: graph(), config: recordsConfig() },
      });
      const store = journal.open(journalId);
      store.beginPart(new Date('2026-11-14T14:02:00.000Z'));
      store.setMapping('created', account(1), fakeId('Account', 'T', 1), 'Account');
      store.flush();
    }

    async function listed(): Promise<ForgeExecutionResult[]> {
      await send(
        'forge:history:list',
        {},
        `wv-history-${posted('forge:history:list:response').length}`,
      );
      return (posted('forge:history:list:response').at(-1)?.payload.history ??
        []) as ForgeExecutionResult[];
    }

    it('holds the lock while the panel’s run writes the target, and lets it go once its part has ended', async () => {
      await execute(recordsConfig());

      expect(lastResult().status).toBe('success');
      expect(locksWhileWriting.length).toBeGreaterThan(0);
      expect(locksWhileWriting.every((locks) => locks.length === 1)).toBe(true);
      expect(
        readdirSync(path.join(storage, 'forge-runs')).filter((n) => n.endsWith('.lock')),
      ).toEqual([]);
    });

    it('lists no run left over whose journal a run of the command line still writes, and lists it once that run has ended', async () => {
      await leftWithoutItsEnd('forge-run-cli');
      const lock = heldByTheCommandLine('forge-run-cli');

      expect(await listed()).toEqual([]);

      lock.release();
      expect(await listed()).toEqual([
        expect.objectContaining({ interrupted: true, journalId: 'forge-run-cli' }),
      ]);
    });

    it('refuses the removal of a run whose journal the command line still writes, in the command line’s words', async () => {
      await leftWithoutItsEnd('forge-run-cli');
      const [entry] = await listed();
      const lock = heldByTheCommandLine('forge-run-cli');
      const holder = forgeRunWriting(journal.pathOf('forge-run-cli'));
      if (!holder) throw new Error('No holder read.');

      await send('forge:undo', { forgeId: entry?.forgeId });

      const refusal = lastError('forge:undo:error');
      expect(refusal['code']).toBe('RUN_WRITING');
      expect(String(refusal['message'])).toContain(forgeRunWritingWords(holder).slice(1));
      expect(String(refusal['message'])).toContain(
        'Stop it with Ctrl-C in the terminal it runs in',
      );
      lock.release();
    });

    it('refuses a resume while a removal of the command line deletes what the run wrote, the removal named', async () => {
      await leftWithoutItsEnd('forge-run-cli');
      const [entry] = await listed();
      const taken = lockForgeRun(
        journal.pathOf('forge-run-cli'),
        { journalId: 'forge-run-cli', ranFrom: 'commandLine', target: 'TGT', removes: true },
        { self: { host: 'another-machine', pid: 4242, startedAt: new Date().toISOString() } },
      );
      if (!('lock' in taken)) throw new Error('The lock was held already.');

      await send('forge:resume-run', { forgeId: entry?.forgeId });

      const refusal = lastError();
      expect(refusal['code']).toBe('RESUME_UNAVAILABLE');
      expect(String(refusal['message'])).toContain(
        'A removal of the run forge-run-cli deletes what it wrote from TGT: started from the ' +
          'command line',
      );
      expect(org.inserted.size).toBe(0);
      taken.lock.release();
    });

    it('refuses the previews of that removal — its sweep and what the target’s automation does — while the run writes its journal', async () => {
      await leftWithoutItsEnd('forge-run-cli');
      const [entry] = await listed();
      const lock = heldByTheCommandLine('forge-run-cli');

      await send('forge:undo-sweep:request', { forgeId: entry?.forgeId });
      await send('forge:undo-automation:request', { forgeId: entry?.forgeId });

      expect(lastError('forge:undo-sweep:error')['code']).toBe('RUN_WRITING');
      expect(lastError('forge:undo-automation:error')['code']).toBe('RUN_WRITING');
      lock.release();
    });
  });
});
