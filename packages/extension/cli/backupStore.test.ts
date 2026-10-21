import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { defaultBackupStoreOf, openBackupStore, type StoreFolderFs } from './backupStore.js';
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
    expect(defaultBackupStoreOf({ SANDFORGE_JOURNAL_DIR: '/srv/runner/sandforge' })).toBe(
      join('/srv/runner/sandforge', 'backups'),
    );
    expect(defaultBackupStoreOf({ SANDFORGE_JOURNAL_DIR: '  ' })).toBe(
      join(homedir(), '.sandforge', 'backups'),
    );
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
