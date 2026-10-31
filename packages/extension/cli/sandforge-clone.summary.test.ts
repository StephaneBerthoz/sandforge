import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Connection, DescribeSObjectResult } from 'jsforce';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
// The files are real; what is written is recorded, write by write.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});
vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(), makeConn: vi.fn() };
});

import { loadOrg, makeConn } from './sfSession.js';
import { selectRows, type FakeRow } from '../src/test/fakeSoql.js';
import { homedir } from 'node:os';
import {
  datedFromItsJournal,
  interruptedLine,
  journalDirOf,
  main,
  parseArgs,
  parseRunSummary,
  removalPlan,
  resumedJournalPath,
  runSummaryOfFile,
  withTheJournal,
} from './sandforge-clone';
import { ForgeRunStore, memoryRunFile } from '../src/modules/forge/ForgeRunStore.js';
import { ForgeStops } from '../src/modules/forge/ForgeStops.js';
import { nodeRunJournal } from '../src/modules/forge/ForgeRunJournal.js';

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

const ACCOUNT = '001000000000001AAA';
const CONTACT = '003000000000001AAA';
const TARGET_ORG = '00D000000000002AAA';

/** A clone of an account from SRC to TGT, with `extra` flags. */
function argv(...extra: string[]): string[] {
  return [
    'node',
    'sandforge-clone.ts',
    '--record',
    ACCOUNT,
    '--source',
    'SRC',
    '--target',
    'TGT',
    '--skip-preflight',
    ...extra,
  ];
}

/** An object as both fake orgs describe it. */
function object(
  name: string,
  keyPrefix: string,
  fields: Array<Record<string, unknown>>,
  childRelationships: Array<Record<string, unknown>> = [],
): DescribeSObjectResult {
  return {
    name,
    keyPrefix,
    createable: true,
    recordTypeInfos: [],
    childRelationships,
    fields: [
      { name: 'Id', type: 'id', createable: false, nillable: false },
      ...fields.map((f) => ({ type: 'string', createable: true, nillable: true, ...f })),
    ].map((f) => ({ referenceTo: [], relationshipName: null, cascadeDelete: false, ...f })),
  } as unknown as DescribeSObjectResult;
}

const DESCRIBES: Record<string, DescribeSObjectResult> = {
  Account: object(
    'Account',
    '001',
    [{ name: 'Name' }],
    [{ childSObject: 'Contact', field: 'AccountId', relationshipName: 'Contacts' }],
  ),
  Contact: object('Contact', '003', [
    { name: 'LastName' },
    { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
  ]),
};

const ROWS: Record<string, FakeRow[]> = {
  Account: [{ Id: ACCOUNT, Name: 'Example' }],
  Contact: [{ Id: CONTACT, LastName: 'Key', AccountId: ACCOUNT }],
};

/** A flow of the target that runs before an account is deleted. */
const ACCOUNT_GUARD = {
  ApiName: 'Account_Guard',
  Label: 'Account guard',
  TriggerType: 'RecordBeforeDelete',
  RecordTriggerType: 'Delete',
  TriggerObjectOrEvent: { QualifiedApiName: 'Account' },
  ActiveVersionId: null,
};

/** The user the fake orgs' connections are of. */
const RUN_USER = '005000000000001AAA';

/**
 * An org holding an account and its contact, a sandbox, running nothing on
 * insert; `flows` are its record-triggered flows. `onCreate` is told of each
 * object written, before its rows are created; `afterCreate` once they are,
 * before the call is answered. What it created is read back as created by
 * {@link RUN_USER}, with `alsoHeld`'s records beside it.
 */
function fakeOrg(
  flows: unknown[] = [],
  onCreate: (name: string) => void = () => {},
  orgId: string = TARGET_ORG,
  onQuery: (soql: string) => void = () => {},
  afterCreate: (name: string) => void = () => {},
  alsoHeld: Record<string, Array<Record<string, unknown>>> = {},
) {
  const written: string[] = [];
  /** What the org created, per object, each record with its id. */
  const created: Record<string, Array<Record<string, unknown>>> = {};
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const conn = {
    sobject: (name: string) => ({
      describe: async () => DESCRIBES[name],
      create: async (records: Array<Record<string, unknown>>) => {
        onCreate(name);
        written.push(name);
        const answers = records.map((record, i) => {
          const id = `${DESCRIBES[name].keyPrefix}00000000090${i}AAA`;
          (created[name] ??= []).push({ ...record, Id: id });
          return { id, success: true, errors: [] };
        });
        afterCreate(name);
        return answers;
      },
    }),
    identity: async () => ({ user_id: RUN_USER }),
    describeGlobal: async () => ({
      sobjects: Object.values(DESCRIBES).map(({ name, keyPrefix }) => ({ name, keyPrefix })),
    }),
    query: async (soql: string) => {
      onQuery(soql);
      if (soql === 'SELECT Id, IsSandbox FROM Organization LIMIT 1') {
        return page([{ Id: orgId, IsSandbox: true }]);
      }
      if (soql.includes(" ProcessType = 'Workflow'")) return page([]);
      if (soql.includes(' FROM FlowDefinitionView ')) return page(flows);
      if (soql.includes(' FROM DuplicateRule ')) return page([]);
      if (soql.includes(' FROM UserSetupEntityAccess ')) return page([]);
      if (soql.includes(' FROM RecordType ')) return page([]);
      const counted = /^SELECT COUNT\(\) FROM (\w+)$/.exec(soql);
      if (counted) return { totalSize: (ROWS[counted[1]] ?? []).length, done: true, records: [] };
      // The dates the run reads back of what it wrote.
      if (/ FROM (Account|Contact) WHERE Id IN /.test(soql) && soql.includes('CreatedDate')) {
        return page([]);
      }
      // What the run's user created as the run went, read back field by field.
      const byUser = /^SELECT (.+?) FROM (\w+) WHERE CreatedById = /.exec(soql);
      if (byUser) {
        const fields = byUser[1].split(', ');
        const held = [...(created[byUser[2]] ?? []), ...(alsoHeld[byUser[2]] ?? [])];
        return page(
          held.map((record) => Object.fromEntries(fields.map((f) => [f, record[f] ?? null]))),
        );
      }
      return page(selectRows(ROWS, soql));
    },
    queryMore: async () => page([]),
    tooling: {
      query: async () => page([]),
      queryMore: async () => page([]),
    },
    request: async () => ({}),
    metadata: { read: async () => [] },
  };
  return { conn: conn as unknown as Connection, written, created };
}

describe('sandforge-clone --summary', () => {
  let dir: string;
  let printed: string[];
  let stdout: string;
  let stderr: string;
  let orgs: Record<'SRC' | 'TGT', ReturnType<typeof fakeOrg>>;

  /** The two fake orgs answering for the aliases of `argv`. */
  function withOrgs(target = fakeOrg()): void {
    orgs = { SRC: fakeOrg(), TGT: target };
    vi.mocked(loadOrg).mockImplementation(async (alias) => ({
      alias,
      username: '',
      instanceUrl: `https://${alias.toLowerCase()}.example.com`,
      accessToken: 'token',
    }));
    vi.mocked(makeConn).mockImplementation((org) => orgs[org.alias as 'SRC' | 'TGT'].conn);
  }

  /** Run the command; the exit code it stopped on, if it stopped on one. */
  async function run(args: string[]): Promise<number | undefined> {
    try {
      await main(args);
      return undefined;
    } catch (err: unknown) {
      if (err instanceof ExitCalled) return err.code;
      throw err;
    }
  }

  /** The documents written to `path`, write by write, through the file renamed over it. */
  const writesOf = (path: string): Array<Record<string, unknown>> =>
    vi
      .mocked(writeFileSync)
      .mock.calls.filter(([written]) => written === `${path}.${process.pid}.tmp`)
      .map(([, content]) => JSON.parse(String(content)) as Record<string, unknown>);

  /** The objects a summary says the run created, by name. */
  const createdIn = (document: Record<string, unknown>): string[] =>
    (
      (document.result as { createdByObject: Array<{ objectApiName: string }> }).createdByObject ??
      []
    ).map((o) => o.objectApiName);

  beforeEach(() => {
    vi.mocked(writeFileSync).mockClear();
    dir = mkdtempSync(join(tmpdir(), 'sandforge-clone-summary-'));
    printed = [];
    stdout = '';
    stderr = '';
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
      printed.push(String(line));
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(typeof code === 'number' ? code : undefined);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('the flag', () => {
    it('takes the file to write the summary to', () => {
      const path = join(dir, 'clone-summary.json');
      expect(parseArgs(argv('--summary', path)).summary).toBe(path);
      expect(parseArgs(argv()).summary).toBeUndefined();
    });

    it('refuses a file already there, which may be the summary of an earlier run', () => {
      const path = join(dir, 'clone-summary.json');
      writeFileSync(path, '{}', 'utf8');

      expect(() => parseArgs(argv('--summary', path))).toThrow(ExitCalled);
      expect(stderr).toContain(`--summary ${path} exists, and is not overwritten`);
      expect(readFileSync(path, 'utf8')).toBe('{}');
    });

    it('refuses no file, and a run that creates nothing to take back', () => {
      expect(() => parseArgs(argv('--summary'))).toThrow(ExitCalled);
      expect(stderr).toContain('--summary wants a value. Nothing was run.');

      const path = join(dir, 'clone-summary.json');
      for (const flag of ['--list-objects', '--rehearse']) {
        stderr = '';
        expect(() => parseArgs(argv('--summary', path, flag))).toThrow(ExitCalled);
        expect(stderr).toBe(`--summary does not go with ${flag}.\n`);
      }
    });
  });

  it('writes the summary as the run goes: after each object it ended, then whole once it ends', async () => {
    withOrgs();
    const path = join(dir, 'clone-summary.json');

    expect(await run(argv('--summary', path, '--json'))).toBeUndefined();

    const writes = writesOf(path);
    expect(writes.map((document) => [createdIn(document), document.running])).toEqual([
      [['Account'], true],
      [['Account', 'Contact'], true],
      [['Account', 'Contact'], undefined],
    ]);
    // The file the run leaves is the summary --json printed, which --remove reads.
    const kept = readFileSync(path, 'utf8');
    expect(JSON.parse(kept)).toEqual(JSON.parse(stdout));
    expect(existsSync(`${path}.${process.pid}.tmp`)).toBe(false);
    const read = parseRunSummary(kept);
    expect('summary' in read && removalPlan(read.summary).map((o) => o.objectApiName)).toEqual([
      'Contact',
      'Account',
    ]);
  });

  it('stops on Ctrl-C between two objects, writes what the run created by then, and exits 130', async () => {
    const once = vi.spyOn(process, 'once');
    const listening = process.listenerCount('SIGINT');
    // Ctrl-C as the account is written: the contact is never sent.
    withOrgs(
      fakeOrg([], (name) => {
        if (name !== 'Account') return;
        const interrupt = once.mock.calls.find(([event]) => event === 'SIGINT')?.[1];
        (interrupt as () => void)();
      }),
    );
    const path = join(dir, 'clone-summary.json');

    expect(await run(argv('--summary', path))).toBe(130);

    expect(orgs.TGT.written).toEqual(['Account']);
    const kept = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(kept.interrupted).toBe(true);
    expect(createdIn(kept)).toEqual(['Account']);
    expect(stderr).toContain('interrupted: the clone stops after the call under way');
    expect(printed).toContain(interruptedLine(path));
    expect(process.listenerCount('SIGINT')).toBe(listening);
    // What --remove takes back: the account the run had created.
    const read = parseRunSummary(readFileSync(path, 'utf8'));
    expect('summary' in read && removalPlan(read.summary)).toEqual([
      { objectApiName: 'Account', ids: ['001000000000900AAA'] },
    ]);
  });

  it('stops on a SIGTERM, as Jenkins sends on abort or timeout, as on Ctrl-C, and exits 143', async () => {
    // Killed outright, the clone printed no summary, and the journal alone
    // said what it had created.
    const once = vi.spyOn(process, 'once');
    const listening = process.listenerCount('SIGTERM');
    withOrgs(
      fakeOrg([], (name) => {
        if (name !== 'Account') return;
        const stop = once.mock.calls.find(([event]) => event === 'SIGTERM')?.[1];
        (stop as () => void)();
      }),
    );
    const path = join(dir, 'clone-summary.json');

    expect(await run(argv('--summary', path))).toBe(143);

    expect(orgs.TGT.written).toEqual(['Account']);
    const kept = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(kept.interrupted).toBe(true);
    expect(createdIn(kept)).toEqual(['Account']);
    expect(process.listenerCount('SIGTERM')).toBe(listening);
  });

  it('refuses --dry-run=true, the way a pipeline writes --dry-run=$DRY_RUN, before any org is reached', async () => {
    // Dropped without a word, the clone wrote for real.
    withOrgs();
    vi.mocked(loadOrg).mockClear();

    expect(await run(argv('--dry-run=true'))).toBe(2);
    expect(await run(argv('--dryrun'))).toBe(2);

    expect(loadOrg).not.toHaveBeenCalled();
    expect(stderr).toContain('"--dry-run=true" is not read: --dry-run takes no value');
  });

  describe('--remap-csv', () => {
    it('refuses a file already there, outside the working directory or not a .csv, before any org is reached', async () => {
      // Checked once every record was written: the run wrote, then failed
      // without its summary on stdout.
      withOrgs();
      vi.spyOn(process, 'cwd').mockReturnValue(dir);
      vi.mocked(loadOrg).mockClear();
      const existing = join(dir, 'remap.csv');
      writeFileSync(existing, 'sourceId,targetId\n', 'utf8');

      expect(await run(argv('--remap-csv', existing))).toBe(2);
      expect(stderr).toContain(`--remap-csv refuses to overwrite existing file: "${existing}"`);
      expect(await run(argv('--remap-csv', join(dir, '..', 'escape.csv')))).toBe(2);
      expect(stderr).toContain('--remap-csv must stay inside cwd');
      expect(await run(argv('--remap-csv', join(dir, 'remap.txt')))).toBe(2);
      expect(stderr).toContain('--remap-csv must use a .csv extension');

      expect(loadOrg).not.toHaveBeenCalled();
      expect(orgs.TGT.written).toEqual([]);
    });

    it('keeps the summary before the table is written, and says so when a file took its place meanwhile', async () => {
      const csv = join(dir, 'remap.csv');
      vi.spyOn(process, 'cwd').mockReturnValue(dir);
      // A file made at the table's path while the run wrote.
      withOrgs(
        fakeOrg([], (name) => {
          if (name === 'Contact') writeFileSync(csv, 'theirs\n', 'utf8');
        }),
      );
      const path = join(dir, 'clone-summary.json');

      expect(await run(argv('--summary', path, '--remap-csv', csv, '--json'))).toBe(1);

      expect(readFileSync(csv, 'utf8')).toBe('theirs\n');
      const kept = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      expect(kept.running).toBeUndefined();
      expect(createdIn(kept)).toEqual(['Account', 'Contact']);
      expect(JSON.parse(stdout)).toEqual(kept);
      expect(stderr).toContain('--remap-csv refuses to overwrite existing file');
    });

    it('writes the table of the ids the run gave', async () => {
      const csv = join(dir, 'remap.csv');
      vi.spyOn(process, 'cwd').mockReturnValue(dir);
      withOrgs();

      expect(await run(argv('--remap-csv', csv))).toBeUndefined();

      expect(readFileSync(csv, 'utf8')).toContain(`"${ACCOUNT}","001000000000900AAA"`);
    });
  });

  it('prints what an interrupted run created as the --json summary, which --remove reads without --summary', async () => {
    const once = vi.spyOn(process, 'once');
    withOrgs(
      fakeOrg([], (name) => {
        if (name !== 'Account') return;
        (once.mock.calls.find(([event]) => event === 'SIGINT')?.[1] as () => void)();
      }),
    );

    expect(await run(argv('--json'))).toBe(130);

    const printedSummary = JSON.parse(stdout) as Record<string, unknown>;
    expect(printedSummary.interrupted).toBe(true);
    expect('summary' in parseRunSummary(stdout)).toBe(true);
    expect(printed).toContain(interruptedLine(undefined));
  });

  it('says before the run what may refuse a removal of its records, and gives it under removalRisks', async () => {
    withOrgs(fakeOrg([ACCOUNT_GUARD]));

    expect(await run(argv('--dry-run', '--json'))).toBeUndefined();

    const said = printed.indexOf(
      "reversibility: a removal of this run's records (--remove) may be refused in TGT:",
    );
    expect(said).toBeGreaterThan(-1);
    expect(printed[said + 1]).toBe(
      '  Account: flow "Account guard" runs before a record is deleted, and can refuse the delete',
    );
    expect(said).toBeLessThan(printed.indexOf('record-type mapping…'));
    expect((JSON.parse(stdout) as { removalRisks: unknown }).removalRisks).toEqual([
      { objectApiName: 'Account', kind: 'flow', name: 'Account guard' },
    ]);
  });

  it('says the Apex triggers it could not read as not known, instead of finding none on a delete', async () => {
    // A Standard User may not read ApexTrigger: the line said "no Apex trigger
    // on one" under the line saying the triggers could not be read.
    const target = fakeOrg();
    const tooling = (target.conn as unknown as { tooling: { query: (soql: string) => unknown } })
      .tooling;
    tooling.query = async (soql: string) => {
      if (soql.includes(' FROM ApexTrigger ')) {
        throw new Error("INVALID_TYPE: sObject type 'ApexTrigger' is not supported.");
      }
      return { totalSize: 0, done: true, records: [] };
    };
    withOrgs(target);

    expect(await run(argv('--dry-run', '--json'))).toBeUndefined();

    const said = printed.findIndex((line) => line.startsWith('reversibility:'));
    expect(printed.slice(said, said + 2)).toEqual([
      "reversibility: nothing found in TGT that refuses a removal of this run's records in what " +
        'could be read (no flow before a delete, no record that locks past Draft)',
      '  the Apex triggers could not be read: whether one refuses the removal is not known',
    ]);
  });

  it('says in plain words that the target does not tell a Standard User its data storage', async () => {
    // Its `/limits` list the daily requests and emails and no DataStorageMB:
    // the write gate printed the schema's issues as the reason, a JSON dump.
    const target = fakeOrg();
    (target.conn as unknown as { request: () => Promise<unknown> }).request = async () => ({
      DailyApiRequests: { Max: 5_000_000, Remaining: 4_998_432 },
      SingleEmail: { Max: 5_000, Remaining: 5_000 },
    });
    withOrgs(target);

    expect(await run(argv('--dry-run', '--json'))).toBeUndefined();

    expect(printed).toContain(
      '  the data storage TGT has left could not be read (the org does not tell this user its ' +
        'data storage): whether the records fit is not known',
    );
  });

  describe('Ctrl-C, through the stop the panel’s Stop takes', () => {
    /** The entries `--audit` kept in `path`. */
    const entriesOf = (path: string): Array<Record<string, unknown>> => {
      const kept = JSON.parse(readFileSync(path, 'utf8')) as Record<string, { value: string }>;
      return JSON.parse(kept['audit:trail'].value) as Array<Record<string, unknown>>;
    };
    /** Ctrl-C, as the process hears it: the clone's own handler, once it listens. */
    const pressCtrlC = (once: { mock: { calls: unknown[][] } }): void => {
      const interrupt = once.mock.calls.find(([event]) => event === 'SIGINT')?.[1];
      if (typeof interrupt !== 'function') throw new Error('the clone does not hear Ctrl-C yet');
      (interrupt as () => void)();
    };

    it('records a clone stopped before its executor had it as the panel records a run stopped before it started, and writes nothing', async () => {
      const once = vi.spyOn(process, 'once');
      // Ctrl-C as the target's record types are read, before anything is written.
      withOrgs(
        fakeOrg(
          [],
          () => {},
          TARGET_ORG,
          (soql) => {
            if (soql.includes(' FROM RecordType ')) pressCtrlC(once);
          },
        ),
      );
      const auditPath = join(dir, 'audit.json');
      const path = join(dir, 'clone-summary.json');
      const listening = process.listenerCount('SIGINT');

      expect(await run(argv('--audit', auditPath, '--summary', path))).toBe(130);

      expect(orgs.TGT.written).toEqual([]);
      expect(entriesOf(auditPath)).toEqual([
        expect.objectContaining({
          action: 'forge_execute',
          outcome: 'stopped',
          objects: [],
          details: { code: 'ABORTED_BEFORE_START' },
        }),
      ]);
      expect(printed).toContain('interrupted: the clone stopped before it wrote anything');
      // No journal was begun, and no summary: nothing to take back.
      expect(printed.some((line) => line.startsWith('journal: '))).toBe(false);
      expect(existsSync(path)).toBe(false);
      // The clone let Ctrl-C go as it ended.
      expect(process.listenerCount('SIGINT')).toBe(listening);
    });

    it('records a clone stopped part way as the panel records a run it stopped, its journal told so for --resume', async () => {
      const once = vi.spyOn(process, 'once');
      const stop = vi.spyOn(ForgeStops.prototype, 'stop');
      withOrgs(
        fakeOrg([], (name) => {
          if (name === 'Account') pressCtrlC(once);
        }),
      );
      const auditPath = join(dir, 'audit.json');
      const path = join(dir, 'clone-summary.json');

      expect(await run(argv('--audit', auditPath, '--summary', path))).toBe(130);

      // The id-less stop the panel's Stop sends with one run under way.
      expect(stop).toHaveBeenCalledTimes(1);
      expect(stop.mock.calls[0][0]).toBeUndefined();
      expect(orgs.TGT.written).toEqual(['Account']);
      const [entry, ...more] = entriesOf(auditPath);
      expect(more).toEqual([]);
      expect(entry).toMatchObject({ action: 'forge_execute', outcome: 'cancelled' });
      expect(entry.objects).toEqual([
        expect.objectContaining({ objectApiName: 'Account', created: 1, failed: 0 }),
      ]);
      const journal = String(
        (JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>).journal,
      );
      const journals = nodeRunJournal(String(process.env['SANDFORGE_JOURNAL_DIR']));
      expect(await journals.lastEndAt(journal)).toMatchObject({ status: 'cancelled' });
    });
  });

  describe('the journal, and taking a run up from it (--resume)', () => {
    /** The document a summary file holds. */
    const documentOf = (path: string): Record<string, unknown> =>
      JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

    it('keeps the journal of a run that writes, says where, and names it and its part in the summary', async () => {
      withOrgs();
      const path = join(dir, 'clone-summary.json');

      expect(await run(argv('--summary', path))).toBeUndefined();

      const document = documentOf(path);
      const journal = String(document.journal);
      expect(
        journal.startsWith(join(String(process.env['SANDFORGE_JOURNAL_DIR']), 'forge-runs')),
      ).toBe(true);
      expect(document.part).toBe(0);
      expect(printed).toContain(
        `journal: ${journal} (--resume ${journal} takes the run up if it stops)`,
      );
      const journals = nodeRunJournal(String(process.env['SANDFORGE_JOURNAL_DIR']));
      expect(await journals.lastEndAt(journal)).toMatchObject({ status: 'success' });
      // A dry run keeps none.
      expect(await run(argv('--dry-run', '--summary', join(dir, 'dry.json')))).toBeUndefined();
      expect(documentOf(join(dir, 'dry.json')).journal).toBeUndefined();
    });

    it('takes a run Ctrl-C stopped up where it stopped: what it wrote linked to, the rest written, both removed from the journal', async () => {
      const once = vi.spyOn(process, 'once');
      let stopOnAccount = true;
      withOrgs(
        fakeOrg([], (name) => {
          if (name !== 'Account' || !stopOnAccount) return;
          (once.mock.calls.find(([event]) => event === 'SIGINT')?.[1] as () => void)();
        }),
      );
      const first = join(dir, 'first.json');
      expect(await run(argv('--summary', first))).toBe(130);
      expect(orgs.TGT.written).toEqual(['Account']);
      const journal = String(documentOf(first).journal);

      stopOnAccount = false;
      const second = join(dir, 'second.json');
      expect(await run(argv('--summary', second, '--resume', journal))).toBeUndefined();

      // The account was not written again: the contact alone, under it.
      expect(orgs.TGT.written).toEqual(['Account', 'Contact']);
      const resumed = documentOf(second);
      expect(resumed.journal).toBe(journal);
      expect(resumed.part).toBe(1);
      expect(createdIn(resumed)).toEqual(['Contact']);
      expect((resumed.result as { linkedCount: number }).linkedCount).toBe(1);
      expect(printed).toContain(`taking up the run of ${journal}`);
      // The journal says every part: what both created, as one run.
      const whole = await runSummaryOfFile(journal, readFileSync(journal, 'utf8'), 'TGT');
      expect('summary' in whole && removalPlan(whole.summary)).toEqual([
        { objectApiName: 'Contact', ids: ['003000000000900AAA'] },
        { objectApiName: 'Account', ids: ['001000000000900AAA'] },
      ]);
    });

    it('takes a muted run up muted, though --resume is given without --mute-automation', async () => {
      const once = vi.spyOn(process, 'once');
      let stopOnAccount = true;
      withOrgs(
        fakeOrg([], (name) => {
          if (name !== 'Account' || !stopOnAccount) return;
          (once.mock.calls.find(([event]) => event === 'SIGINT')?.[1] as () => void)();
        }),
      );
      const first = join(dir, 'first.json');
      expect(await run(argv('--summary', first, '--mute-automation'))).toBe(130);
      const journal = String(documentOf(first).journal);
      const journals = nodeRunJournal(String(process.env['SANDFORGE_JOURNAL_DIR']));
      expect((await journals.headAt(journal))?.resume?.muteAutomation).toBe(true);

      stopOnAccount = false;
      printed.length = 0;
      expect(
        await run(argv('--summary', join(dir, 'second.json'), '--resume', journal)),
      ).toBeUndefined();

      expect(printed).toContain('  mute: the run taken up was muted, and so is this part of it');
      expect(printed.some((line) => line.startsWith('  mute: '))).toBe(true);
    });

    it('takes up by its run id a run whose process was killed, its journal left with no end', async () => {
      withOrgs();
      const path = join(dir, 'clone-summary.json');
      expect(await run(argv('--summary', path))).toBeUndefined();
      const journal = String(documentOf(path).journal);
      // The end the run wrote, taken off as a killed process never wrote it.
      writeFileSync(
        journal,
        readFileSync(journal, 'utf8')
          .split('\n')
          .filter((line) => !line.startsWith('{"end"'))
          .join('\n'),
      );
      rmSync(journal.replace(/\.ndjson$/, '.end.json'));
      const runId =
        journal
          .split(/[\\/]/)
          .pop()
          ?.replace(/\.ndjson$/, '') ?? '';

      expect(
        await run(argv('--summary', join(dir, 'again.json'), '--resume', runId)),
      ).toBeUndefined();

      // Everything was written by the first part: linked to, nothing written again.
      expect(orgs.TGT.written).toEqual(['Account', 'Contact']);
      expect(
        (documentOf(join(dir, 'again.json')).result as { linkedCount: number }).linkedCount,
      ).toBe(2);
    });

    describe('a run whose insert call was under way when it stopped: the org wrote it, its answer was lost', () => {
      /** Whether the connection breaks once the org has written the contact. */
      let breaks = true;
      /** The connection broken once the org has written the contact: the call may have written it. */
      const brokenAfterTheContact = (name: string): void => {
        if (name !== 'Contact' || !breaks) return;
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      };

      beforeEach(() => {
        breaks = true;
      });

      /**
       * The journal of the run `summary` names, as a process killed during
       * that call leaves it: no end, the call's answer never kept. The
       * connection is whole again.
       */
      const killedDuringTheCall = (summary: string): string => {
        const journal = String(documentOf(summary).journal);
        writeFileSync(
          journal,
          readFileSync(journal, 'utf8')
            .split('\n')
            .filter((line) => !line.startsWith('{"end"'))
            .join('\n'),
        );
        rmSync(journal.replace(/\.ndjson$/, '.end.json'));
        breaks = false;
        return journal;
      };

      it('finds the contact in the target before it is taken up, and writes it no second time', async () => {
        withOrgs(
          fakeOrg(
            [],
            () => {},
            TARGET_ORG,
            () => {},
            brokenAfterTheContact,
          ),
        );
        const first = join(dir, 'first.json');
        await run(argv('--summary', first));
        expect(orgs.TGT.written).toEqual(['Account', 'Contact']);
        const journal = killedDuringTheCall(first);
        expect(readFileSync(journal, 'utf8')).toMatch(/^\["x",/m);

        const second = join(dir, 'second.json');
        expect(await run(argv('--summary', second, '--resume', journal))).toBeUndefined();

        expect(printed).toContain(
          '  found in TGT, kept as written by the run and not written again: 1 Contact',
        );
        // Nothing written again: the account and the contact are the first part's.
        expect(orgs.TGT.written).toEqual(['Account', 'Contact']);
        expect((documentOf(second).result as { linkedCount: number }).linkedCount).toBe(2);
        // The journal, every part of it, takes both back.
        const whole = await runSummaryOfFile(journal, readFileSync(journal, 'utf8'), 'TGT');
        expect('summary' in whole && removalPlan(whole.summary)).toEqual([
          { objectApiName: 'Contact', ids: ['003000000000900AAA'] },
          { objectApiName: 'Account', ids: ['001000000000900AAA'] },
        ]);
      });

      it('stops before it writes when the target holds records it cannot tell from the call, unless told to write them', async () => {
        // A contact like the one the call sent, created by the same user since.
        const twin = { Id: '003000000000777AAA', LastName: 'Key', AccountId: '001000000000900AAA' };
        withOrgs(
          fakeOrg(
            [],
            () => {},
            TARGET_ORG,
            () => {},
            brokenAfterTheContact,
            { Contact: [twin] },
          ),
        );
        const first = join(dir, 'first.json');
        await run(argv('--summary', first));
        const journal = killedDuringTheCall(first);

        expect(await run(argv('--resume', journal))).toBe(2);
        expect(stderr).toContain('1 row(s) may already be in TGT (1 Contact)');
        expect(stderr).toContain('--write-uncertain');
        expect(orgs.TGT.written).toEqual(['Account', 'Contact']);

        expect(await run(argv('--resume', journal, '--write-uncertain'))).toBeUndefined();
        expect(orgs.TGT.written).toEqual(['Account', 'Contact', 'Contact']);
      });

      it('takes --write-uncertain with --resume alone', () => {
        expect(() => parseArgs(argv('--write-uncertain'))).toThrow(ExitCalled);
        expect(stderr).toContain('--write-uncertain goes with --resume');
        expect(parseArgs(argv('--resume', 'some-run', '--write-uncertain')).writeUncertain).toBe(
          true,
        );
      });
    });

    it('refuses to take up a run that ended, one of another org, and one set up otherwise', async () => {
      withOrgs();
      const path = join(dir, 'clone-summary.json');
      expect(await run(argv('--summary', path))).toBeUndefined();
      const journal = String(documentOf(path).journal);

      expect(await run(argv('--resume', journal))).toBe(2);
      expect(stderr).toContain('the run ended, and there is nothing of it to take up.');

      // Its end taken off: as a run that stopped.
      rmSync(journal.replace(/\.ndjson$/, '.end.json'));
      writeFileSync(
        journal,
        readFileSync(journal, 'utf8')
          .split('\n')
          .filter((line) => !line.startsWith('{"end"'))
          .join('\n'),
      );
      stderr = '';
      expect(await run(argv('--resume', journal, '--exclude', 'Contact.LastName'))).toBe(2);
      expect(stderr).toContain('The clone is set up otherwise than the run to take up');

      stderr = '';
      withOrgs(fakeOrg([], () => {}, '00D000000000003AAA'));
      expect(await run(argv('--resume', journal))).toBe(2);
      expect(stderr).toContain('TGT is not the org the run to take up wrote to');
      expect(orgs.TGT.written).toEqual([]);
    });

    it('keeps its journals in SANDFORGE_JOURNAL_DIR, or in the home directory, and reads a run id in them', () => {
      expect(journalDirOf({ SANDFORGE_JOURNAL_DIR: dir })).toBe(dir);
      expect(journalDirOf({})).toBe(join(homedir(), '.sandforge'));
      const journals = nodeRunJournal(dir);
      expect(resumedJournalPath('sandforge-clone-run', journals)).toBe(
        join(dir, 'forge-runs', 'sandforge-clone-run.ndjson'),
      );
      expect(resumedJournalPath(join(dir, 'kept.ndjson'), journals)).toBe(join(dir, 'kept.ndjson'));
    });

    it('hands the run its journal, and keeps the ids there past 50 000 records', () => {
      const store = ForgeRunStore.open(memoryRunFile());
      expect(withTheJournal({ stream: { ceiling: 10 } }, store).stream).toEqual({
        ceiling: 10,
        store,
        summaryBound: 50_000,
      });
      expect(withTheJournal({ stream: { ceiling: 10 } }, undefined)).toEqual({
        stream: { ceiling: 10 },
      });
    });

    it('refuses --resume with nothing to take up, and with a run that writes nothing', () => {
      expect(() => parseArgs(argv('--resume'))).toThrow(ExitCalled);
      expect(stderr).toContain('--resume wants a value. Nothing was run.');
      for (const flag of ['--dry-run', '--rehearse', '--list-objects']) {
        stderr = '';
        expect(() => parseArgs(argv('--resume', 'run-1', flag))).toThrow(ExitCalled);
        expect(stderr).toBe(`--resume takes a run up and writes: it does not go with ${flag}.\n`);
      }
      expect(parseArgs(argv('--resume', 'run-1')).resume).toBe('run-1');
    });

    it('reads from the journal the ids a summary past its bound leaves there', async () => {
      withOrgs();
      const path = join(dir, 'clone-summary.json');
      expect(await run(argv('--summary', path))).toBeUndefined();
      const document = documentOf(path);
      const result = document.result as Record<string, unknown>;
      // As a run past the bound writes it: the counts, and no id.
      const bounded = {
        ...document,
        result: {
          ...result,
          remapInJournal: true,
          remapTable: {},
          existingSourceIds: [],
          updatedSourceIds: [],
          createdByObject: [],
        },
      };
      const read = await runSummaryOfFile(path, JSON.stringify(bounded), 'TGT');
      expect('summary' in read && removalPlan(read.summary)).toEqual([
        { objectApiName: 'Contact', ids: ['003000000000900AAA'] },
        { objectApiName: 'Account', ids: ['001000000000900AAA'] },
      ]);
      const unnamed = await runSummaryOfFile(
        path,
        JSON.stringify({ ...bounded, journal: undefined }),
        'TGT',
      );
      expect(unnamed).toEqual({
        refusal: 'keeps the ids of its records in a journal it does not name.',
      });
    });

    it('takes the ids of a summary from its journal whenever it is there: the journal is written call by call', async () => {
      withOrgs();
      const path = join(dir, 'clone-summary.json');
      expect(await run(argv('--summary', path))).toBeUndefined();
      const document = documentOf(path);
      const result = document.result as Record<string, unknown>;
      // As a killed run of whole tables leaves it: what it said when its last
      // object ended, short of what the journal holds.
      const behind = {
        ...document,
        running: true,
        result: {
          ...result,
          remapTable: { [ACCOUNT]: '001000000000900AAA' },
          existingSourceIds: [],
          updatedSourceIds: [],
          createdByObject: [{ objectApiName: 'Account', sourceIds: [ACCOUNT] }],
        },
      };
      const read = await runSummaryOfFile(path, JSON.stringify(behind), 'TGT');
      expect('summary' in read && removalPlan(read.summary)).toEqual([
        { objectApiName: 'Contact', ids: ['003000000000900AAA'] },
        { objectApiName: 'Account', ids: ['001000000000900AAA'] },
      ]);
      // The journal gone, the summary's own ids stand.
      rmSync(String(document.journal));
      const alone = await runSummaryOfFile(path, JSON.stringify(behind), 'TGT');
      expect('summary' in alone && removalPlan(alone.summary)).toEqual([
        { objectApiName: 'Account', ids: ['001000000000900AAA'] },
      ]);
    });

    it('dates a summary taken from its journal alone by its first and last records, as the target dated them', async () => {
      withOrgs();
      const path = join(dir, 'clone-summary.json');
      expect(await run(argv('--summary', path))).toBeUndefined();
      const journal = String(documentOf(path).journal);
      const read = await runSummaryOfFile(journal, readFileSync(journal, 'utf8'), 'TGT');
      if (!('summary' in read)) throw new Error('no summary');
      expect(read.summary.result.writtenBetween).toBeUndefined();
      const asked: string[] = [];
      const created: Record<string, string> = {
        '001000000000900AAA': '2026-10-20T10:00:01.000+0000',
        '003000000000900AAA': '2026-10-20T10:04:30.000+0000',
      };
      const conn = {
        query: async (soql: string) => {
          asked.push(soql);
          const id = /Id = '(\w+)'/.exec(soql)?.[1] ?? '';
          return { totalSize: 1, done: true, records: [{ CreatedDate: created[id] }] };
        },
      } as unknown as Connection;

      const dated = await datedFromItsJournal(conn, read.summary);

      expect(dated.result.writtenBetween).toEqual({
        first: '2026-10-20T10:00:01.000Z',
        last: '2026-10-20T10:04:30.000Z',
      });
      expect(asked).toEqual([
        "SELECT CreatedDate FROM Account WHERE Id = '001000000000900AAA'",
        "SELECT CreatedDate FROM Contact WHERE Id = '003000000000900AAA'",
      ]);
      // A summary that says its window keeps it.
      expect(await datedFromItsJournal(conn, dated)).toBe(dated);
    });
  });
});
