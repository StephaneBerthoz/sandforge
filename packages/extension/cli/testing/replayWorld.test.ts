import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readArchiveHeader } from '../../src/modules/checkpoint/checkpointArchive.js';
import { readReplayAnnex } from '../../src/modules/checkpoint/replay/replayAnnex.js';
import { convertCheckpoint } from '../../src/modules/checkpoint/replay/checkpointToDataset.js';
import {
  SOURCE_OWNER,
  replayCheckpointSpec,
  replayWorld,
  type ReplayWorld,
} from './replayWorld.js';

/*
 * The world a replay's command-line tests run in: its folder, a checkpoint
 * in its store, the store of replays, the other org, and the checkpoint as a
 * file — nothing of an org, nothing in the repository.
 */

const worlds: ReplayWorld[] = [];

afterEach(() => {
  for (const world of worlds.splice(0)) world.remove();
});

async function made(options: Parameters<typeof replayWorld>[0] = {}): Promise<ReplayWorld> {
  const world = await replayWorld(options);
  worlds.push(world);
  return world;
}

describe('the world of a replay from the command line', () => {
  it('keeps a checkpoint of the fixture’s records, with its annex, where the journal folder names', async () => {
    const world = await made({ accounts: 2, perAccount: 1, mark: 'w' });

    expect(world.env.SANDFORGE_JOURNAL_DIR).toBe(world.dir);
    expect(world.store.root).toBe(join(world.dir, 'checkpoints'));
    expect(world.replays.root).toBe(join(world.dir, 'replays'));
    expect(
      world.checkpoint.objects.map((object) => [object.objectApiName, object.records]),
    ).toEqual([
      ['Account', 2],
      ['Contact', 2],
    ]);
    expect((await readReplayAnnex(world.folder))?.users.map((user) => user.id)).toEqual([
      SOURCE_OWNER,
    ]);
    expect(await world.store.list()).toMatchObject([
      { checkpointId: world.checkpoint.checkpointId, valid: true },
    ]);
  });

  it('makes a checkpoint taken before 1.81 when told, without an annex, of the org it is told', async () => {
    const world = await made({
      annex: false,
      org: { tier: 'sandbox', dataStorageMaxMB: undefined },
    });

    expect(await readReplayAnnex(world.folder)).toBeUndefined();
    expect(world.checkpoint.org).not.toHaveProperty('dataStorageMaxMB');
    expect(world.checkpoint).not.toHaveProperty('replayAnnex');
  });

  it('writes the checkpoint to a file of format 2 with its key, and the file of 1.80 with its own', async () => {
    const world = await made();

    const exported = await world.exported();
    const read = await readArchiveHeader(exported.file);
    if ('refusal' in read) throw new Error(read.refusal.message);
    expect(read.read.header.formatVersion).toBe(2);
    expect(exported.key).toHaveLength(32);

    const old = world.fileOf180();
    const read180 = await readArchiveHeader(old.file);
    if ('refusal' in read180) throw new Error(read180.refusal.message);
    expect(read180.read.header).toMatchObject({ formatVersion: 1, sandforgeVersion: '1.80.0' });
  });

  it('converts into its other org, which is asked everything and the checkpoint’s org nothing', async () => {
    const world = await made({ accounts: 2, perAccount: 1 });

    const result = await convertCheckpoint({
      folder: world.folder,
      checkpoint: world.checkpoint,
      annex: await readReplayAnnex(world.folder),
      choices: {
        owners: 'same',
        customSettings: false,
        mask: false,
        contactPoints: 'neutralized',
        objects: [],
        excluded: [],
        link: [],
      },
      access: world.target.access(),
      orgId: 'target-org',
      organizationId: world.target.organizationId,
      runningUserId: world.target.runningUserId,
      tier: 'scratch',
      targetName: 'SCRATCH',
    });
    if ('refusal' in result) throw new Error(result.refusal.message);

    expect(result.conversion.summary.records.toCreate).toBe(4);
    expect(result.conversion.summary.owners).toMatchObject({
      kept: 0,
      toRunningUser: 4,
      reasons: { notInTarget: 4 },
    });
    expect(world.target.described).toEqual(['Account', 'Contact']);
  });

  it('leaves nothing once removed', async () => {
    const world = await replayWorld();

    world.remove();

    expect(existsSync(world.dir)).toBe(false);
  });

  it('builds the fixture’s records as the Frozen fixture names them', () => {
    const spec = replayCheckpointSpec({ accounts: 1, perAccount: 2, mark: 'm' });

    expect(
      spec.objects.map((object) => object.rows.map((row) => row.Name ?? row.LastName)),
    ).toEqual([['SFENV m 1'], ['SFENV m 1', 'SFENV m 2']]);
  });
});
