/**
 * The world the tests of a replay from the command line run in: a folder of
 * the test's own standing for `SANDFORGE_JOURNAL_DIR`, a checkpoint in its
 * store as a take leaves one, the store of its replays beside it, the other
 * org a replay reads and writes, and the checkpoint as a `.sfcheckpoint`
 * file with its key — or the file SandForge 1.80 exported, with its own.
 *
 * The checkpoint holds the records of the Frozen fixture's shape
 * (`frozenDataset.ts`): `n` accounts, and `perAccount` contacts under each,
 * each named `SFENV <mark> <rank>`, made up. Its org is a Developer sandbox
 * whose take kept an annex, unless the test says otherwise; the other org
 * is a scratch org (`replayOrgs.ts`), which reads and refuses as an org does.
 *
 * Nothing touches an org, and nothing lands in the repository: the folder is
 * the system's temporary one, removed by {@link ReplayWorld.remove}.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CheckpointOrg, OrgCheckpoint } from '@sandforge/shared';

import {
  ARCHIVE_EXTENSION,
  exportCheckpointArchive,
  newArchiveKey,
  parseArchiveKey,
} from '../../src/modules/checkpoint/checkpointArchive.js';
import {
  openCheckpointStore,
  type CheckpointFolder,
  type OrgCheckpointStore,
} from '../../src/modules/checkpoint/OrgCheckpointStore.js';
import { ReplayStore } from '../../src/modules/checkpoint/replay/replayStore.js';
import {
  ReplayTargetOrg,
  fabricateCheckpoint,
  idOf,
  type CheckpointSpec,
  type ReplayTargetOptions,
} from '../../src/test/replayOrgs.js';
import type { FrozenFixture } from './frozenDataset.js';

/** The user who owned the checkpoint's records, in its org. */
export const SOURCE_OWNER = idOf('005', 1);

/** The file SandForge 1.80 exported, beside this folder's sources. */
const FIXTURE_180 = join(
  __dirname,
  '..',
  '..',
  'src',
  'modules',
  'checkpoint',
  'fixtures',
  'checkpoint-1.80.sfcheckpoint.json',
);

/**
 * A checkpoint of the Frozen fixture's records: `accounts` accounts, owned by
 * {@link SOURCE_OWNER}, and `perAccount` contacts under each, ids numbered in
 * the order of their rank.
 */
export function replayCheckpointSpec(fixture: FrozenFixture): CheckpointSpec {
  const accounts = Array.from({ length: fixture.accounts }, (_, i) => ({
    Id: idOf('001', i + 1),
    Name: `SFENV ${fixture.mark} ${i + 1}`,
    OwnerId: SOURCE_OWNER,
  }));
  const contacts = accounts.flatMap((account, i) =>
    Array.from({ length: fixture.perAccount }, (_, j) => {
      const rank = i * fixture.perAccount + j + 1;
      return {
        Id: idOf('003', rank),
        LastName: `SFENV ${fixture.mark} ${rank}`,
        AccountId: account.Id,
        OwnerId: SOURCE_OWNER,
      };
    }),
  );
  return {
    objects: [
      { objectApiName: 'Account', rows: accounts },
      ...(contacts.length > 0 ? [{ objectApiName: 'Contact', rows: contacts }] : []),
    ],
  };
}

/** How the world is set up. */
export interface ReplayWorldOptions extends Partial<FrozenFixture> {
  /** What the checkpoint's org was: a Developer sandbox of 200 MB unless told. */
  org?: Partial<CheckpointOrg>;
  /** Whether its take kept an annex, as from 1.81 on: yes unless told. */
  annex?: boolean;
  /** The checkpoint's records: the fixture's unless given. */
  spec?: CheckpointSpec;
  /** The other org. */
  target?: ReplayTargetOptions;
}

/** See the module's comment. */
export interface ReplayWorld {
  /** The test's folder: what `SANDFORGE_JOURNAL_DIR` names. */
  dir: string;
  /** The environment a command line runs with, to keep its files in {@link dir}. */
  env: NodeJS.ProcessEnv;
  /** The checkpoints' store, `checkpoints/`, and the folder of its locks. */
  store: OrgCheckpointStore;
  locksDir: string;
  /** The replays' store, `replays/`. */
  replays: ReplayStore;
  checkpoint: OrgCheckpoint;
  folder: CheckpointFolder;
  /** The other org. */
  target: ReplayTargetOrg;
  /** The checkpoint written to a `.sfcheckpoint` file in {@link dir}, and its key. */
  exported(): Promise<{ file: string; key: Buffer }>;
  /** The file SandForge 1.80 exported, written in {@link dir}, and its key. */
  fileOf180(): { file: string; key: Buffer };
  /** Remove the folder and all it holds. */
  remove(): void;
}

/** Make the world: see the module's comment. */
export async function replayWorld(options: ReplayWorldOptions = {}): Promise<ReplayWorld> {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-replay-world-'));
  const locksDir = join(dir, 'locks');
  const opened = openCheckpointStore({ root: join(dir, 'checkpoints'), locksDir });
  if ('refusal' in opened) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`The world's store cannot be opened: ${opened.refusal.reason}`);
  }
  const fixture: FrozenFixture = {
    accounts: options.accounts ?? 3,
    perAccount: options.perAccount ?? 2,
    mark: options.mark ?? 'replay',
  };
  const spec = options.spec ?? replayCheckpointSpec(fixture);
  const made = await fabricateCheckpoint(opened.store, {
    ...spec,
    ...(options.org !== undefined ? { org: { ...spec.org, ...options.org } } : {}),
    ...(options.annex !== false
      ? {
          annex: spec.annex ?? {
            recordTypes: [],
            users: [
              {
                id: SOURCE_OWNER,
                username: 'ada@example.com.dev1',
                name: 'Ada Admin',
                isActive: true,
                userType: 'Standard',
              },
            ],
            queues: [],
          },
        }
      : { annex: undefined }),
  });
  let exports = 0;
  return {
    dir,
    env: { ...process.env, SANDFORGE_JOURNAL_DIR: dir },
    store: opened.store,
    locksDir,
    replays: new ReplayStore({ root: join(dir, 'replays') }),
    checkpoint: made.checkpoint,
    folder: made.folder,
    target: new ReplayTargetOrg(options.target),
    exported: async () => {
      const file = join(dir, `export-${++exports}${ARCHIVE_EXTENSION}`);
      const key = newArchiveKey();
      await exportCheckpointArchive({
        folder: made.folder,
        checkpoint: made.checkpoint,
        out: file,
        key,
        sandforgeVersion: '1.81.0',
      });
      return { file, key };
    },
    fileOf180: () => {
      const fixture180 = JSON.parse(readFileSync(FIXTURE_180, 'utf8')) as {
        key: string;
        base64: string;
      };
      const file = join(dir, `made-by-1.80${ARCHIVE_EXTENSION}`);
      writeFileSync(file, Buffer.from(fixture180.base64, 'base64'), { mode: 0o600 });
      const key = parseArchiveKey(fixture180.key);
      if (key === undefined) throw new Error('The file of 1.80 holds no key');
      return { file, key };
    },
    remove: () => rmSync(dir, { recursive: true, force: true }),
  };
}
