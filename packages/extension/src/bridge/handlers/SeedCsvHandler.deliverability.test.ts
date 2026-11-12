/**
 * A CSV import from the Seed page on the emails of what runs as its rows go
 * in: the org is read only when something may send one, the question names
 * them and going on is the accord, and an import nobody can answer for writes
 * nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BaseMessage, ForgeTargetAutomation } from '@sandforge/shared';
import { SeedCsvHandler } from './SeedCsvHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { EMAIL_NOT_PERMITTED } from '../../modules/forge/targetDeliverability.js';
import { importRequestsEstimate } from '../../modules/seed/seedStorage.js';
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

const writer = vi.hoisted(() => ({ insert: vi.fn(), upsert: vi.fn() }));
vi.mock('../../modules/sync/BulkDataWriter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../modules/sync/BulkDataWriter.js')>()),
  BulkDataWriter: vi.fn().mockImplementation(function () {
    return writer;
  }),
}));

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

const OPERATION_ID = 'msg-seed:csv:execute';
const ALL_EMAIL = { compiled: true, success: true };
const CLOSED = { compiled: true, success: false, exceptionMessage: EMAIL_NOT_PERMITTED };

/** Every step an import makes, in the order it makes it. */
const steps: string[] = [];

/** A step put down by the fakes, as the write path's order names it. */
const AS_STEP: Readonly<Record<string, WritePathStep>> = {
  'automation read': 'reads',
  'deliverability read': 'deliverabilityRead',
  question: 'question',
  write: 'write',
  result: 'result',
};

/** The target's account flow: it emails the owner of each account created. */
function emailingFlow(objects: readonly string[]): ForgeTargetAutomation {
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
            startsOn: 'create',
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

function buildMsg(): InboundRequest {
  return inboundRequest({
    id: OPERATION_ID,
    type: 'seed:csv:execute',
    timestamp: Date.now(),
    payload: {
      orgId: 'tgt-org',
      objectApiName: 'Account',
      records: [{ name: 'Acme' }, { name: 'Globex' }],
      columnMappings: [
        { csvHeader: 'name', sfFieldApiName: 'Name', sfFieldType: 'string', sfFieldLength: 255 },
      ],
    },
  } as BaseMessage);
}

describe('SeedCsvHandler — an import on the emails of what runs', () => {
  let deps: HandlerDeps;
  let handler: SeedCsvHandler;
  let guard: ProductionGuard;
  let apex: unknown;
  let orgType: string;
  let requestsLeft: number;
  const read =
    vi.fn<(orgId: string, objects: readonly string[]) => Promise<ForgeTargetAutomation>>();

  const posted = (type: string) =>
    vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  const question = () => vi.mocked(guard.confirmRun).mock.calls[0]?.[0];
  const auditEntry = () =>
    new AuditTrailStore(deps.configStore)
      .list()
      .entries.find((e) => e.operationId === OPERATION_ID);
  const answering = (answer: 'confirmed' | 'declined' | 'unavailable') =>
    vi.mocked(guard.confirmRun).mockImplementation(async () => {
      steps.push('question');
      return answer;
    });

  beforeEach(() => {
    vi.clearAllMocks();
    steps.length = 0;
    apex = ALL_EMAIL;
    orgType = 'Developer';
    requestsLeft = 15_000;
    read.mockReset();
    read.mockImplementation(async (_orgId, objects) => {
      steps.push('automation read');
      return emailingFlow(objects);
    });
    writer.insert.mockImplementation(async (_object: string, rows: unknown[]) => {
      steps.push('write');
      return rows.map((_, n) => ({
        success: true,
        id: `001${String(n).padStart(12, '0')}AAA`,
        errors: [],
      }));
    });
    vi.mocked(getJsforceConnection).mockResolvedValue({
      identity: async () => ({ user_id: '005000000000001AAA' }),
      request: vi.fn(async (request: string | { url: string }) => {
        const url = typeof request === 'string' ? request : request.url;
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
        };
      }),
      limitInfo: undefined,
    } as never);
    guard = new ProductionGuard();
    vi.spyOn(guard, 'confirmRun');
    answering('confirmed');
    const store = new Map<string, unknown>();
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: {
        postToWebview: vi.fn((m: BaseMessage) => {
          if (m.type === 'seed:csv:execute:response') steps.push('result');
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
      } as unknown as HandlerDeps['configStore'],
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: { productionGuard: guard } as HandlerDeps['infraServices'],
      nextId: () => String(++n),
    };
    handler = new SeedCsvHandler(deps);
    handler.setTargetAutomation({ read });
  });

  it('reads the automation, then the org, asks, and writes on the answer', async () => {
    await handler.handle(buildMsg());

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
      total: 2,
      deliverability: {
        reading: { level: 'all' },
        senders: [{ objectApiName: 'Account', name: 'Account owner' }],
      },
    });
    expect(auditEntry()).toMatchObject({
      details: { deliverability: 'all', confirmed: 'emails' },
    });
  });

  it('writes nothing when the answer is no', async () => {
    answering('declined');

    await handler.handle(buildMsg());

    expect(steps).not.toContain('write');
    expect(posted('seed:csv:error')[0]?.payload).toMatchObject({ code: 'SEED_WRITE_DECLINED' });
  });

  it('refuses an import nobody can answer for, saying the file’s addresses go as they are', async () => {
    answering('unavailable');

    await handler.handle(buildMsg());

    expect(steps).not.toContain('write');
    expect(posted('seed:csv:error')[0]?.payload).toMatchObject({ code: 'EMAILS_NOT_ACCEPTED' });
    expect(String(posted('seed:csv:error')[0]?.payload.message)).toContain('as they hold them');
    expect(auditEntry()).toMatchObject({ details: { code: 'EMAILS_NOT_ACCEPTED' } });
  });

  it('asks nothing of an org that withholds the emails, and says so in the audit trail', async () => {
    apex = CLOSED;

    await handler.handle(buildMsg());

    expect(steps).toContain('deliverability read');
    expect(steps).not.toContain('question');
    expect(steps).toContain('write');
    expect(auditEntry()).toMatchObject({ details: { deliverability: 'withheld' } });
    expect(auditEntry()?.details).not.toHaveProperty('confirmed');
  });

  it('reads nothing of an org whose automation sends nothing', async () => {
    read.mockImplementation(async (_orgId, objects) => ({
      ...emailingFlow(objects),
      objects: [],
    }));

    await handler.handle(buildMsg());

    expect(steps).not.toContain('deliverability read');
    expect(steps).not.toContain('question');
    expect(steps).toContain('write');
  });

  it('asks when the automation could not be read, and runs no Apex in a production org', async () => {
    read.mockRejectedValue(new Error('Tooling API down'));
    orgType = 'Production';

    await handler.handle(buildMsg());

    expect(steps).not.toContain('deliverability read');
    expect(question()).toMatchObject({
      deliverability: { reading: { unread: expect.any(String) } },
    });
  });

  it('counts what the read sent with the import’s requests', async () => {
    // A closed org's read sends two requests: with one left past the run's
    // own — two rows, one REST call —, the run alone fits and the two
    // together do not.
    apex = CLOSED;
    requestsLeft =
      importRequestsEstimate([{ objectApiName: 'Account', rows: 2 }], { threshold: 200 }) + 1;

    await handler.handle(buildMsg());

    expect(posted('seed:csv:error')[0]?.payload).toMatchObject({ code: 'API_BUDGET_EXCEEDED' });
    expect(steps).not.toContain('write');
  });
});
