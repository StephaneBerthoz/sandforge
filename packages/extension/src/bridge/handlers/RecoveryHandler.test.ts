import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What the org runs as users are written: nothing, unless a test says. */
const orgRuns = vi.hoisted(() => ({ objects: [] as unknown[] }));

vi.mock('../../modules/forge/TargetAutomationReader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/forge/TargetAutomationReader.js')>()),
  TargetAutomationReader: class {
    read(_org: string, objects: readonly string[]) {
      return Promise.resolve({
        objectsRead: [...objects],
        objects: orgRuns.objects,
        unread: [],
        conditionsNotRead: 0,
        conditionsBound: 0,
        requests: 2,
      });
    }
  },
}));

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

import type { Connection } from 'jsforce';
import {
  OrgSafetyTier,
  recoveryErrorPayloadSchema,
  recoveryStatusSchema,
  recoveryUsersListSchema,
  usersApplyAnswerSchema,
  usersPlanAnswerSchema,
  type BaseMessage,
  type RecoveryStatus,
  type SalesforceOrg,
} from '@sandforge/shared';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { fakeAuditOrg } from '../../modules/audit/auditFakeOrg.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { readInventories } from '../../modules/audit/auditStore.js';
import { openCheckpointStore } from '../../modules/checkpoint/OrgCheckpointStore.js';
import { SasPathGuard, findRepoRoot } from '../../modules/frozendataset/SasPathGuard.js';
import { EMAIL_NOT_PERMITTED } from '../../modules/forge/targetDeliverability.js';
import type { DetectedSandboxRefresh } from '../../modules/monitor/SandboxRefreshDetector.js';
import {
  ACME,
  acmeSetup,
  usersTestOrg,
  type UsersTestOrg,
} from '../../modules/users/usersOrg.fixtures.js';
import { usersOrgOf } from '../../modules/users/usersOrg.js';
import { removeUsersRun } from '../../modules/users/usersRemoval.js';
import { UsersRunStore } from '../../modules/users/usersRunStore.js';
import { RecoveryHandler, type RecoveryFileDialogs } from './RecoveryHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';

/*
 * The host of the Back into service page, on the org in miniature: its steps
 * deduced from the stores, its users read, simulated and set up behind the
 * refusal of a production org, its testers kept and carried as users.json,
 * its audits, its note and what a person acknowledges.
 */

const HOST = 'acme--uat.sandbox.my.salesforce.com';
/** The org the sandbox was before its refresh, and the one it is now: the org in miniature. */
const BEFORE = '00D000000000009';
const NOW = ACME.organizationId.slice(0, 15);
const guard = new SasPathGuard(findRepoRoot(process.cwd()));

type OrgKind = { IsSandbox: boolean; OrganizationType?: string };
const SANDBOX: OrgKind = { IsSandbox: true };
const PRODUCTION: OrgKind = { IsSandbox: false, OrganizationType: 'Enterprise Edition' };

function sandbox(over: Partial<SalesforceOrg> = {}): SalesforceOrg {
  return {
    id: 'entry-uat',
    alias: 'UAT',
    username: 'admin@acme.com.uat',
    instanceUrl: `https://${HOST}`,
    orgId: `${BEFORE}AAA`,
    orgType: 'Sandbox',
    sandboxType: 'Full',
    authMethod: 'sfdx_import',
    safetyTier: OrgSafetyTier.MEDIUM,
    appearance: { color: '#4a9eff', icon: 'cloud', position: 0 },
    metadata: { apiVersion: '62.0', edition: 'Enterprise Edition', features: [] },
    status: 'connected',
    lastConnected: '2026-11-01T08:00:00.000Z',
    tags: [],
    ...over,
  };
}

const REFRESH: DetectedSandboxRefresh = {
  orgId: 'entry-uat',
  detectedAt: '2026-11-18T08:12:00.000Z',
  evidence: 'connection',
  previousOrganizationId: BEFORE,
  organizationId: NOW,
};

/** A connection to the org in miniature: its Organration record as `kind` says, the deliverability closed. */
function connectionTo(
  org: UsersTestOrg,
  kind: OrgKind = SANDBOX,
  request?: (r: { method: string; url: string }) => Promise<unknown>,
): { conn: Connection; asked: string[] } {
  const asked: string[] = [];
  const conn = {
    ...org.connection,
    instanceUrl: `https://${HOST}`,
    query: (soql: string) => {
      asked.push(soql);
      if (/FROM Organization\b/.test(soql)) {
        const row = soql.includes('IsSandbox')
          ? { Id: org.organizationId, IsSandbox: kind.IsSandbox }
          : { OrganizationType: kind.OrganizationType };
        return Promise.resolve({ records: [row], done: true, totalSize: 1 });
      }
      return org.connection.query(soql);
    },
    request:
      request ??
      (({ url }: { url: string }) => {
        asked.push(url);
        if (url.startsWith('/tooling/executeAnonymous')) {
          return Promise.resolve({
            compiled: true,
            success: false,
            exceptionMessage: EMAIL_NOT_PERMITTED,
          });
        }
        if (url.startsWith('/query?q=')) {
          return Promise.resolve({ records: [{ PermissionsEmailSingle: true }] });
        }
        return Promise.reject(new Error(`not a request of this test: ${url}`));
      }),
  };
  return { conn: conn as unknown as Connection, asked };
}

let dir: string;
let configStore: ConfigStore;
let orgs: Map<string, SalesforceOrg>;
let refreshes: DetectedSandboxRefresh[];
let usersStore: UsersRunStore;
let dialogs: {
  pickUsersExport: ReturnType<typeof vi.fn>;
  pickUsersImport: ReturnType<typeof vi.fn>;
};
let opened: string[];
let productionGuard: ProductionGuard;

function depsOf(): HandlerDeps {
  let id = 0;
  return {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() },
    orgManager: { getOrg: vi.fn((orgId: string) => orgs.get(orgId)) },
    orgRegistry: {},
    configStore,
    nextId: () => String(++id),
    sandboxRefreshes: {
      refreshesOf: (orgId: string) => (orgId === 'entry-uat' ? refreshes : []),
      organizationIdOf: (orgId: string) => (orgId === 'entry-uat' ? NOW : undefined),
    },
    infraServices: { productionGuard },
  } as unknown as HandlerDeps;
}

function handlerOf(deps: HandlerDeps): RecoveryHandler {
  const store = openCheckpointStore({
    root: join(dir, 'checkpoints'),
    locksDir: join(dir, 'locks'),
  });
  if (!('store' in store)) throw new Error('no checkpoint store');
  return new RecoveryHandler(deps, {
    dialogs: dialogs as unknown as RecoveryFileDialogs,
    openInEditor: (path) => {
      opened.push(path);
      return Promise.resolve();
    },
    journalDir: join(dir, 'journal'),
    usersStore,
    replayStore: { list: () => Promise.resolve([]) },
    checkpointStore: store.store,
    sandforgeVersion: '1.83.0',
    now: () => new Date('2026-11-18T16:00:00.000Z'),
  });
}

function request(type: string, payload: unknown, id = `req-${type}`) {
  return inboundRequest({ id, type, timestamp: Date.now(), payload } as BaseMessage);
}

type Posted = BaseMessage & { payload: Record<string, unknown>; correlationId?: string };

function posted(deps: HandlerDeps): Posted[] {
  return vi.mocked(deps.broker.postToWebview).mock.calls.map((call) => call[0] as Posted);
}

function answer<T>(deps: HandlerDeps, type: string): T {
  const found = posted(deps)
    .filter((message) => message.type === type)
    .at(-1);
  if (found === undefined) {
    const errors = posted(deps).filter((message) => message.type === 'recovery:error');
    throw new Error(`no ${type}; errors: ${JSON.stringify(errors.map((e) => e.payload))}`);
  }
  return found.payload as T;
}

function errorOf(deps: HandlerDeps) {
  const found = posted(deps)
    .filter((message) => message.type === 'recovery:error')
    .at(-1);
  return found !== undefined ? recoveryErrorPayloadSchema.parse(found.payload) : undefined;
}

async function statusOf(handler: RecoveryHandler, deps: HandlerDeps): Promise<RecoveryStatus> {
  await handler.handle(request('recovery:status', { orgId: 'entry-uat' }));
  return recoveryStatusSchema.parse(
    answer<{ status: unknown }>(deps, 'recovery:status:response').status,
  );
}

const RESTORE_JANE = {
  orgId: 'entry-uat',
  config: { users: [{ username: 'jane.qa@acme.com', email: 'restore' as const, frozen: false }] },
  acceptUserEmails: true,
  acceptEmails: false,
  acceptAutomation: false,
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sandforge-recovery-handler-'));
  configStore = new ConfigStore(new InMemoryConfigStoreBackend());
  configStore.initialize();
  orgs = new Map([['entry-uat', sandbox()]]);
  refreshes = [REFRESH];
  usersStore = new UsersRunStore({ root: join(dir, 'users'), guard });
  dialogs = { pickUsersExport: vi.fn(), pickUsersImport: vi.fn() };
  opened = [];
  productionGuard = new ProductionGuard();
  orgRuns.objects = [];
  vi.mocked(getJsforceConnection).mockReset();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('RecoveryHandler — where the sandbox stands', () => {
  it('answers its steps deduced from this machine, as the contract reads them, the org asked nothing', async () => {
    const deps = depsOf();
    const status = await statusOf(handlerOf(deps), deps);
    expect(status).toMatchObject({
      orgId: 'entry-uat',
      alias: 'UAT',
      tier: 'development',
      sandboxType: 'Full',
      myDomainHost: HOST,
      organizationId: NOW,
      refresh: { previousOrganizationId: BEFORE, organizationId: NOW, cachesForgotten: true },
    });
    expect(status.steps[0]).toMatchObject({ id: 'refresh', status: 'done' });
    expect(getJsforceConnection).not.toHaveBeenCalled();
  });

  it('refuses an org not registered, and a production org, by their codes', async () => {
    const deps = depsOf();
    const handler = handlerOf(deps);
    await handler.handle(request('recovery:status', { orgId: 'entry-gone' }));
    expect(errorOf(deps)).toMatchObject({ code: 'ORG_NOT_FOUND' });
    orgs.set(
      'entry-prod',
      sandbox({ id: 'entry-prod', orgType: 'Production', sandboxType: undefined }),
    );
    await handler.handle(request('recovery:status', { orgId: 'entry-prod' }));
    expect(errorOf(deps)).toMatchObject({ code: 'NOT_A_DEVELOPMENT_ORG' });
  });

  it('answers a malformed request on the domain error channel, correlated', async () => {
    const deps = depsOf();
    await handlerOf(deps).handle(request('recovery:status', { org: 'entry-uat' }, 'req-bad'));
    const [error] = posted(deps);
    expect(error).toMatchObject({ type: 'recovery:error', correlationId: 'req-bad' });
    expect(recoveryErrorPayloadSchema.parse(error?.payload).code).toBe('INVALID_PAYLOAD');
  });

  it('counts n of N for the launcher, nothing for an org it does not bring back', async () => {
    const handler = handlerOf(depsOf());
    expect(await handler.progressCountOf('entry-uat')).toEqual({ done: 1, total: 7 });
    expect(await handler.progressCountOf('entry-gone')).toBeUndefined();
  });

  it('keeps a step skipped, a check marked done, clears one, and finishes the recovery', async () => {
    const deps = depsOf();
    const handler = handlerOf(deps);
    const told: string[] = [];
    handler.onStatusChanged((entryId) => told.push(entryId));
    await handler.handle(
      request('recovery:ack', {
        orgId: 'entry-uat',
        what: 'step',
        step: 'masking',
        mark: 'skipped',
      }),
    );
    await handler.handle(
      request('recovery:ack', {
        orgId: 'entry-uat',
        what: 'step',
        step: 'endpoints',
        mark: 'done',
      }),
    );
    let status = recoveryStatusSchema.parse(
      answer<{ status: unknown }>(deps, 'recovery:ack:response').status,
    );
    const byId = new Map(status.steps.map((step) => [step.id, step.status]));
    expect(byId.get('masking')).toBe('skipped');
    expect(byId.get('endpoints')).toBe('done');
    expect(status.done).toBe(3);

    await handler.handle(
      request('recovery:ack', {
        orgId: 'entry-uat',
        what: 'step',
        step: 'masking',
        mark: 'cleared',
      }),
    );
    status = recoveryStatusSchema.parse(
      answer<{ status: unknown }>(deps, 'recovery:ack:response').status,
    );
    expect(status.steps.find((step) => step.id === 'masking')?.status).toBe('todo');

    await handler.handle(request('recovery:ack', { orgId: 'entry-uat', what: 'finish' }));
    expect(configStore.get(`recovery:entry-uat:${BEFORE}`)).toMatchObject({
      finishedAt: '2026-11-18T16:00:00.000Z',
    });
    status = recoveryStatusSchema.parse(
      answer<{ status: unknown }>(deps, 'recovery:ack:response').status,
    );
    expect(status.finishedAt).toBe('2026-11-18T16:00:00.000Z');
    expect(told).toEqual(['entry-uat', 'entry-uat', 'entry-uat', 'entry-uat']);
  });

  it('resumes a recovery finished: its end taken back, its marks kept, the launcher told', async () => {
    const deps = depsOf();
    const handler = handlerOf(deps);
    const told: string[] = [];
    handler.onStatusChanged((entryId) => told.push(entryId));
    configStore.set(
      `recovery:entry-uat:${BEFORE}`,
      { steps: { masking: 'skipped' }, finishedAt: '2026-11-18T15:00:00.000Z' },
      'recovery',
    );
    expect((await statusOf(handler, deps)).finishedAt).toBe('2026-11-18T15:00:00.000Z');

    await handler.handle(request('recovery:ack', { orgId: 'entry-uat', what: 'resume' }));
    const status = recoveryStatusSchema.parse(
      answer<{ status: unknown }>(deps, 'recovery:ack:response').status,
    );
    expect(status.finishedAt).toBeUndefined();
    expect(status.steps.find((step) => step.id === 'masking')?.status).toBe('skipped');
    expect(configStore.get(`recovery:entry-uat:${BEFORE}`)).toEqual({
      steps: { masking: 'skipped' },
    });
    expect(told).toEqual(['entry-uat']);
  });

  it('refuses to mark done by hand a step that is deduced from what ran', async () => {
    const deps = depsOf();
    await handlerOf(deps).handle(
      request('recovery:ack', { orgId: 'entry-uat', what: 'step', step: 'users', mark: 'done' }),
    );
    expect(errorOf(deps)?.code).toBe('INVALID_PAYLOAD');
    expect(configStore.get(`recovery:entry-uat:${BEFORE}`)).toBeUndefined();
  });
});

describe('RecoveryHandler — the users', () => {
  it('refuses an org the registry holds for a production one before it connects', async () => {
    orgs.set('entry-uat', sandbox({ orgType: 'Production', sandboxType: undefined }));
    const deps = depsOf();
    await handlerOf(deps).handle(request('recovery:users:list', { orgId: 'entry-uat' }));
    expect(errorOf(deps)).toMatchObject({ code: 'NOT_A_DEVELOPMENT_ORG', step: 'users' });
    expect(getJsforceConnection).not.toHaveBeenCalled();
  });

  it('refuses an org that says it is a production org before any user is read', async () => {
    const org = usersTestOrg(acmeSetup());
    const { conn, asked } = connectionTo(org, PRODUCTION);
    vi.mocked(getJsforceConnection).mockResolvedValue(conn);
    const deps = depsOf();
    await handlerOf(deps).handle(request('recovery:users:list', { orgId: 'entry-uat' }));
    expect(errorOf(deps)).toMatchObject({ code: 'NOT_A_DEVELOPMENT_ORG', retryable: false });
    expect(asked.filter((soql) => !/FROM Organization\b/.test(soql))).toEqual([]);
    expect(org.queries).toEqual([]);
  });

  it('lists the users to bring back, an address asked back awaiting its click, and the testers kept', async () => {
    const org = usersTestOrg(acmeSetup());
    vi.mocked(getJsforceConnection).mockResolvedValue(connectionTo(org).conn);
    await usersStore.begin(ACME.organizationId, {
      status: 'success',
      startedAt: '2026-11-18T09:00:00.000Z',
      endedAt: '2026-11-18T09:01:00.000Z',
      emailsToPeople: 1,
      users: [
        {
          applied: {
            username: 'jane.qa@acme.com.uat',
            userId: ACME.users.jane,
            before: { isActive: true, isFrozen: true, profileId: ACME.profiles.platform },
            done: [{ what: 'email', to: 'awaiting' }],
            created: { permissionSetAssignments: [], groupMembers: [] },
            address: 'awaiting',
          },
          after: { isActive: true, isFrozen: true, profileId: ACME.profiles.platform },
          accesses: [],
          inFile: true,
        },
      ],
    });
    const deps = depsOf();
    const handler = handlerOf(deps);
    await handler.handle(
      request('recovery:users:config:save', { orgId: 'entry-uat', config: RESTORE_JANE.config }),
    );
    await handler.handle(request('recovery:users:list', { orgId: 'entry-uat' }));
    const listed = recoveryUsersListSchema.parse(answer(deps, 'recovery:users:list:response'));
    expect(
      listed.users.map((user) => [user.username, user.address, user.active, user.frozen]),
    ).toEqual([
      ['erp.integration@acme.com.uat', 'invalid', true, false],
      ['jane.qa@acme.com.uat', 'awaiting', true, true],
      ['paul.qa@acme.com.uat', 'invalid', false, false],
    ]);
    expect(listed.total).toBe(3);
    expect(listed.saved).toEqual({
      config: RESTORE_JANE.config,
      savedAt: '2026-11-18T16:00:00.000Z',
    });
    // The person is never named, nor written to the org.
    expect(JSON.stringify(listed)).not.toContain('Jane Tester');
    expect(org.writes).toEqual([]);
  });

  it('applies only what a simulation of the same choices showed, into the store the command line reads', async () => {
    const org = usersTestOrg(acmeSetup());
    vi.mocked(getJsforceConnection).mockResolvedValue(connectionTo(org).conn);
    const deps = depsOf();
    const handler = handlerOf(deps);

    await handler.handle(request('recovery:users:apply', RESTORE_JANE));
    expect(errorOf(deps)).toMatchObject({ code: 'ORG_CHANGED', step: 'users' });
    expect(org.writes).toEqual([]);

    await handler.handle(request('recovery:users:plan', RESTORE_JANE));
    const plan = usersPlanAnswerSchema.parse(
      answer<{ plan: unknown }>(deps, 'recovery:users:plan:response').plan,
    );
    expect(plan.refusals).toBeUndefined();
    expect(plan.emailsToPeople).toBe(1);
    expect(org.writes).toEqual([]);

    // Other acceptances are other choices: not what was simulated.
    await handler.handle(request('recovery:users:apply', { ...RESTORE_JANE, acceptEmails: true }));
    expect(errorOf(deps)?.code).toBe('ORG_CHANGED');
    expect(org.writes).toEqual([]);

    await handler.handle(request('recovery:users:plan', RESTORE_JANE));
    await handler.handle(request('recovery:users:apply', RESTORE_JANE, 'req-apply'));
    const applied = usersApplyAnswerSchema.parse(
      answer<{ applied: unknown }>(deps, 'recovery:users:apply:response').applied,
    );
    expect(applied).toMatchObject({ run: 1, status: 'success' });
    expect(applied.users[0]).toMatchObject({
      username: 'jane.qa@acme.com.uat',
      address: 'awaiting',
    });
    expect(org.emailsSent()).toBe(1);

    const progress = posted(deps).filter((message) => message.type === 'recovery:users:progress');
    expect(progress[0]).toMatchObject({
      correlationId: 'req-apply',
      payload: { done: 0, total: 1 },
    });
    expect(progress.at(-1)?.payload).toEqual({ orgId: 'entry-uat', done: 1, total: 1 });

    // The audit trail records the run with Production Guard's decision, counts alone.
    const [entry] = new AuditTrailStore(configStore).list({ orgId: 'entry-uat' }).entries;
    expect(entry).toMatchObject({
      action: 'users_apply',
      module: 'recovery',
      operationId: 'req-apply',
      outcome: 'success',
      guard: 'allowed',
      details: { run: 1, emailsToPeople: 1 },
    });
    expect(JSON.stringify(entry)).not.toContain('jane');

    // The command line's store holds the run: `sandforge users remove --run 1` takes it back.
    expect(
      (await usersStore.list(ACME.organizationId)).map((run) => [run.run, run.status]),
    ).toEqual([[1, 'success']]);
    const status = await statusOf(handler, deps);
    expect(status.steps.find((step) => step.id === 'users')).toMatchObject({ status: 'done' });
    expect(status.lastUsersRun).toMatchObject({ run: 1, status: 'success' });

    // A second run needs a simulation of its own: the org is not what the first read.
    await handler.handle(request('recovery:users:apply', RESTORE_JANE));
    expect(errorOf(deps)?.code).toBe('ORG_CHANGED');
  });

  it('takes the users step back to do, and the launcher one step back, once the run is removed', async () => {
    const org = usersTestOrg(acmeSetup());
    const { conn } = connectionTo(org);
    vi.mocked(getJsforceConnection).mockResolvedValue(conn);
    const deps = depsOf();
    const handler = handlerOf(deps);
    await handler.handle(request('recovery:users:plan', RESTORE_JANE));
    await handler.handle(request('recovery:users:apply', RESTORE_JANE));
    const applied = usersApplyAnswerSchema.parse(
      answer<{ applied: unknown }>(deps, 'recovery:users:apply:response').applied,
    );
    const ran = await handler.progressCountOf('entry-uat');
    expect((await statusOf(handler, deps)).steps[1]).toMatchObject({ status: 'done' });

    // `sandforge users remove --run 1`, through the same store.
    const removed = await removeUsersRun({
      org: usersOrgOf(conn),
      organization: applied.org,
      store: usersStore,
      run: applied.run,
    });
    expect(removed.status).toBe('success');

    const status = await statusOf(handler, deps);
    expect(status.steps[1]).toEqual({ id: 'users', status: 'todo', reason: 'toDo' });
    expect(status.lastUsersRun).toMatchObject({ run: 1, status: 'success' });
    expect(await handler.progressCountOf('entry-uat')).toEqual({
      done: (ran?.done ?? 0) - 1,
      total: ran?.total,
    });
  });

  it('keeps no acceptance: a simulation that does not accept the emails again is refused them', async () => {
    const org = usersTestOrg(acmeSetup());
    vi.mocked(getJsforceConnection).mockResolvedValue(connectionTo(org).conn);
    const deps = depsOf();
    const handler = handlerOf(deps);
    await handler.handle(request('recovery:users:plan', RESTORE_JANE));
    await handler.handle(
      request('recovery:users:plan', { ...RESTORE_JANE, acceptUserEmails: false }),
    );
    const plan = usersPlanAnswerSchema.parse(
      answer<{ plan: unknown }>(deps, 'recovery:users:plan:response').plan,
    );
    expect(plan.refusals?.map((refusal) => refusal.code)).toContain('USERS_EMAILS_NOT_ACCEPTED');
    await handler.handle(
      request('recovery:users:apply', { ...RESTORE_JANE, acceptUserEmails: false }),
    );
    expect(errorOf(deps)?.code).toBe('FAILED');
    expect(org.writes).toEqual([]);
    expect(org.emailsSent()).toBe(0);
  });

  it('refuses a run whose org changed since its simulation, nothing written', async () => {
    const org = usersTestOrg(acmeSetup());
    vi.mocked(getJsforceConnection).mockResolvedValue(connectionTo(org).conn);
    const deps = depsOf();
    const handler = handlerOf(deps);
    await handler.handle(request('recovery:users:plan', RESTORE_JANE));
    // Someone unfroze her in Setup meanwhile.
    const jane = org.users.find((user) => user.id === ACME.users.jane);
    if (jane) jane.frozen = false;
    await handler.handle(request('recovery:users:apply', RESTORE_JANE));
    expect(errorOf(deps)).toMatchObject({ code: 'ORG_CHANGED', step: 'users' });
    expect(org.writes).toEqual([]);
  });

  it('asks Production Guard before the run, and writes nothing when the answer is no', async () => {
    orgs.set('entry-uat', sandbox({ staging: true }));
    const org = usersTestOrg(acmeSetup());
    vi.mocked(getJsforceConnection).mockResolvedValue(connectionTo(org).conn);
    const asked: string[] = [];
    productionGuard = new ProductionGuard({
      requestConfirmation: (summary, tier) => {
        asked.push(`${tier}: ${summary}`);
        return Promise.resolve(false);
      },
    });
    const check = vi.spyOn(productionGuard, 'check');
    const deps = depsOf();
    const handler = handlerOf(deps);
    await handler.handle(request('recovery:users:plan', RESTORE_JANE));
    await handler.handle(request('recovery:users:apply', RESTORE_JANE));
    expect(check).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: 'entry-uat', orgTier: 'staging', operation: 'update' }),
    );
    // Staging asks before a delete or a large volume: an update of one user asks nothing.
    expect(asked).toEqual([]);
    expect(org.emailsSent()).toBe(1);

    check.mockReturnValue({
      allowed: true,
      requiresConfirmation: true,
      warnings: [],
      impactSummary: 'UPDATE 1 User record(s) on staging org',
    });
    await handler.handle(
      request('recovery:users:plan', {
        ...RESTORE_JANE,
        config: { users: [{ username: 'paul.qa@acme.com', active: true }] },
      }),
    );
    const writes = org.writes.length;
    await handler.handle(
      request('recovery:users:apply', {
        ...RESTORE_JANE,
        config: { users: [{ username: 'paul.qa@acme.com', active: true }] },
      }),
    );
    expect(asked).toHaveLength(1);
    expect(errorOf(deps)).toMatchObject({ code: 'CANCELLED' });
    expect(org.writes).toHaveLength(writes);
    expect(new AuditTrailStore(configStore).list({ orgId: 'entry-uat' }).entries[0]).toMatchObject({
      action: 'users_apply',
      outcome: 'stopped',
      guard: 'declined',
    });
  });

  it('stops a run under way after the step it is in, its answer cancelled', async () => {
    const org = usersTestOrg(acmeSetup());
    vi.mocked(getJsforceConnection).mockResolvedValue(connectionTo(org).conn);
    const deps = depsOf();
    const handler = handlerOf(deps);
    const both = {
      ...RESTORE_JANE,
      config: {
        users: [
          { username: 'jane.qa@acme.com', email: 'restore' as const, frozen: false },
          { username: 'paul.qa@acme.com', active: true },
        ],
      },
    };
    await handler.handle(request('recovery:users:plan', both));
    vi.mocked(deps.broker.postToWebview).mockImplementation((message) => {
      if ((message as Posted).type === 'recovery:users:progress') {
        void handler.handle(request('recovery:users:cancel', { orgId: 'entry-uat' }));
      }
    });
    await handler.handle(request('recovery:users:apply', both));
    const applied = usersApplyAnswerSchema.parse(
      answer<{ applied: unknown }>(deps, 'recovery:users:apply:response').applied,
    );
    expect(applied.status).toBe('cancelled');
  });
});

describe('RecoveryHandler — the testers carried as users.json', () => {
  it('writes the list where the person picks, by its name alone in the answer', async () => {
    const file = join(dir, 'users.json');
    dialogs.pickUsersExport.mockResolvedValue(file);
    const deps = depsOf();
    await handlerOf(deps).handle(
      request('recovery:users:config:export', { orgId: 'entry-uat', config: RESTORE_JANE.config }),
    );
    expect(answer(deps, 'recovery:users:config:export:response')).toEqual({
      status: 'saved',
      orgId: 'entry-uat',
      fileName: 'users.json',
    });
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(RESTORE_JANE.config);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(dialogs.pickUsersExport).toHaveBeenCalledWith('users.json');
  });

  it('reads the list the person picks, keeps it for the sandbox, and refuses a file that is not one', async () => {
    const good = join(dir, 'testers.json');
    writeFileSync(good, JSON.stringify(RESTORE_JANE.config));
    dialogs.pickUsersImport.mockResolvedValueOnce(good);
    const deps = depsOf();
    const handler = handlerOf(deps);
    await handler.handle(request('recovery:users:config:import', { orgId: 'entry-uat' }));
    expect(answer(deps, 'recovery:users:config:import:response')).toEqual({
      status: 'read',
      orgId: 'entry-uat',
      fileName: 'testers.json',
      config: RESTORE_JANE.config,
    });
    let status = await statusOf(handler, deps);
    expect(status.beforeNextRefresh.find((item) => item.id === 'testersList')?.status).toBe('done');

    const bad = join(dir, 'other.json');
    writeFileSync(
      bad,
      JSON.stringify({ users: [{ username: 'jane.qa@acme.com', restored: true }] }),
    );
    dialogs.pickUsersImport.mockResolvedValueOnce(bad);
    await handler.handle(request('recovery:users:config:import', { orgId: 'entry-uat' }));
    const error = errorOf(deps);
    expect(error).toMatchObject({ code: 'INVALID_PAYLOAD', step: 'users' });
    expect(error?.message).toContain('other.json');
    expect(error?.message).not.toContain(dir);
    status = await statusOf(handler, deps);
    expect(status.beforeNextRefresh.find((item) => item.id === 'testersList')?.at).toBe(
      '2026-11-18T16:00:00.000Z',
    );

    dialogs.pickUsersImport.mockResolvedValueOnce(undefined);
    await handler.handle(request('recovery:users:config:import', { orgId: 'entry-uat' }));
    expect(answer(deps, 'recovery:users:config:import:response')).toEqual({
      status: 'cancelled',
      orgId: 'entry-uat',
    });
  });
});

describe('RecoveryHandler — the audits and the note', () => {
  it('reads the audits as sandforge env audit does, keeps the inventory, and writes the note it opens', async () => {
    const org = usersTestOrg(acmeSetup());
    const audit = fakeAuditOrg({
      deliverability: 'closed',
      data: {
        CronTrigger: {
          columns: [
            'Id',
            'CronJobDetail.Name',
            'CronJobDetail.JobType',
            'CronExpression',
            'State',
            'NextFireTime',
            'PreviousFireTime',
            'OwnerId',
          ],
          rows: [],
        },
      },
      tooling: {},
    });
    vi.mocked(getJsforceConnection).mockResolvedValue(
      connectionTo(org, SANDBOX, (r) => audit.transport.request({ method: 'GET', url: r.url }))
        .conn,
    );
    const deps = depsOf();
    const handler = handlerOf(deps);
    await handler.handle(
      request('recovery:audit', {
        orgId: 'entry-uat',
        asked: { deliverability: true, schedules: true, endpoints: false },
        save: true,
      }),
    );
    const read = answer<{ audit: { deliverability?: unknown; schedules?: { saved?: string } } }>(
      deps,
      'recovery:audit:response',
    );
    expect(read.audit.deliverability).toEqual({ read: 'closed' });
    expect(read.audit.schedules?.saved).toBeDefined();
    const kept = await readInventories(join(dir, 'journal'), HOST);
    expect(kept.kept.map((one) => one.inventory.organizationId.slice(0, 15))).toEqual([NOW]);
    expect(org.writes).toEqual([]);

    let status = await statusOf(handler, deps);
    expect(status.beforeNextRefresh.find((item) => item.id === 'jobsInventory')?.status).toBe(
      'done',
    );

    await handler.handle(request('recovery:handoff', { orgId: 'entry-uat' }));
    const { path } = answer<{ path: string }>(deps, 'recovery:handoff:response');
    expect(path.startsWith(join(dir, 'journal', 'handoff', '_recovery'))).toBe(true);
    expect(opened).toEqual([path]);
    const note = readFileSync(path, 'utf8');
    expect(note).toContain('# Handoff: `Back into service` on `UAT`');
    expect(note).toContain('   - Read closed, System email only or No access');
    status = await statusOf(handler, deps);
    expect(status.steps.find((step) => step.id === 'handoff')).toMatchObject({ status: 'done' });
  });

  it('opens the newest note again as it was written, and refuses one no longer kept', async () => {
    const deps = depsOf();
    const handler = handlerOf(deps);
    await handler.handle(request('recovery:handoff:open', { orgId: 'entry-uat' }, 'req-open'));
    expect(errorOf(deps)).toMatchObject({ code: 'NOTE_NOT_FOUND', step: 'handoff' });
    expect(opened).toEqual([]);

    await handler.handle(request('recovery:handoff', { orgId: 'entry-uat' }));
    const { path } = answer<{ path: string }>(deps, 'recovery:handoff:response');
    writeFileSync(path, 'kept as the person left it\n');
    let status = await statusOf(handler, deps);
    expect(status.handoffNote).toEqual({ writtenAt: '2026-11-18T16:00:00.000Z' });

    await handler.handle(request('recovery:handoff:open', { orgId: 'entry-uat' }, 'req-open-2'));
    expect(answer(deps, 'recovery:handoff:open:response')).toEqual({ orgId: 'entry-uat', path });
    expect(opened).toEqual([path, path]);
    // Opened, never written again.
    expect(readFileSync(path, 'utf8')).toBe('kept as the person left it\n');

    rmSync(path);
    await handler.handle(request('recovery:handoff:open', { orgId: 'entry-uat' }, 'req-open-3'));
    expect(errorOf(deps)).toMatchObject({ code: 'NOTE_NOT_FOUND', retryable: false });
    status = await statusOf(handler, deps);
    expect(status.handoffNote).toBeUndefined();
  });

  it('says an editor that would not open the note again, the note left as it is', async () => {
    const deps = depsOf();
    const handler = new RecoveryHandler(deps, {
      journalDir: join(dir, 'journal'),
      usersStore,
      replayStore: { list: () => Promise.resolve([]) },
      checkpointStore: (() => {
        const opened = openCheckpointStore({
          root: join(dir, 'checkpoints'),
          locksDir: join(dir, 'locks'),
        });
        if (!('store' in opened)) throw new Error('no checkpoint store');
        return opened.store;
      })(),
      openInEditor: () => Promise.reject(new Error('no editor in this window')),
      now: () => new Date('2026-11-18T16:00:00.000Z'),
    });
    await handler.handle(request('recovery:handoff', { orgId: 'entry-uat' }));
    await handler.handle(request('recovery:handoff:open', { orgId: 'entry-uat' }));
    expect(errorOf(deps)).toMatchObject({ code: 'FAILED', step: 'handoff', retryable: true });
  });

  it('does not name the org now in a note while only production reported the refresh', async () => {
    refreshes = [
      {
        ...REFRESH,
        evidence: 'production',
        previousOrganizationId: undefined,
        organizationId: undefined,
      },
    ];
    const deps = depsOf();
    await handlerOf(deps).handle(request('recovery:handoff', { orgId: 'entry-uat' }));
    expect(errorOf(deps)).toMatchObject({
      code: 'NOT_CONNECTED',
      step: 'handoff',
      retryable: true,
    });
    expect(opened).toEqual([]);
  });

  it('refuses an org it cannot reach as not connected, retryable', async () => {
    vi.mocked(getJsforceConnection).mockRejectedValue(new Error('ORG_AUTH_EXPIRED: sign in again'));
    const deps = depsOf();
    await handlerOf(deps).handle(
      request('recovery:audit', {
        orgId: 'entry-uat',
        asked: { deliverability: true, schedules: false, endpoints: false },
        save: false,
      }),
    );
    expect(errorOf(deps)).toMatchObject({ code: 'NOT_CONNECTED', retryable: true });
  });
});
