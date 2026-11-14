import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection } from 'jsforce';
import type { ForgeTargetAutomation } from '@sandforge/shared';

vi.mock('../src/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./sfSession.js', () => ({
  loadOrg: vi.fn(async (alias: string) => ({
    alias,
    username: 'replayer@example.com.uat',
    instanceUrl: 'https://example-target.scratch.my.salesforce.com',
    accessToken: 'token',
  })),
  makeConn: vi.fn(),
}));
vi.mock('../src/core/connection/ConnectionHelper.js', async (original) => ({
  ...(await original<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

/** The other org a replay writes to, through the writer the Frozen handler builds. */
const writes = vi.hoisted(() => ({ target: undefined as ReplayTargetOrg | undefined }));
vi.mock('../src/modules/frozendataset/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/frozendataset/index.js')>();
  return {
    ...actual,
    createBulkDmlWriter: () => {
      if (!writes.target) throw new Error('No target to write to');
      return writes.target.writer();
    },
  };
});

import { loadOrg, makeConn } from './sfSession.js';
import { getJsforceConnection } from '../src/core/connection/ConnectionHelper.js';
import { TargetAutomationReader } from '../src/modules/forge/TargetAutomationReader.js';
import { FrozenDatasetHandler } from '../src/bridge/handlers/FrozenDatasetHandler.js';
import { AuditTrailStore } from '../src/modules/audit/auditTrail.js';
import { archiveKeyText } from '../src/modules/checkpoint/checkpointArchive.js';
import { fileConfigStore } from './fileConfigStore.js';
import { main, parseArgs } from './sandforge-checkpoint.js';
import { REPLAY_AUDIT_FILE, replayWords } from './checkpointReplay.js';
import { loadRecordsRefusal } from '../src/modules/frozendataset/FrozenDatasetLoader.js';
import {
  REPLAYING_USER,
  SOURCE_ORG_ID,
  TARGET_ORG_ID,
  idOf,
  type ReplayTargetOrg,
} from '../src/test/replayOrgs.js';
import {
  replayCheckpointSpec,
  replayWorld,
  type ReplayWorld,
  type ReplayWorldOptions,
} from './testing/replayWorld.js';

/*
 * `sandforge checkpoint replay` and `replays`, run whole: the command line
 * parsed, the checkpoint found in the store of the test's folder, the other
 * org reached through the `sf` session and jsforce, both stood in for by an
 * org that reads and refuses as one does (`replayOrgs.ts`), and the replay
 * made by the Frozen handler and its loader, as the editor's page makes it.
 * The checkpoint's own org is never reached: nothing stands in for it.
 */

const argv = (...args: string[]): string[] => ['node', 'sandforge-checkpoint.ts', ...args];

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

/** What the other org has left today. */
const LIMITS = {
  DataStorageMB: { Max: 200, Remaining: 180 },
  DailyApiRequests: { Max: 15_000, Remaining: 14_000 },
  DailyBulkApiBatches: { Max: 15_000, Remaining: 15_000 },
};

/** A page of rows, as jsforce answers a query. */
const page = (records: Array<Record<string, unknown>>) => ({
  done: true,
  totalSize: records.length,
  records,
});

/**
 * The other org as jsforce shows it: a sandbox by its `Organization` record,
 * its records read and written through the memory org, its describes as the
 * replay's fixture gives them, and what it has left today.
 */
function connectionOf(target: ReplayTargetOrg) {
  const org = target.org;
  return {
    get version() {
      return org.version;
    },
    request: async (request: { method: string; url: string }) =>
      /\/limits\/?$/.test(request.url) ? LIMITS : org.request(request),
    query: async (soql: string, options?: { scanAll?: boolean }) => {
      if (/\bFROM Organization\b/.test(soql)) {
        return page([{ Id: target.organizationId, IsSandbox: true }]);
      }
      return org.query(soql, options);
    },
    queryMore: (url: string) => org.queryMore(url),
    describe: async (objectApiName: string) => {
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
      query: async () => page([]),
      queryMore: async () => page([]),
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

const worlds: ReplayWorld[] = [];
let stdout: string;
let stderr: string;
let exited: number | undefined;

/** The world of a test: its folder named by SANDFORGE_JOURNAL_DIR, the other org reached. */
async function made(options: ReplayWorldOptions = {}): Promise<ReplayWorld> {
  const world = await replayWorld(options);
  worlds.push(world);
  vi.stubEnv('SANDFORGE_JOURNAL_DIR', world.dir);
  writes.target = world.target;
  const conn = connectionOf(world.target);
  vi.mocked(makeConn).mockReturnValue(conn as unknown as Connection);
  vi.mocked(getJsforceConnection).mockImplementation(async () => conn as never);
  return world;
}

/** Run the command line to its end: what it printed, and how it exited. */
async function run(world: ReplayWorld, ...args: string[]): Promise<number> {
  stdout = '';
  stderr = '';
  exited = undefined;
  process.exitCode = undefined;
  try {
    await main(argv(...args), { locksDir: world.locksDir });
  } catch (err: unknown) {
    if (!(err instanceof Error) || !err.message.startsWith('exit ')) throw err;
  }
  return exited ?? Number(process.exitCode ?? 0);
}

/** The accounts and contacts the other org holds. */
function held(world: ReplayWorld): { accounts: number; contacts: number } {
  return {
    accounts: world.target.org.all('Account').length,
    contacts: world.target.org.all('Contact').length,
  };
}

/** The files of the checkpoint's replays, by name. */
function replayFiles(world: ReplayWorld): string[] {
  const folder = world.replays.folderOf(SOURCE_ORG_ID, world.checkpoint.checkpointId);
  return existsSync(folder.dir) ? readdirSync(folder.dir).sort() : [];
}

/** The command line's own words for this checkpoint, into the other org. */
const of = (world: ReplayWorld, ...rest: string[]): string[] => [
  'replay',
  '--checkpoint',
  world.checkpoint.checkpointId,
  '--target',
  'DEV2',
  ...rest,
];

/**
 * The checkpoint as a `.sfcheckpoint` file, and its key: its field prints
 * written first, which a take writes with it and an import checks against
 * each object's, and which the fabricated checkpoint does not hold.
 */
async function exportedOf(world: ReplayWorld): Promise<{ file: string; key: Buffer }> {
  await world.store.writeFingerprints(
    world.folder,
    Object.fromEntries(
      world.checkpoint.objects.map((object) => [
        object.objectApiName,
        { digest: object.fingerprint, fields: {} },
      ]),
    ),
  );
  return world.exported();
}

beforeEach(() => {
  vi.spyOn(TargetAutomationReader.prototype, 'read').mockResolvedValue(NOTHING_RUNS);
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string) => {
    stdout += String(chunk);
    return true;
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    stderr += String(chunk);
    return true;
  }) as never);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exited = code;
    throw new Error(`exit ${String(code)}`);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(loadOrg).mockClear();
  writes.target = undefined;
  process.exitCode = undefined;
  for (const world of worlds.splice(0)) world.remove();
});

describe('sandforge checkpoint replay, its line', () => {
  it('reads what a replay is asked, each choice with its default otherwise', () => {
    const args = parseArgs(
      argv(
        'replay',
        '--checkpoint',
        'recette prête',
        '--from',
        'DEV1',
        '--target',
        'DEV2',
        '--objects',
        'Account,Contact',
        '--objects',
        'Case',
        '--exclude-object',
        'Task',
        '--owners',
        'me',
        '--link',
        'Account=AccountNumber,Name',
        '--mask',
        '--keep-contact-points',
        '--custom-settings',
        '--no-real-data',
        '--again',
        '--mute-automation',
        '--accept-automation',
        '--accept-emails',
        '--max-records',
        '12',
        '--yes',
      ),
    );

    expect(args).toMatchObject({
      command: 'replay',
      replay: {
        action: 'replay',
        checkpoint: 'recette prête',
        from: 'DEV1',
        target: 'DEV2',
        choices: {
          owners: 'me',
          customSettings: true,
          mask: true,
          contactPoints: 'kept',
          objects: ['Account', 'Contact', 'Case'],
          excluded: ['Task'],
          link: [{ objectApiName: 'Account', fields: ['AccountNumber', 'Name'] }],
          noRealData: true,
        },
        again: true,
        muteAutomation: true,
        acceptAutomation: true,
        acceptEmails: true,
        maxRecords: 12,
        yes: true,
      },
    });
    expect(
      parseArgs(argv('replay', '--checkpoint', 'ck-20261110-091400-a1b2', '--target', 'DEV2')),
    ).toMatchObject({
      replay: {
        action: 'replay',
        choices: {
          owners: 'same',
          customSettings: false,
          mask: false,
          contactPoints: 'neutralized',
          objects: [],
          excluded: [],
          link: [],
        },
        again: false,
        yes: false,
      },
    });
  });

  it('refuses a line it cannot run, exit 2, before any org is reached', () => {
    const refusedLine = (...args: string[]): string => {
      stderr = '';
      exited = undefined;
      try {
        parseArgs(argv(...args));
      } catch {
        // `process.exit` throws so the parse stops where it would.
      }
      expect(exited).toBe(2);
      return stderr;
    };

    expect(refusedLine('replay', '--target', 'DEV2')).toContain('--checkpoint');
    expect(refusedLine('replay', '--checkpoint', 'ck-20261110-091400-a1b2')).toContain('--target');
    expect(refusedLine('replay', '--checkpoint', 'recette', '--target', 'DEV2')).toContain(
      '--from',
    );
    expect(
      refusedLine(
        'replay',
        '--checkpoint',
        'ck-20261110-091400-a1b2',
        '--target',
        'DEV2',
        '--verify',
        '--remove',
      ),
    ).toContain('one of');
    expect(
      refusedLine(
        'replay',
        '--checkpoint',
        'ck-20261110-091400-a1b2',
        '--target',
        'DEV2',
        '--remove',
        '--mask',
      ),
    ).toContain('--mask');
    expect(
      refusedLine(
        'replay',
        '--checkpoint',
        'ck-20261110-091400-a1b2',
        '--target',
        'DEV2',
        '--preview',
      ),
    ).toContain('--remove');
    expect(
      refusedLine(
        'replay',
        '--checkpoint',
        'ck-20261110-091400-a1b2',
        '--target',
        'DEV2',
        '--owners',
        'all',
      ),
    ).toContain('same or me');
    expect(
      refusedLine(
        'replay',
        '--checkpoint',
        'ck-20261110-091400-a1b2',
        '--target',
        'DEV2',
        '--link',
        'Account',
      ),
    ).toContain('--link');
    // A key given where the name of its variable goes is not repeated.
    const said = refusedLine(
      'replay',
      '--file',
      'x.sfcheckpoint',
      '--key-env',
      'ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23-4567-ABCD-EFGH-IJKL-MNOP-QRST',
      '--target',
      'DEV2',
    );
    expect(said).not.toContain('ABCD-EFGH');
  });

  it('reads the users of --owner-map from its file, and refuses one that is not a map of user ids', async () => {
    const world = await made();
    const good = join(world.dir, 'owners.json');
    writeFileSync(good, JSON.stringify({ [idOf('005', 1)]: REPLAYING_USER }));
    const bad = join(world.dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ someone: 'else' }));

    expect(parseArgs(argv(...of(world, '--owner-map', good)))).toMatchObject({
      replay: { choices: { ownerMap: { [idOf('005', 1)]: REPLAYING_USER } } },
    });
    try {
      parseArgs(argv(...of(world, '--owner-map', bad)));
    } catch {
      // `process.exit` throws.
    }
    expect(exited).toBe(2);
    expect(stderr).toContain('--owner-map');
  });
});

describe('sandforge checkpoint replay --dry-run', () => {
  it('says what the replay would create in the other org, and why each record that does not go as it was, writing nothing: exit 0', async () => {
    const world = await made();

    const code = await run(world, ...of(world, '--dry-run'));

    expect(code).toBe(0);
    expect(held(world)).toEqual({ accounts: 0, contacts: 0 });
    expect(replayFiles(world)).toEqual([]);
    expect(stdout).toContain(
      "A replay of checkpoint 'Before UAT' (of DEV1, taken 2026-11-10 09:14 UTC) into DEV2 " +
        'would create copies of 9 of its records there, parents first, with new Ids; nothing ' +
        'DEV2 holds is changed or deleted.',
    );
    expect(stdout).toContain('  Account: 3 to insert of 3');
    expect(stdout).toContain(
      'owners: 0 kept, 9 to the user who replays — their user is not in DEV2: 9',
    );
    expect(stdout).toContain(
      'To replay it: pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts replay ' +
        `--checkpoint ${world.checkpoint.checkpointId} --target DEV2`,
    );
    // The checkpoint's own org was never reached: only the other org's session was loaded.
    expect(vi.mocked(loadOrg).mock.calls).toEqual([['DEV2']]);
  });

  it('names each file it leaves where it was, however many: a checkpoint keeps no file’s content', async () => {
    const records = replayCheckpointSpec({ accounts: 1, perAccount: 0, mark: 'files' });
    const files = Array.from({ length: 10 }, (_, at) => ({
      Id: idOf('069', at + 1),
      Title: `Signed contract ${at + 1}`,
    }));
    const world = await made({
      spec: { objects: [...records.objects, { objectApiName: 'ContentDocument', rows: files }] },
    });

    expect(await run(world, ...of(world, '--dry-run'))).toBe(0);

    expect(stdout).toContain(
      "10 file(s) left where they were, a checkpoint keeping no file's content:",
    );
    for (let n = 1; n <= 10; n++) {
      expect(stdout).toContain(`  ContentDocument 'Signed contract ${n}'\n`);
    }
  });

  it('answers with --json what the replay would do, in its own keys', async () => {
    const world = await made();

    expect(await run(world, ...of(world, '--dry-run', '--json'))).toBe(0);

    const answer = JSON.parse(stdout) as Record<string, unknown>;
    expect(answer).toMatchObject({
      command: 'replay',
      dryRun: true,
      checkpoint: {
        id: world.checkpoint.checkpointId,
        name: 'Before UAT',
        organizationId: SOURCE_ORG_ID,
        takenAt: '2026-11-10T09:14:00.000Z',
        tier: 'sandbox',
        annex: true,
      },
      target: { alias: 'DEV2', organizationId: TARGET_ORG_ID },
      choices: { owners: 'same', mask: false, contactPoints: 'neutralized' },
      replay: {
        records: { toCreate: 9, linkedById: 0, linkedByKey: 0, refusedBeforeWrite: 0 },
        owners: { kept: 0, toRunningUser: 9 },
        auditDates: 'new',
      },
      removeWith:
        'pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts replay --checkpoint ' +
        `${world.checkpoint.checkpointId} --target DEV2 --remove`,
      exit: 0,
    });
    expect((answer.plan as { perObject: unknown[] }).perObject).toHaveLength(2);
    expect(answer).not.toHaveProperty('posted');
    expect(answer).not.toHaveProperty('dataset');
  });

  it('refuses the checkpoint’s own org, naming a rewind, before reading anything of it: exit 1', async () => {
    const world = await made({ target: { organizationId: SOURCE_ORG_ID } });

    const code = await run(world, ...of(world, '--dry-run', '--json'));

    expect(code).toBe(1);
    const answer = JSON.parse(stdout) as { refusalCodes?: string[]; refusals?: string[] };
    expect(answer.refusalCodes).toEqual(['REPLAY_SAME_ORG']);
    expect(answer.refusals?.[0]).toContain('rewind that org to the checkpoint instead');
    expect(held(world)).toEqual({ accounts: 0, contacts: 0 });
  });

  it('refuses a sandbox’s checkpoint taken before 1.81 unless masked or declared to hold no real data, and keeps the declaration in the audit trail', async () => {
    const world = await made({ annex: false, org: { dataStorageMaxMB: undefined } });

    expect(await run(world, ...of(world, '--dry-run'))).toBe(1);
    expect(stderr + stdout).toContain('REPLAY_COPY_UNKNOWN');
    expect(stderr + stdout).toContain('--no-real-data');

    expect(await run(world, ...of(world, '--no-real-data', '--yes'))).toBe(0);
    expect(held(world)).toEqual({ accounts: 3, contacts: 6 });
    const trail = new AuditTrailStore(
      fileConfigStore(join(world.dir, 'replays', REPLAY_AUDIT_FILE)),
    )
      .list()
      .entries.filter((entry) => entry.action === 'checkpoint_replay');
    expect(trail[0]).toMatchObject({
      outcome: 'success',
      details: { replayNoRealDataDeclared: true, replayMasked: false },
    });
  });
});

describe('sandforge checkpoint replay', () => {
  it('replays after its dry run, held to the count it gave, and says how to take it back: exit 0', async () => {
    const world = await made();
    const handled = vi.spyOn(FrozenDatasetHandler.prototype, 'handle');

    const code = await run(world, ...of(world, '--yes'));

    expect(code).toBe(0);
    // Its dry run, then its load, bound to the 9 records that dry run counted.
    const asked = handled.mock.calls.map(
      ([message]) => message as unknown as { type: string; payload: Record<string, unknown> },
    );
    expect(asked.map((message) => message.type)).toEqual(['frozen:load:preview', 'frozen:load']);
    expect(asked[1].payload).toMatchObject({
      maxRecords: 9,
      replay: { organizationId: SOURCE_ORG_ID, checkpointId: world.checkpoint.checkpointId },
    });
    expect(held(world)).toEqual({ accounts: 3, contacts: 6 });
    expect(replayFiles(world)).toEqual([
      `counting-contract.${TARGET_ORG_ID}.json`,
      `referenceid-mapping.${TARGET_ORG_ID}.json`,
      'replay.json',
    ]);
    // Its plan first, then what it did.
    expect(stdout.indexOf('would create copies of 9')).toBeLessThan(
      stdout.indexOf('replay: completed'),
    );
    expect(stdout).toContain(
      'To take it back: pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts replay ' +
        `--checkpoint ${world.checkpoint.checkpointId} --target DEV2 --remove`,
    );
  });

  it('stops at its question with no terminal, its plan said and nothing written: exit 2', async () => {
    const world = await made();

    const code = await run(world, ...of(world));

    expect(code).toBe(2);
    expect(stdout).toContain('would create copies of 9');
    expect(held(world)).toEqual({ accounts: 0, contacts: 0 });
  });

  it('verifies the last replay, then removes it — the checkpoint deleted meanwhile — leaving the other org as it was', async () => {
    const world = await made();
    expect(await run(world, ...of(world, '--yes'))).toBe(0);

    expect(await run(world, ...of(world, '--verify'))).toBe(0);
    expect(stdout).toContain('verification: PASSED');

    expect((await world.store.delete(world.checkpoint.checkpointId)).outcome).toBe('deleted');
    expect(await run(world, ...of(world, '--remove', '--preview'))).toBe(0);
    expect(stdout).toContain('preview: what a removal would do; nothing was deleted');
    expect(held(world)).toEqual({ accounts: 3, contacts: 6 });

    expect(await run(world, ...of(world, '--remove', '--yes'))).toBe(0);
    expect(held(world)).toEqual({ accounts: 0, contacts: 0 });
    expect(stdout).toContain('removal: SUCCESS');
  });

  it('replays again over what it created alone, its counts the same', async () => {
    const world = await made();
    expect(await run(world, ...of(world, '--yes'))).toBe(0);

    expect(await run(world, ...of(world, '--again', '--yes'))).toBe(0);

    expect(held(world)).toEqual({ accounts: 3, contacts: 6 });
  });

  it('keeps the replays of a store --store names in that store, and names it in the command that takes them back', async () => {
    const world = await made();
    const store = join(world.dir, 'checkpoints');

    expect(await run(world, ...of(world, '--store', store, '--yes', '--json'))).toBe(0);

    const folder = join(store, '.replays', SOURCE_ORG_ID, world.checkpoint.checkpointId);
    expect(readdirSync(folder)).toContain(`referenceid-mapping.${TARGET_ORG_ID}.json`);
    // Nothing in the editor's own replays: a run of another store keeps its own.
    expect(replayFiles(world)).toEqual([]);
    const removeWith =
      'pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts replay --checkpoint ' +
      `${world.checkpoint.checkpointId} --target DEV2 --store ${store} --remove`;
    expect(JSON.parse(stdout)).toMatchObject({ removeWith });

    expect(await run(world, 'replays', '--store', store, '--json')).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject([{ inPlace: 9, removeWith }]);
    expect(await run(world, ...of(world, '--store', store, '--remove', '--yes'))).toBe(0);
    expect(held(world)).toEqual({ accounts: 0, contacts: 0 });
  });

  it('says no word of a dataset in anything a replay prints, its removal and verification included', async () => {
    const world = await made();
    let said = '';
    for (const line of [
      of(world, '--dry-run'),
      of(world, '--yes'),
      of(world, '--verify'),
      of(world, '--remove', '--preview'),
      of(world, '--remove', '--yes'),
      of(world, '--verify'),
    ]) {
      await run(world, ...line);
      said += stdout + stderr;
    }

    // The verification after the removal names the replay's way, not a load's.
    expect(said).toContain(
      'refused (LOAD_REMOVED): The records the last replay created were removed on ',
    );
    expect(said).toContain('Replay the checkpoint again, then verify.');
    expect(said).not.toMatch(/dataset/i);
    expect(said).not.toMatch(/frozen/i);
    expect(said).not.toMatch(/\bsas\b/);
  });
});

describe('sandforge checkpoint replay --file', () => {
  it('replays a file a teammate sent, with its key, its org never asked, its checkpoint kept apart', async () => {
    const world = await made();
    const { file, key } = await exportedOf(world);
    vi.stubEnv('D8_KEY', archiveKeyText(key));
    expect((await world.store.delete(world.checkpoint.checkpointId)).outcome).toBe('deleted');

    const code = await run(
      world,
      'replay',
      '--file',
      file,
      '--key-env',
      'D8_KEY',
      '--target',
      'DEV2',
      '--dry-run',
    );

    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toContain('would create copies of 9');
    expect(readdirSync(join(world.dir, 'checkpoints', '.received'))).toContain(SOURCE_ORG_ID);
    expect(vi.mocked(loadOrg).mock.calls).toEqual([['DEV2']]);
  });

  it('reads a checkpoint kept here and received back as a file as one, by its id', async () => {
    const world = await made();
    const { file, key } = await exportedOf(world);
    vi.stubEnv('D8_KEY', archiveKeyText(key));
    const line = ['replay', '--file', file, '--key-env', 'D8_KEY', '--target', 'DEV2'];
    expect(await run(world, ...line, '--dry-run')).toBe(0);

    expect(await run(world, ...of(world, '--dry-run'))).toBe(0);

    expect(stdout).toContain('would create copies of 9');
  });

  it('refuses a wrong key before anything is kept: exit 1', async () => {
    const world = await made();
    const { file } = await exportedOf(world);
    const other = await exportedOf(world);
    vi.stubEnv('D8_KEY', archiveKeyText(other.key));

    const code = await run(
      world,
      'replay',
      '--file',
      file,
      '--key-env',
      'D8_KEY',
      '--target',
      'DEV2',
      '--dry-run',
    );

    expect(code).toBe(1);
    expect(stderr).toContain('IMPORT_KEY');
    expect(existsSync(join(world.dir, 'checkpoints', '.received', SOURCE_ORG_ID))).toBe(false);
    expect(loadOrg).not.toHaveBeenCalled();
  });

  it('refuses the file of a Partial Copy unmasked before its key is read, and replays it masked', async () => {
    const world = await made({ org: { dataStorageMaxMB: 5_120 } });
    const { file, key } = await exportedOf(world);

    const refused = await run(
      world,
      'replay',
      '--file',
      file,
      '--key-env',
      'UNSET_KEY',
      '--target',
      'DEV2',
      '--dry-run',
    );
    expect(refused).toBe(1);
    expect(stderr).toContain('REPLAY_REAL_DATA');
    expect(stderr).toContain('--mask');

    vi.stubEnv('D8_KEY', archiveKeyText(key));
    expect(
      await run(
        world,
        'replay',
        '--file',
        file,
        '--key-env',
        'D8_KEY',
        '--target',
        'DEV2',
        '--mask',
        '--dry-run',
      ),
    ).toBe(0);
  });

  it('replays the file SandForge 1.80 exported, without its annex, and says what a replay without it gives', async () => {
    const world = await made();
    const { file, key } = world.fileOf180();
    vi.stubEnv('D8_KEY', archiveKeyText(key));

    const code = await run(
      world,
      'replay',
      '--file',
      file,
      '--key-env',
      'D8_KEY',
      '--target',
      'DEV2',
      '--dry-run',
      '--json',
    );

    expect(code).toBe(0);
    const answer = JSON.parse(stdout) as {
      checkpoint: { annex: boolean };
      replay: { degraded: string[] };
    };
    expect(answer.checkpoint.annex).toBe(false);
    expect(answer.replay.degraded).toEqual(['recordTypes', 'users', 'queues', 'standardPricebook']);
  });
});

describe('replayWords', () => {
  it('says in a replay’s words what the Frozen handler words for a load, by its code', () => {
    const said = (code: string, message: string, payload: Record<string, unknown> = {}) =>
      replayWords(code, message, 'DEV2', payload);

    expect(said('MAX_RECORDS', loadRecordsRefusal(12, 9) ?? '')).toBe(
      'This replay would create 12 record(s), more than the 9 it may: nothing was written. ' +
        "The checkpoint's records or DEV2 changed since that count was taken: run its dry run " +
        'again, and replay with the count it gives (--max-records).',
    );
    expect(
      said(
        'TARGET_REFRESHED',
        'The target org was refreshed after the last load: the records that load wrote are ' +
          'gone. Load the dataset again, then verify.',
      ),
    ).toBe(
      'DEV2 was refreshed after the last replay: the records it created went with the ' +
        'refresh. Replay the checkpoint again, then verify.',
    );
    expect(
      said(
        'LOAD_REMOVED',
        'The removal of 2026-11-14T10:00:00.000Z took part of the records the last load ' +
          'created and left 2 in the org: a verification would read the ones it took as ' +
          'missing. Remove what is left, or reload the dataset, which purges or finds it ' +
          'again; then verify.',
        { left: 2 },
      ),
    ).toBe(
      'The removal of 2026-11-14T10:00:00.000Z took part of the records the last replay ' +
        'created and left 2 in DEV2: a verification would read the ones it took as missing. ' +
        'Remove what is left (--remove), or replay again (--again), which purges or finds it ' +
        'again; then verify.',
    );
    expect(said('LOAD_STOPPED', 'The last load stopped part way … Reload the dataset')).toContain(
      'Replay it again (--again), which purges or finds again what the stopped replay wrote, ' +
        'or take it back (--remove); then verify.',
    );
    expect(
      said(
        'REPLACE_LEAVES_RECORDS',
        'A removal of the loads this reload replaces would leave 3 of their records in the ' +
          'org — Contact (3: changed since): loaded again, the dataset would stand beside ' +
          'them, and the reload would delete what was changed since, and what stays under ' +
          'them along with them. Nothing was written. Take the load back first with a ' +
          'removal — records changed since, and what was added under them since, go too ' +
          'when it is told to include them — then load the dataset again.',
      ),
    ).toBe(
      'Taking back what the replays before created in DEV2 would leave 3 of their records ' +
        "there — Contact (3: changed since): replayed again, the checkpoint's records would " +
        'stand beside them. Nothing was written. Take the replay back first (--remove; ' +
        '--include-changed takes too what was changed since, and what was added under it ' +
        'since), then replay it again.',
    );
    expect(
      said('GUARD_REFUSED', 'Refusing frozen-dataset load on production org x: …', {
        guard: 'non-sandbox',
        tier: 'production',
      }),
    ).toBe(
      'A replay goes into a sandbox, a scratch org or a Developer Edition org, never into a ' +
        'production org nor a sandbox marked Staging, which hold real data: DEV2 is a ' +
        'production org. Nothing was read or written.',
    );
    // What no code tells keeps its words, but for the dataset it names.
    expect(said('LOAD_ERROR', 'Not written: the dataset holds no value')).toBe(
      'Not written: the checkpoint holds no value',
    );
    expect(said('LOAD_ERROR', 'The org answered 503')).toBe('The org answered 503');
  });
});

describe('sandforge checkpoint replays', () => {
  it('lists each replay with what it left in the other org, no org reached', async () => {
    const world = await made();
    expect(await run(world, ...of(world, '--yes'))).toBe(0);
    vi.mocked(loadOrg).mockClear();

    expect(await run(world, 'replays', '--json')).toBe(0);

    expect(JSON.parse(stdout)).toEqual([
      expect.objectContaining({
        checkpointId: world.checkpoint.checkpointId,
        checkpointName: 'Before UAT',
        sourceOrganizationId: SOURCE_ORG_ID,
        target: { organizationId: TARGET_ORG_ID, name: 'DEV2' },
        inPlace: 9,
        inPlaceByObject: [
          { objectApiName: 'Account', records: 3 },
          { objectApiName: 'Contact', records: 6 },
        ],
        removeWith:
          'pnpm exec tsx packages/extension/cli/sandforge-checkpoint.ts replay --checkpoint ' +
          `${world.checkpoint.checkpointId} --target DEV2 --remove`,
      }),
    ]);
    expect(loadOrg).not.toHaveBeenCalled();

    expect(await run(world, 'replays', '--target', 'OTHER')).toBe(0);
    expect(stdout).toContain('No replay into OTHER is kept');
  });
});

describe('sandforge checkpoint delete', () => {
  it('names the replays of the checkpoint still in place, which its deletion leaves removable', async () => {
    const world = await made();
    expect(await run(world, ...of(world, '--yes'))).toBe(0);

    const code = await run(
      world,
      'delete',
      '--org',
      'DEV1',
      '--checkpoint',
      world.checkpoint.checkpointId,
      '--yes',
      '--json',
    );

    expect(code).toBe(0);
    expect(stderr).toContain('A replay of it is still in place: 9 records in DEV2.');
    expect(JSON.parse(stdout)).toMatchObject({
      deleted: [world.checkpoint.checkpointId],
      replaysInPlace: [
        {
          checkpointId: world.checkpoint.checkpointId,
          target: { organizationId: TARGET_ORG_ID, name: 'DEV2' },
          inPlace: 9,
        },
      ],
    });
  });
});
