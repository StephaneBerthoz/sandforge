import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_ROBUSTNESS_CONFIG,
  type BaseMessage,
  type CheckpointReplayChoices,
  type CheckpointReplayLink,
  type ForgeTargetAutomation,
  type FrozenLoadReportInfo,
  type FrozenReplayInfo,
  type FrozenLoadPlanInfo,
} from '@sandforge/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getJsforceConnection } from '../../core/connection/ConnectionHelper.js';
import { ProductionGuard } from '../../core/precheck/ProductionGuard.js';
import { ConfigStore } from '../../core/storage/ConfigStore.js';
import { AuditTrailStore } from '../../modules/audit/auditTrail.js';
import {
  openCheckpointStore,
  type OrgCheckpointStore,
} from '../../modules/checkpoint/OrgCheckpointStore.js';
import { ReplayStore } from '../../modules/checkpoint/replay/replayStore.js';
import { loadRequestsEstimate } from '../../modules/frozendataset/loadRequests.js';
import { InMemoryConfigStoreBackend } from '../../test/InMemoryConfigStoreBackend.js';
import { inboundRequest } from '../../test/mockFactories.js';
import {
  CHECKPOINT_ID,
  REPLAYING_USER,
  ReplayTargetOrg,
  SOURCE_ORG_ID,
  TARGET_ORG_ID,
  fabricateCheckpoint,
  idOf,
  type FabricatedObject,
  type ReplayTargetOptions,
} from '../../test/replayOrgs.js';
import { orgError } from '../../test/memoryRemovalOrg.js';
import { MOST_WIRE_CHARS, wireLength } from '../../test/sampleSourceOrg.js';
import type {
  BeforeRunAsk,
  BeforeRunCheckpoints,
} from '../../modules/checkpoint/beforeRunCheckpoint.js';
import { FrozenDatasetHandler } from './FrozenDatasetHandler.js';
import type { HandlerDeps, InboundRequest } from './HandlerTypes.js';

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../core/connection/ConnectionHelper.js', () => ({
  getJsforceConnection: vi.fn(),
}));

/** The other org a replay writes to, through the writer the handler builds. */
const writes = vi.hoisted(() => ({ target: undefined as ReplayTargetOrg | undefined }));
vi.mock('../../modules/frozendataset/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../modules/frozendataset/index.js')>();
  return {
    ...actual,
    createBulkDmlWriter: () => {
      if (!writes.target) throw new Error('No target to write to');
      return writes.target.writer();
    },
  };
});

/*
 * A checkpoint replayed into another org through the real Frozen handler and
 * the real loader: the checkpoint as a take leaves it, the other org reading
 * and refusing as an org does (`replayOrgs.ts`), the replay's files in a
 * folder of the test's own. The org is registered in this window under an id
 * of its own, as the panel registers one; the command line registers it by
 * its Organization Id.
 */

/** The id the window registers the other org under. */
const REGISTERED = 'org-target-window';

/** The user who owned the checkpoint's records, whom the other org does not hold. */
const OWNER = idOf('005', 7);

const CHOICES: CheckpointReplayChoices = {
  owners: 'same',
  customSettings: false,
  mask: false,
  contactPoints: 'neutralized',
  objects: [],
  excluded: [],
  link: [],
};

/** What the other org runs as records are written: nothing. */
const NOTHING_RUNS: ForgeTargetAutomation = {
  objectsRead: ['Account', 'Contact'],
  objects: [],
  bypassGrants: [],
  unread: [],
  conditionsNotRead: 0,
  conditionsBound: 25,
  requests: 1,
};

/** What the other org has left today: a scratch org's storage, and requests to spare. */
const LIMITS = {
  DataStorageMB: { Max: 200, Remaining: 180 },
  DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
  DailyBulkApiBatches: { Max: 15_000, Remaining: 15_000 },
};

const dirs: string[] = [];

interface World {
  dir: string;
  store: OrgCheckpointStore;
  replays: ReplayStore;
  target: ReplayTargetOrg;
  configStore: ConfigStore;
  handler: FrozenDatasetHandler;
  deps: HandlerDeps;
  /** Every statement the other org was sent, in order. */
  asked: string[];
  /** Every object the other org was asked to describe, in order. */
  described: string[];
}

/** Two accounts and two contacts under each, owned by a user of the checkpoint's org. */
function accountsAndContacts() {
  const accounts = [1, 2].map((n) => ({
    Id: idOf('001', n),
    Name: `SFENV replay ${n}`,
    Phone: '+1 555 0100',
    OwnerId: OWNER,
  }));
  const contacts = [1, 2, 3, 4].map((n) => ({
    Id: idOf('003', n),
    LastName: `SFENV replay ${n}`,
    Email: `person.${n}@example.com`,
    AccountId: accounts[n <= 2 ? 0 : 1].Id,
    OwnerId: OWNER,
  }));
  return [
    { objectApiName: 'Account', rows: accounts },
    { objectApiName: 'Contact', rows: contacts },
    // A file, whose content a checkpoint does not keep.
    { objectApiName: 'ContentDocument', rows: [{ Id: idOf('069', 1), Title: 'Signed contract' }] },
  ];
}

/**
 * The other org as jsforce shows it: its records, reads and deletes through
 * the memory org, its describes as the replay's fixture gives them, what it
 * has left today, and the user the session writes as.
 */
function connectionOf(world: Pick<World, 'target' | 'asked' | 'described'>) {
  const { target } = world;
  const org = target.org;
  return {
    get version() {
      return org.version;
    },
    request: async (request: { method: string; url: string }) =>
      /\/limits\/?$/.test(request.url) ? LIMITS : org.request(request),
    query: async (soql: string, options?: { scanAll?: boolean }) => {
      world.asked.push(soql);
      // jsforce sends the statement in the URL, and the org refuses one past
      // what it holds, with the code jsforce builds from the status.
      if (wireLength(soql) > MOST_WIRE_CHARS) {
        throw orgError('ERROR_HTTP_431', 'Request Header Fields Too Large');
      }
      return org.query(soql, options);
    },
    queryMore: (url: string) => org.queryMore(url),
    describe: async (objectApiName: string) => {
      world.described.push(objectApiName);
      // As an org describes them: each field with its label.
      const own = target.describeOf(objectApiName);
      return {
        ...((await org.describe(objectApiName)) as Record<string, unknown>),
        ...own,
        label: objectApiName,
        fields: own.fields.map((field) => ({ label: field.name, ...field })),
      };
    },
    describeGlobal: () => org.describeGlobal(),
    tooling: {
      query: async () => ({ totalSize: 0, done: true, records: [] }),
      queryMore: async () => ({ totalSize: 0, done: true, records: [] }),
      describeGlobal: async () => ({ sobjects: [] }),
    },
    sobject: (objectApiName: string) => ({
      create: (records: Array<Record<string, unknown>>) => org.create(objectApiName, records),
      update: (records: Array<Record<string, unknown>>) => org.update(objectApiName, records),
      destroy: (ids: string[]) => org.destroy(objectApiName, ids),
    }),
    soap: {
      getServerTimestamp: async () => ({ timestamp: await org.serverTime() }),
      getUserInfo: async () => ({ userId: target.runningUserId }),
      undelete: (ids: string[]) => org.undelete(ids),
    },
  };
}

/** A handler, the checkpoint and the other org, each in the test's own folder. */
async function worldOf(
  options: {
    target?: ReplayTargetOptions;
    /** The id the window registers the other org under: {@link REGISTERED} unless told. */
    registeredAs?: string;
    orgType?: string;
    staging?: boolean;
    /** A checkpoint SandForge 1.80 took of a sandbox: no annex, no data storage. */
    before181?: boolean;
    /** The checkpoint's records: {@link accountsAndContacts} unless given. */
    objects?: FabricatedObject[];
  } = {},
): Promise<World> {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-frozen-replay-'));
  dirs.push(dir);
  const opened = openCheckpointStore({
    root: join(dir, 'checkpoints'),
    locksDir: join(dir, 'locks'),
  });
  if (!('store' in opened)) throw new Error(`The store cannot be opened: ${opened.refusal.reason}`);
  await fabricateCheckpoint(opened.store, {
    objects: options.objects ?? accountsAndContacts(),
    ...(options.before181 ? { org: { dataStorageMaxMB: undefined } } : {}),
    annex: options.before181
      ? undefined
      : {
          recordTypes: [],
          users: [
            {
              id: OWNER,
              username: 'ada@example.com.dev1',
              name: 'Ada Admin',
              isActive: true,
              userType: 'Standard',
            },
          ],
          queues: [],
        },
  });
  const configStore = new ConfigStore(new InMemoryConfigStoreBackend());
  configStore.initialize();
  const target = new ReplayTargetOrg(options.target);
  writes.target = target;
  const world: World = {
    dir,
    store: opened.store,
    replays: new ReplayStore({ root: join(dir, 'replays') }),
    target,
    configStore,
    asked: [],
    described: [],
  } as unknown as World;
  vi.mocked(getJsforceConnection).mockImplementation(async () => connectionOf(world) as never);
  let n = 0;
  const deps: HandlerDeps = {
    log: vi.fn(),
    broker: { postToWebview: vi.fn() } as unknown as HandlerDeps['broker'],
    stateSync: {} as HandlerDeps['stateSync'],
    orgManager: {
      getOrg: vi.fn(() => ({
        id: options.registeredAs ?? REGISTERED,
        orgType: options.orgType ?? 'Scratch',
        ...(options.staging ? { staging: true } : {}),
        alias: 'TARGET',
        username: 'replayer@example.com.uat',
        orgId: target.organizationId,
        instanceUrl: 'https://example-target.scratch.my.salesforce.com',
      })),
      getAllOrgs: vi.fn(() => []),
    } as unknown as HandlerDeps['orgManager'],
    orgRegistry: {} as HandlerDeps['orgRegistry'],
    configStore,
    secretVault: {} as HandlerDeps['secretVault'],
    authProvider: {} as HandlerDeps['authProvider'],
    sfdxBridge: {} as HandlerDeps['sfdxBridge'],
    infraServices: { productionGuard: new ProductionGuard() } as unknown as NonNullable<
      HandlerDeps['infraServices']
    >,
    nextId: () => String(++n),
  };
  const handler = new FrozenDatasetHandler(deps);
  handler.setTargetAutomation({ read: vi.fn(async () => NOTHING_RUNS) });
  handler.setReplayStores({ checkpoints: () => [world.store], replays: world.replays });
  world.handler = handler;
  world.deps = deps;
  return world;
}

type Posted = BaseMessage & { payload: Record<string, unknown> };

/** Send a request to the handler, and the messages it answered with, by type. */
async function send(
  world: World,
  type: string,
  payload: Record<string, unknown>,
  registeredAs = REGISTERED,
): Promise<(of: string) => Posted[]> {
  const id = `wv-${type}-${Math.random().toString(36).slice(2, 8)}`;
  await world.handler.handle(
    inboundRequest({
      id,
      type,
      timestamp: Date.now(),
      payload: { targetOrgId: registeredAs, ...payload },
    } as BaseMessage) as InboundRequest,
  );
  const posted = vi
    .mocked(world.deps.broker.postToWebview)
    .mock.calls.map(([message]) => message as Posted)
    .filter((message) => (message as Posted & { correlationId?: string }).correlationId === id);
  return (of) => posted.filter((message) => message.type === of);
}

/** The replay of the checkpoint, as a request names it. */
const replayOf = (
  choices: Partial<CheckpointReplayChoices> = {},
): { organizationId: string; checkpointId: string; choices: CheckpointReplayChoices } => ({
  organizationId: SOURCE_ORG_ID,
  checkpointId: CHECKPOINT_ID,
  choices: { ...CHOICES, ...choices },
});

/** The replay's entries in the audit trail. */
function trail(world: World, action = 'checkpoint_replay') {
  return new AuditTrailStore(world.configStore).list().entries.filter((e) => e.action === action);
}

/** The files of the replays of the checkpoint, by name. */
function replayFiles(world: World): string[] {
  const folder = world.replays.folderOf(SOURCE_ORG_ID, CHECKPOINT_ID);
  return existsSync(folder.dir) ? readdirSync(folder.dir).sort() : [];
}

/** The account and contact rows the other org holds. */
function held(world: World): { accounts: number; contacts: number } {
  return {
    accounts: world.target.org.all('Account').length,
    contacts: world.target.org.all('Contact').length,
  };
}

/** When the replay's last load wrote its last record, as its mapping keeps it. */
async function loadedAtOf(world: World): Promise<string> {
  const folder = world.replays.folderOf(SOURCE_ORG_ID, CHECKPOINT_ID);
  const [load] = await world.replays.mappingStoreOf(folder, TARGET_ORG_ID).recordedLoads();
  if (!load) throw new Error('No replay recorded');
  return load.endedAt;
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  writes.target = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('frozen:load:preview of a checkpoint replayed', () => {
  it('writes nothing, and says what the replay would create, give the user who replays, and take of the storage', async () => {
    const world = await worldOf();

    const answers = await send(world, 'frozen:load:preview', { replay: replayOf() });

    expect(answers('frozen:load:preview:error').map((error) => error.payload.message)).toEqual([]);
    const [response] = answers('frozen:load:preview:response');
    const plan = response.payload.plan as FrozenLoadPlanInfo;
    const replay = response.payload.replay as FrozenReplayInfo;
    expect(plan.perObject.map((o) => [o.objectApiName, o.toInsert])).toEqual([
      ['Account', 2],
      ['Contact', 4],
    ]);
    expect(replay.checkpoint).toMatchObject({ checkpointId: CHECKPOINT_ID, annex: true });
    expect(replay.target).toEqual({ organizationId: TARGET_ORG_ID, name: 'TARGET' });
    expect(replay.summary.records).toMatchObject({ toCreate: 6, linkedById: 0, linkedByKey: 0 });
    expect(replay.summary.owners).toMatchObject({ kept: 0, toRunningUser: 6 });
    expect(replay.storage).toMatchObject({ remainingMB: 180, maxMB: 200 });
    // The file left is named, never by the id of a record of the checkpoint's org.
    expect(replay.filesLeft).toEqual([
      { objectApiName: 'ContentDocument', name: 'Signed contract' },
    ]);
    expect(replay.storage?.refusal).toBeUndefined();
    // Nothing written, nothing recorded, no folder made.
    expect(held(world)).toEqual({ accounts: 0, contacts: 0 });
    expect(trail(world)).toEqual([]);
    expect(replayFiles(world)).toEqual([]);
  });

  it('refuses the checkpoint’s own org before reading anything of it but which org it is', async () => {
    const world = await worldOf({ target: { organizationId: SOURCE_ORG_ID } });

    const answers = await send(world, 'frozen:load:preview', { replay: replayOf() });

    const [error] = answers('frozen:load:preview:error');
    expect(error.payload.code).toBe('REPLAY_SAME_ORG');
    expect(String(error.payload.message)).toContain('rewind');
    expect(world.asked).toEqual(['SELECT Id FROM Organization']);
    expect(world.described).toEqual([]);
    expect(answers('frozen:load:preview:response')).toEqual([]);
  });

  it('refuses a production org and a sandbox marked Staging before connecting to it', async () => {
    for (const org of [{ orgType: 'Production' }, { orgType: 'Sandbox', staging: true }]) {
      const world = await worldOf(org);

      const answers = await send(world, 'frozen:load:preview', { replay: replayOf() });

      expect(answers('frozen:load:preview:error')[0].payload.code).toBe('GUARD_REFUSED');
      expect(getJsforceConnection).not.toHaveBeenCalled();
      vi.clearAllMocks();
    }
  });

  it('counts the requests its reads of the other org took in the requests its replay would take', async () => {
    const world = await worldOf();

    const answers = await send(world, 'frozen:load:preview', { replay: replayOf() });

    const [response] = answers('frozen:load:preview:response');
    const plan = response.payload.plan as FrozenLoadPlanInfo;
    const replay = response.payload.replay as FrozenReplayInfo;
    expect(replay.requests).toBeGreaterThan(0);
    // The load's own, as a Frozen load of the same records counts them, and the replay's reads.
    const own = loadRequestsEstimate({
      inserts: [
        { objectApiName: 'Account', rows: 2 },
        { objectApiName: 'Contact', rows: 4 },
      ],
      threshold: DEFAULT_ROBUSTNESS_CONFIG.bulk.threshold,
      automationRead: NOTHING_RUNS.requests,
    });
    expect(plan.apiRequests?.estimate).toBe(own + replay.requests);
  });

  it('refuses a sandbox’s checkpoint SandForge 1.80 took, which does not say its license, unless masked or declared to hold no real data', async () => {
    const world = await worldOf({ before181: true });

    const refused = await send(world, 'frozen:load:preview', { replay: replayOf() });
    expect(refused('frozen:load:preview:error')[0].payload.code).toBe('REPLAY_COPY_UNKNOWN');

    const declared = await send(world, 'frozen:load', { replay: replayOf({ noRealData: true }) });
    expect(declared('frozen:load:error').map((error) => error.payload.message)).toEqual([]);
    const replay = declared('frozen:load:response')[0].payload.replay as FrozenReplayInfo;
    expect(replay.checkpoint.annex).toBe(false);
    expect(replay.summary.degraded).toEqual([
      'recordTypes',
      'users',
      'queues',
      'standardPricebook',
    ]);
    // The declaration lifted the refusal on the person's word alone: kept.
    expect(trail(world)[0]).toMatchObject({
      outcome: 'success',
      details: { replaySource: 'unknown', replayNoRealDataDeclared: true, replayMasked: false },
    });
  });

  it('says the refusal a replay would meet past the storage the other org has left, with the way to replay fewer objects', async () => {
    const world = await worldOf();
    const tight = { ...LIMITS, DataStorageMB: { Max: 5, Remaining: 0 } };
    const connect = vi.mocked(getJsforceConnection).getMockImplementation();
    vi.mocked(getJsforceConnection).mockImplementation(async (...args) => {
      const conn = (await connect?.(...args)) as unknown as ReturnType<typeof connectionOf>;
      return {
        ...conn,
        request: async (request: { method: string; url: string }) =>
          /\/limits\/?$/.test(request.url) ? tight : conn.request(request),
      } as never;
    });

    const answers = await send(world, 'frozen:load:preview', { replay: replayOf() });

    const replay = answers('frozen:load:preview:response')[0].payload.replay as FrozenReplayInfo;
    expect(replay.storage?.refusal?.code).toBe('FROZEN_STORAGE_EXCEEDED');
    expect(replay.storage?.refusal?.message).toContain('--objects A,B');
    expect(replay.storage?.refusal?.message).not.toContain('dataset');
  });
});

describe('frozen:load of a checkpoint replayed', () => {
  it('writes the checkpoint’s records, keeps its files under the Organization Id the other org answered with, and says it in the audit trail as a replay', async () => {
    const world = await worldOf();
    world.configStore.set(
      'frozen:config',
      { rootObject: 'Case', axes: [], edgeCases: [] },
      'frozen',
    );

    const answers = await send(world, 'frozen:load', { replay: replayOf(), maxRecords: 6 });

    expect(answers('frozen:load:error').map((error) => error.payload.message)).toEqual([]);
    const [response] = answers('frozen:load:response');
    const report = response.payload.report as FrozenLoadReportInfo;
    expect(report.status).toBe('completed');
    expect((response.payload.replay as FrozenReplayInfo).summary.records.toCreate).toBe(6);
    expect(held(world)).toEqual({ accounts: 2, contacts: 4 });
    // Every record goes to the user who replays: the other org holds none of the checkpoint's.
    expect(world.target.org.all('Account').map((row) => row.OwnerId)).toEqual([
      undefined,
      undefined,
    ]);
    expect(replayFiles(world)).toEqual([
      `counting-contract.${TARGET_ORG_ID}.json`,
      `referenceid-mapping.${TARGET_ORG_ID}.json`,
      'replay.json',
    ]);
    const [entry] = trail(world);
    expect(entry).toMatchObject({
      module: 'checkpoint',
      outcome: 'success',
      orgId: REGISTERED,
      details: {
        replayCheckpoint: CHECKPOINT_ID,
        replaySource: 'developerSandbox',
        replayMasked: false,
        replayContactPoints: 'neutralized',
      },
    });
    expect(trail(world, 'frozen_load')).toEqual([]);
    // The project's configuration and its last loads are the project's.
    expect(world.configStore.get('frozen:config')).toEqual({
      rootObject: 'Case',
      axes: [],
      edgeCases: [],
    });
    expect(world.configStore.get('frozen:lastRuns')).toBeUndefined();
    expect(world.configStore.get('frozen:lastRun')).toBeUndefined();
    // The verification chained after it counts what it wrote, against its own contract.
    const [verified] = answers('frozen:verify:result');
    expect((verified.payload.verdict as { status: string }).status).toBe('passed');
  });

  it('writes nothing past the count its preview gave, and records the replay stopped', async () => {
    const world = await worldOf();

    const answers = await send(world, 'frozen:load', { replay: replayOf(), maxRecords: 5 });

    expect(answers('frozen:load:error')[0].payload.code).toBe('MAX_RECORDS');
    expect(held(world)).toEqual({ accounts: 0, contacts: 0 });
    expect(trail(world)).toMatchObject([{ outcome: 'stopped', module: 'checkpoint' }]);
  });

  it('asks the checkpoint it takes first as a replay’s, in its preview and before its first write, never as a Frozen load’s', async () => {
    const world = await worldOf();
    const asked: string[] = [];
    world.handler.setBeforeRunCheckpoints({
      scope: vi.fn(async (ask: BeforeRunAsk) => {
        asked.push(ask.module);
        throw new Error('The take is not set up in this test');
      }),
      take: vi.fn(),
      settle: vi.fn(),
    } as unknown as BeforeRunCheckpoints);

    await send(world, 'frozen:load:preview', { replay: replayOf(), checkpointFirst: {} });
    const answers = await send(world, 'frozen:load', {
      replay: replayOf(),
      maxRecords: 6,
      checkpointFirst: {},
    });

    // Its name and its chip in the list say what wrote: "Before checkpoint replay".
    expect(asked).toEqual(['replay', 'replay']);
    expect(answers('frozen:load:error')).toHaveLength(1);
    expect(held(world)).toEqual({ accounts: 0, contacts: 0 });
  });

  it('refuses the checkpoint’s own org, writes nothing, and records the replay stopped under its code', async () => {
    const world = await worldOf({ target: { organizationId: SOURCE_ORG_ID } });

    const answers = await send(world, 'frozen:load', { replay: replayOf() });

    expect(answers('frozen:load:error')[0].payload.code).toBe('REPLAY_SAME_ORG');
    expect(held(world)).toEqual({ accounts: 0, contacts: 0 });
    expect(trail(world)).toMatchObject([
      { outcome: 'stopped', module: 'checkpoint', details: { code: 'REPLAY_SAME_ORG' } },
    ]);
  });

  it('links what the other org holds under the same Id or the fields a link names from the first replay, replays again over what it created alone, and its removal leaves what it linked', async () => {
    const link: CheckpointReplayLink = { objectApiName: 'Account', fields: ['Name'] };
    const world = await worldOf();
    // A sandbox copied from the same production holds the first account
    // under its Id; the other org holds the second under its name.
    world.target.hold('Account', {
      Id: idOf('001', 1),
      Name: 'Held by Id',
      OwnerId: REPLAYING_USER,
    });
    world.target.hold('Account', {
      Id: idOf('001', 900),
      Name: 'SFENV replay 2',
      OwnerId: REPLAYING_USER,
    });

    const previewed = await send(world, 'frozen:load:preview', {
      replay: replayOf({ link: [link] }),
    });
    const preview = previewed('frozen:load:preview:response')[0].payload.replay as FrozenReplayInfo;
    expect(preview.summary.records).toMatchObject({ toCreate: 4, linkedById: 1, linkedByKey: 1 });

    const first = await send(world, 'frozen:load', { replay: replayOf({ link: [link] }) });
    expect(first('frozen:load:error').map((error) => error.payload.message)).toEqual([]);
    expect(held(world)).toEqual({ accounts: 2, contacts: 4 });
    const contactsOf = (accountId: string) =>
      world.target.org.all('Contact').filter((row) => row.AccountId === accountId).length;
    expect(contactsOf(idOf('001', 1))).toBe(2);
    expect(contactsOf(idOf('001', 900))).toBe(2);

    const again = await send(world, 'frozen:load', {
      replay: replayOf({ link: [link] }),
      reload: true,
    });
    expect(again('frozen:load:error').map((error) => error.payload.message)).toEqual([]);
    expect(
      (again('frozen:load:response')[0].payload.report as FrozenLoadReportInfo).purge,
    ).toMatchObject({
      deleted: { Contact: 4 },
    });
    expect(held(world)).toEqual({ accounts: 2, contacts: 4 });
    expect(world.target.org.all('Account').map((row) => row.Name)).toEqual([
      'Held by Id',
      'SFENV replay 2',
    ]);

    const removed = await send(world, 'frozen:remove', {
      loadedAt: await loadedAtOf(world),
      replay: { organizationId: SOURCE_ORG_ID, checkpointId: CHECKPOINT_ID },
    });
    expect(removed('frozen:remove:error').map((error) => error.payload.message)).toEqual([]);
    expect(held(world)).toEqual({ accounts: 2, contacts: 0 });
  });
});

describe('a replay of thousands of contacts with their accounts', () => {
  /**
   * `accounts` accounts and `perAccount` contacts under each, as a
   * checkpoint of an org holds them: with the direct relation of each contact
   * to its account, unless told.
   */
  function volume(accounts: number, perAccount: number, relations = true): FabricatedObject[] {
    const accountIds = Array.from({ length: accounts }, (_, n) => idOf('001', n + 1));
    const contacts = accountIds.flatMap((account, a) =>
      Array.from({ length: perAccount }, (_, c) => ({
        Id: idOf('003', a * perAccount + c + 1),
        LastName: `SFENV volume ${a * perAccount + c + 1}`,
        AccountId: account,
      })),
    );
    return [
      {
        objectApiName: 'Account',
        rows: accountIds.map((Id, n) => ({ Id, Name: `SFENV volume ${n + 1}` })),
      },
      { objectApiName: 'Contact', rows: contacts },
      ...(relations
        ? [
            {
              objectApiName: 'AccountContactRelation',
              rows: contacts.map((contact, n) => ({
                Id: idOf('07k', n + 1),
                AccountId: contact.AccountId,
                ContactId: contact.Id,
                IsDirect: true,
              })),
            },
          ]
        : []),
    ];
  }

  it('links the direct relation the other org wrote with each of 3 500 contacts, the org refusing a URL past what it holds', async () => {
    // The replay of a checkpoint of 3 468 contacts read the relations the org
    // wrote with them in one statement: refused with a 431, it stopped after
    // creating 3 900 records.
    const world = await worldOf({ objects: volume(35, 100), target: { directRelations: true } });

    const answers = await send(world, 'frozen:load', { replay: replayOf() });

    expect(answers('frozen:load:error').map((error) => error.payload.message)).toEqual([]);
    const report = answers('frozen:load:response')[0].payload.report as FrozenLoadReportInfo;
    expect(report.status).toBe('completed');
    expect(
      report.perObject.find((o) => o.objectApiName === 'AccountContactRelation'),
    ).toMatchObject({ fromFiles: 3_500, inserted: 0, reused: 3_500 });
    expect(held(world)).toEqual({ accounts: 35, contacts: 3_500 });
    expect(world.target.org.all('AccountContactRelation')).toHaveLength(3_500);
    expect(world.asked.filter((soql) => wireLength(soql) > MOST_WIRE_CHARS)).toEqual([]);
  }, 60_000);

  it('replays again over a replay that left the contact-account relations out, its purge taking those the org wrote with the contacts', async () => {
    // Replayed without its relations, 113 accounts and 3 536 contacts: its
    // --again was refused, "113 kept for records that stay under them
    // (AccountContactRelation, Contact)", while its removal took them all.
    const world = await worldOf({
      objects: volume(2, 1_100),
      target: {
        directRelations: true,
        children: {
          Account: [
            { childSObject: 'Contact', field: 'AccountId', cascadeDelete: true },
            { childSObject: 'AccountContactRelation', field: 'AccountId', cascadeDelete: true },
          ],
          Contact: [
            { childSObject: 'AccountContactRelation', field: 'ContactId', cascadeDelete: true },
          ],
        },
      },
    });
    const without = replayOf({ excluded: ['AccountContactRelation'] });
    const first = await send(world, 'frozen:load', { replay: without });
    expect(first('frozen:load:error').map((error) => error.payload.message)).toEqual([]);
    expect(world.target.org.all('AccountContactRelation')).toHaveLength(2_200);

    const again = await send(world, 'frozen:load:preview', { replay: without, reload: true });

    expect(again('frozen:load:preview:error').map((error) => error.payload.code)).toEqual([]);
    expect(again('frozen:load:preview:response')).toHaveLength(1);
  }, 60_000);
});

describe('frozen:verify and frozen:remove of a checkpoint replayed', () => {
  it('verifies the last replay into the org with the choices it was replayed with', async () => {
    const world = await worldOf();
    await send(world, 'frozen:load', { replay: replayOf() });

    const answers = await send(world, 'frozen:verify', {
      replay: { organizationId: SOURCE_ORG_ID, checkpointId: CHECKPOINT_ID },
    });

    expect(answers('frozen:verify:error').map((error) => error.payload.message)).toEqual([]);
    const [verified] = answers('frozen:verify:result');
    expect((verified.payload.verdict as { status: string }).status).toBe('passed');
  });

  it('removes a replay from its mapping alone, its checkpoint deleted, from the command line that registers the org by its Organization Id', async () => {
    const world = await worldOf();
    await send(world, 'frozen:load', { replay: replayOf() });
    expect(held(world)).toEqual({ accounts: 2, contacts: 4 });
    expect((await world.store.delete(CHECKPOINT_ID)).outcome).toBe('deleted');
    // The command line's host: the org registered by its Organization Id.
    const cli = await worldOf({ registeredAs: TARGET_ORG_ID });
    cli.handler.setReplayStores({ checkpoints: () => [world.store], replays: world.replays });
    writes.target = world.target;
    vi.mocked(getJsforceConnection).mockImplementation(async () => connectionOf(world) as never);

    const answers = await send(
      cli,
      'frozen:remove',
      {
        loadedAt: await loadedAtOf(world),
        replay: { organizationId: SOURCE_ORG_ID, checkpointId: CHECKPOINT_ID },
      },
      TARGET_ORG_ID,
    );

    expect(answers('frozen:remove:error').map((error) => error.payload.message)).toEqual([]);
    expect(answers('frozen:remove:response')[0].payload.result).toMatchObject({
      status: 'success',
    });
    expect(held(world)).toEqual({ accounts: 0, contacts: 0 });
    expect(trail(cli, 'cleanup_delete')[0]).toMatchObject({ module: 'checkpoint' });
  });

  it('previews the removal of a replay from its mapping, nothing written', async () => {
    const world = await worldOf();
    await send(world, 'frozen:load', { replay: replayOf() });

    const answers = await send(world, 'frozen:remove:preview', {
      loadedAt: await loadedAtOf(world),
      replay: { organizationId: SOURCE_ORG_ID, checkpointId: CHECKPOINT_ID },
    });

    expect(answers('frozen:remove:preview:error').map((error) => error.payload.message)).toEqual(
      [],
    );
    expect(answers('frozen:remove:preview:response')[0].payload.preview).toMatchObject({
      planned: 6,
      refusals: [],
    });
    expect(held(world)).toEqual({ accounts: 2, contacts: 4 });
  });

  it('refuses to verify a replay never made into the org, naming the way', async () => {
    const world = await worldOf();

    const answers = await send(world, 'frozen:verify', {
      replay: { organizationId: SOURCE_ORG_ID, checkpointId: CHECKPOINT_ID },
    });

    const [error] = answers('frozen:verify:error');
    expect(error.payload.code).toBe('NO_LOAD');
    expect(String(error.payload.message)).toContain('replay it there first');
  });

  it('names a checkpoint this machine does not keep, before it writes anything', async () => {
    const world = await worldOf();

    const answers = await send(world, 'frozen:load', {
      replay: { ...replayOf(), checkpointId: 'ck-20261110-091400-ffff' },
    });

    expect(answers('frozen:load:error')[0].payload.code).toBe('CHECKPOINT_NOT_FOUND');
    expect(held(world)).toEqual({ accounts: 0, contacts: 0 });
  });
});
