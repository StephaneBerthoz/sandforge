import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseMessage, ForgeTargetAutomation, SalesforceOrg, UUID } from '@sandforge/shared';
import { OrgSafetyTier } from '@sandforge/shared';

import { CheckpointHandler, type WindowWriters } from './CheckpointHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { OrgConnectionError } from '../../core/connection/OrgConnectionError.js';
import { OrgManager } from '../../core/connection/OrgManager.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import {
  openCheckpointStore,
  type OrgCheckpointStore,
} from '../../modules/checkpoint/OrgCheckpointStore.js';
import { LiveOperationTracker } from '../../modules/monitor/LiveOperationTracker.js';
import { SandboxRefreshDetector } from '../../modules/monitor/SandboxRefreshDetector.js';
import type { SyncRunKept } from '../../modules/sync/SyncRunCreations.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import {
  MEMORY_ORG_USER,
  MemoryRemovalOrg,
  type MemoryOrgRequest,
} from '../../test/memoryRemovalOrg.js';
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
  { name: 'Id', type: 'id', permissionable: false },
  { name: 'SystemModstamp', type: 'datetime', permissionable: false },
  { name: 'CreatedDate', type: 'datetime', permissionable: false },
  { name: 'CreatedById', type: 'reference', referenceTo: ['User'], permissionable: false },
  { name: 'LastModifiedDate', type: 'datetime', permissionable: false },
  { name: 'LastModifiedById', type: 'reference', referenceTo: ['User'], permissionable: false },
  { name: 'IsDeleted', type: 'boolean', permissionable: false },
];
const writable = (name: string) => ({
  name,
  type: 'string',
  createable: true,
  updateable: true,
  nillable: true,
});
const FIELDS: Record<string, unknown[]> = {
  Account: [...STAMP_FIELDS, writable('Name')],
  Case: [...STAMP_FIELDS, writable('Subject')],
};

/** The memory org as the handler reaches it: a global describe, `/limits`, its record and its user. */
class HandlerTestOrg extends MemoryRemovalOrg {
  limits = { Max: 5_000_000, Remaining: 4_999_000 };

  constructor(says: { sandbox?: boolean; edition?: string } = {}) {
    super({}, { now: () => clock });
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
      return { DailyApiRequests: this.limits };
    }
    return super.request(request);
  }
}

/** The org behind a connection shaped as jsforce's, as every read of the handler and its snapshot takes it. */
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
    soap: {
      getServerTimestamp: async () => ({ timestamp: await org.serverTime() }),
      getUserInfo: async () => ({ userId: await org.userId() }),
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
    infraServices: { backgroundRegistry: registry, productionGuard },
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

  it('refuses a take while a Forge run of this window writes to the org, and takes one once runs have ended', async () => {
    let forgeWriting = true;
    const h = harness({
      writers: { forgeWritingTo: (orgId) => forgeWriting && orgId === REGISTERED },
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
    expect(
      (answer.payload.objects as Array<{ objectApiName: string }>)
        .map((o) => o.objectApiName)
        .sort(),
    ).toEqual(['Account', 'Case']);
    expect(asked.filter((soql) => /SELECT Id, SystemModstamp/.test(soql))).toEqual([]);
    expect(await h.store.list()).toEqual([]);
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
