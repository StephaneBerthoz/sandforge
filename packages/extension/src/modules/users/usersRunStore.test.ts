import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SasPathGuard, findRepoRoot } from '../frozendataset/SasPathGuard.js';
import { ACME } from './usersOrg.fixtures.js';
import { UsersRunStore, defaultUsersStoreRoot, type UsersRunRecord } from './usersRunStore.js';

/*
 * Where the runs of `sandforge users` are kept on this machine, one file a
 * run, by the Organization Id of the org they set up: what a removal takes
 * back. Ids, usernames, booleans and names of accesses — never an address,
 * never a person's name, never the org's words.
 */

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sandforge-users-'));
  dirs.push(dir);
  return dir;
}

const guard = new SasPathGuard(findRepoRoot(process.cwd()));

function storeIn(root = scratch()): UsersRunStore {
  return new UsersRunStore({ root, guard });
}

type Begun = Omit<UsersRunRecord, 'version' | 'organizationId' | 'run'>;

function running(over: Partial<Begun> = {}): Begun {
  return {
    status: 'running',
    startedAt: '2026-11-20T08:14:00.000Z',
    emailsToPeople: 0,
    users: [
      {
        applied: {
          username: 'jane.qa@acme.com.uat',
          userId: ACME.users.jane,
          before: { isActive: true, isFrozen: true, profileId: ACME.profiles.platform },
          done: [],
          created: { permissionSetAssignments: [], groupMembers: [] },
        },
        after: { isActive: true, isFrozen: true, profileId: ACME.profiles.platform },
        accesses: [],
        inFile: true,
      },
    ],
    ...over,
  };
}

describe('where the runs are kept', () => {
  it('keeps them in users/ of the commands’ folder, or of .sandforge in the home directory', () => {
    expect(defaultUsersStoreRoot({ SANDFORGE_JOURNAL_DIR: '/var/journal' })).toBe(
      resolve('/var/journal/users'),
    );
    expect(defaultUsersStoreRoot({})).toBe(join(homedir(), '.sandforge', 'users'));
  });

  it('keeps no run inside a repository', () => {
    expect(
      () => new UsersRunStore({ root: join(findRepoRoot(process.cwd()), 'users'), guard }),
    ).toThrow(/inside the repository/);
  });

  it('keeps each run its owner’s alone, in a folder of the org', async () => {
    const store = storeIn();
    const record = await store.begin(ACME.organizationId, running());

    const file = store.fileOf(ACME.organizationId, record.run);
    expect(file).toBe(join(store.root, ACME.organizationId, 'run-1.json'));
    // Windows keeps no permission bits: Node reads 0o666 there, whatever was asked.
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(join(store.root, ACME.organizationId)).mode & 0o777).toBe(0o700);
    }
  });
});

describe('the runs of an org', () => {
  it('numbers each org’s runs from 1, two runs begun at once never taking one number', async () => {
    const store = storeIn();

    const [a, b, c] = await Promise.all([
      store.begin(ACME.organizationId, running()),
      store.begin(ACME.organizationId, running()),
      store.begin(ACME.organizationId, running()),
    ]);
    const other = await store.begin('00D000000000022EAA', running());

    expect([a.run, b.run, c.run].sort()).toEqual([1, 2, 3]);
    expect(other.run).toBe(1);
  });

  it('reads a run back as written, and lists them newest first', async () => {
    const store = storeIn();
    const first = await store.begin(ACME.organizationId, running());
    const second = await store.begin(ACME.organizationId, running({ replaces: 1 }));
    await store.write({ ...second, status: 'success', endedAt: '2026-11-20T08:15:00.000Z' });

    expect(await store.read(ACME.organizationId, 1)).toEqual(first);
    expect((await store.list(ACME.organizationId)).map((run) => [run.run, run.status])).toEqual([
      [2, 'success'],
      [1, 'running'],
    ]);
    expect(await store.read(ACME.organizationId, 3)).toBeUndefined();
  });

  it('passes over a run file that does not read, rather than taking it for another', async () => {
    const store = storeIn();
    await store.begin(ACME.organizationId, running());
    writeFileSync(join(store.root, ACME.organizationId, 'run-2.json'), '{ not json');

    expect((await store.list(ACME.organizationId)).map((run) => run.run)).toEqual([1]);
    expect(await store.read(ACME.organizationId, 2)).toBeUndefined();
    expect((await store.begin(ACME.organizationId, running())).run).toBe(3);
  });
});

describe('what a run file holds', () => {
  it('keeps the code of what the org refused, never its words, which may name the person', async () => {
    const store = storeIn();
    const begun = await store.begin(ACME.organizationId, running());
    await store.write({
      ...begun,
      status: 'partial',
      users: [
        {
          ...begun.users[0],
          applied: {
            ...begun.users[0].applied,
            refused: [
              {
                change: { what: 'email', to: 'awaiting' },
                code: 'INVALID_EMAIL_ADDRESS',
                message: 'Email: invalid email address: jane.qa@acme.com (Jane Tester)',
              },
            ],
          },
        },
      ],
    });

    const text = readFileSync(store.fileOf(ACME.organizationId, begun.run), 'utf8');
    expect(text).toContain('INVALID_EMAIL_ADDRESS');
    expect(text).not.toContain('Jane Tester');
    expect(text).not.toContain('jane.qa@acme.com ');
    expect((await store.read(ACME.organizationId, begun.run))?.users[0].applied.refused).toEqual([
      {
        change: { what: 'email', to: 'awaiting' },
        code: 'INVALID_EMAIL_ADDRESS',
        message:
          'refused with INVALID_EMAIL_ADDRESS; the org’s words are not kept, as they may name the person',
      },
    ]);
  });

  it('refuses to keep a key of a user the contract does not name, an address among them', async () => {
    const store = storeIn();
    const begun = await store.begin(ACME.organizationId, running());
    const withAddress = {
      ...begun,
      users: [
        { ...begun.users[0], applied: { ...begun.users[0].applied, email: 'jane.qa@acme.com' } },
      ],
    } as unknown as UsersRunRecord;

    await expect(store.write(withAddress)).rejects.toThrow();
    expect(readFileSync(store.fileOf(ACME.organizationId, begun.run), 'utf8')).not.toContain(
      'jane.qa@acme.com"',
    );
  });
});
