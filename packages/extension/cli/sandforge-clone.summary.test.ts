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
import { interruptedLine, main, parseArgs, parseRunSummary, removalPlan } from './sandforge-clone';

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

/**
 * An org holding an account and its contact, a sandbox, running nothing on
 * insert; `flows` are its record-triggered flows. `onCreate` is told of each
 * object written, before its rows are created.
 */
function fakeOrg(flows: unknown[] = [], onCreate: (name: string) => void = () => {}) {
  const written: string[] = [];
  const page = (records: unknown[]) => ({ totalSize: records.length, done: true, records });
  const conn = {
    sobject: (name: string) => ({
      describe: async () => DESCRIBES[name],
      create: async (records: unknown[]) => {
        onCreate(name);
        written.push(name);
        return records.map((_, i) => ({
          id: `${DESCRIBES[name].keyPrefix}00000000090${i}AAA`,
          success: true,
          errors: [],
        }));
      },
    }),
    describeGlobal: async () => ({
      sobjects: Object.values(DESCRIBES).map(({ name, keyPrefix }) => ({ name, keyPrefix })),
    }),
    query: async (soql: string) => {
      if (soql === 'SELECT Id, IsSandbox FROM Organization LIMIT 1') {
        return page([{ Id: TARGET_ORG, IsSandbox: true }]);
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
  return { conn: conn as unknown as Connection, written };
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
      expect(stderr).toContain('--summary takes the file to write the summary to.');

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
});
