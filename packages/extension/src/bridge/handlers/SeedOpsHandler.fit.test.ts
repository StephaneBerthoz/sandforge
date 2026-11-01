/**
 * A seed from the panel that does not fit its target: what the org runs is
 * read first, before the storage, so the refusal for the storage or the
 * requests carries the counts that fit, room kept for what the org's flows
 * that still run create under them; those counts, applied, are let through.
 * And the order a seed that mutes keeps from its reads to its result.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BaseMessage,
  ForgeTargetAutomation,
  SeedFitProposal,
  SeedTemplate,
} from '@sandforge/shared';
import { BYTES_PER_MB, CRM_STARTER, SALES_CLOUD_STARTER } from '@sandforge/shared';

import { SeedOpsHandler } from './SeedOpsHandler.js';
import type { HandlerDeps } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import { seedStorageBytes } from '../../modules/seed/seedStorage.js';
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

/** Every step a run makes, in the order it makes it, as the tests below put them down. */
const steps: string[] = [];

// The plan of the mute and what still runs are computed, not sent: each is
// put down as it is made.
vi.mock('../../modules/forge/AutomationMuteLease.js', async (original) => {
  const actual = await original<typeof import('../../modules/forge/AutomationMuteLease.js')>();
  return {
    ...actual,
    muteForRun: vi.fn((...args: Parameters<typeof actual.muteForRun>) => {
      steps.push('lease plan');
      return actual.muteForRun(...args);
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

const KB = 1024;

/** A flow of the target, read with its start condition. */
function flowOf(overrides: Partial<ForgeTargetAutomation['objects'][number]['flows'][number]>) {
  return {
    apiName: 'Flow',
    label: 'Flow',
    timing: 'afterSave' as const,
    startsOn: 'create' as const,
    condition: 'read' as const,
    permissions: [],
    ...overrides,
  };
}

/** A target whose account flow creates a Task under each account created, which nothing keeps quiet. */
function creatingAutomation(objects: readonly string[]): ForgeTargetAutomation {
  return {
    objectsRead: [...objects],
    objects: [
      {
        objectApiName: 'Account',
        flows: [
          flowOf({ apiName: 'Account_Follow_Up', label: 'Account follow-up', creates: ['Task'] }),
        ],
        triggers: [],
      },
    ],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    requests: 1,
  };
}

/** A target whose contact flow emails each contact created unless its user holds the bypass a set grants. */
function bypassedAutomation(objects: readonly string[]): ForgeTargetAutomation {
  return {
    objectsRead: [...objects],
    objects: [
      {
        objectApiName: 'Contact',
        flows: [
          flowOf({
            apiName: 'Welcome_Email',
            label: 'Welcome Email',
            creates: ['Task'],
            permissions: [{ name: 'Trap_Bypass_Flow', bypass: true, held: false }],
            messages: [{ kind: 'email', name: 'Send Welcome Email', limit: 'SingleEmail' }],
          }),
        ],
        triggers: [],
      },
    ],
    unread: [],
    conditionsNotRead: 0,
    conditionsBound: 25,
    bypassGrants: [
      {
        permission: 'Trap_Bypass_Flow',
        permissionSets: [{ name: 'Trap_Bypass', label: 'Trap Bypass', grants: 1 }],
      },
    ],
    requests: 1,
  };
}

/** What `/limits` answers, put down as it is read. */
function limitsOf(storage = { Max: 5, Remaining: 5 }, api = { Max: 15_000, Remaining: 15_000 }) {
  return vi.fn(async () => {
    steps.push('limits read');
    return {
      DataStorageMB: storage,
      DailyApiRequests: api,
      SingleEmail: { Max: 15, Remaining: 15 },
    };
  });
}

/** A Developer Edition reached through `request` for its limits, in en_US. */
function developerEdition(request: () => Promise<unknown> = limitsOf()) {
  const query = vi.fn(async (soql: string) =>
    soql.includes('FROM Organization')
      ? { records: [{ DefaultLocaleSidKey: 'en_US' }] }
      : { records: [] },
  );
  vi.mocked(getJsforceConnection).mockResolvedValue({ request, query } as never);
  return { request };
}

/** A template with the counts of a proposal, as the page applies them. */
function applied(template: SeedTemplate, fit: SeedFitProposal): SeedTemplate {
  const after = new Map(fit.objects.map((o) => [o.objectApiName, o.after]));
  return {
    ...template,
    objects: template.objects.map((o) => ({
      ...o,
      recordCount: after.get(o.objectApiName) ?? o.recordCount,
    })),
  };
}

describe('SeedOpsHandler — a seed fitted to the storage', () => {
  let deps: HandlerDeps;
  let handler: SeedOpsHandler;
  let executed: SeedTemplate[];
  let guard: ProductionGuard;
  const read =
    vi.fn<(orgId: string, objects: readonly string[]) => Promise<ForgeTargetAutomation>>();

  const posted = (type: string) =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);

  beforeEach(() => {
    vi.clearAllMocks();
    steps.length = 0;
    executed = [];
    read.mockReset();
    read.mockImplementation(async (_orgId, objects) => {
      steps.push('automation read');
      return creatingAutomation(objects);
    });
    let n = 0;
    guard = new ProductionGuard();
    deps = {
      log: vi.fn(),
      broker: {
        postToWebview: vi.fn((m: BaseMessage) => {
          if (m.type === 'seed:execute:response') steps.push('result');
        }),
      } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn(() => ({ orgType: 'Developer', alias: 'my-dev-org' })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: {
        get: vi.fn(),
        set: vi.fn(),
        getKeysByPrefix: vi.fn(() => []),
      } as unknown as HandlerDeps['configStore'],
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: { productionGuard: guard } as HandlerDeps['infraServices'],
      services: {
        isAIEnabled: () => false,
        getSandforgeSetting: vi.fn((_key: string, fallback: unknown) => fallback),
        seedOrchestrator: vi.fn(() => ({
          execute: vi.fn(async (template: SeedTemplate) => {
            steps.push('write');
            executed.push(template);
            return {
              templateId: template.id,
              operationId: 'op-1',
              status: 'success',
              objectResults: [],
              totalRecordsCreated: 0,
              totalRecordsFailed: 0,
              duration: 1,
              timestamp: '2026-11-01T00:00:00.000Z',
            };
          }),
        })),
      } as unknown as HandlerDeps['services'],
      nextId: () => String(++n),
    };
    handler = new SeedOpsHandler(deps);
    handler.setTargetAutomation({ read });
  });

  const execute = (template: SeedTemplate, extra: Record<string, unknown> = {}) =>
    handler.handle(
      inboundRequest({
        id: 'seed-run',
        type: 'seed:execute',
        timestamp: Date.now(),
        payload: { orgId: 'org-1', template, ...extra },
      }),
    );

  it('reads what the org runs before its storage, and refuses with the counts that fit, room kept for what its flows create', async () => {
    developerEdition();
    await execute(SALES_CLOUD_STARTER);

    // Read once, and before the limits: the proposal needs no read more.
    expect(read).toHaveBeenCalledTimes(1);
    expect(steps.indexOf('automation read')).toBeLessThan(steps.indexOf('limits read'));
    expect(executed).toEqual([]);
    const [error] = posted('seed:error');
    expect(error.payload).toMatchObject({
      code: 'SEED_STORAGE_EXCEEDED',
      estimateMB: 14.9,
      remainingMB: 5,
      maxMB: 5,
      org: 'my-dev-org',
    });
    const fit = error.payload.fit as SeedFitProposal;
    expect(fit.cannotFit).toBeUndefined();
    expect(fit.budget).toMatchObject({ remainingMB: 5, maxMB: 5, roundingMB: 0.5 });
    expect(fit.objects.map((o) => o.objectApiName)).toEqual(
      SALES_CLOUD_STARTER.objects.map((o) => o.objectApiName),
    );

    // The records and the Task the flow creates under each account kept fit
    // what a fit may take: 80 % of the 5 MB, half a MB off for rounding.
    const fitted = applied(SALES_CLOUD_STARTER, fit);
    const accounts = fitted.objects.find((o) => o.objectApiName === 'Account')?.recordCount ?? 0;
    const taken = seedStorageBytes(fitted, []) + accounts * 2 * KB;
    expect(taken).toBeLessThanOrEqual(0.8 * (5 - 0.5) * BYTES_PER_MB);
    expect(fit.budget.automationMB).toBe((accounts * 2 * KB) / BYTES_PER_MB);

    // Applied, the counts meet the gate again, and the seed runs.
    await execute(fitted, { fit: { share: fit.share } });
    await vi.waitFor(() => expect(executed).toHaveLength(1));
    expect(executed[0].objects.map((o) => o.recordCount)).toEqual(fit.objects.map((o) => o.after));
  });

  it('answers a refusal for the API requests with why no smaller seed fits: the day is spent past its last tenth', async () => {
    // Fewer requests left than the seed takes is fewer than a tenth of the
    // day: a seed cut to a REST call per object would still leave the org's
    // own integrations short. The refusal's own way out is to wait.
    developerEdition(limitsOf({ Max: 500, Remaining: 500 }, { Max: 15_000, Remaining: 20 }));
    await execute(SALES_CLOUD_STARTER);

    const [error] = posted('seed:error');
    expect(error.payload).toMatchObject({ code: 'API_BUDGET_EXCEEDED' });
    const fit = error.payload.fit as SeedFitProposal;
    expect(fit.cannotFit).toMatch(
      /takes about 6 API requests, past the 0 that leave the org a tenth of its daily requests$/,
    );
  });

  it('proposes nothing when the org will not say its storage: there is nothing to fit to', async () => {
    const request = vi.fn(async () => {
      steps.push('limits read');
      return { DailyApiRequests: { Max: 15_000, Remaining: 3 } };
    });
    developerEdition(request);
    await execute(CRM_STARTER);

    const [error] = posted('seed:error');
    expect(error.payload).toMatchObject({ code: 'API_BUDGET_EXCEEDED' });
    expect(error.payload).not.toHaveProperty('fit');
  });

  it('plans its mute and what still runs before its storage, asks, then holds the bypass only while it writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'seed-fit-'));
    const SET = '0PSxx0000000001AAA';
    read.mockImplementation(async (_orgId, objects) => {
      steps.push('automation read');
      return bypassedAutomation(objects);
    });
    const org = memoryPermissionOrg({
      sets: [{ id: SET, name: 'Trap_Bypass' }],
      beforeWrite: (write) => {
        steps.push(write.kind === 'insert' ? 'assign' : 'unassign');
      },
    });
    // A day nearly spent: the seed asks before it writes.
    const request = limitsOf({ Max: 5, Remaining: 5 }, { Max: 15_000, Remaining: 1_400 });
    vi.mocked(getJsforceConnection).mockResolvedValue({
      request,
      query: async (soql: string) =>
        soql.includes('DefaultLocaleSidKey')
          ? { records: [{ DefaultLocaleSidKey: 'en_US' }] }
          : org.connection.query(soql),
      identity: org.connection.identity,
      sobject: org.connection.sobject,
    } as never);
    vi.spyOn(guard, 'confirmRun').mockImplementation(async () => {
      steps.push('question');
      return 'confirmed';
    });
    handler.setMuteLeases({ dir, renewEveryMs: 0 });

    await execute(CRM_STARTER, { muteAutomation: true });
    await vi.waitFor(() => expect(steps).toContain('result'));

    expect(steps).toEqual([
      'automation read',
      'lease plan',
      'still running',
      'limits read',
      'question',
      'assign',
      'write',
      'unassign',
      'result',
    ]);
    const asStep: Record<string, WritePathStep> = {
      'automation read': 'reads',
      'limits read': 'reads',
      'lease plan': 'leasePlan',
      'still running': 'stillRunning',
      question: 'question',
      assign: 'leaseAcquire',
      write: 'write',
      unassign: 'leaseRelease',
      result: 'result',
    };
    expect(writePathOrderDefects(steps.map((step) => asStep[step] as WritePathStep))).toEqual([]);
    // One read of the automation, one assignment given back, one run: nothing assigned before the answer.
    expect(read).toHaveBeenCalledTimes(1);
    expect(org.writes.map((w) => w.kind)).toEqual(['insert', 'delete']);
    expect(org.assignments()).toEqual([]);
    expect(executed).toHaveLength(1);
    rmSync(dir, { recursive: true, force: true });
  });
});
