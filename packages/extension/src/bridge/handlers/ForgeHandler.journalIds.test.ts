import path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  BaseMessage,
  ForgeConfig,
  ForgeExecutionResult,
  ForgeGraph,
  ForgeGraphNode,
  ForgeRemovalPlan,
  ForgeRunVerification,
  ForgeTargetAutomation,
} from '@sandforge/shared';
import { ForgeHandler } from './ForgeHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import type { ForgeOrchestrator } from '../../modules/forge/ForgeOrchestrator.js';
import { ForgeAbortedError } from '../../modules/forge/ForgeExecutor.js';
import type { ExecuteOptions, ExecutionSummary } from '../../modules/forge/ForgeExecutor.js';
import { ForgeRunJournal, HISTORY_IDS_BOUND } from '../../modules/forge/ForgeRunJournal.js';
import { memoryRunFile, type ForgeRunStore } from '../../modules/forge/ForgeRunStore.js';
import { fingerprintFields, rowFingerprint } from '../../modules/forge/ForgeInFlight.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ForgeRemovalPlanStore } from '../../modules/forge/ForgeRemovalPlanStore.js';
import { keepPartialSummary } from '../../modules/forge/interruptedRun.js';
import { forgeRunResult } from '../../modules/forge/runResult.js';
import type {
  RunRecords,
  RunRemovalOptions,
  RunRemovalOutcome,
} from '../../modules/forge/ForgeRunRemoval.js';
import type { RunToVerify } from '../../modules/forge/RunVerifier.js';
import type { TargetAutomationReader } from '../../modules/forge/TargetAutomationReader.js';
import type { SaveDialogAdapter } from '../../adapters/fs/SaveDialogAdapter.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(async () => ({
    query: vi.fn(async () => ({ records: [], done: true, totalSize: 0 })),
    queryMore: vi.fn(),
    request: vi.fn(async () => ({ DataStorageMB: { Max: 200, Remaining: 150 } })),
  })),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({ checkApiLimits: vi.fn() }));

/** What each removal was handed to delete, how, and what it answers. */
const removals: Array<Array<{ objectApiName: string; ids: string[] }>> = [];
const removalOptions: RunRemovalOptions[] = [];
let removalAnswer: (plan: Array<{ objectApiName: string; ids: string[] }>) => RunRemovalOutcome;
vi.mock('../../modules/forge/ForgeRunRemoval.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/forge/ForgeRunRemoval.js')>();
  return {
    ...actual,
    removalOrg: () => ({}),
    removeRunRecords: vi.fn(
      async (
        _org: unknown,
        handed: Array<{ objectApiName: string; ids: string[] }> | RunRecords,
        options: RunRemovalOptions,
      ) => {
        removalOptions.push(options);
        // Read a page at a time, as a removal of a run past the bound is handed them.
        const plan: Array<{ objectApiName: string; ids: string[] }> = [];
        if (actual.isRunRecords(handed)) {
          for (const { objectApiName } of handed.objects) {
            const ids: string[] = [];
            for await (const page of handed.pages(objectApiName)) ids.push(...page);
            plan.push({ objectApiName, ids });
          }
        } else plan.push(...handed);
        removals.push(plan.map(({ objectApiName, ids }) => ({ objectApiName, ids: [...ids] })));
        return removalAnswer(plan);
      },
    ),
  };
});

/** What a removal of `plan` that took `gone` leaves, a page at a time, as a removal says it. */
function leftAfter(
  plan: ReadonlyArray<{ objectApiName: string; ids: readonly string[] }>,
  gone: readonly string[],
): RunRemovalOutcome['left'] {
  const taken = new Set(gone);
  return async function* left() {
    for (const { objectApiName, ids } of plan) {
      const still = ids.filter((id) => !taken.has(id));
      if (still.length > 0) yield { objectApiName, ids: still };
    }
  };
}

/** What each verification was asked. */
const verified: RunToVerify[] = [];
vi.mock('../../modules/forge/RunVerifier.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/forge/RunVerifier.js')>();
  return {
    ...actual,
    verifiedOrg: () => ({}),
    RunVerifier: class {
      verify(run: RunToVerify): Promise<ForgeRunVerification> {
        verified.push(run);
        return Promise.resolve({
          verdict: 'verified',
          verifiedAt: '2026-10-14T12:00:00.000Z',
          attempts: 1,
          objects: [],
        });
      }
    },
  };
});

/*
 * A run that maps more records than the history keeps the ids of keeps them
 * in its journal: its summary, its history entry and its removal plan carry
 * its counts, and every reader of its ids — the removal and its
 * confirmation, Verify, a retry, the Id map saved, the record opened — reads
 * them from the journal. One whose journal is gone says so, and offers
 * nothing that needs them.
 */

const TARGET_ORG = '00D000000000001AAA';
/** Records mapped, one past the bound. */
const PAST_THE_BOUND = HISTORY_IDS_BOUND + 1;

/**
 * The most an entry of the history takes once its ids are in the journal, in
 * bytes of JSON: VS Code's global state rewrites the whole history at every
 * change, and is not made for megabytes.
 */
const ENTRY_BYTES = 10_000;

/** A source id and its target id, the `n`-th, of an object's prefix. */
const sourceOf = (prefix: string, n: number): string =>
  `${prefix}S${String(n).padStart(11, '0')}AAA`;
const targetOf = (prefix: string, n: number): string =>
  `${prefix}T${String(n).padStart(11, '0')}AAA`;

function node(objectApiName: string, level: number): ForgeGraphNode {
  return {
    objectApiName,
    recordCount: 10,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    errors: [],
    level,
    successCount: 0,
    failureCount: 0,
    createableFieldCount: 0,
    estimatedSizeMB: 0,
    estimatedApiCalls: 0,
    batchStrategy: 'auto',
  };
}

const GRAPH: ForgeGraph = {
  nodes: [node('Account', 0), node('Contact', 1)],
  edges: [
    {
      sourceObject: 'Account',
      targetObject: 'Contact',
      relationshipName: 'Contacts',
      type: 'lookup',
    },
  ],
  totalRecords: 20,
  estimatedSizeMB: 0.02,
  estimatedDurationSeconds: 0.1,
};

const CONFIG: ForgeConfig = {
  inputMode: 'soql',
  soqlQuery: 'SELECT Id FROM Contact',
  depth: 'direct',
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  anonymizePII: false,
  skipEmpty: false,
  batchSize: 'auto',
};

const QUIET: ForgeTargetAutomation = {
  objectsRead: ['Account', 'Contact'],
  objects: [],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 3,
};

/** A file name as the platform writes it. */
const at = (filePath: string): string => path.normalize(filePath);

/** A disk in memory under a real journal: each file a journal file the store can write and read. */
function memoryDisk() {
  const files = new Map<string, ReturnType<typeof memoryRunFile>>();
  const fileAt = (filePath: string): ReturnType<typeof memoryRunFile> => {
    let file = files.get(at(filePath));
    if (!file) {
      file = memoryRunFile();
      files.set(at(filePath), file);
    }
    return file;
  };
  const journal = new ForgeRunJournal({
    storagePath: '/storage',
    appendFile: async (filePath, content) => fileAt(filePath).append(content),
    readLines: (filePath) =>
      (async function* lines(): AsyncGenerator<string> {
        for (const line of (files.get(at(filePath))?.text() ?? '').split('\n')) yield line;
      })(),
    mkdir: async () => {},
    rm: async (filePath) => void files.delete(at(filePath)),
    listFiles: async (dirPath) =>
      [...files.keys()]
        .filter((filePath) => path.dirname(filePath) === at(dirPath))
        .map((filePath) => path.basename(filePath)),
    openRunFile: (filePath) => fileAt(filePath),
  });
  return { journal, files };
}

/** The removal plans in memory, as the extension's storage keeps them. */
function memoryPlans(): ForgeRemovalPlanStore {
  let text = '';
  return new ForgeRemovalPlanStore({
    storagePath: '/storage',
    readFile: async () => {
      if (!text) throw new Error('ENOENT');
      return text;
    },
    writeFile: async (_filePath, content) => {
      text = content;
    },
    rename: async () => {},
    mkdir: async () => {},
  });
}

/**
 * What the executor returns of a run that wrote through `store`: past
 * `bound`, the counts and none of the ids, as `ForgeExecutor.summaryOf` does.
 */
function summaryOf(store: ForgeRunStore, bound: number | undefined): ExecutionSummary {
  const created = store.countsByObject().reduce((sum, object) => sum + object.created, 0);
  const counts = {
    successCount: created,
    updatedCount: 0,
    linkedCount: store.countsByObject().reduce((sum, object) => sum + object.linked, 0),
    wouldInsertCount: 0,
    failedCount: 0,
    skippedCount: 0,
    remapCount: store.mappedSize,
    errors: [],
    truncatedObjects: [],
    existingRecords: [],
    remapByObject: store.countsByObject(),
    readByObject: [],
    failedReads: [],
  };
  if (bound !== undefined && store.mappedSize > bound) {
    return {
      ...counts,
      remapTable: {},
      existingSourceIds: [],
      updatedSourceIds: [],
      createdByObject: [],
      remapInJournal: true,
    };
  }
  const remapTable: Record<string, string> = {};
  const byObject = new Map<string, string[]>();
  const existing: string[] = [];
  for (const mapping of store.mappings()) {
    remapTable[mapping.sourceId] = mapping.targetId;
    if (mapping.kind !== 'created') {
      existing.push(mapping.sourceId);
      continue;
    }
    const ids = byObject.get(mapping.objectApiName ?? '') ?? [];
    ids.push(mapping.sourceId);
    byObject.set(mapping.objectApiName ?? '', ids);
  }
  return {
    ...counts,
    remapTable,
    existingSourceIds: existing,
    updatedSourceIds: [],
    createdByObject: [...byObject].map(([objectApiName, sourceIds]) => ({
      objectApiName,
      sourceIds,
    })),
  };
}

/**
 * Write a run through `store`: an account it linked to, an account it
 * created, and `contacts` contacts it created — past the bound unless told
 * fewer.
 */
function writeTheRun(store: ForgeRunStore | undefined, contacts = PAST_THE_BOUND - 1): void {
  if (!store) throw new Error('no store');
  store.beginPart(new Date());
  store.setMapping('existing', sourceOf('001', 0), targetOf('001', 0), 'Account');
  store.setMapping('created', sourceOf('001', 1), targetOf('001', 1), 'Account');
  for (let n = 1; n <= contacts; n++) {
    store.setMapping('created', sourceOf('003', n), targetOf('003', n), 'Contact');
  }
}

type Execute = (
  graph: ForgeGraph,
  config: ForgeConfig,
  options?: Pick<ExecuteOptions, 'beforeWrite' | 'stream' | 'writtenBefore'>,
) => Promise<ForgeExecutionResult>;

/** A run that writes `contacts` contacts and ends, its result built as the orchestrator builds it. */
const endsAfter =
  (contacts?: number): Execute =>
  async (graph, _config, options) => {
    const store = options?.stream?.store;
    writeTheRun(store, contacts);
    if (!store) throw new Error('no store');
    return forgeRunResult(summaryOf(store, options?.stream?.summaryBound), graph, {
      startedAt: Date.now(),
      status: 'success',
    });
  };

/** A run that writes past the bound and ends. */
const endsPastTheBound: Execute = endsAfter();

describe('a run whose ids are in its journal', () => {
  let deps: HandlerDeps;
  let configStore: ConfigStore;
  let disk: ReturnType<typeof memoryDisk>;
  let plans: ForgeRemovalPlanStore;
  let saved: string[];
  let execute: ReturnType<typeof vi.fn>;
  let handler: ForgeHandler;
  /** A window of the editor opened on the same storage: a handler of its own. */
  let windowOpened: () => ForgeHandler;

  beforeEach(() => {
    removals.length = 0;
    removalOptions.length = 0;
    verified.length = 0;
    removalAnswer = (plan) => ({
      objects: plan.map(({ objectApiName, ids }) => ({
        objectApiName,
        planned: ids.length,
        deleted: ids.length,
        alreadyGone: 0,
        keptChanged: 0,
        keptDependents: 0,
        refused: 0,
        heldBy: [],
        unchecked: [],
        reasons: [],
      })),
      cancelled: false,
      gone: plan.flatMap(({ ids }) => ids),
      left: leftAfter(
        plan,
        plan.flatMap(({ ids }) => ids),
      ),
      stamps: {},
    });
    disk = memoryDisk();
    plans = memoryPlans();
    saved = [];
    configStore = new ConfigStore(new InMemoryConfigStoreBackend());
    configStore.initialize();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn((id: string) =>
          id === 'tgt-org'
            ? { orgType: 'Sandbox', alias: 'DEV', orgId: TARGET_ORG }
            : { orgType: 'Sandbox', alias: 'UAT', orgId: '00D000000000009AAA' },
        ),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      services: {
        getSandforgeSetting: <T>(_key: string, fallback: T): T => fallback,
      } as unknown as HandlerDeps['services'],
      infraServices: {
        productionGuard: new ProductionGuard({ requestRunConfirmation: async () => true }),
      } as unknown as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    const saveDialog = {
      saveStream: async <T>(
        _name: string,
        write: (append: (text: string) => Promise<void>) => Promise<T>,
      ) => {
        const pieces: string[] = [];
        const result = await write(async (text) => void pieces.push(text));
        saved.push(pieces.join(''));
        return { status: 'saved' as const, path: '/picked/id-map.csv', result };
      },
    } as unknown as SaveDialogAdapter;
    execute = vi.fn(endsPastTheBound);
    windowOpened = (): ForgeHandler => {
      const opened = new ForgeHandler(deps, undefined, saveDialog);
      opened.setForgeOrchestrator(
        {
          execute,
          on: vi.fn().mockReturnValue(vi.fn()),
          abort: vi.fn(),
          pause: vi.fn(),
          resume: vi.fn(),
          clearDiscoveryCache: vi.fn(),
        } as unknown as ForgeOrchestrator,
        {
          targetAutomation: {
            readForGraph: vi.fn(async () => QUIET),
            read: vi.fn(async () => QUIET),
          } as unknown as TargetAutomationReader,
          runJournal: disk.journal,
          removalPlans: plans,
        },
      );
      return opened;
    };
    handler = windowOpened();
  });

  function send(id: string, type: string, payload: unknown): Promise<boolean> {
    return handler.handle(
      inboundRequest({ id, type, timestamp: Date.now(), payload } as BaseMessage),
    );
  }

  function posted(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  }

  function answerTo(id: string, type: string): Record<string, unknown> | undefined {
    return posted(type).find((m) => m.correlationId === id)?.payload;
  }

  const stored = (): ForgeExecutionResult[] =>
    configStore.get<ForgeExecutionResult[]>('forge:history') ?? [];

  async function listed(): Promise<{
    history: ForgeExecutionResult[];
    olderRuns?: ForgeRemovalPlan[];
  }> {
    const id = `wv-history-${posted('forge:history:list:response').length}`;
    await send(id, 'forge:history:list', {});
    return answerTo(id, 'forge:history:list:response') as {
      history: ForgeExecutionResult[];
      olderRuns?: ForgeRemovalPlan[];
    };
  }

  /** The run past the bound, ended: its entry in the history. */
  async function runPastTheBound(): Promise<ForgeExecutionResult> {
    await send('wv-execute', 'forge:execute', { graph: GRAPH, config: CONFIG });
    const entry = stored()[0];
    if (!entry) throw new Error('no entry');
    return entry;
  }

  /** Remove the journal and what lies beside it, as a user clearing the extension's storage would. */
  function dropTheJournal(): void {
    for (const file of [...disk.files.keys()]) {
      if (file.includes('forge-runs')) disk.files.delete(file);
    }
  }

  it('keeps the counts in the history and the ids in the journal, which it names and keeps', async () => {
    const entry = await runPastTheBound();

    const [, , options] = execute.mock.calls[0] as Parameters<Execute>;
    expect(options?.stream?.summaryBound).toBe(HISTORY_IDS_BOUND);
    expect(entry).toMatchObject({
      remapInJournal: true,
      journalId: expect.stringMatching(/^forge-run-/),
      journalPart: 0,
      idRemapCount: PAST_THE_BOUND + 1,
      createdCount: PAST_THE_BOUND,
      idRemapTable: {},
      idRemapCreated: [],
    });
    // A few KB, what globalState rewrites, whatever the run's size.
    expect(Buffer.byteLength(JSON.stringify(configStore.get('forge:history')))).toBeLessThan(
      ENTRY_BYTES,
    );
    // The journal stays, ended: its run is not one to take up.
    expect(await disk.journal.lastEnd(entry.journalId ?? '')).toMatchObject({ status: 'success' });
    const { history } = await listed();
    expect(history[0]).not.toHaveProperty('journalGone');
    expect(history[0]).not.toHaveProperty('resumable');
  });

  it('keeps a run of 200 000 records in the history by its counts alone, and its removal still finds every record it created, read from the journal', async () => {
    const contacts = 200_000 - 2;
    execute.mockImplementation(endsAfter(contacts));

    const entry = await runPastTheBound();

    expect(entry).toMatchObject({
      remapInJournal: true,
      idRemapCount: 200_000,
      createdCount: contacts + 1,
      idRemapTable: {},
      idRemapExisting: [],
      idRemapCreated: [],
    });
    expect(Buffer.byteLength(JSON.stringify(stored()[0]))).toBeLessThan(ENTRY_BYTES);

    await send('wv-undo', 'forge:undo', { forgeId: entry.forgeId });

    const plan = removals[0] ?? [];
    expect(plan.map((object) => object.objectApiName)).toEqual(['Contact', 'Account']);
    expect(plan[0]?.ids).toHaveLength(contacts);
    expect(new Set(plan[0]?.ids).size).toBe(contacts);
    expect(plan[0]?.ids[0]).toBe(targetOf('003', contacts));
    expect(plan[0]?.ids[contacts - 1]).toBe(targetOf('003', 1));
    // The account it linked to is never the run's to remove.
    expect(plan[1]?.ids).toEqual([targetOf('001', 1)]);
    // Two hundred thousand mappings through the journal and back: a few
    // seconds here, several times that on a slow runner.
  }, 60_000);

  it('keeps in its journal, not in the history, the ids of a run of a few thousand records', async () => {
    // Under the command line's bound of 50 000, a run of 20 000 records put
    // more than a MB of ids into its entry, and the history keeps twenty.
    execute.mockImplementation(endsAfter(20_000));

    const entry = await runPastTheBound();

    expect(entry).toMatchObject({
      remapInJournal: true,
      journalId: expect.stringMatching(/^forge-run-/),
      idRemapCount: 20_002,
      idRemapTable: {},
    });
    expect(Buffer.byteLength(JSON.stringify(configStore.get('forge:history')))).toBeLessThan(
      ENTRY_BYTES,
    );
    expect(await disk.journal.lastEnd(entry.journalId ?? '')).toMatchObject({ status: 'success' });
  });

  it('keeps a small run as it was: its ids in the history, its journal gone, its removal read from the entry', async () => {
    execute.mockImplementation(endsAfter(3));

    const entry = await runPastTheBound();

    expect(entry).not.toHaveProperty('remapInJournal');
    expect(entry).not.toHaveProperty('journalId');
    expect(Object.keys(entry.idRemapTable ?? {})).toHaveLength(5);
    expect(entry.idRemapExisting).toEqual([sourceOf('001', 0)]);
    expect(entry.idRemapCreated).toEqual([
      { objectApiName: 'Account', sourceIds: [sourceOf('001', 1)] },
      {
        objectApiName: 'Contact',
        sourceIds: [sourceOf('003', 1), sourceOf('003', 2), sourceOf('003', 3)],
      },
    ]);
    expect([...disk.files.keys()].filter((file) => file.includes('forge-runs'))).toEqual([]);

    await send('wv-undo', 'forge:undo', { forgeId: entry.forgeId });

    expect(removals).toEqual([
      [
        {
          objectApiName: 'Contact',
          ids: [targetOf('003', 3), targetOf('003', 2), targetOf('003', 1)],
        },
        { objectApiName: 'Account', ids: [targetOf('001', 1)] },
      ],
    ]);
  });

  it('removes what the run created, read from its journal', async () => {
    const entry = await runPastTheBound();

    await send('wv-undo', 'forge:undo', { forgeId: entry.forgeId });

    expect(removals).toHaveLength(1);
    const plan = removals[0] ?? [];
    expect(plan.map((object) => object.objectApiName)).toEqual(['Contact', 'Account']);
    expect(plan[0]?.ids).toHaveLength(PAST_THE_BOUND - 1);
    expect(plan[0]?.ids[0]).toBe(targetOf('003', PAST_THE_BOUND - 1));
    // The account it linked to is never the run's to remove.
    expect(plan[1]?.ids).toEqual([targetOf('001', 1)]);
    expect(answerTo('wv-undo', 'forge:undo:response')).toMatchObject({
      result: { status: 'success' },
    });
  });

  it('keeps what a removal left beside the journal, counts it on the entry, and takes that alone next', async () => {
    const entry = await runPastTheBound();
    // The org refuses three of the contacts.
    const refused = new Set([targetOf('003', 1), targetOf('003', 2), targetOf('003', 3)]);
    removalAnswer = (plan) => ({
      objects: plan.map(({ objectApiName, ids }) => ({
        objectApiName,
        planned: ids.length,
        deleted: ids.filter((id) => !refused.has(id)).length,
        alreadyGone: 0,
        keptChanged: 0,
        keptDependents: 0,
        refused: ids.filter((id) => refused.has(id)).length,
        heldBy: [],
        unchecked: [],
        reasons: [],
      })),
      cancelled: false,
      gone: plan.flatMap(({ ids }) => ids.filter((id) => !refused.has(id))),
      left: leftAfter(
        plan,
        plan.flatMap(({ ids }) => ids.filter((id) => !refused.has(id))),
      ),
      stamps: {},
    });

    await send('wv-undo', 'forge:undo', { forgeId: entry.forgeId });

    const marked = stored()[0];
    expect(marked?.removalLeft).toBeUndefined();
    expect(marked?.removalLeftByObject).toEqual([{ objectApiName: 'Contact', count: 3 }]);
    expect(JSON.stringify(configStore.get('forge:history')).length).toBeLessThan(10_000);

    refused.clear();
    await send('wv-undo-again', 'forge:undo', { forgeId: entry.forgeId });
    expect(removals[1]).toEqual([
      {
        objectApiName: 'Contact',
        ids: [targetOf('003', 3), targetOf('003', 2), targetOf('003', 1)],
      },
    ]);
  });

  it('keeps what a removal stamped beside the journal, not on the entry, and tells the next removal and Verify', async () => {
    const entry = await runPastTheBound();
    const stamped = { [targetOf('001', 1)]: '2026-10-14T12:00:05.000+0000' };
    const refused = new Set([targetOf('001', 1)]);
    removalAnswer = (plan) => ({
      objects: plan.map(({ objectApiName, ids }) => ({
        objectApiName,
        planned: ids.length,
        deleted: ids.filter((id) => !refused.has(id)).length,
        alreadyGone: 0,
        keptChanged: 0,
        keptDependents: 0,
        refused: ids.filter((id) => refused.has(id)).length,
        heldBy: [],
        unchecked: [],
        reasons: [],
      })),
      cancelled: false,
      gone: plan.flatMap(({ ids }) => ids.filter((id) => !refused.has(id))),
      left: leftAfter(
        plan,
        plan.flatMap(({ ids }) => ids.filter((id) => !refused.has(id))),
      ),
      stamps: stamped,
    });

    await send('wv-undo', 'forge:undo', { forgeId: entry.forgeId });

    expect(stored()[0]).not.toHaveProperty('removalStamps');
    expect(await disk.journal.stampsOf(entry.journalId ?? '', 0)).toEqual(stamped);

    await send('wv-verify', 'forge:verify:request', { forgeId: entry.forgeId });
    expect(verified[0]?.removalStamps).toEqual(stamped);

    refused.clear();
    await send('wv-undo-again', 'forge:undo', { forgeId: entry.forgeId });
    expect(removalOptions[1]?.removalStamps).toEqual(stamped);
    expect(removals[1]).toEqual([{ objectApiName: 'Account', ids: [targetOf('001', 1)] }]);
  });

  it('verifies what the run created, its lookups read against every id the journal holds', async () => {
    const entry = await runPastTheBound();

    await send('wv-verify', 'forge:verify:request', { forgeId: entry.forgeId });

    expect(verified).toHaveLength(1);
    const run = verified[0];
    expect(run?.records.map((object) => [object.objectApiName, object.ids.length])).toEqual([
      ['Contact', PAST_THE_BOUND - 1],
      ['Account', 1],
    ]);
    expect(Object.keys(run?.remapTable ?? {})).toHaveLength(PAST_THE_BOUND + 1);
    expect(answerTo('wv-verify', 'forge:verify:response')).toBeDefined();
  });

  it('retries against what the journal says the run wrote', async () => {
    const entry = await runPastTheBound();
    execute.mockImplementation(async () => ({ ...entry, forgeId: 'forge-retry' }));

    await send('wv-retry', 'forge:execute', {
      graph: GRAPH,
      config: CONFIG,
      retryOf: entry.forgeId,
    });

    const [, , options] = execute.mock.calls[1] as Parameters<Execute>;
    expect(Object.keys(options?.writtenBefore ?? {})).toHaveLength(PAST_THE_BOUND + 1);
    expect(options?.writtenBefore?.[sourceOf('003', 7)]).toBe(targetOf('003', 7));
  });

  it('saves its Id map from the journal, a line per record, as the results page writes one', async () => {
    const entry = await runPastTheBound();

    await send('wv-export', 'forge:export-ids:request', { forgeId: entry.forgeId });

    expect(answerTo('wv-export', 'forge:export-ids:response')).toEqual({
      status: 'saved',
      path: '/picked/id-map.csv',
      rows: PAST_THE_BOUND + 1,
    });
    const lines = (saved[0] ?? '').split('\n');
    expect(lines[0]).toBe('"Object","Source Id","Target Id","Outcome"');
    expect(lines).toHaveLength(PAST_THE_BOUND + 2);
    expect(lines).toContain(
      `"Account","${sourceOf('001', 0)}","${targetOf('001', 0)}","linked to existing"`,
    );
    expect(lines).toContain(`"Contact","${sourceOf('003', 5)}","${targetOf('003', 5)}","created"`);
  });

  it('keeps a run past the bound that stopped, with its journal, to remove and take up', async () => {
    execute.mockImplementation(async (graph: ForgeGraph, _config: ForgeConfig, options) => {
      const store = (options as ExecuteOptions | undefined)?.stream?.store;
      writeTheRun(store);
      if (!store) throw new Error('no store');
      const error = new ForgeAbortedError('Forge execution was aborted by user request.');
      keepPartialSummary(error, summaryOf(store, (options as ExecuteOptions).stream?.summaryBound));
      void graph;
      throw error;
    });

    await send('wv-execute', 'forge:execute', { graph: GRAPH, config: CONFIG });

    const entry = stored()[0];
    expect(entry).toMatchObject({ cancelled: true, remapInJournal: true, journalPart: 0 });
    expect((await listed()).history[0]).toMatchObject({ resumable: true });
    await send('wv-undo', 'forge:undo', { forgeId: entry?.forgeId });
    expect(removals[0]?.[0]?.ids).toHaveLength(PAST_THE_BOUND - 1);
  });

  it('keeps it removable once the history drops it, from a plan that names the journal and holds no id', async () => {
    const entry = await runPastTheBound();
    // The history let it go: it keeps the last twenty runs.
    configStore.set('forge:history', [], 'forge');
    const kept = await plans.get(entry.forgeId);
    expect(kept).toMatchObject({
      objects: [],
      inJournal: {
        journalId: entry.journalId,
        part: 0,
        left: [
          { objectApiName: 'Contact', count: PAST_THE_BOUND - 1 },
          { objectApiName: 'Account', count: 1 },
        ],
      },
    });
    expect(JSON.stringify(kept).length).toBeLessThan(2_000);
    expect((await listed()).olderRuns?.map((plan) => plan.forgeId)).toEqual([entry.forgeId]);

    await send('wv-undo', 'forge:undo', { forgeId: entry.forgeId });

    expect(removals[0]?.map((object) => object.ids.length)).toEqual([PAST_THE_BOUND - 1, 1]);
  });

  it('says its journal is gone, and offers nothing that needs its ids', async () => {
    const entry = await runPastTheBound();
    dropTheJournal();

    const { history } = await listed();
    expect(history[0]).toMatchObject({ forgeId: entry.forgeId, journalGone: true });
    expect(stored()[0]).not.toHaveProperty('journalGone');

    await send('wv-undo', 'forge:undo', { forgeId: entry.forgeId });
    await send('wv-verify', 'forge:verify:request', { forgeId: entry.forgeId });
    await send('wv-export', 'forge:export-ids:request', { forgeId: entry.forgeId });
    await send('wv-retry', 'forge:execute', {
      graph: GRAPH,
      config: CONFIG,
      retryOf: entry.forgeId,
    });

    expect(removals).toEqual([]);
    expect(verified).toEqual([]);
    expect(saved).toEqual([]);
    expect(answerTo('wv-undo', 'forge:undo:error')).toMatchObject({ code: 'JOURNAL_GONE' });
    expect(answerTo('wv-verify', 'forge:verify:error')).toMatchObject({ code: 'JOURNAL_GONE' });
    expect(answerTo('wv-export', 'forge:export-ids:error')).toMatchObject({ code: 'JOURNAL_GONE' });
    expect(answerTo('wv-retry', 'forge:execute:error')).toMatchObject({
      code: 'RETRY_UNAVAILABLE',
      message: expect.stringContaining('journal, which is gone'),
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('drops the journal of a run that ended once neither the history nor a plan names it', async () => {
    const entry = await runPastTheBound();
    const file = at(`/storage/forge-runs/${entry.journalId ?? ''}.ndjson`);
    expect(disk.files.has(file)).toBe(true);

    configStore.set('forge:history', [], 'forge');
    await plans.update(entry.forgeId, () => undefined);
    await listed();

    expect(disk.files.has(file)).toBe(false);
  });

  describe('removed once its window closed while an insert call was under way', () => {
    /** The contact the call sent, as it sent it and as the target holds it once written. */
    const SENT = { LastName: 'Marked', Email: 'marked@example.com.invalid' };
    const USER = '005000000000001AAA';
    const IN_FLIGHT = sourceOf('003', 900_001);
    const FOUND = targetOf('003', 900_001);
    /** What the target answers the read of the records the run's user created. */
    let held: Array<Record<string, unknown>>;
    /** Why the target cannot be reached, when it cannot. */
    let unreachable: string | undefined;
    /** When the target created each record, by its id. */
    const createdAt = new Map([
      [targetOf('001', 1), '2026-10-20T10:00:01.000+0000'],
      [targetOf('003', 3), '2026-10-20T10:03:00.000+0000'],
      [FOUND, '2026-10-20T10:04:30.000+0000'],
    ]);

    beforeEach(() => {
      held = [];
      unreachable = undefined;
      vi.mocked(getJsforceConnection).mockImplementation(async () => {
        if (unreachable) throw new Error(unreachable);
        return {
          query: vi.fn(async (soql: string) => {
            if (soql.includes('WHERE CreatedById = ')) {
              return { records: held, done: true, totalSize: held.length };
            }
            const dated = /^SELECT CreatedDate FROM \w+ WHERE Id = '(\w+)'$/.exec(soql);
            const at = dated ? createdAt.get(dated[1]) : undefined;
            return at
              ? { records: [{ CreatedDate: at }], done: true, totalSize: 1 }
              : { records: [], done: true, totalSize: 0 };
          }),
          queryMore: vi.fn(),
          identity: vi.fn(async () => ({ user_id: USER })),
          request: vi.fn(async () => ({ DataStorageMB: { Max: 200, Remaining: 150 } })),
        } as never;
      });
    });

    /**
     * The run writes `contacts` contacts, keeps the call of one more as it
     * goes, and its window closes before the call's answer; the window opened
     * again lists it, interrupted.
     */
    async function closedDuringTheCall(contacts: number): Promise<ForgeExecutionResult> {
      execute.mockImplementation(async (_graph: ForgeGraph, _config: ForgeConfig, options) => {
        const store = (options as ExecuteOptions | undefined)?.stream?.store;
        writeTheRun(store, contacts);
        const fields = fingerprintFields([SENT]);
        store?.sent('Contact', fields, [
          { sourceId: IN_FLIGHT, fingerprint: rowFingerprint(SENT, fields) },
        ]);
        return new Promise<ForgeExecutionResult>(() => {});
      });
      void send('wv-execute', 'forge:execute', { graph: GRAPH, config: CONFIG });
      await vi.waitFor(() => expect(execute).toHaveBeenCalled());
      handler = windowOpened();
      const { history } = await listed();
      const entry = history[0];
      expect(entry).toMatchObject({ interrupted: true });
      return entry;
    }

    it('removes with the run the record the target holds of the call, which its journal did not name', async () => {
      const entry = await closedDuringTheCall(3);
      expect(entry.remapInJournal).toBeUndefined();
      held = [{ Id: FOUND, ...SENT }];

      await send('wv-undo', 'forge:undo', { forgeId: entry.forgeId });

      const contacts = removals[0]?.find((object) => object.objectApiName === 'Contact')?.ids;
      expect(contacts).toHaveLength(4);
      expect(contacts).toContain(FOUND);
      expect(answerTo('wv-undo', 'forge:undo:response')?.result).not.toHaveProperty(
        'mayHaveBeenWritten',
      );
      // The history takes it in, and the plan kept of the run too.
      expect(stored()[0]).toMatchObject({ createdCount: 5 });
      expect(stored()[0]?.idRemapTable?.[IN_FLIGHT]).toBe(FOUND);
    });

    it('dates the removal by when the target created the first and the last record its journal names, the one found last', async () => {
      const entry = await closedDuringTheCall(3);
      // Recorded as of when its part began, for no length of time: a record
      // written ten seconds later would read as changed since the run.
      expect(entry).toMatchObject({ duration: 0 });
      held = [{ Id: FOUND, ...SENT }];

      await send('wv-undo', 'forge:undo', { forgeId: entry.forgeId });

      expect(removalOptions[0]).toMatchObject({
        runStartedAt: new Date('2026-10-20T10:00:01.000Z'),
        runEndedAt: new Date('2026-10-20T10:04:30.000Z'),
      });
      expect(removalOptions[0]).not.toHaveProperty('runRecordedAt');
    });

    it('verifies the run dated from its journal as well', async () => {
      const entry = await closedDuringTheCall(3);

      await send('wv-verify', 'forge:verify:request', { forgeId: entry.forgeId });

      expect(verified[0]).toMatchObject({
        runStartedAt: new Date('2026-10-20T10:00:01.000Z'),
        runEndedAt: new Date('2026-10-20T10:03:00.000Z'),
      });
      expect(verified[0]).not.toHaveProperty('runRecordedAt');
    });

    it('removes it with a run whose ids are in its journal, counted with the rest', async () => {
      const entry = await closedDuringTheCall(PAST_THE_BOUND - 1);
      expect(entry.remapInJournal).toBe(true);
      held = [{ Id: FOUND, ...SENT }];

      await send('wv-undo', 'forge:undo', { forgeId: entry.forgeId });

      const contacts = removals[0]?.find((object) => object.objectApiName === 'Contact')?.ids;
      expect(contacts).toHaveLength(PAST_THE_BOUND);
      expect(contacts).toContain(FOUND);
    });

    it('takes nothing of what the target may hold of the call, and says how many rows may be there', async () => {
      const entry = await closedDuringTheCall(3);
      // Two records like the one the call sent: which is the call's cannot be told.
      held = [
        { Id: FOUND, ...SENT },
        { Id: targetOf('003', 900_002), ...SENT },
      ];

      await send('wv-undo', 'forge:undo', { forgeId: entry.forgeId });

      const removed = removals[0]?.flatMap((object) => object.ids) ?? [];
      expect(removed).toHaveLength(4);
      expect(removed).not.toContain(FOUND);
      expect(answerTo('wv-undo', 'forge:undo:response')?.result).toMatchObject({
        mayHaveBeenWritten: 1,
      });
    });

    it('removes nothing when the target cannot be read for the call', async () => {
      const entry = await closedDuringTheCall(3);
      unreachable = 'ECONNREFUSED';

      await send('wv-undo', 'forge:undo', { forgeId: entry.forgeId });

      expect(removals).toEqual([]);
      expect(answerTo('wv-undo', 'forge:undo:error')).toMatchObject({
        code: 'IN_FLIGHT_UNREAD',
        message: expect.stringContaining('Nothing was deleted'),
      });
    });

    it('reads nothing of the target for a run whose calls were all answered', async () => {
      const entry = await runPastTheBound();
      vi.mocked(getJsforceConnection).mockClear();

      await send('wv-undo', 'forge:undo', { forgeId: entry.forgeId });

      expect(removals[0]?.[0]?.ids).toHaveLength(PAST_THE_BOUND - 1);
      // The removal reaches the org once, to remove; no read before it.
      expect(vi.mocked(getJsforceConnection)).toHaveBeenCalledTimes(1);
    });
  });
});
