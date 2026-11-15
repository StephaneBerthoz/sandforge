import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  defaultBackupStoreOf,
  openBackupStore,
  restoredSliceLines,
  restoreTargetOf,
  setLine,
  toolStoreOf,
  valuesOf,
  type StoreFolderFs,
} from './backupStore.js';
import { fileConfigStore } from './fileConfigStore.js';
import { BackupSetStore, type BackupSet } from '../src/modules/dataops/slices/backupSet.js';
import { parseArgs as parseBackupArgs } from './sandforge-backup.js';
import { parseArgs as parseDataOpsArgs } from './sandforge-dataops.js';

/** Whether the system gives files an owner and permission bits the store can rely on. */
const POSIX = process.platform !== 'win32';

describe('defaultBackupStoreOf', () => {
  it('keeps the snapshots in the user’s own SandForge folder, never in the shared temp directory', () => {
    expect(defaultBackupStoreOf({})).toBe(join(homedir(), '.sandforge', 'backups'));
    expect(defaultBackupStoreOf({})).not.toContain(tmpdir());
  });

  it('goes under the folder SANDFORGE_JOURNAL_DIR names, as the clone command’s journals do', () => {
    // Resolved as the store resolves it: on Windows the folder takes the
    // current drive, which a bare join leaves out.
    expect(defaultBackupStoreOf({ SANDFORGE_JOURNAL_DIR: '/srv/runner/sandforge' })).toBe(
      join(resolve('/srv/runner/sandforge'), 'backups'),
    );
    expect(defaultBackupStoreOf({ SANDFORGE_JOURNAL_DIR: '  ' })).toBe(
      join(homedir(), '.sandforge', 'backups'),
    );
  });

  it('keeps the state of Compare and Monitor beside it, each in a folder of its own', () => {
    // Both kept it in a fixed folder of the system's temp directory.
    expect(toolStoreOf('compare', {})).toBe(join(homedir(), '.sandforge', 'compare'));
    expect(toolStoreOf('monitor', { SANDFORGE_JOURNAL_DIR: '/srv/runner/sandforge' })).toBe(
      join(resolve('/srv/runner/sandforge'), 'monitor'),
    );
    expect(toolStoreOf('compare', {})).not.toContain(tmpdir());
  });

  it('is where both command lines put their snapshots when they are told no folder', () => {
    const store = defaultBackupStoreOf();
    expect(parseBackupArgs(['node', 'sandforge-backup', '--org', 'O', '--list']).storeDir).toBe(
      store,
    );
    expect(
      parseDataOpsArgs(['node', 'sandforge-dataops', 'anonymize', '--org', 'O', '--restore', 's'])
        .storeDir,
    ).toBe(store);
  });
});

describe('openBackupStore', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-store-test-'));
    made.push(dir);
    return dir;
  };

  it.runIf(POSIX)('makes the folder readable by its owner alone', () => {
    const dir = join(scratch(), 'nested', 'backups');

    expect(openBackupStore(dir)).toBeUndefined();

    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it('opens a folder of the user’s own that is already there', () => {
    expect(openBackupStore(scratch())).toBeUndefined();
  });

  it('refuses a folder another user owns, who could read the snapshots and replace them', () => {
    const fs: StoreFolderFs = {
      mkdir: () => undefined,
      stat: () => ({ isDirectory: () => true, uid: 0 }),
      uid: () => 1000,
    };

    expect(openBackupStore('/tmp/sandforge-backups', fs)).toBe(
      'The store /tmp/sandforge-backups belongs to another user, who can read its snapshots and ' +
        'change them: name a folder of your own with --store.',
    );
  });

  it('opens any folder where the system has no owner to compare', () => {
    const fs: StoreFolderFs = {
      mkdir: () => undefined,
      stat: () => ({ isDirectory: () => true, uid: 0 }),
    };

    expect(openBackupStore('C:\\Users\\me\\.sandforge\\backups', fs)).toBeUndefined();
  });

  it('refuses a path that is a file, and says why one cannot be made', () => {
    const file = join(scratch(), 'a-file');
    writeFileSync(file, '');

    expect(openBackupStore(file)).toMatch(/^The store .* (is not a folder\.|could not be made: )/);
    expect(openBackupStore(join(file, 'under'))).toMatch(/^The store .* could not be made: /);
  });
});

describe('what a restore and a listing read of a set of slices, from the store alone', () => {
  const made: string[] = [];
  afterEach(() => {
    for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const scratch = (): string => {
    const dir = mkdtempSync(join(tmpdir(), 'sandforge-store-sets-'));
    made.push(dir);
    return dir;
  };

  /** A masking set of three slices of contacts, the second put back already, the fourth never taken. */
  function setIn(dir: string): BackupSet {
    const slice = (index: number, rows: number, extra: Record<string, unknown> = {}) => ({
      index,
      rows,
      snapshotId: `set-1-s000${index}`,
      state: 'masked' as const,
      masked: rows,
      refused: 0,
      deletedSince: 0,
      nothingToMask: 0,
      sizeUsed: 100,
      ...extra,
    });
    const set: BackupSet = {
      setId: 'set-1',
      kind: 'masking',
      orgId: 'ORG',
      size: 100,
      state: 'done',
      startedAt: '2026-11-01T08:00:00.000Z',
      lastActivityAt: '2026-11-02T08:00:00.000Z',
      requestsSpent: 12,
      objects: [
        {
          objectApiName: 'Contact',
          where: "LastName LIKE 'S%'",
          done: true,
          slices: [
            slice(1, 100),
            slice(2, 100, { state: 'restored', restoredAt: '2026-11-03T08:00:00.000Z' }),
            slice(3, 40),
            { ...slice(4, 0), state: 'pending' as const },
          ],
        },
      ],
    };
    new BackupSetStore(fileConfigStore(join(dir, 'snapshots.json'))).save(set);
    return set;
  }

  it('counts the slices a restore puts back as it chooses them: those not put back yet, every one, or those named', () => {
    const dir = scratch();
    setIn(dir);
    const store = fileConfigStore(join(dir, 'snapshots.json'));

    expect(restoreTargetOf(store, 'set-1')).toEqual({
      words: 'set set-1 (the 2 slice(s) not put back yet, of 3)',
      objects: [{ objectApiName: 'Contact', records: 140 }],
      totalRecords: 140,
    });
    expect(restoreTargetOf(store, 'set-1', { rewriteAll: true })?.totalRecords).toBe(240);
    expect(restoreTargetOf(store, 'set-1', { slices: [2] })).toMatchObject({
      words: 'set set-1 (slice(s) 2, of 3)',
      totalRecords: 100,
    });
    expect(restoreTargetOf(store, 'nothing')).toBeUndefined();
  });

  it('lists a set in one line, its filter, its slices and when the retention removes it', () => {
    const set = setIn(scratch());

    expect(setLine(set, 30)).toBe(
      "set-1  2026-11-01T08:00:00.000Z  ORG  Contact (where LastName LIKE 'S%')  4 slice(s) of up " +
        'to 100  240 record(s)  masking, done  expires 2026-12-02',
    );
    expect(setLine(set, 0)).toMatch(/kept \(--max-age-days 0\)$/);
  });

  it('lists a backup in slices that is not done as partial, a masking set left open as open', () => {
    const set = setIn(scratch());

    expect(setLine({ ...set, kind: 'backup', state: 'open' }, 30)).toContain('  backup, partial  ');
    expect(setLine({ ...set, state: 'open' }, 30)).toContain('  masking, open  ');
  });

  it('says each slice a restore reached, and one it put back before', () => {
    expect(
      restoredSliceLines({
        slices: [
          { index: 1, objectApiName: 'Contact', restored: 3, failed: 1, unchanged: 96 },
          {
            index: 2,
            objectApiName: 'Contact',
            restored: 0,
            failed: 0,
            unchanged: 0,
            skipped: true,
          },
        ],
      }),
    ).toEqual([
      '  slice 1  Contact  put back 3  refused 1  unchanged 96',
      '  slice 2  Contact  put back before, not read again (--slice or --rewrite-all puts it back again)',
    ]);
    expect(restoredSliceLines({ message: 'a snapshot' })).toEqual([]);
  });

  it('reads every value a flag is given, the flag given again', () => {
    expect(valuesOf(['--slice', '1', '--org', 'O', '--slice', '2,3'], '--slice')).toEqual([
      '1',
      '2,3',
    ]);
    expect(valuesOf(['--slice'], '--slice')).toEqual([]);
  });
});
