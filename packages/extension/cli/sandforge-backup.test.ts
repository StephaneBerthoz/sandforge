import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// The org is reached through these three, and through nothing else: the
// session the sf CLI hands over, the query the extension types an org with,
// and the connection the handler opens.
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
import { main, parseArgs, snapshotListing, snapshotTaken } from './sandforge-backup.js';
import { fileConfigStore } from './fileConfigStore.js';

/** One day, in milliseconds. */
const DAY = 24 * 60 * 60_000;

/** A command line, as `process.argv` hands it over. */
function argv(...args: string[]): string[] {
  return ['node', 'sandforge-backup.ts', ...args];
}

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

/** Run a parse that is meant to be refused, and report the exit. */
function refuse(...args: string[]): { code: number | undefined; message: string } {
  let code: number | undefined;
  let message = '';
  vi.spyOn(process, 'exit').mockImplementation(((c?: number) => {
    code = c;
    throw new Error('exit');
  }) as never);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
    message += chunk;
    return true;
  }) as never);
  try {
    parseArgs(argv(...args));
  } catch {
    // `process.exit` is stubbed to throw so the parse stops where it would.
  }
  return { code, message };
}

describe('parseArgs', () => {
  it('reads the objects to snapshot', () => {
    const args = parseArgs(argv('--org', 'TGT', '--object', 'Account', '--object', 'Contact'));
    expect(args.org).toBe('TGT');
    expect(args.objects).toEqual(['Account', 'Contact']);
  });

  it('reads a listing', () => {
    expect(parseArgs(argv('--org', 'T', '--list')).list).toBe(true);
  });

  it('reads a restore', () => {
    expect(parseArgs(argv('--org', 'T', '--restore', 'op-1')).restoreId).toBe('op-1');
  });

  it('refuses a line with nothing to do', () => {
    expect(refuse('--org', 'T').code).toBe(2);
  });

  it('refuses two things to do at once', () => {
    // Three answers to "what should this run do" is two too many.
    const { code, message } = refuse('--org', 'T', '--list', '--object', 'Account');
    expect(code).toBe(2);
    expect(message).toContain('one of');
  });

  it('refuses an object name that is not one', () => {
    expect(refuse('--org', 'T', '--object', 'Account; DROP').code).toBe(2);
  });

  it('refuses a line with no org', () => {
    expect(refuse('--object', 'Account').code).toBe(2);
    expect(refuse('--restore', 'op-1').code).toBe(2);
  });

  it("reads a listing without an org, of every org's snapshots, and one of the org named", () => {
    // It asked for an org, then listed every org's snapshots all the same.
    const every = parseArgs(argv('--list'));
    expect(every.list).toBe(true);
    expect(every.org).toBeUndefined();
    expect(parseArgs(argv('--org', 'T', '--list'))).toMatchObject({ list: true, org: 'T' });
  });

  it('reads the cap of records per object a snapshot reads, and leaves it to the default otherwise', () => {
    expect(
      parseArgs(argv('--org', 'T', '--object', 'Contact', '--max-records', '700')).maxRecords,
    ).toBe(700);
    expect(parseArgs(argv('--org', 'T', '--object', 'Contact')).maxRecords).toBeUndefined();
  });

  it('refuses a cap that is not a number of records', () => {
    const { code, message } = refuse('--org', 'T', '--object', 'Contact', '--max-records', 'all');
    expect(code).toBe(2);
    expect(message).toContain('Not a number of records');
  });

  it('does not write without being told to, unless --yes says so', () => {
    expect(parseArgs(argv('--org', 'T', '--restore', 'op-1')).yes).toBe(false);
    expect(parseArgs(argv('--org', 'T', '--restore', 'op-1', '--yes')).yes).toBe(true);
  });

  it('writes only what differs unless --rewrite-all asks for every row', () => {
    expect(parseArgs(argv('--org', 'T', '--restore', 'op-1')).rewriteAll).toBe(false);
    expect(parseArgs(argv('--org', 'T', '--restore', 'op-1', '--rewrite-all')).rewriteAll).toBe(
      true,
    );
  });

  it('refuses --rewrite-all without a restore', () => {
    const { code, message } = refuse('--org', 'T', '--object', 'Contact', '--rewrite-all');
    expect(code).toBe(2);
    expect(message).toContain('--rewrite-all goes with --restore');
  });

  it('puts back the records changed since a Sync run only when --include-changed says so, with a restore', () => {
    expect(parseArgs(argv('--org', 'T', '--restore', 'op-1')).includeChanged).toBe(false);
    expect(
      parseArgs(argv('--org', 'T', '--restore', 'op-1', '--include-changed')).includeChanged,
    ).toBe(true);
    const { code, message } = refuse('--org', 'T', '--object', 'Contact', '--include-changed');
    expect(code).toBe(2);
    expect(message).toContain('--include-changed goes with --restore');
  });

  it('reads the retention in days, 0 keeping every snapshot, and refuses one that is not a number', () => {
    expect(parseArgs(argv('--org', 'T', '--list')).maxAgeDays).toBeUndefined();
    expect(parseArgs(argv('--org', 'T', '--list', '--max-age-days', '0')).maxAgeDays).toBe(0);
    expect(parseArgs(argv('--org', 'T', '--list', '--max-age-days', '90')).maxAgeDays).toBe(90);
    const { code, message } = refuse('--org', 'T', '--list', '--max-age-days', '30d');
    expect(code).toBe(2);
    expect(message).toContain('Not a number of days: "30d"');
  });
});

/** `count` contacts with a title each. */
function contactsOf(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, i) => ({
    Id: `003${String(i + 1).padStart(12, '0')}`,
    LastName: `Contact${i + 1}`,
    Title: 'Original',
  }));
}

/**
 * An org of contacts, read and written the way Salesforce does: every field a
 * statement names, nothing in its recycle bin, an upsert on Id that changes
 * the rows.
 */
function orgOf(rows: Array<Record<string, unknown>>) {
  const query = vi.fn(async (soql: string) => {
    if (soql === 'SELECT Id FROM Organization') {
      return { records: [{ Id: '00D000000000001AAA' }], done: true, totalSize: 1 };
    }
    if (soql.includes('IsDeleted = true')) return { records: [], done: true, totalSize: 0 };
    if (soql.startsWith('SELECT COUNT() '))
      return { records: [], done: true, totalSize: rows.length };
    const fields = /^SELECT (.+?) FROM /.exec(soql)?.[1].split(', ') ?? [];
    const records = rows.map((r) => Object.fromEntries(fields.map((f) => [f, r[f]])));
    return { records, done: true, totalSize: records.length };
  });
  const upsert = vi.fn(async (batch: Array<Record<string, unknown>>) =>
    batch.map((sent) => {
      Object.assign(rows.find((r) => r.Id === sent.Id) ?? {}, sent);
      return { success: true, id: sent.Id };
    }),
  );
  const describe = {
    name: 'Contact',
    label: 'Contact',
    createable: true,
    updateable: true,
    deletable: true,
    queryable: true,
    fields: ['Id', 'LastName', 'Title'].map((name) => ({
      name,
      label: name,
      type: name === 'Id' ? 'id' : 'string',
      createable: name !== 'Id',
      updateable: name !== 'Id',
      permissionable: name !== 'Id',
    })),
    recordTypeInfos: [],
    childRelationships: [],
  };
  vi.mocked(getJsforceConnection).mockResolvedValue({
    query,
    queryMore: vi.fn(),
    describe: vi.fn().mockResolvedValue(describe),
    sobject: vi.fn(() => ({ upsert, describe: vi.fn().mockResolvedValue(describe) })),
    soap: { undelete: vi.fn(async () => []) },
  } as never);
  return { upsert };
}

/** What the org says it is, as the extension's typing query reads it. */
function orgIs(edition: string, sandbox = false): void {
  validateConnection.mockResolvedValue({
    userId: '005000000000001AAA',
    username: 'user@example.com',
    displayName: 'User',
    orgId: '00D000000000001AAA',
    orgName: 'Example',
    orgType: edition,
    isSandbox: sandbox,
  });
}

describe('against an org', () => {
  /** Run the command with `--json`: the messages it printed, and the exit code it ended on. */
  async function run(
    store: string,
    ...args: string[]
  ): Promise<{ code: number | undefined; posted: Array<Record<string, unknown>> }> {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    });
    process.exitCode = undefined;
    await main(argv(...args, '--store', store, '--json'));
    const code = typeof process.exitCode === 'number' ? process.exitCode : undefined;
    vi.mocked(process.stdout.write).mockRestore();
    return { code, posted: (JSON.parse(out) as { posted: Array<Record<string, unknown>> }).posted };
  }

  /** The snapshot a backup run answered with. */
  const snapshotOf = (posted: Array<Record<string, unknown>>): string =>
    String(
      (posted.find((m) => m.type === 'dataops:backup:response')?.payload as { operationId: string })
        .operationId,
    );

  async function inStore(test: (store: string) => Promise<void>): Promise<void> {
    const store = mkdtempSync(join(tmpdir(), 'sandforge-backup-test-'));
    vi.mocked(loadOrg).mockResolvedValue({
      alias: 'ORG',
      username: 'user@example.com',
      instanceUrl: 'https://org.example.com',
      accessToken: 'token',
    });
    try {
      await test(store);
    } finally {
      rmSync(store, { recursive: true, force: true });
    }
  }

  it('restores a snapshot into a Developer Edition org, typed as the extension types it', async () => {
    // Handed no type nor edition, the guard took the scratch org of a real
    // restore for a production one: GUARD_DECLINED, nothing written, exit 0.
    await inStore(async (store) => {
      orgIs('Developer Edition');
      const rows = contactsOf(3);
      const { upsert } = orgOf(rows);
      const backup = await run(store, '--org', 'ORG', '--object', 'Contact');
      expect(backup.code).toBeUndefined();

      rows[0].Title = 'Changed after the backup';
      const restore = await run(
        store,
        '--org',
        'ORG',
        '--restore',
        snapshotOf(backup.posted),
        '--yes',
      );

      expect(restore.code).toBeUndefined();
      expect(upsert).toHaveBeenCalledTimes(1);
      expect(rows.map((r) => r.Title)).toEqual(['Original', 'Original', 'Original']);
      expect(restore.posted.some((m) => m.type === 'dataops:rollback:response')).toBe(true);
    });
  });

  it('restores a snapshot into a sandbox', async () => {
    await inStore(async (store) => {
      orgIs('Unlimited Edition', true);
      const rows = contactsOf(2);
      const { upsert } = orgOf(rows);
      const backup = await run(store, '--org', 'ORG', '--object', 'Contact');
      rows[1].Title = 'Changed after the backup';
      const restore = await run(
        store,
        '--org',
        'ORG',
        '--restore',
        snapshotOf(backup.posted),
        '--yes',
      );

      expect(restore.code).toBeUndefined();
      expect(upsert).toHaveBeenCalledTimes(1);
    });
  });

  it('writes back only the rows changed since the snapshot, and says how many it found unchanged', async () => {
    await inStore(async (store) => {
      orgIs('Developer Edition');
      const rows = contactsOf(5);
      const { upsert } = orgOf(rows);
      const backup = await run(store, '--org', 'ORG', '--object', 'Contact');
      rows[1].Title = 'Changed after the backup';
      rows[3].Title = 'Changed after the backup';

      const restore = await run(
        store,
        '--org',
        'ORG',
        '--restore',
        snapshotOf(backup.posted),
        '--yes',
      );

      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert.mock.calls[0][0].map((row: Record<string, unknown>) => row.Id)).toEqual([
        rows[1].Id,
        rows[3].Id,
      ]);
      expect(rows.map((r) => r.Title)).toEqual(Array(5).fill('Original'));
      expect(
        restore.posted.find((m) => m.type === 'dataops:rollback:response')?.payload,
      ).toMatchObject({
        status: 'success',
        totalRestored: 2,
        totalUnchanged: 3,
        message:
          "Rollback completed: 2 records restored; 3 already held the backup's values and were " +
          'not written',
      });
    });
  });

  it('writes every row back with --rewrite-all, the unchanged ones too', async () => {
    await inStore(async (store) => {
      orgIs('Developer Edition');
      const rows = contactsOf(3);
      const { upsert } = orgOf(rows);
      const backup = await run(store, '--org', 'ORG', '--object', 'Contact');

      const restore = await run(
        store,
        '--org',
        'ORG',
        '--restore',
        snapshotOf(backup.posted),
        '--rewrite-all',
        '--yes',
      );

      expect(upsert).toHaveBeenCalledTimes(1);
      expect(upsert.mock.calls[0][0]).toHaveLength(3);
      expect(
        restore.posted.find((m) => m.type === 'dataops:rollback:response')?.payload,
      ).toMatchObject({
        totalRestored: 3,
        totalUnchanged: 0,
        rewriteAll: true,
        message: 'Rollback completed: 3 records restored',
      });
    });
  });

  it('says on stderr each snapshot its retention removes, the one of a Sync run named, and keeps them with --max-age-days 0', async () => {
    await inStore(async (store) => {
      orgIs('Developer Edition');
      orgOf(contactsOf(1));
      const kept = fileConfigStore(join(store, 'snapshots.json'));
      // The retention has been in force here for a year; the run's snapshot is forty days old.
      kept.set('backupRetention:since', new Date(Date.now() - 365 * DAY).toISOString());
      const taken = new Date(Date.now() - 40 * DAY).toISOString();
      kept.set(
        'backup:sync-before-run-7',
        {
          operationId: 'sync-before-run-7',
          orgId: 'ORG',
          objects: [{ objectApiName: 'Account', recordCount: 1, truncated: false }],
          totalRecords: 1,
          timestamp: taken,
          origin: 'sync',
          runId: 'run-7',
        },
        'backups',
      );
      let err = '';
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        err += String(chunk);
        return true;
      });

      await run(store, '--org', 'ORG', '--object', 'Contact', '--max-age-days', '0');
      expect(err).not.toContain('removed snapshot');
      expect(
        fileConfigStore(join(store, 'snapshots.json')).get('backup:sync-before-run-7'),
      ).toBeDefined();

      await run(store, '--org', 'ORG', '--object', 'Contact');
      expect(err).toContain(
        `removed snapshot sync-before-run-7, taken ${taken}: past the retention of 30 day(s) ` +
          '(--max-age-days, 0 keeps them all). It held what the Sync run run-7 wrote over: ' +
          'removing that run with sandforge-sync --remove no longer puts those values back',
      );
      expect(
        fileConfigStore(join(store, 'snapshots.json')).get('backup:sync-before-run-7'),
      ).toBeUndefined();
    });
  });

  it('hands --include-changed to the restore, which says it put back the changed records too', async () => {
    await inStore(async (store) => {
      orgIs('Developer Edition');
      const rows = contactsOf(2);
      orgOf(rows);
      const backup = await run(store, '--org', 'ORG', '--object', 'Contact');
      rows[0].Title = 'Changed after the backup';

      const restore = await run(
        store,
        '--org',
        'ORG',
        '--restore',
        snapshotOf(backup.posted),
        '--include-changed',
        '--yes',
      );

      expect(
        restore.posted.find((m) => m.type === 'dataops:rollback:response')?.payload,
      ).toMatchObject({ includeChanged: true, totalRestored: 1 });
    });
  });

  it('refuses a restore into a production org, writes nothing and exits 1', async () => {
    await inStore(async (store) => {
      orgIs('Enterprise Edition');
      const rows = contactsOf(2);
      const { upsert } = orgOf(rows);
      const backup = await run(store, '--org', 'ORG', '--object', 'Contact');
      const restore = await run(
        store,
        '--org',
        'ORG',
        '--restore',
        snapshotOf(backup.posted),
        '--yes',
      );

      expect(restore.code).toBe(1);
      expect(upsert).not.toHaveBeenCalled();
      expect(restore.posted.find((m) => m.type === 'dataops:error')?.payload).toMatchObject({
        code: 'GUARD_DECLINED',
      });
    });
  });

  it('stops a restore asked without --yes and with no terminal to answer: exit 2, nothing written', async () => {
    // Its question waited for a terminal a CI step does not have: the job
    // hung until its timeout, or exited 0 having written nothing.
    await inStore(async (store) => {
      orgIs('Developer Edition');
      const rows = contactsOf(2);
      const { upsert } = orgOf(rows);
      const backup = await run(store, '--org', 'ORG', '--object', 'Contact');
      let stderr = '';
      vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string) => {
        stderr += chunk;
        return true;
      }) as never);
      vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`exit ${code}`);
      }) as never);
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      await expect(
        main(argv('--org', 'ORG', '--restore', snapshotOf(backup.posted), '--store', store)),
      ).rejects.toThrow('exit 2');

      expect(upsert).not.toHaveBeenCalled();
      expect(stderr).toContain('no terminal to answer: give --yes');
      // The question goes to stderr, never ahead of what stdout carries.
      expect(stdout.mock.calls.join('')).not.toContain('Upsert snapshot');
    });
  });

  it('lists the snapshots as JSON with --json, where it printed nothing', async () => {
    await inStore(async (store) => {
      orgIs('Developer Edition');
      orgOf(contactsOf(2));
      const backup = await run(store, '--org', 'ORG', '--object', 'Contact');
      let out = '';
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        out += String(chunk);
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      await main(argv('--org', 'ORG', '--list', '--store', store, '--json'));

      expect(JSON.parse(out)).toMatchObject({
        tool: 'sandforge-backup',
        snapshots: [
          {
            operationId: snapshotOf(backup.posted),
            totalRecords: 2,
            objects: [{ objectApiName: 'Contact', recordCount: 2 }],
          },
        ],
      });
    });
  });

  it("lists from the store alone, contacting no org: every org's snapshots without --org, and with it the org's, those of its Organization Id under another alias included", async () => {
    await inStore(async (store) => {
      const kept = fileConfigStore(join(store, 'snapshots.json'));
      const snapshot = (operationId: string, orgId: string, organizationId?: string): void =>
        kept.set(
          `backup:${operationId}`,
          {
            operationId,
            orgId,
            ...(organizationId !== undefined ? { organizationId } : {}),
            objects: [{ objectApiName: 'Contact', recordCount: 1, truncated: false }],
            totalRecords: 1,
            timestamp: '2026-10-22T08:00:00.000Z',
          },
          'backups',
        );
      snapshot('op-1', 'ORG', '00D000000000001AAA');
      snapshot('op-2', 'OTHER', '00D000000000002AAA');
      // The same org, taken under the alias it had before, its id in 15 characters.
      snapshot('op-3', 'RENAMED', '00D000000000001');
      // Taken before the Organization Id was recorded: its alias alone says whose it is.
      snapshot('op-4', 'OTHER');
      vi.mocked(loadOrg).mockClear();
      validateConnection.mockClear();
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const listed = async (...args: string[]): Promise<string> => {
        let out = '';
        const stdout = vi
          .spyOn(process.stdout, 'write')
          .mockImplementation((chunk: string | Uint8Array) => {
            out += String(chunk);
            return true;
          });
        await main(argv(...args, '--list', '--store', store));
        stdout.mockRestore();
        return out;
      };
      const ids = async (...args: string[]): Promise<string[]> =>
        (
          JSON.parse(await listed(...args, '--json')) as {
            snapshots: Array<{ operationId: string }>;
          }
        ).snapshots.map((meta) => meta.operationId);

      expect(await ids()).toEqual(['op-1', 'op-2', 'op-3', 'op-4']);
      expect(await ids('--org', 'ORG')).toEqual(['op-1', 'op-3']);
      expect(await ids('--org', 'OTHER')).toEqual(['op-2', 'op-4']);
      expect(await ids('--org', 'NONE')).toEqual([]);
      // Each names the org it was taken of, which a listing of every org needs.
      const [first] = (JSON.parse(await listed('--json')) as { snapshots: unknown[] }).snapshots;
      expect(first).toMatchObject({
        operationId: 'op-1',
        orgId: 'ORG',
        organizationId: '00D000000000001AAA',
      });
      expect(await listed()).toContain(
        'op-2  2026-10-22T08:00:00.000Z  OTHER  1 record(s)  Contact:1',
      );
      expect(await listed('--org', 'NONE')).toContain('No snapshot of NONE in this store.');
      expect(loadOrg).not.toHaveBeenCalled();
      expect(validateConnection).not.toHaveBeenCalled();
    });
  });

  it('names the snapshot it took, and exits 3 for one cut at --max-records', async () => {
    // Cut at the cap, it said only the type of its last message, exited 0,
    // and a restore of it put back part of the records.
    await inStore(async (store) => {
      orgIs('Developer Edition');
      orgOf(contactsOf(150));
      const whole = await run(store, '--org', 'ORG', '--object', 'Contact');
      expect(whole.code).toBeUndefined();

      const cut = await run(store, '--org', 'ORG', '--object', 'Contact', '--max-records', '100');

      expect(cut.code).toBe(3);
      expect(cut.posted.find((m) => m.type === 'dataops:backup:response')?.payload).toMatchObject({
        partial: true,
      });
    });
  });

  it('refuses --yes=true, which it dropped, before any org is reached', () => {
    vi.mocked(loadOrg).mockClear();
    expect(refuse('--org', 'T', '--restore', 'op-1', '--yes=true').code).toBe(2);
    expect(loadOrg).not.toHaveBeenCalled();
  });
});

describe('what a snapshot taken says', () => {
  it('names its id and the restore that takes it, or what it holds short of the org', () => {
    expect(
      snapshotTaken({
        operationId: 'op-1',
        totalRecords: 4,
        objects: [{ objectApiName: 'Contact', recordCount: 4, truncated: false }],
      }),
    ).toEqual({ line: 'snapshot op-1: 4 record(s) (--restore op-1 puts them back)', exitCode: 0 });
    expect(
      snapshotTaken({
        operationId: 'op-2',
        totalRecords: 100,
        partial: true,
        objects: [
          {
            objectApiName: 'Contact',
            recordCount: 100,
            truncated: true,
            orgCount: 150,
            stoppedAt: 'cap',
          },
        ],
      }),
    ).toEqual({
      line: 'snapshot op-2: 100 record(s) (partial: Contact 100 of 150 (cap))',
      exitCode: 3,
    });
  });

  it('lists each snapshot with what it holds', () => {
    expect(
      snapshotListing([
        {
          operationId: 'op-1',
          timestamp: '2026-10-22T08:00:00.000Z',
          totalRecords: 2,
          objects: [{ objectApiName: 'Contact', recordCount: 2 }],
        },
      ]),
    ).toEqual({
      tool: 'sandforge-backup',
      snapshots: [
        {
          operationId: 'op-1',
          timestamp: '2026-10-22T08:00:00.000Z',
          totalRecords: 2,
          objects: [{ objectApiName: 'Contact', recordCount: 2 }],
        },
      ],
    });
  });
});
