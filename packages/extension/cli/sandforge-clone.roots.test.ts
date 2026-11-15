import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connection } from 'jsforce';
import type { ForgeGraph, ForgeRunVerification } from '@sandforge/shared';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(), makeConn: vi.fn() };
});

import { execFileSync } from 'node:child_process';
import { loadOrg, makeConn } from './sfSession.js';
import {
  cliRunSetup,
  cloneInputLine,
  cloneInputOf,
  cloneSubjectOf,
  executeOptions,
  main,
  parseArgs,
  parseRunSummary,
  removalPlan,
  removalPlanLines,
  rootsLines,
  sampleRefusalExit,
  verificationLines,
} from './sandforge-clone';
import { RunVerifier } from '../src/modules/forge/RunVerifier.js';
import type { ExecutionSummary } from '../src/modules/forge/ForgeExecutor.js';
import { openRootPlan } from '../src/modules/forge/roots/rootPlanStore.js';
import {
  ROWS,
  TARGET_ORG,
  rootsSource,
  sentNames,
  sourceConn,
  sourceId,
  targetConn,
  volumeSource,
  type TargetCreate,
  type TargetSetup,
} from './testing/cloneRootsWorld.js';
import type { SampleSourceOrg } from '../src/test/sampleSourceOrg.js';

/*
 * A clone from records on the command line: the records a query chooses
 * (`--query`), or several named one by one (`--record` given more than
 * once), each cloned with what the clone of that record copies. Its flags
 * and their refusals, read before any org is reached; what it hands the
 * executor; what its dry run and its run say, line by line and as JSON; its
 * plan of roots (`--roots-plan`); its refusals and their exits; and its
 * verification — the command run whole against a source that answers as the
 * org does and a target that creates what it is sent.
 */

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

const ENERGY = "SELECT Id FROM Account WHERE Industry = 'Energy'";

/** A clone of the records `query` chooses from SRC to TGT, with `extra` flags. */
function argv(query: string | undefined, ...extra: string[]): string[] {
  return [
    'node',
    'sandforge-clone.ts',
    ...(query !== undefined ? ['--query', query] : []),
    '--source',
    'SRC',
    '--target',
    'TGT',
    '--skip-preflight',
    ...extra,
  ];
}

/** Run the command and return the exit code it stopped on, or the error it threw. */
async function run(args: string[]): Promise<number | undefined | Error> {
  try {
    await main(args);
    return undefined;
  } catch (err: unknown) {
    if (err instanceof ExitCalled) return err.code;
    return err as Error;
  }
}

let stdout: string[];
let stderr: string[];
let printed: string[];
let journalDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  stdout = [];
  stderr = [];
  printed = [];
  journalDir = mkdtempSync(join(tmpdir(), 'sandforge-clone-roots-'));
  vi.stubEnv('SANDFORGE_JOURNAL_DIR', journalDir);
  vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new ExitCalled(typeof code === 'number' ? code : undefined);
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
    printed.push(String(line));
  });
  vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
    stderr.push(`${String(line)}\n`);
  });
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('sf org display reached');
  });
  vi.mocked(loadOrg).mockRejectedValue(new Error('an org was reached'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(journalDir, { recursive: true, force: true });
});

/**
 * Both orgs answering for SRC and TGT, the source given or made; `onCreate`
 * hears the target, `setup` sets it up. Every call either connection is
 * made is named in `calls`, a describe by what it describes.
 */
function withOrgs(
  source: SampleSourceOrg = rootsSource(),
  onCreate?: (call: TargetCreate) => void,
  setup?: TargetSetup,
) {
  const target = targetConn(onCreate, setup);
  const calls = { SRC: [] as string[], TGT: [] as string[] };
  const conns = {
    SRC: namingCalls(sourceConn(source), calls.SRC),
    TGT: namingCalls(target.conn, calls.TGT),
  };
  vi.mocked(loadOrg).mockImplementation(async (alias) => ({
    alias,
    username: '',
    instanceUrl: `https://${alias.toLowerCase()}.example.com`,
    accessToken: 'token',
  }));
  vi.mocked(makeConn).mockImplementation((org) => conns[org.alias as keyof typeof conns]);
  return { source, target, calls };
}

/**
 * `conn`, each call it is made named in `calls` as it is made: its requests,
 * its statements and their pages, its describes by the object described, its
 * list of objects, its identity, its Tooling API reads.
 */
function namingCalls(conn: Connection, calls: string[]): Connection {
  const c = conn as unknown as Record<string, unknown> & {
    sobject: (name: string) => Record<string, unknown> & { describe: () => Promise<unknown> };
    tooling: Record<string, unknown>;
  };
  const named = (on: Record<string, unknown>, method: string, name = method): void => {
    const call = on[method] as ((...args: unknown[]) => unknown) | undefined;
    if (typeof call !== 'function') return;
    on[method] = (...args: unknown[]) => {
      calls.push(name);
      return call(...args);
    };
  };
  for (const method of ['request', 'query', 'queryMore', 'describeGlobal', 'identity']) {
    named(c, method);
  }
  for (const method of ['query', 'queryMore', 'describeGlobal']) {
    named(c.tooling, method, `tooling.${method}`);
  }
  const sobject = c.sobject;
  c.sobject = (name: string) => {
    const object = sobject(name);
    return {
      ...object,
      describe: async () => {
        calls.push(`describe ${name}`);
        return object.describe();
      },
    };
  };
  return conn;
}

/** The JSON the command printed on stdout. */
function json<T = Record<string, unknown>>(): T {
  return JSON.parse(stdout.join('')) as T;
}

/** What a run's JSON says of its roots, as these tests read it. */
interface RootsJson {
  roots: { objectApiName: string; from: string; query?: string; ids?: string[]; cap: number };
  result: {
    roots: {
      objectApiName: string;
      from: string;
      cap: number;
      asked: number;
      read: number;
      gone: string[];
      written: number;
      linked: number;
      failed: unknown[];
      sha256: string;
    };
    reads: { source: number };
    readByObject: Array<{
      objectApiName: string;
      read: number;
      origin?: { roots: number; under: number; named: number };
      readUnder?: string[];
    }>;
  };
}

describe('the command line of a clone from records', () => {
  it('reads --query into the records it chooses, the most a run takes, and the config the run goes with', () => {
    const args = parseArgs(argv(`${ENERGY} ORDER BY CreatedDate DESC LIMIT 50`));

    expect(args.record).toBeUndefined();
    expect(args.tables).toBeUndefined();
    expect(args.roots).toEqual({
      query: {
        soql: `${ENERGY} ORDER BY CreatedDate DESC LIMIT 50`,
        objectApiName: 'Account',
        roots: { where: "Industry = 'Energy'", orderBy: 'CreatedDate DESC', limit: 50 },
      },
      cap: 200,
    });
    expect(cloneInputOf(args)).toEqual({
      inputMode: 'soql',
      soqlQuery: `${ENERGY} ORDER BY CreatedDate DESC LIMIT 50`,
      queryScope: 'records',
      maxRoots: 200,
    });
    expect(cloneInputLine(args)).toBe(`query=${ENERGY} ORDER BY CreatedDate DESC LIMIT 50`);
    // Its WHERE chooses the roots, and filters no read of their object.
    expect(args.objectSoqlFilters).toEqual({});
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('reads --record given more than once as the records named, each once, the first the record discovery starts from', () => {
    const args = parseArgs(
      argv(
        undefined,
        '--record',
        ROWS.energyTwo,
        '--record',
        ROWS.energyOne,
        '--record',
        ROWS.energyTwo.slice(0, 15),
        '--max-roots',
        '5',
        '--max-read-total',
        '300',
      ),
    );

    expect(args.record).toBe(ROWS.energyTwo);
    expect(args.roots).toEqual({ ids: [ROWS.energyTwo, ROWS.energyOne], cap: 5, readTotal: 300 });
    expect(cloneInputOf(args)).toEqual({ inputMode: 'record', recordId: ROWS.energyTwo });
    expect(cloneInputLine(args)).toBe(`records=${ROWS.energyTwo}, ${ROWS.energyOne}`);
    // One --record is the clone of one record, as it always was.
    expect(parseArgs(argv(undefined, '--record', ROWS.energyOne)).roots).toBeUndefined();
  });

  it.each([
    ['--query with --record', argv(ENERGY, '--record', ROWS.energyOne)],
    ['--query with --object', argv(ENERGY, '--object', 'Contact')],
    ['--query with --depth all', argv(ENERGY, '--depth', 'all')],
    ['--query with --fit share', argv(ENERGY, '--fit', 'share')],
    // Every flag a sample is drawn by goes through the one list.
    ['--query with --fit-floor', argv(ENERGY, '--fit-floor', '3')],
    ['--query with --fit-plan', argv(ENERGY, '--fit-plan', 'plan')],
    ['--query given twice', argv(ENERGY, '--query', ENERGY)],
    ['a query that groups its rows', argv(`${ENERGY} GROUP BY Industry`)],
    ['a query that counts', argv("SELECT COUNT() FROM Account WHERE Industry = 'Energy'")],
    ['a query past an offset', argv(`${ENERGY} LIMIT 10 OFFSET 10`)],
    ['a query of no object', argv('SELECT Id WHERE Name = 1')],
    ['a LIMIT past the most of all', argv(`${ENERGY} LIMIT 2001`, '--max-roots', '2000')],
    ['a LIMIT past --max-roots', argv(`${ENERGY} LIMIT 300`)],
    ['--max-roots 0', argv(ENERGY, '--max-roots', '0')],
    ['--max-roots past 2000', argv(ENERGY, '--max-roots', '2001')],
    ['--max-read-total 0', argv(ENERGY, '--max-read-total', '0')],
    [
      '--max-roots with one --record',
      argv(undefined, '--record', ROWS.energyOne, '--max-roots', '5'),
    ],
    [
      '--roots-plan with one --record',
      argv(undefined, '--record', ROWS.energyOne, '--roots-plan', 'p.json'),
    ],
    ['--roots-plan with --resume', argv(ENERGY, '--roots-plan', 'p.json', '--resume', 'run')],
    [
      'records of two objects',
      argv(undefined, '--record', ROWS.energyOne, '--record', ROWS.contactOfEnergyOne),
    ],
    [
      'more records than --max-roots',
      argv(undefined, '--record', ROWS.energyOne, '--record', ROWS.energyTwo, '--max-roots', '1'),
    ],
  ])('refuses %s with exit 2, before any org is reached', (_label, args) => {
    expect(() => parseArgs(args)).toThrow(ExitCalled);
    expect(vi.mocked(process.exit)).toHaveBeenCalledWith(2);
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('says what a query cannot choose by, under its code, and what to give instead', () => {
    expect(() => parseArgs(argv(`${ENERGY} GROUP BY Industry`))).toThrow(ExitCalled);
    expect(stderr.join('')).toContain('refused (ROOTS_QUERY_REFUSED): The query’s GROUP BY');
    stderr = [];
    expect(() => parseArgs(argv(`${ENERGY} LIMIT 300`))).toThrow(ExitCalled);
    expect(stderr.join('')).toContain('give --max-roots 300');
    stderr = [];
    expect(() => parseArgs(argv(ENERGY, '--fit-floor', '3'))).toThrow(ExitCalled);
    expect(stderr.join('')).toContain('it does not go with --fit-floor');
  });

  it('fingerprints a clone from records by what chooses its roots and the most it takes, and a clone of one record as before', () => {
    const query = parseArgs(argv(ENERGY));
    const other = parseArgs(argv("SELECT Id FROM Account WHERE Industry = 'Retail'"));
    const more = parseArgs(argv(ENERGY, '--max-roots', '300'));
    const record = parseArgs(argv(undefined, '--record', ROWS.energyOne));

    expect(cliRunSetup(query, TARGET_ORG)).toMatchObject({
      query: { objectApiName: 'Account', where: "Industry = 'Energy'" },
      maxRoots: 200,
    });
    expect(cliRunSetup(other, TARGET_ORG)).not.toEqual(cliRunSetup(query, TARGET_ORG));
    expect(cliRunSetup(more, TARGET_ORG)).not.toEqual(cliRunSetup(query, TARGET_ORG));
    // A run read more records of at the bound changes nothing it writes.
    expect(cliRunSetup(parseArgs(argv(ENERGY, '--max-read-total', '9')), TARGET_ORG)).toEqual(
      cliRunSetup(query, TARGET_ORG),
    );
    for (const key of ['query', 'records', 'maxRoots']) {
      expect(Object.keys(cliRunSetup(record, TARGET_ORG))).not.toContain(key);
    }
  });

  it('hands the executor the roots to read, never the record of a clone of one record', () => {
    const graph = {
      nodes: [
        { objectApiName: 'Account', level: 0 },
        { objectApiName: 'Contact', level: 1 },
      ],
    } as unknown as ForgeGraph;
    const plan = {
      version: 1 as const,
      sourceOrgId: 'SRC',
      fingerprint: '',
      objectApiName: 'Account',
      from: 'query' as const,
      readAt: '2026-11-20T01:00:00.000Z',
      ids: [ROWS.energyOne],
      sha256: 'a'.repeat(64),
    };

    const options = executeOptions(
      parseArgs(argv(ENERGY, '--max-roots', '20', '--max-read-total', '500')),
      graph,
      [],
      undefined,
      { plan, sourceRequestsLeft: 9_000 },
    );
    expect(options.rootRecordId).toBeUndefined();
    expect(options.rootObjectApiName).toBe('Account');
    expect(options.roots).toEqual({
      objectApiName: 'Account',
      query: { where: "Industry = 'Energy'" },
      cap: 20,
      readTotal: 500,
      sourceRequestsLeft: 9_000,
      plan,
    });

    const named = executeOptions(
      parseArgs(argv(undefined, '--record', ROWS.energyOne, '--record', ROWS.energyTwo)),
      graph,
      [],
    );
    expect(named.roots).toEqual({
      objectApiName: 'Account',
      ids: [ROWS.energyOne, ROWS.energyTwo],
      cap: 200,
    });

    const one = executeOptions(parseArgs(argv(undefined, '--record', ROWS.energyOne)), graph, []);
    expect(one.roots).toBeUndefined();
    expect(one.rootRecordId).toBe(ROWS.energyOne);
  });

  it('exits 2 on a refusal a line given otherwise answers, and 1 on one the orgs answer', () => {
    for (const code of ['ROOTS_QUERY_REFUSED', 'ROOTS_PLAN_MISMATCH', 'ROOTS_PLAN_GONE']) {
      expect(sampleRefusalExit(code), code).toBe(2);
    }
    for (const code of [
      'NO_ROOTS',
      'ROOTS_EXCEEDED',
      'READ_BOUND_EXCEEDED',
      'API_BUDGET_EXCEEDED',
    ]) {
      expect(sampleRefusalExit(code), code).toBe(1);
    }
  });

  it('calls a clone from records by its roots, counted when they are', () => {
    expect(cloneSubjectOf({ roots: { objectApiName: 'Account', from: 'query', count: 37 } })).toBe(
      '37 Account records (query)',
    );
    expect(cloneSubjectOf({ roots: { objectApiName: 'Case', from: 'records', count: 1 } })).toBe(
      '1 Case record (named)',
    );
    expect(cloneSubjectOf({ roots: { objectApiName: 'Account', from: 'query' } })).toBe(
      'the Account records a query chose',
    );
  });
});

describe('what a clone from records says of its roots', () => {
  const summary = (
    roots: Partial<NonNullable<ExecutionSummary['roots']>> = {},
  ): Pick<ExecutionSummary, 'roots' | 'reads' | 'readByObject'> => ({
    roots: {
      objectApiName: 'Account',
      from: 'query',
      query: { where: "Industry = 'Energy'", orderBy: 'CreatedDate DESC', limit: 50 },
      cap: 200,
      asked: 37,
      read: 37,
      gone: [],
      written: 37,
      linked: 0,
      failed: [],
      sha256: '0123456789abcdef'.repeat(4),
      readAt: '2026-11-18T14:02:00.000Z',
      ...roots,
    },
    reads: { source: 84 },
    readByObject: [
      { objectApiName: 'Account', read: 41, origin: { roots: 37, under: 0, named: 4 } },
      {
        objectApiName: 'Case',
        read: 120,
        origin: { roots: 0, under: 120, named: 0 },
        readUnder: ['Account', 'Contact'],
      },
      { objectApiName: 'Task', read: 0, origin: { roots: 0, under: 0, named: 0 } },
    ],
  });
  const at = { source: 'SRC', target: 'TGT', dryRun: false };

  it('says where its roots came from, what its read came to, how each object came in, and the roots written', () => {
    expect(rootsLines(summary(), at)).toEqual([
      'roots: 37 Account records the query returns (ORDER BY CreatedDate DESC, LIMIT 50; at most 200)',
      'read: 161 records of 2 objects, 84 requests of SRC',
      "  Account: 41 = 37 roots + 4 named by the clone's records",
      "  Case: 120 under the clone's records (read under Account, Contact)",
      'roots written: 37 of 37',
    ]);
  });

  it('says the plan a run took, the roots gone since, those linked and those refused', () => {
    const lines = rootsLines(
      summary({
        from: 'plan',
        read: 35,
        gone: [ROWS.energyOne, ROWS.energyTwo],
        written: 33,
        linked: 1,
        failed: [{ id: ROWS.retail, reason: 'REQUIRED_FIELD_MISSING' }],
      }),
      { ...at, plan: '/plans/energy.json' },
    );
    expect(lines[0]).toBe(
      "roots: 35 Account records taken from the dry run's plan /plans/energy.json (sha256 " +
        '0123456789ab…, read 2026-11-18T14:02:00.000Z; at most 200)',
    );
    expect(lines).toContain(
      `roots gone from SRC since they were chosen: 2 (${ROWS.energyOne}, ${ROWS.energyTwo}), none written`,
    );
    expect(lines).toContain('roots written: 33 of 35, 1 linked to records TGT already held');
    expect(lines.slice(-2)).toEqual([
      'roots refused: 1',
      `  ${ROWS.retail}: REQUIRED_FIELD_MISSING`,
    ]);
  });

  it('says what a dry run would write, the plan it kept, and a plan too old that was read again', () => {
    const lines = rootsLines(
      summary({ readAgain: { roots: 30, readAt: '2026-11-16T09:00:00.000Z' } }),
      { ...at, dryRun: true, plan: '/plans/energy.json' },
    );
    expect(lines).toContain(
      'roots: kept in /plans/energy.json (sha256 0123456789ab…): the run given --roots-plan ' +
        'with it writes these records, and none the query chooses after',
    );
    expect(lines).toContain(
      "roots: the dry run's plan of 2026-11-16T09:00:00.000Z (30 records) was a day old or " +
        'more: the query was read again in its place',
    );
    expect(lines.at(-1)).toBe('roots that would be written: 37 of 37');
    expect(rootsLines({ readByObject: [] }, at)).toEqual([]);
  });
});

describe('a clone from records, run against the orgs', () => {
  it('dry-runs the records the query chooses with what each reaches, and nothing of the others', async () => {
    const { source, target } = withOrgs();

    expect(await run(argv(ENERGY, '--dry-run', '--json'))).toBeUndefined();

    const document = json<RootsJson>();
    expect(document.roots).toEqual({
      objectApiName: 'Account',
      from: 'query',
      query: ENERGY,
      cap: 200,
    });
    expect(document.result.roots).toMatchObject({
      objectApiName: 'Account',
      from: 'query',
      asked: 2,
      read: 2,
      gone: [],
      written: 2,
      failed: [],
    });
    expect(document.result.reads.source).toBeGreaterThan(0);
    const contacts = document.result.readByObject.find((o) => o.objectApiName === 'Contact');
    expect(contacts).toMatchObject({ read: 3, origin: { roots: 0, under: 3, named: 0 } });
    // The roots read by one statement of the run's own; every contact by the
    // accounts it reaches, never the table whole.
    const sent = source.sent.map((s) => s.soql);
    expect(sent).toContain(
      "SELECT Id FROM Account WHERE (Industry = 'Energy') ORDER BY Id LIMIT 201",
    );
    const contactReads = sent.filter(
      (soql) => / FROM Contact\b/.test(soql) && !/COUNT\(/.test(soql),
    );
    expect(contactReads.length).toBeGreaterThan(0);
    for (const soql of contactReads) expect(soql).toContain(ROWS.energyOne.slice(0, 15));
    expect(target.creates).toEqual([]);
  });

  it('says so line by line', async () => {
    withOrgs();

    expect(await run(argv(ENERGY, '--dry-run'))).toBeUndefined();

    const said = printed.join('\n');
    expect(said).toContain(`query=${ENERGY}`);
    expect(said).toContain('roots: 2 Account records the query returns (ORDER BY Id; at most 200)');
    expect(said).toMatch(/read: \d+ records of \d+ objects, \d+ requests of SRC/);
    expect(said).toContain("  Contact: 3 under the clone's records (read under Account)");
    expect(said).toContain('roots that would be written: 2 of 2');
  });

  it('writes the records the query chooses and what each reaches, and says the roots written', async () => {
    const summaryFile = join(journalDir, 'energy.summary.json');
    const { target } = withOrgs();

    expect(await run(argv(ENERGY, '--summary', summaryFile))).toBeUndefined();

    expect(sentNames(target.creates)).toEqual({
      Account: ['Energy one', 'Energy two'],
      Contact: ['One', 'One bis', 'Two'],
      Opportunity: ['Deal 1', 'Deal 2'],
    });
    expect(printed.join('\n')).toContain('roots written: 2 of 2');
    // Its summary names it by its roots, and its removal says so.
    const read = parseRunSummary(readFileSync(summaryFile, 'utf8'));
    if (!('summary' in read)) throw new Error(read.refusal);
    expect(read.summary.roots).toEqual({ objectApiName: 'Account', from: 'query' });
    expect(
      removalPlanLines(read.summary, removalPlan(read.summary), {
        target: 'TGT',
        includeChanged: false,
      })[0],
    ).toContain('the clone of 2 Account records (query) wrote to TGT');
  });

  it('writes the records named one by one', async () => {
    const { target } = withOrgs();

    expect(
      await run(argv(undefined, '--record', ROWS.energyTwo, '--record', ROWS.retail, '--json')),
    ).toBeUndefined();

    expect(sentNames(target.creates).Account).toEqual(['Energy two', 'Retail']);
    expect(json<RootsJson>().result.roots).toMatchObject({ from: 'records', written: 2 });
  });

  it.each([
    [
      'chooses more records than the run takes',
      ['SELECT Id FROM Account', '--max-roots', '2'],
      'ROOTS_EXCEEDED',
    ],
    ['chooses none', ["SELECT Id FROM Account WHERE Industry = 'Mining'"], 'NO_ROOTS'],
    [
      'reaches more records than the run may hold',
      [ENERGY, '--max-read-total', '3'],
      'READ_BOUND_EXCEEDED',
    ],
  ])('is refused when its query %s, exit 1, nothing written', async (_label, line, code) => {
    const { target } = withOrgs();
    const [query, ...extra] = line;

    expect(await run(argv(query, ...extra, '--json'))).toBe(1);

    expect(stderr.join('')).toContain(`refused (${code})`);
    expect(json<{ refused: { code: string } }>().refused.code).toBe(code);
    expect(target.creates).toEqual([]);
  });

  it('keeps the records its dry run chose, and its run writes those and no record chosen since', async () => {
    const plan = join(journalDir, 'energy.roots.json');
    const source = rootsSource();
    const { target } = withOrgs(source);

    expect(await run(argv(ENERGY, '--dry-run', '--roots-plan', plan))).toBeUndefined();
    const kept = await openRootPlan(plan);
    expect(kept.ids).toEqual([ROWS.energyOne, ROWS.energyTwo]);
    expect(printed.join('\n')).toContain(`roots: kept in ${plan}`);

    // An account of the industry made after the dry run.
    source.add('Account', {
      Id: sourceId('001', 9),
      Name: 'Energy late',
      Industry: 'Energy',
      CreatedDate: '2026-02-01T00:00:00.000Z',
      IsDeleted: false,
    });
    printed = [];
    const sentBefore = source.sent.length;

    expect(await run(argv(ENERGY, '--roots-plan', plan))).toBeUndefined();

    expect(sentNames(target.creates).Account).toEqual(['Energy one', 'Energy two']);
    expect(printed.join('\n')).toContain(
      `roots: 2 Account records taken from the dry run's plan ${plan} (sha256 ${kept.sha256.slice(0, 12)}…`,
    );
    // The query was not read again.
    expect(
      source.sent.slice(sentBefore).some((s) => /^SELECT Id FROM Account WHERE \(/.test(s.soql)),
    ).toBe(false);
  });

  it('refuses a run given a plan that is not there, or of another query, exit 2, nothing written', async () => {
    const plan = join(journalDir, 'energy.roots.json');

    expect(await run(argv(ENERGY, '--roots-plan', plan, '--json'))).toBe(2);
    expect(stderr.join('')).toContain(`refused (ROOTS_PLAN_GONE): --roots-plan ${plan}`);
    expect(stderr.join('')).toContain(`--dry-run --roots-plan ${plan}`);
    expect(json<{ refused: { code: string } }>().refused.code).toBe('ROOTS_PLAN_GONE');
    expect(loadOrg).not.toHaveBeenCalled();

    const { target } = withOrgs();
    expect(await run(argv(ENERGY, '--dry-run', '--roots-plan', plan))).toBeUndefined();
    stderr = [];
    expect(
      await run(argv("SELECT Id FROM Account WHERE Industry = 'Retail'", '--roots-plan', plan)),
    ).toBe(2);
    expect(stderr.join('')).toContain('refused (ROOTS_PLAN_MISMATCH)');
    expect(target.creates).toEqual([]);
  });

  it('refuses to keep its plan in place of a file that is no plan, and leaves the file as it was', async () => {
    const file = join(journalDir, 'notes.json');
    writeFileSync(file, '{"mine": true}\n');

    expect(await run(argv(ENERGY, '--dry-run', '--roots-plan', file))).toBe(2);

    expect(stderr.join('')).toContain(`--roots-plan ${file} exists, and is no plan of roots`);
    expect(readFileSync(file, 'utf8')).toBe('{"mine": true}\n');
    expect(loadOrg).not.toHaveBeenCalled();
  });

  it('takes a run stopped part way up from its journal, reading no query again', async () => {
    let interrupted = false;
    const source = rootsSource();
    const { target } = withOrgs(source, (call) => {
      if (call.name === 'Contact' && !interrupted) {
        interrupted = true;
        process.emit('SIGINT', 'SIGINT');
      }
    });

    expect(await run(argv(ENERGY))).toBe(130);
    const dir = join(journalDir, 'forge-runs');
    const [journal] = readdirSync(dir).filter((name) => name.endsWith('.ndjson'));
    if (journal === undefined) throw new Error('the run kept no journal');
    const sentBefore = source.sent.length;
    const createdBefore = target.creates.length;

    expect(await run(argv(ENERGY, '--resume', join(dir, journal)))).toBeUndefined();

    expect(
      source.sent.slice(sentBefore).some((s) => /^SELECT Id FROM Account WHERE \(/.test(s.soql)),
    ).toBe(false);
    const resumed = sentNames(target.creates.slice(createdBefore));
    expect(resumed.Account ?? []).toEqual([]);
    expect(printed.join('\n')).toContain(
      'roots: 2 Account records taken from the journal of the run taken up (sha256 ',
    );
  });
});

/** What a dry run's JSON says of its gate, as these tests read it. */
interface GateJson {
  writePlan?: { totalRows: number; storageBytes: number; automationBytes?: number };
  wouldBeRefused?: string[];
  wouldBeRefusedCodes?: string[];
  refused?: { code: string; message: string };
  apiRequests?: { source?: { sent: number }; target?: { sent: number } };
}

/** The words a dry run says a real run would be refused in, for `code`. */
function wouldBeRefusedFor(gate: GateJson, code: string): string | undefined {
  const at = gate.wouldBeRefusedCodes?.indexOf(code) ?? -1;
  return at < 0 ? undefined : gate.wouldBeRefused?.[at];
}

/** A target of 5 MB of data storage, `remaining` of them left. */
function fiveMegabytes(remaining: number): Record<string, unknown> {
  return {
    DataStorageMB: { Max: 5, Remaining: remaining },
    DailyApiRequests: { Max: 15_000, Remaining: 15_000 },
    DailyBulkApiBatches: { Max: 15_000, Remaining: 15_000 },
    FileStorageMB: { Max: 20, Remaining: 20 },
  };
}

describe('a clone from records weighed before it writes', () => {
  // Run for real on a trap org, a query of every account (41 of them, 1 200
  // contacts) refused past --max-roots 10 after discovery, the target's
  // automation and the preflight: 403 requests to the source, 74 to the
  // target, and its words said "refused before anything else was read".
  it('refuses a query that chooses more than the run takes on its one statement of the source, nothing of the target read', async () => {
    const { calls } = withOrgs();

    expect(
      await run(argv('SELECT Id FROM Account', '--max-roots', '2', '--dry-run', '--json')),
    ).toBe(1);

    expect(json<GateJson>().refused?.code).toBe('ROOTS_EXCEEDED');
    expect(stderr.join('')).toContain(
      'refused (ROOTS_EXCEEDED): The query chooses more than the 2 Account records',
    );
    expect(calls.SRC.filter((call) => call === 'request').length).toBeLessThanOrEqual(3);
    expect(calls.SRC.filter((call) => call.startsWith('describe'))).toEqual([]);
    expect(calls.TGT).toEqual([]);
    expect(json<GateJson>().apiRequests).toEqual({
      target: { sent: 0 },
      source: { sent: calls.SRC.filter((call) => call === 'request').length },
    });
  });

  it('refuses a query that chooses none on that statement too, nothing of the target read', async () => {
    const { calls } = withOrgs();

    expect(
      await run(argv("SELECT Id FROM Account WHERE Industry = 'Mining'", '--dry-run', '--json')),
    ).toBe(1);

    expect(json<GateJson>().refused?.code).toBe('NO_ROOTS');
    expect(calls.SRC.filter((call) => call.startsWith('describe'))).toEqual([]);
    expect(calls.TGT).toEqual([]);
  });

  it('reads the records the query chooses once, before discovery, and its run takes those', async () => {
    const { source } = withOrgs();

    expect(await run(argv(ENERGY, '--dry-run', '--json'))).toBeUndefined();

    const statements = source.sent.map((s) => s.soql);
    const roots = "SELECT Id FROM Account WHERE (Industry = 'Energy') ORDER BY Id LIMIT 201";
    expect(statements.filter((soql) => soql === roots)).toHaveLength(1);
    expect(statements[0]).toBe(roots);
    expect(json<RootsJson>().result.roots).toMatchObject({ from: 'query', read: 2, written: 2 });
  });

  // Run for real on a trap org, the gate said the 1 320 records of 41
  // accounts took 2.58 MB of the 5 MB left, while a flow no mute reaches
  // opens a task under each of their 1 200 contacts: about 2.3 MB more, that
  // a clone of the whole org counts and a clone from records did not.
  it('counts with its records what the target’s automation creates under them, and is refused the storage they take with it', async () => {
    withOrgs(volumeSource(41, 1_200), undefined, {
      limits: fiveMegabytes(4),
      taskOnContact: true,
    });

    expect(
      await run(argv('SELECT Id FROM Account', '--accept-automation', '--dry-run', '--json')),
    ).toBeUndefined();

    const gate = json<GateJson>();
    expect(gate.writePlan?.totalRows).toBe(1_241);
    expect(gate.writePlan?.automationBytes).toBe(1_200 * 2_048);
    expect(gate.wouldBeRefusedCodes).toContain('STORAGE_EXCEEDED');
    expect(stderr.join('')).toMatch(
      /write gate: 1241 record\(s\) to write to TGT, about 4\.\d+ MB of data storage, about 2\.35 MB of it for what the target's automation creates under them/,
    );
  });

  it('counts nothing more when nothing the target runs creates a record under them', async () => {
    withOrgs(volumeSource(41, 1_200), undefined, { limits: fiveMegabytes(4) });

    expect(await run(argv('SELECT Id FROM Account', '--dry-run', '--json'))).toBeUndefined();

    const gate = json<GateJson>();
    expect(gate.writePlan).not.toHaveProperty('automationBytes');
    expect(gate.wouldBeRefusedCodes ?? []).not.toContain('STORAGE_EXCEEDED');
  });

  // Refused past --max-total 100, a query of 41 accounts was told "narrow the
  // clone (--max, --exclude-object, --filter)": --max 20 kept the 41 and 20
  // of their 1 200 contacts, taken by an order nobody chose.
  it('offers fewer of its roots past --max-total, the query that takes as many as fit written out, never --max', async () => {
    withOrgs(volumeSource(41, 1_200));

    expect(
      await run(argv('SELECT Id FROM Account', '--max-total', '100', '--dry-run', '--json')),
    ).toBeUndefined();

    const refusal = wouldBeRefusedFor(json<GateJson>(), 'MAX_TOTAL_EXCEEDED');
    expect(refusal).toContain(
      'the 41 Account records the query chooses take about 31 records each, and about 3 of ' +
        'them fit: --query "SELECT Id FROM Account ORDER BY CreatedDate DESC, Id DESC LIMIT 3" ' +
        'clones the newest 3, its dry run first, or narrow its WHERE',
    );
    expect(refusal).not.toMatch(/--max\b(?!-)/);

    // The query it gives, as it gives it, fits.
    stdout = [];
    const given = /--query "([^"]+)"/.exec(refusal ?? '')?.[1] ?? '';
    expect(await run(argv(given, '--max-total', '100', '--dry-run', '--json'))).toBeUndefined();
    const fitted = json<GateJson & RootsJson>();
    expect(fitted.wouldBeRefusedCodes ?? []).not.toContain('MAX_TOTAL_EXCEEDED');
    expect(fitted.result.roots).toMatchObject({ read: 3 });
    expect(fitted.writePlan?.totalRows).toBeLessThanOrEqual(100);
  });

  it('keeps the query’s own order and WHERE in the way it offers, and names records one by one otherwise', async () => {
    withOrgs(volumeSource(41, 1_200));

    expect(
      await run(
        argv(
          "SELECT Id FROM Account WHERE Industry = 'Energy' ORDER BY Name ASC",
          '--max-total',
          '100',
          '--dry-run',
          '--json',
        ),
      ),
    ).toBeUndefined();
    expect(wouldBeRefusedFor(json<GateJson>(), 'MAX_TOTAL_EXCEEDED')).toContain(
      `--query "SELECT Id FROM Account WHERE Industry = 'Energy' ORDER BY Name ASC LIMIT 3" ` +
        'clones the first 3 in its order',
    );

    stdout = [];
    const named = [101, 102, 103, 104].flatMap((n) => ['--record', sourceId('001', n)]);
    expect(
      await run(argv(undefined, ...named, '--max-total', '50', '--dry-run', '--json')),
    ).toBeUndefined();
    expect(wouldBeRefusedFor(json<GateJson>(), 'MAX_TOTAL_EXCEEDED')).toContain(
      'the 4 Account records named take about 31 records each, and about 1 of them fit: ' +
        'name 1 of them at most',
    );
  });

  it('offers fewer of its roots past the storage the target has left, never fewer records per object', async () => {
    withOrgs(volumeSource(41, 1_200), undefined, {
      limits: fiveMegabytes(4),
      taskOnContact: true,
    });

    expect(
      await run(argv('SELECT Id FROM Account', '--accept-automation', '--dry-run', '--json')),
    ).toBeUndefined();

    const refusal = wouldBeRefusedFor(json<GateJson>(), 'STORAGE_EXCEEDED');
    expect(refusal).toContain(
      'and TGT has 4 MB left of 5 MB: the 41 Account records the query chooses take about ' +
        '0.12 MB each, and about 34 of them fit: --query "SELECT Id FROM Account ORDER BY ' +
        'CreatedDate DESC, Id DESC LIMIT 34" clones the newest 34',
    );
    expect(refusal).not.toContain('records per object');
  });

  it('says when one of its roots alone takes more than --max-total, and offers no LIMIT', async () => {
    withOrgs(volumeSource(2, 100));

    expect(
      await run(argv('SELECT Id FROM Account', '--max-total', '20', '--dry-run', '--json')),
    ).toBeUndefined();

    const refusal = wouldBeRefusedFor(json<GateJson>(), 'MAX_TOTAL_EXCEEDED');
    expect(refusal).toContain(
      'one of the 2 Account records the query chooses takes about 51 records on average, ' +
        'more than the 20 --max-total holds the run to by itself: leave objects out ' +
        '(--exclude-object) or narrow them (--filter), clone less deep (--depth direct), or ' +
        'raise --max-total.',
    );
    expect(refusal).not.toContain('LIMIT');
  });
});

describe('the verification of a clone from records', () => {
  it('hands the verifier the roots its journal names, and says how many the target holds', async () => {
    const summaryFile = join(journalDir, 'energy.summary.json');
    withOrgs();
    expect(await run(argv(ENERGY, '--summary', summaryFile))).toBeUndefined();
    const verified: ForgeRunVerification = {
      verdict: 'verified',
      attempts: 1,
      objects: [],
      roots: { inTarget: 2, of: 2 },
    } as unknown as ForgeRunVerification;
    const verify = vi.spyOn(RunVerifier.prototype, 'verify').mockResolvedValue(verified);
    printed = [];

    expect(
      await run(['node', 'sandforge-clone.ts', '--verify', summaryFile, '--target', 'TGT']),
    ).toBeUndefined();

    expect(verify.mock.calls[0]?.[0]).toMatchObject({
      roots: { objectApiName: 'Account', sourceIds: [ROWS.energyOne, ROWS.energyTwo] },
    });
    expect(printed.join('\n')).toContain('  roots: 2 of 2 in TGT');
    expect(verificationLines(verified, 'TGT')[1]).toBe('  roots: 2 of 2 in TGT');
    expect(existsSync(summaryFile)).toBe(true);
  });
});
