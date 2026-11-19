import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { CheckpointReplayChoices } from '@sandforge/shared';

import { SasPathGuard, findRepoRoot } from '../../frozendataset/SasPathGuard.js';
import { openCheckpointStore } from '../OrgCheckpointStore.js';
import {
  REPLAY_RECORD_FILE,
  ReplayStore,
  defaultReplayStoreRoot,
  replaysInPlace,
  replaysInPlaceWords,
  type ReplayedCheckpoint,
} from './replayStore.js';

/*
 * Where a checkpoint's replays into other orgs are kept, and what lists them
 * without asking any org: outside the checkpoint's folder, so that deleting
 * the checkpoint leaves what removing its replays needs; every file named by
 * the Organization Id of the org the replay went into.
 */

const SOURCE = '00D000000000011EAA';
const TARGET = '00D000000000022EAA';
const OTHER_TARGET = '00D000000000033EAA';
const CHECKPOINT_ID = 'ck-20261110-091400-a1b2';

const CHECKPOINT: ReplayedCheckpoint = {
  checkpointId: CHECKPOINT_ID,
  name: 'recette prête',
  takenAt: '2026-11-10T09:14:00.000Z',
  org: { organizationId: SOURCE, alias: 'DEV1', tier: 'sandbox' },
};

const CHOICES: CheckpointReplayChoices = {
  owners: 'same',
  customSettings: false,
  mask: false,
  contactPoints: 'neutralized',
  objects: [],
  excluded: [],
  link: [],
};

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-replays-'));
  dirs.push(dir);
  return dir;
}

const guard = new SasPathGuard(findRepoRoot(process.cwd()));

function storeIn(dir: string, at = '2026-11-12T10:00:00.000Z'): ReplayStore {
  return new ReplayStore({ root: join(dir, 'replays'), guard, now: () => new Date(at) });
}

/** A load of `ids` into `target` kept in the replay's mapping, as the loader keeps one. */
async function loaded(
  store: ReplayStore,
  target: string,
  ids: Record<string, string>,
  endedAt = '2026-11-12T10:05:00.000Z',
): Promise<void> {
  const folder = store.folderOf(SOURCE, CHECKPOINT_ID);
  const mapping = store.mappingStoreOf(folder, target, { now: () => new Date(endedAt) });
  await mapping.persist(new Map(Object.entries(ids)), {
    created: [{ objectApiName: 'Account', referenceIds: Object.keys(ids) }],
    startedAt: new Date('2026-11-12T10:01:00.000Z'),
  });
}

describe('where replays are kept', () => {
  it('is replays/ in the commands’ own folder, beside the checkpoints', () => {
    expect(defaultReplayStoreRoot({ SANDFORGE_JOURNAL_DIR: '/data/sf' })).toBe(
      resolve('/data/sf/replays'),
    );
    expect(defaultReplayStoreRoot({})).toBe(join(homedir(), '.sandforge', 'replays'));
  });

  it('keeps a checkpoint’s replays outside its folder, its owner’s alone, and never inside a repository', async () => {
    const dir = scratch();
    const store = storeIn(dir);

    const folder = await store.record(CHECKPOINT, { organizationId: TARGET, name: 'UAT' }, CHOICES);

    expect(folder.dir).toBe(join(dir, 'replays', SOURCE, CHECKPOINT_ID));
    // Windows keeps no permission bits: Node reads 0o666 there, whatever was asked.
    if (process.platform !== 'win32') {
      expect(statSync(folder.dir).mode & 0o777).toBe(0o700);
      expect(statSync(join(folder.dir, REPLAY_RECORD_FILE)).mode & 0o777).toBe(0o600);
    }
    expect(() => new ReplayStore({ root: join(guard.repoRoot, 'replays'), guard })).toThrow(
      /inside the repository/,
    );
  });

  it('names every file of a replay by the Organization Id the other org answered with, in its 18 characters', async () => {
    const store = storeIn(scratch());
    const folder = store.folderOf(SOURCE.slice(0, 15), CHECKPOINT_ID);

    expect(store.mappingStoreOf(folder, TARGET.slice(0, 15)).filePath).toBe(
      join(folder.dir, `referenceid-mapping.${TARGET}.json`),
    );
    expect(store.contractPathOf(folder, TARGET)).toBe(
      join(folder.dir, `counting-contract.${TARGET}.json`),
    );
    expect(() => store.folderOf(SOURCE, '../etc')).toThrow(/checkpoint’s id/);
    expect(() => store.mappingStoreOf(folder, 'UAT')).toThrow(/Organization Id/);
  });

  it('keeps per org the choices replayed with and when, and nothing of a record', async () => {
    const dir = scratch();
    await storeIn(dir, '2026-11-12T10:00:00.000Z').record(
      CHECKPOINT,
      { organizationId: TARGET, name: 'UAT' },
      { ...CHOICES, ownerMap: { '005000000000002AAA': '005000000000009AAA' } },
    );
    const store = storeIn(dir, '2026-11-13T10:00:00.000Z');
    await store.record(
      CHECKPOINT,
      { organizationId: TARGET, name: 'UAT' },
      { ...CHOICES, mask: true },
    );
    await store.record(CHECKPOINT, { organizationId: OTHER_TARGET, name: 'QA' }, CHOICES);

    const record = await store.read(store.folderOf(SOURCE, CHECKPOINT_ID));

    expect(record?.checkpoint).toEqual({
      checkpointId: CHECKPOINT_ID,
      name: 'recette prête',
      organizationId: SOURCE,
      alias: 'DEV1',
      tier: 'sandbox',
      takenAt: '2026-11-10T09:14:00.000Z',
    });
    expect(
      record?.targets.map((target) => [
        target.name,
        target.firstAt,
        target.lastAt,
        target.choices.mask,
      ]),
    ).toEqual([
      ['UAT', '2026-11-12T10:00:00.000Z', '2026-11-13T10:00:00.000Z', true],
      ['QA', '2026-11-13T10:00:00.000Z', '2026-11-13T10:00:00.000Z', false],
    ]);
  });

  it('refuses choices a replay would not read, rather than keeping them', async () => {
    const store = storeIn(scratch());

    await expect(
      store.record(CHECKPOINT, { organizationId: TARGET, name: 'UAT' }, {
        ...CHOICES,
        sideways: true,
      } as CheckpointReplayChoices),
    ).rejects.toThrow();
  });
});

describe('the list of replays, no org asked', () => {
  it('lists each org a checkpoint was replayed into, with what its replays left there', async () => {
    const dir = scratch();
    const store = storeIn(dir);
    await store.record(CHECKPOINT, { organizationId: TARGET, name: 'UAT' }, CHOICES);
    await loaded(store, TARGET, {
      'Account-001000000000001AAA': '001000000000091AAA',
      'Account-001000000000002AAA': '001000000000092AAA',
    });
    await store.record(CHECKPOINT, { organizationId: OTHER_TARGET, name: 'QA' }, CHOICES);

    const listed = await store.list();

    expect(listed).toEqual([
      {
        sourceOrganizationId: SOURCE,
        checkpointId: CHECKPOINT_ID,
        checkpointName: 'recette prête',
        takenAt: '2026-11-10T09:14:00.000Z',
        target: { organizationId: TARGET, name: 'UAT' },
        choices: CHOICES,
        replayedAt: '2026-11-12T10:05:00.000Z',
        inPlace: 2,
        inPlaceByObject: [{ objectApiName: 'Account', records: 2 }],
      },
      {
        sourceOrganizationId: SOURCE,
        checkpointId: CHECKPOINT_ID,
        checkpointName: 'recette prête',
        takenAt: '2026-11-10T09:14:00.000Z',
        target: { organizationId: OTHER_TARGET, name: 'QA' },
        choices: CHOICES,
        inPlace: 0,
        inPlaceByObject: [],
      },
    ]);
    expect(await store.list({ targetOrganizationId: OTHER_TARGET.slice(0, 15) })).toHaveLength(1);
    expect(await store.list({ sourceOrganizationId: TARGET })).toEqual([]);
  });

  it('lists a replay whose replay.json does not read by its mapping, so that what it left can still be removed', async () => {
    const dir = scratch();
    const store = storeIn(dir);
    const folder = await store.record(CHECKPOINT, { organizationId: TARGET, name: 'UAT' }, CHOICES);
    await loaded(store, TARGET, { 'Account-001000000000001AAA': '001000000000091AAA' });
    writeFileSync(join(folder.dir, REPLAY_RECORD_FILE), '{"version":', 'utf8');

    expect(await store.list()).toEqual([
      expect.objectContaining({ target: { organizationId: TARGET }, inPlace: 1 }),
    ]);
  });

  it('says a replay a removal took whole is removed, and lists none of an empty store', async () => {
    const dir = scratch();
    const store = storeIn(dir);
    expect(await store.list()).toEqual([]);
    await store.record(CHECKPOINT, { organizationId: TARGET, name: 'UAT' }, CHOICES);
    await loaded(store, TARGET, { 'Account-001000000000001AAA': '001000000000091AAA' });
    const mapping = store.mappingStoreOf(store.folderOf(SOURCE, CHECKPOINT_ID), TARGET);
    await mapping.recordRemoval('2026-11-12T10:05:00.000Z', {
      gone: ['001000000000091AAA'],
      stamps: {},
      mark: {
        removedAt: '2026-11-12T11:00:00.000Z',
        deleted: 1,
        alreadyGone: 0,
        kept: 0,
        refused: 0,
      },
    });

    expect(await store.list()).toEqual([expect.objectContaining({ inPlace: 0, removed: true })]);
  });
});

describe('what a replay created', () => {
  it('is read from the mapping of its last replay into the org: what it created, never a record it linked to, last written first', async () => {
    const dir = scratch();
    const store = storeIn(dir);
    const folder = store.folderOf(SOURCE, CHECKPOINT_ID);
    // An account and a contact made, and a contact the org held under the
    // Id the checkpoint knows it by, linked.
    await store.mappingStoreOf(folder, TARGET).persist(
      new Map([
        ['001000000000001AAA', '001000000000091AAA'],
        ['003000000000001AAA', '003000000000091AAA'],
        ['003000000000002AAA', '003000000000002AAA'],
      ]),
      {
        created: [
          { objectApiName: 'Account', referenceIds: ['001000000000001AAA'] },
          { objectApiName: 'Contact', referenceIds: ['003000000000001AAA'] },
        ],
        startedAt: new Date('2026-11-12T10:01:00.000Z'),
      },
    );

    expect(await store.createdBy(folder, TARGET.slice(0, 15))).toEqual([
      { objectApiName: 'Contact', ids: ['003000000000091AAA'] },
      { objectApiName: 'Account', ids: ['001000000000091AAA'] },
    ]);
  });

  it('is nothing for an org it never went into, nor for a mapping that does not say what it created', async () => {
    const dir = scratch();
    const store = storeIn(dir);
    const folder = store.folderOf(SOURCE, CHECKPOINT_ID);
    expect(await store.createdBy(folder, TARGET)).toBeUndefined();

    await store
      .mappingStoreOf(folder, TARGET)
      .persist(new Map([['001000000000001AAA', '001000000000091AAA']]));
    expect(await store.createdBy(folder, TARGET)).toBeUndefined();
    expect(await store.createdBy(folder, OTHER_TARGET)).toBeUndefined();
  });
});

describe('a checkpoint deleted', () => {
  it('leaves its replays where they are, and names those still in place', async () => {
    const dir = scratch();
    const opened = openCheckpointStore({
      root: join(dir, 'checkpoints'),
      locksDir: join(dir, 'locks'),
    });
    if ('refusal' in opened) throw new Error(opened.refusal.reason);
    const checkpoints = opened.store;
    const folder = await checkpoints.create(SOURCE, CHECKPOINT_ID);
    writeFileSync(join(folder.dir, 'marker'), 'x');
    const replays = storeIn(dir);
    await replays.record(CHECKPOINT, { organizationId: TARGET, name: 'UAT' }, CHOICES);
    await loaded(replays, TARGET, {
      'Account-001000000000001AAA': '001000000000091AAA',
      'Account-001000000000002AAA': '001000000000092AAA',
    });
    await replays.record(CHECKPOINT, { organizationId: OTHER_TARGET, name: 'QA' }, CHOICES);

    expect((await checkpoints.delete(CHECKPOINT_ID)).outcome).toBe('deleted');

    const left = await replays.replaysOf(SOURCE, CHECKPOINT_ID);
    expect(replaysInPlace(left).map((entry) => entry.target.name)).toEqual(['UAT']);
    expect(replaysInPlaceWords(left)).toBe(
      'A replay of it is still in place: 2 records in UAT. Deleting the checkpoint leaves ' +
        'them there, and each replay is still removed without it.',
    );
    expect(replaysInPlaceWords([])).toBeUndefined();
    // The replay's folder is no part of the checkpoint store's.
    expect(readdirSync(join(dir, 'checkpoints'))).not.toContain('replays');
    expect(
      readFileSync(
        replays.mappingStoreOf(replays.folderOf(SOURCE, CHECKPOINT_ID), TARGET).filePath,
        'utf8',
      ),
    ).toContain('001000000000091AAA');
  });
});
