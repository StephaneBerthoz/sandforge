import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BaseMessage,
  ForgeTargetAutomation,
  OrgCheckpoint,
  SalesforceOrg,
  UUID,
} from '@sandforge/shared';
import {
  OrgSafetyTier,
  pipelineCheckpointStepConfigSchema,
  pipelineRewindStepConfigSchema,
  rewindGrantDigest,
} from '@sandforge/shared';

import {
  CheckpointHandler,
  CheckpointStepRefused,
  type WindowWriters,
} from './CheckpointHandler.js';
import type { CheckpointFileDialogs, HandlerDeps } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { OrgConnectionError } from '../../core/connection/OrgConnectionError.js';
import { OrgManager } from '../../core/connection/OrgManager.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import {
  openCheckpointStore,
  type OrgCheckpointStore,
} from '../../modules/checkpoint/OrgCheckpointStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { newArchiveKey, parseArchiveKey } from '../../modules/checkpoint/checkpointArchive.js';
import { appendToRewindLedger, rewindLedgerFileOf } from '../../modules/checkpoint/rewindLedger.js';
import { StepCancelledError } from '../../modules/automation/StepExecutor.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { SandboxRefreshDetector } from '../../modules/monitor/SandboxRefreshDetector.js';
import type { SyncRunKept } from '../../modules/sync/SyncRunCreations.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import {
  MEMORY_ORG_USER,
  type MemoryChild,
  type MemoryOrgRequest,
} from '../../test/memoryRemovalOrg.js';
import { MemoryRestoreOrg } from '../../test/memoryRestoreOrg.js';
import { inboundRequest } from '../../test/mockFactories.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/*
 * The host of the Checkpoints page, on the memory org the bricks run on,
 * reached through a connection shaped as jsforce's: what each request
 * answers, on which channel, what it keeps on this machine, and what it
 * refuses — with the guard's words, never lifted by Production Guard.
 */

const ORG_ID = '00D000000000001AAA';
const REFRESHED_ORG_ID = '00D000000000009AAA';
const AUTOMATED_PROCESS = '005000000000002AAA';
const COLLEAGUE = '005000000000003AAA';
const REGISTERED = 'org-dev';

/** T0 on the org's clock. */
const T0 = Date.parse('2026-10-22T14:05:12.731Z');
const LONG_AGO = Date.parse('2026-10-01T09:00:00.000Z');
let clock = T0;

const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const STAMP_FIELDS = [
  { name: 'Id', label: 'Id', type: 'id', permissionable: false },
  { name: 'SystemModstamp', label: 'System Modstamp', type: 'datetime', permissionable: false },
  { name: 'CreatedDate', label: 'Created Date', type: 'datetime', permissionable: false },
  {
    name: 'CreatedById',
    label: 'Created By',
    type: 'reference',
    referenceTo: ['User'],
    permissionable: false,
  },
  {
    name: 'LastModifiedDate',
    label: 'Last Modified Date',
    type: 'datetime',
    permissionable: false,
  },
  {
    name: 'LastModifiedById',
    label: 'Last Modified By',
    type: 'reference',
    referenceTo: ['User'],
    permissionable: false,
  },
  { name: 'IsDeleted', label: 'Deleted', type: 'boolean', permissionable: false },
];
// Labelled as the org describes every field: what a rewind's give-back reads them by.
const writable = (name: string) => ({
  name,
  label: name,
  type: 'string',
  createable: true,
  updateable: true,
  nillable: true,
});
const FIELDS: Record<string, unknown[]> = {
  Account: [...STAMP_FIELDS, writable('Name')],
  Case: [...STAMP_FIELDS, writable('Subject')],
};

/**
 * The memory org as the handler reaches it: a global describe, `/limits`, its
 * record and its user; its updates made, as a rewind's give-back sends them.
 */
class HandlerTestOrg extends MemoryRestoreOrg {
  limits = { Max: 5_000_000, Remaining: 4_999_000 };
  /** Its daily email limits, as `/limits` lists them: none unless told. */
  emailLimits: Record<string, { Max: number; Remaining: number }> = {};
  /** Whether each read of its clock moves it a second, as time passes during a rewind. */
  ticking = false;

  constructor(
    says: { sandbox?: boolean; edition?: string } = {},
    children: Readonly<Record<string, readonly MemoryChild[]>> = {},
  ) {
    super(children, { now: () => clock });
    clock = LONG_AGO;
    for (const [name, fields] of Object.entries(FIELDS)) this.changeSchema(name, fields);
    this.add('Organization', {
      Id: ORG_ID,
      IsSandbox: says.sandbox ?? true,
      OrganizationType: says.edition ?? 'Enterprise Edition',
    });
    this.add('UserPermissionAccess', {
      Id: '0Up000000000001AAA',
      PermissionsViewAllData: true,
      PermissionsModifyAllData: true,
      PermissionsViewEncryptedData: false,
    });
    this.add('User', { Id: AUTOMATED_PROCESS, UserType: 'AutomatedProcess' });
    this.add('Account', { Id: id('001', 1), Name: 'Northwind' });
    this.add('Account', { Id: id('001', 2), Name: 'Contoso' });
    this.add('Case', { Id: id('500', 1), Subject: 'Broken' });
    clock = T0;
  }

  override async describeGlobal(): Promise<unknown> {
    this.requests++;
    return {
      sobjects: Object.keys(FIELDS).map((name) => ({
        name,
        label: name,
        queryable: true,
        createable: true,
        updateable: true,
        deletable: true,
        layoutable: true,
      })),
    };
  }

  override async request(request: MemoryOrgRequest): Promise<unknown> {
    if (request.method === 'GET' && request.url.endsWith('/limits')) {
      this.requests++;
      return { DailyApiRequests: this.limits, ...this.emailLimits };
    }
    return super.request(request);
  }

  override async serverTime(): Promise<string> {
    if (this.ticking) clock += 1_000;
    return super.serverTime();
  }
}

/**
 * The org behind a connection shaped as jsforce's, as every read of the
 * handler and its snapshot takes it, and as a rewind and an undo write through
 * it: updates and deletes by object, undeletes by SOAP.
 */
function connectionOf(org: HandlerTestOrg, onQuery?: (soql: string) => void) {
  return {
    get version() {
      return org.version;
    },
    request: (request: MemoryOrgRequest) => org.request(request),
    query: (soql: string, options?: { scanAll?: boolean }) => {
      onQuery?.(soql);
      return org.query(soql, options);
    },
    queryMore: (nextRecordsUrl: string) => org.queryMore(nextRecordsUrl),
    describe: (objectApiName: string) => org.describe(objectApiName),
    describeGlobal: () => org.describeGlobal(),
    tooling: { describeGlobal: () => Promise.resolve({ sobjects: [] }) },
    sobject: (objectApiName: string) => ({
      update: (records: Array<Record<string, unknown>>) => org.update(objectApiName, records),
      create: (records: Array<Record<string, unknown>>) => org.create(objectApiName, records),
      destroy: (ids: string[]) => org.destroy(objectApiName, ids),
    }),
    soap: {
      getServerTimestamp: async () => ({ timestamp: await org.serverTime() }),
      getUserInfo: async () => ({ userId: await org.userId() }),
      undelete: (ids: string[]) => org.undelete(ids),
    },
  };
}

function registered(overrides: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: REGISTERED as UUID,
    alias: 'DEV-SB',
    username: 'tester@example.com',
    instanceUrl: 'https://example.my.salesforce.com',
    orgId: ORG_ID,
    orgType: 'Sandbox',
    authMethod: 'sfdx_import',
    safetyTier: OrgSafetyTier.MEDIUM,
    appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '66.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-10-01T09:00:00.000Z',
    tags: [],
    ...overrides,
  };
}

type Posted = BaseMessage & { payload: Record<string, unknown> };

interface Harness {
  handler: CheckpointHandler;
  org: HandlerTestOrg;
  store: OrgCheckpointStore;
  registry: BackgroundOperationRegistry;
  tracker: LiveOperationTracker;
  detector: SandboxRefreshDetector;
  orgManager: OrgManager;
  posted: Posted[];
  logs: string[];
  /** The audit trail the handler records into, newest first. */
  trail: () => ReturnType<AuditTrailStore['list']>['entries'];
  productionGuard: { check: ReturnType<typeof vi.fn>; confirmIfNeeded: ReturnType<typeof vi.fn> };
  /** Called with every statement the org is sent through the connection. */
  onQuery: (hook: (soql: string) => void) => void;
  send: (id: string, type: string, payload?: unknown) => Promise<boolean>;
  /** The messages answering request `id`, by type. */
  answers: (id: string) => Posted[];
}

const dirs: string[] = [];
const trackers: LiveOperationTracker[] = [];

beforeEach(() => {
  clock = T0;
});

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const tracker of trackers.splice(0)) tracker.dispose();
  vi.mocked(getJsforceConnection).mockReset();
});

function harness(
  options: {
    org?: HandlerTestOrg;
    registered?: SalesforceOrg;
    writers?: WindowWriters;
    self?: { pid: number; startedAt: string };
    /** The window's dialogs the page's Export… and Import… pick their file in. */
    checkpointFiles?: CheckpointFileDialogs;
  } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-checkpoint-host-'));
  dirs.push(dir);
  const opened = openCheckpointStore({ root: join(dir, 'store'), locksDir: join(dir, 'locks') });
  if ('refusal' in opened) throw new Error(`no store: ${opened.refusal.reason}`);
  const org = options.org ?? new HandlerTestOrg();
  const orgManager = new OrgManager();
  orgManager.addOrg(options.registered ?? registered());
  const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
  configStore.initialize();
  const detector = new SandboxRefreshDetector({ configStore, orgManager, now: () => new Date(T0) });
  const registry = new BackgroundOperationRegistry();
  const tracker = new LiveOperationTracker();
  trackers.push(tracker);
  // Lets everything through, an override included: the checkpoint's own
  // guard is what refuses a production org, and nothing asks this one.
  const productionGuard = {
    check: vi.fn(() => ({ allowed: true, requiresConfirmation: false, warnings: [] })),
    confirmIfNeeded: vi.fn(() => Promise.resolve(true)),
    hasOverride: vi.fn(() => true),
  };
  const posted: Posted[] = [];
  const logs: string[] = [];
  let ids = 0;
  const deps = {
    log: (line: string) => logs.push(line),
    broker: { postToWebview: (message: Posted) => posted.push(message) },
    stateSync: {},
    orgManager,
    orgRegistry: {},
    configStore,
    secretVault: {},
    authProvider: {},
    sfdxBridge: {},
    infraServices: {
      backgroundRegistry: registry,
      productionGuard,
      ...(options.checkpointFiles ? { checkpointFiles: options.checkpointFiles } : {}),
    },
    nextId: () => `ext-${++ids}`,
    sandboxRefreshes: detector,
  } as unknown as HandlerDeps;
  let hook: (soql: string) => void = () => undefined;
  vi.mocked(getJsforceConnection).mockImplementation(
    async () => connectionOf(org, (soql) => hook(soql)) as never,
  );
  const handler = new CheckpointHandler(
    deps,
    options.writers,
    options.self ?? { pid: process.pid, startedAt: new Date().toISOString() },
  );
  handler.setStore(opened.store);
  handler.setLiveOperationTracker(tracker);
  return {
    handler,
    org,
    store: opened.store,
    registry,
    tracker,
    detector,
    orgManager,
    posted,
    logs,
    trail: () => new AuditTrailStore(configStore).list().entries,
    productionGuard,
    onQuery: (next) => {
      hook = next;
    },
    send: (requestId, type, payload) =>
      handler.handle(
        inboundRequest({
          id: requestId,
          type,
          timestamp: Date.now(),
          ...(payload !== undefined ? { payload } : {}),
        } as BaseMessage),
      ),
    answers: (requestId) => posted.filter((message) => message.correlationId === requestId),
  };
}

/** The one answer to `requestId`: its response, or its error. */
function answerOf(h: Harness, requestId: string): Posted {
  const answers = h.answers(requestId);
  expect(answers).toHaveLength(1);
  return answers[0];
}

const TAKE = { orgId: REGISTERED, name: 'Before UAT', mode: 'everything', keepDays: 30 };

/** Take a checkpoint through the handler, and give back its id. */
async function taken(h: Harness, requestId = 'wv-take-1'): Promise<string> {
  await h.send(requestId, 'checkpoint:take', TAKE);
  const answer = answerOf(h, requestId);
  expect(answer.type).toBe('checkpoint:take:response');
  return (answer.payload.checkpoint as { checkpointId: string }).checkpointId;
}

/** A Sync run's file, of the registered org, with no end. */
function syncRun(extra: Partial<SyncRunKept> = {}): SyncRunKept {
  return {
    runId: 'sync-run-1',
    configId: 'config-1',
    configName: 'Accounts',
    sourceOrgId: 'org-source',
    targetOrgId: REGISTERED,
    startedAt: new Date(T0 - 60_000).toISOString(),
    ...extra,
  } as SyncRunKept;
}

describe('CheckpointHandler — the take', () => {
  it('takes a checkpoint under the id of its request: progress on that id, listed in the registry and in Live Operations, answered with the checkpoint it kept', async () => {
    const h = harness();

    await h.send('wv-take-1', 'checkpoint:take', TAKE);

    const answer = answerOf(h, 'wv-take-1');
    expect(answer.type).toBe('checkpoint:take:response');
    expect(answer.payload.operationId).toBe('wv-take-1');
    const checkpoint = answer.payload.checkpoint as {
      checkpointId: string;
      name: string;
      status: string;
    };
    expect(checkpoint).toMatchObject({ name: 'Before UAT', status: 'ready' });
    expect((await h.store.list()).map((entry) => entry.checkpointId)).toEqual([
      checkpoint.checkpointId,
    ]);
    // What it sent, counted on the connection the handler opened, phase by
    // phase beside what it estimated: here the composites, which go through
    // the connection's requests as jsforce's do.
    const requests = answer.payload.requests as { total: number; byPhase: Record<string, number> };
    const estimate = answer.payload.estimate as { requestsByPhase?: Record<string, number> };
    expect(requests.total).toBe(Object.values(requests.byPhase).reduce((a, b) => a + b, 0));
    // The counts, then what the next phases read of the objects holding records.
    expect(requests.byPhase).toMatchObject({ counts: 2, bin: 1 });
    expect(estimate.requestsByPhase).toMatchObject({ counts: 2, bin: 1, stability: 2 });
    const operation = (type: string) =>
      h.posted.filter(
        (message) =>
          message.type === type &&
          (message.payload as { operationId?: unknown }).operationId === 'wv-take-1',
      );
    expect(operation('operation:started')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ module: 'checkpoint' }) as unknown,
      }),
    ]);
    expect(operation('operation:progress').length).toBeGreaterThan(0);
    expect(operation('operation:completed')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          result: expect.objectContaining({ status: 'success' }),
        }) as unknown,
      }),
    ]);
    await Promise.resolve();
    expect(h.registry.get('wv-take-1')).toMatchObject({
      module: 'checkpoint',
      status: 'completed',
    });
    expect(h.tracker.get('wv-take-1')).toMatchObject({ module: 'checkpoint', status: 'completed' });
  });

  it('refuses a production org with the checkpoint guard’s words, whatever Production Guard would let through, and keeps nothing', async () => {
    const h = harness({
      org: new HandlerTestOrg({ sandbox: false, edition: 'Enterprise Edition' }),
      registered: registered({ orgType: 'Production' }),
    });

    await h.send('wv-take-1', 'checkpoint:take', TAKE);

    const answer = answerOf(h, 'wv-take-1');
    expect(answer).toMatchObject({
      type: 'checkpoint:error',
      payload: {
        code: 'PRODUCTION',
        retryable: false,
        message: expect.stringContaining(
          'SandForge never takes a checkpoint of, or rewinds, a production org',
        ) as unknown,
      },
    });
    expect(h.productionGuard.check).not.toHaveBeenCalled();
    expect(h.productionGuard.confirmIfNeeded).not.toHaveBeenCalled();
    expect(await h.store.list()).toEqual([]);
  });

  it('stops a take from Live Operations’ Cancel between two reads: answered CANCELLED, nothing kept', async () => {
    const h = harness();
    h.onQuery((soql) => {
      if (/^SELECT Id, SystemModstamp, CreatedDate/.test(soql)) h.registry.abort('wv-take-1');
    });

    await h.send('wv-take-1', 'checkpoint:take', TAKE);

    expect(answerOf(h, 'wv-take-1')).toMatchObject({
      type: 'checkpoint:error',
      payload: { code: 'CANCELLED', retryable: true },
    });
    expect(await h.store.list()).toEqual([]);
    expect(h.registry.get('wv-take-1')?.status).toBe('aborted');
    expect(h.tracker.get('wv-take-1')?.status).toBe('cancelled');
  });

  it('takes a Stop sent while the org is still being reached: the take never starts', async () => {
    const h = harness();
    const conn = connectionOf(h.org);
    vi.mocked(getJsforceConnection).mockImplementation(async () => {
      // The page's Stop: `execution:abort` with the request's id.
      expect(h.registry.cancelBeforeStart('wv-take-1')).toBe(true);
      return conn as never;
    });

    await h.send('wv-take-1', 'checkpoint:take', TAKE);

    expect(answerOf(h, 'wv-take-1')).toMatchObject({
      type: 'checkpoint:error',
      payload: { code: 'CANCELLED' },
    });
    expect(h.registry.has('wv-take-1')).toBe(false);
    expect(h.posted.some((message) => message.type === 'operation:started')).toBe(false);
    expect(h.org.requests + h.org.soapCalls).toBe(0);
  });

  it('refuses a take while a Sync run of this window writes to the org, and while a run of another process alive does', async () => {
    const ofThisWindow = harness({ writers: { isRunning: (runId) => runId === 'sync-run-1' } });
    ofThisWindow.handler.setRunFiles('sync', { list: () => Promise.resolve([syncRun()]) });

    await ofThisWindow.send('wv-take-1', 'checkpoint:take', TAKE);

    expect(answerOf(ofThisWindow, 'wv-take-1')).toMatchObject({
      type: 'checkpoint:error',
      payload: {
        code: 'RUN_WRITING',
        retryable: true,
        message:
          'A SandForge run is writing to DEV-SB: take the checkpoint once it has ended. No record was read.',
      },
    });
    expect(await ofThisWindow.store.list()).toEqual([]);

    // A Seed run another window writes, its file naming that window's process.
    const elsewhere = harness({
      self: { pid: process.pid + 1, startedAt: new Date().toISOString() },
    });
    elsewhere.handler.setRunFiles('seed', {
      list: () =>
        Promise.resolve([
          syncRun({
            runId: 'seed-run-1',
            targetOrgId: 'another-entry',
            targetOrganizationId: ORG_ID,
            writer: { pid: process.pid, hostStartedAt: new Date().toISOString() },
            lastWriteAt: new Date().toISOString(),
          }),
        ]),
    });
    await elsewhere.send('wv-take-1', 'checkpoint:take', TAKE);
    expect(answerOf(elsewhere, 'wv-take-1').payload.code).toBe('RUN_WRITING');
  });

  it('refuses a take while a run of this window whose handler says it writes to the org does — a Forge clone, a Frozen load, a DataOps restore, an Autopilot run, a Real-Time session — and takes one once runs have ended', async () => {
    let forgeWriting = true;
    const h = harness({
      writers: { writingTo: (orgId) => forgeWriting && orgId === REGISTERED },
    });
    h.handler.setRunFiles('sync', {
      list: () => Promise.resolve([syncRun({ end: { at: new Date(T0).toISOString() } as never })]),
    });

    await h.send('wv-take-1', 'checkpoint:take', TAKE);
    expect(answerOf(h, 'wv-take-1').payload.code).toBe('RUN_WRITING');

    forgeWriting = false;
    await h.send('wv-take-2', 'checkpoint:take', TAKE);
    expect(answerOf(h, 'wv-take-2').type).toBe('checkpoint:take:response');
  });

  it('refuses a malformed take on the domain’s error channel, before anything is asked of the org', async () => {
    const h = harness();

    await h.send('wv-take-1', 'checkpoint:take', { ...TAKE, keepDays: -1 });

    expect(answerOf(h, 'wv-take-1')).toMatchObject({
      type: 'checkpoint:error',
      payload: { code: 'INVALID_PAYLOAD' },
    });
    expect(getJsforceConnection).not.toHaveBeenCalled();
  });

  it('says an expired scratch org is one, as its checkpoints are words', async () => {
    const h = harness();
    vi.mocked(getJsforceConnection).mockRejectedValue(
      new OrgConnectionError('SCRATCH_ORG_EXPIRED', REGISTERED, 'expired on 2026-10-01'),
    );

    await h.send('wv-take-1', 'checkpoint:take', TAKE);

    expect(answerOf(h, 'wv-take-1').payload).toMatchObject({
      code: 'SCRATCH_EXPIRED',
      message: 'DEV-SB is a scratch org that has expired: its checkpoints can only be deleted.',
    });
  });
});

describe('CheckpointHandler — the scope', () => {
  it('answers what a take would hold and cost, reading no record, with the refusal it would meet', async () => {
    const h = harness({ writers: { isRunning: () => true } });
    h.handler.setRunFiles('sync', { list: () => Promise.resolve([syncRun()]) });
    const asked: string[] = [];
    h.onQuery((soql) => asked.push(soql));

    await h.send('wv-scope-1', 'checkpoint:scope', { orgId: REGISTERED, mode: 'everything' });

    const answer = answerOf(h, 'wv-scope-1');
    expect(answer.type).toBe('checkpoint:scope:response');
    expect(answer.payload).toMatchObject({
      orgId: REGISTERED,
      mode: 'everything',
      estimate: { records: 3, apiRequestsLeft: 4_999_000 },
      refusal: { code: 'RUN_WRITING' },
    });
    // What it would hold of the org's files goes to the page with the rest:
    // the take says the files it keeps, and what it cannot see of them.
    expect(answer.payload.files).toEqual({ held: false, queryAllFiles: false, addedToPicked: [] });
    expect(
      (answer.payload.objects as Array<{ objectApiName: string }>)
        .map((o) => o.objectApiName)
        .sort(),
    ).toEqual(['Account', 'Case']);
    expect(asked.filter((soql) => /SELECT Id, SystemModstamp/.test(soql))).toEqual([]);
    expect(await h.store.list()).toEqual([]);
  });

  it('leaves out the objects the request excludes and holds the take to the limit it names, as the command line asks', async () => {
    const h = harness();

    await h.send('wv-scope-1', 'checkpoint:scope', {
      orgId: REGISTERED,
      mode: 'everything',
      excluded: ['Case'],
      maxTotal: 2,
    });
    await h.send('wv-scope-2', 'checkpoint:scope', {
      orgId: REGISTERED,
      mode: 'everything',
      maxTotal: 2,
    });

    const excluded = answerOf(h, 'wv-scope-1');
    expect(excluded.type).toBe('checkpoint:scope:response');
    expect(excluded.payload.objects).toEqual([
      expect.objectContaining({ objectApiName: 'Account', records: 2 }),
    ]);
    expect(excluded.payload.leftOut).toContainEqual({
      objectApiName: 'Case',
      reason: 'Left out as asked.',
    });
    expect(excluded.payload.refusal).toBeUndefined();
    // The three records of both objects, past the limit of two.
    expect(answerOf(h, 'wv-scope-2').payload.refusal).toMatchObject({
      code: 'TOO_MANY_RECORDS',
      message: expect.stringContaining('hold 3 records in DEV-SB, past its limit of 2') as unknown,
    });
  });
});

/** The handler's org with a list custom setting of two rows, and its user's Customize Application. */
class SettingsTestOrg extends HandlerTestOrg {
  constructor() {
    super();
    this.changeSchema('Endpoints__c', [
      ...STAMP_FIELDS,
      { ...writable('Name'), nillable: false },
      writable('Value__c'),
    ]);
    clock = LONG_AGO;
    this.add('Endpoints__c', { Id: id('a0B', 1), Name: 'Billing', Value__c: 'https://a.example' });
    this.add('Endpoints__c', { Id: id('a0B', 2), Name: 'Shipping', Value__c: 'https://b.example' });
    clock = T0;
    this.all('UserPermissionAccess')[0].PermissionsCustomizeApplication = true;
  }

  override async describeGlobal(): Promise<unknown> {
    const global = (await super.describeGlobal()) as { sobjects: unknown[] };
    return {
      sobjects: [
        ...global.sobjects,
        {
          name: 'Endpoints__c',
          label: 'Endpoints',
          queryable: true,
          createable: true,
          updateable: true,
          deletable: true,
          layoutable: true,
          customSetting: true,
        },
      ],
    };
  }
}

describe('CheckpointHandler — custom settings', () => {
  it('offers the org’s custom settings with the scope, and holds those the request names', async () => {
    const h = harness({ org: new SettingsTestOrg() });

    await h.send('wv-scope-1', 'checkpoint:scope', { orgId: REGISTERED, mode: 'everything' });
    await h.send('wv-scope-2', 'checkpoint:scope', {
      orgId: REGISTERED,
      mode: 'everything',
      customSettings: ['Endpoints__c'],
    });

    const offered = [
      { objectApiName: 'Endpoints__c', label: 'Endpoints', kind: 'list', records: 2 },
    ];
    const none = answerOf(h, 'wv-scope-1').payload;
    const one = answerOf(h, 'wv-scope-2').payload;
    expect(none.customSettings).toEqual(offered);
    expect(one.customSettings).toEqual(offered);
    expect(
      (none.objects as Array<{ objectApiName: string }>).map((o) => o.objectApiName),
    ).not.toContain('Endpoints__c');
    expect(one.objects).toContainEqual(
      expect.objectContaining({ objectApiName: 'Endpoints__c', customSetting: 'list', records: 2 }),
    );
  });

  it('takes the custom settings its request names, each kept with its kind', async () => {
    const h = harness({ org: new SettingsTestOrg() });

    await h.send('wv-take-1', 'checkpoint:take', { ...TAKE, customSettings: 'all' });

    const answer = answerOf(h, 'wv-take-1');
    expect(answer.type).toBe('checkpoint:take:response');
    const checkpoint = answer.payload.checkpoint as {
      objects: Array<{ objectApiName: string; customSetting?: string }>;
    };
    expect(checkpoint.objects).toContainEqual(
      expect.objectContaining({ objectApiName: 'Endpoints__c', customSetting: 'list' }),
    );
  });

  it('refuses a take that names a custom setting by anything but its API name, before reaching the org', async () => {
    const h = harness({ org: new SettingsTestOrg() });

    await h.send('wv-take-1', 'checkpoint:take', { ...TAKE, customSettings: ['Account'] });

    expect(answerOf(h, 'wv-take-1')).toMatchObject({
      type: 'checkpoint:error',
      payload: { code: 'INVALID_PAYLOAD' },
    });
    expect(getJsforceConnection).not.toHaveBeenCalled();
  });
});

describe('CheckpointHandler — what a take is asked beside its scope', () => {
  it('refuses a take past the limit its request names before reading a record, and keeps nothing', async () => {
    const h = harness();

    await h.send('wv-take-1', 'checkpoint:take', { ...TAKE, maxTotal: 2 });

    expect(answerOf(h, 'wv-take-1')).toMatchObject({
      type: 'checkpoint:error',
      payload: { code: 'TOO_MANY_RECORDS', retryable: false },
    });
    expect(await h.store.list()).toEqual([]);
  });

  it('takes the objects its request does not exclude, the excluded one named as left out', async () => {
    const h = harness();

    await h.send('wv-take-1', 'checkpoint:take', { ...TAKE, excluded: ['Case'], maxTotal: 2 });

    const answer = answerOf(h, 'wv-take-1');
    expect(answer.type).toBe('checkpoint:take:response');
    const checkpoint = answer.payload.checkpoint as {
      objects: Array<{ objectApiName: string }>;
      scope: { leftOut: Array<{ objectApiName: string; reason: string }> };
    };
    expect(checkpoint.objects.map((object) => object.objectApiName)).toEqual(['Account']);
    expect(checkpoint.scope.leftOut).toContainEqual({
      objectApiName: 'Case',
      reason: 'Left out as asked.',
    });
  });
});

describe('CheckpointHandler — the list', () => {
  it('lists an org’s checkpoints from this machine alone, those of the org before its refresh marked as such', async () => {
    const h = harness();
    const before = await taken(h);
    const connections = vi.mocked(getJsforceConnection).mock.calls.length;

    await h.send('wv-list-1', 'checkpoint:list', { orgId: REGISTERED });
    expect(answerOf(h, 'wv-list-1').payload.checkpoints).toEqual([
      expect.objectContaining({ checkpointId: before, valid: true }),
    ]);

    // The sandbox answers as another org: refreshed.
    h.detector.observe(REGISTERED, { organizationId: REFRESHED_ORG_ID }, 'connection');
    await h.send('wv-list-2', 'checkpoint:list', { orgId: REGISTERED });
    expect(answerOf(h, 'wv-list-2').payload.checkpoints).toEqual([
      expect.objectContaining({
        checkpointId: before,
        valid: false,
        why: 'refreshed',
        refreshedAt: new Date(T0).toISOString(),
      }),
    ]);

    await h.send('wv-list-3', 'checkpoint:list', { orgId: 'another-entry' });
    expect(answerOf(h, 'wv-list-3').payload.checkpoints).toEqual([]);
    await h.send('wv-list-4', 'checkpoint:list');
    expect(answerOf(h, 'wv-list-4').payload.checkpoints).toHaveLength(1);
    expect(vi.mocked(getJsforceConnection).mock.calls.length).toBe(connections);
    expect(
      await h.handler.keptBefore({
        orgId: REGISTERED,
        detectedAt: new Date(T0).toISOString(),
        evidence: 'connection',
        previousOrganizationId: ORG_ID.slice(0, 15),
        organizationId: REFRESHED_ORG_ID.slice(0, 15),
      }),
    ).toBe(1);
  });
});

describe('CheckpointHandler — the rewinds the histories mark runs by', () => {
  /** A rewind of `organizationId` kept in its ledger, under its lock. */
  async function kept(h: Harness, organizationId: string, rewindId: string): Promise<void> {
    const held = h.store.lock(organizationId, 'rewind');
    if (!('lock' in held)) throw new Error('the lock is held');
    try {
      await appendToRewindLedger(rewindLedgerFileOf(h.store.root, organizationId), held.lock, {
        kind: 'rewind',
        rewindId,
        checkpointId: 'ck-20261022-140512-aaaa',
        checkpointName: 'Before UAT',
        organizationId,
        mode: 'everything',
        objects: ['Account'],
        readFrom: '2026-10-22T14:05:12.000Z',
        takenAt: '2026-10-22T14:06:00.000Z',
        startedAt: '2026-10-22T16:00:00.000Z',
        endedAt: '2026-10-22T16:05:00.000Z',
        status: 'success',
        totals: { deleted: 1, restored: 0, undeleted: 0, recreated: 0 },
      });
    } finally {
      held.lock.release();
    }
  }

  it('answers each registered org’s rewinds from this machine alone, each with the orgs it is of', async () => {
    const h = harness();
    await kept(h, ORG_ID, 'rw-20261022-160000-aaaa');
    await kept(h, '00D000000000007AAA', 'rw-20261022-160000-bbbb');

    await h.send('wv-rewinds-1', 'checkpoint:rewinds', { orgIds: [REGISTERED] });
    await h.send('wv-rewinds-2', 'checkpoint:rewinds');

    for (const requestId of ['wv-rewinds-1', 'wv-rewinds-2']) {
      const answer = answerOf(h, requestId);
      expect(answer.type).toBe('checkpoint:rewinds:response');
      expect(answer.payload.rewinds).toEqual([
        expect.objectContaining({ rewindId: 'rw-20261022-160000-aaaa', orgIds: [REGISTERED] }),
      ]);
    }
    expect(getJsforceConnection).not.toHaveBeenCalled();
  });

  it('answers a refreshed sandbox’s rewinds of the org before beside those since', async () => {
    const h = harness();
    await kept(h, ORG_ID, 'rw-20261022-160000-aaaa');
    h.detector.observe(REGISTERED, { organizationId: REFRESHED_ORG_ID }, 'connection');
    await kept(h, REFRESHED_ORG_ID, 'rw-20261022-170000-cccc');

    await h.send('wv-rewinds-1', 'checkpoint:rewinds', { orgIds: [REGISTERED] });

    const rewinds = answerOf(h, 'wv-rewinds-1').payload.rewinds as Array<{
      rewindId: string;
      orgIds: string[];
    }>;
    expect(rewinds.map(({ rewindId, orgIds }) => [rewindId, orgIds]).sort()).toEqual([
      ['rw-20261022-160000-aaaa', [REGISTERED]],
      ['rw-20261022-170000-cccc', [REGISTERED]],
    ]);
  });

  it('leaves out a line of a ledger that does not parse, and names it in the log', async () => {
    const h = harness();
    await kept(h, ORG_ID, 'rw-20261022-160000-aaaa');
    const { appendFileSync } = await import('node:fs');
    appendFileSync(rewindLedgerFileOf(h.store.root, ORG_ID), '{"kind":"rewind"}\n');

    await h.send('wv-rewinds-1', 'checkpoint:rewinds', { orgIds: [REGISTERED] });

    expect(answerOf(h, 'wv-rewinds-1').payload.rewinds).toHaveLength(1);
    expect(h.logs).toContainEqual(
      expect.stringMatching(
        /^\[WARN\] Line 2 of the rewind ledger of 00D\w+ does not parse: left out$/,
      ),
    );
  });

  it('refuses a request that names no org in its list, one twice, or asks what it does not know', async () => {
    const h = harness();

    for (const [requestId, payload] of [
      ['wv-rewinds-1', { orgIds: [] }],
      ['wv-rewinds-2', { orgIds: [REGISTERED, REGISTERED] }],
      ['wv-rewinds-3', { orgIds: [REGISTERED], since: '2026-01-01' }],
    ] as const) {
      await h.send(requestId, 'checkpoint:rewinds', payload);
      const answer = answerOf(h, requestId);
      expect([answer.type, answer.payload.code]).toEqual(['checkpoint:error', 'INVALID_PAYLOAD']);
    }
  });
});

describe('CheckpointHandler — the preview', () => {
  it('answers what a rewind would do, what the org runs on the objects it writes, and what it costs', async () => {
    const h = harness();
    const checkpointId = await taken(h);
    clock = T0 + 60_000;
    h.org.edit('Account', id('001', 1), { Name: 'Renamed' }, COLLEAGUE);
    h.org.add('Case', { Id: id('500', 2), Subject: 'New', LastModifiedById: MEMORY_ORG_USER });
    clock = T0 + 120_000;
    const asked: Array<{ orgId: string; objects: readonly string[] }> = [];
    h.handler.setTargetAutomation({
      read: (orgId, objects) => {
        asked.push({ orgId, objects });
        return Promise.resolve({
          objectsRead: [...objects],
          objects: [],
          unread: [],
          conditionsNotRead: 0,
          conditionsBound: 0,
          requests: 3,
        } satisfies ForgeTargetAutomation);
      },
    });

    await h.send('wv-preview-1', 'checkpoint:preview', { checkpointId });

    const answer = answerOf(h, 'wv-preview-1');
    expect(answer.type).toBe('checkpoint:preview:response');
    const diff = answer.payload.diff as {
      checkpointId: string;
      objects: Array<{ objectApiName: string }>;
    };
    expect(diff.checkpointId).toBe(checkpointId);
    expect(diff.objects.map((o) => o.objectApiName).sort()).toEqual(['Account', 'Case']);
    expect(asked).toEqual([
      { orgId: REGISTERED, objects: expect.arrayContaining(['Account', 'Case']) as unknown },
    ]);
    expect(answer.payload).toMatchObject({
      automation: { requests: 3 },
      estimate: { records: 2, apiRequestsLeft: 4_999_000 },
    });
    expect(answer.payload.refusal).toBeUndefined();
    expect(await h.store.list()).toHaveLength(1);
  });

  it('answers the emails the rewind’s writes would make the org send, and the refusal past what it has left today, which a rewind meets again (B11, H1)', async () => {
    const h = harness();
    const checkpointId = await taken(h);
    clock = T0 + 60_000;
    h.org.edit('Account', id('001', 1), { Name: 'Renamed' }, COLLEAGUE);
    clock = T0 + 120_000;
    h.org.emailLimits = { SingleEmail: { Max: 15, Remaining: 0 } };
    h.handler.setTargetAutomation({
      read: (_orgId, objects) =>
        Promise.resolve({
          objectsRead: [...objects],
          objects: [
            {
              objectApiName: 'Account',
              flows: [
                {
                  apiName: 'Account_changed',
                  label: 'Account changed',
                  timing: 'afterSave',
                  startsOn: 'update',
                  condition: 'read',
                  permissions: [],
                  messages: [{ kind: 'email', name: 'Tell owner', limit: 'SingleEmail' }],
                },
              ],
              triggers: [],
            },
          ],
          unread: [],
          conditionsNotRead: 0,
          conditionsBound: 0,
          requests: 0,
        } satisfies ForgeTargetAutomation),
    });

    await h.send('wv-preview-1', 'checkpoint:preview', { checkpointId });

    const answer = answerOf(h, 'wv-preview-1');
    expect(answer.payload).toMatchObject({
      emails: [{ limit: 'SingleEmail', emails: 1, verdict: 'exceeds', remaining: 0, max: 15 }],
      refusal: { code: 'EMAILS' },
    });
    const previewId = (answer.payload.diff as { previewId: string }).previewId;
    await h.send(
      'wv-rewind-1',
      'checkpoint:rewind',
      rewindOf(checkpointId, previewId, { acceptAutomation: true }),
    );
    expect(answerOf(h, 'wv-rewind-1').payload).toMatchObject({
      code: 'EMAILS',
      retryable: true,
    });
  });

  it('refuses the preview of a checkpoint of the org before a refresh, without reaching the org', async () => {
    const h = harness();
    const checkpointId = await taken(h);
    h.detector.observe(REGISTERED, { organizationId: REFRESHED_ORG_ID }, 'connection');
    const connections = vi.mocked(getJsforceConnection).mock.calls.length;

    await h.send('wv-preview-1', 'checkpoint:preview', { checkpointId });

    expect(answerOf(h, 'wv-preview-1').payload).toMatchObject({
      code: 'OTHER_ORG',
      message: expect.stringContaining('This sandbox was refreshed on 2026-10-22') as unknown,
    });
    expect(vi.mocked(getJsforceConnection).mock.calls.length).toBe(connections);
  });

  it('refuses the preview of a checkpoint of a scratch org past its date, and of one it does not keep or cannot read', async () => {
    const h = harness();
    const checkpointId = await taken(h);
    await h.store.update(checkpointId, (checkpoint) => ({
      ...checkpoint,
      org: { ...checkpoint.org, tier: 'scratch', scratchExpiresAt: '2026-10-01' },
    }));
    const connections = vi.mocked(getJsforceConnection).mock.calls.length;

    await h.send('wv-preview-1', 'checkpoint:preview', { checkpointId });
    expect(answerOf(h, 'wv-preview-1').payload.code).toBe('SCRATCH_EXPIRED');

    await h.send('wv-preview-2', 'checkpoint:preview', { checkpointId: 'ck-20261022-140000-zzzz' });
    expect(answerOf(h, 'wv-preview-2').payload.code).toBe('NOT_FOUND');

    writeFileSync(h.store.folderOf(ORG_ID, checkpointId).checkpointFile, '{ not json');
    await h.send('wv-preview-3', 'checkpoint:preview', { checkpointId });
    expect(answerOf(h, 'wv-preview-3').payload.code).toBe('DAMAGED');
    expect(vi.mocked(getJsforceConnection).mock.calls.length).toBe(connections);
  });

  it('gives the guard’s refusal of an org that is another one now as the guard words it', async () => {
    const h = harness();
    const checkpointId = await taken(h);
    // Refreshed and not noticed yet: the org itself says it.
    h.org.edit('Organization', ORG_ID, { Id: REFRESHED_ORG_ID });

    await h.send('wv-preview-1', 'checkpoint:preview', { checkpointId });

    expect(answerOf(h, 'wv-preview-1').payload).toMatchObject({
      code: 'OTHER_ORG',
      retryable: false,
    });
  });
});

describe('CheckpointHandler — changes on this machine', () => {
  it('renames a checkpoint, keeps it until it is deleted, and stops comparing fields, answering with it as it is now', async () => {
    const h = harness();
    const checkpointId = await taken(h);

    await h.send('wv-rename-1', 'checkpoint:rename', { checkpointId, name: 'Clean baseline' });
    await h.send('wv-keep-1', 'checkpoint:keep', { checkpointId, keep: true });
    await h.send('wv-ignore-1', 'checkpoint:ignore-fields', {
      checkpointId,
      fields: ['Case.Subject'],
    });

    expect(answerOf(h, 'wv-rename-1')).toMatchObject({
      type: 'checkpoint:rename:response',
      payload: { checkpoint: { name: 'Clean baseline' } },
    });
    expect(answerOf(h, 'wv-keep-1')).toMatchObject({
      type: 'checkpoint:keep:response',
      payload: { checkpoint: { expiresAt: null } },
    });
    expect(answerOf(h, 'wv-ignore-1')).toMatchObject({
      type: 'checkpoint:ignore-fields:response',
      payload: { checkpoint: { ignoredFields: ['Case.Subject'] } },
    });
    expect((await h.store.read(checkpointId))?.checkpoint).toMatchObject({
      name: 'Clean baseline',
      expiresAt: null,
      ignoredFields: ['Case.Subject'],
    });
  });

  it('changes nor deletes a checkpoint while a take, a rewind or an undo of its org holds the lock', async () => {
    const h = harness();
    const checkpointId = await taken(h);
    const held = h.store.lock(ORG_ID, 'rewind', checkpointId);
    if (!('lock' in held)) throw new Error('lock not taken');
    try {
      await h.send('wv-rename-1', 'checkpoint:rename', { checkpointId, name: 'Clean baseline' });
      await h.send('wv-delete-1', 'checkpoint:delete', { checkpointIds: [checkpointId] });
    } finally {
      held.lock.release();
    }

    expect(answerOf(h, 'wv-rename-1').payload).toMatchObject({
      code: 'RUN_WRITING',
      message: expect.stringContaining('a rewind is writing') as unknown,
    });
    expect(answerOf(h, 'wv-delete-1').payload.code).toBe('RUN_WRITING');
    expect((await h.store.read(checkpointId))?.checkpoint?.name).toBe('Before UAT');
  });

  it('deletes checkpoints from this machine, the org untouched', async () => {
    const h = harness();
    const checkpointId = await taken(h);
    const sent = h.org.requests + h.org.soapCalls;

    await h.send('wv-delete-1', 'checkpoint:delete', {
      checkpointIds: [checkpointId, 'ck-20261022-140000-zzzz'],
    });

    expect(answerOf(h, 'wv-delete-1')).toMatchObject({
      type: 'checkpoint:delete:response',
      payload: { deleted: [checkpointId] },
    });
    expect(await h.store.list()).toEqual([]);
    expect(h.org.requests + h.org.soapCalls).toBe(sent);
  });

  it('removes the checkpoints past their date as the panels open, naming each in the log', async () => {
    const h = harness();
    const checkpointId = await taken(h);
    await h.store.update(checkpointId, (checkpoint) => ({
      ...checkpoint,
      expiresAt: '2026-10-01T00:00:00.000Z',
    }));

    await h.handler.sweep();

    expect(await h.store.list()).toEqual([]);
    expect(h.logs).toContainEqual(
      expect.stringContaining("Removed checkpoint 'Before UAT' of DEV-SB"),
    );
  });
});

// ─── The rewind, and its undo ────────────────────────────────────────────────

/** A reader of what the org runs that finds nothing, read without a request. */
function noAutomation(h: Harness): void {
  h.handler.setTargetAutomation({
    read: (_orgId, objects) =>
      Promise.resolve({
        objectsRead: [...objects],
        objects: [],
        unread: [],
        conditionsNotRead: 0,
        conditionsBound: 0,
        requests: 0,
      } satisfies ForgeTargetAutomation),
  });
}

/** What the org holds of what the tests compare, live and in the bin: no stamp. */
function stateOf(org: HandlerTestOrg): Record<string, unknown> {
  const of = (rows: Array<Record<string, unknown>>) =>
    rows
      .map((row) => ({ Id: row.Id, Name: row.Name ?? null, Subject: row.Subject ?? null }))
      .sort((a, b) => String(a.Id).localeCompare(String(b.Id)));
  return {
    live: { Account: of(org.all('Account')), Case: of(org.all('Case')) },
    bin: { Account: of(org.inBin('Account')), Case: of(org.inBin('Case')) },
  };
}

/** A colleague's work since the checkpoint: an account renamed, a case created, another deleted. */
function changedSince(h: Harness): void {
  clock = T0 + 60_000;
  h.org.edit('Account', id('001', 1), { Name: 'Renamed' }, COLLEAGUE);
  h.org.add('Case', { Id: id('500', 2), Subject: 'New', LastModifiedById: COLLEAGUE });
  h.org.trash('Case', id('500', 1), COLLEAGUE);
  clock = T0 + 120_000;
}

/** Preview the rewind to `checkpointId`, and give back the preview's id. */
async function previewed(h: Harness, checkpointId: string, requestId: string): Promise<string> {
  await h.send(requestId, 'checkpoint:preview', { checkpointId });
  const answer = answerOf(h, requestId);
  expect(answer.type).toBe('checkpoint:preview:response');
  return (answer.payload.diff as { previewId: string }).previewId;
}

/** A rewind's request: nothing accepted unless said. */
function rewindOf(checkpointId: string, previewId: string, accepted: Record<string, boolean> = {}) {
  return {
    checkpointId,
    previewId,
    acceptAutomation: false,
    acceptNoUndo: false,
    acceptRecreate: false,
    acceptOutside: false,
    acceptUnseen: false,
    ...accepted,
  };
}

/** The result a rewind or an undo answered `requestId` with, or a failed test. */
function resultOf(h: Harness, requestId: string, type: string) {
  const answer = answerOf(h, requestId);
  expect(answer.type, JSON.stringify(answer.payload)).toBe(type);
  return answer.payload.result as {
    rewindId: string;
    status: string;
    residual: unknown[];
    apiRequests: { used: number; leftToday: number };
    removedJournals?: unknown[];
  };
}

/** The operation messages carrying `operationId`, of `type`. */
function operationMessages(h: Harness, type: string, operationId: string): Posted[] {
  return h.posted.filter(
    (message) =>
      message.type === type &&
      (message.payload as { operationId?: unknown }).operationId === operationId,
  );
}

describe('CheckpointHandler — the rewind and its undo', () => {
  it('rewinds the org on the preview it names, under the id of its request: progress on that id, in the registry and in Live Operations, recorded in the audit trail; then undoes it, once', async () => {
    const h = harness();
    noAutomation(h);
    const checkpointId = await taken(h);
    const atCheckpoint = stateOf(h.org);
    changedSince(h);
    const beforeRewind = stateOf(h.org);
    const previewId = await previewed(h, checkpointId, 'wv-preview-1');
    h.org.ticking = true;

    await h.send('wv-rewind-1', 'checkpoint:rewind', rewindOf(checkpointId, previewId));

    const result = resultOf(h, 'wv-rewind-1', 'checkpoint:rewind:response');
    expect(answerOf(h, 'wv-rewind-1').payload.operationId).toBe('wv-rewind-1');
    expect(result).toMatchObject({ status: 'success', residual: [] });
    expect(stateOf(h.org).live).toEqual(atCheckpoint.live);
    expect(operationMessages(h, 'operation:started', 'wv-rewind-1')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          module: 'checkpoint',
          description: "Rewinding DEV-SB to 'Before UAT'",
        }) as unknown,
      }),
    ]);
    // Each step names its phase, which the page lists the planned ones of.
    const steps = operationMessages(h, 'operation:progress', 'wv-rewind-1').map(
      (message) => (message.payload as { currentStep: string }).currentStep,
    );
    expect(steps).toEqual(
      expect.arrayContaining([
        'Reading DEV-SB again',
        'Bringing back what was deleted since',
        'Giving back what was changed since',
        'Deleting what was created since',
      ]),
    );
    expect(operationMessages(h, 'operation:completed', 'wv-rewind-1')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({ result: { status: 'success' } }) as unknown,
      }),
    ]);
    await Promise.resolve();
    expect(h.registry.get('wv-rewind-1')).toMatchObject({
      module: 'checkpoint',
      status: 'completed',
    });
    expect(h.tracker.get('wv-rewind-1')).toMatchObject({
      module: 'checkpoint',
      status: 'completed',
    });
    expect(h.trail()[0]).toMatchObject({
      action: 'checkpoint_rewind',
      module: 'checkpoint',
      orgId: REGISTERED,
      operationId: 'wv-rewind-1',
      outcome: 'success',
      details: { checkpointId, rewindId: result.rewindId, status: 'success', passes: 1 },
    });
    expect(
      Object.fromEntries(
        (h.trail()[0].objects ?? []).map(({ objectApiName, created, updated, deleted }) => [
          objectApiName,
          { created, updated, deleted },
        ]),
      ),
    ).toEqual({
      // The case it brought back is given its checkpoint values as part of
      // coming back: counted brought back, not given back, as the preview says.
      Case: { created: 1, updated: 0, deleted: 1 },
      Account: { created: 0, updated: 1, deleted: 0 },
    });

    // The list offers its undo; the undo takes it back, and is not offered again.
    const [listed] = await h.store.list();
    expect(listed?.undo?.rewindId).toBe(result.rewindId);
    await h.send('wv-undo-1', 'checkpoint:undo', {
      checkpointId,
      rewindId: result.rewindId,
      acceptAutomation: false,
    });
    const undo = resultOf(h, 'wv-undo-1', 'checkpoint:undo:response');
    expect(undo).toMatchObject({ rewindId: result.rewindId, status: 'success', residual: [] });
    expect(stateOf(h.org).live).toEqual(beforeRewind.live);
    expect(
      operationMessages(h, 'operation:progress', 'wv-undo-1').map(
        (message) => (message.payload as { currentStep: string }).currentStep,
      ),
    ).toEqual(
      expect.arrayContaining([
        'Reading what the rewind did',
        'Bringing back what the rewind deleted and giving back what it wrote over',
      ]),
    );
    expect(operationMessages(h, 'operation:started', 'wv-undo-1')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          description: "Undoing the rewind of DEV-SB to 'Before UAT'",
        }) as unknown,
      }),
    ]);
    expect(h.trail()[0]).toMatchObject({
      action: 'checkpoint_undo',
      operationId: 'wv-undo-1',
      outcome: 'success',
      details: { checkpointId, rewindId: result.rewindId },
    });
    expect((await h.store.read(checkpointId))?.checkpoint?.lastRewind?.undoneAt).toBeDefined();

    await h.send('wv-undo-2', 'checkpoint:undo', {
      checkpointId,
      rewindId: result.rewindId,
      acceptAutomation: false,
    });
    expect(answerOf(h, 'wv-undo-2').payload).toMatchObject({
      code: 'UNDO_CLOSED',
      message: expect.stringMatching(
        /^This rewind can no longer be undone: it was undone on 20\d\d-\d\d-\d\d/,
      ) as unknown,
    });
  });

  it('refuses a production org with the checkpoint guard’s words, whatever Production Guard would let through, records the refusal, and writes nothing', async () => {
    const h = harness();
    noAutomation(h);
    const checkpointId = await taken(h);
    changedSince(h);
    const previewId = await previewed(h, checkpointId, 'wv-preview-1');
    h.org.edit('Organization', ORG_ID, {
      IsSandbox: false,
      OrganizationType: 'Enterprise Edition',
    });
    const before = stateOf(h.org);

    await h.send('wv-rewind-1', 'checkpoint:rewind', rewindOf(checkpointId, previewId));

    expect(answerOf(h, 'wv-rewind-1')).toMatchObject({
      type: 'checkpoint:error',
      payload: {
        code: 'PRODUCTION',
        retryable: false,
        message: expect.stringContaining('a production org') as unknown,
      },
    });
    expect(h.productionGuard.check).not.toHaveBeenCalled();
    expect(h.productionGuard.confirmIfNeeded).not.toHaveBeenCalled();
    expect(stateOf(h.org)).toEqual(before);
    expect(h.org.updates).toEqual([]);
    expect(h.org.deletes).toEqual([]);
    expect(h.trail()[0]).toMatchObject({
      action: 'checkpoint_rewind',
      outcome: 'stopped',
      details: { checkpointId, code: 'PRODUCTION' },
    });
  });

  it('gives a gate’s refusal as the gate gives it, and rewinds once what it asks is accepted', async () => {
    const h = harness();
    const checkpointId = await taken(h);
    changedSince(h);
    h.handler.setTargetAutomation({
      read: (_orgId, objects) =>
        Promise.resolve({
          objectsRead: [...objects],
          objects: [],
          unread: [{ part: 'flows', reason: 'Tooling API timed out' }],
          conditionsNotRead: 0,
          conditionsBound: 0,
          requests: 0,
        } satisfies ForgeTargetAutomation),
    });
    const previewId = await previewed(h, checkpointId, 'wv-preview-1');
    const before = stateOf(h.org);

    await h.send('wv-rewind-1', 'checkpoint:rewind', rewindOf(checkpointId, previewId));

    expect(answerOf(h, 'wv-rewind-1').payload).toMatchObject({
      code: 'AUTOMATION',
      retryable: false,
      message: expect.stringMatching(
        /^DEV-SB: what runs as the rewind writes could not all be read/,
      ) as unknown,
    });
    expect(stateOf(h.org)).toEqual(before);
    expect(operationMessages(h, 'operation:completed', 'wv-rewind-1')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          result: { status: 'refused', code: 'AUTOMATION' },
        }) as unknown,
      }),
    ]);

    h.org.ticking = true;
    await h.send(
      'wv-rewind-2',
      'checkpoint:rewind',
      rewindOf(checkpointId, previewId, { acceptAutomation: true }),
    );
    expect(resultOf(h, 'wv-rewind-2', 'checkpoint:rewind:response').status).toBe('success');
  });

  it('passes on whether the records the recycle bin no longer gives back may be made again with new Ids: refused without it, writing nothing, made with it', async () => {
    const h = harness();
    noAutomation(h);
    const checkpointId = await taken(h);
    clock = T0 + 60_000;
    h.org.trash('Case', id('500', 1), COLLEAGUE);
    h.org.purge(id('500', 1));
    clock = T0 + 120_000;
    const previewId = await previewed(h, checkpointId, 'wv-preview-1');
    const before = stateOf(h.org);

    await h.send('wv-rewind-1', 'checkpoint:rewind', rewindOf(checkpointId, previewId));

    expect(answerOf(h, 'wv-rewind-1').payload).toMatchObject({
      code: 'RECREATE',
      retryable: false,
    });
    expect(stateOf(h.org)).toEqual(before);

    h.org.ticking = true;
    await h.send(
      'wv-rewind-2',
      'checkpoint:rewind',
      rewindOf(checkpointId, previewId, { acceptRecreate: true }),
    );
    const result = resultOf(h, 'wv-rewind-2', 'checkpoint:rewind:response');
    expect(result.status).toBe('success');
    expect(h.org.all('Case')).toHaveLength(1);
  });

  it('passes on whether a rewind by a user read object by object may delete what takes along records the user is not proven to see: refused without it, writing nothing, rewound with it', async () => {
    // The cases go with their account; the user holds the accounts by Modify
    // All on them, the cases by View All alone.
    const org = new HandlerTestOrg(
      {},
      { Account: [{ childSObject: 'Case', field: 'AccountId', cascadeDelete: true }] },
    );
    clock = LONG_AGO;
    org.all('UserPermissionAccess')[0].PermissionsViewAllData = false;
    org.all('UserPermissionAccess')[0].PermissionsModifyAllData = false;
    org.add('PermissionSetAssignment', {
      Id: '0Pa000000000001AAA',
      AssigneeId: MEMORY_ORG_USER,
      PermissionSetId: '0PS000000000001AAA',
      PermissionSetGroupId: null,
    });
    for (const [n, object, modifyAll] of [
      [1, 'Account', true],
      [2, 'Case', false],
    ] as const) {
      org.add('ObjectPermissions', {
        Id: id('110', n),
        ParentId: '0PS000000000001AAA',
        SobjectType: object,
        PermissionsViewAllRecords: true,
        PermissionsModifyAllRecords: modifyAll,
      });
    }
    clock = T0;
    const h = harness({ org });
    noAutomation(h);
    const checkpointId = await taken(h);
    clock = T0 + 60_000;
    h.org.add('Account', { Id: id('001', 3), Name: 'New', LastModifiedById: COLLEAGUE });
    clock = T0 + 120_000;
    const previewId = await previewed(h, checkpointId, 'wv-preview-1');
    const before = stateOf(h.org);

    await h.send('wv-rewind-1', 'checkpoint:rewind', rewindOf(checkpointId, previewId));

    expect(answerOf(h, 'wv-rewind-1').payload).toMatchObject({
      code: 'UNSEEN',
      retryable: false,
      message: expect.stringContaining(
        "Deleting 1 Account record(s) created since also deletes what tester@example.com can't " +
          'see under them in Case',
      ) as unknown,
    });
    expect(stateOf(h.org)).toEqual(before);

    h.org.ticking = true;
    await h.send(
      'wv-rewind-2',
      'checkpoint:rewind',
      rewindOf(checkpointId, previewId, { acceptUnseen: true }),
    );
    const result = resultOf(h, 'wv-rewind-2', 'checkpoint:rewind:response');
    expect(result.status).toBe('success');
    expect(h.org.all('Account').map((row) => row.Id)).not.toContain(id('001', 3));
  });

  it('refuses a rewind and an undo while a run of this window writes to the org, as its handler says, writing nothing; each goes once the run has ended', async () => {
    let writing = false;
    const h = harness({ writers: { writingTo: (orgId) => writing && orgId === REGISTERED } });
    noAutomation(h);
    const checkpointId = await taken(h);
    changedSince(h);
    const previewId = await previewed(h, checkpointId, 'wv-preview-1');
    const before = stateOf(h.org);

    writing = true;
    await h.send('wv-rewind-1', 'checkpoint:rewind', rewindOf(checkpointId, previewId));
    expect(answerOf(h, 'wv-rewind-1').payload).toMatchObject({
      code: 'RUN_WRITING',
      retryable: true,
      message: expect.stringMatching(/^A SandForge run is writing to DEV-SB: /) as unknown,
    });
    expect(stateOf(h.org)).toEqual(before);

    writing = false;
    h.org.ticking = true;
    await h.send('wv-rewind-2', 'checkpoint:rewind', rewindOf(checkpointId, previewId));
    const result = resultOf(h, 'wv-rewind-2', 'checkpoint:rewind:response');
    expect(result.status).toBe('success');
    const rewound = stateOf(h.org);

    writing = true;
    await h.send('wv-undo-1', 'checkpoint:undo', {
      checkpointId,
      rewindId: result.rewindId,
      acceptAutomation: false,
    });
    expect(answerOf(h, 'wv-undo-1').payload).toMatchObject({ code: 'RUN_WRITING' });
    expect(stateOf(h.org)).toEqual(rewound);

    writing = false;
    await h.send('wv-undo-2', 'checkpoint:undo', {
      checkpointId,
      rewindId: result.rewindId,
      acceptAutomation: false,
    });
    expect(resultOf(h, 'wv-undo-2', 'checkpoint:undo:response').status).toBe('success');
  });

  it('refuses, without reaching the org, a rewind on a preview no longer kept, and a rewind or an undo of a checkpoint of the org before a refresh', async () => {
    const h = harness();
    noAutomation(h);
    const checkpointId = await taken(h);
    changedSince(h);
    const previewId = await previewed(h, checkpointId, 'wv-preview-1');
    const connections = vi.mocked(getJsforceConnection).mock.calls.length;

    await h.send(
      'wv-rewind-1',
      'checkpoint:rewind',
      rewindOf(checkpointId, 'pv-20261022-140000-zzzz'),
    );
    expect(answerOf(h, 'wv-rewind-1').payload).toMatchObject({
      code: 'PREVIEW_GONE',
      message: expect.stringContaining("preview the rewind to 'Before UAT' again") as unknown,
    });

    h.detector.observe(REGISTERED, { organizationId: REFRESHED_ORG_ID }, 'connection');
    await h.send('wv-rewind-2', 'checkpoint:rewind', rewindOf(checkpointId, previewId));
    expect(answerOf(h, 'wv-rewind-2').payload.code).toBe('OTHER_ORG');
    await h.send('wv-undo-1', 'checkpoint:undo', {
      checkpointId,
      rewindId: 'rw-20261022-141102-e5f6',
      acceptAutomation: false,
    });
    expect(answerOf(h, 'wv-undo-1').payload.code).toBe('OTHER_ORG');
    expect(vi.mocked(getJsforceConnection).mock.calls.length).toBe(connections);
    expect(h.trail().filter((entry) => entry.module === 'checkpoint')).toEqual([]);
  });

  it('refuses the undo of a rewind the list does not offer, without reaching the org', async () => {
    const h = harness();
    const checkpointId = await taken(h);
    const connections = vi.mocked(getJsforceConnection).mock.calls.length;

    await h.send('wv-undo-1', 'checkpoint:undo', {
      checkpointId,
      rewindId: 'rw-20261022-141102-e5f6',
      acceptAutomation: false,
    });

    expect(answerOf(h, 'wv-undo-1').payload).toMatchObject({
      code: 'UNDO_CLOSED',
      retryable: false,
      message:
        "This rewind can no longer be undone: the rewind rw-20261022-141102-e5f6 is not the last rewind to 'Before UAT'. No record was read or written.",
    });
    expect(vi.mocked(getJsforceConnection).mock.calls.length).toBe(connections);
  });

  it('refuses a malformed rewind and undo on the domain’s error channel, before anything is asked of the org', async () => {
    const h = harness();
    const connections = vi.mocked(getJsforceConnection).mock.calls.length;

    await h.send('wv-rewind-1', 'checkpoint:rewind', {
      checkpointId: 'ck-20261022-140000-aaaa',
      previewId: 'pv-20261022-140000-aaaa',
      acceptAutomation: false,
    });
    await h.send('wv-undo-1', 'checkpoint:undo', {
      checkpointId: 'ck-20261022-140000-aaaa',
      rewindId: '../elsewhere',
      acceptAutomation: false,
    });

    expect(answerOf(h, 'wv-rewind-1')).toMatchObject({
      type: 'checkpoint:error',
      payload: { code: 'INVALID_PAYLOAD' },
    });
    expect(answerOf(h, 'wv-undo-1').payload.code).toBe('INVALID_PAYLOAD');
    expect(vi.mocked(getJsforceConnection).mock.calls.length).toBe(connections);
  });

  it('names in the log, as the sweep names what it deletes, the journal of the rewind before it that a rewind deleted once it ended', async () => {
    const h = harness();
    noAutomation(h);
    const checkpointId = await taken(h);
    changedSince(h);
    h.org.ticking = true;
    await h.send(
      'wv-rewind-1',
      'checkpoint:rewind',
      rewindOf(checkpointId, await previewed(h, checkpointId, 'wv-preview-1')),
    );
    const first = resultOf(h, 'wv-rewind-1', 'checkpoint:rewind:response');
    clock += 60_000;
    h.org.edit('Account', id('001', 1), { Name: 'Renamed again' }, COLLEAGUE);

    await h.send(
      'wv-rewind-2',
      'checkpoint:rewind',
      rewindOf(checkpointId, await previewed(h, checkpointId, 'wv-preview-2')),
    );

    const second = resultOf(h, 'wv-rewind-2', 'checkpoint:rewind:response');
    expect(second.removedJournals).toEqual([
      { checkpointId, name: 'Before UAT', rewindId: first.rewindId },
    ]);
    expect(h.logs).toContainEqual(
      `[INFO] Removed the journal of rewind ${first.rewindId} of checkpoint 'Before UAT': ` +
        'Undo reaches the last rewind of the org alone',
    );
  });

  it('stops a rewind from Live Operations’ Cancel: before it writes, answered CANCELLED; part way, answered with its result, its journal taken up by the next rewind', async () => {
    const h = harness();
    noAutomation(h);
    const checkpointId = await taken(h);
    const atCheckpoint = stateOf(h.org);
    changedSince(h);
    const before = stateOf(h.org);
    const first = await previewed(h, checkpointId, 'wv-preview-1');
    h.org.ticking = true;
    // As the guard reads the user's permissions: before anything is written.
    h.onQuery((soql) => {
      if (/FROM UserPermissionAccess/.test(soql)) h.registry.abort('wv-rewind-1');
    });

    await h.send('wv-rewind-1', 'checkpoint:rewind', rewindOf(checkpointId, first));

    expect(answerOf(h, 'wv-rewind-1')).toMatchObject({
      type: 'checkpoint:error',
      payload: { code: 'CANCELLED', retryable: true },
    });
    expect(stateOf(h.org)).toEqual(before);
    expect(h.registry.get('wv-rewind-1')?.status).toBe('aborted');
    expect(h.tracker.get('wv-rewind-1')?.status).toBe('cancelled');
    expect(h.trail()[0]).toMatchObject({
      action: 'checkpoint_rewind',
      outcome: 'stopped',
      details: { code: 'CANCELLED' },
    });

    // Stopped once it wrote: as its first delete goes.
    h.onQuery(() => undefined);
    const second = await previewed(h, checkpointId, 'wv-preview-2');
    h.org.beforeDelete = () => {
      h.org.beforeDelete = undefined;
      h.registry.abort('wv-rewind-2');
    };
    await h.send('wv-rewind-2', 'checkpoint:rewind', rewindOf(checkpointId, second));
    const stopped = resultOf(h, 'wv-rewind-2', 'checkpoint:rewind:response');
    expect(stopped.status).toBe('cancelled');
    expect(h.registry.get('wv-rewind-2')?.status).toBe('aborted');
    expect(h.tracker.get('wv-rewind-2')?.status).toBe('cancelled');
    expect(h.trail()[0]).toMatchObject({ action: 'checkpoint_rewind', outcome: 'cancelled' });

    const third = await previewed(h, checkpointId, 'wv-preview-3');
    await h.send('wv-rewind-3', 'checkpoint:rewind', rewindOf(checkpointId, third));
    const again = resultOf(h, 'wv-rewind-3', 'checkpoint:rewind:response');
    expect(again).toMatchObject({ status: 'success', rewindId: stopped.rewindId });
    expect(stateOf(h.org).live).toEqual(atCheckpoint.live);
  });

  it('rewinds from the preview it answered, as read, once told to: the org is not read again before the first pass', async () => {
    const run = async (fromPreview: boolean): Promise<number> => {
      const h = harness();
      noAutomation(h);
      if (fromPreview) h.handler.rewindFromPreviewsAnswered();
      const checkpointId = await taken(h);
      const atCheckpoint = stateOf(h.org);
      changedSince(h);
      const previewId = await previewed(h, checkpointId, 'wv-preview-1');
      h.org.ticking = true;
      await h.send('wv-rewind-1', 'checkpoint:rewind', rewindOf(checkpointId, previewId));
      const result = resultOf(h, 'wv-rewind-1', 'checkpoint:rewind:response');
      expect(result.status).toBe('success');
      expect(stateOf(h.org).live).toEqual(atCheckpoint.live);
      return result.apiRequests.used;
    };

    const fresh = await run(false);
    const reused = await run(true);

    expect(reused).toBeLessThan(fresh);
  });

  it('prices, once told to, the rewind its preview will be rewound from: the fresh read of the org the panel’s rewind makes is no longer counted, as that rewind never sends it (G-D2)', async () => {
    const run = async (fromPreview: boolean): Promise<{ said: number; sent: number }> => {
      const h = harness();
      noAutomation(h);
      if (fromPreview) h.handler.rewindFromPreviewsAnswered();
      const checkpointId = await taken(h);
      changedSince(h);
      await h.send('wv-preview-1', 'checkpoint:preview', { checkpointId });
      const preview = answerOf(h, 'wv-preview-1').payload as {
        diff: { previewId: string };
        estimate: { apiRequests: number };
      };
      h.org.ticking = true;
      await h.send(
        'wv-rewind-1',
        'checkpoint:rewind',
        rewindOf(checkpointId, preview.diff.previewId),
      );
      const result = resultOf(h, 'wv-rewind-1', 'checkpoint:rewind:response');
      expect(result.status).toBe('success');
      return { said: preview.estimate.apiRequests, sent: result.apiRequests.used };
    };

    const panel = await run(false);
    const commandLine = await run(true);

    // What the command line's rewind does not send, its preview does not
    // count: the two figures part by what the two rewinds part by. What the
    // memory org's estimate counts beyond either rewind is the same for both;
    // that each preview says what its rewind sends is held on the org of
    // gate G-D2 (`rewindEstimate.requests.test.ts`).
    expect(commandLine.sent).toBeLessThan(panel.sent);
    expect(panel.said - commandLine.said).toBe(panel.sent - commandLine.sent);
  });
});

// ─── A rewind of some objects ────────────────────────────────────────────────

describe('CheckpointHandler — a rewind of some objects', () => {
  it('previews a rewind of the objects named, the diff whole, its automation read on those it writes alone, and refuses one the checkpoint does not hold', async () => {
    const h = harness();
    const checkpointId = await taken(h);
    changedSince(h);
    const asked: Array<readonly string[]> = [];
    h.handler.setTargetAutomation({
      read: (_orgId, objects) => {
        asked.push(objects);
        return Promise.resolve({
          objectsRead: [...objects],
          objects: [],
          unread: [],
          conditionsNotRead: 0,
          conditionsBound: 0,
          requests: 0,
        } satisfies ForgeTargetAutomation);
      },
    });

    await h.send('wv-preview-1', 'checkpoint:preview', { checkpointId, objects: ['case'] });

    const answer = answerOf(h, 'wv-preview-1');
    expect(answer.type).toBe('checkpoint:preview:response');
    const diff = answer.payload.diff as { objects: Array<{ objectApiName: string }> };
    expect(diff.objects.map((o) => o.objectApiName).sort()).toEqual(['Account', 'Case']);
    expect(asked).toEqual([['Case']]);
    // The case created since and the case deleted since: not the account renamed.
    expect(answer.payload).toMatchObject({ estimate: { records: 2 } });

    const sent = h.org.requests;
    await h.send('wv-preview-2', 'checkpoint:preview', { checkpointId, objects: ['Lead'] });
    expect(answerOf(h, 'wv-preview-2')).toMatchObject({
      type: 'checkpoint:error',
      payload: { code: 'NOT_HELD' },
    });
    expect(h.org.requests).toBe(sent);
  });

  it('plans the selection from the preview without reading the org, and the rewind that follows does what it planned, to the objects picked alone', async () => {
    const h = harness();
    noAutomation(h);
    const checkpointId = await taken(h);
    changedSince(h);
    const previewId = await previewed(h, checkpointId, 'wv-preview-1');

    const sent = h.org.requests + h.org.soapCalls;
    await h.send('wv-plan-1', 'checkpoint:plan-selection', {
      checkpointId,
      previewId,
      objects: ['Case'],
      acceptOutside: false,
    });
    expect(h.org.requests + h.org.soapCalls).toBe(sent);
    const answer = answerOf(h, 'wv-plan-1');
    expect(answer.type).toBe('checkpoint:plan-selection:response');
    expect(answer.payload).toEqual({
      checkpointId,
      previewId,
      plan: {
        objects: ['Case'],
        acts: [
          {
            objectApiName: 'Case',
            picked: true,
            toDelete: 1,
            toGiveBack: 0,
            toBringBack: 1,
            toRecreate: 0,
          },
        ],
        left: [],
        needs: [],
        undoCannot: [],
      },
    });
    // Nothing kept of the plan beside the preview it was read from.
    const folder = (await h.store.read(checkpointId))?.folder;
    expect(
      readdirSync(join(folder?.dir ?? '', 'previews', previewId)).filter((name) =>
        name.startsWith('selection-'),
      ),
    ).toEqual([]);

    h.org.ticking = true;
    await h.send('wv-rewind-1', 'checkpoint:rewind', {
      ...rewindOf(checkpointId, previewId),
      objects: ['Case'],
    });
    const result = resultOf(h, 'wv-rewind-1', 'checkpoint:rewind:response') as ReturnType<
      typeof resultOf
    > & {
      deleted: Array<{ objectApiName: string; deleted: number }>;
      undeleted: Array<{ objectApiName: string; undeleted: number }>;
      restored: unknown[];
      scope?: unknown;
    };
    expect(result.status).toBe('success');
    expect(result.deleted.map(({ objectApiName, deleted }) => [objectApiName, deleted])).toEqual([
      ['Case', 1],
    ]);
    expect(
      result.undeleted.map(({ objectApiName, undeleted }) => [objectApiName, undeleted]),
    ).toEqual([['Case', 1]]);
    expect(result.restored).toEqual([]);
    expect(result.scope).toEqual({
      objects: ['Case'],
      notRewound: { objects: ['Account'], records: 1 },
    });
    expect(h.org.all('Account').find((row) => row.Id === id('001', 1))).toMatchObject({
      Name: 'Renamed',
    });
    expect(h.trail()[0]?.details).toMatchObject({ limitedTo: 'Case' });
  });

  it('refuses to plan a selection from a preview it did not answer, and a malformed one, on the domain’s error channel', async () => {
    const h = harness();
    const checkpointId = await taken(h);

    await h.send('wv-plan-1', 'checkpoint:plan-selection', {
      checkpointId,
      previewId: 'pv-20261022-140512-a1b2',
      objects: ['Case'],
      acceptOutside: false,
    });
    expect(answerOf(h, 'wv-plan-1')).toMatchObject({
      type: 'checkpoint:error',
      payload: { code: 'PREVIEW_GONE' },
    });

    await h.send('wv-plan-2', 'checkpoint:plan-selection', {
      checkpointId,
      previewId: 'pv-20261022-140512-a1b2',
      objects: [],
      acceptOutside: false,
    });
    expect(answerOf(h, 'wv-plan-2')).toMatchObject({
      type: 'checkpoint:error',
      payload: { code: 'INVALID_PAYLOAD' },
    });
  });
});

// ─── The side bar's line under Checkpoints ───────────────────────────────────

/** A later id than any take of these tests makes: the list names it first. */
const LATER_ID = 'ck-20991231-235959-zzzz';

/** Keep beside `checkpointId` another checkpoint of its org, its file as `changes` makes it. */
async function keptBeside(
  h: Harness,
  checkpointId: string,
  changes: Partial<OrgCheckpoint>,
): Promise<void> {
  const first = (await h.store.read(checkpointId))?.checkpoint;
  if (!first) throw new Error('the first checkpoint is not kept');
  await h.store.create(ORG_ID, LATER_ID);
  await h.store.write({ ...first, checkpointId: LATER_ID, ...changes });
}

describe('CheckpointHandler — the side bar’s line', () => {
  it('names the registered org’s latest checkpoint that can be rewound to, read from this machine alone', async () => {
    const h = harness();
    const checkpointId = await taken(h);
    const takenAt = (await h.store.read(checkpointId))?.checkpoint?.takenAt;
    const connections = vi.mocked(getJsforceConnection).mock.calls.length;
    const sent = h.org.requests + h.org.soapCalls;
    // A later take that failed: it can only be deleted.
    await keptBeside(h, checkpointId, { name: 'After UAT', status: 'failed' });

    expect(await h.handler.latestUsableOf(REGISTERED)).toEqual({
      checkpointId,
      name: 'Before UAT',
      takenAt,
    });

    await h.store.update(LATER_ID, (checkpoint) => ({
      ...checkpoint,
      status: 'ready',
      takenAt: '2026-10-22T15:00:00.000Z',
    }));
    expect(await h.handler.latestUsableOf(REGISTERED)).toEqual({
      checkpointId: LATER_ID,
      name: 'After UAT',
      takenAt: '2026-10-22T15:00:00.000Z',
    });
    expect(vi.mocked(getJsforceConnection).mock.calls.length).toBe(connections);
    expect(h.org.requests + h.org.soapCalls).toBe(sent);
  });

  it('names nothing for an org with none, a production org, an org it does not know, nor a sandbox refreshed since', async () => {
    const h = harness();
    expect(await h.handler.latestUsableOf(REGISTERED)).toBeUndefined();
    await taken(h);
    // The same Organization Id, registered as a production org: the type alone differs.
    h.orgManager.addOrg(
      registered({
        id: 'org-prod' as UUID,
        alias: 'PROD',
        orgType: 'Production',
        safetyTier: OrgSafetyTier.CRITICAL,
      }),
    );

    expect(await h.handler.latestUsableOf('org-prod')).toBeUndefined();
    // Control: the sandbox's entry names it.
    expect(await h.handler.latestUsableOf(REGISTERED)).toMatchObject({ name: 'Before UAT' });
    expect(await h.handler.latestUsableOf('org-unknown')).toBeUndefined();

    h.detector.observe(REGISTERED, { organizationId: REFRESHED_ORG_ID }, 'connection');
    expect(await h.handler.latestUsableOf(REGISTERED)).toBeUndefined();
  });

  it('tells its listeners each time a take is kept, a checkpoint is changed or deleted, or the sweep removes one, and not when nothing changed', async () => {
    const h = harness();
    const told = vi.fn();
    const stop = h.handler.onCheckpointsChanged(told);

    const checkpointId = await taken(h);
    expect(told).toHaveBeenCalledTimes(1);

    await h.send('wv-rename-1', 'checkpoint:rename', { checkpointId, name: 'Clean baseline' });
    expect(told).toHaveBeenCalledTimes(2);
    expect(await h.handler.latestUsableOf(REGISTERED)).toMatchObject({ name: 'Clean baseline' });

    // Nothing deleted, nothing swept: nothing to tell.
    await h.send('wv-delete-0', 'checkpoint:delete', {
      checkpointIds: ['ck-20261022-140000-zzzz'],
    });
    await h.handler.sweep();
    expect(told).toHaveBeenCalledTimes(2);

    await h.send('wv-delete-1', 'checkpoint:delete', { checkpointIds: [checkpointId] });
    expect(told).toHaveBeenCalledTimes(3);
    expect(await h.handler.latestUsableOf(REGISTERED)).toBeUndefined();

    const second = await taken(h, 'wv-take-2');
    expect(told).toHaveBeenCalledTimes(4);
    await h.store.update(second, (checkpoint) => ({
      ...checkpoint,
      expiresAt: '2026-10-01T00:00:00.000Z',
    }));
    await h.handler.sweep();
    expect(told).toHaveBeenCalledTimes(5);

    stop();
    await taken(h, 'wv-take-3');
    expect(told).toHaveBeenCalledTimes(5);
  });

  it('tells nothing of a take refused, and a listener that throws stops neither the others nor the take', async () => {
    const refused = harness({
      org: new HandlerTestOrg({ sandbox: false, edition: 'Enterprise Edition' }),
      registered: registered({ orgType: 'Production' }),
    });
    const toldOfRefused = vi.fn();
    refused.handler.onCheckpointsChanged(toldOfRefused);
    await refused.send('wv-take-1', 'checkpoint:take', TAKE);
    expect(answerOf(refused, 'wv-take-1').type).toBe('checkpoint:error');
    expect(toldOfRefused).not.toHaveBeenCalled();

    const h = harness();
    const told = vi.fn();
    h.handler.onCheckpointsChanged(() => {
      throw new Error('the side bar is gone');
    });
    h.handler.onCheckpointsChanged(told);
    await taken(h);
    expect(told).toHaveBeenCalledTimes(1);
    expect(h.logs).toContainEqual(
      expect.stringContaining('A listener of the checkpoints failed: the side bar is gone'),
    );
  });
});

describe('CheckpointHandler — a checkpoint to another machine, and from one', () => {
  /** This machine, a checkpoint of the org taken; a teammate's, a store of its own, the same org. */
  async function twoMachines(there: { org?: HandlerTestOrg; registered?: SalesforceOrg } = {}) {
    const here = harness();
    const checkpointId = await taken(here);
    const away = harness({
      org: there.org ?? here.org,
      ...(there.registered ? { registered: there.registered } : {}),
    });
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-transfer-'));
    dirs.push(dir);
    return { here, there: away, checkpointId, file: join(dir, 'before-uat.sfcheckpoint') };
  }

  /** The folders a store keeps of any org: none, for an import refused. */
  function foldersOf(h: Harness): string[] {
    return readdirSync(h.store.root).flatMap((org) => readdirSync(join(h.store.root, org)));
  }

  it('exports a checkpoint to the file the host names, under a key drawn once, and keeps it on another machine as a checkpoint of the org, listed and previewed there', async () => {
    const { here, there, checkpointId, file } = await twoMachines();
    const connections = vi.mocked(getJsforceConnection).mock.calls.length;

    const exported = await here.handler.exportCheckpoint({
      checkpointId,
      out: file,
      sandforgeVersion: '1.70.0',
    });

    if (!exported.exported) throw new Error(exported.refusal.message);
    // The org is not contacted by an export.
    expect(vi.mocked(getJsforceConnection).mock.calls.length).toBe(connections);
    expect(exported.header).toMatchObject({ checkpointId, records: 3, objects: 2 });
    const key = parseArchiveKey(exported.key ?? '');
    expect(key).toBeDefined();

    const check = await there.handler.readImport({ orgId: REGISTERED, file });
    expect(check).toMatchObject({ allowed: true, header: { checkpointId } });
    const done = await there.handler.importCheckpoint({
      orgId: REGISTERED,
      file,
      key: key as Buffer,
    });

    expect(done).toMatchObject({
      imported: true,
      outcome: 'imported',
      checkpoint: { checkpointId, org: { alias: 'DEV-SB' } },
      warnings: [
        expect.stringContaining('the lock is per machine'),
        expect.stringContaining('A field your user cannot see'),
        expect.stringContaining('their Undo, stayed there'),
      ],
    });
    await there.send('wv-list-1', 'checkpoint:list', { orgId: REGISTERED });
    expect(answerOf(there, 'wv-list-1').payload.checkpoints).toEqual([
      expect.objectContaining({ checkpointId, valid: true }),
    ]);
    await there.send('wv-preview-1', 'checkpoint:preview', { checkpointId });
    expect(answerOf(there, 'wv-preview-1').type).toBe('checkpoint:preview:response');
  });

  it('records the export and the import in the audit trail, counts and org, and never the file’s path nor the key, which no log line names either', async () => {
    const { here, there, checkpointId, file } = await twoMachines();
    const given = newArchiveKey();

    const exported = await here.handler.exportCheckpoint({
      checkpointId,
      out: file,
      key: given,
      sandforgeVersion: '1.70.0',
    });
    expect(exported).toMatchObject({ exported: true });
    // A key given is never handed back.
    expect(exported).not.toHaveProperty('key');
    const drawn = await here.handler.exportCheckpoint({
      checkpointId,
      out: `${file}.second`,
      sandforgeVersion: '1.70.0',
    });
    const drawnText = drawn.exported ? (drawn.key ?? '') : '';
    expect(drawnText).not.toBe('');
    await there.handler.importCheckpoint({ orgId: REGISTERED, file, key: given });

    expect(here.trail()[0]).toMatchObject({
      action: 'checkpoint_export',
      module: 'checkpoint',
      orgId: REGISTERED,
      outcome: 'success',
      details: { checkpointId, records: 3, objects: 2 },
    });
    expect(there.trail()[0]).toMatchObject({
      action: 'checkpoint_import',
      orgId: REGISTERED,
      outcome: 'success',
      details: { checkpointId, records: 3, objects: 2 },
    });
    const keys = [
      given.toString('hex'),
      given.toString('base64'),
      drawnText,
      drawnText.replaceAll('-', ''),
    ];
    const said = JSON.stringify([
      here.trail(),
      there.trail(),
      here.logs,
      there.logs,
      here.posted,
      there.posted,
    ]);
    for (const secret of [...keys, file, 'before-uat.sfcheckpoint']) {
      expect(said.includes(secret), secret).toBe(false);
    }
  });

  it('refuses, before the key is read, a file of another org, a production org and a user without View All Data — a wrong key given does not reach the refusal — and keeps nothing', async () => {
    const wrongKey = newArchiveKey();
    const cases: Array<{
      code: string;
      says: string;
      prepare: (org: HandlerTestOrg) => void;
      production?: boolean;
    }> = [
      {
        code: 'OTHER_ORG',
        says: 'another org than the one this file holds a checkpoint of',
        prepare: (org) => org.edit('Organization', ORG_ID, { Id: REFRESHED_ORG_ID }),
      },
      {
        code: 'PRODUCTION',
        says: 'is a production org, or cannot be told from one',
        prepare: (org) =>
          org.edit('Organization', ORG_ID, {
            IsSandbox: false,
            OrganizationType: 'Enterprise Edition',
          }),
      },
      {
        code: 'PERMISSIONS',
        says: 'An import needs a user with View All Data and Modify All Data',
        prepare: (org) =>
          org.edit('UserPermissionAccess', '0Up000000000001AAA', { PermissionsViewAllData: false }),
      },
    ];
    for (const { code, says, prepare } of cases) {
      const { here, checkpointId, file } = await twoMachines();
      const exported = await here.handler.exportCheckpoint({
        checkpointId,
        out: file,
        sandforgeVersion: '1.70.0',
      });
      expect(exported.exported).toBe(true);
      const elsewhere = new HandlerTestOrg();
      prepare(elsewhere);
      const there = harness({ org: elsewhere });

      const check = await there.handler.readImport({ orgId: REGISTERED, file });
      const done = await there.handler.importCheckpoint({ orgId: REGISTERED, file, key: wrongKey });

      expect(check, code).toMatchObject({
        allowed: false,
        header: { checkpointId },
        refusal: { code, message: expect.stringContaining(says) },
      });
      expect(done, code).toMatchObject({ imported: false, refusal: { code } });
      expect(foldersOf(there), code).toEqual([]);
      expect(there.trail()[0], code).toMatchObject({
        action: 'checkpoint_import',
        outcome: 'stopped',
        details: { code },
      });
    }
  });

  it('says a file of the org a sandbox was before its refresh is of the org before, nothing imported', async () => {
    const { here, checkpointId, file } = await twoMachines();
    await here.handler.exportCheckpoint({ checkpointId, out: file, sandforgeVersion: '1.70.0' });
    const refreshed = new HandlerTestOrg();
    refreshed.edit('Organization', ORG_ID, { Id: REFRESHED_ORG_ID });
    const there = harness({ org: refreshed });
    there.detector.observe(REGISTERED, { organizationId: ORG_ID }, 'connection');
    there.detector.observe(REGISTERED, { organizationId: REFRESHED_ORG_ID }, 'connection');

    const check = await there.handler.readImport({ orgId: REGISTERED, file });

    expect(check).toMatchObject({
      allowed: false,
      refusal: {
        code: 'OTHER_ORG',
        message: expect.stringContaining('was refreshed on 2026-10-22: DEV-SB is another org now'),
      },
    });
  });

  it('refuses a wrong key and a file that is no checkpoint file, keeping nothing', async () => {
    const { here, there, checkpointId, file } = await twoMachines();
    await here.handler.exportCheckpoint({ checkpointId, out: file, sandforgeVersion: '1.70.0' });

    expect(
      await there.handler.importCheckpoint({ orgId: REGISTERED, file, key: newArchiveKey() }),
    ).toMatchObject({ imported: false, header: { checkpointId }, refusal: { code: 'IMPORT_KEY' } });
    writeFileSync(`${file}.txt`, 'name,value\n');
    expect(
      await there.handler.importCheckpoint({
        orgId: REGISTERED,
        file: `${file}.txt`,
        key: newArchiveKey(),
      }),
    ).toMatchObject({ imported: false, refusal: { code: 'IMPORT_NOT_ARCHIVE' } });
    expect(foldersOf(there)).toEqual([]);
  });

  it('refuses the export of a checkpoint whose take never ended, and over a file there already, writing nothing', async () => {
    const { here, checkpointId, file } = await twoMachines();
    writeFileSync(file, 'kept');

    expect(
      await here.handler.exportCheckpoint({ checkpointId, out: file, sandforgeVersion: '1.70.0' }),
    ).toMatchObject({ exported: false, refusal: { code: 'EXPORT_EXISTS' } });

    await here.store.update(checkpointId, (checkpoint) => ({ ...checkpoint, status: 'taking' }));
    expect(
      await here.handler.exportCheckpoint({
        checkpointId,
        out: `${file}.other`,
        sandforgeVersion: '1.70.0',
      }),
    ).toMatchObject({
      exported: false,
      refusal: {
        code: 'TAKING',
        message: expect.stringContaining('it can be exported once taken'),
      },
    });
    expect(existsSync(`${file}.other`)).toBe(false);
    expect(here.trail().filter((entry) => entry.action === 'checkpoint_export')).toEqual([]);
  });
});

describe('CheckpointHandler — Export… and Import… on the page', () => {
  /** A key as an export shows it: thirteen groups of four letters and digits. */
  const KEY_SHOWN = /^(?:[A-Z2-7]{4}-){12}[A-Z2-7]{4}$/;

  /**
   * The window's dialogs, in a folder of the test's own: the save dialog
   * answers `saveAs` there, the open dialog `open`, each undefined when it
   * is closed.
   */
  function dialogs(picks: { saveAs?: string; open?: string } = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-page-transfer-'));
    dirs.push(dir);
    const files: CheckpointFileDialogs & {
      pickExportFile: ReturnType<typeof vi.fn>;
      pickImportFile: ReturnType<typeof vi.fn>;
    } = {
      sandforgeVersion: '1.71.0',
      pickExportFile: vi.fn(async () =>
        picks.saveAs === undefined ? undefined : join(dir, picks.saveAs),
      ),
      pickImportFile: vi.fn(async () =>
        picks.open === undefined ? undefined : join(dir, picks.open),
      ),
    };
    return { dir, files };
  }

  /** This machine, a checkpoint of the org taken, its export saved as `before-uat.sfcheckpoint`. */
  async function exportedHere() {
    const { dir, files } = dialogs({ saveAs: 'before-uat.sfcheckpoint' });
    const here = harness({ checkpointFiles: files });
    const checkpointId = await taken(here);
    await here.send('wv-export-1', 'checkpoint:export', { checkpointId });
    const answer = answerOf(here, 'wv-export-1');
    expect(answer.type, JSON.stringify(answer.payload)).toBe('checkpoint:export:response');
    return {
      here,
      dir,
      files,
      checkpointId,
      file: join(dir, 'before-uat.sfcheckpoint'),
      key: String(answer.payload.key),
    };
  }

  /** A teammate's machine, with a store of its own, whose open dialog picks `file`. */
  function teammate(
    file: string,
    there: { org?: HandlerTestOrg; registered?: SalesforceOrg } = {},
  ) {
    const files: CheckpointFileDialogs = {
      sandforgeVersion: '1.71.0',
      pickExportFile: vi.fn(async () => undefined),
      pickImportFile: vi.fn(async () => file),
    };
    return harness({ ...there, checkpointFiles: files });
  }

  /** The folders a store keeps of any org: none, for an import refused. */
  function foldersOf(h: Harness): string[] {
    return existsSync(h.store.root)
      ? readdirSync(h.store.root).flatMap((org) => readdirSync(join(h.store.root, org)))
      : [];
  }

  it('asks where to save once the checkpoint is checked, suggests its id, writes the file its owner’s alone, and answers the key once with the file’s name alone', async () => {
    const { here, dir, files, checkpointId, file, key } = await exportedHere();

    expect(files.pickExportFile).toHaveBeenCalledWith(`${checkpointId}.sfcheckpoint`);
    expect(answerOf(here, 'wv-export-1').payload).toEqual({
      status: 'saved',
      checkpointId,
      fileName: 'before-uat.sfcheckpoint',
      key: expect.stringMatching(KEY_SHOWN),
      records: 3,
      objects: 2,
      bytes: statSync(file).size,
    });
    expect(readFileSync(file, 'utf8').startsWith('{"format":"sandforge-checkpoint"')).toBe(true);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual(['before-uat.sfcheckpoint']);
    const said = JSON.stringify([here.posted, here.logs, here.trail()]);
    expect(said.includes(dir), 'a path reached the page, the log or the trail').toBe(false);
    // The key once: in the answer that shows it, and nowhere else.
    expect(said.split(key).length - 1).toBe(1);
    expect(here.trail()[0]).toMatchObject({
      action: 'checkpoint_export',
      outcome: 'success',
      details: { checkpointId, records: 3, objects: 2 },
    });
  });

  it('refuses the export of a checkpoint whose take never ended, failed, or whose file cannot be read, before the save dialog asks anything, writing nothing', async () => {
    const { dir, files } = dialogs({ saveAs: 'before-uat.sfcheckpoint' });
    const h = harness({ checkpointFiles: files });
    const checkpointId = await taken(h);
    const cases = [
      { status: 'taking', code: 'TAKING', says: 'it can be exported once taken, or deleted' },
      { status: 'failed', code: 'FAILED', says: 'failed: it can only be deleted' },
    ] as const;
    for (const { status, code, says } of cases) {
      await h.store.update(checkpointId, (checkpoint) => ({ ...checkpoint, status }));
      await h.send(`wv-export-${status}`, 'checkpoint:export', { checkpointId });
      expect(answerOf(h, `wv-export-${status}`), status).toMatchObject({
        type: 'checkpoint:error',
        payload: { code, message: expect.stringContaining(says) },
      });
    }
    writeFileSync(h.store.folderOf(ORG_ID, checkpointId).checkpointFile, '{ not json');
    await h.send('wv-export-damaged', 'checkpoint:export', { checkpointId });
    expect(answerOf(h, 'wv-export-damaged')).toMatchObject({
      type: 'checkpoint:error',
      payload: { code: 'DAMAGED', message: expect.stringContaining('cannot be read') },
    });

    expect(files.pickExportFile).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
    expect(h.trail().filter((entry) => entry.action === 'checkpoint_export')).toEqual([]);
  });

  it('says a save dialog closed, writing nothing', async () => {
    const { dir, files } = dialogs();
    const h = harness({ checkpointFiles: files });
    const checkpointId = await taken(h);

    await h.send('wv-export-1', 'checkpoint:export', { checkpointId });

    expect(answerOf(h, 'wv-export-1')).toMatchObject({
      type: 'checkpoint:export:response',
      payload: { status: 'cancelled', checkpointId },
    });
    expect(readdirSync(dir)).toEqual([]);
    expect(h.trail().filter((entry) => entry.action === 'checkpoint_export')).toEqual([]);
  });

  it('replaces a file the person confirmed to replace in the save dialog once the new one is whole, leaving nothing beside it', async () => {
    const { dir, files } = dialogs({ saveAs: 'before-uat.sfcheckpoint' });
    const h = harness({ checkpointFiles: files });
    const checkpointId = await taken(h);
    writeFileSync(join(dir, 'before-uat.sfcheckpoint'), 'an older export');

    await h.send('wv-export-1', 'checkpoint:export', { checkpointId });

    expect(answerOf(h, 'wv-export-1').payload).toMatchObject({
      status: 'saved',
      fileName: 'before-uat.sfcheckpoint',
    });
    const written = readFileSync(join(dir, 'before-uat.sfcheckpoint'), 'utf8');
    expect(written.startsWith('{"format":"sandforge-checkpoint"')).toBe(true);
    expect(readdirSync(dir)).toEqual(['before-uat.sfcheckpoint']);
  });

  it('tells the page a failure of the disk without the folders it happened in', async () => {
    const { dir, files } = dialogs({ saveAs: join('gone', 'before-uat.sfcheckpoint') });
    const h = harness({ checkpointFiles: files });
    const checkpointId = await taken(h);

    await h.send('wv-export-1', 'checkpoint:export', { checkpointId });

    const answer = answerOf(h, 'wv-export-1');
    expect(answer.type).toBe('checkpoint:error');
    expect(answer.payload.message).toEqual(expect.stringContaining('ENOENT'));
    expect(JSON.stringify(h.posted).includes(dir)).toBe(false);
    expect(JSON.stringify(h.logs).includes(dir)).toBe(false);
  });

  it('reads the file’s header and the orgs it can be imported for, the org asked before any key, and names the file by a token, never by its path', async () => {
    const { here, dir, checkpointId, file } = await exportedHere();
    const there = teammate(file, { org: here.org });

    await there.send('wv-read-1', 'checkpoint:import-read');

    const answer = answerOf(there, 'wv-read-1');
    expect(answer.type).toBe('checkpoint:import-read:response');
    expect(answer.payload).toEqual({
      status: 'read',
      token: expect.any(String),
      fileName: 'before-uat.sfcheckpoint',
      summary: {
        formatVersion: 1,
        checkpointFormat: 1,
        sandforgeVersion: '1.71.0',
        // In its 18-character form, its last three letters the org's own checksum.
        organizationId: expect.stringMatching(new RegExp(`^${ORG_ID.slice(0, 15)}[A-Z0-9]{3}$`)),
        orgTier: expect.any(String),
        checkpointId,
        takenAt: expect.any(String),
        records: 3,
        objects: 2,
        files: expect.any(Number),
        bytes: expect.any(Number),
      },
      orgIds: [REGISTERED],
    });
    // The org's guard was asked: its connection was opened.
    expect(vi.mocked(getJsforceConnection)).toHaveBeenCalled();
    expect(JSON.stringify(there.posted).includes(dir)).toBe(false);
    expect(foldersOf(there)).toEqual([]);
  });

  it('refuses, before any key, a file the org does not let in — its user without View All Data, a production org — and one that is no checkpoint file, each with its words, keeping nothing', async () => {
    const { here, dir, file } = await exportedHere();
    const cases: Array<{ code: string; says: string; prepare: (org: HandlerTestOrg) => void }> = [
      {
        code: 'PERMISSIONS',
        says: 'An import needs a user with View All Data and Modify All Data',
        prepare: (org) =>
          org.edit('UserPermissionAccess', '0Up000000000001AAA', { PermissionsViewAllData: false }),
      },
      {
        code: 'PRODUCTION',
        says: 'is a production org, or cannot be told from one',
        prepare: (org) =>
          org.edit('Organization', ORG_ID, {
            IsSandbox: false,
            OrganizationType: 'Enterprise Edition',
          }),
      },
    ];
    for (const { code, says, prepare } of cases) {
      const elsewhere = new HandlerTestOrg();
      prepare(elsewhere);
      const there = teammate(file, { org: elsewhere });
      await there.send('wv-read-1', 'checkpoint:import-read');
      expect(answerOf(there, 'wv-read-1'), code).toMatchObject({
        type: 'checkpoint:error',
        payload: { code, message: expect.stringContaining(says) },
      });
      expect(foldersOf(there), code).toEqual([]);
    }
    writeFileSync(join(dir, 'notes.txt'), 'name,value\n');
    const there = teammate(join(dir, 'notes.txt'), { org: here.org });
    await there.send('wv-read-2', 'checkpoint:import-read');
    expect(answerOf(there, 'wv-read-2')).toMatchObject({
      type: 'checkpoint:error',
      payload: {
        code: 'IMPORT_NOT_ARCHIVE',
        message: expect.stringContaining('This is not a checkpoint file SandForge exported'),
      },
    });
    expect(JSON.stringify(there.posted).includes(dir)).toBe(false);
  });

  it('answers no org to import into for a file of an org not connected here, and never asks one', async () => {
    const { here, file } = await exportedHere();
    const there = teammate(file, {
      org: here.org,
      registered: registered({ orgId: '00D000000000007AAA' }),
    });
    const connections = vi.mocked(getJsforceConnection).mock.calls.length;

    await there.send('wv-read-1', 'checkpoint:import-read');

    expect(answerOf(there, 'wv-read-1').payload).toMatchObject({ status: 'read', orgIds: [] });
    expect(vi.mocked(getJsforceConnection).mock.calls.length).toBe(connections);
  });

  it('says an open dialog closed, and that a checkpoint of the file’s id is kept here already', async () => {
    const { here, file } = await exportedHere();
    const closed = harness({ checkpointFiles: dialogs().files });
    await closed.send('wv-read-1', 'checkpoint:import-read');
    expect(answerOf(closed, 'wv-read-1').payload).toEqual({ status: 'cancelled' });

    const self = teammate(file, { org: here.org });
    self.handler.setStore(here.store);
    await self.send('wv-read-2', 'checkpoint:import-read');
    expect(answerOf(self, 'wv-read-2').payload).toMatchObject({ status: 'read', keptHere: true });
  });

  it('keeps the checkpoint the page confirms with the key shown, after refusing a wrong key, a key that is none and a token the window does not know, each with its words and nothing kept', async () => {
    const { here, dir, checkpointId, file, key } = await exportedHere();
    const there = teammate(file, { org: here.org });
    await there.send('wv-read-1', 'checkpoint:import-read');
    const token = String(answerOf(there, 'wv-read-1').payload.token);
    const asked = (id: string, given: { token?: string; key: string }) =>
      there.send(id, 'checkpoint:import', {
        token: given.token ?? token,
        orgId: REGISTERED,
        key: given.key,
        keepDays: 30,
      });

    await asked('wv-import-1', { key: 'AAAA-'.repeat(12) + 'AAAA' });
    expect(answerOf(there, 'wv-import-1').payload).toMatchObject({
      code: 'IMPORT_KEY',
      message: expect.stringContaining('This key is not the one the file was exported with.'),
    });
    await asked('wv-import-2', { key: 'not a key' });
    expect(answerOf(there, 'wv-import-2').payload).toMatchObject({
      code: 'IMPORT_KEY',
      message: expect.stringContaining('That is not a key SandForge draws'),
    });
    await asked('wv-import-3', { token: 'a-token-of-another-window', key });
    expect(answerOf(there, 'wv-import-3').payload).toMatchObject({
      code: 'IMPORT_FILE_GONE',
      message: expect.stringContaining('choose it again with Import…'),
    });
    expect(foldersOf(there)).toEqual([]);

    // Typed in lower case, without its dashes: the key all the same.
    await asked('wv-import-4', { key: key.replaceAll('-', '').toLowerCase() });
    expect(answerOf(there, 'wv-import-4')).toMatchObject({
      type: 'checkpoint:import:response',
      payload: { outcome: 'imported', checkpoint: { checkpointId, org: { alias: 'DEV-SB' } } },
    });
    expect(foldersOf(there)).toEqual([checkpointId]);
    // The token named the file until it was imported, and no longer.
    await asked('wv-import-5', { key });
    expect(answerOf(there, 'wv-import-5').payload).toMatchObject({ code: 'IMPORT_FILE_GONE' });
    // Read again and imported again: the same checkpoint, left as it is.
    await there.send('wv-read-2', 'checkpoint:import-read');
    const again = String(answerOf(there, 'wv-read-2').payload.token);
    await asked('wv-import-6', { token: again, key });
    expect(answerOf(there, 'wv-import-6').payload).toMatchObject({ outcome: 'alreadyKept' });

    const said = JSON.stringify([there.posted, there.logs, there.trail()]);
    expect(said.includes(dir)).toBe(false);
    expect(said.includes(key)).toBe(false);
    expect(said.includes(key.replaceAll('-', '').toLowerCase())).toBe(false);
  });

  it('refuses a key that is none with what the org refuses first, as a key given is', async () => {
    const { file } = await exportedHere();
    const production = new HandlerTestOrg();
    const there = teammate(file, { org: production });
    await there.send('wv-read-1', 'checkpoint:import-read');
    const token = String(answerOf(there, 'wv-read-1').payload.token);
    // The org becomes a production org between the read and the import.
    production.edit('Organization', ORG_ID, {
      IsSandbox: false,
      OrganizationType: 'Enterprise Edition',
    });

    await there.send('wv-import-1', 'checkpoint:import', {
      token,
      orgId: REGISTERED,
      key: 'not a key',
      keepDays: 30,
    });

    expect(answerOf(there, 'wv-import-1').payload).toMatchObject({ code: 'PRODUCTION' });
  });

  it('refuses Export… and Import… in a window without dialogs, writing nothing', async () => {
    const h = harness();
    const checkpointId = await taken(h);

    await h.send('wv-export-1', 'checkpoint:export', { checkpointId });
    await h.send('wv-read-1', 'checkpoint:import-read');

    expect(answerOf(h, 'wv-export-1').payload).toMatchObject({
      code: 'NO_FILE_DIALOG',
      message: expect.stringContaining('sandforge-checkpoint export'),
    });
    expect(answerOf(h, 'wv-read-1').payload).toMatchObject({
      code: 'NO_FILE_DIALOG',
      message: expect.stringContaining('sandforge-checkpoint import'),
    });
  });
});

// ─── A pipeline's Checkpoint and Rewind steps ────────────────────────────────

/** The pipeline step that runs the take or the rewind: a nightly reset on a schedule. */
const ORIGIN = {
  pipeline: 'Nightly reset',
  step: 'Rewind the sandbox',
  trigger: 'schedule',
} as const;

/** When the Rewind step was confirmed, as the Automation side read it. */
const GRANTED_AT = '2026-10-21T09:00:00.000Z';

/**
 * A Rewind step of the registered org to `checkpointId`, confirmed for its
 * configuration: nothing accepted, ten records at most, the people at work
 * not looked at, unless said.
 */
function rewindStep(checkpointId: string, config: Record<string, unknown> = {}) {
  const read = pipelineRewindStepConfigSchema.parse({
    orgId: REGISTERED,
    checkpointId,
    maxRecords: 10,
    refuseWhenActive: false,
    ...config,
  });
  return {
    config: read,
    grant: {
      organizationId: ORG_ID,
      checkpointId,
      digest: rewindGrantDigest(read),
      grantedAt: GRANTED_AT,
    },
    origin: ORIGIN,
  };
}

/** What a step was refused with, or a failed test. */
async function stepRefusal(step: Promise<unknown>): Promise<CheckpointStepRefused> {
  try {
    await step;
  } catch (err: unknown) {
    if (err instanceof CheckpointStepRefused) return err;
    throw err;
  }
  throw new Error('The step was not refused.');
}

/** What the org was sent that writes: updates and deletes, and what its records hold. */
function writesOf(org: HandlerTestOrg) {
  return { updates: org.updates.length, deletes: org.deletes.length, state: stateOf(org) };
}

describe('CheckpointHandler — a pipeline’s Checkpoint step', () => {
  it('takes a checkpoint named as the step says, {date} put in the place of T0, listed in the registry and in Live Operations, and answers what it kept to no page', async () => {
    const h = harness();

    const kept = await h.handler.takeForPipeline({
      config: pipelineCheckpointStepConfigSchema.parse({
        orgId: REGISTERED,
        mode: 'everything',
        name: 'Nightly {date}',
      }),
      origin: ORIGIN,
    });

    expect(kept).toMatchObject({
      name: 'Nightly 2026-10-22 14:05 UTC',
      records: 3,
      objects: 2,
      movedWhileTaken: { changed: 0, deleted: 0, created: 0 },
    });
    expect(kept.bytes).toBeGreaterThan(0);
    const read = await h.store.read(kept.checkpointId);
    expect(read?.checkpoint).toMatchObject({ name: kept.name, status: 'ready' });
    expect(read?.checkpoint?.expiresAt).not.toBeNull();
    await Promise.resolve();
    expect(h.registry.get(kept.operationId)).toMatchObject({
      module: 'checkpoint',
      status: 'completed',
    });
    expect(h.tracker.get(kept.operationId)).toMatchObject({
      status: 'completed',
      description: "Pipeline 'Nightly reset': taking a checkpoint of DEV-SB",
    });
    expect(h.posted.filter((message) => message.type === 'checkpoint:take:response')).toEqual([]);
  });

  it('fails with the take’s refusal, its code and its words, keeping nothing: the day’s requests, a production org whatever the registry says', async () => {
    const h = harness();
    h.org.limits = { Max: 5_000_000, Remaining: 3 };

    const budget = await stepRefusal(
      h.handler.takeForPipeline({
        config: pipelineCheckpointStepConfigSchema.parse({ orgId: REGISTERED, mode: 'everything' }),
        origin: ORIGIN,
      }),
    );
    expect(budget.code).toBe('API_BUDGET');
    expect(budget.message).toContain('DEV-SB');
    h.org.limits = { Max: 5_000_000, Remaining: 4_999_000 };

    h.org.edit('Organization', ORG_ID, {
      IsSandbox: false,
      OrganizationType: 'Enterprise Edition',
    });
    const production = await stepRefusal(
      h.handler.takeForPipeline({
        config: pipelineCheckpointStepConfigSchema.parse({ orgId: REGISTERED, mode: 'everything' }),
        origin: ORIGIN,
      }),
    );
    expect(production.code).toBe('PRODUCTION');
    expect(production.message).toContain(
      'SandForge never takes a checkpoint of, or rewinds, a production org',
    );
    expect(await h.store.list()).toEqual([]);
  });

  it('is stopped by the step’s Stop, before the take and between two reads, keeping nothing', async () => {
    const h = harness();
    const before = new AbortController();
    before.abort();
    const step = {
      config: pipelineCheckpointStepConfigSchema.parse({ orgId: REGISTERED, mode: 'everything' }),
      origin: ORIGIN,
    };

    await expect(h.handler.takeForPipeline(step, before.signal)).rejects.toBeInstanceOf(
      StepCancelledError,
    );

    const during = new AbortController();
    h.onQuery((soql) => {
      if (/^SELECT Id, SystemModstamp, CreatedDate/.test(soql)) during.abort();
    });
    await expect(h.handler.takeForPipeline(step, during.signal)).rejects.toBeInstanceOf(
      StepCancelledError,
    );
    expect(await h.store.list()).toEqual([]);
  });
});

describe('CheckpointHandler — a pipeline’s Rewind step', () => {
  it('rewinds from a preview it reads itself, under an operation of its own, recorded with its pipeline, its step, its trigger and when it was confirmed', async () => {
    const h = harness();
    noAutomation(h);
    const checkpointId = await taken(h);
    const atCheckpoint = stateOf(h.org);
    changedSince(h);
    h.org.ticking = true;

    const rewound = await h.handler.rewindForPipeline(rewindStep(checkpointId));

    expect(rewound.result).toMatchObject({ status: 'success', residual: [] });
    expect(stateOf(h.org).live).toEqual(atCheckpoint.live);
    expect(rewound.estimate.records).toBe(3);
    await Promise.resolve();
    expect(h.registry.get(rewound.operationId)?.status).toBe('completed');
    expect(h.tracker.get(rewound.operationId)).toMatchObject({
      status: 'completed',
      description: "Pipeline 'Nightly reset': rewinding DEV-SB to 'Before UAT'",
    });
    expect(h.trail()[0]).toMatchObject({
      action: 'checkpoint_rewind',
      operationId: rewound.operationId,
      orgId: REGISTERED,
      outcome: 'success',
      details: {
        checkpointId,
        rewindId: rewound.result.rewindId,
        status: 'success',
        pipeline: 'Nightly reset',
        step: 'Rewind the sandbox',
        trigger: 'schedule',
        grantedAt: GRANTED_AT,
      },
    });
    expect(h.posted.filter((message) => message.type === 'checkpoint:rewind:response')).toEqual([]);
  });

  it('leaves the panel’s preview as it was: the panel’s rewind confirmed on it goes after the step’s, reading the org again', async () => {
    const h = harness();
    noAutomation(h);
    const checkpointId = await taken(h);
    const atCheckpoint = stateOf(h.org);
    changedSince(h);
    const panelPreview = await previewed(h, checkpointId, 'wv-preview-1');
    h.org.ticking = true;

    const rewound = await h.handler.rewindForPipeline(rewindStep(checkpointId));

    expect(rewound.result.status).toBe('success');
    // Its own preview, which the rewind removes once it went through; the
    // panel's is kept as it was.
    const kept = await h.store.read(checkpointId);
    expect(readdirSync(kept?.folder.previewsDir ?? '')).toEqual([panelPreview]);
    await h.send('wv-rewind-1', 'checkpoint:rewind', rewindOf(checkpointId, panelPreview));
    const panel = resultOf(h, 'wv-rewind-1', 'checkpoint:rewind:response');
    // Nothing of what the panel confirmed still differs: the step put it back.
    expect(panel).toMatchObject({ status: 'success', residual: [] });
    expect(stateOf(h.org).live).toEqual(atCheckpoint.live);
  });

  it('rewinds from its own preview as that preview read the org, not reading it again before the first pass, as the panel’s rewind does', async () => {
    const run = async (step: boolean): Promise<number> => {
      const h = harness();
      noAutomation(h);
      const checkpointId = await taken(h);
      changedSince(h);
      if (step) {
        h.org.ticking = true;
        return (await h.handler.rewindForPipeline(rewindStep(checkpointId))).result.apiRequests
          .used;
      }
      const previewId = await previewed(h, checkpointId, 'wv-preview-1');
      h.org.ticking = true;
      await h.send('wv-rewind-1', 'checkpoint:rewind', rewindOf(checkpointId, previewId));
      return resultOf(h, 'wv-rewind-1', 'checkpoint:rewind:response').apiRequests.used;
    };

    const panel = await run(false);
    const step = await run(true);

    expect(step).toBeLessThan(panel);
  });

  it('refuses a rewind of more records than its limit before it writes, with both numbers, and rewinds one at its limit', async () => {
    const h = harness();
    noAutomation(h);
    const checkpointId = await taken(h);
    const atCheckpoint = stateOf(h.org);
    changedSince(h);
    const before = writesOf(h.org);

    const refused = await stepRefusal(
      h.handler.rewindForPipeline(rewindStep(checkpointId, { maxRecords: 2 })),
    );

    expect(refused.code).toBe('TOO_MANY_TO_REWIND');
    expect(refused.message).toBe(
      'The rewind of DEV-SB would rewind 3 records (1 to delete, 1 to give back, 1 to bring ' +
        "back), past this step's limit of 2. Rewind refused; preview the rewind, then raise the " +
        "step's maxRecords to what it rewinds and confirm it again. No record was written.",
    );
    expect(writesOf(h.org)).toEqual(before);
    expect(h.trail()[0]).toMatchObject({
      action: 'checkpoint_rewind',
      outcome: 'stopped',
      details: { checkpointId, code: 'TOO_MANY_TO_REWIND', pipeline: 'Nightly reset' },
    });

    h.org.ticking = true;
    const rewound = await h.handler.rewindForPipeline(rewindStep(checkpointId, { maxRecords: 3 }));
    expect(rewound.result.status).toBe('success');
    expect(stateOf(h.org).live).toEqual(atCheckpoint.live);
  });

  it('refuses before it writes while someone else was at work in the org in the hour before, saying how many people, and rewinds when told not to look', async () => {
    const h = harness();
    noAutomation(h);
    const checkpointId = await taken(h);
    changedSince(h);
    const before = writesOf(h.org);

    const refused = await stepRefusal(
      h.handler.rewindForPipeline(rewindStep(checkpointId, { refuseWhenActive: true })),
    );

    expect(refused.code).toBe('PEOPLE_ACTIVE');
    expect(refused.message).toMatch(
      /^1 person other than the user the rewind writes as changed records of the checkpoint's objects in DEV-SB in the hour before the rewind read it/,
    );
    expect(writesOf(h.org)).toEqual(before);

    h.org.ticking = true;
    const rewound = await h.handler.rewindForPipeline(
      rewindStep(checkpointId, { refuseWhenActive: false }),
    );
    expect(rewound.result.status).toBe('success');
  });

  it('lets through, when told to look, a rewind whose own user alone was at work in the hour before', async () => {
    const h = harness();
    noAutomation(h);
    const checkpointId = await taken(h);
    clock = T0 + 60_000;
    h.org.edit('Account', id('001', 1), { Name: 'Renamed' }, MEMORY_ORG_USER);
    clock = T0 + 120_000;
    h.org.ticking = true;

    const rewound = await h.handler.rewindForPipeline(
      rewindStep(checkpointId, { refuseWhenActive: true }),
    );

    expect(rewound.result.status).toBe('success');
    expect(h.org.all('Account').find((row) => row.Id === id('001', 1))?.Name).toBe('Northwind');
  });

  it('refuses for want of an acceptance its configuration does not give, naming the setting, before it writes', async () => {
    const h = harness();
    const checkpointId = await taken(h);
    changedSince(h);
    h.handler.setTargetAutomation({
      read: (_orgId, objects) =>
        Promise.resolve({
          objectsRead: [...objects],
          objects: [],
          unread: [{ part: 'flows', reason: 'Tooling API timed out' }],
          conditionsNotRead: 0,
          conditionsBound: 0,
          requests: 0,
        } satisfies ForgeTargetAutomation),
    });
    const before = writesOf(h.org);

    const refused = await stepRefusal(h.handler.rewindForPipeline(rewindStep(checkpointId)));

    expect(refused.code).toBe('AUTOMATION');
    expect(refused.message).toMatch(
      /Rewind refused; turn on acceptAutomation in the step and confirm it again to rewind all the same\. No record was written\.$/,
    );
    expect(writesOf(h.org)).toEqual(before);

    h.org.ticking = true;
    const rewound = await h.handler.rewindForPipeline(
      rewindStep(checkpointId, { acceptAutomation: true }),
    );
    expect(rewound.result.status).toBe('success');
  });

  it('refuses a rewind whose writes would send more emails than the org has left today, whatever it accepts', async () => {
    const h = harness();
    const checkpointId = await taken(h);
    clock = T0 + 60_000;
    h.org.edit('Account', id('001', 1), { Name: 'Renamed' }, COLLEAGUE);
    clock = T0 + 120_000;
    h.org.emailLimits = { SingleEmail: { Max: 15, Remaining: 0 } };
    h.handler.setTargetAutomation({
      read: (_orgId, objects) =>
        Promise.resolve({
          objectsRead: [...objects],
          objects: [
            {
              objectApiName: 'Account',
              flows: [
                {
                  apiName: 'Account_changed',
                  label: 'Account changed',
                  timing: 'afterSave',
                  startsOn: 'update',
                  condition: 'read',
                  permissions: [],
                  messages: [{ kind: 'email', name: 'Tell owner', limit: 'SingleEmail' }],
                },
              ],
              triggers: [],
            },
          ],
          unread: [],
          conditionsNotRead: 0,
          conditionsBound: 0,
          requests: 0,
        } satisfies ForgeTargetAutomation),
    });
    const before = writesOf(h.org);

    const refused = await stepRefusal(
      h.handler.rewindForPipeline(
        rewindStep(checkpointId, {
          acceptAutomation: true,
          acceptNoUndo: true,
          acceptRecreate: true,
          acceptUnseen: true,
        }),
      ),
    );

    expect(refused.code).toBe('EMAILS');
    expect(writesOf(h.org)).toEqual(before);
  });

  it('answers no, with nobody to ask, to deleting the rest when its user may not delete some of it: nothing written, the step failing with the objects named', async () => {
    const h = harness();
    noAutomation(h);
    const checkpointId = await taken(h);
    changedSince(h);
    h.org.undeletable.add('Case');
    const before = writesOf(h.org);
    h.org.ticking = true;

    const refused = await stepRefusal(h.handler.rewindForPipeline(rewindStep(checkpointId)));

    expect(refused.code).toBe('UNDELETABLE_UNATTENDED');
    expect(refused.message).toBe(
      'The user SandForge connects to DEV-SB as may not delete the Case (1) record(s) this ' +
        'rewind deletes. With nobody to ask whether to delete the rest, the deletion was left ' +
        'untouched. Give the user Delete on those objects, or rewind from the Checkpoints page, ' +
        'which asks. No record was written.',
    );
    expect(refused.result?.status).toBe('cancelled');
    expect(writesOf(h.org)).toEqual(before);
    const [entry] = h.trail();
    expect(entry).toMatchObject({
      action: 'checkpoint_rewind',
      outcome: 'stopped',
      details: { code: 'UNDELETABLE_UNATTENDED', pipeline: 'Nightly reset' },
    });
    expect(h.tracker.get(entry?.operationId ?? '')?.status).toBe('failed');
  });

  it('is stopped by the step’s Stop: before it writes, as the step’s cancellation with nothing written; once it wrote, with its result', async () => {
    const h = harness();
    noAutomation(h);
    const checkpointId = await taken(h);
    changedSince(h);
    const before = writesOf(h.org);
    const already = new AbortController();
    already.abort();

    await expect(
      h.handler.rewindForPipeline(rewindStep(checkpointId), already.signal),
    ).rejects.toBeInstanceOf(StepCancelledError);
    expect(writesOf(h.org)).toEqual(before);
    expect(h.trail()[0]).toMatchObject({
      outcome: 'stopped',
      details: { code: 'ABORTED_BEFORE_START' },
    });

    // While its own preview reads the org.
    const reading = new AbortController();
    h.onQuery((soql) => {
      if (/FROM UserPermissionAccess/.test(soql)) reading.abort();
    });
    await expect(
      h.handler.rewindForPipeline(rewindStep(checkpointId), reading.signal),
    ).rejects.toBeInstanceOf(StepCancelledError);
    expect(writesOf(h.org)).toEqual(before);
    h.onQuery(() => undefined);

    // As its first delete goes.
    const writing = new AbortController();
    h.org.ticking = true;
    h.org.beforeDelete = () => {
      h.org.beforeDelete = undefined;
      writing.abort();
    };
    const stopped = await h.handler.rewindForPipeline(rewindStep(checkpointId), writing.signal);
    expect(stopped.result.status).toBe('cancelled');
    expect(h.registry.get(stopped.operationId)?.status).toBe('aborted');
    expect(h.tracker.get(stopped.operationId)?.status).toBe('cancelled');
  });

  it('refuses, before it reaches the org, a configuration that does not read and a confirmation given for another one', async () => {
    const h = harness();
    noAutomation(h);
    const checkpointId = await taken(h);
    changedSince(h);
    const connected = vi.mocked(getJsforceConnection).mock.calls.length;

    const latest = rewindStep(checkpointId);
    const invalid = await stepRefusal(
      h.handler.rewindForPipeline({
        ...latest,
        config: { ...latest.config, checkpointId: 'latest' },
      }),
    );
    expect(invalid.code).toBe('CONFIG_INVALID');
    expect(invalid.message).toContain('never latest');

    const confirmed = rewindStep(checkpointId, { maxRecords: 10 });
    const changed = await stepRefusal(
      h.handler.rewindForPipeline({
        ...confirmed,
        config: { ...confirmed.config, maxRecords: 500 },
      }),
    );
    expect(changed.code).toBe('NOT_CONFIRMED');
    expect(changed.message).toBe(
      'Rewind step "Rewind the sandbox" has not been confirmed since it was changed: open it ' +
        "and type the org's alias. No record was written.",
    );
    expect(vi.mocked(getJsforceConnection).mock.calls.length).toBe(connected);
  });

  it('refuses a production org with the checkpoint guard’s words, whatever the confirmation, recording the refusal, writing nothing', async () => {
    const h = harness();
    noAutomation(h);
    const checkpointId = await taken(h);
    changedSince(h);
    h.org.edit('Organization', ORG_ID, {
      IsSandbox: false,
      OrganizationType: 'Enterprise Edition',
    });
    const before = writesOf(h.org);

    const refused = await stepRefusal(h.handler.rewindForPipeline(rewindStep(checkpointId)));

    expect(refused.code).toBe('PRODUCTION');
    expect(writesOf(h.org)).toEqual(before);
    expect(h.trail()[0]).toMatchObject({
      action: 'checkpoint_rewind',
      outcome: 'stopped',
      details: { code: 'PRODUCTION', trigger: 'schedule' },
    });
  });
});
