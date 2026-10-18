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
import { main, parseArgs } from './sandforge-backup.js';

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
});
