import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection, DescribeSObjectResult } from 'jsforce';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
// The sessions stay the real ones unless a test gives the orgs it runs against.
vi.mock('./sfSession.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sfSession.js')>();
  return { ...actual, loadOrg: vi.fn(actual.loadOrg), makeConn: vi.fn(actual.makeConn) };
});

import { execFileSync } from 'node:child_process';
import { loadOrg, makeConn } from './sfSession.js';
import { selectRows, type FakeRow } from '../src/test/fakeSoql.js';
import {
  adaptDescribe,
  contactPointLines,
  describeObjectInfo,
  describeOnce,
  executeOptions,
  failedOutright,
  graphLine,
  jsonResult,
  listedObjects,
  loadRecordTypes,
  main,
  parseArgs,
  summaryLines,
  objectOutcomeLine,
  objectOutcomePrinter,
  simulationGapLines,
  decisionLines,
} from './sandforge-clone';
import type { ExecutionSummary, ForgeProgressEvent } from '../src/modules/forge/ForgeExecutor.js';
import type { ForgeGap, ForgeGraph, ForgeGraphNode } from '@sandforge/shared';

const mockExecFileSync = vi.mocked(execFileSync);

/** Thrown in place of `process.exit` so a test can read the code it was given. */
class ExitCalled extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

/** A valid invocation, with `extra` flags appended. */
function argv(...extra: string[]): string[] {
  return [
    'node',
    'sandforge-clone.ts',
    '--record',
    '001000000000001AAA',
    '--source',
    'SRC',
    '--target',
    'TGT',
    ...extra,
  ];
}

/** Run the CLI and return the exit code it stopped on, or the error it threw. */
async function run(args: string[]): Promise<number | undefined | Error> {
  try {
    await main(args);
    return undefined;
  } catch (err: unknown) {
    if (err instanceof ExitCalled) return err.code;
    return err as Error;
  }
}

/**
 * Every flag reaches the orgs through the same ForgeConfig the wizard sends,
 * but the CLI built it from argv without the schema: `--depth deep` was cast
 * into the union, and a malformed record ID or excluded field name went on to
 * authenticate both orgs before anything refused it. A bad flag now exits 2
 * before `sf org display` runs.
 */
describe('sandforge-clone flag validation', () => {
  let stderr: string;

  beforeEach(() => {
    vi.clearAllMocks();
    stderr = '';
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(typeof code === 'number' ? code : undefined);
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr += String(chunk);
      return true;
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    // A valid invocation stops at the first org lookup.
    mockExecFileSync.mockImplementation(() => {
      throw new Error('sf org display reached');
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ['a malformed --record', argv().map((a) => (a === '001000000000001AAA' ? 'not-an-id' : a))],
    ['an unknown --depth', argv('--depth', 'deep')],
    ['a --custom-depth that is not a number', argv('--custom-depth', 'five')],
    ['a --custom-depth above the maximum', argv('--custom-depth', '50')],
    ['a --max that is not a number', argv('--max', 'lots')],
    ['an --exclude object name that is not an API name', argv('--exclude', 'Acc ount.Name')],
    ['an --exclude field name that is not an API name', argv('--exclude', 'Account.Bad-Field')],
    ['an --exclude-object that is not an API name', argv('--exclude-object', 'Price book')],
    ['a --filter object name that is not an API name', argv('--filter', "Ca$e=Status = 'Open'")],
    ['--files-as-is without --files', argv('--files-as-is')],
    ['--max-file-size without --files', argv('--max-file-size', '5')],
    ['a --max-file-size one call cannot carry', argv('--files', '--max-file-size', '36')],
    ['a --max-file-size that is not a size', argv('--files', '--max-file-size', 'big')],
    ['--include-changed, which goes with --remove', argv('--include-changed')],
    ['a --max-total that is not a number', argv('--max-total', 'lots')],
    ['a --max-total of no record', argv('--max-total', '0')],
    ['a --max-total that is not a whole number', argv('--max-total', '2.5')],
  ])('exits 2 on %s before any org is loaded', async (_label, args) => {
    expect(await run(args)).toBe(2);
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(stderr).not.toBe('');
  });

  it('refuses --files with --anonymize until the files are accepted as they are', async () => {
    expect(await run(argv('--anonymize', '--files'))).toBe(2);

    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(stderr).toContain('--files-as-is');
    expect(stderr).toContain('copied as they are');
  });

  it('reaches the org lookup when the files are accepted as they are', async () => {
    const result = await run(
      argv('--anonymize', '--files', '--files-as-is', '--max-file-size', '20'),
    );

    expect((result as Error).message).toBe('sf org display reached');
  });

  it('takes --accept-automation and --max-total, and caps a run at 10 000 records unless told', () => {
    expect(parseArgs(argv())).toMatchObject({ acceptAutomation: false, maxTotal: 10_000 });
    expect(parseArgs(argv('--accept-automation', '--max-total', '25'))).toMatchObject({
      acceptAutomation: true,
      maxTotal: 25,
    });
  });

  it('reaches the org lookup when every flag is valid', async () => {
    const result = await run(
      argv(
        '--depth',
        'full',
        '--max',
        '50',
        '--exclude',
        'Account.Description',
        '--owner-map',
        '005000000000001AAA=005000000000002AAA',
      ),
    );

    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe('sf org display reached');
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
  });
});

/** Lines that call the script by a bare command name, which no install provides. */
const BARE_COMMAND_LINE = /^\s*(?:\*\s*)?sandforge-(clone|cleanup) --/;

describe('sandforge-clone usage text', () => {
  let stdout: string;

  beforeEach(() => {
    stdout = '';
    vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new ExitCalled(typeof code === 'number' ? code : undefined);
    });
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stdout += String(chunk);
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the command the script is really run with', async () => {
    expect(await run(['node', 'sandforge-clone.ts', '--help'])).toBe(0);

    expect(stdout).toContain('pnpm exec tsx packages/extension/cli/sandforge-clone.ts');
    expect(stdout).toContain('pnpm build:shared');
    expect(stdout.split('\n').filter((line) => BARE_COMMAND_LINE.test(line))).toEqual([]);
  });

  it('names the flag that keeps emails and phone numbers as read, and what it risks', async () => {
    expect(await run(['node', 'sandforge-clone.ts', '--help'])).toBe(0);

    expect(stdout).toMatch(/--keep-contact-points\s+write emails and phone numbers as read/);
    expect(stdout).toContain('under .invalid');
    expect(stdout).toContain('may reach the');
  });

  it('names no bare command anywhere in the script source', () => {
    const source = readFileSync(join(__dirname, 'sandforge-clone.ts'), 'utf8');
    expect(source.split('\n').filter((line) => BARE_COMMAND_LINE.test(line))).toEqual([]);
  });
});

describe('sandforge-clone record type mapping', () => {
  const recordType = (Id: string, SobjectType: string) => ({
    Id,
    Name: 'Business',
    DeveloperName: 'Business',
    SobjectType,
  });
  const orgReturning = (records: ReturnType<typeof recordType>[]): Connection =>
    ({ query: vi.fn().mockResolvedValue({ records }) }) as unknown as Connection;

  it('maps a record type to the one of the same object when two objects share a DeveloperName', async () => {
    const source = orgReturning([
      recordType('012000000000SRCACC', 'Account'),
      recordType('012000000000SRCCON', 'Contact'),
    ]);
    // The Account row comes last, so a match on DeveloperName alone would
    // hand the Contact record type the Account one.
    const target = orgReturning([
      recordType('012000000000TGTCON', 'Contact'),
      recordType('012000000000TGTACC', 'Account'),
    ]);

    const mappings = await loadRecordTypes(source, target);

    expect(mappings.find((m) => m.sourceId === '012000000000SRCCON')?.targetId).toBe(
      '012000000000TGTCON',
    );
    expect(mappings.find((m) => m.sourceId === '012000000000SRCACC')?.targetId).toBe(
      '012000000000TGTACC',
    );
  });

  it('matches the record types of every page each org answers with, not those of the first alone', async () => {
    // A query answers with 2 000 records at most and a cursor to the rest: a
    // record type past the first page went unmatched, and the records of it
    // kept the source's Id, which the target refuses.
    const NEXT = '/services/data/v66.0/query/01g000000000001-2000';
    const onTwoPages = (first: string, second: string) => ({
      query: vi.fn().mockResolvedValue({
        records: [recordType(first, 'Account')],
        done: false,
        nextRecordsUrl: NEXT,
      }),
      queryMore: vi
        .fn()
        .mockResolvedValue({ records: [recordType(second, 'Contact')], done: true }),
    });
    const source = onTwoPages('012000000000SRCACC', '012000000000SRCCON');
    const target = onTwoPages('012000000000TGTACC', '012000000000TGTCON');

    const mappings = await loadRecordTypes(
      source as unknown as Connection,
      target as unknown as Connection,
    );

    expect(mappings.find((m) => m.sourceId === '012000000000SRCCON')?.targetId).toBe(
      '012000000000TGTCON',
    );
    expect(mappings.find((m) => m.sourceId === '012000000000SRCACC')?.targetId).toBe(
      '012000000000TGTACC',
    );
    expect(source.queryMore).toHaveBeenCalledWith(NEXT);
    expect(target.queryMore).toHaveBeenCalledWith(NEXT);
  });
});

describe('sandforge-clone target object info', () => {
  it('reads the key prefix and the record types from the describe jsforce already cached', async () => {
    const describeCached = vi.fn().mockResolvedValue({
      name: 'Account',
      keyPrefix: '001',
      recordTypeInfos: [
        {
          active: true,
          available: false,
          defaultRecordTypeMapping: false,
          developerName: 'Partner',
          master: false,
          name: 'Partner',
          recordTypeId: '012Fk00000RtDeFIAV',
          urls: {},
        },
      ],
    });
    const describe = vi.fn();
    const conn = { describe$: describeCached, describe } as unknown as Connection;

    const info = await describeObjectInfo(conn, 'Account');

    expect(info.keyPrefix).toBe('001');
    expect(info.recordTypes.map((r) => [r.developerName, r.available])).toEqual([
      ['Partner', false],
    ]);
    expect(describeCached).toHaveBeenCalledWith('Account');
    expect(describe).not.toHaveBeenCalled();
  });
});

describe('sandforge-clone summary', () => {
  const summary = (overrides: Partial<ExecutionSummary>): ExecutionSummary => ({
    successCount: 4,
    updatedCount: 0,
    linkedCount: 0,
    wouldInsertCount: 0,
    failedCount: 0,
    skippedCount: 0,
    remapCount: 4,
    errors: [],
    truncatedObjects: [],
    remapTable: {},
    existingRecords: [],
    existingSourceIds: [],
    updatedSourceIds: [],
    remapByObject: [],
    createdByObject: [],
    readByObject: [],
    failedReads: [],
    ...overrides,
  });

  it('counts the records the target already held apart from the created and the failed ones', () => {
    const lines = summaryLines(
      summary({
        successCount: 4,
        linkedCount: 2,
        failedCount: 1,
        existingRecords: [
          { objectApiName: 'Account', linked: 2, unidentified: 0 },
          { objectApiName: 'AccountContactRelation', linked: 0, unidentified: 1 },
        ],
      }),
    );

    expect(lines.slice(0, 3)).toEqual([
      'success: 4',
      'linked:  2 (already in the target, not created)',
      'failed:  1',
    ]);
    expect(lines).toContain('  Account  2 linked');
    expect(lines).toContain(
      '  AccountContactRelation  0 linked, 1 not identified — their children lost the link',
    );
  });

  it('counts the records an upsert matched by their external id as updated, not created', () => {
    const lines = summaryLines(summary({ successCount: 3, updatedCount: 2 }));

    expect(lines.slice(0, 3)).toEqual([
      'success: 3',
      'updated: 2 (matched by their external id, not created)',
      'linked:  0 (already in the target, not created)',
    ]);
  });

  it('counts what a dry run would insert under its own name, never as created', () => {
    const lines = summaryLines(summary({ successCount: 0, wouldInsertCount: 7 }));

    expect(lines.slice(0, 2)).toEqual([
      'success: 0',
      'would be inserted: 7 (dry run, nothing written)',
    ]);
    expect(jsonResult(summary({ successCount: 0, wouldInsertCount: 7 }))).toMatchObject({
      successCount: 0,
      wouldInsertCount: 7,
    });
  });

  it('lists what a dry run found the target would refuse or change, a line a gap, never a record value', () => {
    const gaps: ForgeGap[] = [
      {
        id: 'value_too_long|Case|Subject||',
        kind: 'value_too_long' as const,
        severity: 'blocking' as const,
        source: 'simulation' as const,
        objectApiName: 'Case',
        field: 'Subject',
        rows: 2,
        detail: { length: 80, longest: 112 },
        decisions: ['truncate' as const],
      },
      {
        id: 'picklist_value_refused|Case|Origin|Support|Fax',
        kind: 'picklist_value_refused' as const,
        severity: 'warning' as const,
        source: 'simulation' as const,
        objectApiName: 'Case',
        field: 'Origin',
        recordType: 'Support',
        value: 'Fax',
        rows: 1,
        detail: { replacement: 'Phone', ignored: true },
        decisions: ['map_value' as const],
      },
    ];
    const dry = summary({ successCount: 0, wouldInsertCount: 3, dryRun: true, gaps });

    expect(simulationGapLines(gaps)).toEqual([
      'gaps the target holds against the rows (2, dry run):',
      '  [blocking] Case.Subject  value_too_long: 2 record(s) (longest 112 of 80 characters)',
      '  [warning] Case.Origin  picklist_value_refused "Fax" (record type Support): 1 record(s) ' +
        '(written as "Phone"; ignored)',
    ]);
    expect(summaryLines(dry, true)).toEqual(expect.arrayContaining(simulationGapLines(gaps)));
    expect(simulationGapLines([])).toEqual([
      'gaps: none found (dry run: nothing the target would refuse or change)',
    ]);
    expect(jsonResult(dry).gaps).toEqual(gaps);
    expect(jsonResult(summary({}))).not.toHaveProperty('gaps');
  });

  it('says the decisions the run applied and on how many records', () => {
    const decisionsApplied = [
      {
        kind: 'map_value' as const,
        objectApiName: 'Case',
        field: 'Origin',
        recordType: 'Support',
        from: 'Fax',
        to: 'Phone',
        rows: 3,
      },
      { kind: 'truncate' as const, objectApiName: 'Case', field: 'Subject', rows: 1 },
    ];

    expect(decisionLines(decisionsApplied)).toEqual([
      'decisions applied (2):',
      '  Case.Origin  map_value "Fax" → "Phone" (record type Support): 3 record(s)',
      '  Case.Subject  truncate: 1 record(s)',
    ]);
    expect(summaryLines(summary({ decisionsApplied }))).toEqual(
      expect.arrayContaining(decisionLines(decisionsApplied)),
    );
    expect(jsonResult(summary({ decisionsApplied })).decisionsApplied).toEqual(decisionsApplied);
  });

  it('says, and hands a CI job, the records a call may have written that removing the run cannot reach', () => {
    const mayHaveBeenWritten = [
      { objectApiName: 'Contact', sourceIds: ['003000000000001AAA', '003000000000002AAA'] },
    ];
    const lines = summaryLines(summary({ failedCount: 2, mayHaveBeenWritten }));

    expect(lines).toContain(
      'may be in the target, under ids the run never learned (--remove cannot reach them):',
    );
    expect(lines).toContain('  Contact  2 record(s)');
    expect(jsonResult(summary({ mayHaveBeenWritten })).mayHaveBeenWritten).toEqual(
      mayHaveBeenWritten,
    );
    expect(jsonResult(summary({}))).not.toHaveProperty('mayHaveBeenWritten');
  });

  it('says how many calls the run sent to both orgs, where it counted them', () => {
    const counted = summary({ apiCalls: 64 });

    expect(summaryLines(counted)).toContain('calls:   64 (requests the run sent to both orgs)');
    expect(jsonResult(counted).apiCalls).toBe(64);
    expect(summaryLines(summary({})).some((line) => line.startsWith('calls:'))).toBe(false);
    expect(jsonResult(summary({}))).not.toHaveProperty('apiCalls');
  });

  it('tells a CI job and the text summary whether the contact points went neutralized, and how many', () => {
    const contactPoints = {
      neutralized: true,
      fields: [{ objectApiName: 'Contact', field: 'Phone', kind: 'phone' as const, values: 4 }],
      values: 4,
    };
    const neutralized = summary({ contactPoints });

    expect(jsonResult(neutralized).contactPoints).toEqual(contactPoints);
    expect(summaryLines(neutralized)).toContain('  Contact.Phone  4');
    expect(jsonResult(summary({}))).not.toHaveProperty('contactPoints');

    const kept = summary({ contactPoints: { neutralized: false, fields: [], values: 0 } });
    expect(jsonResult(kept).contactPoints).toEqual({ neutralized: false, fields: [], values: 0 });
    expect(summaryLines(kept).some((line) => line.includes('written as read'))).toBe(true);
  });

  it('gives a CI job the rows the run read of each object, the size of the clone', () => {
    // Discovery counts each whole table; a record-scoped clone reads a few
    // rows of each, and nothing in the summary said how many.
    const readByObject = [
      { objectApiName: 'Opportunity', read: 1 },
      { objectApiName: 'OpportunityLineItem', read: 3 },
    ];

    expect(jsonResult(summary({ readByObject })).readByObject).toEqual(readByObject);
  });

  it('does not call a dry run that found records to insert a failure', () => {
    expect(failedOutright(summary({ successCount: 0, wouldInsertCount: 3, failedCount: 1 }))).toBe(
      false,
    );
  });

  it('lets a CI job tell the rows of the remap table the run created from the rest', () => {
    const result = jsonResult(
      summary({
        remapTable: {
          '001000000000001SRC': '001000000000001AAA',
          '001000000000002SRC': '001000000000002AAA',
          '001000000000003SRC': '001000000000003AAA',
          '01m000000000001SRC': '01m000000000001AAA',
        },
        // Linked to the account the target held, and business hours matched by name.
        existingSourceIds: ['001000000000002SRC', '01m000000000001SRC'],
        // Written over by `--upsert`.
        updatedSourceIds: ['001000000000003SRC'],
      }),
    );

    const notCreated = new Set([...result.existingSourceIds, ...result.updatedSourceIds]);
    expect(Object.keys(result.remapTable).filter((id) => !notCreated.has(id))).toEqual([
      '001000000000001SRC',
    ]);
  });

  it("gives what removing the run's records takes: what it created per object, what goes with it, and when it wrote", () => {
    const createdByObject = [
      { objectApiName: 'Account', sourceIds: ['001000000000001SRC'] },
      { objectApiName: 'Contact', sourceIds: ['003000000000001SRC'] },
    ];
    const writtenBetween = { first: '2026-10-01T10:00:00.000Z', last: '2026-10-01T10:00:05.000Z' };

    const result = jsonResult(
      summary({
        createdByObject,
        withTheirRecordSourceIds: ['003000000000002SRC'],
        writtenBetween,
      }),
    );

    expect(result.createdByObject).toEqual(createdByObject);
    expect(result.withTheirRecordSourceIds).toEqual(['003000000000002SRC']);
    expect(result.writtenBetween).toEqual(writtenBetween);
    // A dry run dates nothing and links nothing with a record it created.
    expect(jsonResult(summary({}))).not.toHaveProperty('writtenBetween');
    expect(jsonResult(summary({}))).not.toHaveProperty('withTheirRecordSourceIds');
  });

  it('does not call a run that updated or linked records a failure, however many others failed', () => {
    expect(failedOutright(summary({ successCount: 0, updatedCount: 2, failedCount: 5 }))).toBe(
      false,
    );
    expect(failedOutright(summary({ successCount: 0, linkedCount: 1, failedCount: 5 }))).toBe(
      false,
    );
    expect(failedOutright(summary({ successCount: 0, failedCount: 5 }))).toBe(true);
    expect(failedOutright(summary({ successCount: 0, failedCount: 0 }))).toBe(false);
  });

  it('calls a run whose reads all failed a failure, though a failed read counts no record', () => {
    // The clone never learned how many rows the object it could not read
    // held: none is counted, and the command still exits on a failure.
    const unread = summary({ successCount: 0, failedCount: 0, failedReads: ['Opportunity'] });

    expect(failedOutright(unread)).toBe(true);
    expect(failedOutright({ ...unread, successCount: 2 })).toBe(false);
  });

  it('tells a CI job which errors are reference data unmatched and which an object skipped whole', () => {
    // Dropped from each error, the two flags left a job reading unmatched
    // reference data as rows held back, and a skipped object counting none
    // as a note.
    const reference = {
      objectApiName: 'BusinessHours',
      stage: 'scope' as const,
      failedCount: 1,
      attemptedCount: 2,
      referenceData: true,
      samples: [],
    };
    const skipped = {
      objectApiName: 'Contract',
      stage: 'scope' as const,
      failedCount: 0,
      attemptedCount: 0,
      skipped: true,
      samples: [],
    };
    const held = {
      objectApiName: 'FeedItem',
      stage: 'scope' as const,
      failedCount: 2,
      attemptedCount: 0,
      samples: [],
    };

    expect(jsonResult(summary({ errors: [reference, skipped, held] })).errors).toEqual([
      reference,
      skipped,
      held,
    ]);
  });

  it('names the objects whose read failed on the failed line, and to a CI job', () => {
    const unread = summary({ failedCount: 1, failedReads: ['Contact', 'Case'] });

    expect(summaryLines(unread)).toContain('failed:  1 (read failed: Contact, Case)');
    expect(summaryLines(summary({ failedCount: 1 }))).toContain('failed:  1');
    expect(jsonResult(unread).failedReads).toEqual(['Contact', 'Case']);
  });

  describe('with --files', () => {
    const files = {
      maxFileBytes: 10 * 1_048_576,
      objects: [
        {
          objectApiName: 'ContentDocument' as const,
          planned: 2,
          plannedBytes: 3_072,
          copied: 1,
          failed: 1,
        },
        {
          objectApiName: 'Attachment' as const,
          planned: 1,
          plannedBytes: 512,
          copied: 1,
          failed: 0,
        },
      ],
      links: 1,
      leftOut: [
        {
          objectApiName: 'ContentDocument' as const,
          sourceId: '069000000000001AAA',
          name: 'Scan',
          bytes: 12 * 1_048_576,
          reason: 'too-large' as const,
        },
      ],
      remainingStorageBytes: 200 * 1_048_576,
    };

    it('counts the files per object, the links, the storage left and every file left out', () => {
      const lines = summaryLines(summary({ files }));

      expect(lines).toEqual(
        expect.arrayContaining([
          'files (up to 10 MB each):',
          '  ContentDocument  1 of 2 copied (3 KB), 1 failed',
          '  Attachment  1 of 1 copied (512 B)',
          '  links to other cloned records: 1',
          '  target file storage left: 200 MB',
          '  left out (1):',
          '    ContentDocument  Scan  12 MB — larger than 10 MB',
        ]),
      );
    });

    it('lists on a dry run every file it would copy and the size, and writes nothing', () => {
      const wouldCopy = [
        {
          objectApiName: 'ContentDocument' as const,
          sourceId: '069000000000002AAA',
          name: 'Plan',
          bytes: 2_048,
        },
        {
          objectApiName: 'Attachment' as const,
          sourceId: '00P000000000001AAA',
          name: 'log.txt',
          bytes: 512,
        },
      ];
      const lines = summaryLines(
        summary({ successCount: 0, files: { ...files, wouldCopy } }),
        true,
      );

      expect(lines).toEqual(
        expect.arrayContaining([
          '  ContentDocument  2 would be copied (3 KB, dry run, nothing written)',
          '  would copy (2):',
          '    ContentDocument  Plan  2 KB',
          '    Attachment  log.txt  512 B',
        ]),
      );
      expect(lines.some((line) => line.includes('copied (3 KB), 1 failed'))).toBe(false);
    });

    it('hands the files to a CI job in the JSON summary', () => {
      expect(jsonResult(summary({ files })).files).toEqual(files);
      expect(jsonResult(summary({})).files).toBeUndefined();
    });

    it('says on a dry run that the files could not all be looked up, never that there is none to copy', () => {
      const lookupFailure =
        'The files of the records to clone could not all be looked up in the source ' +
        '(QUERY_TIMEOUT: Your query request was running for too long.). ' +
        'Run it again, or leave the files out.';
      const nothingFound = { maxFileBytes: files.maxFileBytes, objects: [], links: 0, leftOut: [] };
      const failed = { ...nothingFound, wouldCopy: [], lookupFailure };

      const lines = summaryLines(summary({ successCount: 0, files: failed }), true);

      expect(lines).toEqual(
        expect.arrayContaining([
          'files (up to 10 MB each):',
          `  ${lookupFailure}`,
          '  A real run stops here, before writing anything.',
        ]),
      );
      expect(lines).not.toContain('  none to copy');
      expect(jsonResult(summary({ files: failed })).files?.lookupFailure).toBe(lookupFailure);
      // Every lookup answered and found nothing: then there is none to copy.
      expect(
        summaryLines(summary({ successCount: 0, files: { ...nothingFound, wouldCopy: [] } }), true),
      ).toContain('  none to copy');
    });

    it('says on a dry run that the files could not all be looked up beside those it found', () => {
      const lookupFailure =
        'The files of the records to clone could not all be looked up in the source ' +
        '(QUERY_TIMEOUT: Your query request was running for too long.). ' +
        'Run it again, or leave the files out.';

      const lines = summaryLines(summary({ files: { ...files, lookupFailure } }), true);

      expect(lines).toEqual(
        expect.arrayContaining([
          `  ${lookupFailure}`,
          '  ContentDocument  2 would be copied (3 KB, dry run, nothing written)',
        ]),
      );
    });
  });

  it("names, per object, the fields left empty because they hold a file's content", () => {
    const fileContentFieldsLeftOut = [
      { objectApiName: 'Account', fields: ['Logo__c'] },
      { objectApiName: 'QuoteDocument', fields: ['Document'] },
    ];

    const lines = summaryLines(summary({ fileContentFieldsLeftOut }));

    expect(lines).toEqual(
      expect.arrayContaining([
        "left empty, as they hold a file's content (2 object(s)):",
        '  Account  Logo__c',
        '  QuoteDocument  Document',
      ]),
    );
    expect(jsonResult(summary({ fileContentFieldsLeftOut })).fileContentFieldsLeftOut).toEqual(
      fileContentFieldsLeftOut,
    );
    expect(summaryLines(summary({})).some((line) => line.includes("a file's content"))).toBe(false);
    expect(jsonResult(summary({})).fileContentFieldsLeftOut).toBeUndefined();
  });

  it('names, per object and field, the picklist values replaced or left out, and why', () => {
    const picklistValuesChanged = [
      {
        objectApiName: 'Order__c',
        field: 'Status__c',
        reason: 'record-type' as const,
        values: ['Old'],
        rows: 2,
        recordType: 'Retail',
        replacedBy: 'New',
        replacement: 'default' as const,
      },
      {
        objectApiName: 'Invoice__c',
        field: 'Kind__c',
        reason: 'not-in-target' as const,
        values: ['Gone'],
        rows: 1,
      },
    ];

    const lines = summaryLines(summary({ picklistValuesChanged }));

    expect(lines).toEqual(
      expect.arrayContaining([
        'picklist values not written as read (2 object(s)):',
        '  Order__c  Status__c on 2 rows: "Old" not allowed for record type Retail, replaced by "New", the default of record type Retail',
        '  Invoice__c  Kind__c on 1 row: "Gone" not a value of the field in the target, left out',
      ]),
    );
    expect(jsonResult(summary({ picklistValuesChanged })).picklistValuesChanged).toEqual(
      picklistValuesChanged,
    );
    expect(summaryLines(summary({})).some((line) => line.includes('picklist'))).toBe(false);
    expect(jsonResult(summary({})).picklistValuesChanged).toBeUndefined();
  });

  it('names each field rows were written again without, what refused it — a validation rule, a restricted picklist or a lookup filter — and why', () => {
    const writtenWithoutFields = [
      {
        objectApiName: 'Contact',
        rows: 2,
        fields: [
          {
            field: 'Phone',
            refusedBy: 'validation-rule' as const,
            reason: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Bad phone',
            rows: 2,
          },
          {
            field: 'Rating__c',
            refusedBy: 'restricted-picklist' as const,
            reason:
              'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Yes',
            rows: 1,
          },
          {
            field: 'Preferred_Account__c',
            refusedBy: 'lookup-filter' as const,
            reason: 'FIELD_FILTER_VALIDATION_EXCEPTION: Value does not exist',
            rows: 1,
          },
          // Recorded before a picklist's refusal was written again: a rule's.
          { field: 'Email', reason: 'FIELD_CUSTOM_VALIDATION_EXCEPTION: Bad mail', rows: 1 },
        ],
      },
    ];

    const lines = summaryLines(summary({ writtenWithoutFields }));

    expect(lines).toEqual(
      expect.arrayContaining([
        'written again without a field the target refused (1 object(s)):',
        '  Contact.Phone  2 record(s) — a validation rule refused it — FIELD_CUSTOM_VALIDATION_EXCEPTION: Bad phone',
        '  Contact.Rating__c  1 record(s) — a restricted picklist refused its value — ' +
          'INVALID_OR_NULL_FOR_RESTRICTED_PICKLIST: bad value for restricted picklist field: Yes',
        '  Contact.Preferred_Account__c  1 record(s) — a lookup filter refused the record it ' +
          'names — FIELD_FILTER_VALIDATION_EXCEPTION: Value does not exist',
        '  Contact.Email  1 record(s) — a validation rule refused it — FIELD_CUSTOM_VALIDATION_EXCEPTION: Bad mail',
      ]),
    );
    expect(jsonResult(summary({ writtenWithoutFields })).writtenWithoutFields).toEqual(
      writtenWithoutFields,
    );
    expect(summaryLines(summary({})).some((line) => line.includes('validation rule'))).toBe(false);
    expect(jsonResult(summary({}))).not.toHaveProperty('writtenWithoutFields');
  });

  it('prints the reason an object was held back, from its error samples', () => {
    const lines = summaryLines(
      summary({
        successCount: 0,
        failedCount: 2,
        errors: [
          {
            objectApiName: 'Case',
            stage: 'scope',
            failedCount: 2,
            attemptedCount: 0,
            samples: [
              {
                recordSummary: 'RecordType=Partner_Case (2 records)',
                messages: ['RECORD_TYPE_UNAVAILABLE: 2 Case records use record type Partner_Case.'],
              },
            ],
          },
        ],
      }),
    );

    expect(lines).toContain('  [scope] Case  2/0');
    expect(lines).toContain('    RecordType=Partner_Case (2 records)');
    expect(lines).toContain(
      '      └ RECORD_TYPE_UNAVAILABLE: 2 Case records use record type Partner_Case.',
    );
  });

  it('prints every group of errors an object carries, not the first two', () => {
    // Grouped by reason, the samples say why each group failed: a product
    // clone's 31 held-back products came in groups of 21, 7 and 3, and the
    // command printed the first two.
    const group = (count: number, why: string) => ({
      recordSummary: `PricebookEntryId → ProductSellingModelOption (${count} records)`,
      messages: [why],
    });
    const lines = summaryLines(
      summary({
        successCount: 0,
        failedCount: 31,
        errors: [
          {
            objectApiName: 'Product2',
            stage: 'scope',
            failedCount: 31,
            attemptedCount: 0,
            samples: [
              group(21, 'first reason'),
              group(7, 'second reason'),
              group(3, 'third reason'),
            ],
          },
        ],
      }),
    );

    expect(lines.filter((line) => line.startsWith('      └ '))).toEqual([
      '      └ first reason',
      '      └ second reason',
      '      └ third reason',
    ]);
  });
});

describe('sandforge-clone object outcomes', () => {
  const event = (status: ForgeProgressEvent['status'], message: string): ForgeProgressEvent => ({
    objectName: 'Contact',
    status,
    progress: 100,
    message,
  });

  it("prints what each object came to, a dry run's counts included", () => {
    expect(
      objectOutcomeLine(event('done', '[dry-run] Contact: 2 record(s) would be inserted')),
    ).toBe('  [dry-run] Contact: 2 record(s) would be inserted');
    expect(objectOutcomeLine(event('error', 'Contact: 1 failed'))).toBe('  Contact: 1 failed');
  });

  it('prints what a dry run read, a step its simulated write ends, and that end', () => {
    expect(
      objectOutcomeLine(event('running', '[dry-run] Contact: 2 record(s) would be inserted')),
    ).toBe('  [dry-run] Contact: 2 record(s) would be inserted');
    expect(
      objectOutcomeLine(event('done', 'Simulated Contact: 2 would be inserted, 0 failed')),
    ).toBe('  Simulated Contact: 2 would be inserted, 0 failed');
    expect(
      objectOutcomeLine(
        event('running', 'Simulating the write of 2 Contact records: nothing is sent...'),
      ),
    ).toBeUndefined();
  });

  it('prints a skipped object with the reason it was skipped, as it prints the others', () => {
    expect(
      objectOutcomeLine(
        event('skipped', 'Skipped Contact (out of scope: no parent in cache and not the root)'),
      ),
    ).toBe('  Skipped Contact (out of scope: no parent in cache and not the root)');
    expect(objectOutcomeLine(event('skipped', 'Skipped Contact (parent failed)'))).toBe(
      '  Skipped Contact (parent failed)',
    );
  });

  it('prints an object a cancel stopped while it was written, with what it never sent', () => {
    expect(
      objectOutcomeLine(event('stopped', 'Stopped Contact: 200 succeeded, 0 failed, 250 not sent')),
    ).toBe('  Stopped Contact: 200 succeeded, 0 failed, 250 not sent');
  });

  it('prints nothing for a step on the way, or an end that says nothing', () => {
    expect(objectOutcomeLine(event('running', 'Contact: reading'))).toBeUndefined();
    expect(objectOutcomeLine(event('scanning', 'Querying Contact records...'))).toBeUndefined();
    expect(objectOutcomeLine(event('done', ''))).toBeUndefined();
    expect(objectOutcomeLine(event('skipped', ''))).toBeUndefined();
  });

  describe('of a graph most of which discovery left out', () => {
    const node = (objectApiName: string, overrides: Partial<ForgeGraphNode>): ForgeGraphNode => ({
      objectApiName,
      recordCount: 0,
      fieldCount: 5,
      status: 'idle',
      progress: 0,
      included: false,
      piiFields: [],
      anonymizeFields: [],
      level: 1,
      successCount: 0,
      failureCount: 0,
      errors: [],
      createableFieldCount: 4,
      estimatedSizeMB: 0,
      estimatedApiCalls: 0,
      batchStrategy: 'auto',
      ...overrides,
    });
    /**
     * An opportunity, the objects `emptyTables` names, left out for an empty
     * table, one left out because its count failed, and a campaign nothing
     * read points at.
     */
    const graph = (emptyTables: string[]): ForgeGraph => ({
      nodes: [
        node('Opportunity', { recordCount: 1, included: true, level: 0 }),
        ...emptyTables.map((name) => node(name, {})),
        node('Survey', {
          status: 'error',
          errors: ['Record count unavailable: INSUFFICIENT_ACCESS'],
        }),
        node('Campaign', { recordCount: 40, included: true }),
      ],
      edges: [],
      totalRecords: 41,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    });
    const of = (objectName: string, status: ForgeProgressEvent['status'], message: string) => ({
      objectName,
      status,
      progress: 100,
      message,
    });
    /** What the executor says of Survey's skip: left out, and the error discovery gave. */
    const SURVEY_SKIP = 'Skipped Survey (excluded: Record count unavailable: INSUFFICIENT_ACCESS)';
    /** What the run prints of `events`, line by line. */
    const printed = (run: ForgeGraph, events: ForgeProgressEvent[]): string[] => {
      const line = objectOutcomePrinter(run);
      return events.flatMap((e) => line(e) ?? []);
    };

    it('says in one line how many objects it left out for an empty table, where the first comes', () => {
      const lines = printed(graph(['Lead', 'Asset', 'Contract']), [
        of('Opportunity', 'done', '[dry-run] Opportunity: 1 record(s) would be inserted'),
        of('Lead', 'skipped', 'Skipped Lead (excluded)'),
        of('Asset', 'skipped', 'Skipped Asset (excluded)'),
        of('Survey', 'skipped', SURVEY_SKIP),
        of('Contract', 'skipped', 'Skipped Contract (excluded)'),
        of('Campaign', 'skipped', 'Skipped Campaign (out of scope: no parent in cache)'),
      ]);

      expect(lines).toEqual([
        '  [dry-run] Opportunity: 1 record(s) would be inserted',
        '  Skipped 3 objects (excluded: empty tables; --list-objects names them)',
        `  ${SURVEY_SKIP}`,
        '  Skipped Campaign (out of scope: no parent in cache)',
      ]);
    });

    it('names an empty table when it is the only one left out', () => {
      expect(
        printed(graph(['Lead']), [
          of('Lead', 'skipped', 'Skipped Lead (excluded)'),
          of('Survey', 'skipped', SURVEY_SKIP),
        ]),
      ).toEqual(['  Skipped Lead (excluded)', `  ${SURVEY_SKIP}`]);
    });
  });
});

describe('sandforge-clone describe adapter', () => {
  const field = (name: string, cascadeDelete: boolean) => ({
    name,
    type: 'reference',
    referenceTo: ['Account'],
    relationshipName: `${name}__r`,
    cascadeDelete,
  });

  it('labels a field that cascades on delete as master-detail', () => {
    const raw = {
      name: 'Contact',
      fields: [field('Parent__c', true), field('AccountId', false)],
      childRelationships: [],
    } as unknown as DescribeSObjectResult;

    const adapted = adaptDescribe(raw);

    expect(adapted.fields.map((f) => [f.name, f.isMasterDetail])).toEqual([
      ['Parent__c', true],
      ['AccountId', false],
    ]);
  });

  it('says of each field whether an insert or an update can set it', () => {
    // A person account's lookup at its contact: neither can, and discovery
    // must know it, or the contact orders the account's write.
    const raw = {
      name: 'Account',
      fields: [
        { ...field('PersonContactId', false), createable: false, updateable: false },
        { ...field('ParentId', false), createable: true, updateable: true },
      ],
      childRelationships: [],
    } as unknown as DescribeSObjectResult;

    const adapted = adaptDescribe(raw);

    expect(adapted.fields.map((f) => [f.name, f.createable, f.updateable])).toEqual([
      ['PersonContactId', false, false],
      ['ParentId', true, true],
    ]);
  });
});

describe('sandforge-clone anonymization', () => {
  /** A discovered node, with the PII fields discovery selected on it. */
  const node = (objectApiName: string, anonymizeFields: string[]): ForgeGraphNode => ({
    objectApiName,
    recordCount: 1,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: anonymizeFields,
    anonymizeFields,
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 4,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  });
  const graph: ForgeGraph = {
    nodes: [node('Contact', ['Email', 'Phone']), node('Account', [])],
    edges: [],
    totalRecords: 2,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };

  it('asks the run to anonymize the fields discovery selected when --anonymize is given', () => {
    const options = executeOptions(parseArgs(argv('--anonymize')), graph, []);

    expect(options.anonymization).toEqual({
      fields: { Contact: ['Email', 'Phone'], Account: [] },
      methods: {},
    });
  });

  it('hands the run what discovery names, for the orphan parents it fetches from outside the graph', () => {
    const personalFieldsOf = (fields: Array<{ name: string; type: string }>): string[] =>
      fields.filter((f) => f.type === 'email').map((f) => f.name);

    const options = executeOptions(parseArgs(argv('--anonymize')), graph, [], personalFieldsOf);

    expect(options.anonymization?.personalFieldsOf).toBe(personalFieldsOf);
  });

  it('asks for no anonymization without --anonymize', () => {
    const options = executeOptions(parseArgs(argv()), graph, []);

    expect(options.anonymization).toBeUndefined();
  });
});

describe('sandforge-clone contact points', () => {
  const graph: ForgeGraph = {
    nodes: [],
    edges: [],
    totalRecords: 0,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };

  it('has the run neutralize every email address and phone number without --keep-contact-points', () => {
    const args = parseArgs(argv());

    expect(args.keepContactPoints).toBe(false);
    expect(executeOptions(args, graph, []).keepContactPoints).toBe(false);
  });

  it('has the run write them as read with --keep-contact-points, anonymized or not', () => {
    for (const extra of [[], ['--anonymize']]) {
      const args = parseArgs(argv('--keep-contact-points', ...extra));

      expect(args.keepContactPoints).toBe(true);
      expect(executeOptions(args, graph, []).keepContactPoints).toBe(true);
    }
  });

  it('says how many values of which fields went neutralized, or would on a dry run', () => {
    const report = {
      neutralized: true,
      fields: [
        { objectApiName: 'Contact', field: 'Email', kind: 'email' as const, values: 3 },
        { objectApiName: 'Contact', field: 'SMS_Number__c', kind: 'phone' as const, values: 2 },
      ],
      values: 5,
    };

    expect(contactPointLines(report, false)).toEqual([
      'contact points: 5 value(s) in 2 field(s) neutralized — emails under .invalid, phone ' +
        'numbers in a fictional range',
      '  Contact.Email  3',
      '  Contact.SMS_Number__c  2',
    ]);
    expect(contactPointLines(report, true)[0]).toContain(
      'would be neutralized (dry run, nothing written)',
    );
  });

  it('says how many phone numbers went empty once the fictional numbers ran out', () => {
    const lines = contactPointLines(
      {
        neutralized: true,
        fields: [{ objectApiName: 'Contact', field: 'Phone', kind: 'phone' as const, values: 3 }],
        values: 3,
        numbersExhausted: 2,
      },
      false,
    );

    expect(lines.at(-1)).toBe(
      '  2 phone number(s) left out, their field empty: the 10 000 fictional numbers were all ' +
        'given to other numbers of the run',
    );
  });

  it('says the records went with their own addresses and numbers under --keep-contact-points', () => {
    expect(contactPointLines({ neutralized: false, fields: [], values: 0 }, false)).toEqual([
      "contact points: written as read (--keep-contact-points): the target's flows and email " +
        'alerts may reach the people the records name',
    ]);
  });
});

describe('sandforge-clone describes', () => {
  describe('describeOnce', () => {
    const account = { name: 'Account' } as DescribeSObjectResult;

    it('asks an org for an object once, and shares the answer still to come', async () => {
      const describe = vi.fn(async () => account);
      const described = describeOnce(describe);

      const answers = await Promise.all([
        described('SRC', 'Account'),
        described('SRC', 'Account'),
        described('TGT', 'Account'),
      ]);
      await described('SRC', 'Account');

      expect(answers).toEqual([account, account, account]);
      expect(describe.mock.calls).toEqual([
        ['SRC', 'Account'],
        ['TGT', 'Account'],
      ]);
    });

    it('asks again for a describe that failed', async () => {
      const describe = vi
        .fn<(orgId: string, objectName: string) => Promise<DescribeSObjectResult>>()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValue(account);
      const described = describeOnce(describe);

      await expect(described('SRC', 'Account')).rejects.toThrow('ECONNRESET');
      await expect(described('SRC', 'Account')).resolves.toBe(account);
      expect(describe).toHaveBeenCalledTimes(2);
    });
  });

  describe('of a run', () => {
    const ACCOUNT = '001000000000001AAA';
    /** An object as both fake orgs describe it. */
    const object = (
      name: string,
      keyPrefix: string,
      fields: Array<Record<string, unknown>>,
      childRelationships: Array<Record<string, unknown>> = [],
    ) =>
      ({
        name,
        keyPrefix,
        createable: true,
        recordTypeInfos: [],
        childRelationships,
        fields: [
          { name: 'Id', type: 'id', createable: false, nillable: false },
          ...fields.map((f) => ({ type: 'string', createable: true, nillable: true, ...f })),
        ].map((f) => ({ referenceTo: [], relationshipName: null, cascadeDelete: false, ...f })),
      }) as unknown as DescribeSObjectResult;
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
      Account: [{ Id: ACCOUNT, Name: 'Acme' }],
      Contact: [{ Id: '003000000000001AAA', LastName: 'Key', AccountId: ACCOUNT }],
    };

    /** The id of the org the fake target says it is. */
    const TARGET_ORG = '00D000000000002AAA';

    /**
     * The queries of the read of the target's automation over the regular
     * API, which says its own requests and counts none among the run's.
     */
    const AUTOMATION_READ =
      / FROM (FlowDefinitionView|DuplicateRule|AssignmentRule|UserSetupEntityAccess|FlowVariableView|EntityDefinition) /;

    /**
     * An org holding an account and its contact, the objects it was asked to
     * describe and the records written to it. Its Organization record says it
     * is a sandbox, unless `sandbox` says otherwise.
     */
    function fakeOrg({ id = TARGET_ORG, sandbox = true }: { id?: string; sandbox?: boolean } = {}) {
      const asked: string[] = [];
      const written: Array<Record<string, unknown>> = [];
      const conn = {
        sobject: (name: string) => ({
          describe: async () => {
            asked.push(name);
            return DESCRIBES[name];
          },
          create: async (records: Array<Record<string, unknown>>) => {
            written.push(...records);
            const prefix = String(DESCRIBES[name]?.keyPrefix);
            return records.map((_, i) => ({
              id: `${prefix}00000000090${i}AAA`,
              success: true,
              errors: [],
            }));
          },
        }),
        // jsforce's cache, which the describe of the object filled.
        describe$: async (name: string) => DESCRIBES[name],
        describeGlobal: async () => ({
          sobjects: Object.values(DESCRIBES).map(({ name, keyPrefix }) => ({ name, keyPrefix })),
        }),
        query: async (soql: string) => {
          if (soql === 'SELECT Id, IsSandbox FROM Organization LIMIT 1') {
            return { totalSize: 1, records: [{ Id: id, IsSandbox: sandbox }] };
          }
          const counted = /^SELECT COUNT\(\) FROM (\w+)$/.exec(soql);
          if (counted) return { totalSize: (ROWS[counted[1]] ?? []).length, records: [] };
          if (soql.includes(' FROM RecordType ')) return { totalSize: 0, records: [] };
          // No flow runs on its objects, and no trigger: a run need not be
          // told to go on regardless.
          if (soql.includes(' FROM FlowDefinitionView ')) return { totalSize: 0, records: [] };
          const records = selectRows(ROWS, soql);
          return { totalSize: records.length, records };
        },
        tooling: {
          query: async () => ({ totalSize: 0, done: true, records: [] }),
          queryMore: async () => ({ totalSize: 0, done: true, records: [] }),
        },
        // Where a real connection sends every call, which the run counts.
        // These methods answer without it, and the limits it is asked for
        // say nothing of the data storage.
        request: async () => ({}),
      };
      return { conn: conn as unknown as Connection, asked, written };
    }

    let realLoadOrg: typeof loadOrg;
    let realMakeConn: typeof makeConn;
    let printed: string[];

    beforeEach(async () => {
      ({ loadOrg: realLoadOrg, makeConn: realMakeConn } =
        await vi.importActual<typeof import('./sfSession.js')>('./sfSession.js'));
      printed = [];
      vi.spyOn(console, 'log').mockImplementation((line: unknown) => {
        printed.push(String(line));
      });
      vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
        throw new ExitCalled(typeof code === 'number' ? code : undefined);
      });
    });

    afterEach(() => {
      vi.mocked(loadOrg).mockImplementation(realLoadOrg);
      vi.mocked(makeConn).mockImplementation(realMakeConn);
      vi.restoreAllMocks();
    });

    it('asks each org to describe an object once, whichever steps of the run read it', async () => {
      // Discovery, the catalog step and each object's read described the
      // same objects of the source again: three requests an object on a dry
      // run, where the extension, which caches its describes, sent one.
      const orgs = { SRC: fakeOrg(), TGT: fakeOrg() };
      vi.mocked(loadOrg).mockImplementation(async (alias) => ({
        alias,
        username: '',
        instanceUrl: `https://${alias.toLowerCase()}.example.com`,
        accessToken: 'token',
      }));
      vi.mocked(makeConn).mockImplementation((org) => orgs[org.alias as keyof typeof orgs].conn);

      expect(await run(argv('--dry-run', '--skip-preflight'))).toBeUndefined();

      expect(printed).toContain('  [dry-run] Contact: 1 record(s) would be inserted');
      expect(orgs.SRC.asked.sort()).toEqual(['Account', 'Contact']);
      expect(orgs.TGT.asked.sort()).toEqual(['Account', 'Contact']);
    });

    /** Both fake orgs answering for the aliases of `argv`; the target a sandbox unless told. */
    function withFakeOrgs({ targetSandbox = true }: { targetSandbox?: boolean } = {}) {
      const orgs = {
        SRC: fakeOrg({ id: '00D000000000001AAA' }),
        TGT: fakeOrg({ sandbox: targetSandbox }),
      };
      vi.mocked(loadOrg).mockImplementation(async (alias) => ({
        alias,
        username: '',
        instanceUrl: `https://${alias.toLowerCase()}.example.com`,
        accessToken: 'token',
      }));
      vi.mocked(makeConn).mockImplementation((org) => orgs[org.alias as keyof typeof orgs].conn);
      return orgs;
    }

    it('counts the record types it reads for the run among the calls the run made, as the extension does', async () => {
      // The extension adds the record types it reads before the run to the
      // calls it says the run made. The command counted from the executor's
      // start: "calls: 2" of a run that read both orgs' record types as well.
      // Discovery's counts and the preflight's are the run's in neither.
      const orgs = withFakeOrgs();
      const sent: string[] = [];
      for (const { conn } of Object.values(orgs)) {
        const fake = conn as unknown as {
          query: (soql: string) => Promise<unknown>;
          request: (request: unknown) => Promise<unknown>;
        };
        const answer = fake.query;
        // As on a real connection: a query goes out through `request`, where
        // the command counts what it sends.
        fake.query = async (soql: string) => {
          sent.push(soql);
          await fake.request(soql);
          return answer(soql);
        };
      }

      expect(await run(argv('--dry-run'))).toBeUndefined();

      const recordTypes = sent.filter((soql) => soql.includes(' FROM RecordType '));
      // The read of the target's automation says its own requests, as
      // discovery's counts are not the run's either.
      const reads = sent.filter(
        (soql) =>
          !soql.startsWith('SELECT COUNT()') &&
          !soql.includes(' FROM RecordType ') &&
          !AUTOMATION_READ.test(soql),
      );
      expect(recordTypes).toHaveLength(2);
      expect(reads.length).toBeGreaterThan(0);
      expect(sent.length).toBeGreaterThan(recordTypes.length + reads.length);
      // And the target's limits, read once every row is in hand.
      expect(printed).toContain(
        `calls:   ${recordTypes.length + reads.length + 1} (requests the run sent to both orgs)`,
      );
    });

    it('reads every page of the record types, and counts each among the calls the run made', async () => {
      // The page after the first is a request of its own: read, it is one of
      // the run's calls, as the extension counts it.
      const orgs = withFakeOrgs();
      const NEXT = '/services/data/v66.0/query/01g000000000001-2000';
      const sent: string[] = [];
      for (const [alias, { conn }] of Object.entries(orgs)) {
        const fake = conn as unknown as {
          query: (soql: string) => Promise<unknown>;
          queryMore: (url: string) => Promise<unknown>;
          request: (request: unknown) => Promise<unknown>;
        };
        const answer = fake.query;
        /** A record type of `object` in this org, fake Id and all. */
        const recordType = (object: string, suffix: string) => ({
          Id: `012000000000${alias}${suffix}`,
          Name: 'Business',
          DeveloperName: 'Business',
          SobjectType: object,
        });
        // As on a real connection: a query and each page after it go out
        // through `request`, where the command counts what it sends.
        fake.query = async (soql: string) => {
          sent.push(soql);
          await fake.request(soql);
          if (!soql.includes(' FROM RecordType ')) return answer(soql);
          return {
            totalSize: 2,
            done: false,
            nextRecordsUrl: NEXT,
            records: [recordType('Account', 'A')],
          };
        };
        fake.queryMore = async (url: string) => {
          sent.push(url);
          await fake.request(url);
          return { totalSize: 2, done: true, records: [recordType('Contact', 'C')] };
        };
      }

      expect(await run(argv('--dry-run'))).toBeUndefined();

      const recordTypes = sent.filter(
        (asked) => asked.includes(' FROM RecordType ') || asked === NEXT,
      );
      const reads = sent.filter(
        (asked) =>
          !asked.startsWith('SELECT COUNT()') &&
          !asked.includes(' FROM RecordType ') &&
          !AUTOMATION_READ.test(asked) &&
          asked !== NEXT,
      );
      expect(recordTypes).toHaveLength(4);
      expect(printed).toContain('record-types: 2 mappings');
      // And the target's limits, read once every row is in hand.
      expect(printed).toContain(
        `calls:   ${recordTypes.length + reads.length + 1} (requests the run sent to both orgs)`,
      );
    });

    it('reads every page of a query, not the first alone', async () => {
      // A query answers with 2 000 records at most and a cursor to the rest:
      // the command read the first page and cloned a bigger scope short.
      const orgs = withFakeOrgs();
      const source = orgs.SRC.conn as unknown as {
        query: (soql: string) => Promise<unknown>;
        queryMore: (url: string) => Promise<unknown>;
      };
      const firstPage = source.query;
      const nextContact = { Id: '003000000000002AAA', LastName: 'Second', AccountId: ACCOUNT };
      source.query = async (soql: string) => {
        const page = (await firstPage(soql)) as { totalSize: number; records: FakeRow[] };
        if (!/^SELECT (?!COUNT\(\)).* FROM Contact\b/.test(soql)) return page;
        return { ...page, done: false, nextRecordsUrl: '/query/next-contacts' };
      };
      source.queryMore = async (url: string) => {
        expect(url).toBe('/query/next-contacts');
        return { totalSize: 2, done: true, records: [nextContact] };
      };

      expect(await run(argv('--dry-run', '--skip-preflight'))).toBeUndefined();

      expect(printed).toContain('  [dry-run] Contact: 2 record(s) would be inserted');
    });

    it('leaves out an object --exclude-object names, and says so where it prints the others', async () => {
      withFakeOrgs();

      expect(
        await run(argv('--dry-run', '--skip-preflight', '--exclude-object', 'Contact')),
      ).toBeUndefined();

      expect(printed).toContain('  Skipped Contact (excluded)');
      expect(printed.some((line) => line.includes('[dry-run] Contact'))).toBe(false);
    });

    it('lists an object --exclude-object names as excluded', async () => {
      withFakeOrgs();

      expect(await run(argv('--list-objects', '--exclude-object', 'Contact'))).toBeUndefined();

      expect(printed.join('\n')).toMatch(/Contact\s+1\s+depth 1\s+\(excluded\)/);
    });

    describe('with --upsert by an email external id', () => {
      /** The contact's describe, with an email external id an upsert matches by. */
      const keyed = object('Contact', '003', [
        { name: 'LastName' },
        { name: 'AccountId', type: 'reference', referenceTo: ['Account'] },
        { name: 'Login_Email__c', type: 'email', externalId: true },
      ]);
      let plain: DescribeSObjectResult;
      beforeEach(() => {
        plain = DESCRIBES.Contact;
        DESCRIBES.Contact = keyed;
      });
      afterEach(() => {
        DESCRIBES.Contact = plain;
      });

      it('says before the run that the key goes neutralized and matches no copy holding the real address', async () => {
        withFakeOrgs();

        expect(await run(argv('--dry-run', '--skip-preflight', '--upsert'))).toBeUndefined();

        const at = printed.findIndex((line) => line.startsWith('upsert keys: '));
        expect(printed[at]).toBe(
          'upsert keys: --upsert matches the records of TGT by these external ids, which the ' +
            'run writes neutralized (emails under .invalid, phone numbers in a fictional range): ' +
            'a record of TGT holding the real address or number is not matched, and the run ' +
            'creates another beside it; one an earlier run wrote neutralized is. ' +
            '--keep-contact-points matches the real ones',
        );
        expect(printed[at + 1]).toBe('  Contact.Login_Email__c (email)');
        expect(at).toBeLessThan(printed.indexOf('record-type mapping…'));
      });

      it('hands the key to a CI job in the JSON summary', async () => {
        withFakeOrgs();
        let stdout = '';
        vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
          stdout += String(chunk);
          return true;
        });
        vi.spyOn(console, 'error').mockImplementation(() => undefined);

        expect(
          await run(argv('--dry-run', '--skip-preflight', '--upsert', '--json')),
        ).toBeUndefined();

        expect((JSON.parse(stdout) as Record<string, unknown>).neutralizedUpsertKeys).toEqual([
          { objectApiName: 'Contact', field: 'Login_Email__c', kind: 'email' },
        ]);
      });

      it('says nothing of it with --keep-contact-points, or without --upsert', async () => {
        for (const extra of [['--upsert', '--keep-contact-points'], []]) {
          withFakeOrgs();
          printed = [];

          expect(await run(argv('--dry-run', '--skip-preflight', ...extra))).toBeUndefined();

          expect(printed.some((line) => line.startsWith('upsert keys: '))).toBe(false);
        }
      });
    });

    it("writes a record type's default in place of a value it does not keep, read once from the target's UI API", async () => {
      // "Hot" is active in the target, and not kept by the record type the
      // account goes in with there: written as read, the account is refused.
      const SOURCE_RETAIL = '012000000000001AAA';
      const TARGET_RETAIL = '012000000000101AAA';
      const account = object('Account', '001', [
        { name: 'Name' },
        {
          name: 'RecordTypeId',
          type: 'reference',
          referenceTo: ['RecordType'],
          relationshipName: 'RecordType',
        },
        {
          name: 'Rating__c',
          type: 'picklist',
          restrictedPicklist: true,
          picklistValues: [
            { value: 'Hot', active: true },
            { value: 'Cold', active: true },
          ],
        },
      ]);
      const rows: Record<string, FakeRow[]> = {
        Account: [{ Id: ACCOUNT, Name: 'Acme', RecordTypeId: SOURCE_RETAIL, Rating__c: 'Hot' }],
      };
      const written: Array<Record<string, unknown>> = [];
      const asked: string[] = [];
      const typedOrg = (recordTypeId: string) =>
        ({
          version: '66.0',
          sobject: () => ({
            describe: async () => account,
            create: async (records: Array<Record<string, unknown>>) => {
              written.push(...records);
              return records.map(() => ({ id: '001000000000901AAA', success: true, errors: [] }));
            },
          }),
          describe$: async () => account,
          describeGlobal: async () => ({ sobjects: [{ name: 'Account', keyPrefix: '001' }] }),
          query: async (soql: string) => {
            if (soql === 'SELECT Id, IsSandbox FROM Organization LIMIT 1') {
              return { totalSize: 1, done: true, records: [{ Id: TARGET_ORG, IsSandbox: true }] };
            }
            if (soql.includes(' FROM RecordType ')) {
              const records = [
                {
                  Id: recordTypeId,
                  Name: 'Retail',
                  DeveloperName: 'Retail',
                  SobjectType: 'Account',
                },
              ];
              return { totalSize: 1, done: true, records };
            }
            const counted = /^SELECT COUNT\(\) FROM (\w+)$/.exec(soql);
            if (counted) return { totalSize: (rows[counted[1]] ?? []).length, records: [] };
            // No flow and no trigger of the target fires as the account goes in.
            if (soql.includes(' FROM FlowDefinitionView ')) {
              return { totalSize: 0, done: true, records: [] };
            }
            const records = selectRows(rows, soql);
            return { totalSize: records.length, done: true, records };
          },
          tooling: {
            query: async () => ({ totalSize: 0, done: true, records: [] }),
            queryMore: async () => ({ totalSize: 0, done: true, records: [] }),
          },
          request: async (url: unknown) => {
            if (typeof url === 'string' && url.includes('/ui-api/')) {
              asked.push(url);
              return {
                picklistFieldValues: {
                  Rating__c: {
                    controllerValues: {},
                    defaultValue: { value: 'Cold', validFor: [] },
                    values: [{ value: 'Cold', validFor: [] }],
                  },
                },
              };
            }
            return {};
          },
        }) as unknown as Connection;
      const orgs = { SRC: typedOrg(SOURCE_RETAIL), TGT: typedOrg(TARGET_RETAIL) };
      vi.mocked(loadOrg).mockImplementation(async (alias) => ({
        alias,
        username: '',
        instanceUrl: `https://${alias.toLowerCase()}.example.com`,
        accessToken: 'token',
      }));
      vi.mocked(makeConn).mockImplementation((org) => orgs[org.alias as keyof typeof orgs]);

      expect(await run(argv('--skip-preflight'))).toBeUndefined();

      expect(asked).toEqual([
        `/services/data/v66.0/ui-api/object-info/Account/picklist-values/${TARGET_RETAIL}`,
      ]);
      expect(written).toEqual([{ Name: 'Acme', RecordTypeId: TARGET_RETAIL, Rating__c: 'Cold' }]);
      expect(printed).toContain(
        '  Completed Account: 1 succeeded, 0 failed, picklist values not written as read: ' +
          'Rating__c on 1 row: "Hot" not allowed for record type Retail, replaced by "Cold", ' +
          'the default of record type Retail',
      );
      expect(printed).toContain('picklist values not written as read (1 object(s)):');
    });

    it('refuses to leave out the object of the record to clone, before reading a row', async () => {
      const stderr: string[] = [];
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      });
      withFakeOrgs();

      expect(await run(argv('--dry-run', '--exclude-object', 'Account'))).toBe(2);

      expect(stderr.join('')).toContain(
        '--exclude-object Account: the record to clone is of this object, and nothing would be',
      );
      expect(printed.some((line) => line.includes('executing'))).toBe(false);
    });

    /** What the run writes to stdout and to stderr, chunk by chunk, from here on. */
    function captureStreams() {
      const stdout: string[] = [];
      const stderr: string[] = [];
      vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
        stdout.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
        stderr.push(String(chunk));
        return true;
      });
      vi.spyOn(console, 'error').mockImplementation((line: unknown) => {
        stderr.push(`${String(line)}\n`);
      });
      return { stdout, stderr };
    }

    it('prints the JSON summary alone on stdout under --json, and every other line on stderr', async () => {
      // A CI job saves stdout to a file and parses it: the banner, the
      // discovery and preflight lines and "executing…" came in front of the
      // JSON, and no parser read it.
      withFakeOrgs();
      const { stdout, stderr } = captureStreams();

      expect(await run(argv('--dry-run', '--json'))).toBeUndefined();

      // console.log writes to stdout: nothing went through it.
      expect(printed).toEqual([]);
      expect(JSON.parse(stdout.join(''))).toMatchObject({ tool: 'sandforge-clone', dryRun: true });
      const said = stderr.join('');
      expect(said).toContain('sandforge-clone  SRC -> TGT  record=001000000000001AAA');
      expect(said).toContain('discovery…');
      expect(said).toContain('preflight (target row counts)…');
      expect(said).toContain('executing… (DRY-RUN)');
      expect(said).toContain('  [dry-run] Contact: 1 record(s) would be inserted');
    });

    it('says before the run what becomes of the contact points, and in the JSON summary after it', async () => {
      for (const keep of [false, true]) {
        withFakeOrgs();
        const { stdout, stderr } = captureStreams();

        expect(
          await run(argv('--dry-run', '--json', ...(keep ? ['--keep-contact-points'] : []))),
        ).toBeUndefined();

        expect(stderr.join('')).toContain(
          keep
            ? 'contact points: written as read (--keep-contact-points)'
            : 'contact points: neutralized before writing (emails under .invalid, phone numbers in a fictional range)',
        );
        expect(JSON.parse(stdout.join('')).result.contactPoints).toEqual({
          neutralized: !keep,
          fields: [],
          values: 0,
        });
      }
    });

    it('prints the objects of the graph as JSON alone on stdout under --list-objects --json', async () => {
      // stdout carries the JSON alone under --json, and the listing is not
      // JSON: it went to stderr, and a CI job that saved the objects a clone
      // would reach read an empty file.
      withFakeOrgs();
      const { stdout, stderr } = captureStreams();

      expect(
        await run(argv('--list-objects', '--json', '--exclude-object', 'Contact')),
      ).toBeUndefined();

      expect(printed).toEqual([]);
      expect(JSON.parse(stdout.join(''))).toMatchObject({
        tool: 'sandforge-clone',
        version: 1,
        action: 'list-objects',
        source: 'SRC',
        target: 'TGT',
        record: ACCOUNT,
        graph: { nodes: 2, truncated: false },
        objects: [
          { objectApiName: 'Account', recordCount: 1, depth: 0, included: true },
          { objectApiName: 'Contact', recordCount: 1, depth: 1, included: false },
        ],
      });
      expect(stderr.join('')).toMatch(/objects in the graph \(2\):\n {2}Account\s+1\s+depth 0/);
    });

    it('says in the JSON of --list-objects that discovery stopped at its cap', async () => {
      withFakeOrgs();
      const { stdout } = captureStreams();

      expect(await run(argv('--list-objects', '--json', '--max-nodes', '1'))).toBeUndefined();

      const listing = JSON.parse(stdout.join('')) as {
        graph: { truncated: boolean };
        objects: Array<{ objectApiName: string }>;
      };
      expect(listing.graph.truncated).toBe(true);
      expect(listing.objects.map((o) => o.objectApiName)).toEqual(['Account']);
    });

    it('writes no JSON under --list-objects without --json, only the listing', async () => {
      withFakeOrgs();
      const { stdout } = captureStreams();

      expect(await run(argv('--list-objects'))).toBeUndefined();

      expect(stdout).toEqual([]);
      expect(printed).toContain('\nobjects in the graph (2):');
    });

    it('refuses to clone into a production org before reading a row, and writes nothing', async () => {
      const orgs = withFakeOrgs({ targetSandbox: false });
      const { stderr } = captureStreams();

      expect(await run(argv('--skip-preflight'))).toBe(1);

      expect(stderr.join('')).toContain(
        'TGT is a production org (its Organization record says IsSandbox false, and no ' +
          'edition): sandforge-clone writes to sandboxes and Developer Edition orgs only. ' +
          'Nothing was written',
      );
      expect(orgs.TGT.written).toEqual([]);
      // Refused before discovery described anything.
      expect(orgs.SRC.asked).toEqual([]);
      expect(printed.some((line) => line.includes('executing'))).toBe(false);
    });

    it('runs a dry run against a production org, as it only reads', async () => {
      const orgs = withFakeOrgs({ targetSandbox: false });

      expect(await run(argv('--dry-run', '--skip-preflight'))).toBeUndefined();

      expect(printed).toContain('  [dry-run] Contact: 1 record(s) would be inserted');
      expect(orgs.TGT.written).toEqual([]);
    });

    it("clones into a sandbox, and names the target in its JSON by the org's own id, with when the run ended", async () => {
      // What a removal reads: the org the run wrote to, whatever alias names
      // it by then, and when the run ended, which dates a run whose writes
      // the target did not date.
      const orgs = withFakeOrgs();
      const { stdout } = captureStreams();
      const before = Date.now();

      expect(await run(argv('--skip-preflight', '--json'))).toBeUndefined();

      const summary = JSON.parse(stdout.join('')) as Record<string, unknown>;
      expect(summary).toMatchObject({ dryRun: false, target: 'TGT', targetOrgId: TARGET_ORG });
      const finishedAt = Date.parse(String(summary.finishedAt));
      expect(finishedAt).toBeGreaterThanOrEqual(before);
      expect(finishedAt).toBeLessThanOrEqual(Date.now());
      expect(orgs.TGT.written).toEqual([
        { Name: 'Acme' },
        { LastName: 'Key', AccountId: '001000000000900AAA' },
      ]);
    });
  });
});

describe('sandforge-clone excluded objects', () => {
  const node = (objectApiName: string): ForgeGraphNode => ({
    objectApiName,
    recordCount: 1,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included: true,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 4,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  });
  const graph: ForgeGraph = {
    nodes: [node('Opportunity'), node('OpportunityLineItem'), node('PricebookEntry')],
    edges: [],
    totalRecords: 3,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };

  it('hands the run every object named, once, whether discovery reached it or not', () => {
    // A price the default cap left out has no node to leave out: the run has
    // to know it by name, or it adds the price past the cap.
    const args = parseArgs(
      argv(
        '--exclude-object',
        'PricebookEntry',
        '--exclude-object',
        'OrderItem',
        '--exclude-object',
        'PricebookEntry',
      ),
    );

    expect(executeOptions(args, graph, []).excludedObjects).toEqual([
      'PricebookEntry',
      'OrderItem',
    ]);
  });

  it('leaves out nothing without the flag', () => {
    expect(executeOptions(parseArgs(argv()), graph, []).excludedObjects).toBeUndefined();
  });
});

describe('sandforge-clone graph line', () => {
  const node = (objectApiName: string, included = true): ForgeGraphNode => ({
    objectApiName,
    recordCount: included ? 1 : 0,
    fieldCount: 5,
    status: 'idle',
    progress: 0,
    included,
    piiFields: [],
    anonymizeFields: [],
    level: 0,
    successCount: 0,
    failureCount: 0,
    errors: [],
    createableFieldCount: 4,
    estimatedSizeMB: 0,
    estimatedApiCalls: 1,
    batchStrategy: 'auto',
  });
  const lookup = (sourceObject: string, targetObject: string) => ({
    sourceObject,
    targetObject,
    relationshipName: `${sourceObject}To${targetObject}`,
    type: 'lookup' as const,
  });
  const wave = (order: number, objectApiNames: string[]) => ({
    order,
    objectApiNames,
    totalRecords: objectApiNames.length,
    estimatedDurationSeconds: 0,
    estimatedApiCalls: 1,
  });
  const plan = {
    waves: [wave(0, ['Account', 'Pricebook2']), wave(1, ['Opportunity'])],
    cycleResolutions: [],
  };

  it('says the cap was raised when the objects discovery reached outnumber it', () => {
    // Four objects at a cap of two: the parents their records cannot be
    // written without took discovery past it. Printed as "4 nodes", the
    // count read as the cap not holding.
    const graph: ForgeGraph = {
      nodes: [node('Opportunity'), node('Account'), node('Pricebook2'), node('Lead', false)],
      edges: [
        lookup('Account', 'Opportunity'),
        lookup('Pricebook2', 'Opportunity'),
        lookup('Campaign', 'Opportunity'),
      ],
      totalRecords: 3,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
      truncated: true,
    };

    expect(graphLine(graph, plan, 2)).toBe(
      'graph: 4 objects at a cap of 2 (raised for the parents their records cannot be ' +
        'written without), 3 included; 3 lookups, 2 between these objects; 2 waves, 0 cycles ' +
        '(TRUNCATED)',
    );
  });

  it('says the cap alone when discovery stayed within it', () => {
    const graph: ForgeGraph = {
      nodes: [node('Opportunity'), node('Account')],
      edges: [lookup('Account', 'Opportunity')],
      totalRecords: 2,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    };

    expect(graphLine(graph, plan, 50)).toBe(
      'graph: 2 objects at a cap of 50, 2 included; 1 lookups, 1 between these objects; ' +
        '2 waves, 0 cycles',
    );
  });

  it('counts the empty tables apart: they take no place under the cap, which they do not raise', () => {
    const empty = (objectApiName: string): ForgeGraphNode => ({
      ...node(objectApiName, false),
      level: 1,
    });
    const graph: ForgeGraph = {
      nodes: [node('Opportunity'), node('Account'), empty('Lead'), empty('Campaign')],
      edges: [lookup('Account', 'Opportunity')],
      totalRecords: 2,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    };

    expect(graphLine(graph, plan, 2)).toBe(
      'graph: 4 objects at a cap of 2 (2 empty, taking no place under it), 2 included; ' +
        '1 lookups, 1 between these objects; 2 waves, 0 cycles',
    );
  });

  it('lists the objects by name, each with its record count, depth and whether it is included', () => {
    const graph: ForgeGraph = {
      nodes: [
        { ...node('Opportunity'), level: 0 },
        { ...node('Lead', false), level: 2 },
        { ...node('Account'), recordCount: 3, level: 1 },
      ],
      edges: [],
      totalRecords: 4,
      estimatedSizeMB: 0,
      estimatedDurationSeconds: 0,
    };

    expect(listedObjects(graph)).toEqual([
      { objectApiName: 'Account', recordCount: 3, depth: 1, included: true },
      { objectApiName: 'Lead', recordCount: 0, depth: 2, included: false },
      { objectApiName: 'Opportunity', recordCount: 1, depth: 0, included: true },
    ]);
  });
});

describe('sandforge-clone files', () => {
  const graph: ForgeGraph = {
    nodes: [],
    edges: [],
    totalRecords: 0,
    estimatedSizeMB: 0,
    estimatedDurationSeconds: 0,
  };

  it('copies no file without --files', () => {
    expect(executeOptions(parseArgs(argv()), graph, []).files).toBeUndefined();
  });

  it('copies files up to ten megabytes each by default', () => {
    expect(executeOptions(parseArgs(argv('--files')), graph, []).files).toEqual({
      maxFileBytes: 10 * 1_048_576,
      acceptedAsIs: false,
    });
  });

  it('takes the size and the acceptance from the command line', () => {
    const args = parseArgs(argv('--anonymize', '--files', '--files-as-is', '--max-file-size', '2'));

    expect(executeOptions(args, graph, []).files).toEqual({
      maxFileBytes: 2 * 1_048_576,
      acceptedAsIs: true,
    });
  });
});
