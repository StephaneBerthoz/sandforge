import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// What the org runs as a restore writes its records: nothing.
vi.mock('../src/modules/forge/TargetAutomationReader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/modules/forge/TargetAutomationReader.js')>()),
  TargetAutomationReader: class {
    read(_orgId: string, objects: readonly string[]) {
      return Promise.resolve({
        objectsRead: [...objects],
        objects: [],
        unread: [],
        conditionsNotRead: 0,
        conditionsBound: 0,
        requests: 0,
      });
    }
  },
}));

// The org is reached through these three, and through nothing else.
vi.mock('./sfSession.js', () => ({ loadOrg: vi.fn() }));
vi.mock('../src/core/connection/AuthProvider.js', () => ({
  AuthProvider: class {
    validateConnection = validateConnection;
  },
}));
vi.mock('../src/core/connection/ConnectionHelper.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/connection/ConnectionHelper.js')>()),
  getJsforceConnection: vi.fn(),
}));

const validateConnection = vi.hoisted(() => vi.fn());

import { loadOrg } from './sfSession.js';
import { getJsforceConnection } from '../src/core/connection/ConnectionHelper.js';
import { SlicedOrg, type SlicedRow } from '../src/test/slicedOrg.js';
import { fileConfigStore } from './fileConfigStore.js';
import { BackupSetStore } from '../src/modules/dataops/slices/backupSet.js';
import { fileRunKeys } from '../src/modules/dataops/slices/runKeyStore.js';
import { main, parseArgs, snapshotTaken, wheresOf } from './sandforge-backup.js';

/*
 * The command line of a backup in slices and of a filtered one: `--where
 * <Object>:<clause>`, `--slices`, `--list` of the sets, `--restore <set>
 * --slice`, `--delete`, against an org that pages as the org does.
 */

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** A command line, as `process.argv` hands it over. */
function argv(...args: string[]): string[] {
  return ['node', 'sandforge-backup.ts', ...args];
}

/** The `n`-th contact id. */
function idOf(n: number): string {
  return `003${String(n).padStart(12, '0')}`;
}

/** `count` contacts. */
function contactsOf(count: number): SlicedRow[] {
  return Array.from({ length: count }, (_, i) => ({
    Id: idOf(i + 1),
    LastName: `Last${i + 1}`,
    Title: 'Original',
    CreatedDate: '2020-01-01T00:00:00.000Z',
  }));
}

describe('sandforge-backup in slices and filtered', () => {
  let stdout: string;
  let stderr: string;
  let store: string;

  beforeEach(() => {
    vi.clearAllMocks();
    store = mkdtempSync(join(tmpdir(), 'sandforge-backup-slices-'));
    stdout = '';
    stderr = '';
    process.exitCode = undefined;
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(typeof code === 'number' ? code : undefined);
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    });
    vi.mocked(loadOrg).mockResolvedValue({
      alias: 'ORG',
      username: 'user@example.com',
      instanceUrl: 'https://org.example.com',
      accessToken: 'token',
    });
    validateConnection.mockResolvedValue({
      userId: '005000000000001AAA',
      username: 'user@example.com',
      displayName: 'User',
      orgId: '00D000000000001AAA',
      orgName: 'Example',
      orgType: 'Developer Edition',
      isSandbox: false,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    rmSync(store, { recursive: true, force: true });
  });

  /** Run a parse that is meant to be refused, and report the exit. */
  function refuse(...args: string[]): { code: number | undefined; message: string } {
    try {
      parseArgs(argv(...args));
    } catch (err: unknown) {
      if (err instanceof ExitCalled) return { code: err.code, message: stderr };
      throw err;
    }
    return { code: undefined, message: stderr };
  }

  /** Run the command, and the exit code it ended on; what it printed is kept apart. */
  async function run(org: SlicedOrg | undefined, ...args: string[]): Promise<number | undefined> {
    stdout = '';
    stderr = '';
    process.exitCode = undefined;
    if (org) vi.mocked(getJsforceConnection).mockResolvedValue(org.connection as never);
    try {
      await main(argv(...args, '--store', store));
    } catch (err: unknown) {
      if (err instanceof ExitCalled) return err.code;
      throw err;
    }
    return typeof process.exitCode === 'number' ? process.exitCode : undefined;
  }

  const config = () => fileConfigStore(join(store, 'snapshots.json'));
  const sets = () => new BackupSetStore(config()).list();

  describe('parseArgs', () => {
    it('reads a filter up to its first colon, a date and time in it kept whole', () => {
      expect(
        parseArgs(
          argv(
            '--org',
            'T',
            '--object',
            'Contact',
            '--object',
            'Account',
            '--where',
            'contact:CreatedDate >= 2025-01-01T08:00:00Z',
            '--slices',
          ),
        ),
      ).toMatchObject({
        objects: ['Contact', 'Account'],
        wheres: { Contact: 'CreatedDate >= 2025-01-01T08:00:00Z' },
        slices: true,
      });
      expect(parseArgs(argv('--org', 'T', '--object', 'Contact')).slices).toBe(false);
    });

    it.each([
      [
        'an object the line does not back up',
        'Lead:Email != null',
        'which the line does not back up',
      ],
      [
        'no object before the colon',
        ':Email != null',
        'Give the object, a colon and the condition',
      ],
      ['no condition after it', 'Contact:', 'Give the object, a colon and the condition'],
      [
        'a condition that goes on past it',
        'Contact:Id != null LIMIT 1',
        'Not a filter --where can take',
      ],
    ])('refuses a filter naming %s', (_label, value, words) => {
      expect(() => wheresOf([value], ['Contact'])).toThrow(ExitCalled);
      expect(stderr).toContain(words);
    });

    it('refuses two filters of one object', () => {
      expect(() =>
        wheresOf(['Contact:Email != null', 'Contact:Phone != null'], ['Contact']),
      ).toThrow(ExitCalled);
      expect(stderr).toContain('Give one --where per object: Contact is given two.');
    });

    it('refuses --where and --slices without an object to read, and --slice without a restore', () => {
      expect(refuse('--org', 'T', '--list', '--slices').message).toContain(
        '--slices goes with --object',
      );
      stderr = '';
      expect(refuse('--org', 'T', '--restore', 'x', '--where', 'Contact:Email != null').code).toBe(
        2,
      );
      stderr = '';
      const { code, message } = refuse('--org', 'T', '--object', 'Contact', '--slice', '2');
      expect(code).toBe(2);
      expect(message).toContain('--slice goes with --restore');
      expect(
        parseArgs(argv('--org', 'T', '--restore', 'set-1', '--slice', '2,1')).restoreSlices,
      ).toEqual([1, 2]);
    });

    it('reads a deletion, one thing to do among the others, of an id that names one', () => {
      expect(parseArgs(argv('--org', 'T', '--delete', 'a', '--delete', 'b')).deleteIds).toEqual([
        'a',
        'b',
      ]);
      expect(refuse('--org', 'T', '--delete', 'a', '--list').message).toContain(
        'Give one of --object, --list, --restore or --delete.',
      );
      stderr = '';
      expect(refuse('--org', 'T', '--delete', '../x').message).toContain("Not a snapshot's id");
      stderr = '';
      expect(refuse('--delete', 'a').code).toBe(2);
    });
  });

  describe('against an org', () => {
    it('backs an object up in slices, one snapshot each, and names the set and the restore that takes it: exit 0', async () => {
      const org = new SlicedOrg(contactsOf(250));

      const code = await run(
        org,
        '--org',
        'ORG',
        '--object',
        'Contact',
        '--max-records',
        '100',
        '--slices',
      );

      expect(code).toBeUndefined();
      const [set] = sets();
      expect(set).toMatchObject({ kind: 'backup', state: 'done', size: 100 });
      expect(stdout).toContain(
        `set ${set?.setId}: 250 record(s) in 3 slice(s) of up to 100 (--restore ${set?.setId} puts them back)`,
      );
      expect(org.journal.some((call) => call.kind === 'update' || call.kind === 'upsert')).toBe(
        false,
      );
    });

    it('backs up the records a filter selects, keeps the filter, and lists it', async () => {
      const org = new SlicedOrg(contactsOf(250));

      const code = await run(
        org,
        '--org',
        'ORG',
        '--object',
        'Contact',
        '--where',
        "Contact:LastName LIKE 'Last1%'",
      );

      expect(code).toBeUndefined();
      // Last1, Last10 to Last19, Last100 to Last199.
      expect(stdout).toMatch(/snapshot \S+: 111 record\(s\)/);
      const read = org.journal.find(
        (call) => call.kind === 'query' && call.soql?.includes('FROM Contact'),
      );
      expect(read?.soql).toContain("(LastName LIKE 'Last1%')");

      await run(undefined, '--list');

      expect(stdout).toMatch(
        /ORG {2}111 record\(s\) {2}Contact:111\(where LastName LIKE 'Last1%'\)/,
      );
    });

    it('lists a set of slices in one line, with when the retention removes it, and its slices nowhere else', async () => {
      const org = new SlicedOrg(contactsOf(250));
      await run(org, '--org', 'ORG', '--object', 'Contact', '--max-records', '100', '--slices');
      const [set] = sets();
      vi.mocked(loadOrg).mockClear();

      await run(undefined, '--list', '--org', 'ORG', '--max-age-days', '10');

      const expires = new Date(Date.parse(set?.lastActivityAt ?? '') + 10 * 86_400_000)
        .toISOString()
        .slice(0, 10);
      expect(stdout).toContain(
        `  ${set?.setId}  ${set?.startedAt}  ORG  Contact  3 slice(s) of up to 100  250 record(s)  backup, done  expires ${expires}`,
      );
      expect(stdout).not.toContain('-s0001  ');
      expect(loadOrg).not.toHaveBeenCalled();

      await run(undefined, '--list', '--json');

      const listed = JSON.parse(stdout) as {
        snapshots: unknown[];
        sets: Array<{ setId: string; expiresOn?: string; slices: unknown[] }>;
      };
      expect(listed.snapshots).toEqual([]);
      expect(listed.sets).toMatchObject([{ setId: set?.setId, totalRecords: 250 }]);
      expect(listed.sets[0]?.slices).toHaveLength(3);
      expect(listed.sets[0]?.expiresOn).toBeDefined();
    });

    it('lists a backup in slices that stopped part way as partial, as its help says, and never open', async () => {
      // The org stops answering past the first slice: the backup stops there.
      const org = new SlicedOrg(contactsOf(250), {
        beforeQuery: (soql) => {
          if (soql.includes(`'${idOf(100)}'`))
            throw new Error('UNABLE_TO_LOCK_ROW: the org is busy');
        },
      });
      await run(org, '--org', 'ORG', '--object', 'Contact', '--max-records', '100', '--slices');
      const [set] = sets();
      expect(set?.objects[0]?.slices).toHaveLength(1);

      await run(undefined, '--list', '--org', 'ORG');

      expect(stdout).toContain('  1 slice(s) of up to 100  100 record(s)  backup, partial  ');
      expect(stdout).not.toContain('backup, open');

      await run(undefined, '--list', '--json');

      const listed = JSON.parse(stdout) as { sets: Array<{ state: string }> };
      expect(listed.sets.map((listedSet) => listedSet.state)).toEqual(['partial']);
    });

    it('puts back one slice of a set with --slice, then the others, each slice said', async () => {
      const rows = contactsOf(250);
      const org = new SlicedOrg(rows);
      await run(org, '--org', 'ORG', '--object', 'Contact', '--max-records', '100', '--slices');
      const setId = sets()[0]?.setId ?? '';
      for (const row of org.rows) row.Title = 'Changed';

      expect(
        await run(org, '--org', 'ORG', '--restore', setId, '--slice', '2', '--yes'),
      ).toBeUndefined();

      expect(stdout).toContain('  slice 2  Contact  put back 100  refused 0  unchanged 0');
      expect(org.row(idOf(150))?.Title).toBe('Original');
      expect(org.row(idOf(50))?.Title).toBe('Changed');

      expect(await run(org, '--org', 'ORG', '--restore', setId, '--yes')).toBeUndefined();

      expect(stdout).toContain('  slice 1  Contact  put back 100  refused 0  unchanged 0');
      expect(stdout).toContain('  slice 2  Contact  put back before, not read again');
      expect(org.rows.every((row) => row.Title === 'Original')).toBe(true);
    });

    it('deletes a set from the store alone, its slices and the key of a masking set with it, contacting no org', async () => {
      const org = new SlicedOrg(contactsOf(250));
      await run(org, '--org', 'ORG', '--object', 'Contact', '--max-records', '100', '--slices');
      const setId = sets()[0]?.setId ?? '';
      // A key as a masking run in slices leaves one beside its set.
      await fileRunKeys(store).save(setId, 'a'.repeat(64));
      vi.mocked(loadOrg).mockClear();
      validateConnection.mockClear();

      const code = await run(undefined, '--org', 'ORG', '--delete', setId);

      expect(code).toBeUndefined();
      expect(stdout).toContain(`deleted ${setId}`);
      expect(sets()).toEqual([]);
      expect(config().getKeysByPrefix('backup:')).toEqual([]);
      expect(existsSync(join(store, 'keys')) ? readdirSync(join(store, 'keys')) : []).toEqual([]);
      expect(loadOrg).not.toHaveBeenCalled();
      expect(validateConnection).not.toHaveBeenCalled();
    });

    it('refuses to delete a slice alone, and says what it does not find: exit 1', async () => {
      const org = new SlicedOrg(contactsOf(250));
      await run(org, '--org', 'ORG', '--object', 'Contact', '--max-records', '100', '--slices');
      const setId = sets()[0]?.setId ?? '';

      expect(await run(undefined, '--org', 'ORG', '--delete', `${setId}-s0002`)).toBe(1);
      expect(stdout + stderr).toContain('a slice is deleted with its set');
      expect(sets()).toHaveLength(1);

      expect(await run(undefined, '--org', 'ORG', '--delete', 'nothing-here')).toBe(1);
      expect(stderr).toContain(
        `No snapshot or set nothing-here of ORG in ${store}: nothing deleted for it.`,
      );
    });
  });

  it('says a set stopped short as partial, and how to take it again: exit 3', () => {
    expect(
      snapshotTaken({
        operationId: 'set-1',
        partial: true,
        objects: [
          { objectApiName: 'Task', recordCount: 100, truncated: true, stoppedAt: 'failure' },
        ],
        slices: {
          setId: 'set-1',
          size: 100,
          state: 'open',
          objects: [
            {
              objectApiName: 'Task',
              slices: [
                {
                  index: 1,
                  objectApiName: 'Task',
                  snapshotId: 'set-1-s0001',
                  rows: 100,
                  masked: 0,
                  refused: 0,
                  deletedSince: 0,
                  nothingToMask: 0,
                  state: 'snapshotted',
                },
              ],
            },
          ],
          lateRecords: 0,
          requestsSpent: 3,
          slicesLeft: true,
        },
      }),
    ).toEqual({
      line:
        'set set-1: 100 record(s) in 1 slice(s) of up to 100 (--restore set-1 puts them back), ' +
        'partial: Task not read to its end, its reason above. The same line takes a new set of ' +
        'every record',
      exitCode: 3,
    });
  });
});
