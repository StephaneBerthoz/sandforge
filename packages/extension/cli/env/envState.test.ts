import { afterEach, describe, expect, it } from 'vitest';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { EnvState } from '@sandforge/shared';
import {
  EnvStateError,
  SCRATCH_STATE_KEEP_DAYS,
  envJournalDirOf,
  envRunIdOf,
  journalInsideRepository,
  newEnvState,
  openEnvStore,
  removalStarted,
  runStarted,
  runSummaryPathOf,
  runTemplatePathOf,
  stateExpiresAt,
  stepEnded,
  type EnvStore,
  type EnvStoreOptions,
} from './envState.js';

/** Whether the system gives files an owner and permission bits the states can rely on. */
const POSIX = process.platform !== 'win32';

/** An Organization Id in its 18-character form, and the 15 it is made from. */
const ORG = '00Dxx0000001234EAA';
const ORG_15 = '00Dxx0000001234';
const OTHER_ORG = '00Dxx0000005678EAA';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const DAY = 24 * 60 * 60_000;

const made: string[] = [];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-env-state-'));
  made.push(dir);
  return dir;
}

/** A project in a repository of its own, its file's folder, and a journal directory outside it. */
function project(): { root: string; fileFolder: string; journalDir: string } {
  const root = scratch();
  mkdirSync(join(root, 'project', '.git'), { recursive: true });
  mkdirSync(join(root, 'project', 'env'), { recursive: true });
  return { root, fileFolder: join(root, 'project', 'env'), journalDir: join(root, 'journal') };
}

function storeOf(options: Partial<EnvStoreOptions> = {}): EnvStore {
  const { fileFolder, journalDir } = project();
  const opened = openEnvStore({ journalDir, fileFolder, now: () => NOW, ...options });
  if (!('store' in opened)) throw new Error(`refused: ${opened.refusal}`);
  return opened.store;
}

function stateOf(kind: 'scratch' | 'developer' = 'scratch', org = ORG): EnvState {
  return newEnvState({
    env: 'case-flow',
    org: { organizationId: org, kind, username: 'test-user@example.com', alias: 'pool-1' },
    fileDigest: 'a'.repeat(64),
    sandforgeVersion: '1.68.0',
    now: new Date(NOW),
  });
}

/** The state once its accounts resource began a seed run. */
function seeding(state: EnvState): EnvState {
  return runStarted(state, {
    resource: 'accounts',
    kind: 'seed',
    fingerprint: 'b'.repeat(64),
    dependsOn: [],
    run: {
      script: 'sandforge-seed',
      runId: envRunIdOf('case-flow', 'accounts', 1, '0a1b2c3d-0000-4000-8000-000000000000'),
      summary: runSummaryPathOf('accounts', 1),
      seed: 4242,
      startedAt: '2026-10-25T11:59:00.000Z',
    },
  });
}

async function expectRefused(promise: Promise<unknown>, code: string): Promise<EnvStateError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(EnvStateError);
  expect((err as EnvStateError).code).toBe(code);
  return err as EnvStateError;
}

describe('where the states are', () => {
  it('keeps them in the journal directory the scripts keep their run files in', () => {
    expect(envJournalDirOf({})).toBe(join(homedir(), '.sandforge'));
    expect(envJournalDirOf({ SANDFORGE_JOURNAL_DIR: '/srv/runner/journal' })).toBe(
      resolve('/srv/runner/journal'),
    );
    expect(envJournalDirOf({ SANDFORGE_JOURNAL_DIR: '  ' })).toBe(join(homedir(), '.sandforge'));
  });

  it('files a state under the 18-character Organization Id and the environment’s name', () => {
    const store = storeOf();

    expect(store.folderOf(ORG_15, 'case-flow')).toBe(join(store.root, ORG, 'case-flow'));
    expect(store.folderOf(ORG, 'case-flow')).toBe(join(store.root, ORG, 'case-flow'));
  });

  it('never lets an id, a name or a file that is not one of its shapes reach a path', () => {
    const store = storeOf();

    for (const [org, env] of [
      ['005xx0000001234AAA', 'case-flow'],
      ['../00Dxx0000001234', 'case-flow'],
      [ORG, '../case-flow'],
      [ORG, 'Case-Flow'],
    ] as const) {
      expect(() => store.folderOf(org, env), `${org} ${env}`).toThrow(EnvStateError);
    }
    expect(store.fileOf(ORG, 'case-flow', 'runs/accounts/2.summary.json')).toBe(
      join(store.root, ORG, 'case-flow', 'runs', 'accounts', '2.summary.json'),
    );
    for (const file of [
      'runs/../../x.summary.json',
      '/etc/passwd',
      'state.json',
      'runs/a/0.summary.json',
    ]) {
      expect(() => store.fileOf(ORG, 'case-flow', file), file).toThrow(EnvStateError);
    }
  });

  it('names a run’s files and its Seed run id after the environment, the resource and the rank', () => {
    expect(runSummaryPathOf('accounts', 3)).toBe('runs/accounts/3.summary.json');
    expect(runTemplatePathOf('accounts', 3)).toBe('templates/accounts.3.json');
    expect(envRunIdOf('case-flow', 'accounts', 3, 'u-u-i-d')).toBe(
      'env-case-flow-accounts-3-u-u-i-d',
    );
    expect(() => runSummaryPathOf('accounts', 0)).toThrow(EnvStateError);
    expect(() => envRunIdOf('case-flow', '../x', 1)).toThrow(EnvStateError);
  });
});

describe('the journal directory and the file’s repository', () => {
  it('refuses a journal directory inside the repository that holds the file, saying where to put it', () => {
    const { root, fileFolder } = project();
    const inside = join(root, 'project', '.sandforge');

    const refusal = journalInsideRepository(fileFolder, inside);

    expect(refusal).toContain(`The journal directory ${inside} is inside the repository`);
    expect(refusal).toContain('$RUNNER_TEMP/sandforge');
    expect(journalInsideRepository(fileFolder, join(root, 'project'))).toBeDefined();
    expect(openEnvStore({ journalDir: inside, fileFolder })).toEqual({ refusal });
    expect(existsSync(inside)).toBe(false);
  });

  it('opens a journal directory outside it, or beside a file that is in no repository', () => {
    const { root, fileFolder, journalDir } = project();
    const loose = join(root, 'loose');
    mkdirSync(loose);

    expect(journalInsideRepository(fileFolder, journalDir)).toBeUndefined();
    expect(journalInsideRepository(loose, join(loose, 'journal'))).toBeUndefined();
    expect('store' in openEnvStore({ journalDir, fileFolder })).toBe(true);
  });

  it.runIf(POSIX)(
    'follows links: a journal directory linked into the repository is inside it',
    () => {
      const { root, fileFolder } = project();
      mkdirSync(join(root, 'project', 'state'));
      symlinkSync(join(root, 'project', 'state'), join(root, 'linked'));
      symlinkSync(fileFolder, join(root, 'file-link'));

      expect(journalInsideRepository(fileFolder, join(root, 'linked', 'journal'))).toBeDefined();
      expect(
        journalInsideRepository(join(root, 'file-link'), join(root, 'project', 'j')),
      ).toBeDefined();
    },
  );

  it('lists without a file, and refuses to write what it was opened to list', async () => {
    const { journalDir } = project();
    const opened = openEnvStore({ journalDir, fileFolder: null });
    if (!('store' in opened)) throw new Error(opened.refusal);

    expect(await opened.store.list()).toEqual([]);
    const state = stateOf();
    await expectRefused(opened.store.write(state, state), 'invalid');
  });
});

describe('writing a state', () => {
  it('writes ahead: a run is on disk, applying, before its script would be spawned', async () => {
    const store = storeOf();
    const state = stateOf();

    const ahead = await store.update(state, seeding);

    expect(await store.read(ORG, 'case-flow')).toEqual(ahead);
    expect(ahead).toMatchObject({
      serial: 1,
      resources: {
        accounts: {
          status: 'applying',
          runs: [{ n: 1, script: 'sandforge-seed', seed: 4242, objects: [] }],
        },
      },
    });

    const ended = await store.update(ahead, (s) =>
      stepEnded(s, {
        resource: 'accounts',
        status: 'applied',
        run: {
          endedAt: '2026-10-25T11:59:40.000Z',
          exitCode: 0,
          objects: [{ objectApiName: 'Account', created: 20, refused: 0 }],
        },
      }),
    );

    expect(ended.serial).toBe(2);
    expect(await store.read(ORG, 'case-flow')).toMatchObject({
      resources: { accounts: { status: 'applied', runs: [{ exitCode: 0 }] } },
    });
  });

  it('numbers a resource’s runs, keeping the earlier ones a replace took back', async () => {
    const store = storeOf();
    const first = await store.update(stateOf(), seeding);
    const removing = await store.update(first, (s) => removalStarted(s, 'accounts'));
    expect(removing.resources['accounts']?.status).toBe('destroying');

    const again = await store.update(removing, seeding);

    expect(again.resources['accounts']?.runs.map((run) => run.n)).toEqual([1, 2]);
    expect(again.resources['accounts']?.status).toBe('applying');
    expect(() => removalStarted(again, 'contacts')).toThrow(EnvStateError);
  });

  it('keeps the state and its folders its owner’s alone', async () => {
    const store = storeOf();

    await store.update(stateOf(), seeding);

    if (POSIX) {
      const folder = store.folderOf(ORG, 'case-flow');
      expect(statSync(join(folder, 'state.json')).mode & 0o777).toBe(0o600);
      for (const dir of [store.root, join(store.root, ORG), folder]) {
        expect(statSync(dir).mode & 0o777).toBe(0o700);
      }
    }
  });

  it.runIf(POSIX)('refuses states another user owns, who could read them and replace them', () => {
    const { fileFolder, journalDir } = project();
    const me = process.getuid?.() ?? 0;

    const opened = openEnvStore({ journalDir, fileFolder, uid: () => me + 1 });

    expect(opened).toEqual({ refusal: expect.stringContaining('belongs to another user') });
  });

  it('refuses a folder of the states that is a file', () => {
    const { fileFolder, journalDir } = project();
    mkdirSync(journalDir);
    writeFileSync(join(journalDir, 'env'), '');

    expect(openEnvStore({ journalDir, fileFolder })).toEqual({
      refusal: `${join(journalDir, 'env')} is not a folder.`,
    });
  });

  it('leaves the state as it was when a write is stopped before its rename', async () => {
    const { fileFolder, journalDir } = project();
    const opened = openEnvStore({ journalDir, fileFolder });
    if (!('store' in opened)) throw new Error(opened.refusal);
    const written = await opened.store.update(stateOf(), seeding);
    const failing = openEnvStore({
      journalDir,
      fileFolder,
      rename: () => Promise.reject(new Error('stopped')),
    });
    if (!('store' in failing)) throw new Error(failing.refusal);

    await expect(
      failing.store.update(written, (s) => removalStarted(s, 'accounts')),
    ).rejects.toThrow('stopped');

    expect(await opened.store.read(ORG, 'case-flow')).toEqual(written);
    expect(readdirSync(opened.store.folderOf(ORG, 'case-flow'))).toEqual(['state.json']);
  });

  it('refuses to write over a state that moved since it was read, by serial or by lineage', async () => {
    const store = storeOf();
    const read = await store.update(stateOf(), seeding);
    await store.update(read, (s) => removalStarted(s, 'accounts'));

    const moved = await expectRefused(
      store.update(read, (s) => removalStarted(s, 'accounts')),
      'moved',
    );
    expect(moved.message).toContain('(serial 2, not 1)');
    expect(moved.message).toContain('Nothing was written: plan again.');

    // A state made afresh meanwhile, as a destroy then an apply from another job make one.
    const fresh = stateOf();
    await expectRefused(store.write(fresh, fresh), 'moved');
    await store.remove(ORG, 'case-flow');
    await expectRefused(
      store.update(read, (s) => s),
      'moved',
    );
    expect((await store.update(fresh, seeding)).serial).toBe(1);
    await expectRefused(
      store.update(read, (s) => s),
      'moved',
    );
  });

  it('writes a state over its own lineage only, and only a state that reads back', async () => {
    const store = storeOf();
    const state = stateOf();

    await expectRefused(store.write({ ...state, lineage: stateOf().lineage }, state), 'invalid');
    await expectRefused(store.write({ ...state, sandforgeVersion: 'dev' }, state), 'invalid');
    expect(await store.read(ORG, 'case-flow')).toBeUndefined();
  });
});

describe('reading a state', () => {
  it('says there is none when no apply wrote one', async () => {
    expect(await storeOf().read(ORG, 'case-flow')).toBeUndefined();
  });

  it('refuses a file that does not parse, and never writes over it', async () => {
    const store = storeOf();
    const folder = store.folderOf(ORG, 'case-flow');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'state.json'), '{"version":1,"env":"case-flow"');

    const damaged = await expectRefused(store.read(ORG, 'case-flow'), 'damaged');
    expect(damaged.message).toContain('is not used');
    const state = stateOf();
    await expectRefused(store.write(state, state), 'damaged');
    expect(readFileSync(join(folder, 'state.json'), 'utf8')).toBe('{"version":1,"env":"case-flow"');
  });

  it('refuses a state found under another org’s folder, or another environment’s', async () => {
    const store = storeOf();
    await store.update(stateOf(), seeding);
    const elsewhere = store.folderOf(OTHER_ORG, 'case-flow');
    const renamed = store.folderOf(ORG, 'other-flow');
    for (const folder of [elsewhere, renamed]) {
      mkdirSync(folder, { recursive: true });
      copyFileSync(
        join(store.folderOf(ORG, 'case-flow'), 'state.json'),
        join(folder, 'state.json'),
      );
    }

    await expectRefused(store.read(OTHER_ORG, 'case-flow'), 'otherOrg');
    await expectRefused(store.read(ORG, 'other-flow'), 'otherOrg');
  });
});

describe('listing and expiry', () => {
  it('lists every state with its date, damaged ones apart, and passes over stray folders', async () => {
    const store = storeOf();
    const scratchState = await store.update(stateOf('scratch'), seeding);
    await store.update(stateOf('developer', OTHER_ORG), seeding);
    mkdirSync(join(store.root, 'notes', 'x'), { recursive: true });
    mkdirSync(join(store.root, ORG_15, 'case-flow'), { recursive: true });
    const damagedFolder = store.folderOf(ORG, 'broken');
    mkdirSync(damagedFolder);
    writeFileSync(join(damagedFolder, 'state.json'), 'null');

    const listed = await store.list();

    expect(
      listed.map((entry) => [entry.organizationId, entry.env, entry.state !== undefined]),
    ).toEqual([
      [ORG, 'broken', false],
      [ORG, 'case-flow', true],
      [OTHER_ORG, 'case-flow', true],
    ]);
    expect(listed[0]?.damaged).toContain('does not read as a state');
    expect(listed[1]?.expiresAt).toBe(
      new Date(Date.parse(scratchState.updatedAt) + 30 * DAY).toISOString(),
    );
    expect(listed[2]?.expiresAt).toBeUndefined();
  });

  it(`expires a scratch org’s state ${SCRATCH_STATE_KEEP_DAYS} days after its last write, and no other`, () => {
    const at = '2026-10-25T12:00:00.000Z';

    expect(stateExpiresAt({ org: { ...stateOf().org, kind: 'scratch' }, updatedAt: at })).toBe(
      '2026-11-24T12:00:00.000Z',
    );
    expect(
      stateExpiresAt({ org: { ...stateOf().org, kind: 'developer' }, updatedAt: at }),
    ).toBeUndefined();
    expect(
      stateExpiresAt({ org: { ...stateOf().org, kind: 'sandbox' }, updatedAt: at }),
    ).toBeUndefined();
  });

  it('deletes the states whose date has come, names them, and keeps the rest', async () => {
    const { fileFolder, journalDir } = project();
    const open = (now: number): EnvStore => {
      const opened = openEnvStore({ journalDir, fileFolder, now: () => now });
      if (!('store' in opened)) throw new Error(opened.refusal);
      return opened.store;
    };
    await open(NOW).update(stateOf('scratch'), seeding);
    await open(NOW).update(stateOf('developer', OTHER_ORG), seeding);
    const damagedFolder = open(NOW).folderOf(ORG, 'broken');
    mkdirSync(damagedFolder);
    writeFileSync(join(damagedFolder, 'state.json'), '{}');

    expect(await open(NOW + 29 * DAY).sweep()).toEqual([]);
    const swept = await open(NOW + 30 * DAY).sweep();

    expect(swept).toEqual([
      {
        organizationId: ORG,
        env: 'case-flow',
        alias: 'pool-1',
        updatedAt: new Date(NOW).toISOString(),
        expiresAt: new Date(NOW + 30 * DAY).toISOString(),
      },
    ]);
    const store = open(NOW + 30 * DAY);
    expect(existsSync(store.folderOf(ORG, 'case-flow'))).toBe(false);
    expect(await store.read(OTHER_ORG, 'case-flow')).toBeDefined();
    expect(existsSync(damagedFolder)).toBe(true);
  });

  it('deletes an environment’s folder when asked, and says when none was kept', async () => {
    const store = storeOf();
    await store.update(stateOf(), seeding);

    expect(await store.remove(ORG, 'case-flow')).toBe(true);
    expect(await store.remove(ORG, 'case-flow')).toBe(false);
    expect(await store.read(ORG, 'case-flow')).toBeUndefined();
  });
});
