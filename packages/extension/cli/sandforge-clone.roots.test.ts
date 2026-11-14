import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  type TargetCreate,
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

/** Both orgs answering for SRC and TGT, the source given or made; `onCreate` hears the target. */
function withOrgs(
  source: SampleSourceOrg = rootsSource(),
  onCreate?: (call: TargetCreate) => void,
) {
  const target = targetConn(onCreate);
  const conns = { SRC: sourceConn(source), TGT: target.conn };
  vi.mocked(loadOrg).mockImplementation(async (alias) => ({
    alias,
    username: '',
    instanceUrl: `https://${alias.toLowerCase()}.example.com`,
    accessToken: 'token',
  }));
  vi.mocked(makeConn).mockImplementation((org) => conns[org.alias as keyof typeof conns]);
  return { source, target };
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
