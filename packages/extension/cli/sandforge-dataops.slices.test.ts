import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// What the org runs as a masking or a restore writes its records: nothing,
// as an org without flows or triggers on them answers. The gate reads it
// before every write.
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
import {
  main,
  maskingInterruptedLine,
  maskingQuestion,
  parseArgs,
  sliceRefusedLines,
  sliceSetLines,
  slicePlanLines,
} from './sandforge-dataops';
import { slicesNamed } from './backupStore';

/*
 * The command line of a masking in slices: `--slices`, `--max-requests`,
 * `--resume` of a set with the key kept in the store, `--abandon`, and
 * `--restore <set> --slice`, against an org that pages and refuses as the
 * org does (`SlicedOrg`).
 */

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** A command line, as `process.argv` hands it over. */
function argv(...args: string[]): string[] {
  return ['node', 'sandforge-dataops.ts', ...args];
}

/** The `n`-th contact id: ordered by the org as by its number. */
function idOf(n: number): string {
  return `003${String(n).padStart(12, '0')}`;
}

/**
 * `count` contacts, created long before any run. The first and the last
 * share an address: masked in two slices, by two processes, they get one
 * digest only when the run's key is kept between them.
 */
function contactsOf(count: number): SlicedRow[] {
  return Array.from({ length: count }, (_, i) => {
    const n = i + 1;
    return {
      Id: idOf(n),
      FirstName: `First${n}`,
      LastName: `Last${n}`,
      Email: n === 1 || n === count ? 'shared@example.com' : `person${n}@example.com`,
      Phone: `+33 1 00 00 ${String(n % 100).padStart(2, '0')}`,
      MailingStreet: `${n} rue Example`,
      MailingCity: 'Example City',
      MailingPostalCode: '75000',
      Birthdate: '1980-01-01',
      Department: 'Unmasked',
      CreatedDate: '2020-01-01T00:00:00.000Z',
    } as SlicedRow;
  });
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

describe('sandforge-dataops in slices', () => {
  let stdout: string;
  let stderr: string;
  let store: string;

  beforeEach(() => {
    vi.clearAllMocks();
    stdout = '';
    stderr = '';
    store = mkdtempSync(join(tmpdir(), 'sandforge-dataops-slices-'));
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
    orgIs('Developer Edition');
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

  /** Run the command against `org`, and the exit code it ended on; what it printed is kept apart. */
  async function run(org: SlicedOrg, ...args: string[]): Promise<number | undefined> {
    stdout = '';
    stderr = '';
    process.exitCode = undefined;
    vi.mocked(getJsforceConnection).mockResolvedValue(org.connection as never);
    try {
      await main(argv(...args, '--store', store));
    } catch (err: unknown) {
      if (err instanceof ExitCalled) return err.code;
      throw err;
    }
    return typeof process.exitCode === 'number' ? process.exitCode : undefined;
  }

  /** The line of a run in slices of 100 contacts, every argument given after it. */
  const line = (...more: string[]): string[] => [
    'anonymize',
    '--org',
    'ORG',
    '--object',
    'Contact',
    '--template',
    'tpl-ccpa-california',
    '--max-records',
    '100',
    ...more,
  ];

  /** The sets the store keeps. */
  const sets = () => new BackupSetStore(fileConfigStore(join(store, 'snapshots.json'))).list();

  /** The keys the store keeps of sets left open. */
  const keys = (): string[] =>
    existsSync(join(store, 'keys')) ? readdirSync(join(store, 'keys')) : [];

  describe('parseArgs', () => {
    it('reads a run in slices and its bound on requests', () => {
      expect(parseArgs(argv(...line('--slices', '--max-requests', '5000')))).toMatchObject({
        mode: 'run',
        slices: true,
        maxRequests: 5000,
        maxRecords: 100,
      });
      expect(parseArgs(argv(...line())).slices).toBe(false);
    });

    it('refuses a bound on requests without --slices, which a run of the whole object has nothing to stop between', () => {
      const { code, message } = refuse(...line('--max-requests', '5000'));
      expect(code).toBe(2);
      expect(message).toContain('--max-requests bounds a run in slices: give it with --slices.');
    });

    it.each(['0', 'all', '1e6', '1000000001'])('refuses --max-requests %s', (value) => {
      const { code, message } = refuse(...line('--slices', '--max-requests', value));
      expect(code).toBe(2);
      expect(message).toContain('Not a number of requests');
    });

    it('reads the slices a restore puts back, given once or again, and refuses --slice without --restore', () => {
      expect(
        parseArgs(
          argv('anonymize', '--org', 'O', '--restore', 'set-1', '--slice', '3', '--slice', '1,3'),
        ),
      ).toMatchObject({ mode: 'restore', restoreId: 'set-1', restoreSlices: [1, 3] });
      const { code, message } = refuse(...line('--slice', '2'));
      expect(code).toBe(2);
      expect(message).toContain('--slice goes with --restore');
    });

    it.each(['0', 'two', '1,', '1;2'])('refuses --slice %s', (value) => {
      expect(() => slicesNamed([value])).toThrow(ExitCalled);
      expect(stderr).toContain("Not a slice's number");
    });

    it('reads a set given up, with the line that left it open, and refuses what a run would be bounded or rehearsed by', () => {
      expect(parseArgs(argv(...line('--slices', '--abandon', '--yes')))).toMatchObject({
        mode: 'abandon',
      });
      for (const flag of [['--dry-run'], ['--resume'], ['--max-requests', '10']]) {
        stderr = '';
        const { code, message } = refuse(...line('--slices', '--abandon', ...flag));
        expect(code).toBe(2);
        expect(message).toContain('--abandon gives a set of slices up and masks nothing: drop');
      }
    });

    it('refuses a restore given what only a run takes', () => {
      for (const flag of [['--slices'], ['--max-requests', '10'], ['--abandon']]) {
        stderr = '';
        const { code, message } = refuse('anonymize', '--org', 'O', '--restore', 's', ...flag);
        expect(code).toBe(2);
        expect(message).toContain('--restore puts a snapshot back as it is: drop');
      }
    });

    it('names its new flags in its help', () => {
      expect(refuse('--help').code).toBe(0);
      for (const flag of ['--slices', '--max-requests <n>', '--abandon', '--slice <k[,k]>']) {
        expect(stdout).toContain(flag);
      }
      expect(stdout).toContain('--slices masks in slices of this size');
    });
  });

  describe('against an org', () => {
    it('says in a dry run the slices and the plan of a run in slices, and writes nothing: exit 0', async () => {
      const org = new SlicedOrg(contactsOf(250));

      const code = await run(org, ...line('--slices', '--dry-run'));

      expect(code).toBeUndefined();
      expect(stdout).toContain(
        '    slices: 3 of up to 100 records, each backed up just before it is masked',
      );
      expect(stdout).toContain('  a run in slices:');
      expect(stdout).toMatch(
        / {4}requests: about \d+ \(snapshots \d+, updates 2, reads \d+\) of 4900000 the org has left today: fits/,
      );
      expect(stdout).toContain(
        '    Bulk API batches: none (the run writes over REST, 200 records a call)',
      );
      expect(stdout).toContain(`    disk: about `);
      expect(stdout).toContain(` in ${store} (`);
      expect(stdout).not.toContain('a run would be refused');
      expect(org.journal.some((call) => call.kind === 'update')).toBe(false);
      expect(sets()).toEqual([]);
    });

    it('masks every record in slices, each backed up first, names the set and the line that puts it back, and leaves no key: exit 0', async () => {
      const org = new SlicedOrg(contactsOf(250));

      const code = await run(org, ...line('--slices', '--yes'));

      expect(code).toBeUndefined();
      expect(
        org.rows.every(
          (row) => row.Email !== 'shared@example.com' && !String(row.Email).startsWith('person'),
        ),
      ).toBe(true);
      const [set] = sets();
      expect(set).toMatchObject({ state: 'done', size: 100 });
      expect(stdout).toContain(
        `set ${set?.setId} (done): 3 of 3 slice(s) masked, up to 100 records a slice`,
      );
      expect(stdout).toMatch(
        / {2}slice 1 {2}Contact +masked +100 record\(s\) {2}masked 100 {2}refused 0 {2}deleted since 0 {2}snapshot \S+-s0001/,
      );
      expect(stdout).toMatch(/ {2}slice 3 {2}Contact +masked +50 record\(s\)/);
      expect(stdout).toContain(
        `pnpm exec tsx packages/extension/cli/sandforge-dataops.ts anonymize --org ORG --restore ${set?.setId} --store ${store}`,
      );
      // The set is done: its key is gone with it.
      expect(keys()).toEqual([]);
    });

    it('stops between two slices on --max-requests, keeps the key in the store for its owner alone, and a resume in another process masks the rest with it: exit 3, then 0', async () => {
      const org = new SlicedOrg(contactsOf(250));

      const stopped = await run(org, ...line('--slices', '--max-requests', '7', '--yes'));

      expect(stopped).toBe(3);
      expect(stdout).toContain('Stopped between slices');
      const [open] = sets();
      expect(open?.state).toBe('open');
      const first = org.row(idOf(1));
      const last = org.row(idOf(250));
      expect(first?.Email).not.toBe('shared@example.com');
      expect(last?.Email).toBe('shared@example.com');
      // The run's key, kept for the set, readable by its owner alone.
      expect(keys()).toEqual([`${open?.setId}.key`]);
      if (process.platform !== 'win32') {
        expect(statSync(join(store, 'keys', `${open?.setId}.key`)).mode & 0o777).toBe(0o600);
      }

      // Another process: a handler of its own, which draws another key.
      const resumed = await run(org, ...line('--slices', '--resume', '--yes'));

      expect(resumed).toBeUndefined();
      expect(sets()[0]?.state).toBe('done');
      // The same address, masked in two processes, has one digest.
      expect(org.row(idOf(250))?.Email).toBe(first?.Email);
      expect(keys()).toEqual([]);
    });

    it("refuses a new run while a set of the template is open, in the handler's words, naming --resume and --abandon: exit 1, nothing masked", async () => {
      const org = new SlicedOrg(contactsOf(250));
      expect(await run(org, ...line('--slices', '--max-requests', '7', '--yes'))).toBe(3);
      const updates = org.journal.filter((call) => call.kind === 'update').length;

      const code = await run(org, ...line('--slices', '--yes'));

      expect(code).toBe(1);
      expect(stdout + stderr).toContain('A masking run of this template in slices is still open');
      expect(stdout + stderr).toContain(
        'Resume it (the same line with --resume), or give it up (--abandon)',
      );
      expect(org.journal.filter((call) => call.kind === 'update')).toHaveLength(updates);

      // A dry run says it too, and exits 1.
      expect(await run(org, ...line('--slices', '--dry-run'))).toBe(1);
      expect(stdout).toContain(
        `  a run would be refused: set ${sets()[0]?.setId} of this template is still open on the org`,
      );
    });

    it('gives up a set left open: nothing more masked, its key gone, its slices kept to restore, and a new run goes: exit 0', async () => {
      const org = new SlicedOrg(contactsOf(250));
      expect(await run(org, ...line('--slices', '--max-requests', '7', '--yes'))).toBe(3);
      const updates = org.journal.filter((call) => call.kind === 'update').length;

      const code = await run(org, ...line('--slices', '--abandon', '--yes'));

      expect(code).toBeUndefined();
      const [set] = sets();
      expect(set?.state).toBe('abandoned');
      expect(stdout).toContain(`Set ${set?.setId} given up: nothing more is masked.`);
      expect(stdout).toContain(`--restore ${set?.setId}`);
      expect(keys()).toEqual([]);
      expect(org.journal.filter((call) => call.kind === 'update')).toHaveLength(updates);

      // Nothing open: giving up again is refused, and a new run is not.
      expect(await run(org, ...line('--abandon', '--yes'))).toBe(1);
      expect(stdout + stderr).toContain('there is nothing to give up');
      expect(await run(org, ...line('--slices', '--yes'))).toBeUndefined();
    });

    it('puts back one slice of a set with --slice, then the rest with the set alone, every value as it was', async () => {
      const rows = contactsOf(250);
      const before = rows.map((row) => ({ ...row }));
      const org = new SlicedOrg(rows);
      expect(await run(org, ...line('--slices', '--yes'))).toBeUndefined();
      const setId = sets()[0]?.setId ?? '';

      const one = await run(
        org,
        'anonymize',
        '--org',
        'ORG',
        '--restore',
        setId,
        '--slice',
        '2',
        '--yes',
      );

      expect(one).toBeUndefined();
      expect(stdout).toMatch(/ {2}slice 2 {2}Contact {2}put back 100 {2}refused 0 {2}unchanged 0/);
      expect(org.row(idOf(150))?.Email).toBe('person150@example.com');
      expect(org.row(idOf(50))?.Email).not.toBe('person50@example.com');

      const rest = await run(org, 'anonymize', '--org', 'ORG', '--restore', setId, '--yes');

      expect(rest).toBeUndefined();
      expect(stdout).toMatch(/ {2}slice 1 {2}Contact {2}put back 100/);
      expect(stdout).toContain('  slice 2  Contact  put back before, not read again');
      expect(stdout).toMatch(/ {2}slice 3 {2}Contact {2}put back 50/);
      for (const row of before) {
        expect(org.row(row.Id)).toMatchObject({
          Email: row.Email,
          Phone: row.Phone,
          LastName: row.LastName,
        });
      }
    });

    it('asks before it puts a set back, naming the slices and their records', async () => {
      const org = new SlicedOrg(contactsOf(250));
      expect(await run(org, ...line('--slices', '--yes'))).toBeUndefined();
      const setId = sets()[0]?.setId ?? '';

      // No terminal to answer: the question is asked, and nothing written.
      const code = await run(
        org,
        'anonymize',
        '--org',
        'ORG',
        '--restore',
        setId,
        '--slice',
        '1,3',
      );

      expect(code).toBe(2);
      expect(stderr).toContain(
        `Put back into ORG the values set ${setId} (slice(s) 1, 3, of 3) holds? 150 record(s) of Contact will have those fields written over.`,
      );
    });
  });

  describe('what it says', () => {
    it('asks a run in slices what each slice means, and how many go today when the org is short', () => {
      const coverage = {
        type: 'dataops:anonymize:coverage:response',
        payload: {
          objects: [
            {
              objectApiName: 'Contact',
              count: 3_412_877,
              slicePlan: { objectApiName: 'Contact', size: 1_000_000, slices: 4 },
            },
          ],
          plan: {
            requests: 20_000,
            parts: { snapshots: 1_710, updates: 17_065, reads: 1_225 },
            bulkBatches: 0,
            diskBytes: 1,
            seconds: 1,
            apiBudget: { verdict: 'exceeds', remaining: 10_000, max: 15_000 },
          },
        },
      };
      expect(
        maskingQuestion(
          { mode: 'run', org: 'TGT', slices: true },
          'GDPR Standard',
          'Contact',
          coverage,
          false,
        ),
      ).toBe(
        'Mask 3412877 record(s) of Contact in TGT with GDPR Standard, in 4 slice(s)? Each slice ' +
          'is backed up just before it is masked; if one cannot be backed up whole, the run stops ' +
          'there and the slices before it stay masked with their backups. The org has 10000 ' +
          'requests left today, enough for about 2 of them: the run stops between two slices, ' +
          'and the same line with --resume masks the rest.',
      );
    });

    it('says the plan of a run in slices: requests against the day, no Bulk API batch, the disk and the time', () => {
      expect(
        slicePlanLines(
          {
            requests: 18_900,
            parts: { snapshots: 1_710, updates: 17_065, reads: 125 },
            bulkBatches: 0,
            diskBytes: 1.2 * 1024 ** 3,
            diskFree: 412 * 1024 ** 3,
            seconds: 3 * 3600 + 600,
            apiBudget: { verdict: 'fits', remaining: 4_861_233, max: 5_000_000 },
          },
          4,
          '/home/dev/.sandforge/backups',
        ),
      ).toEqual([
        '  a run in slices:',
        '    requests: about 18900 (snapshots 1710, updates 17065, reads 125) of 4861233 the org has left today: fits',
        '    Bulk API batches: none (the run writes over REST, 200 records a call)',
        '    disk: about 1.2 GB in /home/dev/.sandforge/backups (412 GB free)',
        '    time: about 3h 10min',
      ]);
    });

    it('says a run in slices would be refused for more slices than a set holds, and for a disk too short', () => {
      expect(
        sliceRefusedLines(
          {
            objects: [
              {
                objectApiName: 'Task',
                count: 300_000,
                slicePlan: { objectApiName: 'Task', size: 100, slices: 3_000 },
              },
            ],
            plan: {
              requests: 1,
              parts: { snapshots: 1, updates: 0, reads: 0 },
              bulkBatches: 0,
              diskBytes: 1_000,
              diskFree: 1_000,
              seconds: 1,
              apiBudget: { verdict: 'fits' },
            },
          },
          true,
        ),
      ).toEqual([
        'Task would take 3000 slices of 100 records, more than the 2000 a set holds: give ' +
          '--max-records up to 1000000, or narrow the run with --where',
        "the slices' snapshots take about 1.1 KB, and the store has 1000 bytes free: give " +
          '--store a folder on another disk, delete the backups no longer needed, or keep ' +
          'backups fewer days (--max-age-days)',
      ]);
    });

    it('names the set a Ctrl-C left, and the line that puts its slices back', () => {
      expect(maskingInterruptedLine('set-1')).toContain('--restore set-1 puts their values back');
      expect(maskingInterruptedLine('set-1')).toContain(
        'the same line with --resume masks the rest',
      );
      expect(maskingInterruptedLine()).toContain('the snapshot puts their values back (--restore)');
    });

    it('says a slice of rows created during the run, and no restore line for a set of no slice', () => {
      const restore = (id: string): string => `restore ${id}`;
      const lines = sliceSetLines(
        {
          setId: 'set-1',
          size: 100,
          state: 'open',
          objects: [
            {
              objectApiName: 'Contact',
              slices: [
                {
                  index: 1,
                  objectApiName: 'Contact',
                  snapshotId: 'set-1-s0001',
                  rows: 1,
                  masked: 1,
                  refused: 0,
                  deletedSince: 0,
                  nothingToMask: 0,
                  state: 'masked',
                  late: true,
                },
              ],
            },
          ],
          lateRecords: 2,
          requestsSpent: 7,
          slicesLeft: true,
        },
        restore,
      );
      expect(lines[1]).toContain('created during the run');
      expect(lines).toContain(
        '  2 record(s) created during the run in a range a slice masked, or past its last: no ' +
          'snapshot holds them, and they keep their values',
      );
      expect(lines.at(-1)).toBe('  restore set-1');
      expect(
        sliceSetLines(
          {
            setId: 'set-2',
            size: 100,
            state: 'open',
            objects: [],
            lateRecords: 0,
            requestsSpent: 0,
            slicesLeft: true,
          },
          restore,
        ),
      ).not.toContain('  restore set-2');
    });
  });
});
