/**
 * A seed of the Seed page on the emails of what still runs as its records go
 * in: whether the org delivers them read once the mute's plan says what does,
 * and only when something may send one; put in the seed's one question, whose
 * answer is the accord; the read's requests counted with the seed's; a lease
 * that does not hold its plan refused before the first record.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BaseMessage,
  ForgeTargetAutomation,
  ForgeTargetFlow,
  MutedAutomation,
  SeedTemplate,
} from '@sandforge/shared';
import { CRM_STARTER } from '@sandforge/shared';

import { SeedOpsHandler } from './SeedOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { EMAIL_NOT_PERMITTED } from '../../modules/forge/targetDeliverability.js';
import {
  writePathOrderDefects,
  type WritePathStep,
} from '../../modules/checkpoint/beforeRunCheckpoint.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/** Every step a seed makes, in the order it makes it, as the fakes below put them down. */
const steps: string[] = [];

/** What the lease holds once read back, when a test says it holds less than its plan. */
const lease = vi.hoisted(() => ({ holdsNothing: false }));

vi.mock('../../modules/forge/AutomationMuteLease.js', async (original) => {
  const actual = await original<typeof import('../../modules/forge/AutomationMuteLease.js')>();
  return {
    ...actual,
    muteForRun: vi.fn(async (...args: Parameters<typeof actual.muteForRun>) => {
      steps.push('lease plan');
      const planned = await actual.muteForRun(...args);
      if (!lease.holdsNothing || !planned.prepared) return planned;
      const held: MutedAutomation = { ...planned.muted, state: 'muted', assigned: [] };
      return {
        ...planned,
        prepared: {
          ...planned.prepared,
          acquire: async () => {
            steps.push('assign');
            return {
              outcome: held,
              release: async () => {
                steps.push('unassign');
                return held;
              },
            };
          },
        },
      };
    }),
  };
});
vi.mock('../../modules/seed/seedFit.js', async (original) => {
  const actual = await original<typeof import('../../modules/seed/seedFit.js')>();
  return {
    ...actual,
    seedRoomOf: vi.fn((...args: Parameters<typeof actual.seedRoomOf>) => {
      steps.push('still running');
      return actual.seedRoomOf(...args);
    }),
  };
});

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const SET = '0PSxx0000000001AAA';

const fakeId = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

/** Two accounts and three contacts: a seed that fits a Developer Edition. */
const SMALL: SeedTemplate = {
  ...CRM_STARTER,
  objects: CRM_STARTER.objects
    .filter((o) => o.objectApiName === 'Account' || o.objectApiName === 'Contact')
    .map((o) => ({ ...o, recordCount: o.objectApiName === 'Account' ? 2 : 3 })),
  relations: [],
};

const welcome = (over: Partial<ForgeTargetFlow> = {}): ForgeTargetFlow => ({
  apiName: 'Welcome_Email',
  label: 'Welcome Email',
  timing: 'afterSave',
  startsOn: 'create',
  condition: 'read',
  permissions: [{ name: 'Org_Bypass', bypass: true, held: false }],
  messages: [{ kind: 'email', name: 'Send Welcome Email', limit: 'SingleEmail' }],
  ...over,
});

/** What the target runs on contacts: a flow that emails each, kept quiet by a set's bypass. */
function targetOf(
  objects: readonly string[],
  flows: ForgeTargetFlow[] = [welcome()],
): ForgeTargetAutomation {
  return {
    objectsRead: [...objects],
    objects: flows.length > 0 ? [{ objectApiName: 'Contact', flows, triggers: [] }] : [],
    bypassGrants: [
      {
        permission: 'Org_Bypass',
        permissionSets: [{ name: 'Org_Bypass_Set', label: 'Org bypass', grants: 1 }],
      },
    ],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 1,
  };
}

const ALL_EMAIL = { compiled: true, success: true };
const CLOSED = { compiled: true, success: false, exceptionMessage: EMAIL_NOT_PERMITTED };

/** A step put down by the fakes, as the write path's order names it. */
const AS_STEP: Readonly<Record<string, WritePathStep>> = {
  'automation read': 'reads',
  'lease plan': 'leasePlan',
  'still running': 'stillRunning',
  'deliverability read': 'deliverabilityRead',
  question: 'question',
  assign: 'leaseAcquire',
  write: 'write',
  unassign: 'leaseRelease',
  result: 'result',
};
const ordered = (said: readonly string[]): WritePathStep[] =>
  said.flatMap((step) => (AS_STEP[step] ? [AS_STEP[step]] : []));

describe('SeedOpsHandler — a seed on the emails of what still runs', () => {
  let deps: HandlerDeps;
  let handler: SeedOpsHandler;
  let guard: ProductionGuard;
  let dir: string;
  /** What the org answers its anonymous Apex with. */
  let apex: unknown;
  let requestsLeft: number;
  let orgType: string;
  const read =
    vi.fn<(orgId: string, objects: readonly string[]) => Promise<ForgeTargetAutomation>>();
  const create = vi.fn(async (batch: Record<string, unknown>[]) => {
    steps.push('write');
    return batch.map((_, n) => ({ id: fakeId('003', n + 1), success: true, errors: [] }));
  });

  const posted = (type: string) =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  const answering = (answer: 'confirmed' | 'declined' | 'unavailable') =>
    vi.mocked(guard.confirmRun).mockImplementation(async () => {
      steps.push('question');
      return answer;
    });

  /** A Developer Edition whose permission sets live in memory. */
  function developerEdition() {
    const org = memoryPermissionOrg({
      sets: [{ id: SET, name: 'Org_Bypass_Set' }],
      beforeWrite: (write) => {
        steps.push(write.kind === 'insert' ? 'assign' : 'unassign');
      },
    });
    vi.mocked(getJsforceConnection).mockResolvedValue({
      request: vi.fn(async ({ url }: { url: string }) => {
        if (url.includes('executeAnonymous')) {
          steps.push('deliverability read');
          return apex;
        }
        if (url.includes('UserPermissionAccess')) {
          return { records: [{ PermissionsEmailSingle: true }] };
        }
        return {
          DataStorageMB: { Max: 5, Remaining: 5 },
          DailyApiRequests: { Max: 15_000, Remaining: requestsLeft },
          SingleEmail: { Max: 15, Remaining: 15 },
        };
      }),
      query: async (soql: string) =>
        soql.includes('DefaultLocaleSidKey')
          ? { records: [{ DefaultLocaleSidKey: 'en_US' }] }
          : org.connection.query(soql),
      identity: org.connection.identity,
      sobject: (name: string) =>
        name === 'PermissionSetAssignment' ? org.connection.sobject(name) : { create },
    } as never);
    return org;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    steps.length = 0;
    lease.holdsNothing = false;
    apex = ALL_EMAIL;
    requestsLeft = 15_000;
    orgType = 'Developer';
    read.mockReset();
    read.mockImplementation(async (_orgId, objects) => {
      steps.push('automation read');
      return targetOf(objects);
    });
    let n = 0;
    guard = new ProductionGuard();
    vi.spyOn(guard, 'confirmRun');
    answering('confirmed');
    const store = new Map<string, unknown>();
    deps = {
      log: vi.fn(),
      broker: {
        postToWebview: vi.fn((m: BaseMessage) => {
          if (m.type === 'seed:execute:response') steps.push('result');
        }),
      } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn(() => ({ orgType, alias: 'my-dev-org' })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: {
        get: vi.fn((key: string) => store.get(key)),
        set: vi.fn((key: string, value: unknown) => {
          store.set(key, JSON.parse(JSON.stringify(value)));
        }),
        getKeysByPrefix: vi.fn(() => []),
      } as unknown as HandlerDeps['configStore'],
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: { productionGuard: guard } as HandlerDeps['infraServices'],
      services: {
        isAIEnabled: () => false,
        getSandforgeSetting: vi.fn((_key: string, fallback: unknown) => fallback),
        seedOrchestrator: vi.fn(
          (seedDeps: {
            insert: (
              orgId: string,
              objectApiName: string,
              records: Record<string, unknown>[],
              batchSize: number,
            ) => Promise<unknown>;
          }) => ({
            execute: vi.fn(async (template: SeedTemplate, orgId: string) => {
              await seedDeps.insert(orgId, 'Contact', [{ LastName: 'Doe' }], 200);
              return {
                templateId: template.id,
                operationId: 'op-1',
                status: 'success',
                objectResults: [],
                totalRecordsCreated: 1,
                totalRecordsFailed: 0,
                duration: 1,
                timestamp: '2026-11-01T00:00:00.000Z',
              };
            }),
          }),
        ),
      } as unknown as HandlerDeps['services'],
      nextId: () => String(++n),
    };
    handler = new SeedOpsHandler(deps);
    handler.setTargetAutomation({ read });
    dir = mkdtempSync(join(tmpdir(), 'seed-emails-'));
    handler.setMuteLeases({ dir, renewEveryMs: 0 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const execute = (extra: Record<string, unknown> = {}) =>
    handler.handle(
      inboundRequest({
        id: 'seed-mail',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', template: SMALL, ...extra },
      }),
    );
  const question = () => vi.mocked(guard.confirmRun).mock.calls[0]?.[0];
  const auditEntry = () =>
    new AuditTrailStore(deps.configStore).list().entries.find((e) => e.operationId === 'seed-mail');
  /** The run, to its end. */
  const ran = async () => vi.waitFor(() => expect(steps).toContain('result'));

  it('reads the org once the plan is made, puts the emails in its one question, and takes going on for the accord', async () => {
    developerEdition();

    await execute();
    await ran();

    expect(steps).toEqual([
      'automation read',
      'still running',
      'deliverability read',
      'question',
      'write',
      'result',
    ]);
    expect(writePathOrderDefects(ordered(steps))).toEqual([]);
    expect(question()).toMatchObject({
      stage: 'write',
      module: 'seed',
      deliverability: {
        reading: { level: 'all' },
        senders: [{ objectApiName: 'Contact', name: 'Welcome Email', why: 'email' }],
      },
    });
    expect(auditEntry()).toMatchObject({
      outcome: 'success',
      details: { deliverability: 'all', confirmed: 'emails' },
    });
  });

  it('writes nothing when the answer is no', async () => {
    developerEdition();
    answering('declined');

    await execute();

    expect(posted('seed:error')[0]?.payload).toMatchObject({ code: 'SEED_WRITE_DECLINED' });
    expect(create).not.toHaveBeenCalled();
    expect(auditEntry()).toMatchObject({
      outcome: 'stopped',
      details: { code: 'SEED_WRITE_DECLINED', deliverability: 'all' },
    });
    expect(auditEntry()?.details).not.toHaveProperty('confirmed');
  });

  it('refuses a seed nobody can answer for, where its storage alone would let it go on', async () => {
    developerEdition();
    answering('unavailable');

    await execute();

    const [error] = posted('seed:error');
    expect(error?.payload).toMatchObject({ code: 'EMAILS_NOT_ACCEPTED' });
    expect(String(error?.payload.message)).toContain(
      'those of the records this seed writes, as they hold them',
    );
    expect(String(error?.payload.message)).not.toContain('.invalid');
    expect(create).not.toHaveBeenCalled();
  });

  it('asks as it does for All email when the org answers anything else', async () => {
    developerEdition();
    apex = { compiled: true, success: false, exceptionMessage: 'System.LimitException: no' };

    await execute();
    await ran();

    expect(question()).toMatchObject({
      deliverability: { reading: { unread: 'the org answered: System.LimitException: no' } },
    });
    expect(auditEntry()?.details).toMatchObject({ deliverability: 'unread', confirmed: 'emails' });
  });

  it('asks nothing of the emails of an org that withholds them, and says so in the audit trail', async () => {
    developerEdition();
    apex = CLOSED;

    await execute();
    await ran();

    expect(steps).toContain('deliverability read');
    expect(steps).not.toContain('question');
    expect(auditEntry()?.details).toEqual({ deliverability: 'withheld' });
  });

  it('reads nothing of an org whose automation sends nothing', async () => {
    developerEdition();
    read.mockImplementation(async (_orgId, objects) => targetOf(objects, []));

    await execute();
    await ran();

    expect(steps).not.toContain('deliverability read');
    expect(steps).not.toContain('question');
    expect(auditEntry()?.details ?? {}).not.toHaveProperty('deliverability');
  });

  it('reads nothing when the mute’s plan keeps every sender quiet, and holds the lease for the writes', async () => {
    const org = developerEdition();

    await execute({ muteAutomation: true });
    await ran();

    expect(steps).toEqual([
      'automation read',
      'lease plan',
      'still running',
      'assign',
      'write',
      'unassign',
      'result',
    ]);
    expect(writePathOrderDefects(ordered(steps))).toEqual([]);
    expect(org.assignments()).toEqual([]);
  });

  it('judges a seed that mutes on what still runs, asking before the lease', async () => {
    developerEdition();
    read.mockImplementation(async (_orgId, objects) =>
      targetOf(objects, [
        welcome(),
        welcome({ apiName: 'Notice', label: 'Contact notice', permissions: [] }),
      ]),
    );

    await execute({ muteAutomation: true });
    await ran();

    expect(steps.indexOf('deliverability read')).toBeLessThan(steps.indexOf('question'));
    expect(steps.indexOf('question')).toBeLessThan(steps.indexOf('assign'));
    expect(question()).toMatchObject({
      deliverability: { senders: [expect.objectContaining({ name: 'Contact notice' })] },
    });
    expect(writePathOrderDefects(ordered(steps))).toEqual([]);
  });

  it('refuses before its first record a lease that does not hold what kept the senders quiet, and gives it back', async () => {
    developerEdition();
    lease.holdsNothing = true;

    await execute({ muteAutomation: true });
    await vi.waitFor(() => expect(posted('seed:error')).toHaveLength(1));

    expect(posted('seed:error')[0]?.payload).toMatchObject({
      code: 'EMAILS_NOT_ACCEPTED',
      message: expect.stringContaining('flow "Welcome Email" on Contact may send emails') as string,
    });
    expect(steps).not.toContain('write');
    expect(steps.at(-1)).toBe('unassign');
    // Nothing of what was planned to run sends: the org was not read.
    expect(auditEntry()).toMatchObject({
      outcome: 'stopped',
      details: { code: 'EMAILS_NOT_ACCEPTED' },
    });
    expect(auditEntry()?.details).not.toHaveProperty('deliverability');
  });

  it('counts what the read sent with the seed’s requests, named in the refusal', async () => {
    developerEdition();
    apex = CLOSED;
    requestsLeft = 3;

    await execute();

    const [error] = posted('seed:error');
    expect(error?.payload).toMatchObject({ code: 'API_BUDGET_EXCEEDED' });
    expect(String(error?.payload.message)).toContain(
      '2 of them to read whether the target delivers its emails',
    );
  });

  it('runs no Apex in a production org: what it sends is asked about', async () => {
    developerEdition();
    orgType = 'Production';
    vi.spyOn(guard, 'check').mockReturnValue({
      allowed: true,
      requiresConfirmation: false,
      impactSummary: '',
    } as never);

    await execute();
    await vi.waitFor(() => expect(question()).toBeDefined());

    expect(steps).not.toContain('deliverability read');
    expect(question()).toMatchObject({
      deliverability: { reading: { unread: 'SandForge runs no Apex in a production org' } },
    });
  });

  describe('the page’s read of what the org runs', () => {
    const ask = () =>
      handler.handle(
        inboundRequest({
          id: 'ask-1',
          type: 'seed:automation',
          timestamp: Date.now(),
          payload: { orgId: 'org-1', objects: ['Contact'] },
        }),
      );

    it('says what may send and whether the org delivers it', async () => {
      developerEdition();

      await ask();

      expect(posted('seed:automation:response')[0]?.payload.preview).toMatchObject({
        deliverability: { reading: { level: 'all' }, senders: [{ name: 'Welcome Email' }] },
      });
    });

    it('runs no Apex in a production org', async () => {
      developerEdition();
      orgType = 'Production';

      await ask();

      expect(steps).not.toContain('deliverability read');
      expect(posted('seed:automation:response')[0]?.payload.preview).toMatchObject({
        deliverability: { reading: { unread: 'SandForge runs no Apex in a production org' } },
      });
    });
  });
});
