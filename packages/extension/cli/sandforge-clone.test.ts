import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Connection, DescribeSObjectResult } from 'jsforce';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

import { execFileSync } from 'node:child_process';
import {
  adaptDescribe,
  describeObjectInfo,
  executeOptions,
  loadRecordTypes,
  main,
  parseArgs,
  summaryLines,
} from './sandforge-clone';
import type { ExecutionSummary } from '../src/modules/forge/ForgeExecutor.js';
import type { ForgeGraph, ForgeGraphNode } from '@sandforge/shared';

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
    ['a --filter object name that is not an API name', argv('--filter', "Ca$e=Status = 'Open'")],
  ])('exits 2 on %s before any org is loaded', async (_label, args) => {
    expect(await run(args)).toBe(2);
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(stderr).not.toBe('');
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
    linkedCount: 0,
    failedCount: 0,
    skippedCount: 0,
    remapCount: 4,
    errors: [],
    truncatedObjects: [],
    remapTable: {},
    existingRecords: [],
    existingSourceIds: [],
    remapByObject: [],
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
      fields: { Contact: ['Email', 'Phone'] },
      methods: {},
    });
  });

  it('asks for no anonymization without --anonymize', () => {
    const options = executeOptions(parseArgs(argv()), graph, []);

    expect(options.anonymization).toBeUndefined();
  });
});
