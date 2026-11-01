import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  BaseMessage,
  ForgeTargetAutomation,
  FrozenLoadReportInfo,
  FrozenProjectConfig,
  RunCheckpointEstimate,
  RunCheckpointTaken,
} from '@sandforge/shared';
import { buildFrozenManifest } from '../../modules/frozendataset/index.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { FrozenDatasetHandler } from './FrozenDatasetHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import {
  writePathOrderDefects,
  type BeforeRunCheckpoints,
  type WritePathStep,
} from '../../modules/checkpoint/beforeRunCheckpoint.js';
import { inboundRequest } from '../../test/mockFactories.js';
import { memoryPermissionOrg } from '../../test/memoryPermissionOrg.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/** The writes of the load, through the writer the handler builds: all that is not real here. */
const written = vi.hoisted(() => ({ insert: vi.fn() }));
vi.mock('../../modules/frozendataset/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/frozendataset/index.js')>();
  return {
    ...actual,
    createBulkDmlWriter: () => ({
      insert: written.insert,
      update: vi.fn(async () => []),
      delete: vi.fn(async () => []),
    }),
  };
});

/*
 * The write path of a load through the real handler and the real loader,
 * against a target that answers what they read: Production Guard's question,
 * the checkpoint, the mute's lease, the describes, the writes, the lease given
 * back, the record types read back, in that order. The stock guard asks
 * nothing of the tiers a load may write to: the guard here is one a host
 * injects, asking about every write.
 */

const SET = '0PSxx0000000001AAA';
const MASTER_ID = '012000000000000AAA';
const RETAIL_ID = '012C1000000000AAAA';
const HIDDEN_ID = '012C1000000000BAAA';

/** What the target runs on the accounts: a flow whose bypass `Data_Load` holds. */
const ACCOUNT_FLOW: ForgeTargetAutomation = {
  objectsRead: ['Account'],
  objects: [
    {
      objectApiName: 'Account',
      flows: [
        {
          apiName: 'Account_Welcome',
          label: 'Account welcome',
          timing: 'afterSave',
          startsOn: 'create',
          condition: 'read',
          permissions: [{ name: 'Load_Data', bypass: true }],
          creates: ['Task'],
        },
      ],
      triggers: [],
    },
  ],
  bypassGrants: [
    {
      permission: 'Load_Data',
      permissionSets: [{ name: 'Data_Load', label: 'Data load', grants: 1 }],
    },
  ],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 4,
};

const ESTIMATE: RunCheckpointEstimate = {
  state: 'planned',
  estimate: { records: 12, apiRequests: 8, apiRequestsLeft: 14_000, seconds: 4, bytes: 120_000 },
  objects: ['Account'],
  added: [],
  notHeld: [],
  keepDays: 7,
};

const TAKEN: RunCheckpointTaken = {
  state: 'taken',
  checkpointId: 'ck-before-frozen-1',
  name: 'Before Frozen Dataset load 2026-11-01 10:00 UTC',
  takenAt: '2026-11-01T10:00:00.000Z',
  expiresAt: '2026-11-08T10:00:00.000Z',
  objects: ['Account'],
  records: 12,
  bytes: 120_000,
  requests: 8,
  added: [],
  notHeld: [],
};

const AS_STEP: Readonly<Record<string, WritePathStep>> = {
  question: 'question',
  checkpointTake: 'checkpointTake',
  'assignment insert': 'leaseAcquire',
  write: 'write',
  'assignment delete': 'leaseRelease',
  recordTypeReadBack: 'recordTypeReadBack',
};

describe('frozen:load, its write path through the real loader', () => {
  let deps: HandlerDeps;
  let handler: FrozenDatasetHandler;
  let store: ConfigStore;
  let calls: string[];
  let requestConfirmation: Mock<() => Promise<boolean>>;
  const dirs: string[] = [];

  function tempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(dir);
    return dir;
  }

  /** A dataset of one account on Master, and one on a type the user may not have yet. */
  function writeDataset(): FrozenProjectConfig {
    const sasDir = tempDir('sandforge-frozen-writepath-');
    const datasetDir = path.join(sasDir, 'dataset');
    fs.mkdirSync(path.join(datasetDir, 'data'), { recursive: true });
    const manifest = buildFrozenManifest({
      version: '1.2.0',
      source: { orgId: '00D000000000002AAA', decisionDate: '2026-09-01' },
      saltFingerprint: 'abcdef012345',
      rulesVersion: '1.0.0',
      volumetry: { budgetMax: 100, measured: {}, measuredAt: '2026-09-01T00:00:00.000Z' },
      nonReidentification: {
        passed: true,
        checks: [],
        author: 'qa',
        checkedAt: '2026-09-01T00:00:00.000Z',
      },
      author: 'qa',
    });
    fs.writeFileSync(path.join(datasetDir, 'manifest.json'), JSON.stringify(manifest));
    fs.writeFileSync(
      path.join(datasetDir, 'data', 'Account.json'),
      JSON.stringify({
        objectApiName: 'Account',
        records: [
          { referenceId: 'A1', fields: { Name: 'A1', RecordTypeId: null } },
          { referenceId: 'A2', fields: { Name: 'A2', RecordTypeId: 'Hidden' } },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(datasetDir, 'record-types.json'),
      JSON.stringify({ Account: [{ developerName: 'SFX_Hidden', name: 'Hidden' }] }),
    );
    return { rootObject: 'Account', axes: [], edgeCases: [], budgetMaxRecords: 2500, sasDir };
  }

  /** A guard that asks about every write, as one a host injects may. */
  function askingGuard(): ProductionGuard {
    const guard = new ProductionGuard({ requestConfirmation });
    const check = guard.check.bind(guard);
    vi.spyOn(guard, 'check').mockImplementation((request) => ({
      ...check(request),
      requiresConfirmation: true,
    }));
    return guard;
  }

  /**
   * The target: the lease's own reads and writes in memory, and what the load
   * reads, as the org answers it. `SFX_Hidden` opens to the user once the
   * bypass set is assigned; a record sent without a type goes in as Retail.
   */
  function target() {
    const org = memoryPermissionOrg({
      sets: [{ id: SET, name: 'Data_Load' }],
      beforeWrite: (write) => {
        calls.push(`assignment ${write.kind}`);
      },
    });
    const leaseQuery = org.connection.query as unknown as (soql: string) => Promise<unknown>;
    const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
    const connection = {
      ...org.connection,
      query: vi.fn(async (soql: string) => {
        if (/ FROM RecordType\b/.test(soql)) {
          return page([{ Id: HIDDEN_ID, DeveloperName: 'SFX_Hidden', NamespacePrefix: null }]);
        }
        if (/^SELECT RecordTypeId, COUNT\(Id\) n FROM Account/.test(soql)) {
          calls.push('recordTypeReadBack');
          return page([{ RecordTypeId: RETAIL_ID, n: 1 }]);
        }
        if (/ FROM Account\b/.test(soql)) return page([]);
        return leaseQuery(soql);
      }),
      describe: vi.fn(async (name: string) => {
        calls.push(`describe ${name}`);
        return {
          name,
          createable: true,
          fields: [
            { name: 'Name', type: 'string', createable: true, nillable: false },
            { name: 'RecordTypeId', type: 'reference', createable: true, nillable: true },
          ],
          recordTypeInfos: [
            {
              developerName: 'SFX_Hidden',
              name: 'Hidden',
              recordTypeId: HIDDEN_ID,
              available: org.assignments().length > 0,
              active: true,
              master: false,
              defaultRecordTypeMapping: false,
            },
            {
              developerName: 'SFX_Retail',
              name: 'Retail',
              recordTypeId: RETAIL_ID,
              available: true,
              active: true,
              master: false,
              defaultRecordTypeMapping: false,
            },
            {
              developerName: 'Master',
              name: 'Master',
              recordTypeId: MASTER_ID,
              available: true,
              active: true,
              master: true,
              defaultRecordTypeMapping: true,
            },
          ],
        };
      }),
      soap: {
        getUserInfo: vi.fn(async () => ({ userId: org.userId })),
        getServerTimestamp: vi.fn(async () => ({ timestamp: new Date().toISOString() })),
      },
    };
    vi.mocked(getJsforceConnection).mockResolvedValue(connection as never);
    return { org, connection };
  }

  function checkpoints() {
    const port = {
      scope: vi.fn(async () => {
        calls.push('checkpointScope');
        return ESTIMATE;
      }),
      take: vi.fn(async () => {
        calls.push('checkpointTake');
        return { taken: true as const, checkpoint: TAKEN };
      }),
      settle: vi.fn(async (taken: RunCheckpointTaken) => taken),
    } satisfies BeforeRunCheckpoints;
    handler.setBeforeRunCheckpoints(port);
    return port;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    calls = [];
    requestConfirmation = vi.fn(async () => {
      calls.push('question');
      return true;
    });
    store = new ConfigStore(new InMemoryConfigStoreBackend());
    store.initialize();
    store.set('frozen:config', writeDataset(), 'frozen');
    let n = 0;
    deps = {
      log: vi.fn(),
      broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
      stateSync: {} as HandlerDeps['stateSync'],
      orgManager: {
        getOrg: vi.fn(() => ({ orgType: 'Sandbox', alias: 'DEV' })),
      } as unknown as HandlerDeps['orgManager'],
      orgRegistry: {} as HandlerDeps['orgRegistry'],
      configStore: store,
      secretVault: {} as HandlerDeps['secretVault'],
      authProvider: {} as HandlerDeps['authProvider'],
      sfdxBridge: {} as HandlerDeps['sfdxBridge'],
      infraServices: { productionGuard: askingGuard() } as unknown as NonNullable<
        HandlerDeps['infraServices']
      >,
      nextId: () => String(++n),
    };
    handler = new FrozenDatasetHandler(deps);
    handler.setTargetAutomation({ read: vi.fn(async () => ACCOUNT_FLOW) });
    handler.setMuteLeases({ dir: tempDir('frozen-leases-'), renewEveryMs: 0 });
    let created = 0;
    written.insert.mockImplementation(async (_org: string, _object: string, rows: unknown[]) => {
      calls.push('write');
      return rows.map(() => ({
        id: `001C10${String(++created).padStart(9, '0')}AAA`,
        success: true,
        errors: [],
      }));
    });
  });

  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function load(payload: Record<string, unknown>): Promise<boolean> {
    return handler.handle(
      inboundRequest({
        id: 'wv-load-1',
        type: 'frozen:load',
        timestamp: Date.now(),
        payload: { targetOrgId: 'org-2', ...payload },
      } as BaseMessage) as InboundRequest,
    );
  }

  function posted(type: string): Array<BaseMessage & { payload: Record<string, unknown> }> {
    return vi
      .mocked(deps.broker.postToWebview)
      .mock.calls.map(([m]) => m as BaseMessage & { payload: Record<string, unknown> })
      .filter((m) => m.type === type);
  }

  const report = () =>
    posted('frozen:load:response')[0]?.payload.report as FrozenLoadReportInfo | undefined;
  const trail = () =>
    new AuditTrailStore(store).list().entries.filter((e) => e.action === 'frozen_load');

  it('asks, takes, leases, writes, gives the lease back, then reads the record types', async () => {
    checkpoints();
    target();

    await load({ muteAutomation: true, checkpointFirst: {} });

    const steps = calls.flatMap((call) => (AS_STEP[call] ? [AS_STEP[call]] : []));
    expect(steps).toEqual([
      'question',
      'checkpointTake',
      'leaseAcquire',
      'write',
      'leaseRelease',
      'recordTypeReadBack',
    ]);
    expect(
      writePathOrderDefects(['reads', 'leasePlan', 'stillRunning', ...steps, 'result']),
    ).toEqual([]);
    expect(report()).toMatchObject({
      status: 'completed',
      checkpoint: TAKEN,
      mutedAutomation: { released: true },
    });
  });

  it('puts one question, whatever the batches: the answer stands for each of them', async () => {
    target();
    written.insert.mockClear();

    await load({ muteAutomation: true });

    expect(written.insert.mock.calls.length).toBeGreaterThan(0);
    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(trail()[0]).toMatchObject({ outcome: 'success', guard: 'confirmed' });
  });

  it('reads the record types after the lease assigned its set, and goes by what it opened', async () => {
    target();

    await load({ muteAutomation: true });

    // The describes of the load, every one past the assignment.
    expect(calls.filter((call) => call.startsWith('describe')).length).toBeGreaterThan(0);
    expect(calls.indexOf('assignment insert')).toBeLessThan(calls.indexOf('describe Account'));
    expect(calls.indexOf('describe Account')).toBeLessThan(calls.indexOf('write'));
    // The set opened SFX_Hidden: the record that names it keeps it, and two
    // types open under a Master default, the record on Master gets no other.
    const [, , rows] = written.insert.mock.calls[0] as [
      string,
      string,
      Array<Record<string, unknown>>,
    ];
    expect(rows.map((row) => row.RecordTypeId)).toEqual([undefined, HIDDEN_ID]);
    expect(report()?.alignment.recordTypeIssues).toEqual([]);
    expect(report()?.recordTypesGiven).toEqual([
      expect.objectContaining({ rows: 1, why: { masterInSource: 1 } }),
    ]);
    expect(report()?.recordTypesGiven?.[0]).not.toHaveProperty('predicted');
  });

  it('leaves what it has not been opened out of a load that assigns nothing', async () => {
    target();

    await load({});

    const [, , rows] = written.insert.mock.calls[0] as [
      string,
      string,
      Array<Record<string, unknown>>,
    ];
    expect(rows.map((row) => row.RecordTypeId)).toEqual([undefined, undefined]);
    expect(report()?.alignment.recordTypeIssues[0]?.detail).toContain(
      'the target gives it SFX_Retail, the only other record type open to the user',
    );
    expect(report()?.recordTypesGiven?.[0]).toMatchObject({
      rows: 2,
      why: { masterInSource: 1, dropped: 1 },
      predicted: { developerName: 'SFX_Retail', basis: 'onlyOneOpen' },
    });
  });

  it('says in its preview what the target would give, from the describe, nothing assigned', async () => {
    const { org } = target();

    await handler.handle(
      inboundRequest({
        id: 'wv-preview-1',
        type: 'frozen:load:preview',
        timestamp: Date.now(),
        payload: { targetOrgId: 'org-2' },
      } as BaseMessage) as InboundRequest,
    );

    expect(posted('frozen:load:preview:response')[0]?.payload.plan).toMatchObject({
      recordTypesGiven: [
        {
          objectApiName: 'Account',
          rows: 2,
          why: { masterInSource: 1, dropped: 1 },
          predicted: { developerName: 'SFX_Retail', basis: 'onlyOneOpen' },
        },
      ],
    });
    expect(org.writes).toEqual([]);
    expect(calls).not.toContain('recordTypeReadBack');
  });

  it('takes nothing for a load its question was declined for', async () => {
    const port = checkpoints();
    const { org } = target();
    requestConfirmation.mockResolvedValue(false);

    await load({ muteAutomation: true, checkpointFirst: {} });

    expect(port.scope).not.toHaveBeenCalled();
    expect(port.take).not.toHaveBeenCalled();
    expect(org.writes).toEqual([]);
    expect(written.insert).not.toHaveBeenCalled();
    expect(posted('frozen:load:error')[0]?.payload).toMatchObject({ code: 'GUARD_REFUSED' });
    expect(trail()[0]).toMatchObject({ outcome: 'stopped', guard: 'declined' });
  });

  it('takes nothing for a load the entry guards refuse, into a sandbox marked Staging', async () => {
    // Refused by the load itself, it had its checkpoint taken of the tables
    // it would have written and the bypass assigned, to write nothing.
    vi.mocked(deps.orgManager.getOrg).mockReturnValue({
      orgType: 'Sandbox',
      alias: 'UAT',
      staging: true,
    } as never);
    const port = checkpoints();
    const { org } = target();

    await load({ muteAutomation: true, checkpointFirst: {} });

    expect(port.scope).not.toHaveBeenCalled();
    expect(port.take).not.toHaveBeenCalled();
    expect(org.writes).toEqual([]);
    expect(requestConfirmation).not.toHaveBeenCalled();
    expect(posted('frozen:load:error')[0]?.payload).toMatchObject({ code: 'GUARD_REFUSED' });
    const lines = posted('frozen:load:progress').map((line) => line.payload.status);
    expect(lines).toContain('error');
  });
});
