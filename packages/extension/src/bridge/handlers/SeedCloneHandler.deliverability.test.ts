/**
 * A clone from the Seed page on the emails of what runs as its records go in:
 * whether the target delivers them read only when something may send one, and
 * after the production guard; put in the clone's one question, whose answer is
 * the accord; its requests counted with the clone's; its words saying what
 * the clone does with the addresses it writes. A clone does not mute.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseMessage, ForgeTargetAutomation } from '@sandforge/shared';
import { SeedCloneHandler } from './SeedCloneHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { EMAIL_NOT_PERMITTED } from '../../modules/forge/targetDeliverability.js';
import {
  writePathOrderDefects,
  type WritePathStep,
} from '../../modules/checkpoint/beforeRunCheckpoint.js';

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));
vi.mock('../../core/common/sforceLimitParser.js', () => ({
  checkApiLimits: vi.fn(),
}));

/** The source's reads and the order of the objects are doubles. */
const fetcher = vi.hoisted(() => ({
  fetchRecords: vi.fn(),
  countRecords: vi.fn(),
  fetchSample: vi.fn(),
  describe: vi.fn((conn: { describe: (name: string) => Promise<unknown> }, name: string) =>
    conn.describe(name),
  ),
}));
const linker = vi.hoisted(() => ({
  buildEdgesFromDescribe: vi.fn(),
  resolveInsertOrder: vi.fn(),
  lookupsFilledAfter: vi.fn(),
  lookupsOf: vi.fn(),
}));
vi.mock('../../modules/seed/CloneRecordFetcher.js', () => ({
  CloneRecordFetcher: vi.fn().mockImplementation(function () {
    return fetcher;
  }),
}));
vi.mock('../../modules/seed/CloneReferenceLinker.js', () => ({
  CloneReferenceLinker: vi.fn().mockImplementation(function () {
    return linker;
  }),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

/** Every step a clone makes, in the order it makes it, as the fakes below put them down. */
const steps: string[] = [];

/** The id the clone runs under: its request's. */
const OPERATION_ID = 'msg-seed:clone:execute';

const clonePayload = {
  sourceOrgId: 'src-org',
  targetOrgId: 'tgt-org',
  objects: [{ objectApiName: 'Account' }],
  previewId: 'msg-seed:clone:preview',
};

function buildMsg(type: string, payload: unknown): InboundRequest {
  return inboundRequest({ id: `msg-${type}`, type, timestamp: Date.now(), payload } as BaseMessage);
}

/** The target's account flow: it emails the owner of each account created, or of each updated. */
function accountAutomation(
  objects: readonly string[],
  startsOn: 'create' | 'update' = 'create',
): ForgeTargetAutomation {
  return {
    objectsRead: [...objects],
    objects: [
      {
        objectApiName: 'Account',
        flows: [
          {
            apiName: 'Account_Owner',
            label: 'Account owner',
            timing: 'afterSave',
            startsOn,
            condition: 'read',
            messages: [{ kind: 'email', name: 'Tell owner', limit: 'SingleEmail' }],
            permissions: [],
          },
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

const ALL_EMAIL = { compiled: true, success: true };
const CLOSED = { compiled: true, success: false, exceptionMessage: EMAIL_NOT_PERMITTED };

/** A step put down by the fakes, as the write path's order names it. */
const AS_STEP: Readonly<Record<string, WritePathStep>> = {
  'automation read': 'reads',
  'deliverability read': 'deliverabilityRead',
  question: 'question',
  write: 'write',
  result: 'result',
};

describe('SeedCloneHandler — a clone on the emails of what runs', () => {
  let deps: HandlerDeps;
  let handler: SeedCloneHandler;
  let guard: ProductionGuard;
  let apex: unknown;
  let requestsLeft: number;
  const read =
    vi.fn<(orgId: string, objects: readonly string[]) => Promise<ForgeTargetAutomation>>();
  const create = vi.fn(async (batch: unknown[]) => {
    steps.push('write');
    return batch.map((_, n) => ({
      id: `001${String(n + 1).padStart(12, '0')}AAA`,
      success: true,
      errors: [],
    }));
  });

  const failed = () =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === 'operation:failed');
  const answering = (answer: 'confirmed' | 'declined' | 'unavailable') =>
    vi.mocked(guard.confirmRun).mockImplementation(async () => {
      steps.push('question');
      return answer;
    });

  /** Both orgs, the target answering its anonymous Apex with `apex`. */
  function orgs() {
    vi.mocked(getJsforceConnection).mockImplementation(
      async () =>
        ({
          describeGlobal: vi.fn().mockResolvedValue({ sobjects: [] }),
          describe: vi.fn().mockResolvedValue({
            fields: [{ name: 'Name', type: 'string', createable: true, updateable: true }],
            keyPrefix: '001',
          }),
          query: vi.fn(async () => ({ done: true, totalSize: 0, records: [] })),
          queryMore: vi.fn(),
          sobject: vi.fn(() => ({ create, update: vi.fn(), upsert: vi.fn() })),
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
          limitInfo: undefined,
        }) as never,
    );
  }

  /** Previews the clone of three accounts, then runs it with `extra`. */
  async function clone(extra: Record<string, unknown> = {}): Promise<void> {
    await handler.handle(buildMsg('seed:clone:preview', clonePayload));
    steps.length = 0;
    await handler.handle(buildMsg('seed:clone:execute', { ...clonePayload, ...extra }));
  }

  beforeEach(() => {
    vi.clearAllMocks();
    steps.length = 0;
    apex = ALL_EMAIL;
    requestsLeft = 15_000;
    read.mockReset();
    read.mockImplementation(async (_orgId, objects) => {
      steps.push('automation read');
      return accountAutomation(objects);
    });
    linker.buildEdgesFromDescribe.mockReturnValue([]);
    linker.resolveInsertOrder.mockReturnValue(['Account']);
    linker.lookupsFilledAfter.mockReturnValue([]);
    linker.lookupsOf.mockReturnValue([]);
    fetcher.countRecords.mockResolvedValue(3);
    fetcher.fetchSample.mockResolvedValue([]);
    fetcher.fetchRecords.mockResolvedValue(
      Array.from({ length: 3 }, (_, i) => ({
        Id: `001${String(i).padStart(12, '0')}SRC`,
        Name: `Acme ${i}`,
      })),
    );
    guard = new ProductionGuard();
    vi.spyOn(guard, 'confirmRun');
    answering('confirmed');
    const store = new Map<string, unknown>();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: {
        postToWebview: vi.fn((m: BaseMessage) => {
          if (m.type === 'seed:clone:execute:response') steps.push('result');
        }),
      } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn(() => ({ orgType: 'Developer', alias: 'my-dev-org' })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: {
        get: vi.fn((key: string) => store.get(key)),
        set: vi.fn((key: string, value: unknown) => {
          store.set(key, JSON.parse(JSON.stringify(value)));
        }),
      } as unknown as HandlerDeps['configStore'],
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: { productionGuard: guard } as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    handler = new SeedCloneHandler(deps);
    handler.setTargetAutomation({ read });
    orgs();
  });

  const auditEntry = () =>
    new AuditTrailStore(deps.configStore)
      .list()
      .entries.find((e) => e.operationId === OPERATION_ID);
  const question = () => vi.mocked(guard.confirmRun).mock.calls[0]?.[0];

  it('reads the automation once and the org after it, asks, and writes on the answer', async () => {
    await clone();
    await vi.waitFor(() => expect(steps).toContain('result'));

    expect(steps.filter((step) => step === 'automation read')).toHaveLength(1);
    expect(steps.slice(0, 4)).toEqual([
      'automation read',
      'deliverability read',
      'question',
      'write',
    ]);
    expect(
      writePathOrderDefects(steps.flatMap((step) => (AS_STEP[step] ? [AS_STEP[step]] : []))),
    ).toEqual([]);
    expect(question()).toMatchObject({
      stage: 'write',
      module: 'seed',
      total: 3,
      deliverability: {
        reading: { level: 'all' },
        senders: [{ objectApiName: 'Account', name: 'Account owner' }],
      },
    });
    expect(auditEntry()).toMatchObject({
      details: {
        deliverability: 'all',
        confirmed: 'emails',
        contactPoints: 'neutralized',
      },
    });
  });

  it('counts what fires on the update of its second pass among what sends', async () => {
    read.mockImplementation(async (_orgId, objects) => accountAutomation(objects, 'update'));

    await clone();
    await vi.waitFor(() => expect(steps).toContain('result'));

    expect(question()).toMatchObject({
      deliverability: { senders: [{ name: 'Account owner' }] },
    });
  });

  it('writes nothing when the answer is no', async () => {
    answering('declined');

    await clone();

    expect(failed()[0]?.payload).toMatchObject({ code: 'SEED_WRITE_DECLINED' });
    expect(steps).not.toContain('write');
    expect(auditEntry()).toMatchObject({
      outcome: 'stopped',
      details: { code: 'SEED_WRITE_DECLINED' },
    });
  });

  it('refuses a clone nobody can answer for, saying where the emails go by what it does with the addresses', async () => {
    answering('unavailable');

    await clone();

    expect(steps).not.toContain('write');
    const neutralized = String(failed()[0]?.payload.error);
    expect(neutralized).toContain('those this clone writes are under .invalid');
    expect(auditEntry()).toMatchObject({ details: { code: 'EMAILS_NOT_ACCEPTED' } });

    await clone({ keepContactPoints: true });

    expect(String(failed()[1]?.payload.error)).toContain(
      'those of the records this clone writes, as they hold them',
    );
    expect(neutralized).not.toContain('--mute-automation');
  });

  it('asks nothing of the emails of an org that withholds them, and says so in the audit trail', async () => {
    apex = CLOSED;

    await clone();
    await vi.waitFor(() => expect(steps).toContain('result'));

    expect(steps).toContain('deliverability read');
    expect(steps).not.toContain('question');
    expect(auditEntry()).toMatchObject({ details: { deliverability: 'withheld' } });
    expect(auditEntry()?.details).not.toHaveProperty('confirmed');
  });

  it('reads nothing of an org whose automation sends nothing', async () => {
    read.mockImplementation(async (_orgId, objects) => ({
      ...accountAutomation(objects),
      objects: [],
    }));

    await clone();
    await vi.waitFor(() => expect(steps).toContain('result'));

    expect(steps).not.toContain('deliverability read');
    expect(steps).not.toContain('question');
  });

  it('counts what the read sent with the clone’s requests', async () => {
    apex = CLOSED;
    // The clone's own request and the read's two.
    requestsLeft = 2;

    await clone();

    expect(steps).not.toContain('write');
    expect(String(failed()[0]?.payload.error)).toContain(
      '2 of them to read whether the target delivers its emails',
    );
  });
});
