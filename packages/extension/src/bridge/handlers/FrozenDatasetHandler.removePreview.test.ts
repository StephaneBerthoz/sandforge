import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BaseMessage, FrozenProjectConfig, FrozenRemovalPreview } from '@sandforge/shared';

import { FrozenDatasetHandler } from './FrozenDatasetHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';
import { BackgroundOperationRegistry } from '../../core/engine/BackgroundOperationRegistry.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import { SasReferenceIdMappingStore } from '../../modules/frozendataset/SasReferenceIdMappingStore.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';

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

/** A fake record id: the object's prefix, then a counter. */
const id = (prefix: string, n: number): string => `${prefix}${String(n).padStart(12, '0')}AAA`;

const TARGET_ORG = 'org-dev';
const ORGANIZATION = '00DXX00000AbCdE2A1';
const LOAD_STARTED = '2026-09-20T10:00:00.000Z';
const LOAD_ENDED = '2026-09-20T10:05:00.000Z';
const DURING_LOAD = '2026-09-20T10:02:00.000+0000';
const AFTER_LOAD = '2026-09-20T11:00:00.000+0000';
const USER = id('005', 1);
const TESTER = id('005', 2);

const ACCOUNT = id('001', 1);
const CONTACTS = [id('003', 1), id('003', 2)];
const STANDARD_BOOK = id('01s', 1);

type Row = Record<string, unknown> & { Id: string };

/**
 * The target as jsforce shows it: the account and two contacts the load
 * created, the book it matched; every write it is sent is kept, for a test
 * to find none.
 */
function targetOrg() {
  const rows = new Map<string, Row[]>([
    ['Account', [{ Id: ACCOUNT, CreatedDate: DURING_LOAD, LastModifiedDate: DURING_LOAD }]],
    [
      'Contact',
      CONTACTS.map((contact) => ({
        Id: contact,
        AccountId: ACCOUNT,
        CreatedDate: DURING_LOAD,
        LastModifiedDate: DURING_LOAD,
        LastModifiedById: USER,
      })),
    ],
    ['User', [{ Id: TESTER, Name: 'A Tester' }]],
  ]);
  const writes: Array<{ call: string; object: string }> = [];
  const write =
    (call: string, object: string) =>
    async (records: unknown[]): Promise<unknown[]> => {
      writes.push({ call, object });
      return records.map(() => ({ success: true, errors: [] }));
    };
  const conn = {
    limitInfo: undefined,
    query: vi.fn(async (soql: string) => {
      if (soql === 'SELECT Id FROM Organization') {
        return { totalSize: 1, done: true, records: [{ Id: ORGANIZATION }] };
      }
      const match = /^SELECT (.+) FROM (\w+) WHERE (\w+) IN \((.*)\)(?: LIMIT \d+)?$/.exec(soql);
      if (!match) throw new Error(`unexpected query: ${soql}`);
      const [, columns, object, field, list] = match;
      const wanted = new Set(list.split(', ').map((q) => q.slice(1, -1)));
      const records = (rows.get(object) ?? [])
        .filter((row) => wanted.has(String(row[field])))
        .map((row) => Object.fromEntries(columns.split(', ').map((c) => [c, row[c]])));
      return { totalSize: records.length, done: true, records };
    }),
    describe: vi.fn(async (object: string) => ({
      name: object,
      label: object,
      deletable: true,
      fields: [],
      childRelationships:
        object === 'Account'
          ? [{ childSObject: 'Contact', field: 'AccountId', cascadeDelete: true }]
          : [],
    })),
    describeGlobal: vi.fn(async () => ({
      sobjects: [...rows.keys()].map((name) => ({ name, queryable: true, deletable: true })),
    })),
    soap: {
      getServerTimestamp: vi.fn(async () => ({ timestamp: new Date().toISOString() })),
      getUserInfo: vi.fn(async () => ({ userId: USER })),
    },
    sobject: (object: string) => ({
      destroy: vi.fn(write('destroy', object)),
      update: vi.fn(write('update', object)),
      create: vi.fn(write('create', object)),
      insert: vi.fn(write('insert', object)),
    }),
    bulk2: {
      createJob: vi.fn(() => {
        writes.push({ call: 'bulk', object: '?' });
        throw new Error('a preview opened a Bulk API job');
      }),
    },
  };
  return { conn, rows, writes };
}

function buildMsg(type: string, payload?: unknown): InboundRequest {
  return inboundRequest({
    id: `req-${type}`,
    type,
    timestamp: Date.now(),
    ...(payload !== undefined ? { payload } : {}),
  } as BaseMessage);
}

let sasDir: string;
let deps: HandlerDeps;
let store: ConfigStore;
let handler: FrozenDatasetHandler;
let registry: BackgroundOperationRegistry;
let org: ReturnType<typeof targetOrg>;

/** Messages posted to the webview, of one type. */
const posted = <T extends BaseMessage>(type: string): T[] =>
  vi
    .mocked(deps.broker.postToWebview)
    .mock.calls.map(([m]) => m as T)
    .filter((m) => m.type === type);
const errorsOn = (type: string) =>
  posted<BaseMessage & { payload: { code: string; message: string } }>(type).map((m) => m.payload);
const preview = (): FrozenRemovalPreview | undefined =>
  posted<BaseMessage & { payload: { preview: FrozenRemovalPreview } }>(
    'frozen:remove:preview:response',
  )[0]?.payload.preview;
const askPreview = (payload: Record<string, unknown> = {}) =>
  handler.handle(
    buildMsg('frozen:remove:preview', {
      targetOrgId: TARGET_ORG,
      loadedAt: LOAD_ENDED,
      ...payload,
    }),
  );
/** Every file of the sas, by name, with what it holds. */
const sasFiles = () =>
  fs
    .readdirSync(sasDir)
    .sort()
    .map((name) => [name, fs.readFileSync(path.join(sasDir, name), 'utf8')]);

/** The mapping the load wrote: what it created, and the standard book it matched. */
async function loaded(): Promise<void> {
  await new SasReferenceIdMappingStore(sasDir, {
    orgId: TARGET_ORG,
    organizationId: ORGANIZATION,
    now: () => new Date(LOAD_ENDED),
  }).persist(
    new Map([
      ['Pricebook2-000001', STANDARD_BOOK],
      ['Account-000001', ACCOUNT],
      ['Contact-000001', CONTACTS[0]],
      ['Contact-000002', CONTACTS[1]],
    ]),
    {
      created: [
        { objectApiName: 'Account', referenceIds: ['Account-000001'] },
        { objectApiName: 'Contact', referenceIds: ['Contact-000001', 'Contact-000002'] },
      ],
      startedAt: new Date(LOAD_STARTED),
      writtenBetween: { first: '2026-09-20T10:01:00.000Z', last: '2026-09-20T10:04:00.000Z' },
    },
  );
}

/** Make the first contact one a tester changed since the load. */
function changedSinceTheLoad(): void {
  const contact = (org.rows.get('Contact') ?? [])[0];
  contact.LastModifiedDate = AFTER_LOAD;
  contact.LastModifiedById = TESTER;
}

beforeEach(async () => {
  vi.clearAllMocks();
  sasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sandforge-frozen-remove-preview-'));
  const config: FrozenProjectConfig = {
    rootObject: 'Account',
    axes: [],
    edgeCases: [],
    sasDir,
    datasetDir: path.join(sasDir, 'no-dataset-here'),
  };
  store = new ConfigStore(new InMemoryConfigStoreBackend());
  store.initialize();
  store.set('frozen:config', config, 'frozen');
  registry = new BackgroundOperationRegistry();
  let n = 0;
  deps = {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: {
      getOrg: vi.fn().mockReturnValue({ orgType: 'Sandbox', alias: 'DEV' }),
    } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as HandlerDeps['orgRegistry'],
    configStore: store,
    secretVault: {} as HandlerDeps['secretVault'],
    authProvider: {} as HandlerDeps['authProvider'],
    sfdxBridge: {} as HandlerDeps['sfdxBridge'],
    infraServices: {
      productionGuard: new ProductionGuard(),
    } as unknown as HandlerDeps['infraServices'],
    nextId: () => String(++n),
  };
  handler = new FrozenDatasetHandler(deps);
  handler.setRegistry(registry);
  org = targetOrg();
  mockGetConn.mockResolvedValue(org.conn as never);
  await loaded();
});

afterEach(() => {
  fs.rmSync(sasDir, { recursive: true, force: true });
});

describe('frozen:remove:preview', () => {
  it('says per object what a removal of the load would delete, and writes nothing: to the org, the sas or the audit trail', async () => {
    const before = sasFiles();

    await askPreview();

    expect(errorsOn('frozen:remove:preview:error')).toEqual([]);
    expect(preview()).toMatchObject({
      loadedAt: LOAD_ENDED,
      includeChanged: false,
      planned: 3,
      refusals: [],
      objects: [
        { objectApiName: 'Contact', planned: 2, toDelete: 2, keptChanged: 0 },
        { objectApiName: 'Account', planned: 1, toDelete: 1, keptChanged: 0 },
      ],
    });
    expect(org.writes).toEqual([]);
    expect(sasFiles()).toEqual(before);
    expect(new AuditTrailStore(store).list().entries).toEqual([]);
    // No run: nothing listed, nothing to cancel.
    expect(registry.getRunning()).toEqual([]);
    expect(posted('operation:started')).toEqual([]);
  });

  it('counts a record changed since the load as kept, with who changed it, and as one to delete once told to include it', async () => {
    changedSinceTheLoad();

    await askPreview();
    const kept = preview();
    vi.mocked(deps.broker.postToWebview).mockClear();
    await askPreview({ includeChanged: true });
    const included = preview();

    expect(kept?.objects[0]).toMatchObject({
      objectApiName: 'Contact',
      toDelete: 1,
      changedSince: 1,
      keptChanged: 1,
      changedBy: { [TESTER]: 1 },
    });
    expect(included?.objects[0]).toMatchObject({ toDelete: 2, changedSince: 1, keptChanged: 0 });
    expect(org.writes).toEqual([]);
  });

  it('is refused as the removal is, before the org is read: no load recorded, or another load since', async () => {
    await askPreview({ loadedAt: '2026-09-19T08:00:00.000Z' });
    expect(errorsOn('frozen:remove:preview:error').map((e) => e.code)).toEqual(['LOAD_CHANGED']);

    vi.mocked(deps.broker.postToWebview).mockClear();
    await askPreview({ targetOrgId: 'org-nothing-loaded' });
    expect(errorsOn('frozen:remove:preview:error').map((e) => e.code)).toEqual(['NO_LOAD']);

    expect(mockGetConn).not.toHaveBeenCalled();
  });

  it('says a production org would be refused, asking nothing and deleting nothing', async () => {
    vi.mocked(deps.orgManager.getOrg).mockReturnValue({
      orgType: 'Production',
      alias: 'PROD',
    } as never);
    const confirm = vi.spyOn(ProductionGuard.prototype, 'confirmIfNeeded');

    await askPreview();

    expect(preview()?.refusals).toEqual([
      expect.stringContaining('Operation blocked by Production Guard'),
    ]);
    expect(confirm).not.toHaveBeenCalled();
    expect(org.writes).toEqual([]);
  });
});

describe('a reload, which replaces the loads before it', () => {
  const load = (payload: Record<string, unknown>) =>
    handler.handle(buildMsg('frozen:load', { targetOrgId: TARGET_ORG, ...payload }));

  it("is refused, the panel's as it sends it, before anything is written while the removal of the load before would keep a record changed since", async () => {
    changedSinceTheLoad();
    const before = sasFiles();

    // What the Load tab sends with Reload ticked: its purge deleted the
    // record changed since without a word.
    await load({ reload: true });

    const [refusal] = errorsOn('frozen:load:error');
    expect(refusal.code).toBe('REPLACE_LEAVES_RECORDS');
    expect(refusal.message).toContain(
      'A removal of the loads this reload replaces would leave 1 of their records in the org — ' +
        'Contact (1: 1 changed since the load)',
    );
    expect(refusal.message).toContain('Nothing was written.');
    expect(org.writes).toEqual([]);
    expect(sasFiles()).toEqual(before);
    expect(new AuditTrailStore(store).list().entries).toEqual([
      expect.objectContaining({
        action: 'frozen_load',
        outcome: 'stopped',
        objects: [],
        details: { code: 'REPLACE_LEAVES_RECORDS' },
      }),
    ]);
  });

  it('is refused the same way when previewed', async () => {
    changedSinceTheLoad();

    await handler.handle(
      buildMsg('frozen:load:preview', { targetOrgId: TARGET_ORG, reload: true }),
    );

    expect(errorsOn('frozen:load:preview:error').map((e) => e.code)).toEqual([
      'REPLACE_LEAVES_RECORDS',
    ]);
    expect(org.writes).toEqual([]);
  });

  it('goes on to the load when the removal would take every record of the loads before', async () => {
    await load({ reload: true });

    // Past the gate, the load reads its dataset, which this sas has none of.
    const [error] = errorsOn('frozen:load:error');
    expect(error.code).not.toBe('REPLACE_LEAVES_RECORDS');
    expect(error.message).toContain('No frozen dataset found');
  });

  it('is not asked of a load that is no reload, nor of a pilot, which purges nothing', async () => {
    changedSinceTheLoad();

    await load({});
    await load({ reload: true, pilot: true });

    expect(errorsOn('frozen:load:error').map((e) => e.message)).toEqual([
      expect.stringContaining('No frozen dataset found'),
      expect.stringContaining('No frozen dataset found'),
    ]);
  });
});
